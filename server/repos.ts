/**
 * Repositories API routes.
 *
 * Routes:
 *   GET    /api/projects/:id/repos                         — list repos
 *   POST   /api/projects/:id/repos                         — add repo
 *   GET    /api/projects/:id/repos/progress                — lightweight progress poll
 *   GET    /api/projects/:id/repos/:repoId                 — get repo details
 *   DELETE /api/projects/:id/repos/:repoId                 — remove repo
 *   POST   /api/projects/:id/repos/:repoId/sync            — trigger clone/sync
 *   GET    /api/projects/:id/repos/:repoId/branches        — list branches
 *   PUT    /api/projects/:id/repos/:repoId/default-branch  — update default branch
 */

import { registerBackgroundJob, runInBackground } from './background-jobs.ts';
import { getAwsAccountsRepository } from './repositories/aws-accounts.ts';
import fs from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one } from './db.ts';
import { generateId, now, str, badRequest, notFound, parseJson } from './util.ts';
import { config } from './config.ts';
import { buildGitEnv } from './git-connections.ts';
import { decrypt } from './secrets.ts';
import { ProgressTracker, redactCredentials } from './git-progress.ts';
import type { ProgressInfo } from './git-progress.ts';
import { getGitReposRepository } from './repositories/git-repos.ts';
import { getGitConnectionsRepository } from './repositories/git-connections.ts';

import { getMemberRow, getProjectRow, getRepoRow } from './project-access.ts';
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
  connection_id: string | null;
}

/** Alias used by diagram modules — same shape as Repository. */
export type Repo = Repository;

// ── In-memory progress state ──────────────────────────────────────────────────

/**
 * Active progress trackers, keyed by repo id.
 * Populated when a sync starts; deleted ~2 s after it finishes.
 */
const repoProgress = new Map<string, ProgressTracker>();

/**
 * Repo ids whose sync is currently in-flight.
 * Used to prevent concurrent syncs and to return 409.
 */
const syncInFlight = new Set<string>();

/** @internal Exposed for tests only — do not mutate from outside tests. */
export const _repoProgressForTest = repoProgress;
/** @internal Exposed for tests only. */
export const _syncInFlightForTest = syncInFlight;

/**
 * Active git child processes (clone/fetch) tracked for graceful shutdown.
 * Populated when a git subprocess starts; removed when it exits.
 */
const activeGitProcs = new Set<ChildProcess>();

/**
 * Kill all tracked git child processes.
 * Called on server shutdown so in-flight git operations do not keep
 * the Node.js event loop alive after the HTTP server has closed.
 */
export function killActiveGitProcesses(): void {
  for (const proc of activeGitProcs) {
    try { proc.kill(); } catch { /* already dead */ }
  }
  activeGitProcs.clear();
}

