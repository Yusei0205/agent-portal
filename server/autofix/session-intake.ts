/** A failed ordinary session becomes a `session_failed` finding (reusing recordFinding, so dedupe, scrubbing and status rules stay in one place). */

import { addRunLifecycleHook } from '../agent/runner.ts';
import type { RunLifecycleDetail, RunLifecycleEvent } from '../agent/runner.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { getReviewsRepository } from '../repositories/reviews.ts';
import { getAutofixFindingsRepository } from '../repositories/autofix-findings.ts';
import { interruptionOf, trailingRecoveries, MAX_AUTO_RECOVERIES } from '../workflows/recovery.ts';
import { recordFinding } from './intake.ts';

/**
 * Whether the runner's recovery is going to continue this failure, so it is not a failure yet.
 *
 * Order in runner.ts: fireHook('failed') runs in the catch block; recoverAfterInterruption runs later, in the finally block. So the
 * hook fires BEFORE recovery decides, and the decision is re-derived here from the same inputs recovery uses:
 *   - "is it an interruption": `detail.cutOff`, which the runner computes as interruptionOf(e) from the live error. The stored run
 *     error is only e.message, which loses the error name (AgentCoreStallError) and status (504) that interruptionOf also reads, so
 *     the stored text alone would miss two of its five kinds. (Without detail, fall back to interruptionOf on the stored message.)
 *   - "is there room": trailingRecoveries(human events) < MAX_AUTO_RECOVERIES, counted exactly as recoverAfterInterruption does.
 * Nothing appends a human event between the hook and that decision, so both see the same count. At the cap, recovery stops and the
 * failure is real, so a finding is created.
 */
async function recoveryWillContinue(workflowId: string, storedError: string, detail?: RunLifecycleDetail): Promise<boolean> {
  const cutOff = detail?.cutOff ?? interruptionOf({ message: storedError }) !== null;
  if (!cutOff) return false;
  const bodies = (await getSessionsRepository().listHumanWorkflowEvents(workflowId, null, null, null)).map((m) => String(m.body));
  return trailingRecoveries(bodies) < MAX_AUTO_RECOVERIES;
}

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
  if (await recoveryWillContinue(workflowId, error, detail)) return;

  const projectId = String(workflow.project_id);
  // The stable part is the stop reason (or the failure's class), never the raw error text, so one finding covers repeat failures.
  const errorClass = stop || (interruptionOf({ message: error })?.kind ?? 'run failed');
  await recordFinding(
    projectId,
    { repoFullName: `session:${projectId}`, branch: 'sessions', headSha: '', source: 'session_failed', kind: 'session', severity: 'medium', errorText: errorClass },
    [stop && `Stop reason: ${stop}`, error && `Error: ${error}`].filter(Boolean).join('\n') || 'The session run failed.',
  );
}

let unsubscribe: (() => void) | null = null;

/** Register the intake with the run lifecycle. Safe to call again (a second call replaces the first). */
export function registerSessionIntake(): () => void {
  unsubscribe?.();
  unsubscribe = addRunLifecycleHook(handleSessionFailed);
  return unsubscribe;
}
