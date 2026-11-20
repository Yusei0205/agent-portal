/**
 * Stores a workflow_run delivery and, for a failed deploy run on an alerting branch, opens/refreshes/resolves the alert
 * (Inbox item + chat message). Never throws: the webhook answers 202 and this runs in the background.
 */

import { getPipelineRunsRepository } from '../repositories/pipeline-runs.ts';
import type { PipelineAlert, PipelineRun } from '../repositories/pipeline-runs.ts';
import { getInboxRepository } from '../repositories/inbox.ts';
import { createInboxItem } from '../inbox.ts';
import { emit } from '../events.ts';
import { now } from '../util.ts';
import type { WorkflowRunEvent } from './events.ts';
import { getPipelineSettings, isAlertingBranch, isDeployWorkflow } from './settings.ts';
import { getChatTarget, notifyRunChat } from './chat.ts';

const KEEP_RUNS = 50;
const CAS_TRIES = 4;
/** An alert claimed but still without an Inbox item after this long is taken over (the claimer failed). */
const CLAIM_STALE_MS = 60_000;

/** A fresh updated_at that always differs from the one it replaces (the compare-and-set key). */
function stamp(prev: string | null): string {
  let t = now();
  if (t === prev) t = new Date(Date.parse(t) + 1).toISOString();
  return t;
}

export async function recordPipelineRun(
  projectId: string,
  repo: { id: string; default_branch: string | null },
  ev: WorkflowRunEvent,
): Promise<void> {
  try {
    const runs = getPipelineRunsRepository();
    const { run } = await runs.upsertRun({
      project_id: projectId, repo_id: repo.id, repo_full_name: ev.repoFullName, run_id: ev.runId, run_attempt: ev.runAttempt,
      run_number: ev.runNumber, workflow_id: ev.workflowId, workflow_name: ev.workflowName, branch: ev.branch,
      head_sha: ev.headSha, actor: ev.actor, event: ev.event, status: ev.status, html_url: ev.htmlUrl,
      started_at: ev.startedAt, completed_at: ev.completedAt,
    });
    try { await runs.prune(projectId, repo.id, ev.workflowId, KEEP_RUNS); } catch (e) { console.error('[pipelines] prune failed', e); }
    emit(projectId, { type: 'pipeline.run', repoId: repo.id, runId: ev.runId });

    const settings = await getPipelineSettings(projectId);
    if (!isDeployWorkflow(settings, ev.workflowName) || !isAlertingBranch(settings, ev.branch, repo.default_branch)) return;

    // A stale delivery (an older attempt, or a late in-progress after completion) changed nothing: alert nothing.
    if (run.run_attempt !== ev.runAttempt || run.status !== ev.status) return;

    if (ev.status === 'failure' || ev.status === 'timed_out') await onFailure(projectId, repo.id, ev, run);
    else if (ev.status === 'success') await onSuccess(projectId, repo.id, ev, run);
  } catch (e) {
    console.error('[pipelines] recordPipelineRun failed', e);
  }
}

async function onFailure(projectId: string, repoId: string, ev: WorkflowRunEvent, run: PipelineRun): Promise<void> {
  const runs = getPipelineRunsRepository();
  // Redelivery of the same run+attempt: already handled.
  if (!(await runs.markAlerted(projectId, ev.runId, ev.runAttempt, 'inbox'))) return;

  let claim: PipelineAlert | null = null; // set when this call owes the alert an Inbox item
  let settled = false;
  for (let i = 0; i < CAS_TRIES && !settled; i++) {
    const a = await runs.getAlert(projectId, repoId, ev.workflowId, ev.branch);
    // Only a run later than the last one the alert has seen can open or refresh it.
    if (a && ev.runNumber < a.last_run_number) {
      if (a.open) { // an older failure of the same workflow still counts as a failure of the open alert
        if (await runs.putAlert({ ...a, failures: a.failures + 1, updated_at: stamp(a.updated_at) }, a.updated_at)) settled = true;
        continue;
      }
      return;
    }
    if (a && !a.open && ev.runNumber === a.last_run_number && ev.runId !== a.last_run_id) return;
    if (a && !a.open && ev.runId === a.last_run_id && ev.runAttempt <= 1) return;

    if (a && a.open) {
      const needsItem = await itemMissing(a);
      const next: PipelineAlert = {
        ...a, failures: a.failures + 1, last_run_id: ev.runId, last_run_number: ev.runNumber, updated_at: stamp(a.updated_at),
      };
      if (needsItem) next.inbox_id = null;
      if (await runs.putAlert(next, a.updated_at)) { settled = true; if (needsItem) claim = next; }
      continue;
    }
    const opened: PipelineAlert = {
      project_id: projectId, repo_id: repoId, workflow_id: ev.workflowId, branch: ev.branch, open: true, inbox_id: null,
      last_run_id: ev.runId, last_run_number: ev.runNumber, failures: 1, updated_at: stamp(a ? a.updated_at : null),
    };
    if (await runs.putAlert(opened, a ? a.updated_at : null)) { settled = true; claim = opened; }
  }
  if (!settled) { console.error('[pipelines] lost every alert race', projectId, ev.runId); return; }

  if (claim) await createItemForClaim(projectId, repoId, ev, claim);

  // Chat is separate: a failure here never blocks or duplicates the Inbox item.
  try {
    if (await getChatTarget(projectId)) {
      if (await runs.markAlerted(projectId, ev.runId, ev.runAttempt, 'chat')) await notifyRunChat(projectId, 'failed', run);
    }
  } catch (e) { console.error('[pipelines] chat failed', e); }
}

