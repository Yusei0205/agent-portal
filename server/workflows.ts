/**
 * Autonomous workflow sessions.
 *
 * A session is a saved goal that the portal drives on its own: it starts an agent run, waits for it, runs the team's
 * check command, feeds the result into the next run (which resumes the previous run's conversation and working copy),
 * and repeats until the agent reports done or blocked, or a limit is hit. People review the changes and give new
 * instructions at any time; those are picked up by the next iteration and re-open a finished session.
 *
 * A single run is a session whose max_iterations is 1: one iteration, then it is done (or failed), with the agent's reply
 * as the result. It may be attended (permission_mode set): a person answers its questions and approves its tools. A
 * finished session re-opens when a person sends a message, which is how a single run is continued.
 *
 * Limits that keep an unattended loop safe: a spending budget, a cap on iterations per burst, a stop when the agent
 * keeps reporting the same thing, two failed runs in a row, and blocked commands (see guardrails.ts).
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { all, insert, one, run as exec, update, type Row, isDbOpen, dbGeneration } from './db.ts';
import { del, get, post, put, type Ctx } from './http.ts';
import { getProject, notifyProject, projectDir, requireProject } from './projects.ts';
import { ensureFresh, getRepo, repoGitEnv, pushWorktree, checkBranch, openPullRequest, repoDir } from './repos.ts';
import { checkKey, downloadAttachments, issueDetail, mustMapping } from './jira.ts';
import { requireModel } from './models.ts';
import { ticketMarkdown } from './jira-text.ts';
import { getRun, isActive, startRun, stopRun } from './agent/runner.ts';
import type { PermissionMode } from './agent/types.ts';
import { badRequest, HttpError, newId, notFound, now, parseJson, str } from './util.ts';
import { composeIterationPrompt, parseTrustedPush, parseStatus, safeBranchName, stagnated } from './guardrails.ts';
import { leadChoices, resolveLead, type RunLead } from './kiro-agents.ts';
import { claudeProvider, effectiveProvider, engineProvider } from './project-aws.ts';
import { addContext, contextForIteration, registerContextRoutes, removeContextFiles } from './session-context.ts';
import { pushRun, readRepoChoices, isSharedBranch } from './runs.ts';
import { checkDocOutput, composeDocumentPrompt } from './docrun.ts';
import { runRepos } from './agent/runner.ts';
import { getWorkspace, workspaceIntegrations, workspaceRepos } from './workspaces.ts';
import { readIntegrationIds } from './integrations.ts';
import { assertBudget, getSettings } from './settings.ts';
import { getToolPacks } from './tool-packs.ts';
import { git, redact } from './git.ts';
import { checkConcurrency, isDraining, concurrencyReason, queueReasonLabel, drainQueue } from './control-plane.ts';
import { audit, auditRaw } from './audit.ts';
import { getLoopSpec, type VerificationStep, type StopRules, type MemoryConfig, type EscalationConfig } from './loop-specs.ts';
import { runPipeline, formatPipelineForPrompt, persistPipelineResult, appendProgress, readProgressFile, deleteProgressFile, isPlanPending, shouldPlanFirst, type PipelineResult } from './loop-verification.ts';
import { escalateSession, fireWebhooks } from './loop-engine.ts';
import { recordLoopMetrics } from './loop-specs.ts';

const OPEN = ['running'];

/** Budget of a single run, whose follow-ups are held to it (a session's own default is $5). */
const SINGLE_RUN_BUDGET_USD = 25;
const REOPENABLE = ['done', 'blocked', 'paused', 'stopped', 'failed'];

/** Workflow ids with a driver loop in this process, and the run each is waiting on. */
const driving = new Map<string, { runId: string | null }>();

function getWorkflow(id: string): Row {
  const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
  if (!w) throw notFound();
  return w;
}

/** A single run is a session limited to one iteration. */
function isSingleRun(w: Row): boolean {
  return Number(w.max_iterations) === 1;
}

/** '' (autonomous: tools are allowed except the blocked commands) or a mode in which a person approves tools. */
function readPermissionMode(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (!['default', 'acceptEdits', 'plan'].includes(String(raw))) throw badRequest('Permission mode must be default, acceptEdits or plan');
  return String(raw);
}

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

/**
 * A Kiro session that cannot run never switches engine by itself (D-12): it pauses with the reason and an
 * "engine_switch" event stays open until a person accepts (the session continues on Claude Code) or declines (it stays
 * stopped). The event shows in the session workspace and in the Inbox.
 */
function askEngineSwitch(id: string, reason: string): void {
  const text = reason.slice(0, 400);
  stopWith(id, 'paused', `Kiro cannot run this session: ${text}`);
  if (!one<Row>("SELECT id FROM workflow_events WHERE workflow_id = ? AND kind = 'engine_switch' AND consumed = 0", id)) {
    log(id, 'engine_switch', text);
  }
}

function pendingEngineSwitch(workflowId: string): Row | null {
  return one<Row>("SELECT id, body, created_at FROM workflow_events WHERE workflow_id = ? AND kind = 'engine_switch' AND consumed = 0 ORDER BY id DESC", workflowId) ?? null;
}

export function closeEngineSwitch(workflowId: string): void {
  exec("UPDATE workflow_events SET consumed = 1 WHERE workflow_id = ? AND kind = 'engine_switch' AND consumed = 0", workflowId);
}