/** Attach the current progress snapshot (or null) to a repo row. */
function withProgress(repo: Repository): Repository & { progress: ProgressInfo | null } {
  return { ...repo, progress: repoProgress.get(repo.id)?.snapshot ?? null };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the directory on disk for a cloned repo. Uses the raw repo name (no slugification). */
function repoCloneDir(projectSlug: string, repoName: string): string {
  return path.join(config.dataDir, 'projects', projectSlug, 'repos', repoName);
}

/**
 * The on-disk path for a repo's reference clone, keyed by project slug and raw repo name.
 *
 * Exported so runner.ts and working-copies.ts can derive the same path without re-implementing
 * the logic. Uses `repoName` verbatim — this matches what `performSync` writes on disk (the
 * clone directory is always named after the raw repo name, never slugified).
 */
export function repoRefDir(projectSlug: string, repoName: string): string {
  return repoCloneDir(projectSlug, repoName);
}

/**
 * The reference clone directory for a repository. Used by diagram and document agents
 * to find the checked-out source files.
 *
 * Uses the raw `repo.name` (not slugified) — this matches what `performSync` wrote to disk.
 */
export async function repoDir(repo: Repo): Promise<string> {
  const slug = String((await getProjectRow(repo.project_id))?.slug ?? 'unknown');
  return repoCloneDir(slug, repo.name);
}

/** Look up a repo by id. Throws notFound if missing. */
export async function getRepo(id: string): Promise<Repo> {
  const r = await getRepoRow(id);
  if (!r) throw notFound('Repository not found');
  return r as unknown as Repo;
}

/** Get the project slug for a project id. */
async function getProjectSlug(projectId: string): Promise<string | null> {
  const row = await getProjectRow(projectId);
  return row ? String(row.slug) : null;
}

/** Require the caller to be authenticated and a member (or admin) of the project. */
async function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = await getProjectRow(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = await getMemberRow(projectId, req.user.id);
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
    proc.unref();
    (proc.stdout as unknown as { unref(): void }).unref();
    (proc.stderr as unknown as { unref(): void }).unref();
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

/**
 * Like spawnGit but:
 *   - Feeds stderr chunks to `onStderrChunk` for live progress parsing.
 *   - Redacts credentials from error messages before rejecting.
 */
function spawnGitWithProgress(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  onStderrChunk?: (chunk: Buffer) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    // Unref everything so the event loop can exit once the server closes,
    // even if the git process is still running (e.g. slow network or test cleanup).
    proc.unref();
    (proc.stdout as unknown as { unref(): void }).unref();
    (proc.stderr as unknown as { unref(): void }).unref();
    activeGitProcs.add(proc);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => {
      err.push(d);
      onStderrChunk?.(d);
    });
    proc.on('close', (code) => {
      activeGitProcs.delete(proc);
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8').trim());
      } else {
        const raw = Buffer.concat(err).toString('utf8').trim() || `git exited with ${code}`;
        reject(new Error(redactCredentials(raw)));
      }
    });
    proc.on('error', (e) => {
      activeGitProcs.delete(proc);
      reject(e);
    });
  });
}

// ── Git credential helpers ─────────────────────────────────────────────────────

/**
 * Generate a SigV4-derived username/password for CodeCommit HTTPS.
 *
 * Implements the exact algorithm from the AWS CLI codecommit credential helper
 * (awscli/customizations/codecommit.py, CodeCommitGetCommand.sign_request).
 *
 * canonical_request = "GIT\n{repoPath}\n\nhost:{hostname}\n\nhost\n"
 * string_to_sign    = "AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{sha256(canonical_request)}"
 * password          = "{timestamp}Z{hex(HMAC-signing-key, string_to_sign)}"
 * username          = accessKeyId [ "%" rawSessionToken ]   ← token is NOT percent-encoded
 *
 * The path signed is /v1/repos/<name> (trailing slash and .git stripped).
 * CodeCommit validates the signature against the repo path regardless of the
 * sub-path git requests (/info/refs, /git-upload-pack, …), so signing the
 * repo root path is correct when we inject a static http.<host>.extraHeader.
 *
 * Region is parsed from the host rather than passed as a parameter so the
 * credential exactly matches the endpoint git is talking to.
 */
export function _buildCodeCommitSigV4Password(
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken: string | undefined,
  remoteUrl: string,
  nowDate: Date = new Date(),
): { username: string; password: string } {
  let hostname: string;
  let repoPath: string;
  try {
    const u = new URL(remoteUrl);
    hostname = u.hostname;
    repoPath = u.pathname.replace(/\.git$/, '').replace(/\/$/, '') || '/';
  } catch {
    throw new Error(`Invalid CodeCommit remote URL: ${remoteUrl}`);
  }

  const regionMatch = hostname.match(
    /(vpce-.+\.)?git-codecommit(-fips)?\.([^.]+)\.(vpce\.)?amazonaws\.com/,
  );
  const region = regionMatch ? regionMatch[3] : 'us-east-1';

  const pad = (n: number) => String(n).padStart(2, '0');
  const datestamp = `${nowDate.getUTCFullYear()}${pad(nowDate.getUTCMonth() + 1)}${pad(nowDate.getUTCDate())}`;
  const timestamp = `${datestamp}T${pad(nowDate.getUTCHours())}${pad(nowDate.getUTCMinutes())}${pad(nowDate.getUTCSeconds())}`;

  const canonicalRequest = `GIT\n${repoPath}\n\nhost:${hostname}\n\nhost\n`;
  const canonicalHash = crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');

  const scope = `${datestamp}/${region}/codecommit/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${canonicalHash}`;

  const hmac = (key: Buffer | string, data: string): Buffer =>
    crypto.createHmac('sha256', key).update(data, 'utf8').digest();

  const kDate = hmac(Buffer.from('AWS4' + secretAccessKey, 'utf8'), datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 'codecommit');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const username = sessionToken
    ? `${accessKeyId}%${sessionToken}`
    : accessKeyId;

  return { username, password: `${timestamp}Z${signature}` };
}

