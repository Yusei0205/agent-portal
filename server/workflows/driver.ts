/**
 * Session execution driver — startRun() creates a run record, checks concurrency,
 * and spawns the agent runner in the background.
 */

import { setBeforeCloseHook } from '../db.ts';
import { generateId, now, badRequest } from '../util.ts';
import { emit } from '../events.ts';
import { activeRunCount, abortAllRuns } from './controls.ts';
import { executeRun } from '../agent/runner.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';

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

  // Update workflow to running
  await repo.updateWorkflow(workflowId, { status: 'running', updated_at: ts });

  // Notify project channel
  if (workflow.project_id) {
    emit(workflow.project_id, { type: 'workflow.started', workflowId, runId });
    emit(workflow.project_id, { type: 'workflow.updated', workflowId, status: 'running' });
    emit(workflow.project_id, { type: 'run.updated', workflowId, runId, status: 'pending' });
  }

  // Spawn the run in the background (fire-and-forget)
  executeRun(runId, workflowId).catch((e: unknown) => {
    console.error(`[driver] Unhandled error in run ${runId}:`, e);
    // Best-effort: mark the run failed
    const errTs = now();
    repo.updateRun(runId, { status: 'failed', finished_at: errTs }).catch(() => {});
    repo.updateWorkflow(workflowId, { status: 'failed', updated_at: errTs }).catch(() => {});
    if (workflow.project_id) {
      emit(workflow.project_id, { type: 'run.updated', workflowId, runId, status: 'failed' });
      emit(workflow.project_id, { type: 'workflow.updated', workflowId, status: 'failed' });
    }
  });

  return runId;
}
