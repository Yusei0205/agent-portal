import { cleanModel, clearModelListCache } from './models.ts';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run as exec, type Row } from './db.ts';
import { del, get, post, openSse, HANDLED, sendFile } from './http.ts';
import { getProject, projectDir, requireProject } from './projects.ts';
import { ensureFresh, getRepo, openPullRequest, pushWorktree, removeWorktree, checkBranch, repoDir } from './repos.ts';
import { checkDocOutput, composeDocumentPrompt } from './docrun.ts';
import { HttpError, badRequest, notFound, parseJson, safeJoin, str } from './util.ts';
import { runChannel, subscribe } from './events.ts';
import { git } from './git.ts';
import { answerInput, getRun, inputView, isActive, oneshot, runRepos, runSummary, startRun, stopRun, type RepoChoice } from './agent/runner.ts';
import { PRICES } from './agent/pricing.ts';
import { providerMode } from './settings.ts';
import JSZip from 'jszip';
import { readIntegrationIds } from './integrations.ts';
import { engineProvider } from './project-aws.ts';
import { downloadAttachments, issueDetail, mustMapping, checkKey } from './jira.ts';
import { composeRunPrompt, ticketMarkdown } from './jira-text.ts';
import { resolveLead } from './kiro-agents.ts';

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
  const rel = runRepos(r).length > 1 ? meta.workDir : r.worktree || meta.workDir;
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

/**
 * The repositories a request picks: "repos" ([{ repoId, branch }]) or the single "repoId" / "branch". Each must belong
 * to the project, appear once, and each branch must be a valid name; an empty branch means the repository's default.
 */
export function readRepoChoices(projectId: string, body: any): RepoChoice[] {
  const raw: any[] = Array.isArray(body?.repos) ? body.repos : body?.repoId ? [{ repoId: body.repoId, branch: body.branch }] : [];
  if (raw.length > 8) throw badRequest('Pick at most 8 repositories');
  const out: RepoChoice[] = [];
  for (const x of raw) {
    if (!x?.repoId) continue;
    const repo = getRepo(String(x.repoId));
    if (repo.project_id !== projectId) throw badRequest('That repository belongs to another project');
    if (out.some((o) => o.repoId === repo.id)) throw badRequest(`${repo.name} is chosen twice`);
    out.push({ repoId: repo.id, branch: x.branch ? checkBranch(String(x.branch)) : repo.default_branch });
  }
  return out;
}

/** Branch names agents may never push to, whatever they ask: the shared, long-lived branches. */
const SHARED_BRANCH = /^(main|master|trunk|develop|development|dev([/_-].*)?|release([/_-].*)?|prod(uction)?([/_-].*)?|staging|hotfix\/.*)$/i;

export function isSharedBranch(name: string): boolean {
  return SHARED_BRANCH.test(name);
}

export interface PushOptions {
  repoId?: string;
  branch?: string;
  message?: string;
  createPr?: boolean;
  prTitle?: string;
  base?: string;
  /** Agent pushes: refuse the shared branches (main, develop, release…) too. */
  agent?: boolean;
  /**
   * The agent of this very run asked for the push with `git push` in a trusted session, so the run is still going.
   * Without this a push waits for the run to finish (a person's push must not race the agent's edits).
   */
  duringRun?: boolean;
}

/**
 * Commit one working copy of a run and push it to a new branch, optionally opening a draft pull request. Used by the
 * Push button and by sessions whose agents may push. Never pushes to the branch the work started from, the default
 * branch or the pull request's base; never forces.
 */
