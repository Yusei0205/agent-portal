/**
 * Autonomous workflow sessions.
 *
 * A session is a saved goal that the portal drives on its own: it starts an agent run, waits for it, runs the team's
 * check command, feeds the result into the next run (which resumes the previous run's conversation and working copy),
 * and repeats until the agent reports done or blocked, or a limit is hit. People review the changes and give new
 * instructions at any time; those are picked up by the next iteration and re-open a finished session.
 *
 * Limits that keep an unattended loop safe: a spending budget, a cap on iterations per burst, a stop when the agent
 * keeps reporting the same thing, two failed runs in a row, and blocked commands (see guardrails.ts).
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { all, insert, one, run as exec, update, type Row } from './db.ts';
import { del, get, post, put } from './http.ts';
import { getProject, notifyProject, projectDir, requireProject } from './projects.ts';
import { getRepo } from './repos.ts';
import { checkKey, issueDetail, mustMapping } from './jira.ts';
import { requireModel } from './models.ts';
import { ticketMarkdown } from './jira-text.ts';
import { getRun, isActive, startRun, stopRun } from './agent/runner.ts';
import { badRequest, newId, notFound, now, parseJson, str } from './util.ts';
import { composeIterationPrompt, composeLeadAppend, parseStatus, safeBranchName, stagnated } from './guardrails.ts';
import { listAgentFiles } from './builder.ts';
import { effectiveProvider } from './project-aws.ts';
import { addContext, contextForIteration, registerContextRoutes, removeContextFiles } from './session-context.ts';
import { readRepoChoices } from './runs.ts';

const OPEN = ['running'];
const REOPENABLE = ['done', 'blocked', 'paused', 'stopped', 'failed'];

/** Workflow ids with a driver loop in this process, and the run each is waiting on. */
const driving = new Map<string, { runId: string | null }>();

function getWorkflow(id: string): Row {
  const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
  if (!w) throw notFound();
  return w;
}

/** Live facts for the session list: the latest run's state and how many of its questions or approvals wait. */
function liveFacts(w: Row) {
  if (!w.last_run_id) return { last_run_status: null, pending_inputs: 0 };
  const r = one<Row>(
    "SELECT status, (SELECT COUNT(*) FROM inputs WHERE run_id = runs.id AND status = 'pending') AS pending FROM runs WHERE id = ?",
    w.last_run_id,
  );
  return { last_run_status: r?.status ?? null, pending_inputs: Number(r?.pending ?? 0) };
}

const contextCount = (id: string) => Number(one<Row>('SELECT COUNT(*) AS n FROM workflow_context WHERE workflow_id = ?', id)?.n ?? 0);

/** The session's repositories: the repos column, or the single repo_id / branch of sessions made before it. */
function sessionRepos(w: Row): { repoId: string; branch: string | null }[] {
  const list = parseJson<{ repoId: string; branch: string | null }[]>(w.repos, []);
  if (list.length) return list;
  return w.repo_id ? [{ repoId: w.repo_id, branch: w.branch }] : [];
}

/** Repository names for the UI; a repository removed from the project since shows as such. */
function reposView(w: Row) {
  return sessionRepos(w).map((x) => {
    const r = one<Row>('SELECT name, default_branch FROM repos WHERE id = ?', x.repoId);
    return { repoId: x.repoId, name: r?.name ?? '(removed repository)', branch: x.branch || r?.default_branch || '' };
  });
}

function view(w: Row) {
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
    model: w.model,
    budget_usd: w.budget_usd,
    budget_credits: w.budget_credits,
    spent_credits: w.spent_credits,
    provider: effectiveProvider(w.project_id),
    max_iterations: w.max_iterations,
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
  };
}

function patch(id: string, p: Record<string, string | number | null>): Row {
  update('workflows', id, { ...p, updated_at: now() });
  const w = getWorkflow(id);
  notifyProject(w.project_id, 'workflow.updated', view(w));
  return w;
}

function log(workflowId: string, kind: string, body: string, extra: { runId?: string | null; data?: unknown; consumed?: boolean } = {}): void {
  exec(
    'INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    workflowId,
    kind,
    extra.runId ?? null,
    body,
    JSON.stringify(extra.data ?? {}),
    extra.consumed ? 1 : 0,
    now(),
  );
  const w = getWorkflow(workflowId);
  notifyProject(w.project_id, 'workflow.updated', view(w));
}

/* ------------------------------------------------------------------ */
/* The check command                                                   */
/* ------------------------------------------------------------------ */

