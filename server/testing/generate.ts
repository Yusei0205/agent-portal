/**
 * AI-assisted test generation and import (F12c).
 *
 * Generation is async with a status endpoint.
 * The model call is injectable (setModelCallFn) for testing.
 *
 * Routes:
 *   POST /api/projects/:pid/tests/:tpid/generate              — generate script (async)
 *   POST /api/projects/:pid/tests/:tpid/scripts/:sid/refine   — refine script (async)
 *   GET  /api/projects/:pid/tests/:tpid/generate/:genId       — get generation status
 *   POST /api/projects/:pid/tests/:tpid/import                — import from spreadsheet/doc
 */

import fs from 'node:fs';
import path from 'node:path';
import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { all, one, run, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now, str } from '../util.ts';
import { auditRaw } from '../audit.ts';
import { config } from '../config.ts';
import {
  requireTestProject,
  hasScope,
} from './helpers.ts';
import type { TestProject, TestGeneration, TestScript } from './helpers.ts';
import { validateStep, validateSteps, attemptRepairStep } from './types.ts';
import type { Step } from './types.ts';
import { callTextModel } from './model-provider.ts';
import { convertToMarkdown } from '../convert.ts';
import { validateAttachmentIds, deleteAttachmentsByIds } from '../ai-attachments.ts';

// ── Injectable model call ──────────────────────────────────────────────────────

export type ModelCallFn = (prompt: string, context: ModelCallContext) => Promise<unknown>;

export interface ModelCallContext {
  appUrl: string;
  rulesForAi: string;
  existingSteps?: unknown[];
  /**
   * Full system prompt sent to the AI, including the attachment text block.
   * Present whenever runGeneration has a non-empty system prompt (always).
   */
  systemPrompt?: string;
  /**
   * Image attachment metadata. Empty array when no images are attached.
   * Contains no raw bytes — only filename, MIME type, and size.
   */
  images?: Array<{ filename: string; mimeType: string; size: number }>;
  /**
   * Populated on retry calls only. Contains the per-step validation error
   * messages from the previous model output so the mock can distinguish
   * first-call from retry.
   */
  validationErrors?: string[];
}

let _modelCallFn: ModelCallFn | null = null;

/**
 * Override the model call used by generation/refine/import.
 * Pass null to restore the real provider.
 */
export function setModelCallFn(fn: ModelCallFn | null): void {
  _modelCallFn = fn;
}

// ── System prompt builder ──────────────────────────────────────────────────────

const STEP_KINDS = [
  'goto', 'click', 'fill', 'select', 'press', 'upload',
  'assert_visible', 'assert_text', 'assert_url', 'wait',
  'api_request', 'agent',
];

function buildSystemPrompt(tp: TestProject, existingSteps?: unknown[], attachmentNote?: string): string {
  return `You are a test automation assistant. Generate test steps for the app at: ${tp.app_url}
${tp.api_base_url ? `API base URL: ${tp.api_base_url}` : ''}
${tp.rules_for_ai ? `\nRules:\n${tp.rules_for_ai}` : ''}
${attachmentNote ? `\n${attachmentNote}` : ''}

Output ONLY a valid JSON array. Do NOT include any text, explanation, or markdown outside the JSON array.

CRITICAL LOCATOR RULE: Every step that uses a locator MUST include exactly one of these locator shapes — no other keys are valid:
  { "role": "button", "name": "Submit" }   ← ARIA role + accessible name
  { "label": "Email" }                      ← form label text
  { "text": "Click here" }                  ← visible text on page
  { "testId": "submit-btn" }                ← data-testid attribute
  { "css": "#submit" }                      ← CSS selector

Step schemas (kind field is required for every step):
  goto:           { "kind": "goto", "path": "/path" }
  click:          { "kind": "click", "locator": { "role": "button", "name": "Submit" } }
  fill:           { "kind": "fill", "locator": { "label": "Email" }, "value": "user@example.com" }
  select:         { "kind": "select", "locator": { "label": "Country" }, "value": "US" }
  press:          { "kind": "press", "key": "Enter" }
  upload:         { "kind": "upload", "locator": { "css": "input[type=file]" }, "file": "{{file.resume}}" }
  assert_visible: { "kind": "assert_visible", "locator": { "role": "heading", "name": "Dashboard" } }
  assert_text:    { "kind": "assert_text", "locator": { "testId": "status" }, "text": "Active", "exact": true }
  assert_url:     { "kind": "assert_url", "url": "/dashboard" }
  wait:           { "kind": "wait", "ms": 500 }
  api_request:    { "kind": "api_request", "method": "POST", "path": "/api/login", "expectedStatus": 200 }
  agent:          { "kind": "agent", "instruction": "sign in as admin" }

Vault refs: {{vault.<name>.username}}, {{vault.<name>.password}}, {{vault.<name>.totp}}, {{vault.<name>.value}}
File refs for upload: {{file.<name>}}

Short valid example:
[
  { "kind": "goto", "path": "/login" },
  { "kind": "fill", "locator": { "label": "Email" }, "value": "{{vault.admin.username}}" },
  { "kind": "click", "locator": { "role": "button", "name": "Sign in" } },
  { "kind": "assert_url", "url": "/dashboard" }
]

${existingSteps ? `Existing steps to refine:\n${JSON.stringify(existingSteps, null, 2)}` : ''}`;
}

