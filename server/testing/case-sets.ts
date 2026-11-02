/**
 * Test case sets — manual QA test case sheets generated from specs (F12d).
 *
 * All routes are under /api/projects/:pid/tests/:tpid.
 * Scope: tests + editor for writes, tests + viewer for reads.
 *
 * Routes:
 *   POST   /case-sets                      — create + start async generation (202)
 *   GET    /case-sets                      — list, newest first
 *   GET    /case-sets/:csid               — get with cases
 *   PATCH  /case-sets/:csid               — update name
 *   DELETE /case-sets/:csid               — delete + cancel
 *   POST   /case-sets/:csid/cancel        — cancel generation
 *   POST   /case-sets/:csid/resume        — resume a failed/cancelled set (202)
 *   GET    /case-sets/:csid/trace         — generation trace steps
 *   POST   /case-sets/:csid/cases         — add a row
 *   PUT    /case-sets/:csid/cases/:cid    — update case fields
 *   DELETE /case-sets/:csid/cases/:cid    — remove a case
 *   GET    /case-sets/:csid/export.xlsx   — Excel workbook
 */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { all, one, run, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now, str, badRequest, parseJson } from '../util.ts';
import { auditRaw } from '../audit.ts';
import { requireTestProject, hasScope } from './helpers.ts';
import type { TestProject } from './helpers.ts';
import { callTextModel } from './model-provider.ts';
import { extractJsonArray, buildAttachmentContext } from './generate.ts';
import { validateAttachmentIds, deleteAttachmentsByIds } from '../ai-attachments.ts';
import { startStep, finishStep, getCaseSetTrace } from './trace.ts';
import { formatAsCurl, formatResponseText } from './curl.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TestCaseSet extends Row {
  id: string;
  test_project_id: string;
  name: string;
  description: string;
  status: string;
  progress: string;
  error: string | null;
  warnings: string;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancelled: number;
  outline_categories: string | null;
  attachment_ids: string;
}

interface TestCase extends Row {
  id: string;
  case_set_id: string;
  ord: number;
  test_id: string;
  category: string;
  scenario: string;
  precondition: string;
  steps: string;
  expected_result: string;
  status: string;
  remarks: string;
  request: string | null;
  response: string | null;
  created_at: string;
  updated_at: string;
}

interface Progress {
  phase: 'queued' | 'context' | 'outline' | 'cases' | 'saving' | 'done';
  message: string;
  percent: number;
  categoriesTotal: number;
  categoriesDone: number;
  casesSoFar: number;
}

const VALID_STATUSES = new Set(['', 'Pass', 'Fail', 'Blocked', 'Not Run']);

/** Maximum JSON size for request/response fields (serialised). */
const MAX_REQUEST_RESPONSE_CHARS = 20_000;

// ── Serialisation helpers ──────────────────────────────────────────────────────

function parseProgress(raw: string | null | undefined): Progress {
  if (!raw) return { phase: 'queued', message: 'Waiting to start', percent: 0, categoriesTotal: 0, categoriesDone: 0, casesSoFar: 0 };
  try { return JSON.parse(raw) as Progress; }
  catch { return { phase: 'queued', message: '', percent: 0, categoriesTotal: 0, categoriesDone: 0, casesSoFar: 0 }; }
}

function parseWarnings(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; }
  catch { return []; }
}

function getCaseCount(csId: string): number {
  const row = one<{ c: number }>('SELECT COUNT(*) AS c FROM test_cases WHERE case_set_id = ?', csId);
  return row?.c ?? 0;
}

/** Normalise a category name for comparison: lowercase, collapsed whitespace. */
function normCat(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * For a case set with a saved outline, return the list of categories that still
 * have zero cases. Returns null when no outline is saved (unknown / old set).
 */
function getRemainingCategories(cs: TestCaseSet): string[] | null {
  if (!cs.outline_categories) return null;
  try {
    const outline = JSON.parse(cs.outline_categories) as string[];
    if (!Array.isArray(outline)) return null;
    const existing = getCategoryOrder(cs.id).map(normCat);
    return outline.filter((cat) => !existing.includes(normCat(cat)));
  } catch {
    return null;
  }
}

function formatCaseSet(cs: TestCaseSet): Record<string, unknown> {
  const warnings = parseWarnings(cs.warnings);
  const remaining = getRemainingCategories(cs);
  const resumable =
    cs.status === 'failed' ||
    cs.status === 'cancelled' ||
    (cs.status === 'done' && warnings.length > 0);
  return {
    id: cs.id,
    name: cs.name,
    description: cs.description,
    status: cs.status,
    progress: parseProgress(cs.progress),
    error: cs.error ?? null,
    warnings,
    caseCount: getCaseCount(cs.id),
    createdAt: cs.created_at,
    startedAt: cs.started_at ?? null,
    finishedAt: cs.finished_at ?? null,
    resumable,
    remainingCategories: remaining,
  };
}

function formatCase(c: TestCase): Record<string, unknown> {
  return {
    id: c.id,
    ord: c.ord,
    testId: c.test_id,
    category: c.category,
    scenario: c.scenario,
    precondition: c.precondition,
    steps: c.steps,
    expectedResult: c.expected_result,
    status: c.status,
    remarks: c.remarks,
    request: c.request ? parseJson<unknown>(c.request, null) : null,
    response: c.response ? parseJson<unknown>(c.response, null) : null,
  };
}

// ── Request/Response validation ────────────────────────────────────────────────

/**
 * Validate and serialise a request field from user input.
 * Returns JSON string or null. Throws badRequest on invalid shape.
 */
function validateRequestField(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw badRequest('request must be a JSON object or null');
  }
  const obj = v as Record<string, unknown>;
  if (!obj.url || typeof obj.url !== 'string' || !obj.url.trim()) {
    throw badRequest('request.url is required and must be a non-empty string');
  }
  if (obj.headers !== null && obj.headers !== undefined) {
    if (typeof obj.headers !== 'object' || Array.isArray(obj.headers)) {
      throw badRequest('request.headers must be an object');
    }
    for (const [k, val] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (typeof k !== 'string' || typeof val !== 'string') {
        throw badRequest('request.headers values must be strings');
      }
    }
  }
  const json = JSON.stringify(v);
  if (json.length > MAX_REQUEST_RESPONSE_CHARS) {
    throw badRequest(`request field exceeds ${MAX_REQUEST_RESPONSE_CHARS} character limit`);
  }
  return json;
}

