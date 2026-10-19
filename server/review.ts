import path from 'node:path';
import { all, insert, one, run, update, type Row } from './db.ts';
import { del, get, patch, post } from './http.ts';
import { getProject, notifyProject, projectDir, requireProject } from './projects.ts';
import { checkBranch, diffRefs, ensureFresh, fetchPullRef, getRepo, githubApi, removeWorktree, type Repo } from './repos.ts';
import { HttpError, badRequest, extractJson, int, newId, notFound, now, parseJson } from './util.ts';
import { parseUnifiedDiff, type Finding, type Severity } from './agent/heuristics.ts';
import { startRun, READ_ONLY_TOOLS, getRun } from './agent/runner.ts';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const MAX_DIFF = 400_000;

function reviewPrompt(repo: Repo, base: string, head: string, diff: string, focusFiles?: string[]): string {
  return `Review this change in repository "${repo.name}" (${base}...${head}).
The head version of the code is checked out in this run's working copy; open full files there when the diff is not enough context.
${focusFiles ? `Focus only on these files, which a first pass flagged: ${focusFiles.join(', ')}. Look deeper: trace callers, check tests, and confirm or reject each concern.\n` : ''}
Check, in this order:
1. Correctness against the project's documents and decisions (search docs/md and docs/decisions.md when the change touches a documented rule).
2. Security: injection, authorisation, secrets, unsafe input handling.
3. Reliability: error handling, retries, data loss, concurrency.
4. Tests: is the new behaviour tested?
5. Readability and conventions of the surrounding code.

Report only real issues; skip style nits that a formatter would fix.
Each finding needs: "file" (path as shown in the diff), "line" (line number in the NEW file, or null for file-level), "severity" (critical, high, medium, low or info), "category", "message" (what is wrong, in plain language), "suggestion" (a concrete fix).

End your reply with a JSON block:
\`\`\`json
{"summary": "<one or two sentences>", "findings": [ ... ]}
\`\`\`

<diff>
${diff}
</diff>`;
}

function cleanFindings(raw: unknown, files: Set<string>): Finding[] {
  if (!Array.isArray(raw)) return [];
  const out: Finding[] = [];
  for (const f of raw.slice(0, 200) as any[]) {
    const file = String(f?.file ?? '').replace(/^[ab]\//, '');
    if (!file || !files.has(file)) continue;
    const severity = SEVERITIES.includes(f.severity) ? f.severity : 'medium';
    const line = Number.isFinite(Number(f.line)) && Number(f.line) > 0 ? Math.round(Number(f.line)) : null;
    const message = String(f.message ?? '').slice(0, 2000);
    if (!message) continue;
    out.push({ file, line, severity, category: String(f.category ?? 'general').slice(0, 40), message, suggestion: f.suggestion ? String(f.suggestion).slice(0, 2000) : undefined });
  }
  return out;
}

function trimDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= MAX_DIFF) return { diff, truncated: false };
  const parts = diff.split(/^(?=diff --git )/m);
  let out = '';
  for (const p of parts) {
    if (out.length + p.length > MAX_DIFF) break;
    out += p;
  }
  return { diff: out, truncated: true };
}

async function runPass(review: Row, repo: Repo, userId: string, model: 'haiku' | 'sonnet', focusFiles?: string[]): Promise<{ findings: Finding[]; summary: string; runId: string }> {
  const files = new Set(parseUnifiedDiff(review.diff).map((f) => f.newPath));
  const { run: r, done } = await startRun({
    projectId: review.project_id,
    userId,
    kind: 'review',
    title: `${focusFiles ? 'Deep review' : 'Review'}: ${review.head} → ${review.base}`,
    prompt: reviewPrompt(repo, review.base, review.head, review.diff, focusFiles),
    repoId: repo.id,
    branch: review.head,
    model,
    permissionMode: 'default',
    tools: READ_ONLY_TOOLS,
    allowedTools: READ_ONLY_TOOLS,
    maxTurns: 40,
    meta: { reviewId: review.id, pass: focusFiles ? 'deep' : 'triage' },
  });
  update('reviews', review.id, { run_id: r.id });
  notifyProject(review.project_id, 'review.updated', { id: review.id });
  const final = await done;
  if (final.worktree) {
    await removeWorktree(repo, path.join(projectDir(getProject(review.project_id)), final.worktree)).catch(() => undefined);
  }
  if (final.status !== 'completed') throw new HttpError(502, `The review run ${final.status}: ${final.error ?? ''}`);
  const parsed = extractJson<any>(final.result ?? '') ?? {};
  return { findings: cleanFindings(parsed.findings, files), summary: String(parsed.summary ?? '').slice(0, 2000), runId: r.id };
}