// ── JSON extraction ────────────────────────────────────────────────────────────

/**
 * Extract a JSON value from model output text.
 *
 * Tolerates:
 *   - Fenced ```json ... ``` or ``` ... ``` blocks (Kiro CLI wraps output this way)
 *   - Leading / trailing prose before/after the JSON
 *   - Plain JSON with no extra text
 *
 * Throws if no parseable JSON array can be found.
 */
export function extractJsonArray(text: string): unknown {
  // 1. Fenced code block — ```json ... ``` or ``` ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const inner = fenced[1].trim();
    try { return JSON.parse(inner); } catch { /* fall through */ }
  }

  // 2. JSON array embedded in surrounding text
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) {
    try { return JSON.parse(arr[0]); } catch { /* fall through */ }
  }

  // 3. Whole text as JSON (no fences, no chatter)
  try { return JSON.parse(text.trim()); } catch { /* fall through */ }

  throw new Error('Model output did not contain a JSON array');
}

// ── Partial salvage ────────────────────────────────────────────────────────────

/**
 * Walk model output step-by-step, collecting valid/repaired steps.
 * Invalid steps that cannot be repaired are dropped and recorded as warnings.
 */
function salvagePartialOutput(raw: unknown[]): { steps: Step[]; warnings: string[] } {
  const steps: Step[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const result = attemptRepairStep(raw[i], i);
    if (result.step) {
      steps.push(result.step);
      if (result.repair) {
        warnings.push(`step[${i}] repaired: ${result.repair}`);
      }
    } else {
      warnings.push(`step[${i}] dropped: ${result.error ?? 'invalid step'}`);
    }
  }

  return { steps, warnings };
}

// ── Retry prompt ───────────────────────────────────────────────────────────────

function buildRetryPrompt(originalPrompt: string, stepErrors: string[]): string {
  return `${originalPrompt}

---
Your previous output had these validation problems:
${stepErrors.map((e) => `  - ${e}`).join('\n')}

REMINDER — every locator must use exactly one of:
  { "role": "...", "name": "..." }   { "label": "..." }   { "text": "..." }   { "testId": "..." }   { "css": "..." }

Return the corrected full JSON array only. No explanation, no text outside the JSON.`;
}

// ── CSV parser (same as vault.ts) ─────────────────────────────────────────────

function parseCsvImport(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseRow = (line: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQuote = false; }
        else { cur += ch; }
      } else {
        if (ch === '"') { inQuote = true; }
        else if (ch === ',') { cells.push(cur); cur = ''; }
        else { cur += ch; }
      }
    }
    cells.push(cur);
    return cells;
  };
  return {
    headers: parseRow(lines[0]).map((h) => h.trim().toLowerCase()),
    rows: lines.slice(1).map(parseRow),
  };
}

// ── Attachment context builder ─────────────────────────────────────────────────

/** Max total chars from all document/diagram attachments in a single prompt. */
const ATTACHMENT_TEXT_BUDGET = 50_000;

/**
 * Convert document/diagram attachments to prompt text and collect image buffers.
 * Returns both the text block (to append to the system prompt) and the image list
 * (to pass as multi-modal inputs to callTextModel).
 */