/**
 * Validate and serialise a response field from user input.
 * Returns JSON string or null. Throws badRequest on invalid shape.
 */
function validateResponseField(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw badRequest('response must be a JSON object or null');
  }
  const obj = v as Record<string, unknown>;
  if (obj.status !== null && obj.status !== undefined) {
    if (typeof obj.status !== 'number') {
      throw badRequest('response.status must be a number or null');
    }
  }
  if (obj.headers !== null && obj.headers !== undefined) {
    if (typeof obj.headers !== 'object' || Array.isArray(obj.headers)) {
      throw badRequest('response.headers must be an object');
    }
  }
  const json = JSON.stringify(v);
  if (json.length > MAX_REQUEST_RESPONSE_CHARS) {
    throw badRequest(`response field exceeds ${MAX_REQUEST_RESPONSE_CHARS} character limit`);
  }
  return json;
}

/**
 * Defensively parse a request object from model output — returns JSON string or null.
 * Never throws; bad/missing data → null.
 */
function parseRequestFromModel(raw: unknown): string | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (!r.url || typeof r.url !== 'string' || !r.url.trim()) return null;
    const cleaned: Record<string, unknown> = {
      method: typeof r.method === 'string' ? r.method.toUpperCase().trim() : 'GET',
      url: String(r.url).trim(),
    };
    if (r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers)) {
      const h: Record<string, string> = {};
      for (const [k, val] of Object.entries(r.headers as Record<string, unknown>)) {
        if (typeof k === 'string' && typeof val === 'string') h[k] = val;
      }
      if (Object.keys(h).length > 0) cleaned.headers = h;
    }
    if (r.body !== null && r.body !== undefined) cleaned.body = r.body;
    const json = JSON.stringify(cleaned);
    return json.length <= MAX_REQUEST_RESPONSE_CHARS ? json : null;
  } catch {
    return null;
  }
}

/**
 * Defensively parse a response object from model output — returns JSON string or null.
 * Never throws; bad/missing data → null.
 */
function parseResponseFromModel(raw: unknown): string | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    if (r.status != null) {
      if (typeof r.status === 'number') cleaned.status = r.status;
      else if (typeof r.status === 'string' && /^\d+$/.test(r.status.trim())) {
        cleaned.status = parseInt(r.status.trim(), 10);
      }
    }
    if (r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers)) {
      const h: Record<string, string> = {};
      for (const [k, val] of Object.entries(r.headers as Record<string, unknown>)) {
        if (typeof k === 'string' && typeof val === 'string') h[k] = val;
      }
      if (Object.keys(h).length > 0) cleaned.headers = h;
    }
    if (r.body !== null && r.body !== undefined) cleaned.body = r.body;
    if (Object.keys(cleaned).length === 0) return null;
    const json = JSON.stringify(cleaned);
    return json.length <= MAX_REQUEST_RESPONSE_CHARS ? json : null;
  } catch {
    return null;
  }
}

// ── Progress helpers ───────────────────────────────────────────────────────────

function setProgress(csId: string, p: Partial<Progress>): void {
  const existing = one<{ progress: string }>('SELECT progress FROM test_case_sets WHERE id = ?', csId);
  const current = parseProgress(existing?.progress);
  const updated: Progress = { ...current, ...p };
  try { run('UPDATE test_case_sets SET progress = ? WHERE id = ?', JSON.stringify(updated), csId); }
  catch { /* DB closed or row deleted — ignore */ }
}

// ── Cancellation check ─────────────────────────────────────────────────────────

function isCancelled(csId: string): boolean {
  try {
    const row = one<{ cancelled: number; status: string }>(
      'SELECT cancelled, status FROM test_case_sets WHERE id = ?', csId,
    );
    if (!row) return true; // row deleted — stop
    return row.cancelled !== 0 || row.status === 'cancelled';
  } catch {
    return true;
  }
}

// ── Test ID helpers ────────────────────────────────────────────────────────────

/**
 * Returns categories in order of first appearance within a case set.
 */
function getCategoryOrder(csId: string): string[] {
  const rows = all<{ category: string }>(
    'SELECT category FROM test_cases WHERE case_set_id = ? GROUP BY category ORDER BY MIN(ord)',
    csId,
  );
  return rows.map((r) => r.category);
}

/**
 * Compute TC-<catIdx>.1.<caseNo> for a new case being added to the set.
 * catIdx is 1-based; if the category is new, it gets the next index.
 */
function computeTestId(csId: string, category: string): string {
  const cats = getCategoryOrder(csId);
  let catIdx = cats.indexOf(category) + 1;
  if (catIdx === 0) catIdx = cats.length + 1;
  const count = one<{ c: number }>(
    'SELECT COUNT(*) AS c FROM test_cases WHERE case_set_id = ? AND category = ?',
    csId, category,
  );
  const caseNo = (count?.c ?? 0) + 1;
  return `TC-${catIdx}.1.${caseNo}`;
}

/**
 * Renumber all cases in a set with TC-<catIdx>.1.<caseNo> based on their
 * category's first-appearance order and their ord within each category.
 * Called once after generation to make IDs consistent.
 */