async function executeReview(reviewId: string, userId: string): Promise<void> {
  const review = one<Row>('SELECT * FROM reviews WHERE id = ?', reviewId)!;
  const repo = getRepo(review.repo_id);
  try {
    const triage = await runPass(review, repo, userId, 'haiku');
    let findings = triage.findings.map((f) => ({ ...f, source: 'triage' }));
    let summary = triage.summary;
    if (review.deep) {
      const flagged = [...new Set(triage.findings.filter((f) => ['critical', 'high', 'medium'].includes(f.severity)).map((f) => f.file))].slice(0, 15);
      if (flagged.length) {
        const deep = await runPass(review, repo, userId, 'sonnet', flagged);
        findings = [...findings.filter((f) => !flagged.includes(f.file)), ...deep.findings.map((f) => ({ ...f, source: 'deep' }))];
        summary = deep.summary || summary;
      }
    }
    for (const f of findings) {
      insert('findings', {
        id: newId('f_'),
        review_id: review.id,
        file: f.file,
        line: f.line,
        end_line: null,
        severity: f.severity,
        category: f.category,
        message: f.message,
        suggestion: f.suggestion ?? null,
        status: 'open',
        source: f.source,
      });
    }
    update('reviews', review.id, { status: 'done', summary, finished_at: now() });
  } catch (e: any) {
    update('reviews', review.id, { status: 'error', error: String(e?.message ?? e), finished_at: now() });
  }
  notifyProject(review.project_id, 'review.updated', { id: review.id });
}

function reviewView(r: Row) {
  return { ...r, files: parseJson(r.files, []), diff: undefined };
}

