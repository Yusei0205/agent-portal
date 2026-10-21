import { cleanModel, clearModelListCache } from './models.ts';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run as exec, type Row } from './db.ts';
import { del, get, post, openSse, HANDLED, sendFile } from './http.ts';
import { getProject, projectDir, requireProject } from './projects.ts';
import { ensureFresh, getRepo, githubApi, githubSlug, pushWorktree, removeWorktree, checkBranch, repoDir } from './repos.ts';
import { checkDocOutput, composeDocumentPrompt } from './docrun.ts';
import { HttpError, badRequest, notFound, parseJson, safeJoin, str } from './util.ts';
import { runChannel, subscribe } from './events.ts';
import { git } from './git.ts';
import { answerInput, getRun, inputView, isActive, oneshot, runSummary, startRun, stopRun } from './agent/runner.ts';
import { PRICES } from './agent/pricing.ts';
import { providerMode } from './settings.ts';
import JSZip from 'jszip';
import { issueDetail, mustMapping, checkKey } from './jira.ts';
import { composeRunPrompt, ticketMarkdown } from './jira-text.ts';

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

/** MIME types for common extensions; falls back to octet-stream. */
const FILE_MIME: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

function mimeFor(file: string): string {
  return FILE_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Returns the resolved base directory for a run's files. */
function runBase(r: Row, p: { slug: string }): string | null {
  const meta = parseJson<any>(r.meta, {});
  const rel = r.worktree || meta.workDir;
  if (!rel) return null;
  return path.join(projectDir(p), rel);
}

/** Walk the run folder and collect all files (excluding .git and node_modules). */
function walkRunFiles(base: string): string[] {
  const results: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    if (depth > 8 || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rp, depth + 1);
      else results.push(rp);
    }
  };
  walk(base, '', 0);
  return results;
}