export async function pushRun(r: Row, o: PushOptions) {
  if (isActive(r.id) && !o.duringRun) throw badRequest('Wait for the run to finish before pushing');
  const repos = runRepos(r);
  if (!repos.length) throw badRequest('This run has no repository working copy');
  const target = o.repoId ? repos.find((x) => x.repoId === o.repoId) : repos[0];
  if (!target) throw badRequest('That repository is not part of this run');
  const repo = getRepo(target.repoId);
  const startBranch = target.branch || repo.default_branch;
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

  const branch = checkBranch(o.branch || defaultBranch);
  // The branch a pull request is opened into: chosen at push time, else the one the work started from.
  const prBase = checkBranch(o.base || startBranch);
  if (o.base) await git(['rev-parse', '--verify', '--quiet', `origin/${prBase}`], { cwd: repoDir(repo) }).catch(() => {
    throw badRequest(`Branch "${prBase}" was not found in ${repo.name}`);
  });
  if (branch === repo.default_branch || branch === startBranch || branch === prBase) throw badRequest(`Push to a new branch. "${branch}" is the branch this work started from, and nothing is pushed to it.`);
  if (o.agent && isSharedBranch(branch)) throw badRequest(`Agents may not push to the shared branch "${branch}". Use a new branch for the changes.`);
  const message = str(o.message, 'Commit message', { max: 2000, optional: true }) || defaultMessage;
  const wt = path.join(projectDir(getProject(r.project_id)), target.worktree);
  const out = await pushWorktree(repo, wt, branch, message);
  // The push has happened by now: a pull request that cannot be opened is reported, not thrown.
  let pr: { number: number; url: string; existing?: boolean } | null = null;
  let prError: string | null = null;
  if (o.createPr) {
    const prTitle = str(o.prTitle, 'Pull request title', { max: 200, optional: true })
      || (jiraKey ? `${jiraKey}: ${jiraSummary ?? r.title}` : r.title);
    const prBody = jiraKey && meta.jiraUrl
      ? `Jira: [${jiraKey}](${meta.jiraUrl})\n\nCreated from Agent Portal run "${r.title}".\n\n${(r.result || '').slice(0, 2800)}`
      : `Created from Agent Portal run "${r.title}".\n\n${(r.result || '').slice(0, 3000)}`;
    try {
      pr = await openPullRequest(repo, { title: prTitle, head: branch, base: prBase, body: prBody });
    } catch (e: any) {
      prError = String(e?.message ?? e).slice(0, 300);
    }
  }
  return { ...out, branch, base: prBase, pr, prError, repoId: repo.id, repoName: repo.name };
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
      const ticket = await downloadAttachments(project.id, await issueDetail(project.id, mapping, rawKey));
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
    const repos = readRepoChoices(project.id, body);
    if (repos.length) {
      repoId = repos[0].repoId;
      branch = repos[0].branch ?? null;
    }
    const meta: Record<string, unknown> = body._jiraMeta
      ? { ...body._jiraMeta, repoName: repoId ? getRepo(repoId).name : null }
      : {};
    const engine = body.engine ? (engineProvider(project.id, String(body.engine)), String(body.engine)) : null;
    // An optional lead, as in sessions: on Kiro a project Kiro agent leads with its own profile.
    const leadName = typeof body.leadAgent === 'string' ? body.leadAgent.trim() : '';
    const lead = leadName ? resolveLead(project, leadName, engineProvider(project.id, engine) === 'kiro') : null;
    if (leadName && !lead) throw badRequest(`"${leadName}" cannot lead a run on this engine: it is not an enabled agent of this project.`);
    const { run } = await startRun({
      projectId: project.id,
      userId: ctx.user!.id,
      kind: 'chat',
      title: docTitle || str(body.title, 'Title', { max: 200, optional: true }).trim() || (body._jiraMeta ? `${body._jiraMeta.jiraKey}: ${body._jiraMeta.jiraSummary}`.slice(0, 200) : prompt.split('\n')[0].slice(0, 100)),
      prompt,
      repoId,
      branch,
      repos: repos.length > 1 ? repos : null,
      integrations: readIntegrationIds(body.integrations, ctx.user!.id),
      engine,
      permissionMode: mode,
      model,
      lead: lead ?? undefined,
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
    const repos = runRepos(r);
    const repoDiffs: { repoId: string; name: string; branch: string; changed: number }[] = [];
    for (const x of repos) {
      const wt = path.join(projectDir(p), x.worktree);
      if (!fs.existsSync(wt)) continue;
      const folder = path.posix.basename(x.worktree);
      const prefix = repos.length > 1 ? ['--src-prefix', `a/${folder}/`, '--dst-prefix', `b/${folder}/`] : [];
      await git(['add', '-A', '--intent-to-add'], { cwd: wt }).catch(() => undefined);
      const d = (await git(['diff', '--no-color', ...prefix, 'HEAD'], { cwd: wt, maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }))).stdout;
      diff += d;
      repoDiffs.push({ repoId: x.repoId, name: x.name || getRepo(x.repoId).name, branch: x.branch, changed: (d.match(/^diff --git /gm) || []).length });
    }
    // Absolute path only for admins (reveals server filesystem layout).
    const absPath = ctx.user?.is_admin ? runBase(r, p) : null;
    return { worktree: r.worktree, workDir: meta.workDir, absPath, files, diff: diff.slice(0, 500_000), repos: repoDiffs };
  });

  get('/api/runs/:id/file', (ctx) => {
    const r = runAccess(ctx, ctx.params.id);
    const p = getProject(r.project_id);
    const meta = parseJson<any>(r.meta, {});
    const base = runBase(r, p) ?? path.join(projectDir(p), meta.workDir);
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
    const base = runBase(r, p) ?? path.join(projectDir(p), meta.workDir);
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
    const body = await ctx.json();
    return pushRun(r, {
      repoId: body.repoId,
      branch: body.branch,
      message: body.message,
      createPr: Boolean(body.createPr),
      prTitle: body.prTitle,
      base: body.base,
    });
  });

  del('/api/runs/:id/worktree', async (ctx) => {
    const r = runAccess(ctx, ctx.params.id, 'editor');
    if (isActive(r.id)) throw badRequest('Stop the run first');
    const repos = runRepos(r);
    if (!repos.length) throw badRequest('This run has no working copy');
    for (const x of repos) await removeWorktree(getRepo(x.repoId), path.join(projectDir(getProject(r.project_id)), x.worktree));
    const meta = parseJson<any>(r.meta, {});
    delete meta.repos;
    exec('UPDATE runs SET worktree = NULL, meta = ? WHERE id = ?', JSON.stringify(meta), r.id);
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
