/**
 * What happens after a session changed code in a repository: decide, ask, push, open the pull request, start a review.
 *
 * The runner only looks (it emits `repo-changes` at the end of a run). The portal decides here:
 *   - the session has a ticket and the project's "open pull requests" setting is on: go ahead
 *   - no ticket: ask in the Inbox (type "push"); approving calls createPullRequestForSession, declining writes `declined`
 *   - setting off: write `available` so the session card offers a button
 * An auto-fix session (server/autofix/delivery.ts) is decided by its gate first: blocked, asked (propose mode, or a diff that cannot
 * go ahead alone) or pushed as a draft PR at once (draft_pr mode with a clean diff), whatever the project setting.
 * Going ahead means: choose a branch name, ask the runner (finalize mode, same AgentCore session) to commit and push,
 * create the pull request on the host, then start a draft review. Every step is written to the session as a
 * `pull-request` event (the latest one per repository is what the card shows).
 *
 *   POST /api/sessions/:workflowId/pull-request   { repoId }   (project editors)
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import type { WorkflowRecord } from './repositories/sessions.ts';
import { getGitReposRepository } from './repositories/git-repos.ts';
import { getMembership } from './project-access.ts';
import { getPullRequestSettings } from './project-settings-pr.ts';
import { createPullRequest, deleteRemoteBranch, githubPullRequestState, PullRequestError, scrubSecrets } from './pull-requests.ts';
import { createReview, ReviewCreateError } from './review.ts';
import { createInboxItem } from './inbox.ts';
import { getAutofixFindingsRepository } from './repositories/autofix-findings.ts';
import { listRemoteBranches, _getCloneEnv } from './repos.ts';
import type { Repository } from './repos.ts';
import { invokeAgentCore } from './agent/kiro-agentcore.ts';
import { agentCoreSessionId } from './agent/agentcore-session.ts';
import { snapshotAccess } from './agent/runner-snapshot-access.ts';
import { buildRunnerRepos } from './agent/runner-repo-specs.ts';
import { runtimeFor } from './agent/repo-prep.ts';
import { branchNameFor, classifyPushError, isProtectedBranch } from './agent/runner-finalize.ts';
import type { DiffFile } from './autofix/guardrails.ts';
import type { AutofixPrOutcome, AutofixPrPlan } from './autofix/delivery.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * `paths` (per-file line counts from the runner's detectChanges) is sent only by runners built with it; when it is missing the
 * changed file list is unknown (the auto-fix gate then asks a person instead of pushing).
 */
export interface RepoChange { repo: string; base: string; commits: number; files: number; paths?: DiffFile[] }

export interface SessionPrContext {
  workflowId: string; runId: string; projectId: string; userId: string | null;
  engine: 'claude-code' | 'kiro' | 'codex';
  /**
   * The run's own check result as the engine saw it in the runner's stream (null: the run had checks but none arrived). The auto-fix
   * gate prefers it to the stored check-result event, which on DynamoDB may not be written yet when the changes arrive.
   */
  check?: { ok: boolean } | null;
}

type PrState =
  | 'asked' | 'declined' | 'available' | 'pushing' | 'pushed' | 'opened' | 'review-started' | 'review-failed' | 'failed';
type ErrorCode = 'no-permission' | 'unsupported' | 'failed' | 'no-workspace' | 'protected-path';

interface PrEvent {
  repo: string; repoId: string; provider?: string; state: PrState;
  branch?: string; base?: string; number?: number; url?: string; reviewId?: string; title?: string;
  commits?: number; files?: number; inboxId?: string; error?: string; errorCode?: ErrorCode;
}

/** States in which the work is under way or done: a repeated `repo-changes` does not start it again. */
const BUSY_STATES: PrState[] = ['asked', 'pushing', 'pushed', 'opened', 'review-started', 'review-failed'];
/** A pull request exists for the branch. */
const OPENED_STATES: PrState[] = ['opened', 'review-started', 'review-failed'];
async function stillOpen(prior: PrEvent, repo: Repository): Promise<boolean> {
  return !prior.number || await githubPullRequestState(repo, prior.number) !== 'closed';
}

