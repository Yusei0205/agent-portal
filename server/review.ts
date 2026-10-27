/**
 * Code Review API (P10).
 *
 * Routes:
 *   GET    /api/projects/:id/reviews                       — list reviews
 *   POST   /api/projects/:id/reviews                       — create review
 *   GET    /api/projects/:id/reviews/:rid                  — get review with findings
 *   DELETE /api/projects/:id/reviews/:rid                  — delete review
 *   GET    /api/projects/:id/reviews/:rid/findings         — list findings
 *   PUT    /api/projects/:id/reviews/:rid/findings/:fid    — accept/dismiss finding
 *   POST   /api/projects/:id/reviews/:rid/post             — post findings to GitHub
 *
 * processReviewOutput(reviewId, workDir) — parses agent output from workDir for
 * structured findings (JSON or markdown table), creates finding rows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert } from './db.ts';
import { generateId, now, parseJson, newId } from './util.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Review {
  id: string;
  project_id: string;
  base_ref: string;
  head_ref: string;
  pr_number: number | null;
  repo_id: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  post_mode: 'draft' | 'auto';
  from_loop: string | null;
  workflow_id: string | null;
  min_severity: string;
  summary: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Finding {
  id: string;
  review_id: string;
  file_path: string;
  line_number: number | null;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  body: string;
  confidence: number | null;
  accepted: number; // 1=accepted, -1=dismissed, 0=pending
  posted_at: string | null;
  created_at: string;
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type Severity = (typeof SEVERITIES)[number];

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  const project = one<{ id: string }>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string; access: string }>(
    'SELECT user_id, access FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  return true;
}

function requireProjectEditor(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string; access: string }>(
    'SELECT user_id, access FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (!['editor', 'owner', 'admin'].includes(String(member.access))) {
    sendJson(res, 403, { error: 'Editor access required' });
    return false;
  }
  return true;
}

/**
 * Parse a severity string from agent output, defaulting to 'medium'.
 */
function parseSeverity(raw: unknown): Severity {
  const s = String(raw ?? '').toLowerCase().trim();
  if (SEVERITIES.includes(s as Severity)) return s as Severity;
  return 'medium';
}

/**
 * Try to parse structured findings from a string.
 * Supports:
 *   1. JSON block: ```json { "findings": [...] } ```
 *   2. JSON array: [ {...}, ... ]
 *   3. Markdown table rows: | file | line | severity | title | body |
 */
function parseFindingsFromText(text: string): Array<Partial<Finding>> {
  // Try JSON block (```json ... ```)
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      const arr = Array.isArray(parsed) ? parsed : (parsed.findings ?? parsed.results ?? []);
      if (Array.isArray(arr)) return normalizeParsedFindings(arr);
    } catch { /* fall through */ }
  }

  // Try bare JSON object with findings key
  const jsonObjMatch = text.match(/\{[\s\S]*"findings"\s*:\s*\[[\s\S]*?\][\s\S]*\}/);
  if (jsonObjMatch) {
    try {
      const parsed = JSON.parse(jsonObjMatch[0]);
      if (Array.isArray(parsed.findings)) return normalizeParsedFindings(parsed.findings);
    } catch { /* fall through */ }
  }

  // Try bare JSON array
  const jsonArrMatch = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (jsonArrMatch) {
    try {
      const arr = JSON.parse(jsonArrMatch[0]);
      if (Array.isArray(arr)) return normalizeParsedFindings(arr);
    } catch { /* fall through */ }
  }

  // Try markdown table
  return parseFindingsFromMarkdown(text);
}

function normalizeParsedFindings(arr: unknown[]): Array<Partial<Finding>> {
  return arr.map((item: unknown) => {
    const f = item as Record<string, unknown>;
    return {
      file_path: String(f.file ?? f.file_path ?? f.path ?? '').trim(),
      line_number: f.line != null ? (Number.isFinite(Number(f.line)) ? Number(f.line) : null) : null,
      severity: parseSeverity(f.severity),
      title: String(f.title ?? f.message ?? f.category ?? 'Finding').slice(0, 200),
      body: String(f.body ?? f.description ?? f.message ?? '').slice(0, 2000),
      confidence: f.confidence != null ? Math.min(1, Math.max(0, Number(f.confidence))) : null,
    };
  }).filter((f) => f.file_path || f.body);
}

