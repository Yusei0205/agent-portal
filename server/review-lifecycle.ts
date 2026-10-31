/**
 * Review lifecycle wiring.
 *
 * Registers a hook in the agent runner so that when a p6 run that belongs to
 * a review finishes, the review row is updated with real stats (tokens, tool
 * calls, duration, …) and auto-post fires if post_mode='auto'.
 *
 * Imported by server/index.ts to activate at startup.
 */

import path from 'node:path';
import { one, all, run as dbRun } from './db.ts';
import type { Row } from './db.ts';
import { now } from './util.ts';
import { setRunLifecycleHook } from './agent/runner.ts';
import { processReviewOutput, triggerAutoPost, getPrCommentMode } from './review.ts';
import { config } from './config.ts';

// ── Run-log entry ─────────────────────────────────────────────────────────────

export interface RunLogEntry {
  ts: string;
  type: 'llm' | 'tool' | 'tool_result' | 'error' | 'system';
  name?: string;
  input?: string;
  output?: string;
  text?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_write_tokens?: number;
  cache_read_tokens?: number;
}

// ── Assistant text capture ────────────────────────────────────────────────────

/**
 * Concatenate the full (untruncated) text from all assistant-text events for a
 * run. This is stored as the review summary so processReviewOutput() can parse
 * findings from it.
 */
function collectAssistantText(runId: string): string {
  const events = all<Row>(
    "SELECT payload FROM p6_events WHERE run_id = ? AND type = 'assistant-text' ORDER BY id ASC",
    runId,
  );
  const parts: string[] = [];
  for (const ev of events) {
    try {
      const payload = JSON.parse(String(ev.payload ?? '{}')) as Record<string, unknown>;
      const text = String(payload.text ?? '').trim();
      if (text) parts.push(text);
    } catch { /* skip malformed events */ }
  }
  return parts.join('\n\n');
}

// ── Log builder ───────────────────────────────────────────────────────────────

function buildRunLog(runId: string): {
  log: RunLogEntry[];
  toolCalls: number;
  llmRequests: number;
  retryCount: number;
  filesReviewed: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
} {
  const events = all<Row>(
    'SELECT type, payload, created_at FROM p6_events WHERE run_id = ? ORDER BY id ASC',
    runId,
  );

  const log: RunLogEntry[] = [];
  let toolCalls = 0;
  let llmRequests = 0;
  let retryCount = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  const filesRead = new Set<string>();

  for (const ev of events) {
    const ts = String(ev.created_at ?? now());
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(String(ev.payload ?? '{}')); } catch { /* skip */ }

    const evType = String(ev.type ?? '');

    switch (evType) {
      case 'assistant-text': {
        llmRequests++;
        const entry: RunLogEntry = {
          ts, type: 'llm',
          text: String(payload.text ?? '').slice(0, 500),
        };
        if (payload.input_tokens != null) entry.input_tokens = Number(payload.input_tokens);
        if (payload.output_tokens != null) entry.output_tokens = Number(payload.output_tokens);
        if (payload.cache_write_tokens != null) {
          entry.cache_write_tokens = Number(payload.cache_write_tokens);
          cacheWriteTokens += Number(payload.cache_write_tokens);
        }
        if (payload.cache_read_tokens != null) {
          entry.cache_read_tokens = Number(payload.cache_read_tokens);
          cacheReadTokens += Number(payload.cache_read_tokens);
        }
        log.push(entry);
        break;
      }
      case 'tool-start': {
        toolCalls++;
        const toolName = String(payload.toolName ?? payload.tool_name ?? '');
        const toolInput = String(payload.toolInput ?? payload.tool_input ?? '');
        log.push({ ts, type: 'tool', name: toolName, input: toolInput.slice(0, 200) });
        // Count unique file reads (used as proxy for files_reviewed)
        if (['Read', 'read_file', 'str_replace_editor', 'view', 'cat'].includes(toolName)) {
          try {
            const inp = JSON.parse(toolInput) as Record<string, unknown>;
            const fp = inp.file_path ?? inp.path ?? inp.command ?? '';
            if (fp) filesRead.add(String(fp));
          } catch { /* skip */ }
        }
        break;
      }
      case 'tool-end': {
        const toolName = String(payload.toolName ?? payload.tool_name ?? '');
        log.push({ ts, type: 'tool_result', name: toolName, output: String(payload.output ?? '').slice(0, 300) });
        break;
      }
      case 'tool-blocked': {
        const toolName = String(payload.toolName ?? payload.tool_name ?? '');
        log.push({ ts, type: 'system', name: toolName, text: `Blocked: ${String(payload.reason ?? '')}` });
        break;
      }
      case 'run-failed': {
        log.push({ ts, type: 'error', text: String(payload.error ?? '').slice(0, 500) });
        break;
      }
      case 'retry': {
        retryCount++;
        log.push({ ts, type: 'system', text: `Retry #${retryCount}: ${String(payload.reason ?? '')}` });
        break;
      }
      default:
        break;
    }
  }

  return { log, toolCalls, llmRequests, retryCount, filesReviewed: filesRead.size, cacheWriteTokens, cacheReadTokens };
}