function runCheck(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // Only the basics of the environment: a check must not see the portal's keys.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(AWS_|ANTHROPIC_|PORTAL_|GITHUB_|GH_)/i.test(k)) env[k] = v;
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d: Buffer) => {
      out = (out + d.toString()).slice(-6000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      out += '\n[the check took longer than 5 minutes and was stopped]';
      child.kill();
    }, 5 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Could not start the check: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim().slice(-4000) });
    });
  });
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

function stopWith(id: string, status: 'done' | 'blocked' | 'failed' | 'paused' | 'stopped', reason: string): void {
  patch(id, { status, stop_reason: reason });
  log(id, 'status', reason ? `${status}: ${reason}` : status);
}

/**
 * Why a session may not start another iteration, or ''. Dollars and Kiro credits are capped separately: a project can
 * switch providers mid-session, and each budget only counts what was billed in its own unit.
 */
function overBudget(w: Row): string {
  if (w.spent_usd >= w.budget_usd) return `Reached the budget of $${Number(w.budget_usd).toFixed(2)}. Raise the budget to go on.`;
  if (w.budget_credits > 0 && w.spent_credits >= w.budget_credits) return `Reached the budget of ${w.budget_credits} Kiro credits (${Number(w.spent_credits).toFixed(2)} used). Raise the credit budget to go on.`;
  return '';
}

