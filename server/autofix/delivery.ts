/**
 * Auto-fix delivery: how a fix session's change reaches a pull request through the existing session PR flow (session-pr.ts).
 *
 *  - autofixGate: called by session-pr's handleOne for every reported repository change. It acts only for a session that belongs to
 *    a finding in 'fixing' while the project's mode is not 'off' (otherwise null: the ordinary session flow, unchanged).
 *      wait   the run's loop check did not pass (or there was none): nothing yet; the loop goes on, or the pipeline counts the attempt
 *      block  the diff touches a protected path: needs_human, an audit entry and a 'blocked' Inbox item; nothing is pushed
 *      ask    propose mode, or draft_pr with a large diff, an unknown file list (older runner) or a list too big to check, or while
 *             paused: the ordinary 'push' Inbox question, marked payload.kind 'autofix'
 *      go     draft_pr with a clean diff: push and open a draft PR at once (the project's "open pull requests" setting is not consulted:
 *             draft_pr is the admin's explicit opt-in)
 *  - autofixPrPlan: the branch (`autofix/<kind>-<fp8>`), title, body, draft flag and label of the PR, used by runPullRequest on both
 *    the 'go' path and the Inbox approval path. A retry after red CI (pipeline.ts applyCiResult) reuses the finding's PR branch and,
 *    while that PR is open, updates it instead of opening another.
 *  - afterAutofixPullRequest: links an opened PR to the finding (pr_open) or accounts for a failed push / unopened PR.
 */

import { getAutofixFindingsRepository } from '../repositories/autofix-findings.ts';
import type { AutofixFinding } from '../repositories/autofix-findings.ts';
import { getAuditRepository } from '../repositories/audit.ts';
import { getLoopSpecsRepository } from '../repositories/loop-specs.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { listBranchFiles, listTreeDifference, scrubSecrets } from '../pull-requests.ts';
import { readCheckResult } from '../workflows/loop.ts';
import { formatCheckResult } from '../agent/runner-checks.ts';
import type { RepoChange, SessionPrContext } from '../session-pr.ts';
import { getAutofixPolicy, isPaused } from './policy.ts';
import type { AutofixPolicy } from './policy.ts';
import { checkDiff, DEPS_LOCKFILE_GLOBS } from './guardrails.ts';
import type { DiffFile } from './guardrails.ts';
import type { Repository } from '../repos.ts';
import { scrubEvidence } from './scrub.ts';
import { AUTOFIX_SPEC_BY_SOURCE, recordFailedAttempt, toNeedsHuman } from './pipeline.ts';

export type GateDecision = 'go' | 'ask' | 'block' | 'wait';

/**
 * checkDiff's glob matching grows with the square of a path's segment count, so a list longer than this, or any path longer than
 * MAX_GATE_PATH_CHARS, is not checked: it is treated as large (a person is asked; it never goes ahead on its own).
 */
export const MAX_GATE_FILES = 2000;
export const MAX_GATE_PATH_CHARS = 1024;

const PR_LABELS = ['autofix'];
const BODY_EVIDENCE_MAX = 6000;
const BODY_CHECK_MAX = 6000;

let checkDiffFn: typeof checkDiff = checkDiff;
/** Test seam: replace checkDiff (to see whether it was called). Call with null to restore it. */
export function _setCheckDiffForTest(fn: typeof checkDiff | null): void { checkDiffFn = fn ?? checkDiff; }

// ── Names and text ───────────────────────────────────────────────────────────

