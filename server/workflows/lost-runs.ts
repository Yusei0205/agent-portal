/**
 * A turn whose process was lost.
 *
 * A turn runs in a separate process (the AgentCore job runtime, or a Lambda invocation). If that process dies without a word
 * (the microVM is reclaimed, the invocation is killed) nothing records the end of the turn: the run stays "running" for ever,
 * the session shows a turn in progress, and the next message waits behind it.
 *
 * While a turn runs, its process writes `heartbeat_at` on the run every HEARTBEAT_MS. A run that has gone quiet for LOST_AFTER_MS is
 * lost: it is closed as failed, with the reason, and the session is left ready for the next message.
 */

import { getSessionsRepository } from '../repositories/sessions.ts';
import type { RunRecord, RunFinalizeStats } from '../repositories/sessions.ts';
import { emit } from '../events.ts';
import { now } from '../util.ts';

/** How often the process running a turn says it is alive. */
export const HEARTBEAT_MS = 30_000;
/** No sign of life for this long: the process is gone (ten heartbeats missed). */
export const LOST_AFTER_MS = 5 * 60_000;
/** A run that was never picked up (a microVM can take minutes to start). */
export const PENDING_LOST_AFTER_MS = 15 * 60_000;
/** A run from before heartbeats: only judged when its own time limit passed and it still did not report back. */
export const PAST_LIMIT_GRACE_MS = 2 * 60_000;

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Why this run counts as lost, or null when it is fine (or already over). Pure: the time is passed in. */
export function lostRunReason(run: RunRecord, nowMs: number = Date.now()): string | null {
  if (run.status === 'pending') {
    const created = ms(run.created_at);
    return !Number.isNaN(created) && nowMs - created > PENDING_LOST_AFTER_MS
      ? 'This turn never started: the job that should have run it did not pick it up.'
      : null;
  }
  if (run.status !== 'running') return null;

  const beat = ms(run.heartbeat_at);
  if (!Number.isNaN(beat)) {
    return nowMs - beat > LOST_AFTER_MS
      ? `The job running this turn stopped responding (no sign of life since ${new Date(beat).toISOString().slice(11, 19)} UTC), so the turn was ended. Send a message to carry on.`
      : null;
  }
  const limit = ms(run.time_limit_at);
  return !Number.isNaN(limit) && nowMs - limit > PAST_LIMIT_GRACE_MS
    ? 'The job running this turn did not report back by its time limit, so the turn was ended. Send a message to carry on.'
    : null;
}

/**
 * Close a lost run as failed and leave its session ready for the next message. Safe to call twice (the second call finds the run
 * already closed and changes nothing). Returns whether this call closed it.
 */
export async function closeLostRun(runId: string, reason: string): Promise<boolean> {
  const repo = getSessionsRepository();
  const run = await repo.getRunById(runId);
  if (!run || (run.status !== 'running' && run.status !== 'pending')) return false;
  const workflow = await repo.getWorkflowById(run.workflow_id).catch(() => null);

  const ts = now();
  const hint: RunFinalizeStats = {
    dateUTC: ts.slice(0, 10),
    projectId: workflow?.project_id ? String(workflow.project_id) : null,
    agentName: (workflow?.lead_agent ?? '').trim() || 'default',
  };
  // Conditional on the status read above: if the process was only slow and finishes the run itself first, this does nothing.
  const closed = await repo.finalizeRun(runId, run.status, { status: 'failed', finished_at: ts, error: reason.slice(0, 2000) }, hint);
  if (!closed) return false;

  // The turn is over, so the session is not "running" any more. A session the person stopped stays as it is.
  if (workflow && (workflow.status === 'running' || workflow.status === 'paused')) {
    await repo.updateWorkflow(workflow.id, { status: 'paused', stop_reason: 'interrupted', last_turn_at: ts, updated_at: ts });
  }
  try {
    const { emitRunEvent } = await import('../agent/runner.ts');
    emitRunEvent(runId, workflow?.project_id ? String(workflow.project_id) : null, run.workflow_id, 'run-failed', { error: reason });
  } catch { /* the run is closed either way */ }
  if (workflow?.project_id) {
    emit(String(workflow.project_id), { type: 'run.updated', workflowId: run.workflow_id, runId, status: 'failed' });
    emit(String(workflow.project_id), { type: 'workflow.updated', workflowId: run.workflow_id, status: 'paused' });
  }
  console.warn(`[lost-run] closed ${runId} of ${run.workflow_id}: ${reason}`);
  return true;
}
