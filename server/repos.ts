import fs from 'node:fs';
import path from 'node:path';
import { all, insert, one, run, update, type Row } from './db.ts';
import { del, get, patch, post } from './http.ts';
import { HttpError, badRequest, newId, notFound, now, slugify, str, withLock } from './util.ts';
import { getProject, notifyProject, projectDir, requireProject, writeClaudeMd } from './projects.ts';
import { git, gitConfigEnv, PORTAL_GIT_IDENTITY, redact } from './git.ts';
import { deleteSecret, getSecret, secretInfo, setSecret } from './secrets.ts';
import { awsEnv, githubToken } from './settings.ts';

export type Provider = 'github' | 'codecommit' | 'git';

export interface Repo {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  provider: Provider;
  url: string;
  default_branch: string;
  token_secret: string | null;
  auth_user: string | null;
  status: string;
  error: string | null;
  last_sync: string | null;
}

export function getRepo(id: string): Repo {
  const r = one<Repo>('SELECT * FROM repos WHERE id = ?', id);
  if (!r) throw notFound('Repository not found');
  return r;
}

export function repoDir(r: Repo): string {
  return path.join(projectDir(getProject(r.project_id)), 'repos', r.slug);
}

const GITHUB_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const CODECOMMIT_HTTPS_RE = /^https:\/\/git-codecommit\.([a-z0-9-]+)\.amazonaws\.com\/v1\/repos\/([A-Za-z0-9_.-]+)$/;
const CODECOMMIT_GRC_RE = /^codecommit:(?::([a-z0-9-]+))?\/\/(?:[A-Za-z0-9_-]+@)?([A-Za-z0-9_.-]+)$/;

export function validateUrl(provider: Provider, url: string, isAdmin: boolean): string {
  const u = url.trim();
  if (provider === 'github') {
    if (!GITHUB_RE.test(u)) throw badRequest('Use the HTTPS address, like https://github.com/owner/repo');
    return u.replace(/\/$/, '');
  }
  if (provider === 'codecommit') {
    if (!CODECOMMIT_HTTPS_RE.test(u) && !CODECOMMIT_GRC_RE.test(u)) {
      throw badRequest('Use https://git-codecommit.<region>.amazonaws.com/v1/repos/<name> or codecommit::<region>://<name>');
    }
    return u;
  }
  if (/^https:\/\/[^\s]+$/.test(u) || /^ssh:\/\/[^\s]+$/.test(u) || /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/.test(u)) return u;
  if (/^file:\/\/\//.test(u) || u.startsWith('/')) {
    if (!isAdmin) throw badRequest('Only admins can connect repositories from the server’s own disk');
    return u;
  }
  throw badRequest('Use an https://, ssh:// or git@host:path address');
}

export function githubSlug(url: string): { owner: string; repo: string } | null {
  const m = url.match(GITHUB_RE);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function repoToken(r: Repo): Promise<string | null> {
  if (r.token_secret) {
    const t = await getSecret(r.token_secret);
    if (t) return t;
  }
  return r.provider === 'github' ? githubToken() : null;
}

/** Environment that lets git authenticate for this repository without writing credentials to disk. */
export async function repoGitEnv(r: Repo): Promise<Record<string, string>> {
  if (r.provider === 'codecommit') {
    const aws = await awsEnv();
    if (r.url.startsWith('https://')) {
      return {
        ...aws,
        ...gitConfigEnv([
          ['credential.helper', ''],
          ['credential.helper', '!aws codecommit credential-helper $@'],
          ['credential.UseHttpPath', 'true'],
        ]),
      };
    }
    return aws;
  }
  const token = await repoToken(r);
  if (!token || !r.url.startsWith('https://')) return {};
  const user = r.auth_user || 'x-access-token';
  const origin = new URL(r.url).origin;
  return gitConfigEnv([[`http.${origin}/.extraheader`, `AUTHORIZATION: basic ${Buffer.from(`${user}:${token}`).toString('base64')}`]]);
}

function view(r: Repo) {
  return { ...r, token: r.token_secret ? secretInfo(r.token_secret) : { set: false } };
}

function publishRepo(r: Repo) {
  notifyProject(r.project_id, 'repo.updated', view(getRepo(r.id)));
}

export async function cloneRepo(r: Repo): Promise<void> {
  const dir = repoDir(r);
  await withLock(`repo:${r.id}`, async () => {
    update('repos', r.id, { status: 'cloning', error: null });
    publishRepo(r);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await git(['clone', '--quiet', '--origin', 'origin', r.url, dir], { env: await repoGitEnv(r), timeoutMs: 15 * 60_000 });
      const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir }).catch(() => null);
      const def = head?.stdout.trim().replace(/^origin\//, '');
      const branch = r.default_branch || def || 'main';
      update('repos', r.id, { status: 'ready', last_sync: now(), default_branch: branch });
    } catch (e: any) {
      update('repos', r.id, { status: 'error', error: redact(String(e?.message ?? e)) });
    }
    publishRepo(r);
  });
}

