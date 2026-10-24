/** The JSON shape of a session, as the list and the workspace show it. */
import { all, one, type Row } from '../db.ts';
import { parseJson } from '../util.ts';
import { claudeProvider, effectiveProvider, engineProvider } from '../project-aws.ts';
import { pendingEngineSwitch } from './engine-switch.ts';

/** Live facts for the session list: the latest run's state and how many of its questions or approvals wait. */
function liveFacts(w: Row) {
  if (!w.last_run_id) return { last_run_status: null, pending_inputs: 0 };
  const r = one<Row>(
    "SELECT status, (SELECT COUNT(*) FROM inputs WHERE run_id = agent_runs.id AND status = 'pending') AS pending FROM agent_runs WHERE id = ?",
    w.last_run_id,
  );
  return { last_run_status: r?.status ?? null, pending_inputs: Number(r?.pending ?? 0) };
}

const contextCount = (id: string) => Number(one<Row>('SELECT COUNT(*) AS n FROM workflow_context WHERE workflow_id = ?', id)?.n ?? 0);

/** The session's repositories: the repos column, or the single repo_id / branch of sessions made before it. */
export function sessionRepos(w: Row): { repoId: string; branch: string | null }[] {
  const list = parseJson<{ repoId: string; branch: string | null }[]>(w.repos, []);
  if (list.length) return list;
  return w.repo_id ? [{ repoId: w.repo_id, branch: w.branch }] : [];
}

/** Repository names for the UI; a repository removed from the project since shows as such. */
export function reposView(w: Row) {
  return sessionRepos(w).map((x) => {
    const r = one<Row>('SELECT name, default_branch FROM repos WHERE id = ?', x.repoId);
    return { repoId: x.repoId, name: r?.name ?? '(removed repository)', branch: x.branch || r?.default_branch || '' };
  });
}

export function view(w: Row) {
  return {
    ...liveFacts(w),
    context_count: contextCount(w.id),
    id: w.id,
    project_id: w.project_id,
    title: w.title,
    goal: w.goal,
    status: w.status,
    stop_reason: w.stop_reason,
    repo_id: w.repo_id,
    branch: w.branch,
    repos: reposView(w),
    workspace: w.workspace_id ? (one<Row>('SELECT id, name FROM workspaces WHERE id = ?', w.workspace_id) ?? null) : null,
    parent: w.parent_id ? (one<Row>('SELECT id, title, status FROM workflows WHERE id = ?', w.parent_id) ?? null) : null,
    children: all<Row>('SELECT id, title, status, summary FROM workflows WHERE parent_id = ? ORDER BY created_at', w.id),
    depth: Number(w.depth ?? 0),
    waiting_children: Boolean(w.waiting_children),
    push_mode: w.push_mode || 'never',
    pending_push: w.pending_push ? parseJson<any>(w.pending_push, null) : null,
    engine_switch: (() => {
      const e = w.status === 'paused' ? pendingEngineSwitch(w.id) : null;
      return e ? { reason: String(e.body), since: String(e.created_at), claudeReady: Boolean(claudeProvider(w.project_id)) } : null;
    })(),
    integrations: parseJson<string[]>(w.integrations, []),
    integration_list: parseJson<string[]>(w.integrations, []).map((id) => one<Row>('SELECT id, name, kind, allow_writes FROM integrations WHERE id = ?', id) ?? { id, name: '(removed integration)', kind: '', allow_writes: 0 }),
    model: w.model,
    budget_usd: w.budget_usd,
    budget_credits: w.budget_credits,
    spent_credits: w.spent_credits,
    engine: w.engine || '',
    provider: (() => {
      try {
        return engineProvider(w.project_id, w.engine || null);
      } catch {
        return effectiveProvider(w.project_id);
      }
    })(),
    max_iterations: w.max_iterations,
    single_run: Number(w.max_iterations) === 1,
    permission_mode: w.permission_mode || '',
    verify_command: w.verify_command,
    rules: w.rules,
    iteration: w.iteration,
    burst_start: w.burst_start,
    spent_usd: w.spent_usd,
    last_run_id: w.last_run_id,
    work_branch: w.work_branch,
    lead_agent: w.lead_agent,
    jira_key: w.jira_key,
    jira_summary: w.jira_summary,
    jira_url: w.jira_url,
    summary: w.summary,
    created_at: w.created_at,
    updated_at: w.updated_at,
    playground: Boolean(w.playground),
    trust_tools: Boolean(w.trust_tools),
    loop_spec_id: w.loop_spec_id ?? null,
    planning_gate: Boolean(w.planning_gate),
    queue_reason: w.queue_reason || '',
    queued_at: w.queued_at || null,
  };
}
