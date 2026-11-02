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
 *   GET  /api/projects/:pid/tests/:tpid/generations/:gid/trace — generation trace steps
 */

import { testingRepo } from './data.ts';
import { registerBackgroundJob, runInBackground } from '../background-jobs.ts';
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
  { "role": "button", "name": "Submit" }   ← ARIA role + accessible name
  { "label": "Email" }                      ← form label text
  { "text": "Click here" }                  ← visible text on page
  { "testId": "submit-btn" }                ← data-testid attribute
  { "css": "#submit" }                      ← CSS selector

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

/** Broader ANSI stripper — catches cursor-movement and mode sequences missed by model-provider. */
const EXTRACT_ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-9;?]*[A-Za-z])/g;

/**
 * If `parsed` is a plain object with a `steps` array (e.g. Kiro CLI may return
 * `{"steps":[...]}` instead of a bare array), extract and return the array.
 * Otherwise return `parsed` unchanged.
 */
function unwrapSteps(parsed: unknown): unknown {
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const p = parsed as Record<string, unknown>;
    if (Array.isArray(p.steps)) return p.steps;
  }
  return parsed;
}

/**
 * Extract a JSON value from model output text.
 *
 * Tolerates:
 *   - Fenced ```json ... ``` or ``` ... ``` blocks (Kiro CLI wraps output this way)
 *   - Leading / trailing prose before/after the JSON
 *   - Plain JSON with no extra text
 *   - Object wrapper `{ "steps": [...] }` returned by some models instead of a bare array
 *   - ANSI escape sequences (stripped before parsing)
 *
 * Throws if no parseable JSON array can be found.
 */
export function extractJsonArray(rawText: string): unknown {
  // Strip ANSI codes that may leak through from interactive CLIs.
  const text = rawText.replace(EXTRACT_ANSI_RE, '');

  // 1. Fenced code block — ```json ... ``` or ``` ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const inner = fenced[1].trim();
    try { return unwrapSteps(JSON.parse(inner)); } catch { /* fall through */ }
  }

  // 2. JSON array embedded in surrounding text (handles {steps:[...]}, non-empty)
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) {
    try { return JSON.parse(arr[0]); } catch { /* fall through */ }
  }

  // 3. Bare JSON object with a steps array (e.g. model returned {"steps":[]} with empty array,
  //    so step 2 found no array span, but step 3 can parse and unwrap it)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const unwrapped = unwrapSteps(JSON.parse(objMatch[0]));
      if (Array.isArray(unwrapped)) return unwrapped;
    } catch { /* fall through */ }
  }

  // 4. Whole text as JSON (no fences, no chatter)
  try { return unwrapSteps(JSON.parse(text.trim())); } catch { /* fall through */ }

  // 5. Truncated JSON array recovery — handles Kiro CLI output cut off mid-element
  const openBracket = text.indexOf('[');
  if (openBracket >= 0) {
    const lastClose = text.lastIndexOf('}');
    if (lastClose > openBracket) {
      try {
        const recovered = JSON.parse(text.slice(openBracket, lastClose + 1) + ']');
        if (Array.isArray(recovered)) return recovered;
      } catch { /* fall through */ }
    }
  }

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

// ── Cancellation registry ──────────────────────────────────────────────────────

/**
 * In-memory set of generation IDs that have been cancelled by the cancel endpoint
 * before the background `runGeneration` task completes. The task checks this set
 * before persisting its result.
 */
const cancelledGenerations = new Set<string>();

// ── Progress tracking ──────────────────────────────────────────────────────────

type ProgressPhase = 'preparing' | 'calling' | 'retrying' | 'parsing' | 'saving' | 'done';

