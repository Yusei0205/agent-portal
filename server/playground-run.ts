/**
 * Start a single unattended agent run with no repository (a "playground" session of one iteration) for a feature that
 * builds its own prompt, such as the presentation generator. It goes through the same machinery as any session: the
 * concurrency caps and queue, the drain mode, the monthly budget and the session list all apply.
 */
import { insert, one, type Row } from './db.ts';
import { getProject, notifyProject } from './projects.ts';
import { badRequest, newId, now } from './util.ts';
import { assertBudget } from './settings.ts';
import { concurrencyReason, queueReasonLabel } from './control-plane.ts';
import { engineProvider } from './project-aws.ts';
import { log } from './workflows/store.ts';
import { readSettings } from './workflows/validation.ts';

export interface PlaygroundRunInput {
  projectId: string;
  userId: string;
  title: string;
  goal: string;
  /** Rules the session shows the agent next to the goal. */
  rules: string;
  budgetUsd: number;
  /** A line for the session history ("Presentation session started ..."). */
  logLine: string;
}

/** Refuse before anything is written when the monthly budget is used up. */
export function checkRunBudget(projectId: string, userId: string): void {
  try {
    assertBudget(engineProvider(projectId, null), userId, projectId);
  } catch (e: any) {
    throw badRequest(e?.message ?? String(e));
  }
}

/** Create the session row and start it (or queue it when the caps are reached). Returns the row. */
export async function startPlaygroundRun(i: PlaygroundRunInput): Promise<Row> {
  const project = getProject(i.projectId);
  const s = readSettings({ model: project.default_model || undefined, budgetUsd: i.budgetUsd, maxIterations: 1, pushMode: 'never', permissionMode: '' }, undefined, { hasRepos: false, isPlayground: true });
  const reason = concurrencyReason(i.userId, project.id);
  const queued = reason !== null;
  const id = newId('w_');
  const ts = now();
  insert('workflows', {
    id,
    project_id: project.id,
    title: i.title.slice(0, 120),
    goal: i.goal,
    status: queued ? 'queued' : 'running',
    stop_reason: queued ? queueReasonLabel(reason!) : '',
    queue_reason: queued ? reason! : '',
    queued_at: queued ? ts : null,
    repo_id: null,
    branch: null,
    repos: '[]',
    workspace_id: null,
    engine: '',
    integrations: '[]',
    playground: 1,
    ...s,
    rules: i.rules,
    iteration: 0,
    burst_start: 0,
    spent_usd: 0,
    spent_credits: 0,
    work_branch: '',
    lead_agent: '',
    jira_key: '',
    jira_summary: '',
    jira_url: '',
    summary: '',
    loop_spec_id: null,
    planning_gate: 0,
    created_by: i.userId,
    created_at: ts,
    updated_at: ts,
  });
  log(id, 'system', i.logLine);
  notifyProject(project.id, 'workflow.created', { id });
  if (!queued) {
    const { kick } = await import('./workflows/driver.ts');
    kick(id);
  }
  return one<Row>('SELECT * FROM workflows WHERE id = ?', id)!;
}