async function buildAttachmentContext(
  attachmentRows: Row[],
): Promise<{
  textBlock: string;
  images: Array<{ data: Buffer; mimeType: string; filename: string }>;
}> {
  const textDocs: Array<{ filename: string; content: string }> = [];
  const images: Array<{ data: Buffer; mimeType: string; filename: string }> = [];

  for (const att of attachmentRows) {
    const kind = String(att.kind);
    const filePath = String(att.file_path);
    const filename = String(att.filename);

    if (kind === 'image') {
      try {
        const data = fs.readFileSync(filePath);
        images.push({ data, mimeType: String(att.mime_type), filename });
      } catch {
        // file missing — skip silently
      }
    } else {
      // document or diagram — convert to markdown text
      let content: string;
      try {
        content = await convertToMarkdown(filePath, String(att.mime_type));
      } catch (e: unknown) {
        content = `(Could not extract text: ${e instanceof Error ? e.message : String(e)})`;
      }
      textDocs.push({ filename, content });
    }
  }

  // Apply per-file text budget
  let textBlock = '';
  if (textDocs.length > 0) {
    const perFile = Math.floor(ATTACHMENT_TEXT_BUDGET / textDocs.length);
    const truncNote = '\n\n[... content truncated due to size limit ...]';
    const parts = textDocs.map(({ filename, content }) => {
      let body = content;
      if (content.length > perFile) {
        body = content.slice(0, perFile - truncNote.length) + truncNote;
      }
      return `--- FILE: ${filename} ---\n${body}\n--- END FILE: ${filename} ---`;
    });
    textBlock =
      '\n\n## Attached Source Files\n\n' +
      'The following files have been provided as reference material for this generation.\n\n' +
      parts.join('\n\n');
  }

  return { textBlock, images };
}

// ── Core generation logic ──────────────────────────────────────────────────────

