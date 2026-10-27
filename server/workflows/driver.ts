/**
 * Session execution driver — startRun() creates a run record, checks concurrency,
 * and spawns the agent runner in the background.
 */

import { one, insert, run as dbRun } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now, badRequest } from '../util.ts';
import { emit } from '../events.ts';
import { activeRunCount } from './controls.ts';
import { executeRun } from '../agent/runner.ts';

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
    } catch {
      // DB may be closed during shutdown — ignore
    }
  });

  return runId;
}
