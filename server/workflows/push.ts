/** Agent pushes: the portal pushes a session branch when the agents ask and a person allows it. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as exec, type Row } from '../db.ts';
import { post } from '../http.ts';
import { getProject, projectDir, requireProject } from '../projects.ts';
import { getRepo, checkBranch, repoDir } from '../repos.ts';
import { getRun } from '../agent/runner.ts';
import { HttpError, badRequest, now, parseJson, str } from '../util.ts';
import { pushRun, isSharedBranch } from '../runs.ts';
import { runRepos } from '../agent/runner.ts';
import { git } from '../git.ts';
import { driving, getWorkflow, patch, log } from './store.ts';
import { sessionRepos, view } from './views.ts';
import { stopWith } from './lifecycle.ts';
import { kick } from './driver.ts';

export interface PushRequest {
  message: string;
  pr: boolean;
  /** The branch the pull request goes into, when the agents named one; otherwise each repository's starting branch. */
  base?: string;
  runId: string;
  branch: string;
  /** What the agent reported with the request, so approving can finish a session that was done. */
  state: string;
  at: string;
  /** The working copies' content when the agents asked (worktreeFingerprint), so a person allows exactly that. */
  tree?: string;
}

/**
 * The content of a run's working copies, as one string: for each, the git tree of everything in it (committed or not,
 * except ignored files), written through a throw-away index so the working copy itself is not touched.
 */
export async function worktreeFingerprint(run: Row): Promise<string> {
  const pdir = projectDir(getProject(run.project_id));
  const parts: string[] = [];
  for (const x of runRepos(run)) {
    const dir = path.join(pdir, x.worktree);
    const index = path.join(os.tmpdir(), `portal-index-${randomUUID()}`);
    try {
      const env = { GIT_INDEX_FILE: index };
      await git(['read-tree', 'HEAD'], { cwd: dir, env });
      await git(['add', '-A'], { cwd: dir, env });
      parts.push(`${x.repoId}:${(await git(['write-tree'], { cwd: dir, env })).stdout.trim()}`);
    } finally {
      fs.rmSync(index, { force: true });
    }
  }
  return parts.join(',');
}

/** Push every working copy of a session's run to its new branch; the results go into the history. */
export async function pushForSession(w: Row, req: PushRequest, by: string) {
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
export function pushBlocker(w: Row, lastCheck: { ok: boolean } | null): string {
  if (!sessionRepos(w).length) return 'this session has no repository';
  if (lastCheck && !lastCheck.ok) return 'the check failed';
  return '';
}

/**
 * Called by the trusted-push handler when an agent runs `git push` in a trust_tools session.
 * Validates the branch, performs the push via pushRun, records a history event, and returns a
 * human-readable result string for the agent.
 */
export async function performTrustedPush(workflowId: string, requestedBranch: string | null): Promise<string> {
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
export function deriveBranchName(w: Row): string {
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

export function registerPushRoutes(): void {
  // A person allows the push the agents asked for: the portal pushes, then the session finishes or carries on.
  post('/api/workflows/:id/push/allow', async (ctx) => {
    const w = getWorkflow(ctx.params.id);
    requireProject(ctx, w.project_id, 'editor');
    const req = w.pending_push ? parseJson<PushRequest | null>(w.pending_push, null) : null;
    if (!req) throw badRequest('This session is not waiting for a push');
    if (w.status === 'running' || driving.has(w.id)) throw badRequest('Wait for the current iteration to finish');
    // Allowing a push allows what the agents asked to push. If the working copy changed since (a follow-up run, say),
    // the person has not seen what would go out.
    if (req.tree && (await worktreeFingerprint(getRun(req.runId)).catch(() => '')) !== req.tree) {
      throw new HttpError(409, 'The working copy changed after the agents asked to push. Review the changes again, then push from the Changes tab, or deny this and let the agents ask again.');
    }
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
}
