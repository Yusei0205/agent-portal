/**
 * Auto-fix pipeline: a `new` finding is triaged and, when it may proceed, one loop session is started for it from the built-in spec
 * of its source, with the project's verify command as the loop's check. When that session ends, its result decides the finding's
 * next status:
 *  - the agent reports "cannot reproduce" (the check already passed): needs_human, with a 'blocked' Inbox item;
 *  - the last check failed, or the session failed: one attempt more, back to `new` after the cooldown;
 *  - the checks passed: the finding stays `fixing` while the PR step (delivery.ts) delivers the change it gated during the run; when
 *    the run produced no repository change (nothing was gated and no `pull-request` event exists), needs_human ('fix produced no
 *    changes').
 *
 * Every status change is a conditional transition, so two callers racing on one finding cannot both act on it. Findings held back
 * (deferred by triage, or a 409/429 from the portal-wide fixer spec) stay `new`; they are picked up when any fix session ends
 * (processNewEverywhere) or when the same failure is delivered again (intake).
 */

import { getAutofixFindingsRepository } from '../repositories/autofix-findings.ts';
import type { AutofixFinding, FindingSource, FindingStatus } from '../repositories/autofix-findings.ts';
import { getGitReposRepository } from '../repositories/git-repos.ts';
import { getLoopSpecsRepository } from '../repositories/loop-specs.ts';
import type { LoopSpecRecord } from '../repositories/loop-specs.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { getProjectRepository } from '../repositories/projects.ts';
import { fireLoopSpec } from '../loop-triggers.ts';
import type { FireOptions, FireResult } from '../loop-triggers.ts';
import { validateCheckSteps, MAX_CHECK_STEPS } from '../agent/runner-checks.ts';
import type { CheckStep } from '../agent/runner-checks.ts';
import { addRunLifecycleHook } from '../agent/runner.ts';
import type { RunLifecycleDetail, RunLifecycleEvent } from '../agent/runner.ts';
import { readLoopState } from '../workflows/loop.ts';
import { createInboxItem } from '../inbox.ts';
import { getAutofixPolicy, isPaused } from './policy.ts';
import type { AutofixPolicy } from './policy.ts';
import { triage } from './triage.ts';
import type { TriageContext } from './triage.ts';
import { AUTOFIX_BRANCH_PREFIX, classifyKind } from './github-events.ts';
import type { GithubEventResult } from './github-events.ts';
import { scrubEvidence } from './scrub.ts';
import { listBranchFiles, scrubSecrets } from '../pull-requests.ts';
import type { Repository } from '../repos.ts';

/** The built-in spec that fixes each kind of finding. Sources without one (added in Task 12) are left `new`. */
export const AUTOFIX_SPEC_BY_SOURCE: Partial<Record<FindingSource, string>> = { ci_failed: 'builtin-autofix-ci' };

const EVIDENCE_IN_GOAL = 4_000;
/** The previous_attempt goal variable is at most this long; the stored account of the attempt leaves room for the branch note. */
const PREVIOUS_ATTEMPT_MAX = 4_000;
const PREVIOUS_ATTEMPT_STORED_MAX = 3_500;
const PREVIOUS_FILES_SHOWN = 40;
const PROCESS_NEW_BATCH = 20;
/** At most this many projects are looked at in one sweep after a session ends. */
const SWEEP_PROJECTS = 100;

type FireFn = (spec: LoopSpecRecord, opts: FireOptions) => Promise<FireResult>;
let fire: FireFn = fireLoopSpec;
/** Test seam: replace fireLoopSpec. Call with null to restore it. */
export function _setFireLoopSpec(fn: FireFn | null): void { fire = fn ?? fireLoopSpec; }