export async function runGeneration(
  genId: string,
  tp: TestProject,
  description: string,
  targetGroupId: string,
  existingScriptId: string | null,
  createdBy: string,
  attachmentIds: string[] = [],
): Promise<void> {
  try { run('UPDATE test_generations SET status = ? WHERE id = ?', 'running', genId); }
  catch { return; } // DB closed

  try {
    const existingSteps = existingScriptId
      ? (() => {
          const s = one<TestScript>('SELECT steps FROM test_scripts WHERE id = ?', existingScriptId);
          if (!s) return undefined;
          try { return JSON.parse(String(s.steps || '[]')) as unknown[]; } catch { return undefined; }
        })()
      : undefined;

    // Load and process attachments (single-use: cleaned up after generation)
    let attachmentRows: Row[] = [];
    if (attachmentIds.length > 0) {
      const { rows } = validateAttachmentIds(tp.project_id, attachmentIds);
      attachmentRows = rows ?? [];
    }

    const { textBlock, images } = await buildAttachmentContext(attachmentRows);

    // Build attachment note for system prompt
    const attachmentNote = images.length > 0
      ? 'You have been provided with images showing the app\'s UI, architecture, or design. ' +
        'Use them as reference material to understand the app and generate appropriate test steps. ' +
        'The attached files describe the app under test and should drive the test steps.'
      : textBlock.length > 0
        ? 'Attached source files have been provided below. Use them as primary reference material.'
        : undefined;

    const systemPrompt = buildSystemPrompt(tp, existingSteps, attachmentNote);
    const userPrompt = description;

    // ── Helper: invoke the model and return parsed output ──────────────────
    const callModel = async (userMsg: string, validationErrors?: string[]): Promise<unknown> => {
      if (_modelCallFn) {
        return _modelCallFn(userMsg, {
          appUrl: tp.app_url,
          rulesForAi: tp.rules_for_ai,
          ...(existingSteps ? { existingSteps } : {}),
          systemPrompt: systemPrompt + textBlock,
          images: images.map((img) => ({ filename: img.filename, mimeType: img.mimeType, size: img.data.length })),
          ...(validationErrors ? { validationErrors } : {}),
        });
      }

      const text = await callTextModel(
        systemPrompt + textBlock,
        userMsg,
        { maxTokens: 4096, createdBy, images },
      );
      return extractJsonArray(text);
    };

    // ── First model call ───────────────────────────────────────────────────
    const modelOutput = await callModel(userPrompt);

    if (!Array.isArray(modelOutput)) {
      throw new Error('Model output must be a JSON array of steps');
    }

    // ── Validate — retry once on failure ───────────────────────────────────
    const genWarnings: string[] = [];
    let validatedSteps: Step[];

    try {
      validatedSteps = validateSteps(modelOutput);
    } catch (firstErr) {
      // Collect per-step errors to include in retry prompt
      const stepErrors: string[] = [];
      for (let idx = 0; idx < (modelOutput as unknown[]).length; idx++) {
        try { validateStep((modelOutput as unknown[])[idx], idx); }
        catch (e) { stepErrors.push((e as Error).message); }
      }

      // Retry once with error feedback
      let retryOutput: unknown = null;
      try {
        retryOutput = await callModel(buildRetryPrompt(userPrompt, stepErrors), stepErrors);
      } catch { /* retry call itself failed — proceed to salvage original */ }

      // Choose which output to proceed with
      const outputToSalvage = Array.isArray(retryOutput) ? retryOutput as unknown[] : modelOutput as unknown[];

      // Try full validation on the retry output first
      if (Array.isArray(retryOutput)) {
        try {
          validatedSteps = validateSteps(retryOutput);
        } catch {
          // Retry still has invalid steps — salvage valid + repairable ones
          const salvaged = salvagePartialOutput(retryOutput as unknown[]);
          validatedSteps = salvaged.steps;
          genWarnings.push(...salvaged.warnings);
        }
      } else {
        // Retry failed or returned non-array — salvage from original output
        const salvaged = salvagePartialOutput(outputToSalvage);
        validatedSteps = salvaged.steps;
        genWarnings.push(...salvaged.warnings);
      }

      // If salvage produced no usable steps at all, fail the generation
      if (validatedSteps.length === 0) {
        throw new Error(`Model output contains invalid steps: ${(firstErr as Error).message}`);
      }
    }

    // ── Create or update script ────────────────────────────────────────────
    const ts = now();
    let scriptId: string;

    if (existingScriptId) {
      run('UPDATE test_scripts SET steps = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(validatedSteps), ts, existingScriptId);
      scriptId = existingScriptId;
    } else {
      scriptId = generateId();
      insert('test_scripts', {
        id: scriptId,
        test_project_id: tp.id,
        test_group_id: targetGroupId,
        name: description.slice(0, 200),
        sort_order: 0,
        steps: JSON.stringify(validatedSteps),
        created_by: createdBy,
        created_at: ts,
        updated_at: ts,
      });
    }

    try {
      run(
        'UPDATE test_generations SET status = ?, result_script_ids = ?, finished_at = ?, warnings = ? WHERE id = ?',
        'done', JSON.stringify([scriptId]), ts, JSON.stringify(genWarnings), genId,
      );
    } catch { /* DB closed */ }
  } catch (err) {
    try {
      run('UPDATE test_generations SET status = ?, error = ?, finished_at = ? WHERE id = ?',
        'failed', String((err as Error).message ?? err), now(), genId);
    } catch { /* DB closed */ }
  } finally {
    // Single-use: always clean up test attachments after generation (success or failure)
    if (attachmentIds.length > 0) {
      try { deleteAttachmentsByIds(attachmentIds); } catch { /* best effort */ }
    }
  }
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerGenerateRoutes(): void {

  // POST /api/projects/:pid/tests/:tpid/generate — start generation
  router.post('/api/projects/:pid/tests/:tpid/generate', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const description = str(body.description, 'description', { max: 4000 }).trim();
    const groupId = typeof body.groupId === 'string' ? body.groupId : null;
    const rawAttachmentIds = Array.isArray(body.attachmentIds) ? (body.attachmentIds as unknown[]).map(String) : [];

    // Validate attachment IDs
    if (rawAttachmentIds.length > 0) {
      const { error } = validateAttachmentIds(req.params.pid, rawAttachmentIds);
      if (error) { sendJson(res, 400, { error }); return; }
    }

    // Validate group if provided
    if (groupId) {
      const group = one<Row>('SELECT id FROM test_groups WHERE id = ? AND test_project_id = ?', groupId, tp.id);
      if (!group) { sendJson(res, 400, { error: 'Group not found in this test project' }); return; }
    } else {
      // Create a default group if none exists
      const existing = one<Row>('SELECT id FROM test_groups WHERE test_project_id = ? LIMIT 1', tp.id);
      if (!existing) {
        const gid = generateId();
        const ts = now();
        insert('test_groups', { id: gid, test_project_id: tp.id, name: 'Default', sort_order: 0, created_at: ts, updated_at: ts });
      }
    }

    const effectiveGroupId = groupId ?? (one<Row>('SELECT id FROM test_groups WHERE test_project_id = ? ORDER BY sort_order LIMIT 1', tp.id)?.id as string);

    const genId = generateId();
    const ts = now();
    insert('test_generations', {
      id: genId,
      test_project_id: tp.id,
      script_id: null,
      kind: 'generate',
      description,
      status: 'pending',
      error: null,
      result_script_ids: '[]',
      warnings: '[]',
      created_by: req.user!.id,
      created_at: ts,
      finished_at: null,
    });

    auditRaw(req.user!.id, 'test_generation.start', `test_generation:${genId}`, { description });

    runGeneration(genId, tp, description, effectiveGroupId, null, req.user!.id, rawAttachmentIds).catch(() => {
      // error saved to DB in runGeneration — ignore any trailing DB-closed errors
    });

    sendJson(res, 202, { generationId: genId });
  });

  // POST /api/projects/:pid/tests/:tpid/scripts/:sid/refine — refine existing script
  router.post('/api/projects/:pid/tests/:tpid/scripts/:sid/refine', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const script = one<TestScript>('SELECT * FROM test_scripts WHERE id = ? AND test_project_id = ?', req.params.sid, tp.id);
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const instruction = str(body.instruction, 'instruction', { max: 4000 }).trim();
    const rawAttachmentIds = Array.isArray(body.attachmentIds) ? (body.attachmentIds as unknown[]).map(String) : [];

    // Validate attachment IDs
    if (rawAttachmentIds.length > 0) {
      const { error } = validateAttachmentIds(req.params.pid, rawAttachmentIds);
      if (error) { sendJson(res, 400, { error }); return; }
    }

    const genId = generateId();
    const ts = now();
    insert('test_generations', {
      id: genId,
      test_project_id: tp.id,
      script_id: script.id,
      kind: 'refine',
      description: instruction,
      status: 'pending',
      error: null,
      result_script_ids: '[]',
      warnings: '[]',
      created_by: req.user!.id,
      created_at: ts,
      finished_at: null,
    });

    runGeneration(genId, tp, instruction, script.test_group_id, script.id, req.user!.id, rawAttachmentIds).catch(() => {});

    sendJson(res, 202, { generationId: genId });
  });

  // GET /api/projects/:pid/tests/:tpid/generations — list generations for a test project
  router.get('/api/projects/:pid/tests/:tpid/generations', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;

    const activeOnly = req.query.get('active') === '1';
    const rawLimit = parseInt(req.query.get('limit') ?? '20', 10);
    const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20), 50);

    let gens: TestGeneration[];
    if (activeOnly) {
      gens = all<TestGeneration>(
        "SELECT * FROM test_generations WHERE test_project_id = ? AND status IN ('pending', 'running') ORDER BY created_at DESC",
        tp.id,
      );
    } else {
      gens = all<TestGeneration>(
        'SELECT * FROM test_generations WHERE test_project_id = ? ORDER BY created_at DESC LIMIT ?',
        tp.id, limit,
      );
    }

    const generations = gens.map((gen) => {
      let warnings: string[] = [];
      try { warnings = JSON.parse(String(gen.warnings || '[]')) as string[]; } catch { warnings = []; }

      let resultScriptIds: string[] = [];
      try { resultScriptIds = JSON.parse(String(gen.result_script_ids || '[]')) as string[]; } catch { resultScriptIds = []; }

      const desc = gen.description ?? null;
      const description = desc !== null && desc.length > 200 ? desc.slice(0, 200) : desc;

      return {
        id: gen.id,
        kind: gen.kind,
        description,
        status: gen.status,
        error: gen.error ?? null,
        warnings,
        scriptId: gen.script_id ?? null,
        resultScriptIds,
        createdBy: gen.created_by ?? null,
        createdAt: gen.created_at,
        finishedAt: gen.finished_at ?? null,
      };
    });

    sendJson(res, 200, { generations });
  });

  // GET /api/projects/:pid/tests/:tpid/generate/:genId — get generation status
  router.get('/api/projects/:pid/tests/:tpid/generate/:genId', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const gen = one<TestGeneration>(
      'SELECT * FROM test_generations WHERE id = ? AND test_project_id = ?',
      req.params.genId, tp.id,
    );
    if (!gen) { sendJson(res, 404, { error: 'Generation not found' }); return; }

    // If done, include the created/updated scripts
    let scripts: unknown[] = [];
    if (gen.status === 'done') {
      let ids: string[] = [];
      try { ids = JSON.parse(String(gen.result_script_ids || '[]')) as string[]; } catch { ids = []; }
      scripts = ids.map((sid) => {
        const s = one<TestScript>('SELECT * FROM test_scripts WHERE id = ?', sid);
        if (!s) return null;
        return {
          id: s.id,
          name: s.name,
          steps: (() => { try { return JSON.parse(String(s.steps || '[]')); } catch { return []; } })(),
        };
      }).filter(Boolean);
    }

    // Parse warnings from DB
    let warnings: string[] = [];
    try { warnings = JSON.parse(String(gen.warnings || '[]')) as string[]; } catch { warnings = []; }

    sendJson(res, 200, {
      generation: {
        id: gen.id,
        kind: gen.kind,
        description: gen.description,
        status: gen.status,
        error: gen.error ?? null,
        warnings,
        createdAt: gen.created_at,
        finishedAt: gen.finished_at ?? null,
      },
      scripts,
    });
  });

  // POST /api/projects/:pid/tests/:tpid/import — import test cases from CSV/XLSX/DOCX/MD
  router.post('/api/projects/:pid/tests/:tpid/import', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const groupId = typeof body.groupId === 'string' ? body.groupId : null;

    // Validate group
    let targetGroupId = groupId;
    if (targetGroupId) {
      const group = one<Row>('SELECT id FROM test_groups WHERE id = ? AND test_project_id = ?', targetGroupId, tp.id);
      if (!group) { sendJson(res, 400, { error: 'Group not found' }); return; }
    } else {
      const existing = one<Row>('SELECT id FROM test_groups WHERE test_project_id = ? ORDER BY sort_order LIMIT 1', tp.id);
      if (!existing) {
        const gid = generateId();
        const ts = now();
        insert('test_groups', { id: gid, test_project_id: tp.id, name: 'Imported', sort_order: 0, created_at: ts, updated_at: ts });
        targetGroupId = gid;
      } else {
        targetGroupId = String(existing.id);
      }
    }

    // Parse test cases from CSV text
    // For CSV: columns = name, description (one row = one test case)
    // For each test case, kick off an async generation job
    if (typeof body.csv !== 'string') {
      sendJson(res, 400, { error: 'csv field is required (CSV text with name,description columns)' });
      return;
    }

    const { headers, rows } = parseCsvImport(body.csv);
    const nameIdx = headers.indexOf('name');
    const descIdx = headers.indexOf('description');

    if (nameIdx < 0 || descIdx < 0) {
      sendJson(res, 400, { error: 'CSV must have name and description columns' });
      return;
    }

    const genIds: string[] = [];
    const errors: { row: number; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = (row[nameIdx] ?? '').trim();
      const description = (row[descIdx] ?? '').trim();
      const rowNum = i + 2;

      if (!name) { errors.push({ row: rowNum, error: 'name is required' }); continue; }
      if (!description) { errors.push({ row: rowNum, error: 'description is required' }); continue; }

      const genId = generateId();
      const ts = now();
      insert('test_generations', {
        id: genId,
        test_project_id: tp.id,
        script_id: null,
        kind: 'import',
        description: `${name}: ${description}`,
        status: 'pending',
        error: null,
        result_script_ids: '[]',
        warnings: '[]',
        created_by: req.user!.id,
        created_at: ts,
        finished_at: null,
      });

      runGeneration(genId, tp, `${name}: ${description}`, targetGroupId!, null, req.user!.id).catch(() => {});
      genIds.push(genId);
    }

    sendJson(res, 202, { generationIds: genIds, errors });
  });
}
