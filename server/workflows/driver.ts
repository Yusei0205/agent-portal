/** The driver loop: starts an agent run, waits for it, runs the check and repeats until a stop condition. */
import path from 'node:path';
import { all, one, run as exec, type Row, isDbOpen, dbGeneration } from '../db.ts';
import { getProject, projectDir } from '../projects.ts';
import { getRepo } from '../repos.ts';
import { downloadAttachments, issueDetail, mustMapping } from '../jira.ts';
import { ticketMarkdown } from '../jira-text.ts';
import { getRun, startRun } from '../agent/runner.ts';
import type { PermissionMode } from '../agent/types.ts';
import { now, parseJson } from '../util.ts';
import { composeIterationPrompt, parseStatus, safeBranchName, stagnated } from '../guardrails.ts';
import { leadChoices, resolveLead, type RunLead } from '../kiro-agents.ts';
import { contextForIteration } from '../session-context.ts';
import { runRepos } from '../agent/runner.ts';
import { getSettings } from '../settings.ts';
import { getToolPacks } from '../tool-packs.ts';
import { isDraining } from '../control-plane.ts';
import { type VerificationStep } from '../loop-specs.ts';
import { runPipeline, formatPipelineForPrompt, persistPipelineResult, appendProgress } from '../loop-verification.ts';
import { driving, getWorkflow, isSingleRun, patch, log, overBudget } from './store.ts';
import { sessionRepos, reposView } from './views.ts';
import { askEngineSwitch, closeEngineSwitch } from './engine-switch.ts';
import { stopWith } from './lifecycle.ts';
import { childrenOf, runningChildren, createChild, delegationRoom } from './delegation.ts';
import { isKiro } from './validation.ts';
import { PushRequest, pushForSession, pushBlocker, performTrustedPush, deriveBranchName, worktreeFingerprint } from './push.ts';

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
  const wallClockStart = wallClockStartedAt(id);

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
      if (wallMins > 0 && (Date.now() - wallClockStart) > wallMins * 60_000) {
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
    if (!w.lead_agent && isKiro(w.project_id, w.engine) && !leadChoices(getProject(w.project_id), true).length) {
      return askEngineSwitch(id, 'this project has no usable Kiro agent.');
    }
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
        const pipelineResult = await runPipeline(verificationSteps, cwd, summary, { projectId: w.project_id, userId: w.created_by, workflowId: id });
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
          // Remember what the working copies hold now: allowing the push allows exactly this.
          req.tree = await worktreeFingerprint(finished).catch(() => undefined);
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
  // The coordinating session of a "Keep docs current" firing never runs an agent (NEW-2).
  if (one<Row>('SELECT 1 AS x FROM docs_sync_jobs WHERE workflow_id = ?', id)) {
    void import('../docs-sync.ts').then((m) => m.resumeSync(id)).catch(() => undefined);
    return;
  }
  // The coordinating session of an automatic pull request review never runs an agent either (NEW-3).
  if (one<Row>('SELECT 1 AS x FROM reviews WHERE workflow_id = ?', id)) {
    void import('../pr-review.ts').then((m) => m.resumePrReview(id)).catch(() => undefined);
    return;
  }
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

/**
 * When the session's current stretch of iterations started (milliseconds), for the wall-clock stop rule. The time is
 * kept in loop_run_states with the stretch it belongs to (the session's burst_start), so a server restart, which
 * resumes the session, keeps counting. A new stretch (a person resumed the session, or it paused and went on) gets a
 * new start. Sessions without loop state (no loop spec) have no wall-clock rule, so they just get "now".
 */
export function wallClockStartedAt(id: string): number {
  const w = one<Row>('SELECT burst_start FROM workflows WHERE id = ?', id);
  const s = one<Row>('SELECT wall_clock_started_at, burst_start FROM loop_run_states WHERE workflow_id = ?', id);
  const burst = Number(w?.burst_start ?? 0);
  if (s?.wall_clock_started_at && Number(s.burst_start) === burst) {
    const t = Date.parse(String(s.wall_clock_started_at));
    if (Number.isFinite(t)) return t;
  }
  const started = now();
  if (s) exec('UPDATE loop_run_states SET wall_clock_started_at = ?, burst_start = ? WHERE workflow_id = ?', started, burst, id);
  return Date.parse(started);
}

/** True if any session is actively running a drive() loop in this process. */
export function anyDriving(): boolean {
  return driving.size > 0;
}