async function setProgress(
  genId: string,
  phase: ProgressPhase,
  message: string,
  percent: number,
  stepsSoFar = 0,
): Promise<void> {
  try {
    await testingRepo().updateGeneration(genId, { progress: JSON.stringify({ phase, message, percent, stepsSoFar }) });
  } catch { /* DB closed — best effort */ }
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
export async function buildAttachmentContext(
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

import { startStep, finishStep, getGenerationTrace } from './trace.ts';

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
  // ── Local trace helpers ─────────────────────────────────────────────────
  let seq = 0;
  let _failureStepAdded = false;
  const mk = (kind: string, label: string, detail?: Record<string, unknown>) =>
    startStep({ parentKind: 'generation', parentId: genId, seq: ++seq, kind, label, detail });
  const fin = finishStep;
  const traceFail = async (error: string) => {
    if (_failureStepAdded) return;
    _failureStepAdded = true;
    const s = await mk('failure', 'Generation failed');
    await fin(s.id, s.startedAt, { status: 'failed', error });
  };

  try { await testingRepo().updateGeneration(genId, { status: 'running', started_at: now() }); }
  catch { return; } // DB closed

  await setProgress(genId, 'preparing', 'Loading context and attachments', 10);

  try {
    let existingSteps: unknown[] | undefined;
    if (existingScriptId) {
      const existing = await testingRepo().getTestScriptById(existingScriptId);
      if (existing) {
        try { existingSteps = JSON.parse(String(existing.steps || '[]')) as unknown[]; } catch { existingSteps = undefined; }
      }
    }

    // ── Trace: context step ───────────────────────────────────────────────
    const ctxStep = await mk('context', 'Building context');

    // Load and process attachments (single-use: cleaned up after generation)
    let attachmentRows: Row[] = [];
    let attachmentNames: string[] = [];
    if (attachmentIds.length > 0) {
      const { rows } = await validateAttachmentIds(tp.project_id, attachmentIds);
      attachmentRows = rows ?? [];
      attachmentNames = attachmentRows.map((r) => String(r.filename));
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

    // Store system prompt once on the context step (vault refs only resolved at execution time).
    await fin(ctxStep.id, ctxStep.startedAt, {
      status: 'ok',
      detail: { attachmentNames, textChars: textBlock.length, imageCount: images.length },
      prompt: { system: systemPrompt + textBlock },
    });

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

    await setProgress(genId, 'calling', existingScriptId ? 'Refining existing script' : 'Calling the AI model', 30);

    // ── Trace: first model call ────────────────────────────────────────────
    const callStep = await mk('call', existingScriptId ? 'Refining existing script' : 'Generating test steps');

    let modelOutput: unknown;
    try {
      modelOutput = await callModel(userPrompt);
    } catch (callErr) {
      await fin(callStep.id, callStep.startedAt, {
        status: 'failed',
        error: String((callErr as Error).message ?? callErr),
        prompt: { user: userPrompt },
      });
      throw callErr;
    }

    if (!Array.isArray(modelOutput)) {
      await fin(callStep.id, callStep.startedAt, {
        status: 'failed',
        error: 'Model output must be a JSON array of steps',
        output: JSON.stringify(modelOutput),
        prompt: { user: userPrompt },
      });
      throw new Error('Model output must be a JSON array of steps');
    }

    await fin(callStep.id, callStep.startedAt, {
      status: 'ok',
      detail: { stepCount: (modelOutput as unknown[]).length },
      output: JSON.stringify(modelOutput),
      prompt: { user: userPrompt },
    });

    // ── Validate — retry once on failure ───────────────────────────────────
    const genWarnings: string[] = [];
    let validatedSteps: Step[];

    // ── Trace: validate step ───────────────────────────────────────────────
    const validateStep2 = await mk('validate', 'Validating generated steps');

    try {
      validatedSteps = validateSteps(modelOutput);
      // Empty array → no usable steps; trigger the retry path instead of saving an empty script
      if (validatedSteps.length === 0) throw new Error('no usable steps');
      await fin(validateStep2.id, validateStep2.startedAt, {
        status: 'ok',
        detail: { stepCount: validatedSteps.length, passed: true },
      });
    } catch (firstErr) {
      // Collect per-step errors to include in retry prompt
      const stepErrors: string[] = [];
      for (let idx = 0; idx < (modelOutput as unknown[]).length; idx++) {
        try { validateStep((modelOutput as unknown[])[idx], idx); }
        catch (e) { stepErrors.push((e as Error).message); }
      }

      await fin(validateStep2.id, validateStep2.startedAt, {
        status: 'retry',
        detail: { stepCount: (modelOutput as unknown[]).length, passed: false, errorCount: stepErrors.length },
        error: (firstErr as Error).message,
      });

      await setProgress(genId, 'retrying', 'Retrying with validation feedback', 50);

      // ── Trace: retry call ─────────────────────────────────────────────────
      const retryStep = await mk('retry', 'Retrying with validation feedback');
      const retryPrompt = buildRetryPrompt(userPrompt, stepErrors);

      let retryOutput: unknown = null;
      try {
        retryOutput = await callModel(retryPrompt, stepErrors);
        await fin(retryStep.id, retryStep.startedAt, {
          status: 'ok',
          detail: { stepCount: Array.isArray(retryOutput) ? (retryOutput as unknown[]).length : 0 },
          output: JSON.stringify(retryOutput),
          prompt: { user: retryPrompt },
        });
      } catch (retryErr) {
        await fin(retryStep.id, retryStep.startedAt, {
          status: 'failed',
          error: String((retryErr as Error).message ?? retryErr),
          prompt: { user: retryPrompt },
        });
        /* retry call itself failed — proceed to salvage original */
      }

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

      // Record salvage warnings in a trace step if any
      if (genWarnings.length > 0) {
        const salvageStep = await mk('salvage', `Salvaged ${validatedSteps.length} of ${outputToSalvage.length} steps`);
        await fin(salvageStep.id, salvageStep.startedAt, {
          status: 'ok',
          detail: { kept: validatedSteps.length, dropped: genWarnings.filter((w) => w.includes('dropped')).length, repaired: genWarnings.filter((w) => w.includes('repaired')).length },
        });
      }

      // If salvage produced no usable steps at all, fail the generation
      if (validatedSteps.length === 0) {
        const NO_STEPS_MSG =
          'The model returned no usable steps. Try a more specific description, or use Generate test cases for scenario-level test cases.';
        await traceFail(NO_STEPS_MSG);
        throw new Error(NO_STEPS_MSG);
      }
    }

    await setProgress(genId, 'parsing', 'Validating steps', 70, validatedSteps.length);

    // Check if cancelled before saving — do not create/update script
    // (the cancel route may have run in another process, so the database is checked as well)
    if (cancelledGenerations.has(genId) || (await testingRepo().getGenerationById(genId))?.cancelled_at) {
      cancelledGenerations.delete(genId);
      return;
    }

    // ── Create or update script ────────────────────────────────────────────
    await setProgress(genId, 'saving', existingScriptId ? 'Updating test script' : 'Saving test script', 85, validatedSteps.length);
    const saveStep = await mk('save', existingScriptId ? 'Updating script' : 'Creating script');
    const ts = now();
    let scriptId: string;

    if (existingScriptId) {
      await testingRepo().updateTestScript(existingScriptId, { steps: JSON.stringify(validatedSteps), updated_at: ts });
      scriptId = existingScriptId;
    } else {
      scriptId = generateId();
      await testingRepo().createTestScript({
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

    await fin(saveStep.id, saveStep.startedAt, {
      status: 'ok',
      detail: { scriptId, stepCount: validatedSteps.length },
    });

    // ── Done step ─────────────────────────────────────────────────────────
    const doneStep = await mk('done', 'Generation complete');

    await setProgress(genId, 'done', 'Generation complete', 100, validatedSteps.length);
    try {
      await testingRepo().updateGeneration(genId, {
        status: 'done', result_script_ids: JSON.stringify([scriptId]), finished_at: ts, warnings: JSON.stringify(genWarnings),
      });
    } catch { /* DB closed */ }

    await fin(doneStep.id, doneStep.startedAt, {
      status: 'ok',
      detail: { scriptId, warningsCount: genWarnings.length },
    });

    // Delete attachments on success (single-use)
    if (attachmentIds.length > 0) {
      try { await deleteAttachmentsByIds(attachmentIds); } catch { /* best effort */ }
    }
  } catch (err) {
    await traceFail(String((err as Error).message ?? err));
    try {
      await testingRepo().updateGeneration(genId, { status: 'failed', error: String((err as Error).message ?? err), finished_at: now() });
    } catch { /* DB closed */ }
    // Attachments are NOT deleted on failure — kept for retry
  }
}

// ── Route registration ─────────────────────────────────────────────────────────

/** First group of a test project (lowest sort order), or null when it has none. */
async function firstGroupId(testProjectId: string): Promise<string | null> {
  const groups = (await testingRepo().listGroupsByTestProject(testProjectId)).sort((a, b) => a.sort_order - b.sort_order);
  return groups[0]?.id ?? null;
}

interface GenerationJob {
  genId: string;
  tp: TestProject;
  description: string;
  targetGroupId: string;
  existingScriptId: string | null;
  createdBy: string;
  attachmentIds: string[];
}

/** Run a generation in the background (a separate Lambda invocation in the cloud). */
async function startGenerationJob(job: GenerationJob): Promise<void> {
  await runInBackground('test-generate', {
    genId: job.genId,
    testProjectId: job.tp.id,
    description: job.description,
    targetGroupId: job.targetGroupId,
    existingScriptId: job.existingScriptId,
    createdBy: job.createdBy,
    attachmentIds: job.attachmentIds,
  });
}

export function registerGenerateRoutes(): void {
  registerBackgroundJob('test-generate', async (a) => {
    const tp = (await testingRepo().getTestProjectById(String(a.testProjectId))) as unknown as TestProject | null;
    if (!tp) return;
    await runGeneration(
      String(a.genId), tp, String(a.description), String(a.targetGroupId),
      a.existingScriptId ? String(a.existingScriptId) : null, String(a.createdBy),
      Array.isArray(a.attachmentIds) ? (a.attachmentIds as unknown[]).map(String) : [],
    );
  });

  // POST /api/projects/:pid/tests/:tpid/generate — start generation
  router.post('/api/projects/:pid/tests/:tpid/generate', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const description = str(body.description, 'description', { max: 4000 }).trim();
    const groupId = typeof body.groupId === 'string' ? body.groupId : null;
    const rawAttachmentIds = Array.isArray(body.attachmentIds) ? (body.attachmentIds as unknown[]).map(String) : [];

    // Validate attachment IDs
    if (rawAttachmentIds.length > 0) {
      const { error } = await validateAttachmentIds(req.params.pid, rawAttachmentIds);
      if (error) { sendJson(res, 400, { error }); return; }
    }

    // Validate group if provided
    if (groupId) {
      const group = await testingRepo().getTestGroupByTestProjectAndId(tp.id, groupId);
      if (!group) { sendJson(res, 400, { error: 'Group not found in this test project' }); return; }
    } else {
      // Create a default group if none exists
      const existing = await testingRepo().listGroupsByTestProject(tp.id);
      if (existing.length === 0) {
        const gid = generateId();
        const ts = now();
        await testingRepo().createTestGroup({ id: gid, test_project_id: tp.id, name: 'Default', sort_order: 0, created_at: ts, updated_at: ts });
      }
    }

    const effectiveGroupId = groupId ?? (await firstGroupId(tp.id)) as string;

    const genId = generateId();
    const ts = now();
    await testingRepo().createGeneration({
      id: genId,
      test_project_id: tp.id,
      script_id: null,
      kind: 'generate',
      description,
      group_id: effectiveGroupId,
      status: 'pending',
      error: null,
      result_script_ids: '[]',
      warnings: '[]',
      attachment_ids: JSON.stringify(rawAttachmentIds),
      created_by: req.user!.id,
      created_at: ts,
      finished_at: null,
      progress: '{}',
      started_at: null,
      cancelled_at: null,
    });

    auditRaw(req.user!.id, 'test_generation.start', `test_generation:${genId}`, { description });

    await startGenerationJob({ genId, tp, description, targetGroupId: effectiveGroupId, existingScriptId: null, createdBy: req.user!.id, attachmentIds: rawAttachmentIds });

    sendJson(res, 202, { generationId: genId });
  });

  // POST /api/projects/:pid/tests/:tpid/scripts/:sid/refine — refine existing script
  router.post('/api/projects/:pid/tests/:tpid/scripts/:sid/refine', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const script = (await testingRepo().getTestScriptByTestProjectAndId(tp.id, req.params.sid)) as unknown as TestScript | null;
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const instruction = str(body.instruction, 'instruction', { max: 4000 }).trim();
    const rawAttachmentIds = Array.isArray(body.attachmentIds) ? (body.attachmentIds as unknown[]).map(String) : [];

    // Validate attachment IDs
    if (rawAttachmentIds.length > 0) {
      const { error } = await validateAttachmentIds(req.params.pid, rawAttachmentIds);
      if (error) { sendJson(res, 400, { error }); return; }
    }

    const genId = generateId();
    const ts = now();
    await testingRepo().createGeneration({
      id: genId,
      test_project_id: tp.id,
      script_id: script.id,
      kind: 'refine',
      description: instruction,
      group_id: String(script.test_group_id),
      status: 'pending',
      error: null,
      result_script_ids: '[]',
      warnings: '[]',
      attachment_ids: JSON.stringify(rawAttachmentIds),
      created_by: req.user!.id,
      created_at: ts,
      finished_at: null,
      progress: '{}',
      started_at: null,
      cancelled_at: null,
    });

    await startGenerationJob({ genId, tp, description: instruction, targetGroupId: script.test_group_id, existingScriptId: script.id, createdBy: req.user!.id, attachmentIds: rawAttachmentIds });

    sendJson(res, 202, { generationId: genId });
  });

  // GET /api/projects/:pid/tests/:tpid/generations — list generations for a test project
  router.get('/api/projects/:pid/tests/:tpid/generations', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;

    const activeOnly = req.query.get('active') === '1';
    const rawLimit = parseInt(req.query.get('limit') ?? '20', 10);
    const limit = Math.min(Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20), 50);

    const allGens = ((await testingRepo().listGenerationsByTestProject(tp.id, 1000, 0)) as unknown as TestGeneration[])
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const gens: TestGeneration[] = activeOnly
      ? allGens.filter((g) => g.status === 'pending' || g.status === 'running')
      : allGens.slice(0, limit);

    const generations = gens.map((gen) => {
      let warnings: string[] = [];
      try { warnings = JSON.parse(String(gen.warnings || '[]')) as string[]; } catch { warnings = []; }

      let resultScriptIds: string[] = [];
      try { resultScriptIds = JSON.parse(String(gen.result_script_ids || '[]')) as string[]; } catch { resultScriptIds = []; }

      let progress: Record<string, unknown> = {};
      try { progress = JSON.parse(String(gen.progress || '{}')) as Record<string, unknown>; } catch { progress = {}; }

      const desc = gen.description ?? null;
      const description = desc !== null && desc.length > 200 ? desc.slice(0, 200) : desc;

      const status = gen.cancelled_at ? 'cancelled' : gen.status;
      const retryable = gen.status === 'failed' && !gen.cancelled_at;

      return {
        id: gen.id,
        kind: gen.kind,
        description,
        status,
        error: gen.error ?? null,
        warnings,
        scriptId: gen.script_id ?? null,
        resultScriptIds,
        createdBy: gen.created_by ?? null,
        createdAt: gen.created_at,
        startedAt: gen.started_at ?? null,
        finishedAt: gen.finished_at ?? null,
        progress,
        retryable,
      };
    });

    sendJson(res, 200, { generations });
  });

  // GET /api/projects/:pid/tests/:tpid/generate/:genId — get generation status
  router.get('/api/projects/:pid/tests/:tpid/generate/:genId', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const gen = (await testingRepo().getGenerationByTestProjectAndId(tp.id, req.params.genId)) as unknown as TestGeneration | null;
    if (!gen) { sendJson(res, 404, { error: 'Generation not found' }); return; }

    // If done, include the created/updated scripts
    let scripts: unknown[] = [];
    if (gen.status === 'done') {
      let ids: string[] = [];
      try { ids = JSON.parse(String(gen.result_script_ids || '[]')) as string[]; } catch { ids = []; }
      scripts = (await Promise.all(ids.map(async (sid) => {
        const s = await testingRepo().getTestScriptById(sid);
        if (!s) return null;
        return {
          id: s.id,
          name: s.name,
          steps: (() => { try { return JSON.parse(String(s.steps || '[]')); } catch { return []; } })(),
        };
      }))).filter(Boolean);
    }

    // Parse warnings from DB
    let warnings: string[] = [];
    try { warnings = JSON.parse(String(gen.warnings || '[]')) as string[]; } catch { warnings = []; }

    const retryable = gen.status === 'failed' && !gen.cancelled_at;

    sendJson(res, 200, {
      generation: {
        id: gen.id,
        kind: gen.kind,
        description: gen.description,
        status: gen.status,
        error: gen.error ?? null,
        warnings,
        retryable,
        createdAt: gen.created_at,
        finishedAt: gen.finished_at ?? null,
      },
      scripts,
    });
  });

  // POST /api/projects/:pid/tests/:tpid/import — import test cases from CSV/XLSX/DOCX/MD
  router.post('/api/projects/:pid/tests/:tpid/import', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const groupId = typeof body.groupId === 'string' ? body.groupId : null;

    // Validate group
    let targetGroupId = groupId;
    if (targetGroupId) {
      const group = await testingRepo().getTestGroupByTestProjectAndId(tp.id, targetGroupId);
      if (!group) { sendJson(res, 400, { error: 'Group not found' }); return; }
    } else {
      const existingId = await firstGroupId(tp.id);
      if (!existingId) {
        const gid = generateId();
        const ts = now();
        await testingRepo().createTestGroup({ id: gid, test_project_id: tp.id, name: 'Imported', sort_order: 0, created_at: ts, updated_at: ts });
        targetGroupId = gid;
      } else {
        targetGroupId = existingId;
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
      await testingRepo().createGeneration({
        id: genId,
        test_project_id: tp.id,
        script_id: null,
        kind: 'import',
        group_id: targetGroupId,
        description: `${name}: ${description}`,
        status: 'pending',
        error: null,
        result_script_ids: '[]',
        warnings: '[]',
        created_by: req.user!.id,
        created_at: ts,
        finished_at: null,
        progress: '{}',
        started_at: null,
        cancelled_at: null,
      });

      await startGenerationJob({ genId, tp, description: `${name}: ${description}`, targetGroupId: targetGroupId!, existingScriptId: null, createdBy: req.user!.id, attachmentIds: [] });
      genIds.push(genId);
    }

    sendJson(res, 202, { generationIds: genIds, errors });
  });

  // POST /api/projects/:pid/tests/:tpid/generations/:gid/cancel — cancel a generation
  router.post('/api/projects/:pid/tests/:tpid/generations/:gid/cancel', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const gen = (await testingRepo().getGenerationByTestProjectAndId(tp.id, req.params.gid)) as unknown as TestGeneration | null;
    if (!gen) { sendJson(res, 404, { error: 'Generation not found' }); return; }

    const currentStatus = gen.cancelled_at ? 'cancelled' : gen.status;

    // Already finished — no-op, return current state
    if (currentStatus === 'done' || currentStatus === 'failed' || currentStatus === 'cancelled') {
      let warnings: string[] = [];
      try { warnings = JSON.parse(String(gen.warnings || '[]')) as string[]; } catch { warnings = []; }
      let resultScriptIds: string[] = [];
      try { resultScriptIds = JSON.parse(String(gen.result_script_ids || '[]')) as string[]; } catch { resultScriptIds = []; }
      let progress: Record<string, unknown> = {};
      try { progress = JSON.parse(String(gen.progress || '{}')) as Record<string, unknown>; } catch { progress = {}; }
      sendJson(res, 200, {
        generation: {
          id: gen.id, kind: gen.kind, description: gen.description ?? null,
          status: currentStatus, error: gen.error ?? null, warnings,
          scriptId: gen.script_id ?? null, resultScriptIds,
          createdBy: gen.created_by ?? null, createdAt: gen.created_at,
          startedAt: gen.started_at ?? null, finishedAt: gen.finished_at ?? null,
          progress,
        },
      });
      return;
    }

    // Mark cancelled in DB and signal runGeneration to abort before saving
    const ts = now();
    try {
      await testingRepo().updateGeneration(gen.id, { cancelled_at: ts, finished_at: ts });
    } catch { /* DB closed */ }
    cancelledGenerations.add(gen.id);

    sendJson(res, 200, {
      generation: {
        id: gen.id, kind: gen.kind, description: gen.description ?? null,
        status: 'cancelled', error: null, warnings: [],
        scriptId: gen.script_id ?? null, resultScriptIds: [],
        createdBy: gen.created_by ?? null, createdAt: gen.created_at,
        startedAt: gen.started_at ?? null, finishedAt: ts,
        progress: { phase: 'done', message: 'Cancelled', percent: 0, stepsSoFar: 0 },
      },
    });
  });

  // GET /api/projects/:pid/tests/:tpid/generations/:gid/trace — generation trace steps
  router.get('/api/projects/:pid/tests/:tpid/generations/:gid/trace', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'viewer');
    if (!tp) return;

    const gen = await testingRepo().getGenerationByTestProjectAndId(tp.id, req.params.gid);
    if (!gen) { sendJson(res, 404, { error: 'Generation not found' }); return; }

    const steps = await getGenerationTrace(gen.id);
    sendJson(res, 200, { steps });
  });

  // POST /api/projects/:pid/tests/:tpid/generations/:gid/retry — retry a failed generation
  router.post('/api/projects/:pid/tests/:tpid/generations/:gid/retry', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const original = (await testingRepo().getGenerationByTestProjectAndId(tp.id, req.params.gid)) as unknown as TestGeneration | null;
    if (!original) { sendJson(res, 404, { error: 'Generation not found' }); return; }

    const currentStatus = original.cancelled_at ? 'cancelled' : String(original.status);
    if (currentStatus !== 'failed') {
      sendJson(res, 409, { error: 'Generation is not in a failed state' });
      return;
    }

    // For 'refine' kind, verify the script still exists
    if (original.kind === 'refine' && original.script_id) {
      const script = await testingRepo().getTestScriptByTestProjectAndId(tp.id, String(original.script_id));
      if (!script) { sendJson(res, 404, { error: 'Original script no longer exists' }); return; }
    }

    // Reuse stored attachment IDs (kept on failure intentionally)
    let attachmentIds: string[] = [];
    try { attachmentIds = JSON.parse(String(original.attachment_ids || '[]')) as string[]; } catch { attachmentIds = []; }

    if (attachmentIds.length > 0) {
      const { error } = await validateAttachmentIds(req.params.pid, attachmentIds);
      if (error) attachmentIds = [];
    }

    const groupId = original.group_id ? String(original.group_id) : await firstGroupId(tp.id);
    if (!groupId) { sendJson(res, 400, { error: 'No group found for retry' }); return; }

    const genId = generateId();
    const ts = now();
    await testingRepo().createGeneration({
      id: genId,
      test_project_id: tp.id,
      script_id: original.script_id ?? null,
      kind: original.kind,
      description: original.description,
      group_id: groupId,
      status: 'pending',
      error: null,
      result_script_ids: '[]',
      warnings: '[]',
      attachment_ids: JSON.stringify(attachmentIds),
      created_by: req.user!.id,
      created_at: ts,
      finished_at: null,
      progress: '{}',
      started_at: null,
      cancelled_at: null,
    });

    auditRaw(req.user!.id, 'test_generation.retry', `test_generation:${genId}`, {
      originalId: original.id,
      kind: original.kind,
    });

    await startGenerationJob({
      genId,
      tp,
      description: String(original.description ?? ''),
      targetGroupId: groupId,
      existingScriptId: original.kind === 'refine' ? (original.script_id ? String(original.script_id) : null) : null,
      createdBy: req.user!.id,
      attachmentIds,
    });

    sendJson(res, 202, { generationId: genId });
  });
}