const IDENTITY = { name: 'Agent Portal', email: 'agent-portal@users.noreply.invalid' };
const BODY_FINAL_MESSAGE_MAX = 3000;

// ── Test seam ─────────────────────────────────────────────────────────────────

interface Deps {
  /** Branch names that exist on the repository's remote. */
  listBranches: (repo: Repository) => Promise<string[]>;
  /** Replaces handleRepoChanges (tests of the callers only). */
  onRepoChanges?: (ctx: SessionPrContext, changes: RepoChange[]) => Promise<void>;
}
const defaultDeps: Deps = {
  listBranches: async (repo) => listRemoteBranches(repo, await _getCloneEnv(repo)),
};
let deps: Deps = { ...defaultDeps };

/** Tests only. Call with no argument to restore the real behaviour. */
export function _setSessionPrDeps(over: Partial<Deps> = {}): void {
  deps = { ...defaultDeps, ...over };
}

// ── Events ────────────────────────────────────────────────────────────────────

async function writeEvent(runId: string, projectId: string, workflowId: string, ev: PrEvent): Promise<void> {
  const clean: Record<string, unknown> = { type: 'pull-request' };
  for (const [k, v] of Object.entries(ev)) if (v !== undefined) clean[k] = v;
  // Loaded late: runner.ts pulls in the whole agent stack, which in turn calls into this module.
  const { emitRunEvent } = await import('./agent/runner.ts');
  emitRunEvent(runId, projectId, workflowId, 'pull-request', clean);
}

/** The latest `pull-request` event per repository id, newest first from the store. */
async function latestByRepo(workflowId: string): Promise<Map<string, PrEvent & { runId: string }>> {
  const rows = await getSessionsRepository().listWorkflowRunEventsByType(workflowId, ['pull-request'], 500);
  const out = new Map<string, PrEvent & { runId: string }>();
  for (const row of rows) {
    let p: PrEvent;
    try { p = JSON.parse(row.payload) as PrEvent; } catch { continue; }
    const key = p.repoId || p.repo;
    if (key && !out.has(key)) out.set(key, { ...p, runId: row.run_id });
  }
  return out;
}

