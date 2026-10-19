import fs from 'node:fs';
import path from 'node:path';
import { all, one, run as exec, type Row } from './db.ts';
import { del, get, post, openSse, HANDLED } from './http.ts';
import { getProject, projectDir, requireProject } from './projects.ts';
import { getRepo, githubApi, githubSlug, pushWorktree, removeWorktree, checkBranch } from './repos.ts';
import { HttpError, badRequest, notFound, parseJson, safeJoin, str } from './util.ts';
import { runChannel, subscribe } from './events.ts';
import { git } from './git.ts';
import { answerInput, getRun, inputView, isActive, oneshot, runSummary, startRun, stopRun } from './agent/runner.ts';
import { PRICES } from './agent/pricing.ts';
import { providerMode } from './settings.ts';

const MODEL_CHOICES = ['haiku', 'sonnet', 'opus'];

function runAccess(ctx: any, runId: string, min: 'viewer' | 'editor' = 'viewer'): Row {
  const r = getRun(runId);
  requireProject(ctx, r.project_id, min);
  return r;
}

function events(runId: string, after = 0) {
  return all<Row>('SELECT seq, ts, type, parent_tool_use_id AS parent, data FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq', runId, after).map((e) => ({
    ...e,
    data: parseJson(e.data, {}),
  }));
}