export function registerRunRoutes(): void {
  get('/api/meta', () => ({ provider: providerMode(), prices: PRICES, models: MODEL_CHOICES }));

  get('/api/projects/:pid/runs', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const kinds = (ctx.query.get('kind') || 'chat,test,review').split(',').filter(Boolean);
    // standalone=1 leaves out the runs a session started for its iterations; the session shows those itself.
    const standalone = ctx.query.get('standalone') === '1' ? `AND r.meta NOT LIKE '%"workflowId"%'` : '';
    const rows = all<Row>(
      `SELECT r.*, u.name AS created_by_name FROM runs r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.project_id = ? AND r.kind IN (${kinds.map(() => '?').join(',')}) ${standalone}
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
    let prompt: string;
    let docTitle = '';
    if (body.document) {
      // "Document a repository": read the repo's reference clone (refreshed first) and write only to the run folder.
      const repo = getRepo(String(body.document.repoId ?? ''));
      if (repo.project_id !== project.id) throw badRequest('That repository belongs to another project');
      await ensureFresh(repo);
      const scope = str(body.document.scope, 'Focus', { max: 1000, optional: true });
      prompt = composeDocumentPrompt(getRepo(repo.id), { scope, output: checkDocOutput(body.document.output ?? 'markdown') });
      docTitle = `Document ${repo.name}`;
      body.repoId = undefined; // the reference clone is read in place; a working copy would limit writes to the repo
    } else if (body.jiraKey) {
      // Free task started from a Jira ticket in the Composer.
      const rawKey = str(body.jiraKey, 'Jira key', { max: 30 }).trim().toUpperCase();
      const mapping = mustMapping(project.id);
      checkKey(mapping, rawKey);
      const ticket = await issueDetail(project.id, mapping, rawKey);
      const instruction = str(body.prompt ?? '', 'Instruction', { max: 50_000, optional: true }).trim();
      const repoName: string | null = body.repoId ? (getRepo(String(body.repoId)).name ?? null) : null;
      prompt = composeRunPrompt({ instruction, repoName, ticket: ticketMarkdown(ticket), key: ticket.key });
      body._jiraMeta = { jiraKey: ticket.key, jiraUrl: ticket.url, jiraSummary: ticket.summary };
    } else {
      prompt = str(body.prompt, 'Prompt', { max: 50_000 }).trim();
      if (!prompt) throw badRequest('Describe what the agent should do');
    }
    const model = cleanModel(body.model);
    const mode = ['default', 'acceptEdits', 'plan'].includes(body.permissionMode) ? body.permissionMode : undefined;
    let repoId: string | null = null;
    let branch: string | null = null;
    if (body.repoId) {
      const repo = getRepo(String(body.repoId));
      if (repo.project_id !== project.id) throw badRequest('That repository belongs to another project');
      repoId = repo.id;
      branch = body.branch ? checkBranch(body.branch) : repo.default_branch;
    }
    const meta: Record<string, unknown> = body._jiraMeta
      ? { ...body._jiraMeta, repoName: repoId ? getRepo(repoId).name : null }
      : {};
    const { run } = await startRun({
      projectId: project.id,
      userId: ctx.user!.id,
      kind: 'chat',
      title: docTitle || str(body.title, 'Title', { max: 200, optional: true }).trim() || (body._jiraMeta ? `${body._jiraMeta.jiraKey}: ${body._jiraMeta.jiraSummary}`.slice(0, 200) : prompt.split('\n')[0].slice(0, 100)),
      prompt,
      repoId,
      branch,
      permissionMode: mode,
      model,
      meta: Object.keys(meta).length ? meta : undefined,
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
    // Absolute path only for admins (reveals server filesystem layout).
    const absPath = ctx.user?.is_admin ? runBase(r, p) : null;
    return { worktree: r.worktree, workDir: meta.workDir, absPath, files, diff: diff.slice(0, 500_000) };
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
    // Binary files cannot be returned as UTF-8 text; flag them so the UI can show a download prompt.
    const mime = mimeFor(file);
    const isBinary = !mime.includes('text/') && !mime.includes('application/json') && !mime.includes('application/xml') && !mime.includes('text/xml');
    if (isBinary) return { path: rel, content: null, binary: true, mime };
    return { path: rel, content: fs.readFileSync(file, 'utf8'), binary: false, mime };
  });

  /** Download a single run file as raw bytes with the correct MIME type. */
  get('/api/runs/:id/file/download', (ctx) => {
    const r = runAccess(ctx, ctx.params.id);
    const p = getProject(r.project_id);
    const meta = parseJson<any>(r.meta, {});
    const base = path.join(projectDir(p), r.worktree || meta.workDir);
    const rel = str(ctx.query.get('path'), 'Path', { max: 500 });
    const file = safeJoin(base, rel);
    const stat = fs.existsSync(file) ? fs.statSync(file) : null;
    if (!stat || !stat.isFile()) throw notFound('File not found');
    const buf = fs.readFileSync(file);
    const mime = mimeFor(file);
    return sendFile(ctx.res, buf, mime, path.basename(rel));
  });

  /** Download all run files as a ZIP archive (excludes .git and node_modules). */
  get('/api/runs/:id/files/zip', async (ctx) => {
    const r = runAccess(ctx, ctx.params.id);
    const p = getProject(r.project_id);
    const base = runBase(r, p);
    if (!base || !fs.existsSync(base)) throw notFound('Run folder not found');
    const zip = new JSZip();
    const filePaths = walkRunFiles(base);
    for (const rel of filePaths) {
      try {
        const buf = fs.readFileSync(path.join(base, rel));
        zip.file(rel, buf);
      } catch {
        // Skip unreadable files
      }
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const safeName = (r.title || r.id).replace(/[^\w\s.-]/g, '_').slice(0, 80);
    return sendFile(ctx.res, buf, 'application/zip', `${safeName}.zip`);
  });

  post('/api/runs/:id/push', async (ctx) => {
    const r = runAccess(ctx, ctx.params.id, 'editor');
    if (isActive(r.id)) throw badRequest('Wait for the run to finish before pushing');
    if (!r.repo_id || !r.worktree) throw badRequest('This run has no repository working copy');
    const repo = getRepo(r.repo_id);
    const body = await ctx.json();
    const meta = parseJson<any>(r.meta, {});
    const jiraKey: string | undefined = meta.jiraKey;
    const jiraSummary: string | undefined = meta.jiraSummary;

    // Build Jira-aware defaults when the run came from a ticket
    const defaultBranch = typeof meta.workBranch === 'string' && meta.workBranch
      ? meta.workBranch
      : jiraKey
      ? `agent/${jiraKey.toLowerCase()}-${(jiraSummary ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`
      : `agent/${r.id.slice(2, 12).toLowerCase()}`;
    const defaultMessage = jiraKey
      ? `${jiraKey}: ${jiraSummary ?? r.title}`
      : `Agent Portal: ${r.title}`;

    const branch = checkBranch(body.branch || defaultBranch);
    // The branch a pull request is opened into: chosen at push time, else the one the work started from.
    const prBase = checkBranch(body.base || r.branch || repo.default_branch);
    if (body.base) await git(['rev-parse', '--verify', '--quiet', `origin/${prBase}`], { cwd: repoDir(repo) }).catch(() => {
      throw badRequest(`Branch "${prBase}" was not found in ${repo.name}`);
    });
    if (branch === repo.default_branch || branch === r.branch || branch === prBase) throw badRequest(`Push to a new branch. "${branch}" is the branch this work started from, and nothing is pushed to it.`);
    const message = str(body.message, 'Commit message', { max: 2000, optional: true }) || defaultMessage;
    const wt = path.join(projectDir(getProject(r.project_id)), r.worktree);
    const out = await pushWorktree(repo, wt, branch, message);
    let pr: { number: number; url: string } | null = null;
    if (body.createPr && repo.provider === 'github' && githubSlug(repo.url)) {
      const prTitle = str(body.prTitle, 'Pull request title', { max: 200, optional: true })
        || (jiraKey ? `${jiraKey}: ${jiraSummary ?? r.title}` : r.title);
      const prBody = jiraKey && meta.jiraUrl
        ? `Jira: [${jiraKey}](${meta.jiraUrl})\n\nCreated from Agent Portal run "${r.title}".\n\n${(r.result || '').slice(0, 2800)}`
        : `Created from Agent Portal run "${r.title}".\n\n${(r.result || '').slice(0, 3000)}`;
      const created = await githubApi(repo, 'POST', '/pulls', {
        title: prTitle,
        head: branch,
        base: prBase,
        body: prBody,
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
  // A project's own connection: the same one-line test, run with that project's provider and AWS account.
  post('/api/projects/:pid/connection/test', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const started = Date.now();
    try {
      const { text, runId } = await oneshot({
        projectId: project.id,
        userId: ctx.user!.id,
        kind: 'connection',
        title: 'Connection test',
        system: 'You are a connection test. Reply with exactly: OK',
        prompt: 'Reply with exactly: OK',
        model: 'haiku',
        demoOutput: () => 'OK',
      });
      const r = one<Row>('SELECT model, provider FROM runs WHERE id = ?', runId);
      return { ok: /\bOK\b/.test(text), reply: text.slice(0, 200), provider: r?.provider, model: r?.model, ms: Date.now() - started };
    } catch (e: any) {
      throw new HttpError(502, `Connection failed: ${e?.message ?? e}`);
    }
  });

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
      const ok = /\bOK\b/.test(text);
      if (ok) clearModelListCache();
      return { ok, reply: text.slice(0, 200), provider: providerMode(), ms: Date.now() - started };
    } catch (e: any) {
      throw new HttpError(502, `Connection failed: ${e?.message ?? e}`);
    }
  }, { auth: 'admin' });
}
