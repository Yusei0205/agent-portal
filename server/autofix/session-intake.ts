/** A failed ordinary session becomes a `session_failed` finding (reusing recordFinding, so dedupe, scrubbing and status rules stay in one place). */

import { addRunLifecycleHook } from '../agent/runner.ts';
import type { RunLifecycleDetail, RunLifecycleEvent } from '../agent/runner.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { getReviewsRepository } from '../repositories/reviews.ts';
import { getAutofixFindingsRepository } from '../repositories/autofix-findings.ts';
import { recordFinding } from './intake.ts';

/*
 * Whether recovery is continuing this failure is decided by the runner, not here. In runner.ts the 'failed' hook fires in the catch
 * block and recoverAfterInterruption runs later in the finally block, and the hook is fire-and-forget: reading the human events here
 * would race with recovery appending its own "↻" event (it would see the cap reached for a session that is being continued). So the
 * runner reads the trailing recovery count before firing the hook and passes `detail.recovering`; this intake reads no human events.
 *
 * Known gap: failures closed by the lost-run sweep (workflows/lost-runs.ts) and by driver-level catches (workflows/driver.ts) fire no
 * 'failed' hook, so they are out of scope for this intake.
 */

export async function handleSessionFailed(workflowId: string, runId: string, event: RunLifecycleEvent, detail?: RunLifecycleDetail): Promise<void> {
  if (event !== 'failed') return;
  const sessions = getSessionsRepository();
  const workflow = await sessions.getWorkflowById(workflowId);
  if (!workflow || !workflow.project_id || workflow.kind === 'automation' || workflow.kind === 'review') return;
  if (await getAutofixFindingsRepository().getByWorkflowId(workflowId)) return; // an auto-fix session
  if (await getReviewsRepository().getByWorkflowId(workflowId)) return; // a review session

  const run = await sessions.getRunById(runId);
  const error = String(run?.error ?? '').trim();
  const stop = String(run?.stop_reason ?? '').trim();
  if (detail?.recovering) return;

  const projectId = String(workflow.project_id);
  // computeFingerprint normalises the error (timestamps, ids, paths, line numbers), so the same failure is one finding and different
  // failures are different findings.
  const header = `Session ${workflowId}, run ${runId}. Goal: ${String(workflow.goal ?? '').slice(0, 200)}`;
  await recordFinding(
    projectId,
    {
      repoFullName: `session:${projectId}`, branch: 'sessions', headSha: '', source: 'session_failed', kind: 'session', severity: 'medium',
      errorText: [stop, error].filter(Boolean).join(' ') || 'run failed',
    },
    [header, stop && `Stop reason: ${stop}`, error && `Error: ${error}`].filter(Boolean).join('\n'),
  );
}

let unsubscribe: (() => void) | null = null;

/** Register the intake with the run lifecycle. Safe to call again (a second call replaces the first). */
export function registerSessionIntake(): () => void {
  unsubscribe?.();
  unsubscribe = addRunLifecycleHook(handleSessionFailed);
  return unsubscribe;
}