function parseFindingsFromMarkdown(text: string): Array<Partial<Finding>> {
  const findings: Array<Partial<Finding>> = [];
  // Match markdown table rows: | col1 | col2 | ... |
  const rowRe = /^\|(.+)\|$/gm;
  let match: RegExpExecArray | null;
  const rows: string[][] = [];
  while ((match = rowRe.exec(text)) !== null) {
    const cols = match[1].split('|').map((c) => c.trim());
    if (cols.every((c) => /^[-: ]+$/.test(c))) continue; // separator row
    rows.push(cols);
  }
  if (rows.length < 2) return findings;
  const headers = rows[0].map((h) => h.toLowerCase().replace(/[^a-z_]/g, ''));
  for (const row of rows.slice(1)) {
    const f: Record<string, string> = {};
    headers.forEach((h, i) => { if (row[i] !== undefined) f[h] = row[i]; });
    const fp = f.filepath ?? f.file ?? f.filename ?? '';
    const body = f.body ?? f.description ?? f.message ?? f.details ?? '';
    if (!fp && !body) continue;
    findings.push({
      file_path: fp.slice(0, 500),
      line_number: f.line != null && Number.isFinite(Number(f.line)) ? Number(f.line) : null,
      severity: parseSeverity(f.severity),
      title: (f.title ?? f.category ?? f.rule ?? 'Finding').slice(0, 200),
      body: body.slice(0, 2000),
      confidence: null,
    });
  }
  return findings;
}

/**
 * Deduplicate findings by (file_path, line_number, body text).
 */
function deduplicateFindings(incoming: Array<Partial<Finding>>, existingKey: Set<string>): Array<Partial<Finding>> {
  const result: Array<Partial<Finding>> = [];
  for (const f of incoming) {
    const key = `${f.file_path ?? ''}|${f.line_number ?? ''}|${(f.body ?? '').toLowerCase().trim().slice(0, 100)}`;
    if (existingKey.has(key)) continue;
    existingKey.add(key);
    result.push(f);
  }
  return result;
}

/**
 * Parse agent output from workDir for structured findings.
 * Creates finding rows in the database. Deduplicates by (file, line, body).
 */