/**
 * Build a git credential environment using GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n
 * (git ≥ 2.31) to inject an http.extraHeader Authorization header.
 *
 * Keeps secrets out of argv, out of process substitution, and out of .git/config.
 * Always adds GIT_TERMINAL_PROMPT=0 so a missing credential fails fast.
 */
async function getCloneEnv(repo: Repository): Promise<Record<string, string>> {
  // A CodeCommit repository clones with the project's default AWS account (Workspaces → AWS) when it has usable keys:
  // refreshing the keys there is enough, no Git connection is needed. Other hosts and projects without such an
  // account fall through to the repository's Git connection.
  if (repo.project_id && /git-codecommit(-fips)?\.[^.]+\.(vpce\.)?amazonaws\.com/.test(repo.url)) {
    try {
      const { readDefaultId } = await import('./project-aws.ts');
      const accountId = readDefaultId(String(repo.project_id));
      const acc = accountId ? await getAwsAccountsRepository().getById(accountId) : null;
      if (acc && String(acc.project_id) === String(repo.project_id) && acc.auth_method === 'keys' && acc.credentials_enc) {
        const c = parseJson<Record<string, string>>(decrypt(acc.credentials_enc, config.secretKey), {});
        if (c.accessKeyId && c.secretAccessKey) {
          const { username, password } = _buildCodeCommitSigV4Password(c.accessKeyId, c.secretAccessKey, c.sessionToken, repo.url);
          return buildGitEnv({ username, password }, 'codecommit', repo.url);
        }
      }
    } catch { /* fall back to the connection */ }
  }

  if (!repo.connection_id) return { GIT_TERMINAL_PROMPT: '0' };

  const conn = await getGitConnectionsRepository().getById(repo.connection_id);
  if (!conn?.credentials_enc) return { GIT_TERMINAL_PROMPT: '0' };

  let creds: Record<string, string>;
  try {
    const plain = decrypt(conn.credentials_enc, config.secretKey);
    creds = parseJson<Record<string, string>>(plain, {});
  } catch {
    return { GIT_TERMINAL_PROMPT: '0' };
  }

  if (conn.provider === 'codecommit') {
    const mode = (creds.mode as 'keys' | 'aws-account' | 'portal-sso' | undefined) ?? 'keys';
    const region = creds.region ?? 'us-east-1';

    let accessKeyId: string | undefined;
    let secretAccessKey: string | undefined;
    let sessionToken: string | undefined;

    if (mode === 'keys') {
      accessKeyId = creds.accessKeyId;
      secretAccessKey = creds.secretAccessKey;
      sessionToken = creds.sessionToken;
    } else if (mode === 'aws-account') {
      // The project's AWS account (AWS tab): the one the connection names, else the project's default one. Changing the
      // keys there changes what clones use. The account must belong to the repository's project.
      const { readDefaultId } = await import('./project-aws.ts');
      const accountId = creds.awsAccountId || (repo.project_id ? readDefaultId(String(repo.project_id)) : null);
      const acc = accountId ? await getAwsAccountsRepository().getById(accountId) : null;
      if (acc && (!repo.project_id || !acc.project_id || String(acc.project_id) === String(repo.project_id)) && acc.auth_method === 'keys' && acc.credentials_enc) {
        const plain = decrypt(acc.credentials_enc, config.secretKey);
        const c = parseJson<Record<string, string>>(plain, {});
        accessKeyId = c.accessKeyId;
        secretAccessKey = c.secretAccessKey;
        sessionToken = c.sessionToken;
      }
    } else if (mode === 'portal-sso') {
      const { getBedrockSsoCredentials } = await import('./bedrock-sso.ts');
      const sso = await getBedrockSsoCredentials();
      accessKeyId = sso.accessKeyId;
      secretAccessKey = sso.secretAccessKey;
      sessionToken = sso.sessionToken;
    }

    if (!accessKeyId || !secretAccessKey) return { GIT_TERMINAL_PROMPT: '0' };

    const { username, password } = _buildCodeCommitSigV4Password(
      accessKeyId, secretAccessKey, sessionToken, repo.url,
    );
    return buildGitEnv({ username, password }, 'codecommit', repo.url);
  }

  // GitHub, Bitbucket, and generic git — buildGitEnv knows each provider's header format.
  return buildGitEnv(creds, conn.provider, repo.url);
}

