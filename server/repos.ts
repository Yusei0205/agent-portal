/**
 * Repositories API routes.
 *
 * Routes:
 *   GET    /api/projects/:id/repos                         — list repos
 *   POST   /api/projects/:id/repos                         — add repo
 *   GET    /api/projects/:id/repos/:repoId                 — get repo details
 *   DELETE /api/projects/:id/repos/:repoId                 — remove repo
 *   POST   /api/projects/:id/repos/:repoId/sync            — trigger clone/sync
 *   GET    /api/projects/:id/repos/:repoId/branches        — list branches
 *   PUT    /api/projects/:id/repos/:repoId/default-branch  — update default branch
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert } from './db.ts';
import { generateId, now, str, badRequest, notFound } from './util.ts';
import { config } from './config.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Repository {
  id: string;
  project_id: string;
  name: string;
  url: string;
  provider: string;
  status: string;
  default_branch: string | null;
  identity: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the directory on disk for a cloned repo. */
function repoCloneDir(projectSlug: string, repoName: string): string {
  return path.join(config.dataDir, 'projects', projectSlug, 'repos', repoName);
}

/** Get the project slug for a project id. */
function getProjectSlug(projectId: string): string | null {
  return one<{ slug: string }>('SELECT slug FROM projects WHERE id = ?', projectId)?.slug ?? null;
}

/** Require the caller to be authenticated and a member (or admin) of the project. */
function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = one<{ id: string }>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string }>(
    'SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

/** Run a git command, returning stdout or throwing on failure. */
function spawnGit(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8').trim());
      } else {
        reject(new Error(Buffer.concat(err).toString('utf8').trim() || `git exited with ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

/** Background clone/sync operation. Updates status in the database. */
async function performSync(repoId: string, projectId: string): Promise<void> {
  const repo = one<Repository>('SELECT * FROM repositories WHERE id = ? AND project_id = ?', repoId, projectId);
  if (!repo) return;

  const slug = getProjectSlug(projectId);
  if (!slug) return;

  const cloneDir = repoCloneDir(slug, repo.name);

  try {
    if (fs.existsSync(path.join(cloneDir, '.git'))) {
      // Already cloned — fetch
      await spawnGit(['fetch', '--all', '--prune'], cloneDir);
    } else {
      // Fresh clone
      await fsp.mkdir(path.dirname(cloneDir), { recursive: true });
      await spawnGit(['clone', repo.url, cloneDir], path.dirname(cloneDir));
    }

    // Detect default branch
    let defaultBranch: string | null = repo.default_branch;
    try {
      const ref = await spawnGit(
        ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
        cloneDir,
      );
      defaultBranch = ref.replace('origin/', '');
    } catch {
      // Fall back to existing value
    }

    run(
      `UPDATE repositories SET status = 'ready', last_synced_at = ?, default_branch = ?, last_error = NULL WHERE id = ?`,
      now(),
      defaultBranch,
      repoId,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    run(
      `UPDATE repositories SET status = 'error', last_error = ? WHERE id = ?`,
      msg.slice(0, 1000),
      repoId,
    );
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerRepoRoutes(): void {

  // GET /api/projects/:id/repos
  router.get('/api/projects/:id/repos', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;
    const repos = all<Repository>(
      'SELECT * FROM repositories WHERE project_id = ? ORDER BY created_at',
      req.params.id,
    );
    sendJson(res, 200, { repos });
  });

  // POST /api/projects/:id/repos
  router.post('/api/projects/:id/repos', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const url = str(body.url, 'url', { max: 1000 }).trim();
    const provider = str(body.provider, 'provider', { max: 32 }).trim();

    if (!['github', 'codecommit', 'bitbucket', 'git'].includes(provider)) {
      sendJson(res, 400, { error: 'provider must be github, codecommit, bitbucket, or git' });
      return;
    }
    if (!url) { sendJson(res, 400, { error: 'url is required' }); return; }

    const id = generateId();
    const ts = now();

    insert('repositories', {
      id,
      project_id: req.params.id,
      name,
      url,
      provider,
      status: 'new',
      default_branch: null,
      identity: null,
      last_synced_at: null,
      last_error: null,
      created_at: ts,
    });

    const repo = one<Repository>('SELECT * FROM repositories WHERE id = ?', id);
    sendJson(res, 201, { repo });
  });

  // GET /api/projects/:id/repos/:repoId
  router.get('/api/projects/:id/repos/:repoId', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const repo = one<Repository>(
      'SELECT * FROM repositories WHERE id = ? AND project_id = ?',
      req.params.repoId,
      req.params.id,
    );
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    sendJson(res, 200, { repo });
  });

  // DELETE /api/projects/:id/repos/:repoId
  router.delete('/api/projects/:id/repos/:repoId', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const result = run(
      'DELETE FROM repositories WHERE id = ? AND project_id = ?',
      req.params.repoId,
      req.params.id,
    );
    if (result.changes === 0) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/repos/:repoId/sync
  router.post('/api/projects/:id/repos/:repoId/sync', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const repo = one<Repository>(
      'SELECT * FROM repositories WHERE id = ? AND project_id = ?',
      req.params.repoId,
      req.params.id,
    );
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    // Set status to cloning immediately
    run(
      `UPDATE repositories SET status = 'cloning', last_error = NULL WHERE id = ?`,
      repo.id,
    );

    // Run clone/fetch in background
    performSync(repo.id, req.params.id).catch((e: unknown) => {
      console.error(`[repos] sync error for ${repo.id}:`, e);
    });

    sendJson(res, 202, { ok: true, status: 'cloning' });
  });

  // GET /api/projects/:id/repos/:repoId/branches
  router.get('/api/projects/:id/repos/:repoId/branches', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const repo = one<Repository>(
      'SELECT * FROM repositories WHERE id = ? AND project_id = ?',
      req.params.repoId,
      req.params.id,
    );
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    const slug = getProjectSlug(req.params.id);
    if (!slug) { sendJson(res, 404, { error: 'Project not found' }); return; }

    const cloneDir = repoCloneDir(slug, repo.name);

    if (!fs.existsSync(path.join(cloneDir, '.git'))) {
      sendJson(res, 200, { branches: [] });
      return;
    }

    try {
      const output = await spawnGit(['branch', '-r', '--format=%(refname:short)'], cloneDir);
      const branches = output
        .split('\n')
        .map((b) => b.trim().replace(/^origin\//, ''))
        .filter((b) => b && b !== 'HEAD');
      sendJson(res, 200, { branches: [...new Set(branches)] });
    } catch {
      sendJson(res, 200, { branches: [] });
    }
  });

  // PUT /api/projects/:id/repos/:repoId/default-branch
  router.put('/api/projects/:id/repos/:repoId/default-branch', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const repo = one<Repository>(
      'SELECT * FROM repositories WHERE id = ? AND project_id = ?',
      req.params.repoId,
      req.params.id,
    );
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const branch = str(body.branch, 'branch', { max: 255 }).trim();

    run(
      'UPDATE repositories SET default_branch = ? WHERE id = ?',
      branch,
      repo.id,
    );

    sendJson(res, 200, { ok: true });
  });
}