export function processReviewOutput(reviewId: string, workDir?: string): number {
  // Collect text to parse from: output files in workDir, plus any stored review summary
  const review = one<Review>('SELECT * FROM p10_reviews WHERE id = ?', reviewId);
  if (!review) return 0;

  let text = review.summary ?? '';

  if (workDir) {
    // Look for findings files in workDir
    const candidateFiles = ['findings.json', 'findings.md', 'review.json', 'review.md', 'output.json', 'output.md'];
    for (const fname of candidateFiles) {
      const fpath = path.join(workDir, fname);
      try {
        if (fs.existsSync(fpath)) {
          text += '\n' + fs.readFileSync(fpath, 'utf8');
        }
      } catch { /* skip */ }
    }
  }

  const parsed = parseFindingsFromText(text);

  // Build dedup set from existing findings
  const existing = all<Finding>('SELECT file_path, line_number, body FROM p10_findings WHERE review_id = ?', reviewId);
  const existingKeys = new Set(
    existing.map((f) => `${f.file_path}|${f.line_number ?? ''}|${(f.body ?? '').toLowerCase().trim().slice(0, 100)}`),
  );

  const toInsert = deduplicateFindings(parsed, existingKeys);
  const ts = now();
  for (const f of toInsert) {
    if (!f.file_path && !f.body) continue;
    insert('p10_findings', {
      id: newId('f_'),
      review_id: reviewId,
      file_path: f.file_path ?? '',
      line_number: f.line_number ?? null,
      severity: f.severity ?? 'medium',
      title: f.title ?? 'Finding',
      body: f.body ?? '',
      confidence: f.confidence ?? null,
      accepted: 0,
      posted_at: null,
      created_at: ts,
    });
  }

  return toInsert.length;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerReviewRoutes(): void {

  // GET /api/projects/:id/reviews
  router.get('/api/projects/:id/reviews', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const reviews = all<Review & { finding_count?: number; repo_name?: string }>(
      `SELECT r.*,
         (SELECT COUNT(*) FROM p10_findings f WHERE f.review_id = r.id) AS finding_count,
         repos.name AS repo_name
       FROM p10_reviews r
       LEFT JOIN repositories repos ON repos.id = r.repo_id
       WHERE r.project_id = ?
       ORDER BY r.created_at DESC
       LIMIT 100`,
      req.params.id,
    );

    sendJson(res, 200, { reviews });
  });

  // POST /api/projects/:id/reviews
  router.post('/api/projects/:id/reviews', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const repoId = body.repoId != null ? String(body.repoId) : null;
    const baseRef = String(body.baseRef ?? '').trim();
    const headRef = String(body.headRef ?? '').trim();

    if (!baseRef) { sendJson(res, 400, { error: 'baseRef is required' }); return; }
    if (!headRef) { sendJson(res, 400, { error: 'headRef is required' }); return; }

    // Validate repo belongs to project if provided
    if (repoId) {
      const repo = one<{ id: string; project_id: string }>(
        'SELECT id, project_id FROM repositories WHERE id = ?',
        repoId,
      );
      if (!repo || repo.project_id !== req.params.id) {
        sendJson(res, 400, { error: 'That repository belongs to another project' });
        return;
      }
    }

    const prNumber = body.prNumber != null ? Number(body.prNumber) : null;
    const postMode = body.postMode === 'auto' ? 'auto' : 'draft';
    const minSeverity = SEVERITIES.includes(body.minSeverity as Severity) ? String(body.minSeverity) : 'medium';

    // Create a p6_workflow for tracking
    let workflowId: string | null = null;
    try {
      const goal = `Code review: ${baseRef} → ${headRef}${prNumber ? ` (PR #${prNumber})` : ''}`;
      const wid = generateId();
      const ts = now();
      insert('p6_workflows', {
        id: wid,
        project_id: req.params.id,
        goal,
        status: 'pending',
        engine: 'demo',
        trust_tools: 0,
        lead_agent: body.leadAgent != null ? String(body.leadAgent) : null,
        workspace_id: null,
        output_files_enabled: 0,
        repo_ids: repoId ? JSON.stringify([repoId]) : '[]',
        iteration_count: 0,
        max_iterations: 1,
        created_by: req.user!.id,
        created_at: ts,
        updated_at: ts,
      });
      workflowId = wid;
    } catch { /* if workflow insert fails, continue without it */ }

    const id = generateId();
    const ts = now();

    insert('p10_reviews', {
      id,
      project_id: req.params.id,
      base_ref: baseRef,
      head_ref: headRef,
      pr_number: prNumber,
      repo_id: repoId,
      status: 'pending',
      post_mode: postMode,
      from_loop: null,
      workflow_id: workflowId,
      min_severity: minSeverity,
      summary: null,
      created_by: req.user!.id,
      created_at: ts,
    });

    const review = one<Review>('SELECT * FROM p10_reviews WHERE id = ?', id);
    sendJson(res, 201, { review });
  });

  // GET /api/projects/:id/reviews/:rid
  router.get('/api/projects/:id/reviews/:rid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const review = one<Review>(
      'SELECT * FROM p10_reviews WHERE id = ? AND project_id = ?',
      req.params.rid,
      req.params.id,
    );
    if (!review) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const findings = all<Finding>(
      `SELECT * FROM p10_findings WHERE review_id = ?
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, file_path, line_number`,
      review.id,
    );

    sendJson(res, 200, { review, findings });
  });

  // DELETE /api/projects/:id/reviews/:rid
  router.delete('/api/projects/:id/reviews/:rid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const review = one<Review>(
      'SELECT * FROM p10_reviews WHERE id = ? AND project_id = ?',
      req.params.rid,
      req.params.id,
    );
    if (!review) { sendJson(res, 404, { error: 'Review not found' }); return; }
    if (review.status === 'running') {
      sendJson(res, 400, { error: 'Wait for the review to finish before deleting it' });
      return;
    }

    run('DELETE FROM p10_reviews WHERE id = ?', review.id);
    sendJson(res, 200, { ok: true });
  });

  // GET /api/projects/:id/reviews/:rid/findings
  router.get('/api/projects/:id/reviews/:rid/findings', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const review = one<Review>(
      'SELECT id FROM p10_reviews WHERE id = ? AND project_id = ?',
      req.params.rid,
      req.params.id,
    );
    if (!review) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const findings = all<Finding>(
      `SELECT * FROM p10_findings WHERE review_id = ?
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, file_path, line_number`,
      review.id,
    );

    sendJson(res, 200, { findings });
  });

  // PUT /api/projects/:id/reviews/:rid/findings/:fid
  router.put('/api/projects/:id/reviews/:rid/findings/:fid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectEditor(req, res, req.params.id)) return;

    const review = one<Review>(
      'SELECT id FROM p10_reviews WHERE id = ? AND project_id = ?',
      req.params.rid,
      req.params.id,
    );
    if (!review) { sendJson(res, 404, { error: 'Review not found' }); return; }

    const finding = one<Finding>(
      'SELECT * FROM p10_findings WHERE id = ? AND review_id = ?',
      req.params.fid,
      review.id,
    );
    if (!finding) { sendJson(res, 404, { error: 'Finding not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const accepted = Number(body.accepted);
    if (accepted !== 1 && accepted !== -1 && accepted !== 0) {
      sendJson(res, 400, { error: 'accepted must be 1 (accept), -1 (dismiss), or 0 (pending)' });
      return;
    }

    run('UPDATE p10_findings SET accepted = ? WHERE id = ?', accepted, finding.id);
    const updated = one<Finding>('SELECT * FROM p10_findings WHERE id = ?', finding.id);
    sendJson(res, 200, { finding: updated, ok: true });
  });

  // POST /api/projects/:id/reviews/:rid/post
  // Post findings to GitHub. Admin/owner only.
  router.post('/api/projects/:id/reviews/:rid/post', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!req.user.is_admin) {
      // Check project owner/admin access
      const member = one<{ access: string }>(
        'SELECT access FROM project_members WHERE project_id = ? AND user_id = ?',
        req.params.id,
        req.user.id,
      );
      if (!member || !['owner', 'admin', 'editor'].includes(member.access)) {
        sendJson(res, 403, { error: 'Owner or admin access required to post findings' });
        return;
      }
    }

    const review = one<Review>(
      'SELECT * FROM p10_reviews WHERE id = ? AND project_id = ?',
      req.params.rid,
      req.params.id,
    );
    if (!review) { sendJson(res, 404, { error: 'Review not found' }); return; }
    if (review.status !== 'done') {
      sendJson(res, 400, { error: 'Wait for the review to finish before posting' });
      return;
    }

    const minSevRank = SEVERITIES.indexOf(review.min_severity as Severity);
    const findings = all<Finding>(
      'SELECT * FROM p10_findings WHERE review_id = ? AND accepted != -1',
      review.id,
    );

    // Determine which findings meet the min severity threshold or are explicitly accepted
    const toPost = findings.filter((f) => {
      if (f.accepted === 1) return true; // explicitly accepted, always post
      if (f.posted_at) return false; // already posted
      const rank = SEVERITIES.indexOf(f.severity as Severity);
      return rank <= minSevRank; // lower index = higher severity
    });

    const skipped = findings.length - toPost.length;
    const ts = now();

    // Mark findings as posted (in a real implementation this would call GitHub API)
    for (const f of toPost) {
      run('UPDATE p10_findings SET posted_at = ? WHERE id = ?', ts, f.id);
    }

    sendJson(res, 200, {
      posted: toPost.length,
      skipped,
      message: toPost.length
        ? `Posted ${toPost.length} finding${toPost.length === 1 ? '' : 's'}`
        : 'Nothing to post',
    });
  });
}