/** Whether the session already has a pull request (or one being made) for the repository. Used by the route. */
export async function sessionPullRequestStatus(workflowId: string, repoId: string): Promise<PrEvent | null> {
  return (await latestByRepo(workflowId)).get(repoId) ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();
/** One pull request job per session and repository at a time. */
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

function firstLine(text: string, max: number): string {
  const line = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? '';
  const chars = Array.from(line);
  return chars.length <= max ? line : chars.slice(0, max - 1).join('') + '…';
}

function errText(e: unknown): string {
  return scrubSecrets(e instanceof Error ? e.message : String(e)).slice(0, 500);
}

function repoIdsOf(w: WorkflowRecord): string[] {
  try { const v = JSON.parse(String(w.repo_ids ?? '[]')); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

interface Resolved { record: Repository; runnerName: string; env: Record<string, string> }

/** Match the runner's folder name to the session's repository record, with the git settings the runner needs. */
async function resolveRepos(w: WorkflowRecord): Promise<Resolved[]> {
  const projectId = w.project_id ? String(w.project_id) : null;
  const ids = repoIdsOf(w);
  const specs = await buildRunnerRepos(ids, projectId, () => undefined);
  const out: Resolved[] = [];
  for (const id of ids) {
    const rec = await getGitReposRepository().getById(id);
    if (!rec || String(rec.project_id) !== projectId) continue;
    const spec = specs.find((s) => s.url === String(rec.url));
    if (spec) out.push({ record: rec as unknown as Repository, runnerName: spec.name, env: spec.env ?? {} });
  }
  return out;
}

interface Ticket { key: string; summary: string; url: string }
function ticketOf(w: WorkflowRecord): Ticket | null {
  const key = String(w.jira_key ?? '').trim();
  return key ? { key, summary: String(w.jira_summary ?? '').trim(), url: String(w.jira_url ?? '').trim() } : null;
}

function prTitle(w: WorkflowRecord): string {
  const t = ticketOf(w);
  const goal = firstLine(String(w.goal ?? ''), 72) || 'Changes from Agent Portal';
  if (t && t.summary) return firstLine(`${t.key}: ${t.summary}`, 72);
  if (t) return firstLine(`${t.key}: ${goal}`, 72);
  return goal;
}

async function finalMessage(workflowId: string): Promise<string> {
  try {
    const rows = await getSessionsRepository().listWorkflowRunEventsByType(workflowId, ['run-complete'], 1);
    const p = rows[0] ? JSON.parse(rows[0].payload) as { result?: unknown } : null;
    return typeof p?.result === 'string' ? p.result : '';
  } catch { return ''; }
}

async function prBody(w: WorkflowRecord): Promise<string> {
  const lines: string[] = [];
  const t = ticketOf(w);
  if (t) lines.push(t.url ? `Ticket: [${t.key}](${t.url})` : `Ticket: ${t.key}`);
  const pub = (process.env.PORTAL_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (pub && /^https?:\/\//i.test(pub) && w.project_id) lines.push(`Session: ${pub}/#/p/${w.project_id}/sessions/${w.id}`);
  const msg = scrubSecrets(await finalMessage(String(w.id))).trim();
  if (msg) {
    const chars = Array.from(msg);
    lines.push('', chars.length <= BODY_FINAL_MESSAGE_MAX ? msg : chars.slice(0, BODY_FINAL_MESSAGE_MAX - 1).join('') + '…');
  }
  lines.push('', 'Opened by Agent Portal.');
  return lines.join('\n');
}

// ── Public: runner reports changes ────────────────────────────────────────────

/**
 * Called once a run has finished and the runner reported changed repositories. Never throws: a problem becomes a
 * `pull-request` event with state `failed`.
 */
export async function handleRepoChanges(ctx: SessionPrContext, changes: RepoChange[]): Promise<void> {
  if (deps.onRepoChanges) return deps.onRepoChanges(ctx, changes);
  for (const change of changes) {
    try {
      await handleOne(ctx, change);
    } catch (e) {
      try {
        await writeEvent(ctx.runId, ctx.projectId, ctx.workflowId, {
          repo: change.repo, repoId: '', state: 'failed', base: change.base, commits: change.commits, files: change.files,
          error: errText(e), errorCode: 'failed',
        });
      } catch { /* nothing more to do */ }
    }
  }
}

async function handleOne(ctx: SessionPrContext, change: RepoChange): Promise<void> {
  const w = await getSessionsRepository().getWorkflowById(ctx.workflowId);
  if (!w) return;
  // Visual workflows choose their publication stage explicitly. Intermediate turns
  // must not open unrelated push approvals or publish before that stage.
  if (w.kind === 'automation') return;
  // An auto-fix session is decided by its gate before the project's setting is read; any other session goes on unchanged.
  // Fix sessions attach one repository today; with several, each change would be gated (and could block the finding) on its own.
  const { autofixGate, askReason, activeFinding } = await import('./autofix/delivery.ts');
  const gate = await autofixGate(ctx, change);
  if (gate === 'block' || gate === 'wait') return;
  const resolved = (await resolveRepos(w)).find((r) => r.runnerName === change.repo);
  if (!resolved) {
    await writeEvent(ctx.runId, ctx.projectId, ctx.workflowId, {
      repo: change.repo, repoId: '', state: 'failed', base: change.base, commits: change.commits, files: change.files,
      error: `The repository ${change.repo} is no longer attached to this session.`, errorCode: 'failed',
    });
    return;
  }
  const repoId = String(resolved.record.id);

  await serialized(`${ctx.workflowId}:${repoId}`, async () => {
    const prior = (await latestByRepo(ctx.workflowId)).get(repoId);
    if (prior && BUSY_STATES.includes(prior.state)
      && (!OPENED_STATES.includes(prior.state) || await stillOpen(prior, resolved.record))) return;

    const base: PrEvent = {
      repo: change.repo, repoId, provider: String(resolved.record.provider ?? '') || undefined, state: 'available', base: change.base, commits: change.commits, files: change.files,
    };
    // Judged before the lock: a duplicate change waiting here may find the finding moved on (a failed push sent it back to 'new').
    if ((gate === 'go' || gate === 'ask') && !(await activeFinding(ctx.workflowId))) return;
    if (gate === 'go') {
      await runPullRequest(ctx.runId, w, resolved, base, { userId: ctx.userId }, 'gate');
      return;
    }
    if (gate === 'ask') {
      const finding = await getAutofixFindingsRepository().getByWorkflowId(ctx.workflowId);
      const why = await askReason(ctx, change);
      const inboxId = await createInboxItem({
        type: 'push', projectId: ctx.projectId, workflowId: ctx.workflowId, runId: ctx.runId,
        payload: {
          kind: 'autofix', findingId: finding?.id ?? null,
          title: `Open an auto-fix pull request for ${change.repo}?`,
          body: `The auto-fix session changed ${change.files} files in ${change.commits} commit(s) in ${change.repo} and its checks pass. ${why} Approve to push a new branch and open a draft pull request.`,
          repo: change.repo, repoId, base: change.base, commits: change.commits, files: change.files,
        },
      });
      await writeEvent(ctx.runId, ctx.projectId, ctx.workflowId, { ...base, state: 'asked', inboxId });
      return;
    }
    const settings = getPullRequestSettings(ctx.projectId);
    const ticket = ticketOf(w);

    if (!settings.openPullRequests) {
      await writeEvent(ctx.runId, ctx.projectId, ctx.workflowId, base);
      return;
    }
    if (!ticket) {
      const inboxId = await createInboxItem({
        type: 'push', projectId: ctx.projectId, workflowId: ctx.workflowId, runId: ctx.runId,
        payload: {
          title: `Open a pull request for ${change.repo}?`,
          body: `${change.files} files changed in ${change.commits} commit(s) in ${change.repo}. Approve to push a new branch and open a pull request.`,
          repo: change.repo, repoId, base: change.base, commits: change.commits, files: change.files,
        },
      });
      await writeEvent(ctx.runId, ctx.projectId, ctx.workflowId, { ...base, state: 'asked', inboxId });
      return;
    }
    await runPullRequest(ctx.runId, w, resolved, base, { userId: ctx.userId }, 'other');
  });
}

// ── Public: approve, button ───────────────────────────────────────────────────

/** The Inbox question was declined. */
export async function declinePullRequestForSession(workflowId: string, repoId: string): Promise<void> {
  const w = await getSessionsRepository().getWorkflowById(workflowId);
  if (!w || !w.project_id) return;
  const prior = (await latestByRepo(workflowId)).get(repoId);
  if (prior && OPENED_STATES.includes(prior.state)) return;
  const runId = prior?.runId ?? (await getSessionsRepository().getLatestRun(workflowId))?.id;
  if (!runId) return;
  await writeEvent(runId, String(w.project_id), workflowId, {
    repo: prior?.repo ?? '', repoId, provider: prior?.provider, state: 'declined', base: prior?.base, commits: prior?.commits, files: prior?.files,
  });
  const { onAutofixPullRequestDeclined } = await import('./autofix/delivery.ts');
  await onAutofixPullRequestDeclined(workflowId);
}

/**
 * Push and open the pull request for one repository of a session: after an approval, from the session's button, or
 * to retry after a failure. Does nothing when a pull request is already open. Never throws.
 */
export async function createPullRequestForSession(
  workflowId: string, repoId: string,
  opts: { approvedBy?: string; base?: string; runId?: string; via?: 'approval' } = {},
): Promise<void> {
  try {
    const w = await getSessionsRepository().getWorkflowById(workflowId);
    if (!w || !w.project_id) return;
    const resolved = (await resolveRepos(w)).find((r) => String(r.record.id) === repoId);
    if (!resolved) return;

    await serialized(`${workflowId}:${repoId}`, async () => {
      const prior = (await latestByRepo(workflowId)).get(repoId);
      if (prior && OPENED_STATES.includes(prior.state) && await stillOpen(prior, resolved.record)) return;
      const base: PrEvent = {
        repo: resolved.runnerName, repoId, provider: String(resolved.record.provider ?? '') || undefined, state: 'available',
        base: opts.base || prior?.base || resolved.record.default_branch || 'main',
        commits: opts.base && opts.base !== prior?.base ? 0 : prior?.commits ?? 0,
        files: opts.base && opts.base !== prior?.base ? 0 : prior?.files ?? 0,
        ...(prior?.branch && (prior.state === 'pushed' || prior.state === 'failed') ? { branch: prior.branch } : {}),
      };
      const runId = opts.runId ?? prior?.runId ?? (await getSessionsRepository().getLatestRun(workflowId))?.id;
      if (!runId) return;
      if (opts.base && !(await deps.listBranches(resolved.record)).includes(opts.base)) {
        await writeEvent(runId, String(w.project_id), workflowId, { ...base, state: 'failed',
          error: 'The requested PR base branch does not exist on the repository remote.', errorCode: 'failed' });
        return;
      }
      await runPullRequest(runId, w, resolved, base, { userId: opts.approvedBy ?? null }, opts.via ?? 'other');
    });
  } catch (e) {
    console.error('[session-pr] createPullRequestForSession failed:', errText(e));
  }
}

/** A Codex tool request can name only a repository already attached to this session. */
export async function createRequestedSessionPullRequest(ctx: SessionPrContext, request: { repo: string; base: string }): Promise<void> {
  const w = await getSessionsRepository().getWorkflowById(ctx.workflowId);
  if (!w || String(w.project_id) !== ctx.projectId) throw new Error('Session project does not match');
  const resolved = (await resolveRepos(w)).find(r => r.runnerName === request.repo);
  if (!resolved) throw new Error('Repository is not attached to this session');
  // An auto-fix session delivers only through its gate: the agent cannot open a PR itself.
  const { activeFinding } = await import('./autofix/delivery.ts');
  if (await activeFinding(ctx.workflowId)) {
    await writeEvent(ctx.runId, ctx.projectId, ctx.workflowId, {
      repo: request.repo, repoId: String(resolved.record.id), state: 'failed', base: request.base,
      error: 'An auto-fix session cannot open a pull request itself; the portal delivers the fix after its checks.', errorCode: 'failed',
    });
    return;
  }
  await createPullRequestForSession(ctx.workflowId, String(resolved.record.id), {
    approvedBy: ctx.userId ?? undefined, base: request.base, runId: ctx.runId,
  });
}

// ── The work ──────────────────────────────────────────────────────────────────

/**
 * `via`: 'gate' (the auto-fix gate said go), 'approval' (an Inbox approval) or 'other' (ticket flow, the session's button, a tool).
 * An active auto-fix session's PR is made only via the gate or an approval; any other way is refused (defence in depth).
 */
async function runPullRequest(
  runId: string, w: WorkflowRecord, r: Resolved, start: PrEvent, who: { userId: string | null }, via: 'gate' | 'approval' | 'other',
): Promise<void> {
  // An auto-fix session's PR: its own branch name, title and body, a draft with the autofix label, and the finding is told the outcome.
  const { autofixPrPlan, afterAutofixPullRequest } = await import('./autofix/delivery.ts');
  const plan = await autofixPrPlan(String(w.id), runId);
  if (plan && via === 'other') {
    await writeEvent(runId, String(w.project_id), String(w.id), {
      ...start, state: 'failed', errorCode: 'failed',
      error: 'This auto-fix session is still being delivered through its checks; approve its Inbox question instead.',
    });
    return;
  }
  const outcome = await runPullRequestSteps(runId, w, r, start, who, plan);
  if (plan) await afterAutofixPullRequest(plan.findingId, String(w.id), outcome);
}

async function runPullRequestSteps(
  runId: string, w: WorkflowRecord, r: Resolved, start: PrEvent, who: { userId: string | null }, plan: AutofixPrPlan | null,
): Promise<AutofixPrOutcome> {
  const projectId = String(w.project_id);
  const workflowId = String(w.id);
  const repo = r.record;
  const emitEv = (patch: Partial<PrEvent>): Promise<void> => writeEvent(runId, projectId, workflowId, { ...start, ...patch });
  const ticket = ticketOf(w);
  const title = plan ? plan.title : prTitle(w);
  const settings = getPullRequestSettings(projectId);
  const baseBranch = start.base || repo.default_branch || 'main';
  const engine = (String(w.engine) === 'kiro' ? 'kiro' : String(w.engine) === 'codex' ? 'codex' : 'claude-code') as 'kiro' | 'claude-code' | 'codex';

  // An older Inbox approval must not push while a newer turn is changing the same files.
  const latest = await getSessionsRepository().getLatestRun(workflowId);
  if (latest && ['pending', 'running'].includes(String(latest.status)) && String(latest.id) !== runId) {
    await emitEv({ state: 'failed', error: 'The session is still working. Wait for its current turn to finish, then retry creating the PR.', errorCode: 'failed' });
    return { kind: 'skipped' };
  }

  let branch = start.branch ?? '';
  let pushedSha: string | undefined;
  if (!branch) {
    if (plan?.reuseBranch) {
      // 1a. An auto-fix retry after red CI: the commit goes on top of the open PR's branch (a fast-forward push), so that PR is updated.
      branch = plan.reuseBranch;
    } else {
      // 1. Choose the branch name among the names the remote already has.
      let taken: string[] = [];
      try { taken = await deps.listBranches(repo); } catch { /* the runner and the host still refuse a clash */ }
      branch = branchNameFor({
        ticketKey: ticket?.key ?? null,
        title: ticket?.summary || firstLine(String(w.goal ?? ''), 200) || 'changes',
        taken,
        ...(plan ? { stem: plan.branchStem } : {}),
      });
    }
    // Second enforcement of the protected list (the runner checks it again before pushing).
    if (isProtectedBranch(branch, settings.protectedBranches, repo.default_branch)) {
      await emitEv({
        state: 'failed', branch: undefined,
        error: `The branch name ${branch} is protected, so nothing was pushed.`, errorCode: 'failed',
      });
      return { kind: 'not-opened', error: `the branch name ${branch} is protected` };
    }

    // 2. Ask the runner to commit and push.
    const rt = runtimeFor(engine);
    if (!rt) {
      await emitEv({ state: 'failed', error: 'No cloud runtime is configured to push from.', errorCode: 'failed' });
      return { kind: 'not-opened', error: 'no cloud runtime is configured to push from' };
    }
    // An auto-fix push pins the base: the runner refuses a fetched base that is not the commit read here from the host.
    let baseSha: string | null = null;
    if (plan) {
      const { branchHeadSha } = await import('./pull-requests.ts');
      baseSha = await branchHeadSha(repo, baseBranch);
      if (!baseSha) {
        const error = `The tip of the base branch ${baseBranch} could not be read from the host, so nothing was pushed.`;
        await emitEv({ state: 'failed', branch: undefined, error, errorCode: 'failed' });
        return { kind: 'not-opened', error };
      }
    }
    await emitEv({ state: 'pushing', branch });
    const snapshot = await snapshotAccess(workflowId);
    const payload: Record<string, unknown> = {
      mode: 'finalize', repo: r.runnerName, base: baseBranch, branch,
      message: title, protectedBranches: settings.protectedBranches,
      defaultBranch: repo.default_branch || baseBranch, identity: IDENTITY, env: r.env,
      ...(snapshot ? { snapshot } : {}),
      // An auto-fix push: the runner commits, checks and pushes it from a private repository, fetching the base from and pushing to
      // this URL (never the session repository's own remote configuration), and refuses it when a protected path changed.
      ...(plan ? { denyPaths: plan.denyPaths, remoteUrl: String(repo.url ?? ''), baseSha } : {}),
    };
    let pushed = false;
    let pushError = '';
    let pushCode: ErrorCode | null = null;
    try {
      for await (const raw of invokeAgentCore(rt.arn, agentCoreSessionId(workflowId, engine), payload)) {
        const ev = raw as unknown as Record<string, unknown>;
        if (ev.type === 'repo-pushed' && ev.repo === r.runnerName) {
          if (ev.error) {
            pushError = scrubSecrets(String(ev.error));
            // The runner names the kind of failure itself; only an older runner leaves it to the wording.
            const c = ev.errorCode;
            if (c === 'no-permission' || c === 'no-workspace' || c === 'failed' || c === 'protected-path') pushCode = c;
          }
          else if (ev.sha) { pushed = true; pushedSha = String(ev.sha); }
        } else if (ev.type === 'error') {
          pushError = pushError || scrubSecrets(String(ev.message ?? 'The push failed'));
        }
      }
    } catch (e) {
      pushError = pushError || errText(e);
    }
    if (!pushed && plan && pushCode === 'protected-path') {
      const error = (pushError || 'The runner refused the push: a protected path changed.').slice(0, 500);
      await emitEv({ state: 'failed', branch: undefined, error, errorCode: 'protected-path' });
      return { kind: 'blocked', reason: error, violations: [], repo: String(repo.name ?? '') };
    }
    if (!pushed && plan && /Unknown field: "(denyPaths|remoteUrl|baseSha)"/.test(pushError)) {
      // A runner older than the auto-fix guardrails: fail closed rather than push without the check.
      const error = 'The runner is older than the portal and cannot check protected paths before a push; redeploy the runners. Nothing was pushed.';
      await emitEv({ state: 'failed', branch: undefined, error, errorCode: 'failed' });
      return { kind: 'not-opened', error };
    }
    if (!pushed) {
      const code: ErrorCode = pushCode ?? classifyPushError(pushError);
      const error = code === 'no-permission'
        ? `No permission to push to ${repo.name}. A GitHub token needs repo write access; CodeCommit needs GitPush and CreatePullRequest.`
        : code === 'no-workspace'
          ? "The session's saved files could not be restored, so nothing was pushed."
          : (pushError || 'The push did not complete.').slice(0, 500);
      await emitEv({ state: 'failed', branch: undefined, error, errorCode: code });
      return { kind: 'push-failed', error };
    }
    await emitEv({ state: 'pushed', branch });
  }

  // 3. Protected check again for a retry that reuses a pushed branch, then the pull request.
  if (isProtectedBranch(branch, settings.protectedBranches, repo.default_branch)) {
    await emitEv({ state: 'failed', branch, error: `The branch ${branch} is protected.`, errorCode: 'failed' });
    return { kind: 'not-opened', error: `the branch ${branch} is protected`, branch };
  }
  if (plan) {
    // The server's own check of what was pushed (the runner shares its machine with the agent): the file list from the host.
    const { verifyPushedBranch } = await import('./autofix/delivery.ts');
    const verdict = await verifyPushedBranch(plan.findingId, repo, baseBranch, branch);
    if (!verdict.ok) {
      const deleted = await deleteRemoteBranch(repo, branch).catch(() => false);
      const error = `${verdict.reason}. ${deleted ? `The branch ${branch} was deleted` : `Delete the branch ${branch}`}; no pull request was opened.`.slice(0, 500);
      await emitEv({ state: 'failed', branch: undefined, error, errorCode: 'protected-path' });
      return { kind: 'blocked', reason: verdict.reason, violations: verdict.violations, repo: String(repo.name ?? ''), branch };
    }
  }
  if (plan?.reuseBranch && plan.existingPr && await githubPullRequestState(repo, plan.existingPr.number) !== 'closed') {
    // The retry's push updated the open PR: nothing more to open, and its review was started when it was opened.
    const { number, url } = plan.existingPr;
    await emitEv({ state: 'opened', branch, number, url, title });
    return { kind: 'opened', number, url, branch, repo: String(repo.name ?? ''), ...(pushedSha ? { sha: pushedSha } : {}) };
  }
  let created: { number: number; url: string };
  try {
    created = await createPullRequest({
      repo, base: baseBranch, head: branch, title, body: plan ? plan.body : await prBody(w),
      ...(plan ? { draft: plan.draft, labels: plan.labels } : {}),
    });
  } catch (e) {
    const code: ErrorCode = e instanceof PullRequestError ? e.code : 'failed';
    const error = code === 'unsupported'
      ? `Pull requests on ${repo.provider} are not supported yet. The branch ${branch} was pushed.`
      : `The branch ${branch} was pushed, but the pull request could not be opened: ${errText(e)}`;
    await emitEv({ state: 'failed', branch, error, errorCode: code });
    return { kind: 'not-opened', error, branch };
  }
  await emitEv({ state: 'opened', branch, number: created.number, url: created.url, title });
  const opened: AutofixPrOutcome = {
    kind: 'opened', number: created.number, url: created.url, branch, repo: String(repo.name ?? ''), ...(pushedSha ? { sha: pushedSha } : {}),
  };

  // 4. A draft review of the new pull request. The pull request stays when this fails.
  try {
    const reviewer = who.userId || (w.created_by ? String(w.created_by) : '');
    if (!reviewer) throw new Error('No user to start the review as');
    // The project may name the engine and model that review its pull requests; the reviewer's own sign-in for that engine is used.
    const { reviewEngine, reviewModel } = getPullRequestSettings(projectId);
    let credentialId: string | null = null;
    if (reviewEngine) {
      const { credentialIdForEngine } = await import('./create-ai.ts');
      credentialId = await credentialIdForEngine(reviewer, reviewEngine);
      if (!credentialId) throw new Error(`This project reviews pull requests with ${reviewEngine === 'claude-code' ? 'Claude' : reviewEngine === 'kiro' ? 'Kiro' : 'Codex'}, but you have no such sign-in (Agent setup › Sign-ins).`);
    }
    const review = await createReview({
      projectId, userId: reviewer, repoId: String(repo.id), baseRef: baseBranch, headRef: branch,
      prNumber: created.number, jiraKey: ticket?.key ?? null, postMode: 'draft',
      ...(credentialId ? { credentialId, model: reviewModel } : {}),
    });
    await emitEv({ state: 'review-started', branch, number: created.number, url: created.url, title, reviewId: review.id });
  } catch (e) {
    const error = e instanceof ReviewCreateError ? e.message : errText(e);
    await emitEv({ state: 'review-failed', branch, number: created.number, url: created.url, title, error });
  }
  return opened;
}

// ── Flag for the run payload ──────────────────────────────────────────────────

/**
 * Value of `finalizeCheck` in a run payload: ask the runner to report changed repositories. An auto-fix session (`workflowId`) always
 * asks, since its delivery does not depend on the project's setting.
 */
export async function finalizeRunPayloadFlag(projectId: string, hasTicket: boolean, workflowId?: string | null): Promise<boolean> {
  if (hasTicket || getPullRequestSettings(projectId).openPullRequests) return true;
  if (!workflowId) return false;
  const { isAutofixWorkflow } = await import('./autofix/delivery.ts');
  return isAutofixWorkflow(workflowId).catch(() => false);
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function registerSessionPullRequestRoutes(): void {
  router.post('/api/sessions/:workflowId/pull-request', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const workflowId = req.params.workflowId;
    const w = await getSessionsRepository().getWorkflowById(workflowId);
    if (!w || !w.project_id) { sendJson(res, 404, { error: 'Session not found' }); return; }
    if (!req.user.is_admin) {
      const member = await getMembership(String(w.project_id), String(req.user.id));
      if (!member) { sendJson(res, 403, { error: 'Not a project member' }); return; }
      if (!['editor', 'owner'].includes(String(member.access ?? ''))) { sendJson(res, 403, { error: 'Project editor access required' }); return; }
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const repoId = typeof body.repoId === 'string' ? body.repoId : '';
    if (!repoId || !repoIdsOf(w).includes(repoId)) { sendJson(res, 404, { error: 'Repository not found in this session' }); return; }
    const rec = await getGitReposRepository().getById(repoId);
    if (!rec || String(rec.project_id) !== String(w.project_id)) { sendJson(res, 404, { error: 'Repository not found in this session' }); return; }

    const prior = await sessionPullRequestStatus(workflowId, repoId);
    if (prior && OPENED_STATES.includes(prior.state) && await stillOpen(prior, rec as unknown as Repository)) {
      sendJson(res, 409, { error: 'A pull request is already open for this repository in this session.' });
      return;
    }
    if ((await getAutofixFindingsRepository().getByWorkflowId(workflowId))?.status === 'fixing') {
      sendJson(res, 409, { error: 'This auto-fix session is being delivered through its checks. Use its Inbox question to approve the pull request.' });
      return;
    }
    void createPullRequestForSession(workflowId, repoId, { approvedBy: String(req.user.id) });
    sendJson(res, 202, { ok: true });
  });
}