export async function syncRepo(r: Repo): Promise<void> {
  const dir = repoDir(r);
  if (!fs.existsSync(path.join(dir, '.git'))) return cloneRepo(r);
  await withLock(`repo:${r.id}`, async () => {
    update('repos', r.id, { status: 'syncing', error: null });
    publishRepo(r);
    try {
      await git(['fetch', '--quiet', '--prune', 'origin'], { cwd: dir, env: await repoGitEnv(r), timeoutMs: 10 * 60_000 });
      const fresh = getRepo(r.id);
      await git(['checkout', '--quiet', '-B', fresh.default_branch, `origin/${fresh.default_branch}`], { cwd: dir });
      await git(['reset', '--quiet', '--hard', `origin/${fresh.default_branch}`], { cwd: dir });
      update('repos', r.id, { status: 'ready', last_sync: now() });
    } catch (e: any) {
      update('repos', r.id, { status: 'error', error: redact(String(e?.message ?? e)) });
    }
    publishRepo(r);
  });
}

export async function listBranches(r: Repo): Promise<{ name: string; sha: string; date: string; subject: string }[]> {
  const dir = repoDir(r);
  if (!fs.existsSync(path.join(dir, '.git'))) return [];
  const out = await git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname:short)%09%(committerdate:iso8601)%09%(subject)', 'refs/remotes/origin'], { cwd: dir });
  return out.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, sha, date, ...subject] = l.split('\t');
      return { name: ref.replace(/^origin\//, ''), sha, date, subject: subject.join('\t') };
    })
    .filter((b) => b.name !== 'HEAD' && b.name !== 'origin');
}

const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._\/-]{1,200}$/;

export function checkBranch(b: unknown): string {
  if (typeof b !== 'string' || !BRANCH_RE.test(b) || b.startsWith('-')) throw badRequest('Branch name is not valid');
  return b;
}

export async function ensureFresh(r: Repo): Promise<void> {
  const fresh = getRepo(r.id);
  if (fresh.status !== 'ready') throw badRequest(`Repository "${r.name}" is not ready (${fresh.status}). Sync it on the Repos tab.`);
  if (!fresh.last_sync || Date.now() - Date.parse(fresh.last_sync) > 2 * 60_000) await syncRepo(fresh);
}

export async function fetchPullRef(r: Repo, pr: number): Promise<string> {
  const dir = repoDir(r);
  await git(['fetch', '--quiet', 'origin', `+refs/pull/${pr}/head:refs/remotes/origin/pr/${pr}`], { cwd: dir, env: await repoGitEnv(r) });
  return `pr/${pr}`;
}