async function drive(id: string): Promise<void> {
  let failures = 0;
  let ticketWarned = false;
  let leadWarned = false;
  let lastCheck: { command: string; ok: boolean; output: string } | null = null;
  const summaries: string[] = [];
  for (;;) {
    let w = getWorkflow(id);
    if (w.status !== 'running') return;
    if (w.iteration - w.burst_start >= w.max_iterations) return stopWith(id, 'paused', `Reached ${w.max_iterations} iterations without finishing. Review it, then send an instruction or resume to go on.`);
    const over = overBudget(w);
    if (over) return stopWith(id, 'paused', over);

    // The ticket may have changed since the last iteration (new comments, a changed description).
    let ticket: { key: string; markdown: string } | null = null;
    if (w.jira_key) {
      try {
        ticket = { key: w.jira_key, markdown: ticketMarkdown(await issueDetail(w.project_id, mustMapping(w.project_id), w.jira_key)) };
      } catch (e: any) {
        if (!ticketWarned) log(id, 'status', `Could not read ${w.jira_key} from Jira, so this iteration goes on without it: ${String(e?.message ?? e).slice(0, 200)}`);
        ticketWarned = true;
      }
    }

    // Instructions people sent since the last iteration.
    const pending = all<Row>('SELECT id, body FROM workflow_events WHERE workflow_id = ? AND kind = ? AND consumed = 0 ORDER BY id', id, 'human');
    const iteration = w.iteration + 1;
    const prompt = composeIterationPrompt({
      title: w.title,
      goal: w.goal,
      rules: w.rules,
      progress: w.summary,
      instructions: pending.map((p) => String(p.body)),
      check: lastCheck,
      ticket,
      iteration: iteration - w.burst_start,
      maxIterations: w.max_iterations,
      budgetLeftUsd: w.budget_usd - w.spent_usd,
      hasRepo: Boolean(w.repo_id),
      repos: reposView(w).map((r) => ({ name: r.name, branch: r.branch })),
      workBranch: w.work_branch,
      baseBranch: w.repo_id ? w.branch || getRepo(w.repo_id).default_branch : '',
      context: contextForIteration(id),
    });
    for (const p of pending) exec('UPDATE workflow_events SET consumed = 1 WHERE id = ?', p.id);

    // A lead agent from the project's team plans and delegates; without one the default main agent decides.
    let systemAppend: string | undefined;
    if (w.lead_agent) {
      const team = listAgentFiles(getProject(w.project_id)).filter((a) => a.enabled);
      const lead = team.find((a) => a.name === w.lead_agent);
      if (lead) systemAppend = composeLeadAppend(lead, team);
      else if (!leadWarned) {
        log(id, 'status', `The lead agent "${w.lead_agent}" is not enabled in this project any more, so the default agent leads.`);
        leadWarned = true;
      }
    }

    let started;
    try {
      const prev = w.last_run_id ? getRun(w.last_run_id) : null;
      started = await startRun({
        projectId: w.project_id,
        userId: w.created_by,
        kind: 'chat',
        title: `${w.title} · iteration ${iteration}`,
        prompt,
        repoId: w.repo_id || null,
        branch: w.branch || null,
        repos: sessionRepos(w).length > 1 ? sessionRepos(w) : null,
        permissionMode: 'acceptEdits',
        autoApprove: true,
        model: w.model,
        resumeOf: prev && prev.session_id ? prev.id : null,
        systemAppend,
        meta: { workflowId: id, iteration, leadAgent: systemAppend ? w.lead_agent : '' },
      });
    } catch (e: any) {
      return stopWith(id, 'paused', String(e?.message ?? e).slice(0, 300));
    }
    const slot = driving.get(id);
    if (slot) slot.runId = started.run.id;
    patch(id, { iteration, last_run_id: started.run.id });
    log(id, 'iteration', `Iteration ${iteration} started`, { runId: started.run.id, data: { iteration, instructions: pending.length } });

    const finished = await started.done;
    if (slot) slot.runId = null;
    w = getWorkflow(id);
    patch(id, { spent_usd: w.spent_usd + (Number(finished.cost_usd) || 0), spent_credits: w.spent_credits + (Number(parseJson<any>(finished.meta, {}).kiroCredits) || 0) });
    w = getWorkflow(id);
    if (w.status !== 'running') {
      log(id, 'iteration', `Iteration ${iteration} ended (${finished.status}) after the session was ${w.status}`, { runId: finished.id });
      return;
    }

    if (finished.status !== 'completed') {
      failures++;
      log(id, 'iteration', `Iteration ${iteration} did not complete: ${finished.error || finished.status}`, { runId: finished.id, data: { failed: true } });
      if (failures >= 2) return stopWith(id, 'failed', `Two runs in a row failed: ${String(finished.error || finished.status).slice(0, 200)}`);
      continue;
    }
    failures = 0;

    const status = parseStatus(finished.result);
    const summary = status?.summary || String(finished.result ?? '').trim().slice(-600);
    log(id, 'iteration', summary || '(no summary)', { runId: finished.id, data: { iteration, state: status?.state ?? 'continue', next: status?.next ?? '', needs: status?.needs ?? '', reported: Boolean(status) } });
    if (summary) patch(id, { summary: summary.slice(0, 4000) });
    // The agent names the new branch once; after that the name is kept so every iteration and the push agree.
    if (w.repo_id && !w.work_branch && status?.branch) {
      // The new branch must not be the starting branch of any of the session's repositories.
      const bases = new Set(reposView(w).map((r) => r.branch.toLowerCase()));
      const name = safeBranchName(status.branch);
      if (name && !bases.has(name)) {
        patch(id, { work_branch: name });
        log(id, 'status', `The agents will push their changes to the new branch "${name}".`);
      } else {
        log(id, 'status', `The branch name "${status.branch}" cannot be used, so the agents are asked again next iteration.`);
      }
    }
    // Let the run carry the branch name, so its Push dialog offers it.
    {
      const cur = getWorkflow(id);
      const run = getRun(finished.id);
      const meta = parseJson<any>(run.meta, {});
      if (cur.work_branch && meta.workBranch !== cur.work_branch) exec('UPDATE runs SET meta = ? WHERE id = ?', JSON.stringify({ ...meta, workBranch: cur.work_branch }), run.id);
    }
    summaries.push(summary);

    // The team's own check decides what the agent's word is worth.
    lastCheck = null;
    if (w.verify_command.trim()) {
      const run = getRun(finished.id);
      // With several repositories the check runs in the run folder that holds all of their working copies.
      const pdir = projectDir(getProject(w.project_id));
      const workDir = parseJson<any>(run.meta, {}).workDir;
      const cwd = sessionRepos(w).length > 1 && workDir ? path.join(pdir, workDir) : run.worktree ? path.join(pdir, run.worktree) : pdir;
      const res = await runCheck(w.verify_command, cwd);
      lastCheck = { command: w.verify_command, ok: res.ok, output: res.output };
      log(id, 'check', res.ok ? 'Check passed' : 'Check failed', { runId: finished.id, data: { command: w.verify_command, ok: res.ok, output: res.output } });
    }

    w = getWorkflow(id);
    if (w.status !== 'running') return;
    if (status?.state === 'blocked') return stopWith(id, 'blocked', status.needs || status.summary || 'The agent needs a person.');
    if (status?.state === 'done') {
      if (lastCheck && !lastCheck.ok) {
        // Claimed done but the check disagrees: keep going with the check output in front of it.
        log(id, 'status', 'The agent reported done, but the check failed, so it goes on.');
      } else {
        return stopWith(id, 'done', 'The agent reports the goal is met. Review the changes.');
      }
    }
    if (stagnated(summaries)) return stopWith(id, 'blocked', 'The last iterations all reported the same thing, so it is not making progress. Give it a new instruction.');
  }
}

