/**
 * Trace step helpers — ordered AI-operation traces for case-set and script generations.
 *
 * Each generation persists an ordered sequence of trace_steps rows in the database,
 * accessible via the /trace routes. Steps are written in real-time so the UI can
 * display which operation is currently in progress.
 *
 * Security note: vault values ({{vault.x.y}} placeholders) are only resolved at test
 * execution time and never appear in generation prompts, so no redaction is needed.
 * The app URL and rules_for_ai that appear in system prompts are project-level config,
 * not secrets.
 */

import { insert, run, all } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now } from '../util.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum characters stored per string field (output, prompt.system, prompt.user). */
export const MAX_TRACE_FIELD_CHARS = 20_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TracePrompt {
  system?: string | null;
  user?: string | null;
  /** Set when the system field was longer than MAX_TRACE_FIELD_CHARS and was cut. */
  systemTruncated?: boolean;
  /** Set when the user field was longer than MAX_TRACE_FIELD_CHARS and was cut. */
  userTruncated?: boolean;
}

export type TraceStatus = 'ok' | 'retry' | 'failed' | 'skipped';

export interface TraceStepRow extends Row {
  id: string;
  case_set_id: string | null;
  generation_id: string | null;
  seq: number;
  kind: string;
  label: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  detail: string;
  prompt: string | null;
  output: string | null;
  output_truncated: number;
  error: string | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function truncateField(s: string): { value: string; truncated: boolean } {
  if (s.length <= MAX_TRACE_FIELD_CHARS) return { value: s, truncated: false };
  return { value: s.slice(0, MAX_TRACE_FIELD_CHARS), truncated: true };
}

function buildPromptJson(p: TracePrompt): string {
  const out: Record<string, unknown> = {};
  if (p.system != null) {
    const { value, truncated } = truncateField(p.system);
    out.system = value;
    if (truncated) out.systemTruncated = true;
  }
  if (p.user != null) {
    const { value, truncated } = truncateField(p.user);
    out.user = value;
    if (truncated) out.userTruncated = true;
  }
  return JSON.stringify(out);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface StartStepOpts {
  parentKind: 'case_set' | 'generation';
  parentId: string;
  seq: number;
  kind: string;
  label: string;
  detail?: Record<string, unknown>;
  prompt?: TracePrompt | null;
}

export interface StartStepResult {
  id: string;
  startedAt: string;
}

/**
 * Insert a trace step with status 'running'.
 * Returns the generated id and the startedAt timestamp so finishStep can compute duration.
 * All errors are swallowed (the DB may be closed or the parent row deleted — trace is best-effort).
 */
export function startStep(opts: StartStepOpts): StartStepResult {
  const id = generateId();
  const startedAt = now();
  try {
    insert('trace_steps', {
      id,
      case_set_id: opts.parentKind === 'case_set' ? opts.parentId : null,
      generation_id: opts.parentKind === 'generation' ? opts.parentId : null,
      seq: opts.seq,
      kind: opts.kind,
      label: opts.label,
      status: 'running',
      started_at: startedAt,
      finished_at: null,
      duration_ms: null,
      detail: JSON.stringify(opts.detail ?? {}),
      prompt: opts.prompt ? buildPromptJson(opts.prompt) : null,
      output: null,
      output_truncated: 0,
      error: null,
    });
  } catch {
    // DB closed or FK violation — trace is best-effort
  }
  return { id, startedAt };
}

export interface FinishStepOpts {
  status: TraceStatus;
  detail?: Record<string, unknown>;
  /** Raw model output or other freeform text. Capped at MAX_TRACE_FIELD_CHARS. */
  output?: string | null;
  error?: string | null;
  /**
   * When provided, updates the prompt on the step (useful for steps where the
   * prompt is only known after the operation completes, e.g. category calls).
   */
  prompt?: TracePrompt | null;
}

/**
 * Update a trace step to its final status.
 * All errors are swallowed (trace is best-effort).
 */
export function finishStep(id: string, startedAt: string, opts: FinishStepOpts): void {
  try {
    const finishedAt = now();
    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(finishedAt).getTime();
    const durationMs = Number.isFinite(endMs - startMs) ? Math.round(endMs - startMs) : null;

    const sets: string[] = ['status = ?', 'finished_at = ?', 'duration_ms = ?'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vals: any[] = [opts.status, finishedAt, durationMs];

    if (opts.output !== null && opts.output !== undefined) {
      let output = opts.output;
      let outputTruncated = 0;
      if (output.length > MAX_TRACE_FIELD_CHARS) {
        output = output.slice(0, MAX_TRACE_FIELD_CHARS);
        outputTruncated = 1;
      }
      sets.push('output = ?');
      vals.push(output);
      sets.push('output_truncated = ?');
      vals.push(outputTruncated);
    }

    if (opts.error) {
      sets.push('error = ?');
      vals.push(String(opts.error).slice(0, 2000));
    }

    if (opts.detail) {
      sets.push('detail = ?');
      vals.push(JSON.stringify(opts.detail));
    }

    if (opts.prompt != null) {
      sets.push('prompt = ?');
      vals.push(buildPromptJson(opts.prompt));
    }

    vals.push(id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run(`UPDATE trace_steps SET ${sets.join(', ')} WHERE id = ?`, ...(vals as any[]));
  } catch {
    // DB closed — ignore
  }
}

// ── Serialisation ─────────────────────────────────────────────────────────────

/** Format a raw trace_steps row for the API response. */
export function formatTraceStep(row: TraceStepRow): Record<string, unknown> {
  let detail: unknown = {};
  try { detail = JSON.parse(row.detail); } catch { /* fallback to {} */ }

  let prompt: unknown = undefined;
  if (row.prompt) {
    try { prompt = JSON.parse(row.prompt); } catch { /* skip */ }
  }

  const out: Record<string, unknown> = {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    label: row.label,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    durationMs: row.duration_ms ?? null,
    detail,
    output: row.output ?? null,
    outputTruncated: row.output_truncated !== 0,
    error: row.error ?? null,
  };
  if (prompt !== undefined) out.prompt = prompt;
  return out;
}

/** Fetch all trace steps for a case-set, ordered by seq. */
export function getCaseSetTrace(csId: string): Record<string, unknown>[] {
  const rows = all<TraceStepRow>(
    'SELECT * FROM trace_steps WHERE case_set_id = ? ORDER BY seq',
    csId,
  );
  return rows.map(formatTraceStep);
}

/** Fetch all trace steps for a generation, ordered by seq. */
export function getGenerationTrace(genId: string): Record<string, unknown>[] {
  const rows = all<TraceStepRow>(
    'SELECT * FROM trace_steps WHERE generation_id = ? ORDER BY seq',
    genId,
  );
  return rows.map(formatTraceStep);
}