export function registerReviewRoutes(): void {
  get('/api/projects/:pid/reviews', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const rows = all(
      `SELECT r.*, g.name AS repo_name, u.name AS created_by_name,
         (SELECT COUNT(*) FROM findings f WHERE f.review_id = r.id AND f.status != 'dismissed') AS open_findings,
         (SELECT COUNT(*) FROM findings f WHERE f.review_id = r.id AND f.severity IN ('critical','high') AND f.status != 'dismissed') AS serious
       FROM reviews r LEFT JOIN repos g ON g.id = r.repo_id LEFT JOIN users u ON u.id = r.created_by
       WHERE r.project_id = ? ORDER BY r.created_at DESC LIMIT 100`,
      project.id,
    );
    return { reviews: rows.map(reviewView) };
  });

  post('/api/projects/:pid/reviews', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const repo = getRepo(String(body.repoId ?? ''));
    if (repo.project_id !== project.id) throw badRequest('That repository belongs to another project');
    await ensureFresh(repo);
    let base: string;
    let head: string;
    let prNumber: number | null = null;
    let headSha: string | null = null;
    if (body.prNumber) {
      if (repo.provider !== 'github') throw badRequest('Pull request numbers work for GitHub repositories only');
      prNumber = int(body.prNumber, 'Pull request', undefined, 1);
      const pr = await githubApi(repo, 'GET', `/pulls/${prNumber}`);
      base = checkBranch(pr.base.ref);
      headSha = pr.head.sha;
      head = await fetchPullRef(repo, prNumber);
    } else {
      base = checkBranch(body.base);
      head = checkBranch(body.head);
      if (base === head) throw badRequest('Pick two different branches');
    }
    const raw = await diffRefs(repo, base, head);
    if (!raw.trim()) throw badRequest(`No differences between ${base} and ${head}`);
    const { diff, truncated } = trimDiff(raw);
    const files = parseUnifiedDiff(diff).map((f) => ({ path: f.newPath, oldPath: f.oldPath, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary }));
    const id = newId('v_');
    insert('reviews', {
      id,
      project_id: project.id,
      repo_id: repo.id,
      base,
      head,
      pr_number: prNumber,
      head_sha: headSha,
      diff,
      files: JSON.stringify(files),
      status: 'running',
      deep: body.deep ? 1 : 0,
      summary: truncated ? 'The diff was very large, so only the first files were reviewed.' : null,
      created_by: ctx.user!.id,
      created_at: now(),
    });
    notifyProject(project.id, 'review.updated', { id });
    void executeReview(id, ctx.user!.id);
    return { review: reviewView(one('SELECT * FROM reviews WHERE id = ?', id)!) };
  });

  get('/api/reviews/:id', (ctx) => {
    const r = one<Row>('SELECT r.*, g.name AS repo_name, g.provider FROM reviews r LEFT JOIN repos g ON g.id = r.repo_id WHERE r.id = ?', ctx.params.id);
    if (!r) throw notFound('Review not found');
    requireProject(ctx, r.project_id);
    return {
      review: reviewView(r),
      diff: parseUnifiedDiff(r.diff),
      findings: all("SELECT * FROM findings WHERE review_id = ? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, file, line", r.id),
      run: r.run_id ? (() => { try { const x = getRun(r.run_id); return { id: x.id, status: x.status }; } catch { return null; } })() : null,
    };
  });

  patch('/api/findings/:id', async (ctx) => {
    const f = one<Row>('SELECT f.*, r.project_id FROM findings f JOIN reviews r ON r.id = f.review_id WHERE f.id = ?', ctx.params.id);
    if (!f) throw notFound('Finding not found');
    requireProject(ctx, f.project_id, 'editor');
    const body = await ctx.json();
    if (!['open', 'accepted', 'dismissed'].includes(body.status)) throw badRequest('Status must be open, accepted or dismissed');
    run('UPDATE findings SET status = ? WHERE id = ?', body.status, f.id);
    notifyProject(f.project_id, 'review.updated', { id: f.review_id });
    return { ok: true };
  });

  post('/api/reviews/:id/post-github', async (ctx) => {
    const r = one<Row>('SELECT * FROM reviews WHERE id = ?', ctx.params.id);
    if (!r) throw notFound('Review not found');
    requireProject(ctx, r.project_id, 'editor');
    const repo = getRepo(r.repo_id);
    if (repo.provider !== 'github' || !r.pr_number || !r.head_sha) throw badRequest('Posting works for GitHub pull request reviews only');
    const findings = all<Row>("SELECT * FROM findings WHERE review_id = ? AND status != 'dismissed'", r.id);
    const lineFindings = findings.filter((f) => f.line);
    const fileFindings = findings.filter((f) => !f.line);
    const body =
      `**Agent Portal review** (${findings.length} finding${findings.length === 1 ? '' : 's'})\n\n${r.summary ?? ''}` +
      (fileFindings.length ? `\n\n${fileFindings.map((f) => `- **${f.severity}** \`${f.file}\`: ${f.message}`).join('\n')}` : '');
    await githubApi(repo, 'POST', `/pulls/${r.pr_number}/reviews`, {
      commit_id: r.head_sha,
      event: 'COMMENT',
      body,
      comments: lineFindings.slice(0, 50).map((f) => ({
        path: f.file,
        line: f.line,
        side: 'RIGHT',
        body: `**${f.severity}** · ${f.category}\n\n${f.message}${f.suggestion ? `\n\n_Suggestion:_ ${f.suggestion}` : ''}`,
      })),
    });
    update('reviews', r.id, { posted_at: now() });
    notifyProject(r.project_id, 'review.updated', { id: r.id });
    return { ok: true, posted: findings.length };
  });

  del('/api/reviews/:id', (ctx) => {
    const r = one<Row>('SELECT * FROM reviews WHERE id = ?', ctx.params.id);
    if (!r) throw notFound('Review not found');
    requireProject(ctx, r.project_id, 'editor');
    if (r.status === 'running') throw badRequest('Wait for the review to finish, or stop its run first');
    run('DELETE FROM reviews WHERE id = ?', r.id);
    notifyProject(r.project_id, 'review.updated', { id: r.id });
    return { ok: true };
  });
}