export async function createWorktree(r: Repo, branch: string, dest: string): Promise<void> {
  checkBranch(branch);
  await ensureFresh(r);
  const dir = repoDir(r);
  await withLock(`repo:${r.id}`, async () => {
    await git(['rev-parse', '--verify', '--quiet', `origin/${branch}`], { cwd: dir }).catch(() => {
      throw badRequest(`Branch "${branch}" was not found in ${r.name}`);
    });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await git(['worktree', 'add', '--quiet', '--detach', dest, `origin/${branch}`], { cwd: dir });
  });
}

export async function removeWorktree(r: Repo, dest: string): Promise<void> {
  const dir = repoDir(r);
  await withLock(`repo:${r.id}`, async () => {
    await git(['worktree', 'remove', '--force', dest], { cwd: dir }).catch(() => undefined);
    fs.rmSync(dest, { recursive: true, force: true });
    await git(['worktree', 'prune'], { cwd: dir }).catch(() => undefined);
  });
}

export async function diffRefs(r: Repo, base: string, head: string): Promise<string> {
  const dir = repoDir(r);
  const out = await git(['diff', '--no-color', '--no-ext-diff', '--unified=3', '--find-renames', `origin/${base}...origin/${head}`], {
    cwd: dir,
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.stdout;
}

export async function pushWorktree(r: Repo, worktreeAbs: string, branch: string, message: string): Promise<{ commit: string | null; pushed: boolean }> {
  checkBranch(branch);
  await git(['checkout', '--quiet', '-B', branch], { cwd: worktreeAbs });
  await git(['add', '-A'], { cwd: worktreeAbs });
  const staged = await git(['diff', '--cached', '--name-only'], { cwd: worktreeAbs });
  let commit: string | null = null;
  if (staged.stdout.trim()) {
    await git(['commit', '--quiet', '-m', message], { cwd: worktreeAbs, env: PORTAL_GIT_IDENTITY });
  }
  const ahead = await git(['rev-list', '--count', `origin/${getRepo(r.id).default_branch}..HEAD`], { cwd: worktreeAbs }).catch(() => ({ stdout: '1' }));
  if (Number(ahead.stdout.trim()) === 0) throw badRequest('There are no changes to push in this run’s working copy');
  commit = (await git(['rev-parse', 'HEAD'], { cwd: worktreeAbs })).stdout.trim();
  await git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktreeAbs, env: await repoGitEnv(r), timeoutMs: 5 * 60_000 });
  return { commit, pushed: true };
}

/* ------------------------------------------------------------------ */
/* GitHub API                                                          */
/* ------------------------------------------------------------------ */

export async function githubApi(r: Repo, method: string, apiPath: string, body?: unknown): Promise<any> {
  const slug = githubSlug(r.url);
  if (!slug) throw badRequest('This is not a GitHub repository');
  const token = await repoToken(r);
  if (!token) throw badRequest('Add a GitHub token for this repository (Repos tab) or in Settings');
  const res = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-portal',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new HttpError(502, `GitHub said ${res.status}: ${data?.message ?? text.slice(0, 200)}`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function checkProvider(p: unknown): Provider {
  if (p !== 'github' && p !== 'codecommit' && p !== 'git') throw badRequest('Provider must be github, codecommit or git');
  return p;
}

