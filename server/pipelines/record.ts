/**
 * Stores a workflow_run delivery and, for a failed deploy run on an alerting branch, opens/refreshes/resolves the alert
 * (Inbox item + chat message). Never throws: the webhook answers 202 and this runs in the background.
 */

import { getPipelineRunsRepository } from '../repositories/pipeline-runs.ts';
import type { PipelineAlert, PipelineRun } from '../repositories/pipeline-runs.ts';
import { getProjectRepository } from '../repositories/projects.ts';
import { getInboxRepository } from '../repositories/inbox.ts';
import { createInboxItem } from '../inbox.ts';
import { emit } from '../events.ts';
import { now } from '../util.ts';
import type { WorkflowRunEvent } from './events.ts';
import { getPipelineSettings, isAlertingBranch, isDeployWorkflow } from './settings.ts';
import { getChatTarget, notifyRunChat } from './chat.ts';

const KEEP_RUNS = 50;
const CAS_TRIES = 4;

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

  let claimed: PipelineAlert | null = null; // set when this call opened the alert and owes it an Inbox item
  for (let i = 0; i < CAS_TRIES; i++) {
    const a = await runs.getAlert(projectId, repoId, ev.workflowId, ev.branch);
    if (a && !a.open && ev.runNumber < a.last_run_number) return; // older than the success that closed it
    if (a && a.open) {
      const newer = ev.runNumber >= a.last_run_number;
      const next: PipelineAlert = {
        ...a,
        failures: a.failures + 1,
        last_run_id: newer ? ev.runId : a.last_run_id,
        last_run_number: newer ? ev.runNumber : a.last_run_number,
        updated_at: stamp(a.updated_at),
      };
      if (await runs.putAlert(next, a.updated_at)) break;
      continue;
    }
    const opened: PipelineAlert = {
      project_id: projectId, repo_id: repoId, workflow_id: ev.workflowId, branch: ev.branch, open: true, inbox_id: null,
      last_run_id: ev.runId, last_run_number: ev.runNumber, failures: 1, updated_at: stamp(a ? a.updated_at : null),
    };
    if (await runs.putAlert(opened, a ? a.updated_at : null)) { claimed = opened; break; }
  }

  if (claimed) {
    const inboxId = await createInboxItem({
      type: 'blocked',
      projectId,
      payload: {
        kind: 'pipeline', workflow: ev.workflowName, repo: ev.repoFullName, branch: ev.branch, sha: ev.headSha.slice(0, 7),
        actor: ev.actor, url: ev.htmlUrl || '', failures: 1,
      },
    });
    await attachInboxId(projectId, repoId, ev, inboxId);
  }

  // Chat is separate: a failure here never blocks or duplicates the Inbox item.
  try {
    if (await getChatTarget(projectId)) {
      if (await runs.markAlerted(projectId, ev.runId, ev.runAttempt, 'chat')) await notifyRunChat(projectId, 'failed', run);
    }
  } catch (e) { console.error('[pipelines] chat failed', e); }
}

async function attachInboxId(projectId: string, repoId: string, ev: WorkflowRunEvent, inboxId: string): Promise<void> {
  const runs = getPipelineRunsRepository();
  for (let i = 0; i < CAS_TRIES + 2; i++) {
    const a = await runs.getAlert(projectId, repoId, ev.workflowId, ev.branch);
    if (!a || a.inbox_id) return;
    if (await runs.putAlert({ ...a, inbox_id: inboxId, updated_at: stamp(a.updated_at) }, a.updated_at)) {
      // Recovery may have closed the alert before the item existed: close the item now.
      if (!a.open) await resolveItem(projectId, inboxId);
      return;
    }
  }
  console.error('[pipelines] could not attach inbox item to alert', inboxId);
}

/**
 * Resolves the Inbox item as 'system' (the existing convention). SQLite's resolved_by is a foreign key to users, which has no
 * 'system' row, so that write is refused there; fall back to the project's creator so the item really closes.
 * A no-op when a person already resolved it.
 */
async function resolveItem(projectId: string, inboxId: string): Promise<void> {
  const inbox = getInboxRepository();
  try { await inbox.resolveConditional(inboxId, 'system', now()); return; } catch { /* try the creator */ }
  try {
    const owner = (await getProjectRepository().getProjectById(projectId))?.created_by;
    if (owner) await inbox.resolveConditional(inboxId, owner, now());
    else console.error('[pipelines] resolve failed: no user to attribute the resolve to', inboxId);
  } catch (e) { console.error('[pipelines] resolve failed', e); }
}

async function onSuccess(projectId: string, repoId: string, ev: WorkflowRunEvent, run: PipelineRun): Promise<void> {
  const runs = getPipelineRunsRepository();
  for (let i = 0; i < CAS_TRIES; i++) {
    const a = await runs.getAlert(projectId, repoId, ev.workflowId, ev.branch);
    if (!a || !a.open) return;
    const later = ev.runNumber > a.last_run_number;
    const rerun = ev.runId === a.last_run_id && ev.runAttempt > 1;
    if (!later && !rerun) return; // an older run finishing late resolves nothing
    const closed: PipelineAlert = {
      ...a, open: false, last_run_id: ev.runId, last_run_number: Math.max(ev.runNumber, a.last_run_number), updated_at: stamp(a.updated_at),
    };
    if (!(await runs.putAlert(closed, a.updated_at))) continue;
    if (a.inbox_id) await resolveItem(projectId, a.inbox_id);
    try {
      if (await getChatTarget(projectId)) {
        if (await runs.markAlerted(projectId, ev.runId, ev.runAttempt, 'chat')) await notifyRunChat(projectId, 'recovered', run);
      }
    } catch (e) { console.error('[pipelines] chat failed', e); }
    return;
  }
}