/** True when an open alert has no usable Inbox item: resolved by hand, or a claim whose creator never finished. */
async function itemMissing(a: PipelineAlert): Promise<boolean> {
  if (!a.inbox_id) return Date.now() - Date.parse(a.updated_at) > CLAIM_STALE_MS;
  try {
    const item = await getInboxRepository().getById(a.inbox_id);
    return !item || item.resolved !== 0;
  } catch { return false; }
}

async function createItemForClaim(projectId: string, repoId: string, ev: WorkflowRunEvent, claim: PipelineAlert): Promise<void> {
  const runs = getPipelineRunsRepository();
  let inboxId: string;
  try {
    inboxId = await createInboxItem({
      type: 'blocked',
      projectId,
      payload: {
        kind: 'pipeline', title: `${ev.workflowName} on ${ev.repoFullName}@${ev.branch}`, workflow: ev.workflowName, repo: ev.repoFullName,
        branch: ev.branch, sha: ev.headSha.slice(0, 7), actor: ev.actor, url: ev.htmlUrl || '', failures: 1,
      },
    });
  } catch (e) {
    console.error('[pipelines] could not create the Inbox item; releasing the alert', e);
    // Put the alert back CLOSED (keeping the run number) so the next failure can claim it again.
    for (let i = 0; i < CAS_TRIES; i++) {
      const a = await runs.getAlert(projectId, repoId, ev.workflowId, ev.branch);
      if (!a || a.inbox_id || !a.open) return;
      if (await runs.putAlert({ ...a, open: false, last_run_number: Math.min(a.last_run_number, claim.last_run_number - 1), updated_at: stamp(a.updated_at) }, a.updated_at)) return;
    }
    return;
  }
  for (let i = 0; i < CAS_TRIES + 2; i++) {
    const a = await runs.getAlert(projectId, repoId, ev.workflowId, ev.branch);
    // Attach only to the claim this call made (same alert, still item-less), never to a later reopened one.
    if (!a || a.inbox_id || a.last_run_number < claim.last_run_number) { await resolveItem(inboxId); return; }
    if (await runs.putAlert({ ...a, inbox_id: inboxId, updated_at: stamp(a.updated_at) }, a.updated_at)) {
      if (!a.open) await resolveItem(inboxId); // recovery closed the alert before the item existed
      return;
    }
  }
  console.error('[pipelines] lost every race attaching the Inbox item', inboxId);
}

/** Resolves the Inbox item as the system (user null). A no-op when a person already resolved it. */
async function resolveItem(inboxId: string): Promise<void> {
  try { await getInboxRepository().resolveConditional(inboxId, null, now()); } catch (e) { console.error('[pipelines] resolve failed', e); }
}

async function onSuccess(projectId: string, repoId: string, ev: WorkflowRunEvent, run: PipelineRun): Promise<void> {
  const runs = getPipelineRunsRepository();
  for (let i = 0; i < CAS_TRIES; i++) {
    const a = await runs.getAlert(projectId, repoId, ev.workflowId, ev.branch);
    if (!a) {
      // Remember the success so a late older failure cannot open an alert.
      const closed: PipelineAlert = {
        project_id: projectId, repo_id: repoId, workflow_id: ev.workflowId, branch: ev.branch, open: false, inbox_id: null,
        last_run_id: ev.runId, last_run_number: ev.runNumber, failures: 0, updated_at: stamp(null),
      };
      if (await runs.putAlert(closed, null)) return;
      continue;
    }
    const later = ev.runNumber > a.last_run_number;
    const rerun = ev.runId === a.last_run_id && ev.runAttempt > 1;
    if (!later && !rerun) return; // an older run finishing late resolves nothing
    // An open alert is closed and resolved; a closed one just advances its run number.
    const closed: PipelineAlert = {
      ...a, open: false, last_run_id: ev.runId, last_run_number: Math.max(ev.runNumber, a.last_run_number), updated_at: stamp(a.updated_at),
    };
    if (!(await runs.putAlert(closed, a.updated_at))) continue;
    if (!a.open) return;
    if (a.inbox_id) await resolveItem(a.inbox_id);
    try {
      if (await getChatTarget(projectId)) {
        if (await runs.markAlerted(projectId, ev.runId, ev.runAttempt, 'chat')) await notifyRunChat(projectId, 'recovered', run);
      }
    } catch (e) { console.error('[pipelines] chat failed', e); }
    return;
  }
  console.error('[pipelines] lost every alert race on recovery', projectId, ev.runId);
}