function renumberCases(csId: string): void {
  const cases = all<TestCase>('SELECT * FROM test_cases WHERE case_set_id = ? ORDER BY ord', csId);
  const catOrder: string[] = [];
  for (const c of cases) {
    if (!catOrder.includes(c.category)) catOrder.push(c.category);
  }
  const counters: Record<string, number> = {};
  for (const c of cases) {
    const catIdx = catOrder.indexOf(c.category) + 1;
    counters[c.category] = (counters[c.category] ?? 0) + 1;
    const newId = `TC-${catIdx}.1.${counters[c.category]}`;
    if (newId !== c.test_id) {
      try { run('UPDATE test_cases SET test_id = ? WHERE id = ?', newId, c.id); }
      catch { /* ok */ }
    }
  }
}

// ── Prompts ────────────────────────────────────────────────────────────────────

const MAX_CASE_TEXT = 4000;

function buildSystemPrompt(tp: TestProject, attachmentNote?: string): string {
  return [
    `You are a QA test case generator for the application at: ${tp.app_url}`,
    tp.api_base_url ? `API base URL: ${tp.api_base_url}` : '',
    tp.rules_for_ai ? `\nRules:\n${tp.rules_for_ai}` : '',
    attachmentNote ? `\n${attachmentNote}` : '',
    '\nOutput ONLY valid JSON. No markdown, no explanation, nothing outside the JSON.',
  ].filter(Boolean).join('\n');
}

function buildOutlinePrompt(description: string): string {
  return [
    `Generate a structured outline of test categories for the following requirement:`,
    `"""${description}"""`,
    '',
    'Return a JSON array of category objects. Each object must have a "name" field.',
    'Aim for 5–15 categories covering the major functional areas, user roles, edge cases, and validation scenarios.',
    '',
    'Example:',
    '[{"name":"1. Login Flow"},{"name":"2. Registration"},{"name":"3. Password Reset"},{"name":"4. Access Control"}]',
    '',
    'Return ONLY the JSON array.',
  ].join('\n');
}

function buildCategoryPrompt(description: string, categoryName: string, textBlock: string): string {
  return [
    `Requirement: """${description}"""`,
    `Category: ${categoryName}`,
    textBlock,
    '',
    'Generate thorough test cases for this category. Cover:',
    '- Positive paths (happy paths)',
    '- Negative paths (invalid inputs, error states)',
    '- Boundary conditions',
    '- Roles and permissions',
    '- Validation rules',
    '',
    'Return a JSON array. Each element must have these fields:',
    '  scenario       — brief test case name (string, required)',
    '  precondition   — pre-test state (string, may be empty)',
    '  steps          — numbered steps, e.g. "1. Navigate to page\\n2. Enter value" (string)',
    '  expectedResult — what should happen (string)',
    '  request        — for API test cases only, null for UI-only cases:',
    '                   { "method": "POST", "url": "{{baseUrl}}/endpoint",',
    '                     "headers": { "Content-Type": "application/json" },',
    '                     "body": { ... } }',
    '  response       — for API test cases only, null for UI-only cases:',
    '                   { "status": 200, "body": { ... } }',
    '  Use {{baseUrl}} as a placeholder for the API base URL.',
    '  Use {{token}} for authorisation tokens. Do NOT invent real credentials.',
    '  Set request and response to null for purely UI test cases.',
    '',
    'Return ONLY the JSON array.',
  ].join('\n');
}

// ── Core generation ────────────────────────────────────────────────────────────