/** Start the loop for a session unless one is already running in this process. */
function kick(id: string): void {
  if (driving.has(id)) return;
  driving.set(id, { runId: null });
  drive(id)
    .catch((e) => {
      console.error(`[workflow ${id}]`, e);
      try {
        stopWith(id, 'failed', String(e?.message ?? e).slice(0, 300));
      } catch {
        /* the session may have been deleted */
      }
    })
    .finally(() => driving.delete(id));
}

/** After a restart nothing is driving any more; sessions that were running wait for someone to resume them. */
export function recoverWorkflows(): void {
  for (const w of all<Row>("SELECT id FROM workflows WHERE status = 'running'")) {
    exec("UPDATE workflows SET status = 'paused', stop_reason = 'The server restarted. Resume to go on.', updated_at = ? WHERE id = ?", now(), w.id);
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function readSettings(body: any, current?: Row) {
  const num = (v: unknown, name: string, min: number, max: number, fallback: number) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
    return n;
  };
  const model = body.model === undefined || body.model === '' ? current?.model ?? 'sonnet' : requireModel(body.model);
  return {
    model,
    budget_usd: num(body.budgetUsd, 'Budget', 0.1, 1000, current?.budget_usd ?? 5),
    budget_credits: num(body.budgetCredits, 'Credit budget', 0.1, 100000, current?.budget_credits ?? 20),
    max_iterations: Math.round(num(body.maxIterations, 'Iterations', 1, 50, current?.max_iterations ?? 8)),
    verify_command: body.verifyCommand === undefined ? current?.verify_command ?? '' : str(body.verifyCommand, 'Check command', { max: 500, optional: true }).trim(),
    rules: body.rules === undefined ? current?.rules ?? '' : str(body.rules, 'Rules', { max: 4000, optional: true }).trim(),
  };
}

/** The lead agent named in a request must be one of the project's enabled agents; empty means the default. */
function checkLead(project: ReturnType<typeof getProject>, raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return '';
  if (!listAgentFiles(project).some((a) => a.enabled && a.name === name)) throw badRequest(`"${name}" is not an enabled agent in this project. Add or enable it under Agents and skills.`);
  return name;
}

/**
 * Context items sent along with a new session or an instruction (documents, notes, links, earlier results; files are
 * uploaded separately). All are checked before anything is saved, so a bad item leaves nothing half-added.
 */
function readContextItems(raw: unknown): any[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Context must be a list');
  if (raw.length > 20) throw badRequest('Add at most 20 context items at once');
  return raw;
}

function addContextItems(workflowId: string, user: { id: string; name: string }, items: any[]): void {
  for (const item of items) {
    const c = addContext(workflowId, user, item);
    log(workflowId, 'context', `${user.name} added “${c.title}” as context`);
  }
}

export function registerWorkflowRoutes(): void {
  registerContextRoutes((workflowId, message) => log(workflowId, 'context', message));

  get('/api/projects/:pid/workflows', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { workflows: all<Row>('SELECT * FROM workflows WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100', project.id).map(view) };
  });

  post('/api/projects/:pid/workflows', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    let jira = { key: '', summary: '', url: '' };
    if (body.jiraKey) {
      const key = str(body.jiraKey, 'Jira key', { max: 30 }).trim().toUpperCase();
      const mapping = mustMapping(project.id);
      checkKey(mapping, key);
      const t = await issueDetail(project.id, mapping, key);
      jira = { key: t.key, summary: t.summary, url: t.url };
    }
    let goal = str(body.goal, 'Goal', { max: 6000, optional: Boolean(jira.key) }).trim();
    if (!goal && jira.key) goal = `Implement or fix what ticket ${jira.key} describes (${jira.summary}), following the project documents and decisions.`;
    const title = str(body.title, 'Title', { max: 120, optional: true }).trim() || (jira.key ? `${jira.key}: ${jira.summary}`.slice(0, 120) : goal.split('\n')[0].slice(0, 80));
    // Without a branch, a single repository keeps following its default branch, as before.
    const repos = readRepoChoices(project.id, body);
    const single = !Array.isArray(body.repos) && repos.length === 1;
    const repoId: string | null = repos[0]?.repoId ?? null;
    const s = readSettings(body);
    const leadAgent = checkLead(project, body.leadAgent);
    const contextItems = readContextItems(body.context);
    const id = newId('w_');
    insert('workflows', {
      id,
      project_id: project.id,
      title,
      goal,
      status: body.start === false ? 'paused' : 'running',
      stop_reason: body.start === false ? 'Not started yet. Press Resume to start.' : '',
      repo_id: repoId,
      branch: single ? str(body.branch, 'Branch', { max: 200, optional: true }).trim() || null : (repos[0]?.branch ?? null),
      repos: JSON.stringify(repos.length > 1 ? repos : []),
      ...s,
      iteration: 0,
      burst_start: 0,
      spent_usd: 0,
      spent_credits: 0,
      work_branch: '',
      lead_agent: leadAgent,
      jira_key: jira.key,
      jira_summary: jira.summary,
      jira_url: jira.url,
      summary: '',
      created_by: ctx.user!.id,
      created_at: now(),
      updated_at: now(),
    });
    log(id, 'system', `Session created by ${ctx.user!.name}`);
    try {
      addContextItems(id, { id: ctx.user!.id, name: ctx.user!.name }, contextItems);
    } catch (e) {
      // A bad context item must not leave a half-made session behind.
      exec('DELETE FROM workflows WHERE id = ?', id);
      throw e;
    }
    if (body.start !== false) kick(id);
    return { workflow: view(getWorkflow(id)) };
  });

  get('/api/workflows/:id', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id);
    const events = all<Row>('SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY id DESC LIMIT 300', w.id)
      .reverse()
      .map((e) => ({ id: e.id, kind: e.kind, run_id: e.run_id, body: e.body, data: parseJson(e.data, {}), consumed: Boolean(e.consumed), created_at: e.created_at }));
    const runs = all<Row>('SELECT id, title, status, cost_usd, created_at, finished_at FROM runs WHERE project_id = ? AND meta LIKE ? ORDER BY created_at DESC LIMIT 100', w.project_id, `%"workflowId":"${w.id}"%`);
    return { workflow: view(w), events, runs, driving: driving.has(w.id) };
  });

  put('/api/workflows/:id', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    const s = readSettings(body, w);
    const p: Record<string, string | number | null> = { ...s };
    if (body.leadAgent !== undefined) p.lead_agent = checkLead(getProject(w.project_id), body.leadAgent);
    if (body.title !== undefined) p.title = str(body.title, 'Title', { max: 120 }).trim();
    if (body.goal !== undefined) p.goal = str(body.goal, 'Goal', { max: 6000 }).trim();
    const out = patch(w.id, p);
    log(w.id, 'system', `Settings changed by ${ctx.user!.name}`);
    return { workflow: view(out) };
  });

  // Tell the session something. It is read at the next iteration, and a finished or stopped session starts again.
  post('/api/workflows/:id/messages', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    const text = str(body.body, 'Instruction', { max: 4000 }).trim();
    if (REOPENABLE.includes(w.status) && overBudget(w)) throw badRequest('This session has used its budget. Raise the budget first, then send the instruction.');
    addContextItems(w.id, { id: ctx.user!.id, name: ctx.user!.name }, readContextItems(body.context));
    log(w.id, 'human', text, { data: { by: ctx.user!.name } });
    if (REOPENABLE.includes(w.status)) {
      patch(w.id, { status: 'running', stop_reason: '', burst_start: w.iteration });
      kick(w.id);
    }
    return { workflow: view(getWorkflow(w.id)) };
  });

  post('/api/workflows/:id/resume', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (OPEN.includes(w.status) && driving.has(w.id)) return { workflow: view(w) };
    if (overBudget(w)) throw badRequest('This session has used its budget. Raise the budget first.');
    patch(w.id, { status: 'running', stop_reason: '', burst_start: w.iteration });
    log(w.id, 'status', 'Resumed');
    kick(w.id);
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Finish the current iteration, then wait.
  post('/api/workflows/:id/pause', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (w.status !== 'running') throw badRequest('This session is not running');
    stopWith(w.id, 'paused', 'Paused after the current iteration.');
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Stop now, including the run in progress.
  post('/api/workflows/:id/stop', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    stopWith(w.id, 'stopped', `Stopped by ${ctx.user!.name}.`);
    const runId = driving.get(w.id)?.runId ?? w.last_run_id;
    if (runId && isActive(runId)) stopRun(runId);
    return { workflow: view(getWorkflow(w.id)) };
  });

  del('/api/workflows/:id', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (w.status === 'running') throw badRequest('Stop the session first');
    exec('DELETE FROM workflows WHERE id = ?', w.id);
    removeContextFiles(w.project_id, w.id);
    notifyProject(w.project_id, 'workflow.deleted', { id: w.id });
    return { ok: true };
  });
}