/** @internal Exposed for tests and diagnostic scripts — same as getCloneEnv. */
export const _getCloneEnv = getCloneEnv;

/** Background clone/sync operation. Updates status in the database. */
async function performSync(repoId: string, projectId: string): Promise<void> {
  // In test environments (PORTAL_DISABLE_GIT_SYNC=1), skip the actual git
  // subprocess so the event loop can exit cleanly after server close.
  if (process.env.PORTAL_DISABLE_GIT_SYNC === '1') return;

  // Prevent concurrent syncs of the same repo
  if (syncInFlight.has(repoId)) return;
  syncInFlight.add(repoId);

  // Create a fresh progress tracker and register it before any await
  const tracker = new ProgressTracker();
  repoProgress.set(repoId, tracker);

  const repo = await getGitReposRepository().getByIdForProject(repoId, projectId);
  if (!repo) {
    syncInFlight.delete(repoId);
    repoProgress.delete(repoId);
    return;
  }

  const slug = await getProjectSlug(projectId);
  if (!slug) {
    syncInFlight.delete(repoId);
    repoProgress.delete(repoId);
    return;
  }

  const cloneDir = repoCloneDir(slug, repo.name);
  const cloneEnv = await getCloneEnv(repo);

  // In the cloud the agents clone the repository themselves inside their own microVM, and Lambda's disk is
  // temporary and small, so "adding" a repository only checks that the portal can reach it and finds its
  // default branch. Nothing is stored on this machine.
  if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.PORTAL_REPO_SYNC_MODE === 'check') {
    try {
      const out = await spawnGit(['ls-remote', '--symref', repo.url, 'HEAD'], os.tmpdir(), cloneEnv);
      const m = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
      await getGitReposRepository().updateStatus(repoId, 'ready', {
        lastSyncedAt: now(),
        defaultBranch: m ? m[1] : repo.default_branch,
        lastError: null,
      });
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      await getGitReposRepository().updateStatus(repoId, 'error', {
        lastError: `Could not reach the repository: ${raw}`.replace(/https?:\/\/[^@\s]*@/g, 'https://').slice(0, 500),
      });
    } finally {
      repoProgress.delete(repoId);
      syncInFlight.delete(repoId);
    }
    return;
  }

  const onChunk = (chunk: Buffer) => tracker.feedChunk(chunk);

  try {
    if (fs.existsSync(path.join(cloneDir, '.git'))) {
      // Already cloned — fetch with progress
      await spawnGitWithProgress(['fetch', '--all', '--prune', '--progress'], cloneDir, cloneEnv, onChunk);
    } else {
      // Fresh clone with progress.
      // -c core.longpaths=true: enables Win32 long-path API so repos with deeply-nested
      // paths (>260 chars) clone successfully on Windows.
      await fsp.mkdir(path.dirname(cloneDir), { recursive: true });
      await spawnGitWithProgress(
        ['clone', '--progress', '-c', 'core.longpaths=true', repo.url, cloneDir],
        path.dirname(cloneDir),
        cloneEnv,
        onChunk,
      );
    }

    tracker.finalize();

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

    await getGitReposRepository().updateStatus(repoId, 'ready', {
      lastSyncedAt: now(),
      defaultBranch,
      lastError: null,
    });

    // Keep progress visible at 100% briefly so pollers catch the finished state
    setTimeout(() => {
      repoProgress.delete(repoId);
    }, 2000);

  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    // Enrich error with the phase context so users know where it failed
    const snap = tracker.snapshot;
    const phaseContext =
      snap.phase !== 'connecting' && snap.phase !== 'finalizing'
        ? `Failed while ${snap.phaseLabel.toLowerCase()} (${snap.phasePercent ?? '?'}%): `
        : '';
    const msg = `${phaseContext}${raw}`.slice(0, 1000);

    await getGitReposRepository().updateStatus(repoId, 'error', { lastError: msg });
    repoProgress.delete(repoId);
  } finally {
    syncInFlight.delete(repoId);
  }
}