/** `autofix/<kind>-<first 8 of fingerprint>`, lowercase and always a valid branch name. */
export function fixBranchName(kind: string, fingerprint: string): string {
  const k = String(kind ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'fix';
  const fp = String(fingerprint ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || '00000000';
  return `autofix/${k}-${fp}`;
}

/** One line, no backticks: for a value from a webhook that is shown inside inline code. */
function inline(text: string | null | undefined, max = 100): string {
  return scrubSecrets(String(text ?? '')).replace(/[`\r\n]+/g, ' ').trim().slice(0, max);
}

/** A fenced block whose fence is longer than any backtick run in the text, so the text cannot close it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

export function prTitleFor(f: AutofixFinding): string {
  if (f.source === 'review_finding') return `Auto-fix: review finding${f.branch ? ` on ${inline(f.branch, 60)}` : ''}`;
  return `Auto-fix: ${inline(f.kind, 40) || 'failure'} failure${f.branch ? ` on ${inline(f.branch, 60)}` : ''}`;
}

/**
 * The PR body: what failed, links to the finding and the session, the scrubbed evidence and the last loop check output. The existing
 * session PR flow has no PR template support, so neither does this (plain sections). No raw webhook text beyond the scrubbed evidence.
 */
export function buildPrBody(f: AutofixFinding, checkOutput: string): string {
  const lines: string[] = [];
  lines.push(`Auto-fix for a \`${inline(f.kind, 40) || 'failure'}\` failure${f.branch ? ` on \`${inline(f.branch)}\`` : ''} (${inline(f.source, 40)}).`, '');
  lines.push(`Finding: ${f.id}`);
  const pub = (process.env.PORTAL_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (pub && /^https?:\/\//i.test(pub) && f.workflow_id) lines.push(`Session: ${pub}/#/p/${f.project_id}/sessions/${f.workflow_id}`);
  else if (f.workflow_id) lines.push(`Session: ${f.workflow_id}`);
  lines.push('', '### Evidence', '', fenced(scrubEvidence(f.evidence || '(none)', BODY_EVIDENCE_MAX)));
  lines.push('', '### Last check output', '', fenced(scrubEvidence(checkOutput || '(no check output)', BODY_CHECK_MAX)));
  lines.push('', 'Opened as a draft by Agent Portal auto-fix. Review the change before marking it ready.');
  return lines.join('\n');
}

// ── Which sessions are auto-fix sessions ─────────────────────────────────────

/** The finding this session is fixing, while it is 'fixing' and auto-fix is not off for its project. */
export async function activeFinding(workflowId: string): Promise<{ finding: AutofixFinding; policy: AutofixPolicy } | null> {
  const f = await getAutofixFindingsRepository().getByWorkflowId(workflowId);
  if (!f || f.status !== 'fixing' || f.workflow_id !== workflowId) return null;
  const policy = await getAutofixPolicy(f.project_id);
  if (policy.mode === 'off') return null;
  return { finding: f, policy };
}

/**
 * Whether the runner should report this session's repository changes although the project does not open PRs and there is no ticket:
 * true for a fix session. The finding is linked to the session only after the session started, so the fixer spec's latest loop run
 * (written before the session starts) is checked too.
 */
export async function isAutofixWorkflow(workflowId: string): Promise<boolean> {
  const f = await getAutofixFindingsRepository().getByWorkflowId(workflowId);
  if (f) return (f.status === 'triaged' || f.status === 'fixing') && (await getAutofixPolicy(f.project_id)).mode !== 'off';
  for (const specId of new Set(Object.values(AUTOFIX_SPEC_BY_SOURCE))) {
    if (!specId) continue;
    const last = await getLoopSpecsRepository().getLastRunBySpec(specId);
    if (last?.last_workflow_id === workflowId) return true;
  }
  return false;
}

/** How many parent sessions are walked up to find the auto-fix session a delegated child belongs to. */
const AUTOFIX_PARENT_DEPTH = 3;
/** How many of each fixer spec's latest loop runs are scanned for a session id (bounded). */
const AUTOFIX_RUNS_SCANNED = 500;

/**
 * The session and its parents (delegated sessions inherit the repositories), at most AUTOFIX_PARENT_DEPTH levels up. A missing
 * session, or a cycle, ends the walk.
 */
async function selfAndParents(workflowId: string): Promise<string[]> {
  const ids = [workflowId];
  let cur = workflowId;
  for (let i = 0; i < AUTOFIX_PARENT_DEPTH; i++) {
    const w = await getSessionsRepository().getWorkflowById(cur);
    const parent = w?.parent_id ? String(w.parent_id) : '';
    if (!parent || ids.includes(parent)) break;
    ids.push(parent);
    cur = parent;
  }
  return ids;
}

/**
 * Whether a session is (or was) an auto-fix session, whatever its finding's status and the project's mode: a finding has this
 * workflow_id in any status, or a loop run of a fixer spec started it (an earlier session of a finding that was retried: the retry
 * overwrote the finding's workflow_id). A session delegated from one (up to AUTOFIX_PARENT_DEPTH levels) counts too. Such a session
 * never takes the ordinary (unchecked) push: only an ACTIVE fix session delivers, through its gate (autofixPrPlan).
 * `finding` is the finding found by workflow id (null when only a loop run names the session).
 */
export async function autofixSessionInfo(workflowId: string): Promise<{ finding: AutofixFinding | null; delegated: boolean } | null> {
  const ids = await selfAndParents(workflowId);
  const findings = getAutofixFindingsRepository();
  for (const id of ids) {
    const f = await findings.getByWorkflowId(id);
    if (f) return { finding: f, delegated: id !== workflowId };
  }
  const wanted = new Set(ids);
  for (const specId of new Set(Object.values(AUTOFIX_SPEC_BY_SOURCE))) {
    if (!specId) continue;
    const runs = await getLoopSpecsRepository().listRunsBySpec(specId, AUTOFIX_RUNS_SCANNED);
    const hit = runs.find((r) => r.last_workflow_id && wanted.has(r.last_workflow_id));
    if (hit) return { finding: null, delegated: hit.last_workflow_id !== workflowId };
  }
  return null;
}

/** True for an auto-fix session in any state, an earlier session of a retried finding, or a session delegated from one. */
export async function autofixSessionOf(workflowId: string): Promise<boolean> {
  return (await autofixSessionInfo(workflowId)) !== null;
}

/**
 * The reason shown when an auto-fix session (see autofixSessionOf) that is not the active fix session of its finding would push: null
 * for any other session (the ordinary flow applies).
 */
export async function autofixPushRefusal(workflowId: string): Promise<string | null> {
  const info = await autofixSessionInfo(workflowId);
  if (!info) return null;
  const f = info.finding;
  let what: string;
  if (info.delegated) what = 'This session was delegated from an auto-fix session, which delivers its fix only through its own checks';
  else if (!f || f.workflow_id !== workflowId) what = "This auto-fix session's finding is now handled by a later session";
  else if (f.status === 'fixing') what = "This auto-fix session's finding is fixing, but auto-fix is off for the project";
  else what = `This auto-fix session's finding is ${f.status.replace(/_/g, ' ')}`;
  return `${what}; nothing was pushed. Use Retry on the Auto-fix tab.`;
}

// ── The gate ─────────────────────────────────────────────────────────────────

async function audit(action: string, target: string, detail: object): Promise<void> {
  try {
    await getAuditRepository().append({ actorId: null, action, target, detail, ip: null });
  } catch (e) {
    console.error(`[autofix] audit ${action} failed:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Whether the portal may push an auto-fix branch without a person approving it: only when its operator set
 * AUTOFIX_ALLOW_UNATTENDED_PUSH=1 on the portal server process. Default: no, every push is asked in the Inbox (draft_pr mode still
 * works end to end, with an approval).
 *
 * Why: the fix agent and the runner run as the same user in the same microVM. A process the agent leaves behind can race the runner's
 * checks or read the push credentials from /proc while git runs, and the portal's own check of the pushed branch happens after the
 * push, when a push-triggered workflow may already have run with the repository's secrets. Turning this on additionally requires the
 * runners redeployed from this version, the agent's processes killed (or run as another user) before credentialed git calls, and a
 * repository ruleset restricting pushes to `.github/workflows/**` and tags.
 */
export function unattendedPushAllowed(): boolean {
  return process.env.AUTOFIX_ALLOW_UNATTENDED_PUSH === '1';
}

/** The note added to the Inbox question when the change would otherwise have been pushed unattended. */
export const UNATTENDED_DISABLED_NOTE = 'Unattended push is disabled on this portal; approve to push.';

/**
 * Decide what happens to one repository change of a session. Null when the session is not an active auto-fix session (the caller
 * goes on as for any session). Side effects here are on the finding only; the PR flow (Inbox item, push) is the caller's.
 */
export async function autofixGate(ctx: SessionPrContext, change: RepoChange): Promise<GateDecision | null> {
  const active = await activeFinding(ctx.workflowId);
  if (!active) return null;
  const { finding: f, policy } = active;

  // Only the change of a run whose loop check passed is delivered; a later iteration reports the whole change again. The engine's
  // in-memory result comes first: on DynamoDB the stored check-result event is written asynchronously and may not be there yet.
  const checkOk = ctx.check !== undefined ? ctx.check?.ok === true : (await readCheckResult(ctx.workflowId, ctx.runId))?.ok === true;
  if (!checkOk) return 'wait';

  const paths = Array.isArray(change.paths) ? change.paths : null;
  const oversize = paths !== null && (paths.length > MAX_GATE_FILES || paths.some((p) => String(p.path).length > MAX_GATE_PATH_CHARS));
  let large = paths === null || oversize;
  if (paths !== null && !oversize) {
    const r = checkDiffFn(paths, policy, f.kind);
    if (!r.ok) {
      const reason = `the fix touches a protected path: ${r.violations[0]}`.slice(0, 300);
      await toNeedsHuman(f, ['fixing'], reason, {}, ctx.workflowId);
      await audit('autofix.pr.blocked', f.id, { repo: change.repo, violations: r.violations.slice(0, 20) });
      return 'block';
    }
    large = r.large;
  }

  const clear = policy.mode === 'draft_pr' && !large && !(await isPaused(f.project_id));
  // Downgraded to a person's approval unless the operator allowed unattended pushes (see unattendedPushAllowed).
  const decision: GateDecision = clear && unattendedPushAllowed() ? 'go' : 'ask';
  // Recorded before anything else, so the pipeline sees at the session's end that delivery began (see onFixSessionEnded).
  await getAutofixFindingsRepository().transition(f.id, ['fixing'], { status: 'fixing', fix_branch: f.pr_branch ?? fixBranchName(f.kind, f.fingerprint) });
  return decision;
}

/** Why a person is asked, for the Inbox question. */
export async function askReason(ctx: SessionPrContext, change: RepoChange): Promise<string> {
  const active = await activeFinding(ctx.workflowId);
  if (!active) return '';
  if (active.policy.mode === 'propose') return 'The project proposes auto-fixes for approval.';
  if (!Array.isArray(change.paths)) return 'The runner did not report the changed files, so the diff could not be checked.';
  if (change.paths.length > MAX_GATE_FILES || change.paths.some((p) => String(p.path).length > MAX_GATE_PATH_CHARS)) {
    return 'The change is too large to check automatically.';
  }
  if (await isPaused(active.finding.project_id)) return 'Auto-fix is paused.';
  if (!checkDiffFn(change.paths, active.policy, active.finding.kind).large) return UNATTENDED_DISABLED_NOTE;
  return `The change is larger than the auto-fix limits (${active.policy.limits.max_files} files, ${active.policy.limits.max_lines} lines).`;
}

// ── The pull request ─────────────────────────────────────────────────────────

export interface AutofixPrPlan {
  findingId: string;
  /** The branch name before the clash rule (`-2`, `-3`, ...) of branchNameFor. */
  branchStem: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
  /** Sent to the runner's finalize: globs no pushed file may match (the policy's protected paths, as checkDiff applies them). */
  denyPaths: string[];
  /** A retry after red CI: push to this branch (the finding's PR branch) instead of choosing a new name. */
  reuseBranch?: string;
  /** The PR already open from reuseBranch: when it is still open, the push updates it and no PR is created. */
  existingPr?: { number: number; url: string };
  /**
   * The PR's base instead of the reported one: for a review fix, the reviewed PR's head branch (a stacked PR). The push still goes
   * only to the autofix/ branch; the reviewed branch is never pushed to.
   */
  base?: string;
}

/** The protected paths as checkDiff applies them for this kind: a 'deps' fix may touch the lockfiles (and only those globs are dropped). */
export function denyPathsFor(policy: AutofixPolicy, kind: string): string[] {
  return policy.protected_paths.filter((g) => !(kind === 'deps' && DEPS_LOCKFILE_GLOBS.has(g)));
}

/** How runPullRequest opens the PR of an active auto-fix session (null for any other session). */
export async function autofixPrPlan(workflowId: string, runId: string): Promise<AutofixPrPlan | null> {
  const active = await activeFinding(workflowId);
  if (!active) return null;
  const f = active.finding;
  const check = await readCheckResult(workflowId, runId).catch(() => null);
  return {
    findingId: f.id,
    branchStem: fixBranchName(f.kind, f.fingerprint),
    title: prTitleFor(f),
    body: buildPrBody(f, check ? formatCheckResult(check) : ''),
    draft: true,
    labels: [...PR_LABELS],
    denyPaths: denyPathsFor(active.policy, f.kind),
    ...(f.pr_branch ? { reuseBranch: f.pr_branch } : {}),
    ...(f.pr_branch && f.pr_number != null && f.pr_url ? { existingPr: { number: f.pr_number, url: f.pr_url } } : {}),
    ...(f.source === 'review_finding' && f.branch ? { base: f.branch } : {}),
  };
}

/**
 * The server's own check of a pushed auto-fix branch, before its PR is opened: the file lists from the host, not from the runner,
 * through checkDiff. Two lists: the GitHub compare API (three-dot, what the branch changed since the merge base; caps and protected
 * paths) and the tree difference between the base TIP and the branch head (two-dot; protected paths only), so a protected file the
 * base deleted or changed since the fork cannot ride along. Fails closed: a list that cannot be read, may be cut, is over the caps, or
 * touches a protected path is a violation.
 *
 * This runs AFTER the push (the runner pushes before the portal can look): a workflow triggered by the push itself may already have
 * run. The runner's own check before the push is the first line; a repository ruleset restricting pushes to `.github/workflows/**` is
 * the independent control.
 */
export async function verifyPushedBranch(findingId: string, repo: Repository, base: string, branch: string): Promise<{ ok: true } | { ok: false; reason: string; violations: string[] }> {
  const f = await getAutofixFindingsRepository().getById(findingId);
  if (!f) return { ok: false, reason: 'the finding is gone', violations: [] };
  const listed = await listBranchFiles(repo, base, branch);
  if (!listed.ok) return { ok: false, reason: `the pushed files could not be checked: ${listed.reason}`, violations: [] };
  const files: DiffFile[] = listed.files;
  if (files.length > MAX_GATE_FILES || files.some((p) => p.path.length > MAX_GATE_PATH_CHARS)) {
    return { ok: false, reason: 'the pushed change is too large to check', violations: [] };
  }
  const policy = await getAutofixPolicy(f.project_id);
  const r = checkDiffFn(files, policy, f.kind);
  if (!r.ok) return { ok: false, reason: `the pushed branch touches a protected path: ${r.violations[0]}`, violations: r.violations };
  const tree = await listTreeDifference(repo, base, branch);
  if (!tree.ok) return { ok: false, reason: `the pushed branch could not be compared with the tip of ${base}: ${tree.reason}`, violations: [] };
  if (tree.files.some((p) => p.path.length > MAX_GATE_PATH_CHARS)) return { ok: false, reason: 'the pushed branch has a path too long to check', violations: [] };
  // Size does not matter here (the base may have moved a lot since the fork); protected paths and control characters do.
  const t = checkDiffFn(tree.files, policy, f.kind);
  if (!t.ok) {
    return {
      ok: false, violations: t.violations,
      reason: `the pushed branch differs from the tip of ${base} in a protected path: ${t.violations[0]} (rebase the fix on the base branch)`,
    };
  }
  return { ok: true };
}

export type AutofixPrOutcome =
  /** `sha`: the commit the runner pushed (absent when no push happened in this call), recorded as the PR head CI is judged against. */
  | { kind: 'opened'; number: number; url: string; branch: string; repo: string; sha?: string }
  /** The runner did not push (permission, workspace, git): one attempt more, as for a failed fix. */
  | { kind: 'push-failed'; error: string }
  /** Nothing went wrong with the fix, but no PR was opened (protected branch name, no runtime, host refused the PR). */
  | { kind: 'not-opened'; error: string; branch?: string }
  /** A retry could not deliver to its PR (the PR was closed, or the pushed branch could not be checked): needs_human with the reason. */
  | { kind: 'needs-human'; reason: string }
  /** Not attempted (a newer turn is running): the finding is left as it is. */
  | { kind: 'skipped' }
  /** A protected path (refused by the runner before the push, or found by the server's check after it): needs_human, audited. */
  | { kind: 'blocked'; reason: string; violations: string[]; repo: string; branch?: string };

/** Record the outcome of runPullRequest for an auto-fix session on its finding. Never throws. */
export async function afterAutofixPullRequest(findingId: string, workflowId: string, outcome: AutofixPrOutcome): Promise<void> {
  try {
    if (outcome.kind === 'skipped') return;
    const repo = getAutofixFindingsRepository();
    const f = await repo.getById(findingId);
    if (!f || f.status !== 'fixing') return;
    if (outcome.kind === 'opened') {
      const linked = await repo.transition(f.id, ['fixing'], {
        status: 'pr_open', pr_number: outcome.number, pr_url: outcome.url, fix_branch: outcome.branch, pr_branch: outcome.branch,
        pr_head_sha: outcome.sha ?? null,
      });
      if (linked) await audit('autofix.pr.opened', f.id, { prNumber: outcome.number, repo: outcome.repo });
      return;
    }
    if (outcome.kind === 'blocked') {
      await toNeedsHuman(f, ['fixing'], outcome.reason.slice(0, 300), { fix_branch: null }, workflowId);
      await audit('autofix.pr.blocked', f.id, {
        repo: outcome.repo, violations: outcome.violations.slice(0, 20), reason: outcome.reason.slice(0, 300),
        ...(outcome.branch ? { deletedBranch: outcome.branch } : {}),
      });
      return;
    }
    if (outcome.kind === 'needs-human') {
      await toNeedsHuman(f, ['fixing'], outcome.reason, {}, workflowId);
      return;
    }
    if (outcome.kind === 'push-failed') {
      await recordFailedAttempt(f, ['fixing'], await getAutofixPolicy(f.project_id), { fix_branch: null }, workflowId);
      return;
    }
    await toNeedsHuman(f, ['fixing'], `the pull request was not opened: ${outcome.error}`.slice(0, 300),
      outcome.branch ? { fix_branch: outcome.branch } : {}, workflowId);
  } catch (e) {
    console.error('[autofix] recording the pull request outcome failed:', e instanceof Error ? e.message : e);
  }
}

/** A person declined the auto-fix PR in the Inbox: the finding goes to needs_human (no second Inbox item: they just decided). */
export async function onAutofixPullRequestDeclined(workflowId: string): Promise<void> {
  try {
    const active = await activeFinding(workflowId);
    if (!active) return;
    if (await getAutofixFindingsRepository().transition(active.finding.id, ['fixing'], { status: 'needs_human' })) {
      await audit('autofix.pr.declined', active.finding.id, {});
    }
  } catch (e) {
    console.error('[autofix] recording the declined pull request failed:', e instanceof Error ? e.message : e);
  }
}
