/**
 * Review lifecycle wiring.
 *
 * Registers a hook in the agent runner so that when a p6 run that belongs to
 * a review finishes, the review row is updated with real stats (tokens, tool
 * calls, duration, …) and auto-post fires if post_mode='auto'.
 *
 * Imported by server/index.ts to activate at startup.
 */

import { getReviewsRepository } from './repositories/reviews.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { getDiagramRepository } from './repositories/diagrams-data.ts';
import { getGeneratedDocRepository } from './repositories/generated-docs-data.ts';
import { getPresentationRepository } from './repositories/presentations-data.ts';
import path from 'node:path';
import { one, all, run as dbRun } from './db.ts';
import type { Row } from './db.ts';
import { now } from './util.ts';
import { setRunLifecycleHook } from './agent/runner.ts';
import { processReviewOutput, triggerAutoPost, getPrCommentMode } from './review.ts';
import { config } from './config.ts';

import { getLatestRunRow, getProjectRow, getWorkflowRow } from './project-access.ts';
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
 * run. This is stored as the review summary so await processReviewOutput() can parse
 * findings from it.
 */
async function collectAssistantText(runId: string): Promise<string> {
  const events = (await getSessionsRepository().listRunEvents(runId, 20000))
    .filter((e) => e.type === 'assistant-text') as unknown as Row[];
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

async function buildRunLog(runId: string): Promise<{
  log: RunLogEntry[];
  toolCalls: number;
  llmRequests: number;
  retryCount: number;
  filesReviewed: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}> {
  const events = (await getSessionsRepository().listRunEvents(runId, 20000)) as unknown as Row[];

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

export async function handleReviewLifecycle(
  workflowId: string,
  runId: string,
  event: 'start' | 'done' | 'failed' | 'cancelled',
): Promise<void> {
  const reviews = getReviewsRepository();
  const review = await reviews.getByWorkflowId(workflowId);
  if (!review) return;

  if (event === 'start') {
    if (review.status !== 'running') {
      await reviews.update(review.id, { status: 'running', started_at: review.started_at ?? now() });
    }
    return;
  }

  // Terminal: a cancelled (aborted) run must not leave the review stuck in 'running'.
  // The review never completed, so mark it failed so it can be deleted or re-run.
  if (event === 'cancelled') {
    if (review.status === 'running' || review.status === 'pending') {
      await reviews.update(review.id, { status: 'failed' });
    }
    return;
  }

  const succeeded = event === 'done';

  // Read aggregate token counts from the run
  const runRow = (await getSessionsRepository().getRunById(runId)) as unknown as Row | null;
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
  } = await buildRunLog(runId);

  // provider_id / model_id: prefer what's already on the review (set at creation),
  // fall back to what the run row reports
  const providerId = review.provider_id ?? (String(runRow?.provider ?? '') || null);
  const modelId = review.model_id ?? (String(runRow?.model ?? '') || null);

  await reviews.update(review.id, {
    status: succeeded ? 'done' : 'failed',
    started_at: startedAt,
    duration_ms: durationMs,
    input_tokens: inputTokens,
    cache_write_tokens: cacheWriteTokens,
    cache_read_tokens: cacheReadTokens,
    output_tokens: outputTokens,
    llm_requests: llmRequests,
    retry_count: retryCount,
    tool_calls: toolCalls,
    files_reviewed: filesReviewed,
    run_log: JSON.stringify(log),
    provider_id: providerId,
    model_id: modelId,
  });

  if (succeeded) {
    // Capture the agent's full text output.
    // raw_output  — full untruncated transcript, used by await processReviewOutput() for
    //               finding extraction and kept for audit/re-parsing.
    // summary     — bounded human-readable snippet (≤ 4 KB) for list-view display.
    const assistantText = await collectAssistantText(runId);
    if (assistantText) {
      const humanSummary = assistantText.length > 4000
        ? assistantText.slice(0, 4000) + '\n…[truncated]'
        : assistantText;
      await reviews.update(review.id, { raw_output: assistantText, summary: humanSummary });
    }

    // Derive the run's work directory so await processReviewOutput() can also scan
    // any findings files the agent wrote (findings.json, review.md, etc.).
    const projectRow = review.project_id
      ? (await getProjectRow(review.project_id))
      : null;
    const slug = String(projectRow?.slug ?? 'unknown');
    const workDir = path.join(config.dataDir, 'projects', slug, 'work', runId);

    // Parse findings from whatever the agent produced.
    const findingCount = await processReviewOutput(review.id, workDir);

    // If the agent produced no text output at all (not just zero findings),
    // the run cannot be considered a valid review — mark it failed so an
    // empty finding set is never mistaken for a clean review.
    if (!assistantText && findingCount === 0) {
      await reviews.update(review.id, { status: 'failed' });
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
setRunLifecycleHook(async (workflowId, runId, event) => {
  await handleReviewLifecycle(workflowId, runId, event);
  await handleArtifactLifecycle(workflowId, event);
});

// ── Artifact lifecycle (diagrams / generated-docs / presentations) ────────────

/**
 * On workflow done/failed/cancelled, update the status of any artifact
 * (diagram, generated_doc, presentation) that references this workflow.
 * This runs fire-and-forget so it never blocks the runner.
 */
async function handleArtifactLifecycle(
  workflowId: string,
  event: 'start' | 'done' | 'failed' | 'cancelled',
): Promise<void> {
  if (event === 'start') return;

  const wf = await getWorkflowRow(workflowId);
  const workDir = wf ? String(wf.work_dir ?? '') : '';

  // An agent's run of test cases: read its results into the sheet and the history.
  try {
    const { isCaseRunWorkflow, finishCaseRun } = await import('./testing/case-runs.ts');
    if (await isCaseRunWorkflow(workflowId)) {
      await finishCaseRun(workflowId, workDir, event);
      return;
    }
  } catch (e) { console.warn('[case-runs] could not close the run:', e instanceof Error ? e.message : e); }

  const projectId = wf?.project_id ? String(wf.project_id) : null;
  const diagrams = projectId ? ((await getDiagramRepository().listByProject(projectId)) as unknown as Row[]) : [];
  const gdocs = projectId ? ((await getGeneratedDocRepository().listByProject(projectId)) as unknown as Row[]) : [];
  const diagram = diagrams.find((d) => d.pending_workflow_id === workflowId);
  const gdoc = gdocs.find((d) => d.workflow_id === workflowId && d.status === 'generating');
  const pres = (await getPresentationRepository().getByWorkflowId(workflowId)) as unknown as Row | null;

  if (event === 'done') {
    const latestRunId = async (): Promise<string> => {
      const r = await getLatestRunRow(workflowId);
      return r ? String(r.id) : '';
    };

    if (diagram) {
      import('./diagrams.ts').then(async ({ processDiagramOutput }) => {
        await processDiagramOutput(workflowId, await latestRunId(), workDir).catch(() => { /* best effort */ });
      }).catch(() => { /* best effort */ });
    }
    if (gdoc) {
      import('./generated-docs.ts').then(async ({ processDocOutput }) => {
        await processDocOutput(workflowId, await latestRunId(), workDir).catch(() => { /* best effort */ });
      }).catch(() => { /* best effort */ });
    }
    if (pres) {
      import('./presentations.ts').then(async ({ processPresentationOutput }) => {
        await processPresentationOutput(workflowId, await latestRunId(), workDir).catch(() => { /* best effort */ });
      }).catch(() => { /* best effort */ });
    }
  } else {
    // failed or cancelled — mark artifacts as failed
    try {
      if (diagram) {
        await getDiagramRepository().update(String(diagram.id), { status: 'error', error: 'Generation failed', pending_workflow_id: null });
      }
      if (gdoc) {
        await getGeneratedDocRepository().update(String(gdoc.id), { status: 'failed', error: 'Generation failed' });
      }
      if (pres && pres.status === 'generating') {
        await getPresentationRepository().update(String(pres.id), { status: 'failed', error: 'Generation failed' });
      }
    } catch { /* best effort */ }
  }
}