function stopWith(id: string, status: 'done' | 'blocked' | 'failed' | 'paused' | 'stopped', reason: string): void {
  const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
  patch(id, { status, stop_reason: reason });
  log(id, 'status', reason ? `${status}: ${reason}` : status);
  childStopped(id);

  // When a top-level session stops/finishes, drain the queue — start any waiting sessions.
  const terminal = ['done', 'blocked', 'failed', 'stopped'];
  if (w && !w.parent_id && terminal.includes(status)) {
    setImmediate(() => {
      try {
        const ids = drainQueue();
        for (const qid of ids) {
          kick(qid);
        }
      } catch {
        /* queue drain is best-effort */
      }
    });
  }

  // Record loop metrics when a session terminates (not just pauses).
  if (w && terminal.includes(status)) {
    const specId = w.loop_spec_id ? String(w.loop_spec_id) : null;
    const savedState = one<Row>('SELECT * FROM loop_run_states WHERE workflow_id = ?', id);
    const lastCheckData = savedState?.last_check ? parseJson<any>(savedState.last_check, null) : null;
    const verifPass = lastCheckData?.steps ? (lastCheckData.steps as any[]).filter((s: any) => s.ok && !s.advisory).length : 0;
    const verifFail = lastCheckData?.steps ? (lastCheckData.steps as any[]).filter((s: any) => !s.ok && !s.advisory).length : 0;
    const humanInputs = Number(one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workflow_events WHERE workflow_id = ? AND kind = 'human'", id,
    )?.n ?? 0);
    const hasPr = Boolean(one<Row>(
      "SELECT id FROM workflow_events WHERE workflow_id = ? AND kind = 'push' AND data LIKE '%\"pr\"%' LIMIT 1", id,
    ));
    recordLoopMetrics({
      workflowId: id,
      specId,
      projectId: String(w.project_id),
      terminalState: status,
      iterationsUsed: Number(w.iteration ?? 0),
      costUsd: Number(w.spent_usd ?? 0),
      verifStepsPass: verifPass,
      verifStepsFail: verifFail,
      stagnationHit: status === 'blocked' && String(reason).includes('same thing') ? 1 : 0,
      humanInputs,
      prOpened: hasPr ? 1 : 0,
      startedAt: String(w.created_at),
      finishedAt: now(),
    });

    // Escalation for blocked/failed sessions that have escalation configured.
    if ((status === 'blocked' || status === 'failed') && specId) {
      try {
        const spec = getLoopSpec(specId);
        const esc: EscalationConfig = spec.escalation;
        const shouldEsc = (status === 'blocked' && esc.onBlocked !== false) || (status === 'failed' && esc.onFail !== false);
        if (shouldEsc) {
          escalateSession(id, status === 'blocked' ? 'blocked' : 'failed', reason);
        }
      } catch { /* spec may have been deleted */ }
    } else if (status === 'blocked' || status === 'failed') {
      // Even without a spec, fire webhooks for blocked/failed
      fireWebhooks(String(w.project_id), status === 'failed' ? 'session.failed' : 'session.blocked', {
        workflowId: id, projectId: w.project_id, title: w.title, reason,
      });
    } else if (status === 'done') {
      fireWebhooks(String(w.project_id), 'session.done', {
        workflowId: id, projectId: w.project_id, title: w.title,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Delegated sessions                                                  */
/* ------------------------------------------------------------------ */

function childrenOf(id: string): Row[] {
  return all<Row>('SELECT id, title, status, summary, stop_reason, seen_by_parent FROM workflows WHERE parent_id = ? ORDER BY created_at', id);
}

function runningChildren(id: string): number {
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
    budget_usd: parent.budget_usd,
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
function childStopped(id: string): void {
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

/**
 * Why a session may not start another iteration, or ''. Dollars and Kiro credits are capped separately: a project can
 * switch providers mid-session, and each budget only counts what was billed in its own unit.
 */
function overBudget(w: Row): string {
  if (w.spent_usd >= w.budget_usd) return `Reached the budget of $${Number(w.budget_usd).toFixed(2)}. Raise the budget to go on.`;
  if (w.budget_credits > 0 && w.spent_credits >= w.budget_credits) return `Reached the budget of ${w.budget_credits} Kiro credits (${Number(w.spent_credits).toFixed(2)} used). Raise the credit budget to go on.`;
  return '';
}

async function drive(id: string, gen: number): Promise<void> {
  // --- Restore durable loop state from the database ---
  const savedState = one<Row>('SELECT * FROM loop_run_states WHERE workflow_id = ?', id);
  let failures = savedState ? Number(savedState.failures) : 0;
  let ticketWarned = false;
  let leadWarned = false;
  let lastCheck: { command: string; ok: boolean; output: string } | null = null;
  if (savedState?.last_check && savedState.last_check !== '{}' && savedState.last_check !== 'null') {
    const parsed = parseJson<{ command?: string; ok?: boolean; output?: string; steps?: unknown[] } | null>(savedState.last_check, null);
    // Support both old {command,ok,output} shape and new {steps,overall_ok} shape.
    if (parsed && (parsed.command !== undefined || (parsed as any).overall_ok !== undefined)) {
      if ((parsed as any).overall_ok !== undefined) {
        // New pipeline shape: adapt to legacy interface for the prompt composer.
        lastCheck = {
          command: ((parsed as any).steps as any[] ?? []).map((s: any) => s.step).join(', '),
          ok: Boolean((parsed as any).overall_ok),
          output: typeof (parsed as any).ran_at === 'string'
            ? `Pipeline result (${(parsed as any).ran_at}): ${(parsed as any).overall_ok ? 'PASS' : 'FAIL'}`
            : '',
        };
      } else {
        lastCheck = parsed as { command: string; ok: boolean; output: string };
      }
    }
  }
  const summaries: string[] = savedState?.summaries ? parseJson<string[]>(savedState.summaries, []) : [];
  const driveStartedAt = Date.now();

  /** Write current loop state to the database (called at the start of every iteration). */
  function persistLoopState(iteration: number): void {
    const ts = now();
    exec(
      `INSERT INTO loop_run_states (workflow_id, iteration, failures, last_check, summaries, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET
         iteration = excluded.iteration,
         failures  = excluded.failures,
         last_check = excluded.last_check,
         summaries = excluded.summaries,
         updated_at = excluded.updated_at`,
      id,
      iteration,
      failures,
      JSON.stringify(lastCheck),   // null → 'null'; object → '{...}'
      JSON.stringify(summaries.slice(-20)),
      ts,
    );
  }

  for (;;) {
    // If the database was swapped (another server started in the same process), exit silently.
    if (dbGeneration() !== gen) return;
    // If the database was closed (server shutting down), exit silently. The session will be recovered on the next start.
    if (!isDbOpen()) return;
    let w = getWorkflow(id);
    if (w.status !== 'running') return;
    if (w.iteration - w.burst_start >= w.max_iterations) return stopWith(id, 'paused', `Reached ${w.max_iterations} iterations without finishing. Review it, then send an instruction or resume to go on.`);
    const over = overBudget(w);
    if (over) return stopWith(id, 'paused', over);

    // Wall-clock stop rule from loop spec.
    {
      const specSnap = (() => {
        const s = one<Row>('SELECT spec_snapshot FROM loop_run_states WHERE workflow_id = ?', id);
        return s?.spec_snapshot ? parseJson<any>(s.spec_snapshot, {}) : {};
      })();
      const wallMins = Number(specSnap.stop_rules?.wallClockMinutes ?? 0);
      if (wallMins > 0 && (Date.now() - driveStartedAt) > wallMins * 60_000) {
        return stopWith(id, 'paused', `Reached the ${wallMins}-minute wall-clock limit. Resume to go on.`);
      }
    }

    // The ticket may have changed since the last iteration (new comments, a changed description).
    let ticket: { key: string; markdown: string } | null = null;
    if (w.jira_key) {
      try {
        // Attachments are downloaded once and kept, so later iterations only fetch new ones.
        ticket = { key: w.jira_key, markdown: ticketMarkdown(await downloadAttachments(w.project_id, await issueDetail(w.project_id, mustMapping(w.project_id), w.jira_key))) };
      } catch (e: any) {
        if (!ticketWarned) log(id, 'status', `Could not read ${w.jira_key} from Jira, so this iteration goes on without it: ${String(e?.message ?? e).slice(0, 200)}`);
        ticketWarned = true;
      }
    }

    // Instructions people sent since the last iteration.
    const pending = all<Row>('SELECT id, body FROM workflow_events WHERE workflow_id = ? AND kind = ? AND consumed = 0 ORDER BY id', id, 'human');
    const iteration = w.iteration + 1;
    // Persist loop state before starting the iteration (checkpoint).
    persistLoopState(iteration);
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
      pushMode: (w.push_mode || 'never') as 'never' | 'ask' | 'auto',
      trustTools: Boolean(w.trust_tools),
      attended: Boolean(w.permission_mode),
      single: isSingleRun(w),
      delegation: (() => {
        const kids = childrenOf(id);
        const d = getSettings().delegation;
        if (!d.enabled && !kids.length) return undefined;
        return {
          ...delegationRoom(w),
          children: kids.map((c) => ({ title: c.title, status: c.status === 'running' ? 'still working' : c.status, summary: c.summary || c.stop_reason || '', isNew: c.status !== 'running' && !c.seen_by_parent })),
          nudge: d.nudgeThreshold,
        };
      })(),
    });
    for (const p of pending) exec('UPDATE workflow_events SET consumed = 1 WHERE id = ?', p.id);
    exec("UPDATE workflows SET seen_by_parent = 1 WHERE parent_id = ? AND status != 'running'", id);

    // A lead agent from the project's team plans and delegates; without one the default main agent decides.
    // On Kiro a project Kiro agent leads with its own profile; a .claude agent's instructions become the system text,
    // which the runner words for the run's engine (Claude's Agent tool or Kiro's subagent tool).
    let lead: RunLead | undefined;
    if (w.lead_agent) {
      const onKiro = isKiro(w.project_id, w.engine);
      lead = resolveLead(getProject(w.project_id), w.lead_agent, onKiro) ?? undefined;
      if (!lead && onKiro) {
        const anyKiro = leadChoices(getProject(w.project_id), true).length > 0;
        return askEngineSwitch(id, anyKiro
          ? `the lead agent "${w.lead_agent}" is not an enabled Kiro agent in this project.`
          : `this project has no usable Kiro agent, and the lead agent "${w.lead_agent}" cannot run on Kiro.`);
      }
      if (!lead && !leadWarned) {
        log(id, 'status', `The lead agent "${w.lead_agent}" is not enabled in this project any more, so the default agent leads.`);
        leadWarned = true;
      }
    }

    let started;
    try {
      const prev = w.last_run_id ? getRun(w.last_run_id) : null;
      // If this session uses the Kiro engine, verify the kiro pack is available before starting.
      if (isKiro(w.project_id, w.engine)) {
        const packs = await getToolPacks();
        const kiroPack = packs.find((p) => p.id === 'kiro');
        if (kiroPack && kiroPack.status !== 'available') {
          return askEngineSwitch(w.id, `the Kiro CLI is not available (${kiroPack.reason}).`);
        }
      }
      // Continue the last run's conversation and working copies, unless the session's repositories changed since.
      const repoIds = (list: { repoId: string }[]) => list.map((r) => r.repoId).sort().join(',');
      const sameRepos = prev ? repoIds(runRepos(prev).length ? runRepos(prev) : prev.repo_id ? [{ repoId: String(prev.repo_id) }] : []) === repoIds(sessionRepos(w)) : false;
      started = await startRun({
        projectId: w.project_id,
        userId: w.created_by,
        kind: 'chat',
        title: isSingleRun(w) && iteration === 1 ? w.title : `${w.title} · iteration ${iteration}`,
        prompt,
        repoId: w.repo_id || null,
        branch: w.branch || null,
        repos: sessionRepos(w).length > 1 ? sessionRepos(w) : null,
        integrations: parseJson<string[]>(w.integrations, []),
        engine: w.engine || null,
        workflowId: id,
        permissionMode: (w.permission_mode || 'acceptEdits') as PermissionMode,
        autoApprove: !w.permission_mode,
        trustTools: Boolean(w.trust_tools),
        trustedPushHandler: w.trust_tools ? (branch) => performTrustedPush(id, branch) : undefined,
        model: w.model,
        resumeOf: prev && prev.session_id && sameRepos ? prev.id : null,
        lead,
        meta: { iteration, leadAgent: lead ? w.lead_agent : '', ...(w.jira_key ? { jiraKey: w.jira_key, jiraUrl: w.jira_url, jiraSummary: w.jira_summary } : {}) },
      });
    } catch (e: any) {
      if (isKiro(w.project_id, w.engine)) return askEngineSwitch(id, `the Kiro run could not start: ${String(e?.message ?? e)}`);
      return stopWith(id, 'paused', String(e?.message ?? e).slice(0, 300));
    }
    closeEngineSwitch(id);
    // If the bookkeeping below throws (the database closed on shutdown), the run's own promise must not go unhandled.
    started.done.catch(() => undefined);
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
      if (isKiro(w.project_id, w.engine)) {
        log(id, 'iteration', `Iteration ${iteration} did not complete: ${finished.error || finished.status}`, { runId: finished.id, data: { failed: true } });
        return askEngineSwitch(id, `the Kiro run failed: ${String(finished.error || finished.status)}`);
      }
      if (isSingleRun(w)) return stopWith(id, 'failed', String(finished.error || finished.status).slice(0, 300));
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
      if (cur.work_branch && meta.workBranch !== cur.work_branch) exec('UPDATE agent_runs SET meta = ? WHERE id = ?', JSON.stringify({ ...meta, workBranch: cur.work_branch }), run.id);
    }
    summaries.push(summary);

    // Tasks the agent handed to separate sessions start now, within the limits; refusals go into the history.
    for (const task of status?.delegate ?? []) {
      try {
        createChild(getWorkflow(id), task, { id: w.created_by, name: 'The agents' });
      } catch (e: any) {
        log(id, 'status', `Could not delegate "${task.title || task.goal.slice(0, 60)}": ${String(e?.message ?? e).replace(/^Cannot delegate now: /, '')}`);
        break;
      }
    }

    // The team's own check decides what the agent's word is worth.
    // Sessions started from a loop spec use the spec's verification pipeline.
    // Sessions without a spec fall back to the single verify_command (backward compat).
    lastCheck = null;
    {
      const runRow = getRun(finished.id);
      const pdir = projectDir(getProject(w.project_id));
      const workDir = parseJson<any>(runRow.meta, {}).workDir;
      const cwd = sessionRepos(w).length > 1 && workDir ? path.join(pdir, workDir) : runRow.worktree ? path.join(pdir, runRow.worktree) : pdir;

      // Resolve verification pipeline: from spec snapshot first, then fallback to verify_command.
      const savedStateRow = one<Row>('SELECT spec_snapshot FROM loop_run_states WHERE workflow_id = ?', id);
      const specSnap = savedStateRow?.spec_snapshot ? parseJson<any>(savedStateRow.spec_snapshot, {}) : {};
      const verificationSteps: VerificationStep[] = specSnap.verification?.length
        ? specSnap.verification
        : w.verify_command?.trim()
          ? [{ step: 'verify', cmd: w.verify_command, timeout: 300, required: true, kind: 'cmd' }]
          : [];

      if (verificationSteps.length) {
        const pipelineResult = await runPipeline(verificationSteps, cwd, summary);
        persistPipelineResult(id, pipelineResult);
        lastCheck = {
          command: verificationSteps.map((s) => s.step).join(', '),
          ok: pipelineResult.overall_ok,
          output: formatPipelineForPrompt(pipelineResult),
        };
        const passCount = pipelineResult.steps.filter((s) => s.ok && !s.advisory).length;
        const failCount = pipelineResult.steps.filter((s) => !s.ok && !s.advisory).length;
        log(id, 'check', pipelineResult.overall_ok ? `Pipeline passed (${passCount} steps)` : `Pipeline failed (${failCount} step(s))`, {
          runId: finished.id,
          data: {
            ok: pipelineResult.overall_ok,
            output: lastCheck.output,
            overall_ok: pipelineResult.overall_ok,
            steps: pipelineResult.steps.map((s) => ({ step: s.step, ok: s.ok, advisory: Boolean(s.advisory) })),
            command: lastCheck.command,
          },
        });
      }

      // Memory: append iteration summary to the per-session progress file if configured.
      if (summary && specSnap.memory_config?.progressFile !== false) {
        try { appendProgress(w.project_id, id, summary, iteration, specSnap.memory_config?.maxEntries ?? 20); } catch { /* non-fatal */ }
      }

      // Planning gate: after the first iteration, pause and wait for a human to approve the plan.
      if (Boolean(w.planning_gate) && iteration === 1) {
        return stopWith(id, 'paused', 'Plan ready for approval. Review the plan in the session history and approve to continue.');
      }
    }

    w = getWorkflow(id);
    if (w.status !== 'running') return;

    // The agents asked the portal to push: never, after a person approves, or at once, depending on the session.
    if (status?.push) {
      const mode = w.push_mode || 'never';
      // Auto-derive a branch name if the agents didn't name one yet.
      if (!w.work_branch) {
        const derived = deriveBranchName(w);
        patch(id, { work_branch: derived });
        log(id, 'status', `No branch name was given; using "${derived}".`);
        w = getWorkflow(id);
      }
      const why = pushBlocker(w, lastCheck);
      if (mode === 'never') {
        log(id, 'status', 'The agents asked to push, but agent pushes are off for this session. Push from the Changes tab, or allow agent pushes in its settings.');
      } else if (why) {
        log(id, 'status', `The agents asked to push, but it cannot happen now: ${why}.`);
      } else {
        const req: PushRequest = { message: status.push.message, pr: status.push.pr, ...(status.push.base ? { base: status.push.base } : {}), runId: finished.id, branch: w.work_branch, state: status.state, at: now() };
        if (mode === 'auto') {
          await pushForSession(w, req, 'The agents');
        } else {
          patch(id, { pending_push: JSON.stringify(req) });
          return stopWith(id, 'paused', `Waiting for you to allow pushing to "${w.work_branch}".`);
        }
      }
      w = getWorkflow(id);
      if (w.status !== 'running') return;
    }
    if (status?.state === 'blocked') return stopWith(id, 'blocked', status.needs || status.summary || 'The agent needs a person.');
    if (status?.state === 'done') {
      if (lastCheck && !lastCheck.ok) {
        // Claimed done but the check disagrees: keep going with the check output in front of it.
        log(id, 'status', 'The agent reported done, but the check failed, so it goes on.');
      } else {
        // Done, but tasks it delegated are still running: wait for them, then carry on to bring their work together.
        const waiting = runningChildren(id);
        if (waiting) {
          patch(id, { waiting_children: 1 });
          return stopWith(id, 'paused', `Waiting for ${waiting} delegated session${waiting === 1 ? '' : 's'} to finish; it carries on by itself when they do.`);
        }
        return stopWith(id, 'done', 'The agent reports the goal is met. Review the changes.');
      }
    }
    if (isSingleRun(w) && (!lastCheck || lastCheck.ok)) return stopWith(id, 'done', 'The run finished. Review the changes.');
    if (stagnated(summaries)) return stopWith(id, 'blocked', 'The last iterations all reported the same thing, so it is not making progress. Give it a new instruction.');
  }
}

/** Start the loop for a session unless one is already running in this process. Exported for loop-triggers.ts. */
export function kick(id: string): void {
  if (driving.has(id)) return;
  // Don't start new iterations in drain mode.
  if (isDraining()) {
    const w = one<Row>('SELECT status FROM workflows WHERE id = ?', id);
    if (w?.status === 'running') {
      exec('UPDATE workflows SET status = ?, stop_reason = ?, updated_at = ? WHERE id = ?', 'paused', 'The server is shutting down. Resume to go on.', now(), id);
    }
    return;
  }
  const gen = dbGeneration();
  driving.set(id, { runId: null });
  drive(id, gen)
    .catch((e) => {
      // Suppress DB-closed errors: they happen when the server is shut down while a session is still running.
      // The session will be recovered on the next startup via recoverWorkflows().
      if (!isDbOpen() || dbGeneration() !== gen) return;
      console.error(`[workflow ${id}]`, e);
      try {
        stopWith(id, 'failed', String(e?.message ?? e).slice(0, 300));
      } catch {
        /* the session may have been deleted */
      }
    })
    .finally(() => driving.delete(id));
}

/** True if any session is actively running a drive() loop in this process. */
export function anyDriving(): boolean {
  return driving.size > 0;
}

const RESTART_REASON = 'The server restarted. Resume to go on.';
const INTERRUPTED_REASON = 'Interrupted mid-iteration by a server restart.';

/** After a restart nothing is driving any more: sessions that were running are paused. Returns their ids. */
export function recoverWorkflows(): string[] {
  const ids = all<Row>("SELECT id FROM workflows WHERE status = 'running'").map((w) => String(w.id));
  for (const id of ids) {
    // Check if this session was in the middle of an iteration when it was interrupted.
    const savedState = one<Row>('SELECT iteration FROM loop_run_states WHERE workflow_id = ?', id);
    const w = one<Row>('SELECT iteration FROM workflows WHERE id = ?', id);
    const wasInIteration = savedState && w && Number(savedState.iteration) > Number(w.iteration);
    const reason = wasInIteration ? INTERRUPTED_REASON : RESTART_REASON;
    exec('UPDATE workflows SET status = ?, stop_reason = ?, updated_at = ? WHERE id = ?', 'paused', reason, now(), id);
    // If it was interrupted mid-iteration, record the fact in workflow_events so the history is clear.
    if (wasInIteration) {
      exec(
        "INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, 'status', NULL, ?, '{}', 0, ?)",
        id,
        `Iteration ${savedState.iteration} was interrupted by a server restart. It will run again from the last checkpoint when resumed.`,
        now(),
      );
    }
  }
  return ids;
}

/**
 * Start again the sessions a restart paused (Settings › Agent defaults decides whether this happens). A session that
 * someone changed in the meantime, or that has used its budget, stays paused. Each continues where it was: the next
 * iteration resumes the conversation and the working copy of its last run, with its iteration count unchanged.
 * The durable loop state (failures, summaries, lastCheck) is restored from loop_run_states.
 */
export function resumeAfterRestart(ids: string[]): number {
  let n = 0;
  for (const id of ids) {
    const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
    if (!w || w.status !== 'paused') continue;
    if (w.stop_reason !== RESTART_REASON && w.stop_reason !== INTERRUPTED_REASON) continue;
    if (overBudget(w)) continue;
    patch(id, { status: 'running', stop_reason: '' });
    log(id, 'status', 'The server restarted; the session carries on by itself where it left off.');
    kick(id);
    n++;
  }
  // On restart, also check if any queued sessions can now start (drain mode may have lifted, or capacity available).
  try {
    const started = drainQueue();
    for (const qid of started) kick(qid);
    n += started.length;
  } catch {
    /* best-effort */
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function readSettings(body: any, current?: Row, ctx?: { hasRepos?: boolean; isPlayground?: boolean }) {
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
    push_mode: effectivePushMode(body.pushMode, current?.push_mode, ctx?.hasRepos ?? false, ctx?.isPlayground ?? false),
    trust_tools: body.trustTools === undefined ? (current?.trust_tools ?? 0) : body.trustTools ? 1 : 0,
    permission_mode: body.permissionMode === undefined ? current?.permission_mode ?? '' : readPermissionMode(body.permissionMode),
  };
}

function readPushMode(raw: unknown, current?: string): string {
  if (raw === undefined || raw === null || raw === '') return current || getSettings().agents.defaultPushMode || 'never';
  if (!['never', 'ask', 'auto'].includes(String(raw))) throw badRequest('Agent pushes must be never, ask or auto');
  return String(raw);
}

/**
 * Determine the push mode for a new or updated session.
 * - Explicit values always win if valid.
 * - Playground sessions without an explicit value stay 'never'.
 * - On update (current defined): keep the current value exactly — never escalate.
 * - On create (current undefined): use settings default; else 'ask' if repos; else 'never'.
 */
function effectivePushMode(raw: unknown, current: string | undefined, hasRepos: boolean, isPlayground: boolean): string {
  const explicit = raw !== undefined && raw !== null && raw !== '';
  if (explicit) {
    if (!['never', 'ask', 'auto'].includes(String(raw))) throw badRequest('Agent pushes must be never, ask or auto');
    return String(raw);
  }
  // No explicit value: playground sessions stay never.
  if (isPlayground) return 'never';
  // On update (current is the existing stored value): keep it exactly — never escalate.
  if (current !== undefined) return current || 'never';
  // On create: use settings default, then repo-presence heuristic.
  const settingsDefault = getSettings().agents.defaultPushMode;
  if (settingsDefault) return settingsDefault;
  return hasRepos ? 'ask' : 'never';
}

/* ------------------------------------------------------------------ */
/* Agent pushes                                                        */
/* ------------------------------------------------------------------ */

interface PushRequest {
  message: string;
  pr: boolean;
  /** The branch the pull request goes into, when the agents named one; otherwise each repository's starting branch. */
  base?: string;
  runId: string;
  branch: string;
  /** What the agent reported with the request, so approving can finish a session that was done. */
  state: string;
  at: string;
}

/** Push every working copy of a session's run to its new branch; the results go into the history. */
async function pushForSession(w: Row, req: PushRequest, by: string) {
  const run = getRun(req.runId);
  const results: { repo: string; ok: boolean; commit?: string; pr?: string; repoId?: string; prNumber?: number; prError?: string; error?: string }[] = [];
  for (const x of runRepos(run)) {
    try {
      // A base the agents named only applies to repositories that have that branch; the others use their starting one.
      let base: string | undefined;
      if (req.pr && req.base) {
        const repo = getRepo(x.repoId);
        const ok = await git(['rev-parse', '--verify', '--quiet', `origin/${checkBranch(req.base)}`], { cwd: repoDir(repo) }).then(() => true, () => false);
        if (ok) base = req.base;
      }
      const r = await pushRun(run, { repoId: x.repoId, branch: req.branch, message: req.message || undefined, createPr: req.pr, base, agent: true });
      results.push({ repo: r.repoName, ok: true, commit: r.commit ?? undefined, pr: r.pr?.url, repoId: r.repoId, prNumber: r.pr?.number, ...(r.prError ? { prError: r.prError } : {}) });
    } catch (e: any) {
      results.push({ repo: x.name || getRepo(x.repoId).name, ok: false, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  const ok = results.filter((r) => r.ok);
  const prs = ok.filter((r) => r.pr);
  const prFailed = ok.filter((r) => r.prError);
  const body = ok.length
    ? `${by} pushed to "${req.branch}"${results.length > 1 ? ` in ${ok.length} of ${results.length} repositories` : ''}${prs.length ? ` and opened a pull request (${prs.map((r) => r.pr).join(', ')})` : ''}.${prFailed.length ? ` No pull request was opened in ${prFailed.map((r) => `${r.repo}: ${r.prError}`).join('; ')}` : ''}`
    : `Nothing was pushed to "${req.branch}": ${results.map((r) => r.error).join('; ')}`;
  log(w.id, 'push', body, { runId: req.runId, data: { branch: req.branch, by, results } });
  return { ok: ok.length > 0, results };
}

/** Why a push the agents asked for cannot happen now, or ''. */
function pushBlocker(w: Row, lastCheck: { ok: boolean } | null): string {
  if (!sessionRepos(w).length) return 'this session has no repository';
  if (lastCheck && !lastCheck.ok) return 'the check failed';
  return '';
}

/**
 * Called by the trusted-push handler when an agent runs `git push` in a trust_tools session.
 * Validates the branch, performs the push via pushRun, records a history event, and returns a
 * human-readable result string for the agent.
 */
async function performTrustedPush(workflowId: string, requestedBranch: string | null): Promise<string> {
  let w = getWorkflow(workflowId);
  // Must have a repository.
  const repos = sessionRepos(w);
  if (!repos.length) {
    return 'No repository is attached to this session. Attach one under session settings and push again.';
  }
  // Must have an active run.
  if (!w.last_run_id) throw new Error('No active run for this session');
  const run = getRun(w.last_run_id);

  // Resolve the branch name.
  let branch: string;
  if (!requestedBranch) {
    // Use session work_branch or derive one.
    if (!w.work_branch) {
      const derived = deriveBranchName(w);
      exec('UPDATE workflows SET work_branch = ?, updated_at = ? WHERE id = ?', derived, now(), w.id);
      w = getWorkflow(workflowId);
      branch = derived;
    } else {
      branch = w.work_branch;
    }
  } else {
    branch = requestedBranch;
  }

  // Validate: must not be a shared branch or the session's base branch.
  const repoRow = getRepo(repos[0].repoId);
  const baseBranch = repos[0].branch || repoRow.default_branch;
  if (branch === baseBranch || branch === repoRow.default_branch) {
    return `Push refused: "${branch}" is the base/default branch. The portal only pushes to a new branch. Use a name like agent/${branch}-changes or feature/my-task.`;
  }
  if (isSharedBranch(branch)) {
    return `Push refused: "${branch}" is a shared branch (main, develop, release, etc.). The portal never pushes to shared branches. Use a new branch name.`;
  }
  // Validate: not --force / --mirror / --delete / --tags (already handled by parseTrustedPush in the guard,
  // but double-check here since this can be called directly too).

  // Perform the push.
  const results: { repo: string; ok: boolean; commit?: string; error?: string }[] = [];
  for (const x of runRepos(run)) {
    try {
      // The agent of the running iteration asked for this push itself, so it does not wait for the run to end.
      const r = await pushRun(run, { repoId: x.repoId, branch, agent: true, duringRun: true });
      results.push({ repo: r.repoName, ok: true, commit: r.commit ?? undefined });
      // Update work_branch if not set.
      if (!w.work_branch) exec('UPDATE workflows SET work_branch = ?, updated_at = ? WHERE id = ?', branch, now(), workflowId);
    } catch (e: any) {
      results.push({ repo: x.name || getRepo(x.repoId).name, ok: false, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  const ok = results.filter((r) => r.ok);
  const body = ok.length
    ? `Agent pushed to "${branch}"${results.length > 1 ? ` in ${ok.length} of ${results.length} repositories` : ''}${ok[0]?.commit ? ` (${ok[0].commit.slice(0, 7)})` : ''}.`
    : `Agent push to "${branch}" failed: ${results.map((r) => r.error).join('; ')}`;
  log(workflowId, 'push', body, { runId: w.last_run_id, data: { branch, by: 'agent (trusted)', results } });
  if (ok.length) {
    return `Pushed to "${branch}"${ok[0]?.commit ? ` (${ok[0].commit.slice(0, 7)})` : ''}. The push was performed by the portal with stored credentials.`;
  }
  throw new Error(results.map((r) => r.error).filter(Boolean).join('; ') || 'Push failed');
}

/**
 * Derive a branch name from the session's Jira key or title when work_branch is empty.
 * Format: agent/<jira key lowercased, else slug of the title, max 40 chars>-<last 6 of session id>
 */
function deriveBranchName(w: Row): string {
  const suffix = w.id.slice(-6).toLowerCase();
  if (w.jira_key) {
    return `agent/${w.jira_key.toLowerCase()}-${suffix}`;
  }
  const slug = String(w.title || w.goal)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `agent/${slug || 'task'}-${suffix}`;
}

/** True when a session on this engine runs on Kiro. */
function isKiro(projectId: string, engine: string | null | undefined): boolean {
  try {
    return engineProvider(projectId, engine || null) === 'kiro';
  } catch {
    return false;
  }
}

/**
 * The lead agent named in a request must be able to lead on the session's engine: one of the project's enabled Kiro
 * agents on Kiro, one of its enabled .claude agents on Claude. Empty means the default.
 */
function checkLead(project: ReturnType<typeof getProject>, raw: unknown, engine?: string | null): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return '';
  const kiro = isKiro(project.id, engine);
  const choices = leadChoices(project, kiro);
  if (!choices.some((c) => c.name === name)) {
    throw badRequest(
      kiro
        ? `"${name}" is not an enabled Kiro agent in this project. Add or enable it under Agents and skills › Kiro.`
        : `"${name}" is not an enabled agent in this project. Add or enable it under Agents and skills.`,
    );
  }
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

/** '' (the project's connection), 'claude' or 'kiro'; checked to be usable now. */
export function readEngine(projectId: string, raw: unknown): string {
  const engine = raw === undefined || raw === null || raw === '' ? '' : String(raw);
  if (engine) engineProvider(projectId, engine);
  return engine;
}

/** Start a stopped session again: queued when the concurrency cap or a server drain says so, running otherwise. */
function resumeSession(w: Row, ctx: Ctx): void {
  if (!w.parent_id) {
    const reason = concurrencyReason(ctx.user!.id, w.project_id);
    if (reason) {
      const label = queueReasonLabel(reason);
      patch(w.id, { status: 'queued', queue_reason: reason, queued_at: now(), stop_reason: label });
      log(w.id, 'status', reason === 'drain' ? 'Queued during server drain.' : `Queued: ${label}`);
      audit(ctx, 'session.resume', `workflow:${w.id}`, { projectId: w.project_id, queued: true });
      return;
    }
  }
  patch(w.id, { status: 'running', stop_reason: '', queue_reason: '', queued_at: null, burst_start: w.iteration, waiting_children: 0, pending_push: '' });
  log(w.id, 'status', 'Resumed');
  audit(ctx, 'session.resume', `workflow:${w.id}`, { projectId: w.project_id });
  kick(w.id);
}

export function registerWorkflowRoutes(): void {
  // Which engines a project can run on, for the New dialog.
  get('/api/projects/:pid/engines', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { default: effectiveProvider(project.id), claude: claudeProvider(project.id), kiro: true, pushMode: getSettings().agents.defaultPushMode || 'never' };
  });

  registerContextRoutes((workflowId, message) => log(workflowId, 'context', message));

  get('/api/projects/:pid/workflows', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { workflows: all<Row>('SELECT * FROM workflows WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100', project.id).map(view) };
  });

  post('/api/projects/:pid/workflows', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    // A single run is a session with one iteration. Its text arrives as "prompt" (or "goal"); "Document a repository" is
    // a single run whose prompt is built here and which reads the repository's reference clone in place.
    const singleRun = Boolean(body.singleRun);
    let docTitle = '';
    if (singleRun) {
      if (body.document) {
        const docRepo = getRepo(String(body.document.repoId ?? ''));
        if (docRepo.project_id !== project.id) throw badRequest('That repository belongs to another project');
        await ensureFresh(docRepo);
        const scope = str(body.document.scope, 'Focus', { max: 1000, optional: true });
        body.goal = composeDocumentPrompt(getRepo(docRepo.id), { scope, output: checkDocOutput(body.document.output ?? 'markdown') });
        docTitle = `Document ${docRepo.name}`;
        body.repoId = undefined;
        body.repos = undefined;
        body.workspaceId = undefined;
      } else if (body.goal === undefined) {
        body.goal = body.prompt;
      }
      body.playground = !body.workspaceId && !readRepoChoices(project.id, body).length;
      body.maxIterations = 1;
      if (body.pushMode === undefined) body.pushMode = 'never';
      if (body.budgetUsd === undefined) body.budgetUsd = SINGLE_RUN_BUDGET_USD;
      if (body.permissionMode === undefined || body.permissionMode === '') body.permissionMode = getSettings().agents.defaultPermissionMode;
    }
    let jira = { key: '', summary: '', url: '' };
    if (body.jiraKey) {
      const key = str(body.jiraKey, 'Jira key', { max: 30 }).trim().toUpperCase();
      const mapping = mustMapping(project.id);
      checkKey(mapping, key);
      const t = await issueDetail(project.id, mapping, key);
      jira = { key: t.key, summary: t.summary, url: t.url };
    }
    let goal = str(body.goal, singleRun ? 'Prompt' : 'Goal', { max: singleRun ? 50_000 : 6000, optional: Boolean(jira.key) }).trim();
    if (!goal && jira.key) goal = `Implement or fix what ticket ${jira.key} describes (${jira.summary}), following the project documents and decisions.`;
    if (!goal) throw badRequest(singleRun ? 'Describe what the agent should do' : 'Goal is required');
    const title = str(body.title, 'Title', { max: 120, optional: true }).trim() || docTitle || (jira.key ? `${jira.key}: ${jira.summary}`.slice(0, 120) : goal.split('\n')[0].slice(0, singleRun ? 100 : 80));
    // A workspace fills in the repositories (and integrations) unless the request lists its own.
    let workspace: Row | null = null;
    if (body.workspaceId) {
      workspace = getWorkspace(String(body.workspaceId));
      if (workspace.project_id !== project.id) throw badRequest('That workspace belongs to another project');
      if (!Array.isArray(body.repos) && !body.repoId) body.repos = workspaceRepos(workspace);
      if (!Array.isArray(body.integrations)) body.integrations = workspaceIntegrations(workspace);
    }
    const integrationIds = readIntegrationIds(body.integrations, ctx.user!.id);
    const engine = readEngine(project.id, body.engine);
    // Without a branch, a single repository keeps following its default branch, as before.
    const repos = readRepoChoices(project.id, body);
    const single = !Array.isArray(body.repos) && repos.length === 1;
    const repoId: string | null = repos[0]?.repoId ?? null;
    const playground = Boolean(body.playground);
    // A session must have a repository, a workspace, or be explicitly marked as a playground.
    if (!repoId && !workspace && !playground) {
      throw badRequest('Pick a repository or workspace, or start it as a playground with no repository.');
    }
    // Concurrency cap: queue instead of rejecting (when start=false, skip — it starts paused anyway).
    let queued = false;
    let queueReason = '';
    if (body.start !== false) {
      const reason = concurrencyReason(ctx.user!.id, project.id);
      if (reason && reason !== 'drain') {
        queued = true;
        queueReason = reason;
      } else if (reason === 'drain') {
        // During drain, still create as queued (held until drain lifts)
        queued = true;
        queueReason = reason;
      }
    }
    // A single run is refused up front when the monthly budget is used up (a session is created and pauses instead).
    if (singleRun && !queued && body.start !== false) assertBudget(engineProvider(project.id, engine || null));
    const s = readSettings(body, undefined, { hasRepos: repos.length > 0, isPlayground: playground });
    const leadAgent = checkLead(project, body.leadAgent, engine);
    const contextItems = readContextItems(body.context);
    // Check pack availability BEFORE writing anything: a missing required pack returns 400 cleanly.
    if (!queued && body.start !== false && isKiro(project.id, engine)) {
      const packs = await getToolPacks();
      const kiroPack = packs.find((p) => p.id === 'kiro');
      if (kiroPack && kiroPack.status !== 'available') {
        throw badRequest(kiroPack.hint);
      }
    }
    const id = newId('w_');
    insert('workflows', {
      id,
      project_id: project.id,
      title,
      goal,
      status: queued ? 'queued' : (body.start === false ? 'paused' : 'running'),
      stop_reason: queued ? queueReasonLabel(queueReason) : (body.start === false ? 'Not started yet. Press Resume to start.' : ''),
      queue_reason: queueReason,
      queued_at: queued ? now() : null,
      repo_id: repoId,
      branch: single ? str(body.branch, 'Branch', { max: 200, optional: true }).trim() || null : (repos[0]?.branch ?? null),
      repos: JSON.stringify(repos.length > 1 ? repos : []),
      workspace_id: workspace?.id ?? null,
      engine,
      integrations: JSON.stringify(integrationIds),
      playground: playground ? 1 : 0,
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
      loop_spec_id: body.loopSpecId ? String(body.loopSpecId) : null,
      planning_gate: body.planningGate ? 1 : (body.planning_gate ? 1 : 0),
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
    audit(ctx, 'session.start', `workflow:${id}`, { projectId: project.id, title, start: body.start !== false, ...(singleRun ? { singleRun: true } : {}) });
    if (!queued && body.start !== false) {
      kick(id);
    }
    return { workflow: view(getWorkflow(id)) };
  });

  get('/api/workflows/:id', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id);
    const events = all<Row>('SELECT * FROM workflow_events WHERE workflow_id = ? ORDER BY id DESC LIMIT 300', w.id)
      .reverse()
      .map((e) => ({ id: e.id, kind: e.kind, run_id: e.run_id, body: e.body, data: parseJson(e.data, {}), consumed: Boolean(e.consumed), created_at: e.created_at }));
    const runs = all<Row>('SELECT id, title, status, cost_usd, created_at, finished_at FROM agent_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 100', w.id);
    return { workflow: view(w), events, runs, driving: driving.has(w.id) };
  });

  put('/api/workflows/:id', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    const s = readSettings(body, w, { hasRepos: sessionRepos(w).length > 0, isPlayground: Boolean(w.playground) });
    const p: Record<string, string | number | null> = { ...s };
    if (body.engine !== undefined) p.engine = readEngine(w.project_id, body.engine);
    if (body.leadAgent !== undefined) p.lead_agent = checkLead(getProject(w.project_id), body.leadAgent, p.engine === undefined ? w.engine : String(p.engine));
    if (body.integrations !== undefined) p.integrations = JSON.stringify(readIntegrationIds(body.integrations, ctx.user!.id));
    if (body.title !== undefined) p.title = str(body.title, 'Title', { max: 120 }).trim();
    if (body.goal !== undefined) p.goal = str(body.goal, 'Goal', { max: 6000 }).trim();
    // Repositories can be attached (or changed) later; the next iteration starts on fresh working copies of them.
    if (body.repos !== undefined || body.repoId !== undefined) {
      if (w.status === 'running' || driving.has(w.id)) throw badRequest('Stop or pause the session before changing its repositories');
      const repos = readRepoChoices(w.project_id, body);
      const single = !Array.isArray(body.repos) && repos.length === 1;
      p.repo_id = repos[0]?.repoId ?? null;
      p.branch = single ? str(body.branch, 'Branch', { max: 200, optional: true }).trim() || null : (repos[0]?.branch ?? null);
      p.repos = JSON.stringify(repos.length > 1 ? repos : []);
      if (JSON.stringify(sessionRepos({ ...w, ...p } as Row)) !== JSON.stringify(sessionRepos(w))) p.work_branch = '';
    }
    const out = patch(w.id, p);
    log(w.id, 'system', `Settings changed by ${ctx.user!.name}`);
    return { workflow: view(out) };
  });

  // A person allows the push the agents asked for: the portal pushes, then the session finishes or carries on.
  post('/api/workflows/:id/push/allow', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const req = w.pending_push ? parseJson<PushRequest | null>(w.pending_push, null) : null;
    if (!req) throw badRequest('This session is not waiting for a push');
    if (w.status === 'running' || driving.has(w.id)) throw badRequest('Wait for the current iteration to finish');
    const body = await ctx.json().catch(() => ({}));
    if (body.message) req.message = str(body.message, 'Commit message', { max: 500 });
    if (body.pr !== undefined) req.pr = Boolean(body.pr);
    exec("UPDATE workflows SET pending_push = '' WHERE id = ?", w.id);
    const out = await pushForSession(w, req, ctx.user!.name);
    if (req.state === 'done' && out.ok) {
      stopWith(w.id, 'done', `Pushed to "${req.branch}". The agents report the goal is met.`);
    } else {
      patch(w.id, { status: 'running', stop_reason: '', burst_start: w.iteration });
      kick(w.id);
    }
    return { workflow: view(getWorkflow(w.id)), push: out };
  });

  // A person declines it; the reason goes to the agents as an instruction and the session carries on.
  post('/api/workflows/:id/push/deny', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const req = w.pending_push ? parseJson<PushRequest | null>(w.pending_push, null) : null;
    if (!req) throw badRequest('This session is not waiting for a push');
    const reason = str((await ctx.json().catch(() => ({}))).reason, 'Reason', { max: 2000, optional: true }).trim();
    exec("UPDATE workflows SET pending_push = '' WHERE id = ?", w.id);
    log(w.id, 'human', `Do not push yet.${reason ? ` ${reason}` : ' Ask again only when told to.'}`, { data: { by: ctx.user!.name } });
    if (req.state === 'done' && !reason) {
      stopWith(w.id, 'done', `${ctx.user!.name} declined the push. The agents report the goal is met.`);
    } else {
      patch(w.id, { status: 'running', stop_reason: '', burst_start: w.iteration });
      kick(w.id);
    }
    return { workflow: view(getWorkflow(w.id)) };
  });

  // A person hands a task of this session to a separate session.
  post('/api/workflows/:id/delegate', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    const child = createChild(w, { title: str(body.title, 'Title', { max: 80, optional: true }), goal: str(body.goal, 'Task', { max: 6000 }) }, { id: ctx.user!.id, name: ctx.user!.name });
    return { workflow: view(child) };
  });

  // Tell the session something. It is read at the next iteration, and a finished or stopped session starts again.
  post('/api/workflows/:id/messages', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    const text = str(body.body, 'Instruction', { max: 4000 }).trim();
    if (REOPENABLE.includes(w.status) && overBudget(w)) throw badRequest('This session has used its budget. Raise the budget first, then send the instruction.');
    const permissionMode = body.permissionMode === undefined ? undefined : readPermissionMode(body.permissionMode);
    addContextItems(w.id, { id: ctx.user!.id, name: ctx.user!.name }, readContextItems(body.context));
    if (permissionMode !== undefined && permissionMode !== (w.permission_mode || '')) patch(w.id, { permission_mode: permissionMode });
    log(w.id, 'human', text, { data: { by: ctx.user!.name } });
    if (REOPENABLE.includes(w.status)) {
      patch(w.id, { status: 'running', stop_reason: '', burst_start: w.iteration, waiting_children: 0, pending_push: '' });
      kick(w.id);
    }
    return { workflow: view(getWorkflow(w.id)) };
  });

  post('/api/workflows/:id/resume', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (OPEN.includes(w.status) && driving.has(w.id)) return { workflow: view(w) };
    if (overBudget(w)) throw badRequest('This session has used its budget. Raise the budget first.');
    resumeSession(w, ctx);
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Kiro could not run this session: the person decides whether it continues on Claude Code. Nothing switches by itself.
  post('/api/workflows/:id/engine-switch', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    if (typeof body.accept !== 'boolean') throw badRequest('Say whether to switch: {"accept": true} or {"accept": false}');
    if (!pendingEngineSwitch(w.id)) throw badRequest('This session is not waiting for an engine decision');
    if (body.accept) {
      engineProvider(w.project_id, 'claude');
      if (overBudget(w)) throw badRequest('This session has used its budget. Raise the budget first.');
      closeEngineSwitch(w.id);
      patch(w.id, { engine: 'claude' });
      log(w.id, 'system', `${ctx.user!.name} switched this session to Claude Code because Kiro could not run it.`);
      audit(ctx, 'session.engine-switch', `workflow:${w.id}`, { projectId: w.project_id, accept: true });
      resumeSession(getWorkflow(w.id), ctx);
    } else {
      closeEngineSwitch(w.id);
      log(w.id, 'system', `${ctx.user!.name} kept this session on Kiro; it stays stopped.`);
      audit(ctx, 'session.engine-switch', `workflow:${w.id}`, { projectId: w.project_id, accept: false });
      stopWith(w.id, 'stopped', 'Kiro could not run this session and you chose not to switch to Claude Code.');
    }
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Finish the current iteration, then wait.
  post('/api/workflows/:id/pause', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (w.status !== 'running') throw badRequest('This session is not running');
    stopWith(w.id, 'paused', 'Paused after the current iteration.');
    audit(ctx, 'session.pause', `workflow:${w.id}`, { projectId: w.project_id });
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Stop now, including the run in progress.
  post('/api/workflows/:id/stop', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    stopWith(w.id, 'stopped', `Stopped by ${ctx.user!.name}.`);
    const runId = driving.get(w.id)?.runId ?? w.last_run_id;
    if (runId && isActive(runId)) stopRun(runId);
    audit(ctx, 'session.stop', `workflow:${w.id}`, { projectId: w.project_id });
    return { workflow: view(getWorkflow(w.id)) };
  });

  // Cancel a queued (waiting) session. Changes its status to 'stopped'.
  post('/api/workflows/:id/cancel-queued', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (w.status !== 'queued') throw badRequest('This session is not queued');
    patch(w.id, { status: 'stopped', queue_reason: '', queued_at: null, stop_reason: `Cancelled while queued by ${ctx.user!.name}.` });
    log(w.id, 'status', `Cancelled while queued by ${ctx.user!.name}`);
    audit(ctx, 'session.stop', `workflow:${w.id}`, { projectId: w.project_id, wasQueued: true });
    return { workflow: view(getWorkflow(w.id)) };
  });

  del('/api/workflows/:id', (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (w.status === 'running') throw badRequest('Stop the session first');
    // Sessions it delegated to stay, on their own.
    exec('UPDATE workflows SET parent_id = NULL WHERE parent_id = ?', w.id);
    exec('DELETE FROM workflows WHERE id = ?', w.id);
    removeContextFiles(w.project_id, w.id);
    notifyProject(w.project_id, 'workflow.deleted', { id: w.id });
    return { ok: true };
  });

  /* -------- rescue routes -------- */

  /** List all git working copies inside the session's run folders (read-only, newest run first, last 10 runs). */
  get('/api/workflows/:id/working-copies', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id);
    const project = getProject(w.project_id);
    const pdir = projectDir(project);
    // Collect the last 10 runs belonging to this session, newest first.
    const runs = all<Row>('SELECT id, worktree, meta FROM agent_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 10', w.id);
    // Build a set of root-commit -> repoId mappings for all project repos.
    const projectRepos = all<Row>('SELECT id, name FROM repos WHERE project_id = ?', w.project_id);
    const repoRootMap = new Map<string, { repoId: string; repoName: string }>();
    for (const repo of projectRepos) {
      try {
        const repoSlug = all<Row>('SELECT slug FROM repos WHERE id = ?', repo.id)[0]?.slug ?? '';
        const repoPath = path.join(pdir, 'repos', repoSlug);
        if (!fs.existsSync(repoPath)) continue;
        const res = await git(['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoPath }).catch(() => null);
        const rootSha = res?.stdout.trim();
        if (rootSha) repoRootMap.set(rootSha, { repoId: repo.id, repoName: String(repo.name) });
      } catch { /* skip */ }
    }

    const items: {
      runId: string; path: string; branch: string; head: string; subject: string;
      dirty: boolean; repoId: string | null; repoName: string;
    }[] = [];
    // Dedupe: track absolute paths already added so runs that resume with the same work folder appear once.
    const seenPaths = new Set<string>();

    for (const run of runs) {
      const meta = parseJson<any>(run.meta, {});
      // Find the base work directory for this run.
      const worktree: string | undefined = meta.workDir;
      const singleWt: string | undefined = meta.repos?.[0]?.worktree ?? run.worktree ?? undefined;
      const runFolderRel = worktree ?? singleWt;
      if (!runFolderRel) continue;
      const runFolderAbs = path.join(pdir, runFolderRel);
      if (!fs.existsSync(runFolderAbs)) continue;

      // Walk max depth 2 below run folder for .git dirs (same logic as before).
      const gitDirs: string[] = [];
      if (fs.existsSync(path.join(runFolderAbs, '.git'))) {
        gitDirs.push(runFolderAbs);
      } else {
        try {
          for (const e of fs.readdirSync(runFolderAbs, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name === 'node_modules') continue;
            const sub = path.join(runFolderAbs, e.name);
            if (fs.existsSync(path.join(sub, '.git'))) {
              gitDirs.push(sub);
            } else {
              try {
                for (const e2 of fs.readdirSync(sub, { withFileTypes: true })) {
                  if (!e2.isDirectory() || e2.name === 'node_modules') continue;
                  const sub2 = path.join(sub, e2.name);
                  if (fs.existsSync(path.join(sub2, '.git'))) gitDirs.push(sub2);
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }

      for (const gitDir of gitDirs) {
        const relPath = path.relative(pdir, gitDir).replace(/\\/g, '/');
        // Dedupe by absolute path: same folder appears only once even when multiple runs share it.
        if (seenPaths.has(gitDir)) continue;
        seenPaths.add(gitDir);
        try {
          const g = (args: string[]) => git(args, { cwd: gitDir }).then((r) => r.stdout.trim()).catch(() => '');
          const branch = await g(['rev-parse', '--abbrev-ref', 'HEAD']);
          const head = await g(['rev-parse', '--short', 'HEAD']);
          const subject = await g(['log', '-1', '--format=%s']);
          const dirtyOut = await g(['status', '--porcelain']);
          const dirty = dirtyOut.length > 0;
          let repoId: string | null = null;
          let repoName = '';
          const rootSha = await g(['rev-list', '--max-parents=0', 'HEAD']);
          const match = repoRootMap.get(rootSha);
          if (match) { repoId = match.repoId; repoName = match.repoName; }
          items.push({ runId: run.id, path: relPath, branch, head, subject, dirty, repoId, repoName });
        } catch { /* skip */ }
      }
    }

    return { copies: items };
  });

  /** Attach a repository to a session that has none (rescue stuck playground sessions). */
  post('/api/workflows/:id/attach-repo', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    if (sessionRepos(w).length) throw badRequest('This session already has repositories');
    if (w.status === 'running' || driving.has(w.id)) throw badRequest('Stop the session before attaching a repository');
    // Active-run guard: last run still active.
    if (w.last_run_id && isActive(w.last_run_id)) throw badRequest('Wait for the current run to finish before attaching a repository');
    const body = await ctx.json();
    const repo = getRepo(String(body.repoId ?? ''));
    if (repo.project_id !== w.project_id) throw badRequest('That repository belongs to another project');
    const branch = body.branch ? checkBranch(String(body.branch)) : repo.default_branch;
    const repos = [{ repoId: repo.id, branch }];
    // Upgrade push_mode from 'never' to 'ask' now that we have a repo.
    const newPushMode = w.push_mode === 'never' ? 'ask' : w.push_mode;
    exec(
      "UPDATE workflows SET repo_id = ?, branch = ?, repos = ?, playground = 0, push_mode = ?, updated_at = ? WHERE id = ?",
      repo.id, branch, JSON.stringify(repos), newPushMode, now(), w.id,
    );
    log(w.id, 'system', `Repository "${repo.name}" attached by ${ctx.user!.name}; agent pushes set to "${newPushMode}".`);
    return { workflow: view(getWorkflow(w.id)) };
  });

  /** Push an arbitrary working copy from a run folder to a new branch on a connected repo. */
  post('/api/workflows/:id/push-copy', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');

    // Active-run guard: refuse if the session is currently running, being driven, or has an active last run.
    if (w.status === 'running' || driving.has(w.id)) throw badRequest('Stop the session before pushing a working copy');
    if (w.last_run_id && isActive(w.last_run_id)) throw badRequest('Wait for the current run to finish before pushing');

    const body = await ctx.json();
    const project = getProject(w.project_id);
    const pdir = projectDir(project);

    // Validate and resolve the path — must be inside one of this session's run folders.
    const rawPath = str(body.path, 'path', { max: 500 });
    let absPath: string;
    try {
      absPath = path.resolve(pdir, rawPath.replace(/\//g, path.sep));
    } catch {
      throw badRequest('Invalid path');
    }
    if (!absPath.startsWith(pdir + path.sep) && absPath !== pdir) throw badRequest('Path is outside the project directory');
    // Resolve symlinks to detect traversal.
    let realAbs: string;
    try {
      realAbs = fs.realpathSync(absPath);
    } catch {
      throw badRequest('Path does not exist');
    }
    if (!realAbs.startsWith(pdir + path.sep) && realAbs !== pdir) throw badRequest('Path resolves outside the project directory');

    // Must be inside a run folder that belongs to this session.
    const runs = all<Row>('SELECT id, worktree, meta FROM agent_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 50', w.id);
    const isInsideRunFolder = runs.some((r) => {
      const meta = parseJson<any>(r.meta, {});
      const candidates: string[] = [];
      if (meta.workDir) candidates.push(path.resolve(pdir, meta.workDir.replace(/\//g, path.sep)));
      if (Array.isArray(meta.repos)) {
        for (const rr of meta.repos) if (rr.worktree) candidates.push(path.resolve(pdir, rr.worktree.replace(/\//g, path.sep)));
      }
      if (r.worktree) candidates.push(path.resolve(pdir, r.worktree.replace(/\//g, path.sep)));
      return candidates.some((c) => realAbs === c || realAbs.startsWith(c + path.sep));
    });
    if (!isInsideRunFolder) throw badRequest('Path is not inside any run folder of this session');

    // Verify it is a git repo.
    if (!fs.existsSync(path.join(realAbs, '.git'))) throw badRequest('No git repository found at that path');

    // Validate repo and branch.
    const repo = getRepo(String(body.repoId ?? ''));
    if (repo.project_id !== w.project_id) throw badRequest('That repository belongs to another project');

    // Derive branch if not given.
    let branch: string;
    if (body.branch) {
      branch = checkBranch(String(body.branch));
    } else {
      if (!w.work_branch) {
        const derived = deriveBranchName(w);
        exec('UPDATE workflows SET work_branch = ?, updated_at = ? WHERE id = ?', derived, now(), w.id);
        branch = derived;
      } else {
        branch = w.work_branch;
      }
    }

    // Guards: never push to base/default/shared branches.
    if (branch === repo.default_branch) throw badRequest(`Push to a new branch. "${branch}" is the default branch of the repository.`);
    if (isSharedBranch(branch)) throw badRequest(`Agents may not push to the shared branch "${branch}". Use a new branch for the changes.`);

    // Verify git history using async git() helper (sets GIT_TERMINAL_PROMPT=0, redacts credentials on error).
    const gitAt = (args: string[]) => git(args, { cwd: realAbs });

    let wcRootSha: string;
    try {
      wcRootSha = (await gitAt(['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim();
    } catch (e: any) {
      throw badRequest(`Cannot read git history at that path: ${redact(String(e?.message ?? e)).slice(0, 200)}`);
    }
    const repoSlug = all<Row>('SELECT slug FROM repos WHERE id = ?', repo.id)[0]?.slug ?? '';
    const repoPath = path.join(pdir, 'repos', repoSlug);
    let repoRootSha: string;
    try {
      repoRootSha = (await git(['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoPath })).stdout.trim();
    } catch (e: any) {
      throw badRequest(`Cannot read the history of repository "${repo.name}": ${redact(String(e?.message ?? e)).slice(0, 200)}`);
    }
    if (wcRootSha !== repoRootSha) throw badRequest(`The working copy's history does not match the repository "${repo.name}". Cannot push.`);

    // Handle dirty working copy.
    let dirty = false;
    try {
      dirty = (await gitAt(['status', '--porcelain'])).stdout.trim().length > 0;
    } catch { /* assume clean */ }

    if (dirty) {
      const message = str(body.message, 'Commit message', { max: 2000, optional: true }).trim();
      if (!message) throw badRequest('The working copy has uncommitted changes. Provide a commit message to commit them first.');
      try {
        await gitAt(['add', '-A']);
        await git(['-c', 'user.name=Agent Portal', '-c', 'user.email=portal@localhost', 'commit', '-m', message], { cwd: realAbs });
      } catch (e: any) {
        throw badRequest(`Could not commit: ${redact(String(e?.message ?? e)).slice(0, 200)}`);
      }
    }

    // Checkout the target branch.
    try {
      await gitAt(['checkout', '-B', branch]);
    } catch (e: any) {
      throw badRequest(`Could not switch to branch "${branch}": ${redact(String(e?.message ?? e)).slice(0, 200)}`);
    }

    // Set remote URL using credentials env (never leaks URL into process args).
    const credEnv = await repoGitEnv(repo);
    try {
      await git(['remote', 'set-url', 'origin', repo.url], { cwd: realAbs, env: credEnv });
    } catch {
      try {
        await git(['remote', 'add', 'origin', repo.url], { cwd: realAbs, env: credEnv });
      } catch (e: any) {
        throw badRequest(`Could not configure remote: ${redact(String(e?.message ?? e)).slice(0, 200)}`);
      }
    }

    // Capture HEAD commit for the history record.
    let commit: string | null = null;
    try {
      commit = (await gitAt(['rev-parse', 'HEAD'])).stdout.trim();
    } catch { /* skip */ }

    // Perform the push using the async git helper (captures and redacts stderr on failure).
    try {
      await git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { cwd: realAbs, env: credEnv, timeoutMs: 5 * 60_000 });
    } catch (e: any) {
      throw badRequest(`Push failed: ${redact(String(e?.message ?? e)).slice(0, 300)}`);
    }

    // Open a pull request if requested (GitHub: draft; CodeCommit: regular). The push already happened, so a failure
    // is reported in the history instead of failing the request.
    let prHtmlUrl: string | null = null;
    let prNumber: number | null = null;
    let prError: string | null = null;
    if (body.pr) {
      try {
        const baseBranch = sessionRepos(getWorkflow(w.id)).find((x) => x.repoId === repo.id)?.branch || repo.default_branch;
        const created = await openPullRequest(repo, { title: branch, head: branch, base: baseBranch, body: `Created from Agent Portal session "${w.title}".` });
        prHtmlUrl = created.url;
        prNumber = created.number;
      } catch (e: any) {
        prError = String(e?.message ?? e).slice(0, 300);
      }
    }

    // Record history event using the same shape as pushForSession (pr = html_url string).
    const results = [{ repo: repo.name, ok: true, commit: commit ?? undefined, pr: prHtmlUrl ?? undefined, repoId: repo.id, prNumber: prNumber ?? undefined, ...(prError ? { prError } : {}) }];
    const msg = `Pushed working copy at "${rawPath}" to "${branch}" in ${repo.name}${prHtmlUrl ? ` and opened a pull request (${prHtmlUrl})` : ''}.${prError ? ` No pull request was opened: ${prError}` : ''}`;
    const currentW = getWorkflow(w.id);
    log(w.id, 'push', msg, { data: { branch, by: ctx.user!.name, results } });

    // Set work_branch if empty.
    if (!currentW.work_branch) {
      exec('UPDATE workflows SET work_branch = ?, updated_at = ? WHERE id = ?', branch, now(), w.id);
    }
    // Mark blocked sessions as done.
    if (currentW.status === 'blocked') {
      exec("UPDATE workflows SET status = 'done', stop_reason = ?, updated_at = ? WHERE id = ?",
        `Pushed to "${branch}" via push-copy.`, now(), w.id);
    }

    return { workflow: view(getWorkflow(w.id)), push: { ok: true, results } };
  });
}