export function registerRepoRoutes(): void {
  get('/api/projects/:pid/repos', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { repos: all<Repo>('SELECT * FROM repos WHERE project_id = ? ORDER BY name', project.id).map(view) };
  });

  post('/api/projects/:pid/repos', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const provider = checkProvider(body.provider);
    const url = validateUrl(provider, str(body.url, 'Repository address', { max: 500 }), Boolean(ctx.user!.is_admin));
    const inferred = url.split(/[/:]/).filter(Boolean).pop()!.replace(/\.git$/, '');
    const name = str(body.name, 'Name', { max: 100, optional: true }).trim() || inferred;
    let slug = slugify(name, 40);
    let n = 2;
    while (one('SELECT id FROM repos WHERE project_id = ? AND slug = ?', project.id, slug)) slug = `${slugify(name, 36)}-${n++}`;
    const id = newId('g_');
    let tokenSecret: string | null = null;
    if (body.token) {
      tokenSecret = `repo.${id}.token`;
      await setSecret(tokenSecret, str(body.token, 'Token', { max: 2000 }).trim());
    }
    insert('repos', {
      id,
      project_id: project.id,
      name,
      slug,
      provider,
      url,
      default_branch: body.defaultBranch ? checkBranch(body.defaultBranch) : '',
      token_secret: tokenSecret,
      auth_user: body.username ? str(body.username, 'Username', { max: 100 }).trim() : null,
      status: 'new',
      created_at: now(),
    });
    const repo = getRepo(id);
    void cloneRepo(repo).then(() => writeClaudeMd(project.id, `Connect repository ${name}`)).catch(() => undefined);
    return { repo: view(repo) };
  });

  patch('/api/repos/:id', async (ctx) => {
    const repo = getRepo(ctx.params.id);
    requireProject(ctx, repo.project_id, 'editor');
    const body = await ctx.json();
    const p: Record<string, any> = {};
    if (body.name !== undefined) p.name = str(body.name, 'Name', { max: 100 }).trim();
    if (body.defaultBranch !== undefined) p.default_branch = checkBranch(body.defaultBranch);
    if (body.username !== undefined) p.auth_user = body.username ? str(body.username, 'Username', { max: 100 }).trim() : null;
    if (body.token === null) {
      if (repo.token_secret) deleteSecret(repo.token_secret);
      p.token_secret = null;
    } else if (body.token) {
      const name = repo.token_secret || `repo.${repo.id}.token`;
      await setSecret(name, str(body.token, 'Token', { max: 2000 }).trim());
      p.token_secret = name;
    }
    update('repos', repo.id, p);
    publishRepo(repo);
    if (p.name || p.default_branch) await writeClaudeMd(repo.project_id, 'Update repository details');
    return { repo: view(getRepo(repo.id)) };
  });

  post('/api/repos/:id/sync', async (ctx) => {
    const repo = getRepo(ctx.params.id);
    requireProject(ctx, repo.project_id, 'editor');
    if (repo.status === 'cloning' || repo.status === 'syncing') return { repo: view(repo) };
    void (repo.status === 'error' && !fs.existsSync(path.join(repoDir(repo), '.git')) ? cloneRepo(repo) : syncRepo(repo));
    return { repo: view(getRepo(repo.id)) };
  });

  get('/api/repos/:id/branches', async (ctx) => {
    const repo = getRepo(ctx.params.id);
    requireProject(ctx, repo.project_id);
    return { branches: await listBranches(repo), defaultBranch: repo.default_branch };
  });

  get('/api/repos/:id/pulls', async (ctx) => {
    const repo = getRepo(ctx.params.id);
    requireProject(ctx, repo.project_id);
    if (repo.provider !== 'github') return { pulls: [] };
    const pulls = await githubApi(repo, 'GET', '/pulls?state=open&per_page=50');
    return {
      pulls: pulls.map((p: any) => ({ number: p.number, title: p.title, base: p.base.ref, head: p.head.ref, headSha: p.head.sha, author: p.user?.login, url: p.html_url })),
    };
  });

  del('/api/repos/:id', async (ctx) => {
    const repo = getRepo(ctx.params.id);
    requireProject(ctx, repo.project_id, 'editor');
    await withLock(`repo:${repo.id}`, async () => {
      fs.rmSync(repoDir(repo), { recursive: true, force: true });
    });
    if (repo.token_secret) deleteSecret(repo.token_secret);
    run('DELETE FROM repos WHERE id = ?', repo.id);
    await writeClaudeMd(repo.project_id, `Disconnect repository ${repo.name}`);
    notifyProject(repo.project_id, 'repo.deleted', { id: repo.id });
    return { ok: true };
  });
}

export type { Row };
