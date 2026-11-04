/**
 * Session execution driver — startRun() creates a run record, checks concurrency,
 * and spawns the agent runner in the background.
 */

import { registerBackgroundJob, runInBackground } from '../background-jobs.ts';
import { setBeforeCloseHook } from '../db.ts';
import { generateId, now, badRequest } from '../util.ts';
import { emit } from '../events.ts';
import { activeRunCount, abortAllRuns } from './controls.ts';
import { executeRun } from '../agent/runner.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import type { RunFinalizeStats } from '../repositories/sessions.ts';

// ── Before-close hook ─────────────────────────────────────────────────────────
// Abort all active runs when the database is closed so background executeRun
// tasks don't attempt to insert into a replaced in-memory DB (FK violations).
setBeforeCloseHook(abortAllRuns);

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum number of agent runs that may be active simultaneously across the portal. */
const MAX_CONCURRENT_RUNS = 5;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Create a run record for a workflow and start it in the background.
 * Returns the new runId.
 *
 * Throws an HttpError(429) if the concurrency limit is reached.
 */
export async function startRun(workflowId: string): Promise<string> {
  const repo = getSessionsRepository();
  const workflow = await repo.getWorkflowById(workflowId);
  if (!workflow) throw badRequest('Workflow not found');

  // Idempotency: if a run is already active for this workflow, return it.
  const activeRun = await repo.getActiveRun(workflowId);
  if (activeRun) {
    return activeRun.id;
  }

  // max_iterations enforcement
  const maxIter = workflow.max_iterations ?? 0;
  const iterCount = workflow.iteration_count ?? 0;
  if (maxIter > 0 && iterCount >= maxIter) {
    const ts = now();
    if (workflow.stop_reason !== 'max_iterations') {
      await repo.updateWorkflow(workflowId, { status: 'done', stop_reason: 'max_iterations', updated_at: ts });
    }
    throw badRequest(
      `Workflow has reached its maximum iteration limit (${maxIter}). ` +
      `Create a new session or increase max_iterations to continue.`,
    );
  }

  // Concurrency check
  if (activeRunCount() >= MAX_CONCURRENT_RUNS) {
    throw badRequest(
      `The portal is already running ${MAX_CONCURRENT_RUNS} agent runs. Wait for one to finish before starting another.`,
    );
  }

  // Create run record in pending state
  const runId = generateId();
  const ts = now();
  await repo.createRun({
    id: runId,
    workflow_id: workflowId,
    status: 'pending',
    started_at: null,
    finished_at: null,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    created_at: ts,
  });

  // Conditionally update workflow to running.
  // Uses the status we just read as the expected value so a concurrent startRun
  // (or any other status transition) that wins the race is detected here.
  const claimed = await repo.updateWorkflowConditional(workflowId, workflow.status, {
    status: 'running',
    updated_at: ts,
  }, { hintParentId: workflow.parent_id });

  if (!claimed) {
    // Another caller transitioned the workflow before us.
    // Cancel our orphaned pending run via finalizeRun so it is counted in DynamoDB rollups.
    const cancelTs = now();
    const cancelHint: RunFinalizeStats = {
      dateUTC: cancelTs.slice(0, 10),
      projectId: workflow.project_id ?? null,
      agentName: (workflow.lead_agent ?? '').trim() || 'default',
    };
    await repo.finalizeRun(runId, 'pending', {
      status: 'cancelled',
      finished_at: cancelTs,
    }, cancelHint);
    const conflictRun = await repo.getActiveRun(workflowId);
    if (conflictRun) return conflictRun.id;
    // Workflow moved to a terminal state between our read and write.
    throw badRequest('Workflow is no longer in a startable state');
  }

  // Notify project channel
  if (workflow.project_id) {
    emit(workflow.project_id, { type: 'workflow.started', workflowId, runId });
    emit(workflow.project_id, { type: 'workflow.updated', workflowId, status: 'running' });
    emit(workflow.project_id, { type: 'run.updated', workflowId, runId, status: 'pending' });
  }

  // Run it in the background. On Lambda this is a separate invocation, so the run keeps going after this
  // request's reply is sent (otherwise the instance freezes and the run only moves when something wakes it).
  await runInBackground('execute-run', { runId, workflowId });

  return runId;
}

/** Runs one agent turn and marks the run failed if it throws. */
async function runTurn(runId: string, workflowId: string): Promise<void> {
  try {
    await executeRun(runId, workflowId);
  } catch (e: unknown) {
    console.error(`[driver] Unhandled error in run ${runId}:`, e);
    const repo = getSessionsRepository();
    const workflow = await repo.getWorkflowById(workflowId).catch(() => null);
    // Best-effort: mark the run failed via finalizeRun so rollups are updated.
    const errTs = now();
    const errHint: RunFinalizeStats = {
      dateUTC: errTs.slice(0, 10),
      projectId: workflow?.project_id ?? null,
      agentName: (workflow?.lead_agent ?? '').trim() || 'default',
    };
    await repo.finalizeRun(runId, 'running', { status: 'failed', finished_at: errTs }, errHint).catch(() => {});
    await repo.updateWorkflowConditional(workflowId, 'running', { status: 'failed', updated_at: errTs }).catch(() => {});
    if (workflow?.project_id) {
      emit(workflow.project_id, { type: 'run.updated', workflowId, runId, status: 'failed' });
      emit(workflow.project_id, { type: 'workflow.updated', workflowId, status: 'failed' });
    }
  }
}

registerBackgroundJob('execute-run', async (a) => { await runTurn(String(a.runId), String(a.workflowId)); });