// On Lambda a clone started after the reply would be frozen or recycled mid-way, so it runs as its own invocation.
registerBackgroundJob('repo-sync', async (a) => { await performSync(String(a.repoId), String(a.projectId)); });

// ── Route registration ────────────────────────────────────────────────────────

export function registerRepoRoutes(): void {

  // GET /api/projects/:id/repos
  router.get('/api/projects/:id/repos', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const repos = await getGitReposRepository().listByProject(req.params.id);
    sendJson(res, 200, { repos: repos.map(withProgress) });
  });

  // POST /api/projects/:id/repos
  router.post('/api/projects/:id/repos', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const url = str(body.url, 'url', { max: 1000 }).trim();
    const provider = str(body.provider, 'provider', { max: 32 }).trim();

    if (!['github', 'codecommit', 'bitbucket', 'git'].includes(provider)) {
      sendJson(res, 400, { error: 'provider must be github, codecommit, bitbucket, or git' });
      return;
    }
    if (!url) { sendJson(res, 400, { error: 'url is required' }); return; }

    const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : null;

    const id = generateId();
    const ts = now();

    const repo = await getGitReposRepository().create({
      id, project_id: req.params.id, name, url, provider, status: 'cloning',
      default_branch: typeof body.defaultBranch === 'string' ? body.defaultBranch.trim() : null,
      identity: null, last_synced_at: null, last_error: null, created_at: ts,
      connection_id: connectionId,
    });

    // Start background clone immediately
    await runInBackground('repo-sync', { repoId: id, projectId: req.params.id });

    sendJson(res, 201, { repo: withProgress(repo) });
  });

  // GET /api/projects/:id/repos/progress
  // Lightweight polling endpoint — returns only id, status, progress, lastError
  // for every repo in the project. Must be registered before /:repoId so the
  // literal segment "progress" is not captured as a repoId.
  router.get('/api/projects/:id/repos/progress', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const repos = await getGitReposRepository().listByProject(req.params.id);
    const result = repos.map((r) => ({
      id: r.id,
      status: r.status,
      progress: repoProgress.get(r.id)?.snapshot ?? null,
      lastError: r.last_error,
    }));
    sendJson(res, 200, { repos: result });
  });

  // GET /api/projects/:id/repos/:repoId
  router.get('/api/projects/:id/repos/:repoId', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const repo = await getGitReposRepository().getByIdForProject(req.params.repoId, req.params.id);
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    sendJson(res, 200, { repo: withProgress(repo) });
  });

  // DELETE /api/projects/:id/repos/:repoId
  router.delete('/api/projects/:id/repos/:repoId', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const deleted = await getGitReposRepository().delete(req.params.repoId, req.params.id);
    if (!deleted) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/repos/:repoId/sync
  router.post('/api/projects/:id/repos/:repoId/sync', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const repo = await getGitReposRepository().getByIdForProject(req.params.repoId, req.params.id);
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    // If a sync is already running, attach to it
    if (syncInFlight.has(repo.id)) {
      sendJson(res, 202, { ok: true, status: repo.status, alreadySyncing: true });
      return;
    }

    const slug = await getProjectSlug(req.params.id);
    const isReclone = slug
      ? fs.existsSync(path.join(repoCloneDir(slug, repo.name), '.git'))
      : false;
    const nextStatus = isReclone ? 'syncing' : 'cloning';

    await getGitReposRepository().updateStatus(repo.id, nextStatus, { lastError: null });

    await runInBackground('repo-sync', { repoId: repo.id, projectId: req.params.id });

    sendJson(res, 202, { ok: true, status: nextStatus });
  });

  // GET /api/projects/:id/repos/:repoId/branches
  router.get('/api/projects/:id/repos/:repoId/branches', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const found = await getGitReposRepository().getByIdForProject(req.params.repoId, req.params.id);
    const repo = (found ?? undefined) as unknown as Repository | undefined;
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    const slug = await getProjectSlug(req.params.id);
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
  router.put('/api/projects/:id/repos/:repoId/default-branch', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const repo = await getGitReposRepository().getByIdForProject(req.params.repoId, req.params.id);
    if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const branch = str(body.branch, 'branch', { max: 255 }).trim();

    await getGitReposRepository().updateDefaultBranch(repo.id, branch);

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/repos/bulk
  // Bulk-add repos from a connection, skipping duplicates (by URL).
  router.post('/api/projects/:id/repos/bulk', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : '';
    if (!connectionId) { sendJson(res, 400, { error: 'connectionId is required' }); return; }

    const repoList = Array.isArray(body.repos) ? body.repos as Array<Record<string, unknown>> : [];
    if (repoList.length === 0) { sendJson(res, 400, { error: 'repos array is required and must not be empty' }); return; }
    if (repoList.length > 100) { sendJson(res, 400, { error: 'Cannot bulk-add more than 100 repos at once' }); return; }

    // Verify connection exists and is accessible
    const conn = await getGitConnectionsRepository().getById(connectionId);
    if (!conn) { sendJson(res, 404, { error: 'Connection not found' }); return; }

    // Access check: personal connections only usable by their owner
    if (conn.scope === 'personal' && !req.user!.is_admin && conn.owner_id !== req.user!.id) {
      sendJson(res, 403, { error: 'You do not have access to this connection' });
      return;
    }

    // Collect existing URLs in this project to detect duplicates
    const existingUrlList = await getGitReposRepository().listUrlsByProject(req.params.id);
    const existingUrls = new Set(existingUrlList.map((u) => u.toLowerCase()));

    const added: Array<Record<string, unknown>> = [];
    const skipped: Array<{ url: string; reason: string }> = [];
    const errors: Array<{ url: string; error: string }> = [];
    const ts = now();

    for (const repoInput of repoList) {
      const url = typeof repoInput.url === 'string' ? repoInput.url.trim() : '';
      if (!url) { errors.push({ url: '', error: 'url is required' }); continue; }

      if (existingUrls.has(url.toLowerCase())) {
        skipped.push({ url, reason: 'already in project' });
        continue;
      }

      try {
        let name = typeof repoInput.name === 'string' ? repoInput.name.trim() : '';
        if (!name) {
          const urlObj = new URL(url);
          name = urlObj.pathname.replace(/\.git$/, '').split('/').filter(Boolean).pop() ?? 'repo';
        }
        const defaultBranch = typeof repoInput.defaultBranch === 'string' ? repoInput.defaultBranch.trim() : null;

        const id = generateId();
        const repo = await getGitReposRepository().create({
          id, project_id: req.params.id, name: name.slice(0, 120), url,
          provider: conn.provider, status: 'cloning', default_branch: defaultBranch,
          identity: null, last_synced_at: null, last_error: null, created_at: ts,
          connection_id: connectionId,
        });
        existingUrls.add(url.toLowerCase());
        added.push(withProgress(repo) as unknown as Record<string, unknown>);
        await runInBackground('repo-sync', { repoId: id, projectId: req.params.id });
      } catch (e: unknown) {
        errors.push({ url, error: e instanceof Error ? e.message : String(e) });
      }
    }

    sendJson(res, 200, { added, skipped, errors });
  });
}
