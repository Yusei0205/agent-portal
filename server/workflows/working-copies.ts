/** Rescue routes: list the working copies of a session, attach a repository and push a copy by hand. */
import path from 'node:path';
import fs from 'node:fs';
import { all, run as exec, type Row } from '../db.ts';
import { get, post } from '../http.ts';
import { getProject, projectDir, requireProject } from '../projects.ts';
import { getRepo, repoGitEnv, checkBranch, openPullRequest } from '../repos.ts';
import { isActive } from '../agent/runner.ts';
import { badRequest, now, parseJson, str } from '../util.ts';
import { isSharedBranch } from '../runs.ts';
import { git, redact } from '../git.ts';
import { driving, getWorkflow, log } from './store.ts';
import { sessionRepos, view } from './views.ts';
import { deriveBranchName } from './push.ts';

export function registerWorkingCopyRoutes(): void {
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
