/**
 * Session execution driver — startRun() creates a run record, checks concurrency,
 * and spawns the agent runner in the background.
 */

import { one, insert, run as dbRun, setBeforeCloseHook } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now, badRequest } from '../util.ts';
import { emit } from '../events.ts';
import { activeRunCount, abortAllRuns } from './controls.ts';
import { executeRun } from '../agent/runner.ts';

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
  const workflow = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', workflowId);
  if (!workflow) throw badRequest('Workflow not found');

  // Idempotency: if a run is already active for this workflow, return it.
  // This prevents double-starts when the /message route and the composer UI
  // both call /start in rapid succession.
  const activeRun = one<Row>(
    "SELECT id FROM p6_runs WHERE workflow_id = ? AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
    workflowId,
  );
  if (activeRun) {
    return String(activeRun.id);
  }

  // max_iterations enforcement: if the workflow has already exhausted its
  // iteration budget, refuse to start a new run with a clear stop reason.
  const maxIter = Number(workflow.max_iterations ?? 0);
  const iterCount = Number(workflow.iteration_count ?? 0);
  if (maxIter > 0 && iterCount >= maxIter) {
    // Mark workflow done with stop_reason='max_iterations' if not already
    dbRun(
      `UPDATE p6_workflows SET status = 'done', stop_reason = 'max_iterations', updated_at = ? WHERE id = ? AND stop_reason != 'max_iterations'`,
      now(),
      workflowId,
    );
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
  insert('p6_runs', {
    id: runId,
    workflow_id: workflowId,
    status: 'pending',
    started_at: null,
    finished_at: null,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    created_at: now(),
  });

  // Update workflow to running
  dbRun(
    `UPDATE p6_workflows SET status = 'running', updated_at = ? WHERE id = ?`,
    now(),
    workflowId,
  );

  // Notify project channel
  if (workflow.project_id) {
    emit(String(workflow.project_id), {
      type: 'workflow.started',
      workflowId,
      runId,
    });
    emit(String(workflow.project_id), { type: 'workflow.updated', workflowId, status: 'running' });
    emit(String(workflow.project_id), { type: 'run.updated', workflowId, runId, status: 'pending' });
  }

  // Spawn the run in the background (fire-and-forget)
  executeRun(runId, workflowId).catch((e: unknown) => {
    console.error(`[driver] Unhandled error in run ${runId}:`, e);
    // Best-effort: mark the run failed
    try {
      dbRun(
        'UPDATE p6_runs SET status = ?, finished_at = ? WHERE id = ?',
        'failed',
        now(),
        runId,
      );
      dbRun(
        `UPDATE p6_workflows SET status = 'failed', updated_at = ? WHERE id = ?`,
        now(),
        workflowId,
      );
      if (workflow.project_id) {
        emit(String(workflow.project_id), { type: 'run.updated', workflowId, runId, status: 'failed' });
        emit(String(workflow.project_id), { type: 'workflow.updated', workflowId, status: 'failed' });
      }
    } catch {
      // DB may be closed during shutdown — ignore
    }
  });

  return runId;
}