// ── Lifecycle handler ─────────────────────────────────────────────────────────

export function handleReviewLifecycle(
  workflowId: string,
  runId: string,
  event: 'start' | 'done' | 'failed' | 'cancelled',
): void {
  interface ReviewRow {
    id: string;
    started_at: string | null;
    post_mode: string;
    project_id: string | null;
    provider_id: string | null;
    model_id: string | null;
    status: string;
  }

  const review = one<ReviewRow>(
    'SELECT id, started_at, post_mode, project_id, provider_id, model_id, status FROM p10_reviews WHERE workflow_id = ?',
    workflowId,
  );
  if (!review) return;

  if (event === 'start') {
    if (review.status !== 'running') {
      dbRun(
        "UPDATE p10_reviews SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
        now(),
        review.id,
      );
    }
    return;
  }

  // Terminal: a cancelled (aborted) run must not leave the review stuck in 'running'.
  // The review never completed, so mark it failed so it can be deleted or re-run.
  if (event === 'cancelled') {
    if (review.status === 'running' || review.status === 'pending') {
      dbRun(
        "UPDATE p10_reviews SET status = 'failed' WHERE id = ?",
        review.id,
      );
    }
    return;
  }

  const succeeded = event === 'done';

  // Read aggregate token counts from p6_runs
  const runRow = one<Row>('SELECT * FROM p6_runs WHERE id = ?', runId);
  const inputTokens = Number(runRow?.input_tokens ?? 0);
  const outputTokens = Number(runRow?.output_tokens ?? 0);

  const startedAt = String(runRow?.started_at ?? review.started_at ?? now());
  const finishedAt = String(runRow?.finished_at ?? now());

  let durationMs: number | null = null;
  try {
    const start = new Date(startedAt).getTime();
    const end = new Date(finishedAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durationMs = end - start;
    }
  } catch { /* skip */ }

  const {
    log,
    toolCalls,
    llmRequests,
    retryCount,
    filesReviewed,
    cacheWriteTokens,
    cacheReadTokens,
  } = buildRunLog(runId);

  // provider_id / model_id: prefer what's already on the review (set at creation),
  // fall back to what the run row reports
  const providerId = review.provider_id ?? (String(runRow?.provider ?? '') || null);
  const modelId = review.model_id ?? (String(runRow?.model ?? '') || null);

  dbRun(
    `UPDATE p10_reviews SET
       status          = ?,
       started_at      = ?,
       duration_ms     = ?,
       input_tokens    = ?,
       cache_write_tokens = ?,
       cache_read_tokens  = ?,
       output_tokens   = ?,
       llm_requests    = ?,
       retry_count     = ?,
       tool_calls      = ?,
       files_reviewed  = ?,
       run_log         = ?,
       provider_id     = COALESCE(provider_id, ?),
       model_id        = COALESCE(model_id, ?)
     WHERE id = ?`,
    succeeded ? 'done' : 'failed',
    startedAt,
    durationMs,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    llmRequests,
    retryCount,
    toolCalls,
    filesReviewed,
    JSON.stringify(log),
    providerId,
    modelId,
    review.id,
  );

  if (succeeded) {
    // Capture the agent's full text output.
    // raw_output  — full untruncated transcript, used by processReviewOutput() for
    //               finding extraction and kept for audit/re-parsing.
    // summary     — bounded human-readable snippet (≤ 4 KB) for list-view display.
    const assistantText = collectAssistantText(runId);
    if (assistantText) {
      dbRun('UPDATE p10_reviews SET raw_output = ? WHERE id = ?', assistantText, review.id);
      const humanSummary = assistantText.length > 4000
        ? assistantText.slice(0, 4000) + '\n…[truncated]'
        : assistantText;
      dbRun('UPDATE p10_reviews SET summary = ? WHERE id = ?', humanSummary, review.id);
    }

    // Derive the run's work directory so processReviewOutput() can also scan
    // any findings files the agent wrote (findings.json, review.md, etc.).
    const projectRow = review.project_id
      ? one<{ slug: string }>('SELECT slug FROM projects WHERE id = ?', review.project_id)
      : null;
    const slug = projectRow?.slug ?? 'unknown';
    const workDir = path.join(config.dataDir, 'projects', slug, 'work', runId);

    // Parse findings from whatever the agent produced.
    const findingCount = processReviewOutput(review.id, workDir);

    // If the agent produced no text output at all (not just zero findings),
    // the run cannot be considered a valid review — mark it failed so an
    // empty finding set is never mistaken for a clean review.
    if (!assistantText && findingCount === 0) {
      dbRun(
        "UPDATE p10_reviews SET status = 'failed' WHERE id = ?",
        review.id,
      );
      return;
    }

    // Fire auto-post if the review was set to auto-post, or if the global
    // prCommentMode is 'automatic' (F10).
    const shouldAutoPost = review.post_mode === 'auto' || getPrCommentMode() === 'automatic';
    if (shouldAutoPost) {
      triggerAutoPost(review.id, review.project_id ?? undefined).catch(() => { /* best effort */ });
    }
  }
}

// Register hook when this module is imported
setRunLifecycleHook(handleReviewLifecycle);