export async function runCaseSetGeneration(
  csId: string,
  tp: TestProject,
  description: string,
  createdBy: string,
  attachmentIds: string[] = [],
  resumeFrom?: { existingCaseCount: number; categoriesToGenerate: string[] },
): Promise<void> {
  // Local trace state — continue seq from the max existing seq when resuming
  const existingMaxSeq = (() => {
    try {
      const r = one<{ m: number | null }>('SELECT MAX(seq) AS m FROM trace_steps WHERE case_set_id = ?', csId);
      return r?.m ?? 0;
    } catch { return 0; }
  })();
  let seq = existingMaxSeq;
  let _failureStepAdded = false;
  const mk = (kind: string, label: string, detail?: Record<string, unknown>) =>
    startStep({ parentKind: 'case_set', parentId: csId, seq: ++seq, kind, label, detail });
  const fin = finishStep;

  // Convenience: add a terminal 'cancelled' step and return
  const traceCancel = () => {
    const s = mk('cancelled', 'Generation cancelled');
    fin(s.id, s.startedAt, { status: 'ok' });
  };
  // Convenience: add a terminal 'failure' step
  const traceFail = (error: string) => {
    if (_failureStepAdded) return;
    _failureStepAdded = true;
    const s = mk('failure', 'Generation failed');
    fin(s.id, s.startedAt, { status: 'failed', error });
  };

  try {
    run(
      'UPDATE test_case_sets SET status = ?, started_at = ?, cancelled = 0, error = NULL WHERE id = ?',
      'running', now(), csId,
    );
  } catch { return; }

  try {
    // ── Phase: context ──────────────────────────────────────────────────────
    setProgress(csId, { phase: 'context', message: 'Building context…', percent: 0 });

    const ctxStep = mk('context', 'Building context');

    // Resolve attachment IDs — from parameter or (on resume) from the saved row
    const resolvedAttachmentIds = attachmentIds.length > 0
      ? attachmentIds
      : (() => {
          try {
            const row = one<{ attachment_ids: string }>('SELECT attachment_ids FROM test_case_sets WHERE id = ?', csId);
            return JSON.parse(row?.attachment_ids ?? '[]') as string[];
          } catch { return []; }
        })();

    let textBlock = '';
    let images: Array<{ data: Buffer; mimeType: string; filename: string }> = [];
    let attachmentNames: string[] = [];
    if (resolvedAttachmentIds.length > 0) {
      const { rows } = validateAttachmentIds(tp.project_id, resolvedAttachmentIds);
      if (rows) attachmentNames = rows.map((r) => String(r.filename));
      const ctx = await buildAttachmentContext(rows ?? []);
      textBlock = ctx.textBlock;
      images = ctx.images;
    }

    const attachmentNote = images.length > 0
      ? 'Images showing the app UI or architecture have been provided as reference material.'
      : textBlock.length > 0
        ? 'Attached source files have been provided below as reference material.'
        : undefined;

    const systemPrompt = buildSystemPrompt(tp, attachmentNote) + textBlock;

    fin(ctxStep.id, ctxStep.startedAt, {
      status: 'ok',
      detail: { attachmentNames, textChars: textBlock.length, imageCount: images.length },
      prompt: { system: systemPrompt },
    });

    if (isCancelled(csId)) { traceCancel(); return; }

    // ── Resolve categories (resume path vs. full generation path) ────────────
    let categories: string[];

    if (resumeFrom) {
      // Resume: categories already resolved by caller; add a resume trace step
      categories = resumeFrom.categoriesToGenerate;
      const resumeStep = mk('resume', 'Resuming generation', {
        existingCaseCount: resumeFrom.existingCaseCount,
        categoriesToGenerate: categories,
      });
      fin(resumeStep.id, resumeStep.startedAt, { status: 'ok' });

      if (categories.length === 0) {
        // Nothing to do — all categories already have cases
        const doneStep = mk('done', 'Generation complete (nothing remaining)');
        setProgress(csId, { phase: 'done', message: 'Complete', percent: 100 });
        const warnings: string[] = [];
        try {
          const existing = all<{ warnings: string }>(
            'SELECT warnings FROM test_case_sets WHERE id = ?', csId,
          );
          try { const parsed = JSON.parse(existing[0]?.warnings ?? '[]') as string[]; warnings.push(...parsed); } catch { /**/ }
        } catch { /**/ }
        run(
          `UPDATE test_case_sets SET status = 'done', finished_at = ?, warnings = ? WHERE id = ? AND cancelled = 0`,
          now(), JSON.stringify(warnings), csId,
        );
        fin(doneStep.id, doneStep.startedAt, { status: 'ok', detail: { warningsCount: warnings.length } });
        return;
      }
    } else {
      // Full generation: run the outline phase
      setProgress(csId, { phase: 'outline', message: 'Generating outline…', percent: 5 });

      const outlineUserPrompt = buildOutlinePrompt(description);
      const outlineStep = mk('outline', 'Generating test outline');

      let outlineText: string;
      try {
        outlineText = await callTextModel(
          systemPrompt,
          outlineUserPrompt,
          { maxTokens: 2048, createdBy, images },
        );
      } catch (outlineErr) {
        fin(outlineStep.id, outlineStep.startedAt, {
          status: 'failed',
          error: String((outlineErr as Error).message ?? outlineErr),
          prompt: { user: outlineUserPrompt },
        });
        throw outlineErr;
      }

      let rawCategories: unknown;
      try {
        rawCategories = extractJsonArray(outlineText);
      } catch (e) {
        fin(outlineStep.id, outlineStep.startedAt, {
          status: 'failed',
          error: `Outline parse failed: ${(e as Error).message}`,
          output: outlineText,
          prompt: { user: outlineUserPrompt },
        });
        throw new Error(`Outline failed: ${(e as Error).message}`);
      }

      if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
        fin(outlineStep.id, outlineStep.startedAt, {
          status: 'failed',
          error: 'Outline returned no categories.',
          output: outlineText,
          prompt: { user: outlineUserPrompt },
        });
        throw new Error('Outline returned no categories.');
      }

      const parsed: string[] = rawCategories.map((c, i) => {
        if (c && typeof c === 'object' && 'name' in c && typeof (c as Record<string, unknown>).name === 'string') {
          return String((c as Record<string, unknown>).name).trim();
        }
        if (typeof c === 'string') return c.trim();
        return `Category ${i + 1}`;
      }).filter(Boolean);

      if (parsed.length === 0) {
        fin(outlineStep.id, outlineStep.startedAt, {
          status: 'failed',
          error: 'Outline returned no usable categories.',
          output: outlineText,
          prompt: { user: outlineUserPrompt },
        });
        throw new Error('Outline returned no usable categories.');
      }

      categories = parsed;

      // Persist the outline for future resumes
      try {
        run('UPDATE test_case_sets SET outline_categories = ? WHERE id = ?', JSON.stringify(categories), csId);
      } catch { /* best effort */ }

      fin(outlineStep.id, outlineStep.startedAt, {
        status: 'ok',
        detail: { categoryNames: categories },
        output: outlineText,
        prompt: { user: outlineUserPrompt },
      });

      if (isCancelled(csId)) { traceCancel(); return; }
    }

    setProgress(csId, {
      phase: 'cases',
      message: `Generating cases for ${categories.length} categories…`,
      percent: 10,
      categoriesTotal: categories.length,
      categoriesDone: 0,
      casesSoFar: resumeFrom?.existingCaseCount ?? 0,
    });

    // ── Phase: cases ────────────────────────────────────────────────────────
    const warnings: string[] = [];
    // globalOrd tracks the TOTAL ord for newly inserted rows (offset by existing count for resume)
    const existingOrdBase = (() => {
      const r = one<{ m: number | null }>('SELECT MAX(ord) AS m FROM test_cases WHERE case_set_id = ?', csId);
      return r?.m ?? 0;
    })();
    let globalOrd = existingOrdBase;
    let categoriesDone = 0;

    for (let i = 0; i < categories.length; i++) {
      if (isCancelled(csId)) { traceCancel(); return; }

      const catName = categories[i];
      // catIdx must account for categories already present; getCategoryOrder returns them in order
      const existingCats = getCategoryOrder(csId);
      let catIdx = existingCats.map(normCat).indexOf(normCat(catName)) + 1;
      if (catIdx === 0) catIdx = existingCats.length + 1;
      const userMsg = buildCategoryPrompt(description, catName, textBlock);

      let rawCasesText: string | null = null;
      let rawCases: unknown = null;
      let parseOk = false;

      for (let attempt = 0; attempt < 2; attempt++) {
        if (isCancelled(csId)) { traceCancel(); return; }

        const catLabel = attempt === 0
          ? `Category: ${catName}`
          : `Category: ${catName} (retry)`;
        const catStep = mk('category', catLabel, { categoryName: catName, attempt: attempt + 1 });

        try {
          rawCasesText = await callTextModel(systemPrompt, userMsg, { maxTokens: 8192, createdBy, images });
          rawCases = extractJsonArray(rawCasesText);
          parseOk = true;
          fin(catStep.id, catStep.startedAt, {
            status: 'ok',
            detail: { categoryName: catName, attempt: attempt + 1, casesProduced: (rawCases as unknown[]).length },
            output: rawCasesText,
            prompt: { user: userMsg },
          });
          break;
        } catch (parseErr) {
          rawCases = null;
          parseOk = false;
          fin(catStep.id, catStep.startedAt, {
            status: attempt < 1 ? 'retry' : 'failed',
            detail: { categoryName: catName, attempt: attempt + 1, parseError: String((parseErr as Error).message) },
            output: rawCasesText,
            prompt: { user: userMsg },
          });
        }
      }

      if (!parseOk || !Array.isArray(rawCases)) {
        warnings.push(`Category "${catName}" failed to generate and was skipped.`);
        categoriesDone++;
        const pct = Math.round(10 + (categoriesDone / categories.length) * 85);
        setProgress(csId, { categoriesDone, percent: pct });
        continue;
      }

      if (isCancelled(csId)) { traceCancel(); return; }

      let caseNo = 0;
      for (const raw of rawCases as unknown[]) {
        if (typeof raw !== 'object' || raw === null) continue;
        const r = raw as Record<string, unknown>;
        const scenario = String(r.scenario ?? '').trim();
        if (!scenario) continue;

        caseNo++;
        globalOrd++;
        const testId = `TC-${catIdx}.1.${caseNo}`;

        try {
          insert('test_cases', {
            id: generateId(),
            case_set_id: csId,
            ord: globalOrd,
            test_id: testId,
            category: catName,
            scenario: scenario.slice(0, MAX_CASE_TEXT),
            precondition: String(r.precondition ?? '').slice(0, MAX_CASE_TEXT),
            steps: String(r.steps ?? '').slice(0, MAX_CASE_TEXT),
            expected_result: String(r.expectedResult ?? r.expected_result ?? '').slice(0, MAX_CASE_TEXT),
            status: '',
            remarks: '',
            request: parseRequestFromModel(r.request),
            response: parseResponseFromModel(r.response),
            created_at: now(),
            updated_at: now(),
          });
        } catch {
          return;
        }
      }

      categoriesDone++;
      const pct = Math.round(10 + (categoriesDone / categories.length) * 85);
      setProgress(csId, {
        phase: 'cases',
        message: `Generated ${categoriesDone} of ${categories.length} categories`,
        percent: pct,
        categoriesTotal: categories.length,
        categoriesDone,
        casesSoFar: globalOrd,
      });
    }

    if (isCancelled(csId)) { traceCancel(); return; }

    const totalNewCases = globalOrd - existingOrdBase;
    if (totalNewCases === 0 && !resumeFrom) {
      const noMsg = 'No test cases were generated. Try a more specific description or check the model output.';
      traceFail(noMsg);
      run(
        `UPDATE test_case_sets SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
        noMsg, now(), csId,
      );
      return;
    }

    // ── Phase: saving ───────────────────────────────────────────────────────
    const savingStep = mk('saving', 'Saving and renumbering cases');
    setProgress(csId, { phase: 'saving', message: 'Saving…', percent: 98 });
    renumberCases(csId);
    fin(savingStep.id, savingStep.startedAt, {
      status: 'ok',
      detail: { caseCount: globalOrd, warningsCount: warnings.length },
    });

    if (isCancelled(csId)) { traceCancel(); return; }

    // ── Phase: done ─────────────────────────────────────────────────────────
    const doneStep = mk('done', 'Generation complete');
    setProgress(csId, { phase: 'done', message: 'Complete', percent: 100 });
    run(
      `UPDATE test_case_sets SET status = 'done', finished_at = ?, warnings = ? WHERE id = ? AND cancelled = 0`,
      now(), JSON.stringify(warnings), csId,
    );
    fin(doneStep.id, doneStep.startedAt, {
      status: 'ok',
      detail: { caseCount: globalOrd, warningsCount: warnings.length },
    });

    // Delete attachments now that the set is done
    if (resolvedAttachmentIds.length > 0) {
      try { await deleteAttachmentsByIds(resolvedAttachmentIds); } catch { /* best effort */ }
    }
  } catch (err) {
    if (isCancelled(csId)) return;
    traceFail(String((err as Error).message ?? err));
    try {
      run(
        `UPDATE test_case_sets SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
        String((err as Error).message ?? err), now(), csId,
      );
    } catch { /* DB closed */ }
    // Attachments are NOT deleted on failure — kept for resume
  }
}

