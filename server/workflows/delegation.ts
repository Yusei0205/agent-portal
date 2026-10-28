/** Delegated sessions: a session hands a task to a child session and is told when it stops. */
import { all, insert, one, run as exec, type Row } from '../db.ts';
import { post } from '../http.ts';
import { requireProject } from '../projects.ts';
import { badRequest, newId, now, str } from '../util.ts';
import { getSettings } from '../settings.ts';
import { getWorkflow, patch, log, overBudget } from './store.ts';
import { view } from './views.ts';
import { kick } from './driver.ts';

export function childrenOf(id: string): Row[] {
  return all<Row>('SELECT id, title, status, summary, stop_reason, seen_by_parent FROM workflows WHERE parent_id = ? ORDER BY created_at', id);
}

/** What a new delegated session of this parent may spend, in USD (never more than the parent's own budget). */
export function childBudget(parent: Row): number {
  const committed = Number(
    one<Row>("SELECT COALESCE(SUM(MAX(budget_usd - spent_usd, 0)), 0) AS n FROM workflows WHERE parent_id = ? AND status IN ('running', 'queued', 'paused')", parent.id)?.n ?? 0,
  );
  const left = Number(parent.budget_usd ?? 0) - Number(parent.spent_usd ?? 0) - committed;
  return Number(Math.min(Number(parent.budget_usd ?? 0), Math.max(0, left)).toFixed(4));
}

export function runningChildren(id: string): number {
  return Number(one<Row>("SELECT COUNT(*) AS n FROM workflows WHERE parent_id = ? AND status = 'running'", id)?.n ?? 0);
}

/** How many more delegated sessions this session may start now (Settings › Delegated sessions), and why not. */
export function delegationRoom(w: Row): { canStart: number; why?: string } {
  const d = getSettings().delegation;
  if (!d.enabled) return { canStart: 0, why: 'delegation is turned off' };
  if (Number(w.depth) >= 1 && !d.allowNested) return { canStart: 0, why: 'a delegated session cannot delegate further' };
  const perParent = d.maxPerParent - runningChildren(w.id);
  const perUser = d.maxPerUser - Number(one<Row>("SELECT COUNT(*) AS n FROM workflows WHERE parent_id IS NOT NULL AND created_by = ? AND status = 'running'", w.created_by)?.n ?? 0);
  const n = Math.max(0, Math.min(perParent, perUser));
  if (n) return { canStart: n };
  return { canStart: 0, why: perParent <= 0 ? `${d.maxPerParent} delegated sessions of this one are running already` : `${d.maxPerUser} delegated sessions of this person are running already` };
}

/**
 * Hand a task to a new session that inherits the parent's repositories, integrations, engine, model, limits and rules,
 * and works on its own working copy and branch. It starts at once.
 */
export function createChild(parent: Row, task: { title?: string; goal: string }, by: { id: string; name: string }): Row {
  const room = delegationRoom(parent);
  if (!room.canStart) throw badRequest(`Cannot delegate now: ${room.why}.`);
  const goal = task.goal.trim();
  if (!goal) throw badRequest('Say what the delegated session should do');
  if (childBudget(parent) < 0.1) throw badRequest('Cannot delegate now: this session has no budget left for another session. Raise its budget first.');
  const id = newId('w_');
  const title = (task.title?.trim() || goal.split('\n')[0]).slice(0, 80);
  insert('workflows', {
    id,
    project_id: parent.project_id,
    title,
    goal: `${goal}\n\nThis task was delegated by the session "${parent.title}" (goal: ${String(parent.goal).slice(0, 300)}). Do only this task, and say in your summary what you changed and verified.`,
    status: 'running',
    stop_reason: '',
    repo_id: parent.repo_id,
    branch: parent.branch,
    repos: parent.repos,
    model: parent.model,
    // A delegated session spends from its parent's budget: what the parent has left, less what its other running
    // delegated sessions may still spend. Copying the parent's whole budget let a $5 session start three $5 children.
    budget_usd: childBudget(parent),
    budget_credits: parent.budget_credits,
    max_iterations: parent.max_iterations,
    verify_command: parent.verify_command,
    rules: parent.rules,
    iteration: 0,
    burst_start: 0,
    spent_usd: 0,
    spent_credits: 0,
    work_branch: '',
    lead_agent: '',
    jira_key: parent.jira_key,
    jira_summary: parent.jira_summary,
    jira_url: parent.jira_url,
    summary: '',
    workspace_id: parent.workspace_id,
    engine: parent.engine,
    integrations: parent.integrations,
    parent_id: parent.id,
    depth: Number(parent.depth) + 1,
    seen_by_parent: 1,
    push_mode: parent.push_mode,
    playground: parent.playground,
    trust_tools: parent.trust_tools,
    created_by: parent.created_by,
    created_at: now(),
    updated_at: now(),
  });
  log(id, 'system', `Delegated by ${by.name} from the session "${parent.title}"`);
  log(parent.id, 'delegate', `${by.name} handed "${title}" to a separate session`, { data: { childId: id, by: by.name } });
  kick(id);
  return getWorkflow(id);
}

/** A delegated session stopped: tell its parent, and let a parent that was waiting for it carry on. */
export function childStopped(id: string): void {
  const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
  if (!w?.parent_id) return;
  const parent = one<Row>('SELECT * FROM workflows WHERE id = ?', w.parent_id);
  if (!parent) return;
  exec('UPDATE workflows SET seen_by_parent = 0 WHERE id = ?', id);
  const what = w.status === 'done' ? 'finished' : w.status;
  log(parent.id, 'delegate', `Delegated session "${w.title}" ${what}: ${String(w.summary || w.stop_reason || '').slice(0, 400)}`, { data: { childId: id, status: w.status } });
  if (parent.status === 'paused' && parent.waiting_children && !runningChildren(parent.id) && !overBudget(parent)) {
    patch(parent.id, { status: 'running', stop_reason: '', waiting_children: 0, burst_start: parent.iteration });
    log(parent.id, 'status', 'Its delegated sessions have stopped; it carries on to bring their work together.');
    kick(parent.id);
  }
}

export function registerDelegationRoutes(): void {
  // A person hands a task of this session to a separate session.
  post('/api/workflows/:id/delegate', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    const child = createChild(w, { title: str(body.title, 'Title', { max: 80, optional: true }), goal: str(body.goal, 'Task', { max: 6000 }) }, { id: ctx.user!.id, name: ctx.user!.name });
    return { workflow: view(child) };
  });
}