export function registerRunRoutes(): void {
  get('/api/meta', () => ({ provider: providerMode(), prices: PRICES, models: MODEL_CHOICES }));

  get('/api/projects/:pid/runs', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const kinds = (ctx.query.get('kind') || 'chat,test,review').split(',').filter(Boolean);
    const rows = all<Row>(
      `SELECT r.*, u.name AS created_by_name FROM runs r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.project_id = ? AND r.kind IN (${kinds.map(() => '?').join(',')})
        ORDER BY r.created_at DESC LIMIT ?`,
      project.id,
      ...kinds,
      Math.min(Number(ctx.query.get('limit') || 50), 200),
    );
    return { runs: rows.map((r) => ({ ...runSummary(r), created_by_name: r.created_by_name, repo_id: r.repo_id, branch: r.branch })) };
  });

  post('/api/projects/:pid/runs', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const prompt = str(body.prompt, 'Prompt', { max: 50_000 }).trim();
    if (!prompt) throw badRequest('Describe what the agent should do');
    const model = body.model && MODEL_CHOICES.includes(body.model) ? body.model : 'sonnet';
    const mode = ['default', 'acceptEdits', 'plan'].includes(body.permissionMode) ? body.permissionMode : undefined;
    let repoId: string | null = null;
    let branch: string | null = null;
    if (body.repoId) {
      const repo = getRepo(String(body.repoId));
      if (repo.project_id !== project.id) throw badRequest('That repository belongs to another project');
      repoId = repo.id;
      branch = body.branch ? checkBranch(body.branch) : repo.default_branch;
    }
    const { run } = await startRun({
      projectId: project.id,
      userId: ctx.user!.id,
      kind: 'chat',
      title: str(body.title, 'Title', { max: 200, optional: true }).trim() || prompt.split('\n')[0].slice(0, 100),
      prompt,
      repoId,
      branch,
      permissionMode: mode,
      model,
    });
    return { run: runSummary(run) };
  });

  get('/api/runs/:id', (ctx) => {
    const r = runAccess(ctx, ctx.params.id);
    return {
      run: { ...runSummary(r), prompt: r.prompt, result: r.result, error: r.error, worktree: r.worktree, branch: r.branch, repo_id: r.repo_id, permission_mode: r.permission_mode, session_id: r.session_id, resume_of: r.resume_of, started_at: r.started_at },
      events: events(r.id),
      inputs: all('SELECT * FROM inputs WHERE run_id = ? ORDER BY created_at', r.id).map(inputView),
      active: isActive(r.id),
      continuations: all('SELECT id, title, status, created_at FROM runs WHERE resume_of = ? ORDER BY created_at', r.id),
    };
  });

  get('/api/runs/:id/stream', (ctx) => {
    const r = runAccess(ctx, ctx.params.id);
    const after = Number(ctx.query.get('after') || 0);
    const sse = openSse(ctx);
    // Subscribe first, then replay, so nothing falls in the gap; the client ignores duplicate seq numbers.
    sse.onClose(subscribe(runChannel(r.id), (event, data) => sse.send(event, data)));
    for (const e of events(r.id, after)) sse.send('event', e);
    sse.send('run', runSummary(getRun(r.id)));
    return HANDLED;
  });

  post('/api/runs/:id/stop', (ctx) => {
    const r = runAccess(ctx, ctx.params.id, 'editor');
    if (!stopRun(r.id)) {
      if (['queued', 'running', 'waiting'].includes(r.status)) {
        exec("UPDATE runs SET status = 'stopped', error = 'Stopped by a user' WHERE id = ?", r.id);
      }
    }
    return { ok: true };
  });

  post('/api/runs/:id/continue', async (ctx) => {
    const prev = runAccess(ctx, ctx.params.id, 'editor');
    if (isActive(prev.id)) throw badRequest('Wait for this run to finish before continuing it');
    if (!['chat', 'test'].includes(prev.kind)) throw badRequest('Only agent runs can be continued');
    const body = await ctx.json();
    const prompt = str(body.prompt, 'Follow-up', { max: 50_000 }).trim();
    const { run } = await startRun({
      projectId: prev.project_id,
      userId: ctx.user!.id,
      kind: prev.kind,
      title: `${prev.title.replace(/^Follow-up: /, '')} (follow-up)`.slice(0, 200),
      prompt,
      resumeOf: prev.id,
      permissionMode: body.permissionMode ?? prev.permission_mode,
      model: prev.model,
    });
    return { run: runSummary(run) };
  });

  get('/api/runs/:id/changes', async (ctx) => {
    const r = runAccess(ctx, ctx.params.id);
    const p = getProject(r.project_id);
    const meta = parseJson<any>(r.meta, {});
    const files: { path: string; size: number }[] = [];
    const workRel = r.worktree ? null : meta.workDir;
    if (workRel) {
      const base = path.join(projectDir(p), workRel);
      const walk = (d: string, rel: string, depth: number) => {
        if (depth > 4 || !fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name === '.git' || e.name === 'node_modules') continue;
          const rp = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(path.join(d, e.name), rp, depth + 1);
          else if (files.length < 200) files.push({ path: rp, size: fs.statSync(path.join(d, e.name)).size });
        }
      };
      walk(base, '', 0);
    }
    let diff = '';
    if (r.worktree) {
      const wt = path.join(projectDir(p), r.worktree);
      if (fs.existsSync(wt)) {
        await git(['add', '-A', '--intent-to-add'], { cwd: wt }).catch(() => undefined);
        diff = (await git(['diff', '--no-color', 'HEAD'], { cwd: wt, maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }))).stdout;
      }
    }
    return { worktree: r.worktree, workDir: meta.workDir, files, diff: diff.slice(0, 500_000) };
  });

  get('/api/runs/:id/file', (ctx) => {
    const r = runAccess(ctx, ctx.params.id);
    const p = getProject(r.project_id);
    const meta = parseJson<any>(r.meta, {});
    const base = path.join(projectDir(p), r.worktree || meta.workDir);
    const rel = str(ctx.query.get('path'), 'Path', { max: 500 });
    const file = safeJoin(base, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw notFound('File not found');
    if (fs.statSync(file).size > 1_000_000) throw badRequest('File is too large to show here');
    return { path: rel, content: fs.readFileSync(file, 'utf8') };
  });

  post('/api/runs/:id/push', async (ctx) => {
    const r = runAccess(ctx, ctx.params.id, 'editor');
    if (isActive(r.id)) throw badRequest('Wait for the run to finish before pushing');
    if (!r.repo_id || !r.worktree) throw badRequest('This run has no repository working copy');
    const repo = getRepo(r.repo_id);
    const body = await ctx.json();
    const branch = checkBranch(body.branch || `agent/${r.id.slice(2, 12).toLowerCase()}`);
    if (branch === repo.default_branch) throw badRequest('Push to a new branch, not the default branch');
    const message = str(body.message, 'Commit message', { max: 2000, optional: true }) || `Agent Portal: ${r.title}`;
    const wt = path.join(projectDir(getProject(r.project_id)), r.worktree);
    const out = await pushWorktree(repo, wt, branch, message);
    let pr: { number: number; url: string } | null = null;
    if (body.createPr && repo.provider === 'github' && githubSlug(repo.url)) {
      const created = await githubApi(repo, 'POST', '/pulls', {
        title: str(body.prTitle, 'Pull request title', { max: 200, optional: true }) || r.title,
        head: branch,
        base: repo.default_branch,
        body: `Created from Agent Portal run “${r.title}”.\n\n${(r.result || '').slice(0, 3000)}`,
        draft: true,
      });
      pr = { number: created.number, url: created.html_url };
    }
    return { ...out, branch, pr };
  });

  del('/api/runs/:id/worktree', async (ctx) => {
    const r = runAccess(ctx, ctx.params.id, 'editor');
    if (isActive(r.id)) throw badRequest('Stop the run first');
    if (!r.worktree || !r.repo_id) throw badRequest('This run has no working copy');
    const repo = getRepo(r.repo_id);
    await removeWorktree(repo, path.join(projectDir(getProject(r.project_id)), r.worktree));
    exec('UPDATE runs SET worktree = NULL WHERE id = ?', r.id);
    return { ok: true };
  });

  // ---- Answer a question or approval ----
  post('/api/inputs/:id/answer', async (ctx) => {
    const row = one<Row>('SELECT * FROM inputs WHERE id = ?', ctx.params.id);
    if (!row) throw notFound('Question not found');
    requireProject(ctx, row.project_id, row.type === 'approval' ? 'editor' : 'viewer');
    const body = await ctx.json();
    const updated = await answerInput(row.id, { id: ctx.user!.id, name: ctx.user!.name }, body);
    return { input: inputView(updated) };
  });

  // ---- Check the model connection ----
  post('/api/settings/test', async (ctx) => {
    const p = one<Row>('SELECT id FROM projects ORDER BY created_at LIMIT 1');
    if (!p) throw badRequest('Create a project first; the test run is recorded in it');
    const started = Date.now();
    try {
      const { text } = await oneshot({
        projectId: p.id,
        userId: ctx.user!.id,
        kind: 'connection',
        title: 'Connection test',
        system: 'You are a connection test. Reply with exactly: OK',
        prompt: 'Reply with exactly: OK',
        model: 'haiku',
        demoOutput: () => 'OK',
      });
      return { ok: /\bOK\b/.test(text), reply: text.slice(0, 200), provider: providerMode(), ms: Date.now() - started };
    } catch (e: any) {
      throw new HttpError(502, `Connection failed: ${e?.message ?? e}`);
    }
  }, { auth: 'admin' });
}