/**
 * Variant for resume when no saved outline exists.
 * Runs the outline, filters out categories already present (by normalised name),
 * then calls runCaseSetGeneration in resume mode.
 */
async function runCaseSetGenerationWithExistingFilter(
  csId: string,
  tp: TestProject,
  description: string,
  createdBy: string,
  existingCatNames: string[],
): Promise<void> {
  // We need the outline to filter, so build a minimal context for the model call.
  const systemPrompt = buildSystemPrompt(tp);
  const outlineUserPrompt = buildOutlinePrompt(description);

  const existingNorm = existingCatNames.map(normCat);

  let categories: string[];
  try {
    const outlineText = await callTextModel(systemPrompt, outlineUserPrompt, { maxTokens: 2048, createdBy });
    const rawCategories = extractJsonArray(outlineText);
    if (!Array.isArray(rawCategories) || rawCategories.length === 0) {
      throw new Error('Outline returned no categories');
    }
    const parsed: string[] = rawCategories.map((c, i) => {
      if (c && typeof c === 'object' && 'name' in c && typeof (c as Record<string, unknown>).name === 'string') {
        return String((c as Record<string, unknown>).name).trim();
      }
      if (typeof c === 'string') return c.trim();
      return `Category ${i + 1}`;
    }).filter(Boolean);

    // Persist the outline
    try { run('UPDATE test_case_sets SET outline_categories = ? WHERE id = ?', JSON.stringify(parsed), csId); } catch { /* ok */ }

    // Filter to categories not already present
    categories = parsed.filter((cat) => !existingNorm.includes(normCat(cat)));
  } catch (err) {
    try {
      run(
        `UPDATE test_case_sets SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
        String((err as Error).message ?? err), now(), csId,
      );
    } catch { /* DB closed */ }
    return;
  }

  const existingCaseCount = getCaseCount(csId);
  await runCaseSetGeneration(csId, tp, description, createdBy, [], {
    existingCaseCount,
    categoriesToGenerate: categories,
  });
}

// ── Route helpers ──────────────────────────────────────────────────────────────

function requireCaseSet(
  req: PortalRequest,
  res: PortalResponse,
  csId: string,
  tp: TestProject,
): TestCaseSet | null {
  const cs = one<TestCaseSet>(
    'SELECT * FROM test_case_sets WHERE id = ? AND test_project_id = ?',
    csId, tp.id,
  );
  if (!cs) { sendJson(res, 404, { error: 'Case set not found' }); return null; }
  return cs;
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerCaseSetRoutes(): void {

  // POST /case-sets — create + start generation
  router.post('/api/projects/:pid/tests/:tpid/case-sets', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const description = str(body.description, 'description', { max: 8000 }).trim();
    const rawName = str(body.name, 'name', { max: 120, optional: true }).trim();
    const name = rawName || description.slice(0, 120);
    const rawAttachmentIds = Array.isArray(body.attachmentIds)
      ? (body.attachmentIds as unknown[]).map(String)
      : [];

    if (rawAttachmentIds.length > 0) {
      const { error } = validateAttachmentIds(req.params.pid, rawAttachmentIds);
      if (error) { sendJson(res, 400, { error }); return; }
    }

    const csId = generateId();
    const ts = now();
    const initProgress: Progress = { phase: 'queued', message: 'Waiting to start', percent: 0, categoriesTotal: 0, categoriesDone: 0, casesSoFar: 0 };

    insert('test_case_sets', {
      id: csId,
      test_project_id: tp.id,
      name,
      description,
      status: 'pending',
      progress: JSON.stringify(initProgress),
      error: null,
      warnings: '[]',
      created_by: req.user!.id,
      created_at: ts,
      started_at: null,
      finished_at: null,
      cancelled: 0,
      attachment_ids: JSON.stringify(rawAttachmentIds),
    });

    auditRaw(req.user!.id, 'test_case_set.create', `test_case_set:${csId}`, { name });

    const cs = one<TestCaseSet>('SELECT * FROM test_case_sets WHERE id = ?', csId)!;

    runCaseSetGeneration(csId, tp, description, req.user!.id, rawAttachmentIds).catch(() => {});

    sendJson(res, 202, { caseSet: formatCaseSet(cs) });
  });

  // GET /case-sets — list all, newest first
  router.get('/api/projects/:pid/tests/:tpid/case-sets', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;

    const rows = all<TestCaseSet>(
      'SELECT * FROM test_case_sets WHERE test_project_id = ? ORDER BY created_at DESC',
      tp.id,
    );
    sendJson(res, 200, { caseSets: rows.map((cs) => formatCaseSet(cs)) });
  });

  // GET /case-sets/:csid — get with cases
  router.get('/api/projects/:pid/tests/:tpid/case-sets/:csid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    const cases = all<TestCase>(
      'SELECT * FROM test_cases WHERE case_set_id = ? ORDER BY ord',
      cs.id,
    );
    sendJson(res, 200, { caseSet: formatCaseSet(cs), cases: cases.map(formatCase) });
  });

  // PATCH /case-sets/:csid — update name
  router.patch('/api/projects/:pid/tests/:tpid/case-sets/:csid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();

    run('UPDATE test_case_sets SET name = ? WHERE id = ?', name, cs.id);
    const updated = one<TestCaseSet>('SELECT * FROM test_case_sets WHERE id = ?', cs.id)!;
    sendJson(res, 200, { caseSet: formatCaseSet(updated) });
  });

  // DELETE /case-sets/:csid — delete + cancel
  router.delete('/api/projects/:pid/tests/:tpid/case-sets/:csid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    // Signal cancellation before deleting (so running generation detects it before FK errors)
    try { run('UPDATE test_case_sets SET cancelled = 1 WHERE id = ?', cs.id); } catch { /* ok */ }
    // Clean up any stored attachments
    try {
      const attIds = JSON.parse(cs.attachment_ids || '[]') as string[];
      if (attIds.length > 0) await deleteAttachmentsByIds(attIds);
    } catch { /* best effort */ }
    run('DELETE FROM test_case_sets WHERE id = ?', cs.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /case-sets/:csid/cancel — cancel generation
  router.post('/api/projects/:pid/tests/:tpid/case-sets/:csid/cancel', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    if (cs.status === 'pending' || cs.status === 'running') {
      run(
        `UPDATE test_case_sets SET cancelled = 1, status = 'cancelled', finished_at = ? WHERE id = ?`,
        now(), cs.id,
      );
    }

    const updated = one<TestCaseSet>('SELECT * FROM test_case_sets WHERE id = ?', cs.id)!;
    sendJson(res, 200, { caseSet: formatCaseSet(updated) });
  });

  // POST /case-sets/:csid/resume — resume a failed/cancelled set, or re-generate skipped categories
  router.post('/api/projects/:pid/tests/:tpid/case-sets/:csid/resume', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    // 409 when already running/pending
    if (cs.status === 'pending' || cs.status === 'running') {
      sendJson(res, 409, { error: 'Case set is already running' });
      return;
    }

    // Only failed, cancelled, or done-with-warnings sets are resumable
    const warnings = parseWarnings(cs.warnings);
    const resumable =
      cs.status === 'failed' ||
      cs.status === 'cancelled' ||
      (cs.status === 'done' && warnings.length > 0);
    if (!resumable) {
      sendJson(res, 409, { error: 'Case set is not resumable' });
      return;
    }

    const existingCaseCount = getCaseCount(cs.id);
    const existingCatNames = getCategoryOrder(cs.id);

    let categoriesToGenerate: string[];

    if (cs.outline_categories) {
      // Use saved outline: generate only categories with zero cases
      try {
        const outline = JSON.parse(cs.outline_categories) as string[];
        categoriesToGenerate = outline.filter(
          (cat) => !existingCatNames.some((e) => normCat(e) === normCat(cat)),
        );
      } catch {
        categoriesToGenerate = [];
      }
    } else {
      // No saved outline: we'll run a fresh outline inside runCaseSetGeneration,
      // filtered to categories whose names don't match existing ones.
      // Pass an empty array — the generation function will handle the "no saved list" case
      // by running the outline and filtering out names matching existing categories.
      categoriesToGenerate = [];
    }

    // For the "no saved outline" case, we need a fresh outline.
    // Signal this by passing resumeFrom with an empty list — generation will re-outline.
    const resumeFrom = cs.outline_categories
      ? { existingCaseCount, categoriesToGenerate }
      : null;

    // Reset cancelled flag so isCancelled() works correctly
    run(
      'UPDATE test_case_sets SET cancelled = 0, status = ?, error = NULL WHERE id = ?',
      'pending', cs.id,
    );

    const updated = one<TestCaseSet>('SELECT * FROM test_case_sets WHERE id = ?', cs.id)!;

    if (resumeFrom) {
      runCaseSetGeneration(cs.id, tp, cs.description, req.user!.id, [], resumeFrom).catch(() => {});
    } else {
      // No saved outline: run full generation but skip categories whose names already exist
      runCaseSetGenerationWithExistingFilter(cs.id, tp, cs.description, req.user!.id, existingCatNames).catch(() => {});
    }

    sendJson(res, 202, { caseSet: formatCaseSet(updated) });
  });

  // GET /case-sets/:csid/trace — generation trace steps
  router.get('/api/projects/:pid/tests/:tpid/case-sets/:csid/trace', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    const steps = getCaseSetTrace(cs.id);
    sendJson(res, 200, { steps });
  });

  // POST /case-sets/:csid/cases — add a case row
  router.post('/api/projects/:pid/tests/:tpid/case-sets/:csid/cases', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const category = str(body.category, 'category', { max: MAX_CASE_TEXT, optional: true }).trim();
    const scenario = str(body.scenario, 'scenario', { max: MAX_CASE_TEXT }).trim();
    const precondition = str(body.precondition, 'precondition', { max: MAX_CASE_TEXT, optional: true });
    const steps = str(body.steps, 'steps', { max: MAX_CASE_TEXT, optional: true });
    const expectedResult = str(body.expectedResult, 'expectedResult', { max: MAX_CASE_TEXT, optional: true });
    const status = str(body.status, 'status', { optional: true });
    const remarks = str(body.remarks, 'remarks', { max: MAX_CASE_TEXT, optional: true });

    if (status && !VALID_STATUSES.has(status)) {
      throw badRequest(`status must be one of: '', 'Pass', 'Fail', 'Blocked', 'Not Run'`);
    }

    const requestJson = 'request' in body ? validateRequestField(body.request) : null;
    const responseJson = 'response' in body ? validateResponseField(body.response) : null;

    const nextOrd = (() => {
      const r = one<{ m: number | null }>('SELECT MAX(ord) AS m FROM test_cases WHERE case_set_id = ?', cs.id);
      return (r?.m ?? 0) + 1;
    })();

    const effectiveCategory = category || 'Uncategorised';
    const cid = generateId();
    const testId = computeTestId(cs.id, effectiveCategory);
    const ts = now();

    insert('test_cases', {
      id: cid,
      case_set_id: cs.id,
      ord: nextOrd,
      test_id: testId,
      category: effectiveCategory,
      scenario,
      precondition,
      steps,
      expected_result: expectedResult,
      status: status || '',
      remarks,
      request: requestJson,
      response: responseJson,
      created_at: ts,
      updated_at: ts,
    });

    const newCase = one<TestCase>('SELECT * FROM test_cases WHERE id = ?', cid)!;
    sendJson(res, 201, { case: formatCase(newCase) });
  });

  // PUT /case-sets/:csid/cases/:cid — update case fields
  router.put('/api/projects/:pid/tests/:tpid/case-sets/:csid/cases/:cid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    const existingCase = one<TestCase>(
      'SELECT * FROM test_cases WHERE id = ? AND case_set_id = ?',
      req.params.cid, cs.id,
    );
    if (!existingCase) { sendJson(res, 404, { error: 'Case not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;

    const updates: Record<string, unknown> = { updated_at: now() };

    if ('category' in body) updates.category = str(body.category, 'category', { max: MAX_CASE_TEXT }).trim();
    if ('scenario' in body) updates.scenario = str(body.scenario, 'scenario', { max: MAX_CASE_TEXT }).trim();
    if ('precondition' in body) updates.precondition = str(body.precondition, 'precondition', { max: MAX_CASE_TEXT, optional: true });
    if ('steps' in body) updates.steps = str(body.steps, 'steps', { max: MAX_CASE_TEXT, optional: true });
    if ('expectedResult' in body) updates.expected_result = str(body.expectedResult, 'expectedResult', { max: MAX_CASE_TEXT, optional: true });
    if ('status' in body) {
      const s = str(body.status, 'status', { optional: true });
      if (!VALID_STATUSES.has(s)) throw badRequest(`status must be one of: '', 'Pass', 'Fail', 'Blocked', 'Not Run'`);
      updates.status = s;
    }
    if ('remarks' in body) updates.remarks = str(body.remarks, 'remarks', { max: MAX_CASE_TEXT, optional: true });
    if ('request' in body) updates.request = validateRequestField(body.request);
    if ('response' in body) updates.response = validateResponseField(body.response);

    const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    const vals = [...Object.values(updates), existingCase.id];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run(`UPDATE test_cases SET ${setClauses} WHERE id = ?`, ...(vals as any[]));

    const updated = one<TestCase>('SELECT * FROM test_cases WHERE id = ?', existingCase.id)!;
    sendJson(res, 200, { case: formatCase(updated) });
  });

  // DELETE /case-sets/:csid/cases/:cid — remove a case
  router.delete('/api/projects/:pid/tests/:tpid/case-sets/:csid/cases/:cid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    const existingCase = one<TestCase>(
      'SELECT id FROM test_cases WHERE id = ? AND case_set_id = ?',
      req.params.cid, cs.id,
    );
    if (!existingCase) { sendJson(res, 404, { error: 'Case not found' }); return; }

    run('DELETE FROM test_cases WHERE id = ?', existingCase.id);
    sendJson(res, 200, { ok: true });
  });

  // GET /case-sets/:csid/export.xlsx — Excel workbook
  router.get('/api/projects/:pid/tests/:tpid/case-sets/:csid/export.xlsx', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;
    const cs = requireCaseSet(req, res, req.params.csid, tp);
    if (!cs) return;

    const cases = all<TestCase>('SELECT * FROM test_cases WHERE case_set_id = ? ORDER BY ord', cs.id);

    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    wb.creator = 'Agent Portal';
    wb.created = new Date();

    const HEADER_FILL: import('exceljs').Fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    const HEADER_FONT: Partial<import('exceljs').Font> = { bold: true, color: { argb: 'FFFFFFFF' } };
    const DATA_ALIGNMENT: Partial<import('exceljs').Alignment> = { wrapText: true, vertical: 'top' };

    // ── Sheet: Test Cases ──────────────────────────────────────────────────
    const ws = wb.addWorksheet('Test Cases');
    ws.columns = [
      { header: 'Test ID',         key: 'testId',         width: 12 },
      { header: 'Category',        key: 'category',       width: 35 },
      { header: 'Scenario',        key: 'scenario',       width: 60 },
      { header: 'Precondition',    key: 'precondition',   width: 50 },
      { header: 'Test Steps',      key: 'steps',          width: 70 },
      { header: 'Expected Result', key: 'expectedResult', width: 60 },
      { header: 'Status',          key: 'status',         width: 12 },
      { header: 'Remarks',         key: 'remarks',        width: 30 },
      { header: 'Request',         key: 'request',        width: 80 },
      { header: 'Response',        key: 'response',       width: 60 },
    ];

    ws.getRow(1).eachCell((cell) => {
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
    });
    ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];

    for (const c of cases) {
      const reqObj = c.request ? parseJson<Record<string, unknown>>(c.request, {}) : null;
      const resObj = c.response ? parseJson<Record<string, unknown>>(c.response, {}) : null;

      const row = ws.addRow({
        testId: c.test_id,
        category: c.category,
        scenario: c.scenario,
        precondition: c.precondition,
        steps: c.steps,
        expectedResult: c.expected_result,
        status: c.status,
        remarks: c.remarks,
        request: reqObj ? formatAsCurl(reqObj as Parameters<typeof formatAsCurl>[0]) : '',
        response: resObj ? formatResponseText(resObj as Parameters<typeof formatResponseText>[0]) : '',
      });
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = DATA_ALIGNMENT;
      });
    }

    // ── Sheet: Summary ─────────────────────────────────────────────────────
    const ws2 = wb.addWorksheet('Summary');
    ws2.columns = [
      { header: 'Category',         key: 'category', width: 45 },
      { header: 'Test Cases Count', key: 'count',    width: 20 },
    ];
    ws2.getRow(1).eachCell((cell) => {
      cell.fill = HEADER_FILL;
      cell.font = HEADER_FONT;
    });
    ws2.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];

    const catCounts = new Map<string, number>();
    const catOrder: string[] = [];
    for (const c of cases) {
      if (!catOrder.includes(c.category)) catOrder.push(c.category);
      catCounts.set(c.category, (catCounts.get(c.category) ?? 0) + 1);
    }
    for (const cat of catOrder) {
      const row = ws2.addRow({ category: cat, count: catCounts.get(cat) ?? 0 });
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = DATA_ALIGNMENT;
      });
    }

    // ── Send response ──────────────────────────────────────────────────────
    const safeName = cs.name.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'Test_Cases';
    const filename = `${safeName}_Test_Cases.xlsx`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await wb.xlsx.writeBuffer() as any;

    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.byteLength),
    });
    res.end(Buffer.from(buffer));
  });
}

// ── M40 migration SQL (reference copy — actual migration lives in server/db.ts) ──

export const M40_CASE_SETS = `
  CREATE TABLE IF NOT EXISTS test_case_sets (
    id TEXT PRIMARY KEY,
    test_project_id TEXT NOT NULL REFERENCES test_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','done','failed','cancelled')),
    progress TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    warnings TEXT NOT NULL DEFAULT '[]',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS test_case_sets_project ON test_case_sets(test_project_id, created_at);

  CREATE TABLE IF NOT EXISTS test_cases (
    id TEXT PRIMARY KEY,
    case_set_id TEXT NOT NULL REFERENCES test_case_sets(id) ON DELETE CASCADE,
    ord REAL NOT NULL DEFAULT 0,
    test_id TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    scenario TEXT NOT NULL DEFAULT '',
    precondition TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '',
    expected_result TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '' CHECK(status IN ('','Pass','Fail','Blocked','Not Run')),
    remarks TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS test_cases_case_set ON test_cases(case_set_id, ord);
`;