const pending = new Set<Promise<void>>();
function track(p: Promise<void>): void {
  const tracked = p.finally(() => { pending.delete(tracked); });
  pending.add(tracked);
}
/** Test helper: resolves when all background pipeline work started so far has finished. */
export async function _drainPipelineForTest(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

function log(msg: string, e?: unknown): void {
  if (e === undefined) console.warn(`[autofix] ${msg}`);
  else console.error(`[autofix] ${msg}:`, e instanceof Error ? e.message : e);
}

async function blockedItem(f: AutofixFinding, reason: string, workflowId: string | null = null): Promise<void> {
  await createInboxItem({
    type: 'blocked', projectId: f.project_id, workflowId,
    payload: { kind: 'autofix', reason, findingId: f.id, findingKind: f.kind, branch: f.branch },
  });
}

/** Move the finding from `from` to needs_human and, when this call made the move, write a 'blocked' Inbox item. */
export async function toNeedsHuman(f: AutofixFinding, from: FindingStatus[], reason: string, extra: Partial<AutofixFinding> = {}, workflowId: string | null = null): Promise<void> {
  if (await getAutofixFindingsRepository().transition(f.id, from, { ...extra, status: 'needs_human' })) await blockedItem(f, reason, workflowId);
}

/**
 * A fix attempt failed (its checks failed, its session failed, or its push failed): count it and send the finding back to `new`
 * after the cooldown, or, at the attempt limit, to needs_human. Applies only while the finding is in one of `from`.
 */
export async function recordFailedAttempt(
  f: AutofixFinding, from: FindingStatus[], policy: AutofixPolicy, extra: Partial<AutofixFinding> = {}, workflowId: string | null = null,
): Promise<void> {
  const attempts = f.attempts + 1;
  if (attempts >= policy.limits.max_attempts) {
    // The last allowed attempt failed: straight to a person (a cooldown here would only delay the same decision in triage).
    await toNeedsHuman(f, from, 'attempt limit reached', { ...extra, attempts }, workflowId);
  } else {
    const cooldown_until = new Date(Date.now() + policy.limits.cooldown_minutes * 60_000).toISOString();
    await getAutofixFindingsRepository().transition(f.id, from, { ...extra, status: 'new', attempts, cooldown_until });
  }
}

/**
 * Whether delivery of a fix session's change began: the PR gate (delivery.ts) records the fix branch on the finding before anything
 * else, and the session PR flow writes `pull-request` events. Both happen while the run is still open (before the lifecycle hook).
 */
async function deliveryStarted(f: AutofixFinding, workflowId: string): Promise<boolean> {
  if (f.fix_branch) return true;
  const rows = await getSessionsRepository().listWorkflowRunEventsByType(workflowId, ['pull-request'], 1);
  return rows.length > 0;
}

const utcMidnight = (d: Date): string => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();

async function triageContext(f: AutofixFinding): Promise<TriageContext> {
  const repo = getAutofixFindingsRepository();
  const at = new Date();
  const [prOpen, fixing, costTodayUsd, paused, gitRepo] = await Promise.all([
    repo.list(f.project_id, { status: 'pr_open', limit: 500 }),
    repo.list(f.project_id, { status: 'fixing', limit: 500 }),
    repo.sumCostSince(f.project_id, utcMidnight(at)),
    isPaused(f.project_id),
    f.repo_id ? getGitReposRepository().getById(f.repo_id) : Promise.resolve(null),
  ]);
  return {
    paused,
    openPrCount: prOpen.length,
    costTodayUsd,
    defaultBranch: gitRepo?.default_branch ?? null,
    portalPrBranches: [...prOpen, ...fixing].map((x) => x.fix_branch).filter((b): b is string => Boolean(b)),
    now: at,
  };
}

/** The loop checks: the verify command, then the quick commands (at most MAX_CHECK_STEPS in all). Throws when one is not allowed. */
function buildChecks(verify: { command: string; quick_commands: string[] }): CheckStep[] {
  const steps = [
    { step: 'verify', cmd: verify.command },
    ...verify.quick_commands.map((cmd, i) => ({ step: `quick ${i + 1}`, cmd })),
  ].slice(0, MAX_CHECK_STEPS);
  return validateCheckSteps(steps);
}

const warnedMissingSpecs = new Set<string>();

async function specFor(source: FindingSource): Promise<LoopSpecRecord | null> {
  const id = AUTOFIX_SPEC_BY_SOURCE[source];
  if (!id) return null; // no fixer for this source yet
  const spec = await getLoopSpecsRepository().getSpecById(id);
  if (!spec && !warnedMissingSpecs.has(id)) {
    // Built-in specs are seeded by the SQLite schema only (not on DynamoDB), so this is a setup problem worth a log line.
    warnedMissingSpecs.add(id);
    log(`the fixer spec ${id} for ${source} findings is missing (not seeded in this database); those findings stay new`);
  }
  return spec;
}

/** What one processing pass did: 'busy' when the fixer spec refused for now (409/429), so others of that spec need not try. */
type Outcome = 'started' | 'busy' | 'none';

/** Triage a `new` finding and, when it may proceed, start its fix session. Safe to call for any finding in any status. */
export async function processFinding(findingId: string): Promise<void> {
  await processOne(findingId);
}

async function processOne(findingId: string): Promise<Outcome> {
  const repo = getAutofixFindingsRepository();
  const f = await repo.getById(findingId);
  if (!f || f.status !== 'new') return 'none';
  const spec = await specFor(f.source);
  if (!spec) return 'none';
  const policy = await getAutofixPolicy(f.project_id);

  const decision = triage(f, policy, await triageContext(f));
  if (decision.decision === 'deferred') return 'none';
  if (decision.decision === 'suppressed') { await repo.transition(f.id, ['new'], { status: 'suppressed' }); return 'none'; }
  if (decision.decision === 'needs_human') { await toNeedsHuman(f, ['new'], decision.reason); return 'none'; }

  // An incomplete setup is not the finding's fault: it waits as `new` until the policy has a verify command and a user to run as.
  if (!policy.verify.command.trim() || !policy.run_as) {
    log(`finding ${f.id} waits: the auto-fix policy has no ${policy.run_as ? 'verify command' : 'run_as user'}`);
    return 'none';
  }

  if (!await repo.transition(f.id, ['new'], { status: 'triaged' })) return 'none'; // someone else took it

  let checks: CheckStep[];
  try {
    checks = buildChecks(policy.verify);
  } catch (e) {
    await toNeedsHuman(f, ['triaged'], `verify command not allowed: ${(e as Error).message}`);
    return 'none';
  }

  const vars: Record<string, string> = {
    kind: f.kind,
    branch: f.branch ?? 'the default branch',
    evidence: f.evidence.length > EVIDENCE_IN_GOAL ? f.evidence.slice(-EVIDENCE_IN_GOAL) : f.evidence,
    verify_command: policy.verify.command,
    previous_attempt: previousAttemptVar(f),
  };
  let result: FireResult;
  try {
    result = await fire(spec, {
      source: 'webhook', vars, projectId: f.project_id, runAs: policy.run_as, checks,
      repoIds: f.repo_id ? [f.repo_id] : [], engine: policy.engine,
    });
  } catch (e) {
    log(`starting the fix session for ${f.id} failed`, e);
    result = { ok: false, status: 500, reason: String((e as Error)?.message ?? e) };
  }

  if (result.ok) {
    // fix_branch is cleared: a value left from an earlier attempt would read as "delivery began" for this session.
    if (!await repo.transition(f.id, ['triaged'], { status: 'fixing', workflow_id: result.workflowId, fix_branch: null })) {
      // Not expected (only this call moves a finding out of 'triaged'); never start a second session for it.
      log(`finding ${f.id} left 'triaged' while session ${result.workflowId} was starting; the session is not linked to it`);
    }
    return 'started';
  }
  if (result.status === 403) {
    // fireLoopSpec checks run_as again at fire time: that user is not (or no longer) an editor or owner of the project.
    await toNeedsHuman(f, ['triaged'], 'the run_as user has no edit access to this project');
    return 'none';
  }
  if (result.status === 409 || result.status === 429) {
    // The fixer spec is portal-wide: its previous session is still running, or its hourly limit is reached. The finding is retried
    // when a fix session ends (sweep) or the same failure is delivered again (intake).
    await repo.transition(f.id, ['triaged'], { status: 'new' });
    return 'busy';
  }
  log(`fix session for ${f.id} did not start (${result.status}): ${result.reason}`);
  await repo.transition(f.id, ['triaged'], { status: 'new', attempts: f.attempts + 1 });
  return 'none';
}

async function newWithFixer(projectId: string): Promise<AutofixFinding[]> {
  if ((await getAutofixPolicy(projectId)).mode === 'off') return [];
  return (await getAutofixFindingsRepository().list(projectId, { status: 'new', limit: 200 }))
    .filter((f) => AUTOFIX_SPEC_BY_SOURCE[f.source]);
}

/** Oldest first, one at a time, at most PROCESS_NEW_BATCH; once a spec is busy (409/429), its other findings are not tried. */
async function processList(list: AutofixFinding[]): Promise<void> {
  const busy = new Set<string>();
  const ordered = [...list]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .slice(0, PROCESS_NEW_BATCH);
  for (const f of ordered) {
    const specId = AUTOFIX_SPEC_BY_SOURCE[f.source]!;
    if (busy.has(specId)) continue;
    try {
      if (await processOne(f.id) === 'busy') busy.add(specId);
    } catch (e) { log(`processing finding ${f.id} failed`, e); }
  }
}

/** Process the project's `new` findings that have a fixer, oldest first, one at a time (at most PROCESS_NEW_BATCH). */
export async function processNew(projectId: string): Promise<void> {
  await processList(await newWithFixer(projectId));
}

/**
 * Process the held-back `new` findings of every project with auto-fix on (at most SWEEP_PROJECTS projects), oldest first across
 * projects. The fixer specs are portal-wide, so a session ending in one project frees the spec for the others.
 */
export async function processNewEverywhere(firstProjectId?: string): Promise<void> {
  const ids = (await getProjectRepository().listProjects()).map((p) => p.id);
  const ordered = firstProjectId ? [firstProjectId, ...ids.filter((id) => id !== firstProjectId)] : ids;
  const all: AutofixFinding[] = [];
  for (const id of ordered.slice(0, SWEEP_PROJECTS)) {
    try { all.push(...await newWithFixer(id)); } catch (e) { log(`listing findings of project ${id} failed`, e); }
  }
  await processList(all);
}

/**
 * Called by the intake for a finding it just created or reopened: process it unless auto-fix is off for the project. Never rejects;
 * callers do not wait for it.
 */
export function maybeProcess(findingId: string): Promise<void> {
  const work = (async () => {
    const f = await getAutofixFindingsRepository().getById(findingId);
    if (!f || f.status !== 'new') return;
    if ((await getAutofixPolicy(f.project_id)).mode === 'off') return;
    await processFinding(findingId);
  })().catch((e) => log(`processing finding ${findingId} failed`, e));
  track(work);
  return work;
}

/**
 * True when the agent's final status summary says the failure could not be reproduced. The goal tells it to start the summary with
 * "cannot reproduce"; close variants are accepted too.
 */
export function cannotReproduce(summary: string | null | undefined): boolean {
  return /\b(cannot|can't|can not|could not|couldn't|unable to) reproduce\b/i.test(String(summary ?? ''));
}

/**
 * A fix session has ended (or was cancelled, `opts.cancelled`): record its cost on the finding and decide the finding's next status.
 * Only a finding still `fixing` with this session is changed. Afterwards, findings that were held back are processed.
 */
export async function onFixSessionEnded(workflowId: string, opts: { cancelled?: boolean } = {}): Promise<void> {
  const repo = getAutofixFindingsRepository();
  const f = await repo.getByWorkflowId(workflowId);
  if (!f) return;
  if (f.status === 'fixing' && f.workflow_id === workflowId) {
    const sessions = getSessionsRepository();
    const [w, totals, policy] = await Promise.all([
      sessions.getWorkflowById(workflowId), sessions.getRunTotals(workflowId), getAutofixPolicy(f.project_id),
    ]);
    const cost_usd = f.cost_usd + (Number(totals.total_cost) || 0);
    const cooldown_until = new Date(Date.now() + policy.limits.cooldown_minutes * 60_000).toISOString();
    const state = w ? readLoopState(w) : null;
    const lastCheck = state?.lastCheck ?? null;
    const lastSummary = state?.summaries[state.summaries.length - 1] ?? '';
    const failed = !w || String(w.status) === 'failed';

    if (opts.cancelled) {
      // A person stopped the session: not the fix's fault, so no attempt, but a cooldown so it does not restart at once.
      await repo.transition(f.id, ['fixing'], { status: 'new', cost_usd, cooldown_until });
    } else if (!failed && lastCheck?.ok !== false && cannotReproduce(lastSummary)) {
      await toNeedsHuman(f, ['fixing'], 'cannot reproduce', { cost_usd }, workflowId);
    } else if (failed || !lastCheck || !lastCheck.ok) {
      await recordFailedAttempt(f, ['fixing'], policy, { cost_usd }, workflowId);
    } else if (!await deliveryStarted(f, workflowId)) {
      // Checks passed but the runner reported no repository change for the run, so there is nothing to deliver.
      await toNeedsHuman(f, ['fixing'], 'fix produced no changes', { cost_usd }, workflowId);
    } else {
      // Checks passed: stays 'fixing'; the PR step is delivering the change (or waits for an Inbox approval).
      await repo.transition(f.id, ['fixing'], { status: 'fixing', cost_usd });
    }
  }
  await processNewEverywhere(f.project_id);
}

// ── Closing the loop: CI results and PR closings on the fix branch ──────────

type CiResult = Extract<GithubEventResult, { type: 'ci_result' }>;
type PrClosed = Extract<GithubEventResult, { type: 'pr_closed' }>;

type FilesLister = (f: AutofixFinding) => Promise<string[] | null>;

/** The files the fix branch changes against the repository's default branch, from GitHub (null when they cannot be read). */
async function listFixFiles(f: AutofixFinding): Promise<string[] | null> {
  if (!f.fix_branch || !f.repo_id) return null;
  const rec = await getGitReposRepository().getById(f.repo_id);
  if (!rec) return null;
  const r = await listBranchFiles(rec as unknown as Repository, rec.default_branch || 'main', f.fix_branch);
  return r.ok ? r.files.map((x) => x.path) : null;
}
let previousFiles: FilesLister = listFixFiles;
/** Test seam: replace the lookup of the files the previous fix changed. Call with null to restore it. */
export function _setPreviousFilesLister(fn: FilesLister | null): void { previousFiles = fn ?? listFixFiles; }

/** One line, no control characters, credentials removed: for a value from a webhook or the host inside the goal. */
const oneLine = (v: string, max: number): string => scrubSecrets(String(v)).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

/** The account of a fix whose PR failed CI, stored on the finding for the retry's goal: header first, then the CI output's tail. */
function describeFailedFix(f: AutofixFinding, r: CiResult, evidence: string, files: string[] | null): string {
  const head: string[] = [];
  const where = [f.pr_number != null ? `pull request #${f.pr_number}` : 'pull request', f.fix_branch ? `branch ${oneLine(f.fix_branch, 120)}` : '',
    r.headSha ? `commit ${oneLine(r.headSha, 12)}` : ''].filter(Boolean).join(', ');
  head.push(`The previous fix (${where}) failed CI${r.workflowName ? ` in ${oneLine(r.workflowName, 80)}` : ''}.`);
  if (files && files.length) {
    const shown = files.slice(0, PREVIOUS_FILES_SHOWN).map((p) => oneLine(p, 200));
    head.push(`Files the previous fix changed: ${shown.join(', ')}${files.length > shown.length ? ` (and ${files.length - shown.length} more)` : ''}`);
  } else {
    head.push('Files the previous fix changed: unknown (see the branch).');
  }
  const header = scrubEvidence(head.join('\n'), 2_000);
  const room = PREVIOUS_ATTEMPT_STORED_MAX - header.length - 60;
  const out = evidence.trim() && room > 200
    ? `${header}\nCI output on the fix branch (log tail, secrets removed):\n${scrubEvidence(evidence, room)}`
    : `${header}\nNo CI output could be read for the failing run.`;
  return out.slice(0, PREVIOUS_ATTEMPT_STORED_MAX);
}

/** The previous_attempt goal variable: how to continue on the open PR's branch, and what the previous attempt did. */
function previousAttemptVar(f: AutofixFinding): string {
  const parts: string[] = [];
  if (f.pr_branch) {
    const b = oneLine(f.pr_branch, 200);
    parts.push(`This is a retry on the open pull request${f.pr_number != null ? ` #${f.pr_number}` : ''}. Build on the previous fix so that pull request is updated: before changing anything, run \`git checkout -B ${b} origin/${b}\` and keep its commits.`);
  }
  if (f.previous_attempt) parts.push(f.previous_attempt);
  return parts.length ? parts.join('\n').slice(0, PREVIOUS_ATTEMPT_MAX) : 'None: this is the first attempt.';
}

/**
 * The finding whose open PR a CI result or PR closing is about: its fix branch (never a branch outside autofix/), and only while it is
 * pr_open. Anything else (unknown branch, a finding already resolved, dismissed or being retried) is null, so late and duplicate
 * events change nothing.
 */
async function openPrFinding(projectId: string, branch: string): Promise<AutofixFinding | null> {
  if (!branch.startsWith(AUTOFIX_BRANCH_PREFIX)) return null;
  const f = await getAutofixFindingsRepository().getByFixBranch(projectId, branch);
  return f && f.status === 'pr_open' ? f : null;
}

/**
 * A CI run on a fix branch finished. Applies only to a pr_open finding, a run for the commit the portal pushed last (when known), and,
 * for a CI finding, a workflow of the finding's own kind (a green lint run says nothing about a tests fix).
 *  - success: resolved;
 *  - failure: one attempt more; at the attempt limit, needs_human ('attempt limit reached') with a 'blocked' Inbox item; below it, the
 *    finding goes back to `new` (no cooldown) with an account of the failed fix, and through the normal pipeline (triage, limits, kill
 *    switch, mode), which starts one retry on the same branch. `opts.evidence` reads the failing run's log (only for a failure that
 *    applies).
 */
export async function applyCiResult(projectId: string, r: CiResult, opts: { evidence?: () => Promise<string> } = {}): Promise<void> {
  const f = await openPrFinding(projectId, r.branch);
  if (!f) return;
  if (f.source === 'ci_failed' && r.workflowName && classifyKind(r.workflowName) !== f.kind) return;
  if (f.pr_head_sha && r.headSha && r.headSha.toLowerCase() !== f.pr_head_sha.toLowerCase()) return; // a stale run
  const repo = getAutofixFindingsRepository();
  if (r.conclusion === 'success') {
    await repo.transition(f.id, ['pr_open'], { status: 'resolved', previous_attempt: null });
    return;
  }
  const policy = await getAutofixPolicy(f.project_id);
  const attempts = f.attempts + 1;
  if (attempts >= policy.limits.max_attempts) {
    await toNeedsHuman(f, ['pr_open'], 'attempt limit reached', { attempts });
    return;
  }
  const evidence = opts.evidence ? await opts.evidence().catch(() => '') : '';
  const files = await previousFiles(f).catch(() => null);
  const moved = await repo.transition(f.id, ['pr_open'], {
    status: 'new', attempts, cooldown_until: null, previous_attempt: describeFailedFix(f, r, evidence, files),
    // The retry pushes to the PR's branch (pr_branch); fix_branch is set again when its delivery begins.
    pr_branch: f.pr_branch ?? f.fix_branch, fix_branch: null,
  });
  if (moved) await maybeProcess(f.id);
}

/** The fix's PR was closed: merged resolves the finding; closed without merging dismisses it for the cooldown. Only from pr_open. */
export async function applyPrClosed(projectId: string, r: PrClosed): Promise<void> {
  const f = await openPrFinding(projectId, r.branch);
  if (!f) return;
  if (f.pr_number != null && f.pr_number !== r.prNumber) return; // another PR from the same branch name
  const done = { pr_branch: null, pr_head_sha: null, previous_attempt: null };
  if (r.merged) {
    await getAutofixFindingsRepository().transition(f.id, ['pr_open'], { status: 'resolved', ...done });
    return;
  }
  const policy = await getAutofixPolicy(f.project_id);
  const cooldown_until = new Date(Date.now() + policy.limits.cooldown_minutes * 60_000).toISOString();
  await getAutofixFindingsRepository().transition(f.id, ['pr_open'], { status: 'dismissed', cooldown_until, ...done });
}

/** The run lifecycle hook: acts when a fix session has ended, not after an iteration the loop goes on from. */
export function handleFixLifecycle(workflowId: string, _runId: string, event: RunLifecycleEvent, detail?: RunLifecycleDetail): Promise<void> | void {
  if (event === 'start') return;
  if (event === 'failed' && detail?.recovering) return; // recovery continues this session
  if ((event === 'done' || event === 'failed') && detail?.loopEnded === false) return; // the loop started its next iteration
  const work = onFixSessionEnded(workflowId, { cancelled: event === 'cancelled' })
    .catch((e) => log(`handling the end of session ${workflowId} failed`, e));
  track(work);
  return work;
}

let unsubscribe: (() => void) | null = null;

/** Register the pipeline with the run lifecycle. Safe to call again (a second call replaces the first). */
export function registerFixPipeline(): () => void {
  unsubscribe?.();
  unsubscribe = addRunLifecycleHook(handleFixLifecycle);
  return unsubscribe;
}
