/**
 * Git connections API routes — shared credential store.
 *
 * Routes:
 *   GET    /api/git-connections                          — list user's own + shared connections
 *   POST   /api/git-connections                          — create connection
 *   PUT    /api/git-connections/:id                      — update connection
 *   DELETE /api/git-connections/:id                      — delete connection
 *   POST   /api/git-connections/:id/test                 — test credentials against provider API
 *   GET    /api/git-connections/:id/repos                — discover repos via provider API
 *   POST   /api/git-connections/github/device/start      — begin GitHub OAuth device flow
 *   POST   /api/git-connections/github/device/poll       — poll GitHub OAuth device flow
 */

import { spawn } from 'node:child_process';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, getDb } from './db.ts';
import { generateId, now, str, parseJson } from './util.ts';
import { encrypt, decrypt } from './secrets.ts';
import { config } from './config.ts';
import { appendAudit } from './audit.ts';
import { getSetting } from './settings.ts';
import { getGitConnectionsRepository } from './repositories/git-connections.ts';
import type { GitConnectionRecord } from './repositories/git-connections.ts';

import { getMemberRow } from './project-access.ts';
// ── Types ─────────────────────────────────────────────────────────────────────

export type GitConnection = GitConnectionRecord;

export interface DiscoveredRepo {
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
  description: string;
  updatedAt: string;
}

// ── In-memory GitHub device-flow state ────────────────────────────────────────

interface DeviceFlowState {
  clientId: string;
  deviceCode: string;
  expiresAt: number;
  interval: number;
  name: string;
  scope: string;
  userId: string;
}

const deviceFlows = new Map<string, DeviceFlowState>();

// Clean up expired flows every 5 minutes
setInterval(() => {
  const cutoff = Date.now();
  for (const [id, state] of deviceFlows) {
    if (state.expiresAt < cutoff) deviceFlows.delete(id);
  }
}, 5 * 60_000).unref();

// ── Repo discovery cache (2-minute TTL per connection) ────────────────────────

interface RepoCacheEntry {
  expiry: number;
  repos: DiscoveredRepo[];
  workspaces?: string[];
  /** Region searched — set for CodeCommit connections so the UI can report it. */
  region?: string;
}

const repoCache = new Map<string, RepoCacheEntry>();

/** @internal Clear repo cache (for tests). */
export function _clearRepoCache(): void {
  repoCache.clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip credentials from a connection before sending to the browser. */
function safeConnection(c: GitConnection) {
  const { credentials_enc: _cred, ...rest } = c;
  let hasSessionToken = false;
  if (c.credentials_enc) {
    try {
      const plain = decrypt(c.credentials_enc, config.secretKey);
      const cr = parseJson<Record<string, string>>(plain, {});
      if (cr.mode === 'keys' && cr.sessionToken) hasSessionToken = true;
    } catch { /* ignore */ }
  }
  return { ...rest, hasSessionToken };
}

/**
 * Returns true if an AWS SDK error matches any of the given name/message patterns.
 * Mirrors the private matchSdkError helper used in bedrock-sso.ts and credentials.ts.
 */
function matchAwsError(e: unknown, ...patterns: string[]): boolean {
  const err = e as { name?: string; message?: string } | null;
  const n = String(err?.name ?? '');
  const m = String(err?.message ?? '');
  return patterns.some((p) => n === p || m.includes(p));
}

/**
 * Maps AWS token errors to a user-friendly message.
 * Returns null when the error is not a recognised token problem.
 */
function classifyAwsTokenError(e: unknown): string | null {
  if (
    matchAwsError(e, 'ExpiredTokenException', 'ExpiredToken') ||
    matchAwsError(e, 'UnrecognizedClientException') ||
    matchAwsError(e, 'InvalidClientTokenId')
  ) {
    return (
      'The temporary AWS credentials on this connection have expired or are invalid. ' +
      'Paste fresh credentials from the AWS access portal, or switch the connection to ' +
      '"Portal AWS SSO identity".'
    );
  }
  if (
    matchAwsError(e, 'InvalidSignatureException') ||
    matchAwsError(e, 'AuthFailure', 'authentication failure')
  ) {
    return (
      'The AWS secret access key does not match the access key ID. ' +
      'Re-enter the credentials from the AWS access portal.'
    );
  }
  return null;
}

/**
 * Validate CodeCommit "keys" mode credentials.
 * Returns an error string when ASIA temp credentials are missing a session token.
 */
function validateCodeCommitCreds(c: Record<string, unknown>): string | null {
  const mode = String(c.mode ?? 'keys');
  if (mode === 'keys') {
    const keyId = String(c.accessKeyId ?? '');
    if (keyId.startsWith('ASIA') && !c.sessionToken) {
      return 'Temporary credentials (ASIA…) need a session token';
    }
  }
  return null;
}

/** Require caller is authenticated and owns the connection (or is admin). */
function requireConnectionAccess(
  req: PortalRequest,
  res: PortalResponse,
  conn: GitConnection,
): boolean {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  if (!req.user.is_admin && conn.owner_id !== req.user.id) {
    sendJson(res, 403, { error: 'You do not have access to this connection' });
    return false;
  }
  return true;
}

/** Require browser-session (no API token) + authenticated. */
function requireBrowserAuth(req: PortalRequest, res: PortalResponse): boolean {
  const authHeader = String(req.headers.authorization ?? '');
  if (authHeader.startsWith('Bearer ')) {
    sendJson(res, 403, {
      error: 'Git connection credential routes can only be accessed from a signed-in browser, not via API tokens',
    });
    return false;
  }
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  return true;
}

/** Build a Bitbucket Basic auth header (email:apiToken). */
function bitbucketBasicAuth(email: string, apiToken: string): string {
  return 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
}

/** Parse a GitHub repo URL → { owner, repo } | null. */
function parseGitHubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// ── Injectable provider implementations ─────────────────────────────────────

/** Start a GitHub device-authorization flow. */
async function _doGithubDeviceStart(clientId: string, scope: string): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}> {
  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`GitHub device/code: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json() as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (data.error) throw new Error(data.error_description ?? data.error);
  return {
    deviceCode: data.device_code ?? '',
    userCode: data.user_code ?? '',
    verificationUri: data.verification_uri ?? 'https://github.com/login/device',
    expiresIn: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  };
}

/** Poll a GitHub device-authorization flow. */
async function _doGithubDevicePoll(
  clientId: string,
  deviceCode: string,
): Promise<{
  status: 'pending' | 'complete' | 'expired' | 'denied' | 'slow_down';
  token?: string;
  interval?: number;
}> {
  const resp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`GitHub poll: ${resp.status} ${resp.statusText}`);
  const data = await resp.json() as {
    access_token?: string;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (data.access_token) return { status: 'complete', token: data.access_token };
  switch (data.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down': return { status: 'slow_down', interval: data.interval };
    case 'expired_token': return { status: 'expired' };
    case 'access_denied': return { status: 'denied' };
    case 'device_flow_disabled':
      throw new Error('Enable Device Flow on the OAuth App in GitHub settings.');
    case 'incorrect_client_credentials':
      throw new Error('Incorrect OAuth client credentials — check the client ID in Settings.');
    default: throw new Error(data.error_description ?? data.error ?? 'Unknown poll error');
  }
}

/** Verify a GitHub token and return account info. */
async function _doGithubTestConnection(token: string): Promise<{
  login: string;
  name: string;
}> {
  const resp = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(`GitHub API: ${body.message ?? resp.statusText}`);
  }
  const data = await resp.json() as { login?: string; name?: string };
  return { login: data.login ?? '', name: data.name ?? data.login ?? '' };
}

/** List repos accessible to a GitHub token. */
async function _doGithubListRepos(
  token: string,
  q: string,
  page: number,
): Promise<{ repos: DiscoveredRepo[]; nextPage: number | null }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const perPage = 30;

  if (q) {
    // Use GitHub search API for filtered queries — searches across ALL accessible repos,
    // not just the current page.
    const searchResp = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+fork:true&per_page=${perPage}&page=${page}`,
      { headers, signal: AbortSignal.timeout(20_000) },
    );
    if (!searchResp.ok) {
      const body = await searchResp.json().catch(() => ({})) as { message?: string };
      if (searchResp.status === 401 || searchResp.status === 403) {
        throw new Error(`Invalid GitHub token or insufficient scope: ${body.message ?? searchResp.statusText}`);
      }
      throw new Error(`GitHub search API: ${searchResp.status} ${body.message ?? searchResp.statusText}`);
    }
    const searchData = await searchResp.json() as {
      total_count?: number;
      items?: Array<{
        name?: string;
        full_name?: string;
        clone_url?: string;
        default_branch?: string;
        private?: boolean;
        description?: string;
        updated_at?: string;
      }>;
    };
    const repos: DiscoveredRepo[] = (searchData.items ?? []).map((r) => ({
      name: r.name ?? '',
      fullName: r.full_name ?? '',
      url: r.clone_url ?? '',
      defaultBranch: r.default_branch ?? 'main',
      private: r.private ?? false,
      description: r.description ?? '',
      updatedAt: r.updated_at ?? '',
    }));
    const linkHeader = searchResp.headers.get('link') ?? '';
    const hasNext = linkHeader.includes('rel="next"');
    return { repos, nextPage: hasNext ? page + 1 : null };
  }

  // No search term — list all accessible repos
  const resp = await fetch(
    `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { message?: string };
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Invalid GitHub token or insufficient scope: ${body.message ?? resp.statusText}`);
    }
    throw new Error(`GitHub repos API: ${resp.status} ${body.message ?? resp.statusText}`);
  }
  const items = await resp.json() as Array<{
    name?: string;
    full_name?: string;
    clone_url?: string;
    default_branch?: string;
    private?: boolean;
    description?: string;
    updated_at?: string;
  }>;

  const repos: DiscoveredRepo[] = items.map((r) => ({
    name: r.name ?? '',
    fullName: r.full_name ?? '',
    url: r.clone_url ?? '',
    defaultBranch: r.default_branch ?? 'main',
    private: r.private ?? false,
    description: r.description ?? '',
    updatedAt: r.updated_at ?? '',
  }));

  const linkHeader = resp.headers.get('link') ?? '';
  const hasNext = linkHeader.includes('rel="next"');
  return { repos, nextPage: hasNext ? page + 1 : null };
}

/** Verify Bitbucket credentials and return account info. */
async function _doBitbucketTestConnection(
  email: string,
  apiToken: string,
): Promise<{ email: string; name: string }> {
  const resp = await fetch('https://api.bitbucket.org/2.0/user', {
    headers: { Authorization: bitbucketBasicAuth(email, apiToken), Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    if (resp.status === 401) throw new Error('Invalid Bitbucket credentials');
    throw new Error(`Bitbucket API: ${body.error?.message ?? resp.statusText}`);
  }
  const data = await resp.json() as {
    account_id?: string;
    display_name?: string;
    username?: string;
    links?: { avatar?: { href?: string } };
  };
  return { email, name: data.display_name ?? data.username ?? email };
}

/** List Bitbucket workspaces accessible to the credentials. */
async function _doBitbucketListWorkspaces(
  email: string,
  apiToken: string,
): Promise<string[]> {
  const resp = await fetch(
    'https://api.bitbucket.org/2.0/user/permissions/workspaces?pagelen=50',
    {
      headers: { Authorization: bitbucketBasicAuth(email, apiToken), Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!resp.ok) return [];
  const data = await resp.json() as {
    values?: Array<{ workspace?: { slug?: string } }>;
  };
  return (data.values ?? []).map((v) => v.workspace?.slug ?? '').filter(Boolean);
}

/** List repos in a Bitbucket workspace. */
async function _doBitbucketListRepos(
  email: string,
  apiToken: string,
  workspace: string,
  q: string,
  page: number,
): Promise<{ repos: DiscoveredRepo[]; nextPage: number | null }> {
  const auth = bitbucketBasicAuth(email, apiToken);
  const perPage = 25;
  const qParam = q ? `&q=name~"${encodeURIComponent(q)}"` : '';
  const url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}?role=member&pagelen=${perPage}&page=${page}${qParam}`;

  const resp = await fetch(url, {
    headers: { Authorization: auth, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Invalid Bitbucket credentials or no access to workspace "${workspace}"`);
    }
    throw new Error(`Bitbucket repos: ${resp.status} ${body.error?.message ?? resp.statusText}`);
  }
  const data = await resp.json() as {
    values?: Array<{
      slug?: string;
      full_name?: string;
      links?: { clone?: Array<{ href?: string; name?: string }> };
      mainbranch?: { name?: string };
      is_private?: boolean;
      description?: string;
      updated_on?: string;
    }>;
    next?: string;
  };

  const repos: DiscoveredRepo[] = (data.values ?? []).map((r) => {
    const httpsClone =
      (r.links?.clone ?? []).find((c) => c.name === 'https')?.href ?? '';
    return {
      name: r.slug ?? '',
      fullName: r.full_name ?? '',
      url: httpsClone,
      defaultBranch: r.mainbranch?.name ?? 'main',
      private: r.is_private ?? false,
      description: r.description ?? '',
      updatedAt: r.updated_on ?? '',
    };
  });

  return { repos, nextPage: data.next ? page + 1 : null };
}

/** Verify CodeCommit credentials and return account info via ListRepositories. */
async function _doCodeCommitTestConnection(creds: {
  mode: 'keys' | 'aws-account' | 'portal-sso';
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  awsAccountId?: string;
  connectionOwnerId?: string;
  callerIsAdmin?: boolean;
}): Promise<{ login: string; name: string }> {
  const resolved = await resolveCodeCommitAwsCreds(creds);
  const { CodeCommitClient, ListRepositoriesCommand } = await import('@aws-sdk/client-codecommit');
  const client = new CodeCommitClient({ region: creds.region, credentials: resolved ?? undefined });
  await client.send(new ListRepositoriesCommand({ order: 'ascending', sortBy: 'repositoryName', nextToken: undefined }));
  return { login: creds.awsAccountId ?? 'aws-account', name: `CodeCommit (${creds.region})` };
}

/** List CodeCommit repositories in the configured region. */
async function _doCodeCommitListRepos(
  creds: {
    mode: 'keys' | 'aws-account' | 'portal-sso';
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    awsAccountId?: string;
    connectionOwnerId?: string;
    callerIsAdmin?: boolean;
  },
  q: string,
  nextToken: string,
): Promise<{ repos: DiscoveredRepo[]; nextPage: string | null }> {
  const resolved = await resolveCodeCommitAwsCreds(creds);
  const { CodeCommitClient, ListRepositoriesCommand, BatchGetRepositoriesCommand } =
    await import('@aws-sdk/client-codecommit');
  const client = new CodeCommitClient({ region: creds.region, credentials: resolved ?? undefined });

  const listResult = await client.send(
    new ListRepositoriesCommand({
      order: 'descending',
      sortBy: 'lastModifiedDate',
      nextToken: nextToken || undefined,
    }),
  );
  const names = (listResult.repositories ?? []).map((r) => r.repositoryName ?? '').filter(Boolean);

  if (names.length === 0) return { repos: [], nextPage: listResult.nextToken ?? null };

  // BatchGetRepositories is capped at 25 names per call — chunk and merge.
  const BATCH_LIMIT = 25;
  const rawRepos: Array<{
    repositoryName?: string;
    cloneUrlHttp?: string;
    defaultBranch?: string;
    repositoryDescription?: string;
    lastModifiedDate?: Date;
  }> = [];
  for (let i = 0; i < names.length; i += BATCH_LIMIT) {
    const chunk = names.slice(i, i + BATCH_LIMIT);
    const batchResult = await client.send(new BatchGetRepositoriesCommand({ repositoryNames: chunk }));
    rawRepos.push(...(batchResult.repositories ?? []));
  }

  let repos: DiscoveredRepo[] = rawRepos.map((r) => ({
    name: r.repositoryName ?? '',
    fullName: r.repositoryName ?? '',
    url: r.cloneUrlHttp ?? '',
    defaultBranch: r.defaultBranch ?? 'main',
    private: true,
    description: r.repositoryDescription ?? '',
    updatedAt: r.lastModifiedDate ? new Date(r.lastModifiedDate).toISOString() : '',
  }));

  if (q) {
    const lq = q.toLowerCase();
    repos = repos.filter((r) => r.name.toLowerCase().includes(lq));
  }

  return { repos, nextPage: listResult.nextToken ?? null };
}

/** Resolve short-lived AWS credentials for CodeCommit operations. */
export async function resolveCodeCommitAwsCreds(creds: {
  mode: 'keys' | 'aws-account' | 'portal-sso';
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Session token for temporary credentials (ASIA* access key IDs). */
  sessionToken?: string;
  awsAccountId?: string;
  /** Owner of the git connection — used for aws-account access checks. */
  connectionOwnerId?: string;
  /** Whether the caller is an admin (bypasses project membership check). */
  callerIsAdmin?: boolean;
}): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null> {
  if (creds.mode === 'keys' && creds.accessKeyId && creds.secretAccessKey) {
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    };
  }
  if (creds.mode === 'aws-account' && creds.awsAccountId) {
    interface AccRow { credentials_enc: string | null; auth_method: string; project_id: string | null }
    const acc = one<AccRow>(
      'SELECT credentials_enc, auth_method, project_id FROM aws_accounts WHERE id = ? LIMIT 1',
      creds.awsAccountId,
    );
    if (!acc) throw new Error(`AWS account ${creds.awsAccountId} not found`);

    // Authorization: the requesting user must be a member (or admin) of the project
    // that owns this AWS account. Admins may access any account.
    if (!creds.callerIsAdmin && acc.project_id && creds.connectionOwnerId) {
      const isMember = await getMemberRow(acc.project_id, creds.connectionOwnerId);
      const isProjectAdmin = one<{ id: string }>(
        'SELECT id FROM users WHERE id = ? AND is_admin = 1 LIMIT 1',
        creds.connectionOwnerId,
      );
      if (!isMember && !isProjectAdmin) {
        throw new Error(`Access denied: you do not have access to AWS account ${creds.awsAccountId}`);
      }
    }

    if (acc.auth_method === 'keys' && acc.credentials_enc) {
      const plain = decrypt(acc.credentials_enc, config.secretKey);
      const c = parseJson<Record<string, string>>(plain, {});
      if (c.accessKeyId && c.secretAccessKey) {
        return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
      }
    }
    return null; // instance-role / ambient
  }
  if (creds.mode === 'portal-sso') {
    const { getBedrockSsoCredentials } = await import('./bedrock-sso.ts');
    const c = await getBedrockSsoCredentials();
    return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken };
  }
  return null;
}

/** Run git ls-remote with optional credentials in the environment. */
function testGitRemote(url: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['ls-remote', '--exit-code', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    proc.unref();
    proc.stderr.unref();
    const err: Buffer[] = [];
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(Buffer.concat(err).toString('utf8').trim() || `git exited with ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Minimum git version required for GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n.
 * Available since git 2.31 (released 2021-03-15).
 */
const GIT_CONFIG_ENV_MIN_VERSION = [2, 31, 0] as const;

/**
 * Parse a git version string like "git version 2.39.1" into [major, minor, patch].
 * Returns null if it cannot be parsed.
 */
function parseGitVersion(versionOutput: string): [number, number, number] | null {
  const m = versionOutput.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] ?? '0', 10)];
}

/**
 * Returns true if the installed git version is at least [major, minor, patch].
 * Caches the result after the first successful parse.
 */
let _gitVersionCache: [number, number, number] | null | undefined;
async function gitVersionAtLeast(min: readonly [number, number, number]): Promise<boolean> {
  if (_gitVersionCache === undefined) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileP = promisify(execFile);
      const { stdout } = await execFileP('git', ['--version']);
      _gitVersionCache = parseGitVersion(stdout);
    } catch {
      _gitVersionCache = null;
    }
  }
  if (!_gitVersionCache) return false;
  const [ma, mi, pa] = _gitVersionCache;
  const [minMa, minMi, minPa] = min;
  if (ma !== minMa) return ma > minMa;
  if (mi !== minMi) return mi > minMi;
  return pa >= minPa;
}

/**
 * Build a git-credential environment using GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n /
 * GIT_CONFIG_VALUE_n (git ≥ 2.31) to inject an http.extraHeader Authorization
 * header scoped to the remote host.
 *
 * This keeps secrets out of argv and out of .git/config.
 * Always adds GIT_TERMINAL_PROMPT=0 so a missing credential fails fast.
 *
 * @param credentials   Decrypted credentials object.
 * @param provider      Provider name: 'github' | 'bitbucket' | 'git' | ...
 * @param remoteUrl     Optional remote URL; used to scope the header to the host.
 */
export async function buildGitEnv(
  credentials: Record<string, string>,
  provider: string,
  remoteUrl?: string,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };

  let authHeader: string | null = null;
  let hostScope: string | null = null;

  if (provider === 'github' && credentials.token) {
    authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${credentials.token}`).toString('base64')}`;
    hostScope = 'https://github.com/';
  } else if (provider === 'bitbucket' && credentials.apiToken) {
    // Bitbucket: x-token-auth as username, token as password
    authHeader = `Authorization: Basic ${Buffer.from(`x-token-auth:${credentials.apiToken}`).toString('base64')}`;
    hostScope = 'https://bitbucket.org/';
  } else if (credentials.username && credentials.password) {
    authHeader = `Authorization: Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
    // Scope to the host from remoteUrl when available
    if (remoteUrl) {
      try {
        const u = new URL(remoteUrl);
        hostScope = `${u.protocol}//${u.host}/`;
      } catch {
        // fall through — inject without scoping
      }
    }
  }

  if (!authHeader) return env;

  if (!(await gitVersionAtLeast(GIT_CONFIG_ENV_MIN_VERSION))) {
    throw new Error(
      `Git version ${GIT_CONFIG_ENV_MIN_VERSION.join('.')} or newer is required for secure credential injection (GIT_CONFIG_COUNT). ` +
      `Please upgrade git.`,
    );
  }

  const configKey = hostScope
    ? `http.${hostScope}.extraHeader`
    : 'http.extraHeader';

  // Entry 0: clear any system credential helper (e.g. Git Credential Manager on Windows).
  // An empty value resets the helper list, preventing the system helper from intercepting
  // the request and returning cached (possibly stale) credentials.
  // Entry 1: inject the pre-computed Authorization header scoped to the remote host.
  env['GIT_CONFIG_COUNT'] = '2';
  env['GIT_CONFIG_KEY_0'] = 'credential.helper';
  env['GIT_CONFIG_VALUE_0'] = '';
  env['GIT_CONFIG_KEY_1'] = configKey;
  env['GIT_CONFIG_VALUE_1'] = authHeader;

  return env;
}

// ── Injectable providers (overrideable in tests) ──────────────────────────────

export const _gitConnProviders = {
  githubDeviceStart: _doGithubDeviceStart,
  githubDevicePoll: _doGithubDevicePoll,
  githubTestConnection: _doGithubTestConnection,
  githubListRepos: _doGithubListRepos,
  bitbucketTestConnection: _doBitbucketTestConnection,
  bitbucketListWorkspaces: _doBitbucketListWorkspaces,
  bitbucketListRepos: _doBitbucketListRepos,
  codecommitTestConnection: _doCodeCommitTestConnection,
  codecommitListRepos: _doCodeCommitListRepos,
};

/** @internal Exposed for tests only — directly calls `_doCodeCommitListRepos`. */
export const _doCodeCommitListReposForTest = _doCodeCommitListRepos;

// ── Credential extraction helpers ─────────────────────────────────────────────

function decryptCreds(conn: GitConnection): Record<string, string> {
  if (!conn.credentials_enc) return {};
  try {
    const plain = decrypt(conn.credentials_enc, config.secretKey);
    return parseJson<Record<string, string>>(plain, {});
  } catch {
    return {};
  }
}

/**
 * Merge incoming credentials with stored credentials on PUT, preserving blank or
 * missing secret fields instead of overwriting them with empty strings.
 *
 * Returns `{ merged }` on success or `{ error }` for a 400 validation failure.
 */
function mergeCredentialsOnUpdate(
  provider: string,
  incoming: Record<string, unknown>,
  stored: Record<string, string>,
): { merged: Record<string, unknown> } | { error: string } {
  if (provider === 'github') {
    const merged: Record<string, unknown> = { ...stored };
    const tok = String(incoming.token ?? '').trim();
    if (tok) merged.token = tok;
    return { merged };
  }

  if (provider === 'bitbucket') {
    const merged: Record<string, unknown> = { ...stored };
    const apiToken = String(incoming.apiToken ?? '').trim();
    if (apiToken) merged.apiToken = apiToken;
    const email = String(incoming.email ?? '').trim();
    if (email) merged.email = email;
    if (incoming.workspace !== undefined) merged.workspace = String(incoming.workspace ?? '').trim();
    return { merged };
  }

  if (provider === 'git') {
    const merged: Record<string, unknown> = { ...stored };
    const tok = String(incoming.token ?? '').trim();
    if (tok) merged.token = tok;
    const username = String(incoming.username ?? '').trim();
    if (username) merged.username = username;
    const password = String(incoming.password ?? '');
    if (password) merged.password = password;
    return { merged };
  }

  if (provider === 'codecommit') {
    const incomingMode = String(incoming.mode ?? stored.mode ?? 'keys');
    const merged: Record<string, unknown> = {
      mode: incomingMode,
      region: String(incoming.region ?? stored.region ?? 'us-east-1'),
    };

    if (incomingMode === 'aws-account') {
      const awsAccountId = String(incoming.awsAccountId ?? stored.awsAccountId ?? '');
      if (awsAccountId) merged.awsAccountId = awsAccountId;
    } else if (incomingMode === 'keys') {
      const incomingKeyId = String(incoming.accessKeyId ?? '').trim();
      const storedKeyId = String(stored.accessKeyId ?? '');

      if (incomingKeyId && incomingKeyId !== storedKeyId) {
        // New (different) accessKeyId supplied — treat as a fresh key set.
        const incomingSecret = String(incoming.secretAccessKey ?? '').trim();
        if (!incomingSecret) {
          return { error: 'A new access key ID requires a secret access key' };
        }
        merged.accessKeyId = incomingKeyId;
        merged.secretAccessKey = incomingSecret;
        // sessionToken: use body value; blank means clear the token.
        const sessionToken = String(incoming.sessionToken ?? '').trim();
        if (sessionToken) merged.sessionToken = sessionToken;
      } else {
        // Blank or unchanged accessKeyId — preserve stored key material.
        if (storedKeyId) merged.accessKeyId = storedKeyId;
        const incomingSecret = String(incoming.secretAccessKey ?? '').trim();
        const secretAccessKey = incomingSecret || String(stored.secretAccessKey ?? '');
        if (secretAccessKey) merged.secretAccessKey = secretAccessKey;
        // sessionToken: keep stored unless a new non-blank one is supplied.
        const incomingToken = String(incoming.sessionToken ?? '').trim();
        const sessionToken = incomingToken || String(stored.sessionToken ?? '');
        if (sessionToken) merged.sessionToken = sessionToken;
      }
    }
    // portal-sso: no extra secret fields — mode + region are sufficient.

    return { merged };
  }

  // Unknown provider — store incoming as-is.
  return { merged: incoming };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerGitConnectionRoutes(): void {

  // ── GitHub device-flow: start ────────────────────────────────────────────
  // POST /api/git-connections/github/device/start
  router.post(
    '/api/git-connections/github/device/start',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireBrowserAuth(req, res)) return;

      const clientId = getSetting(getDb(), 'github.oauth.clientId') ?? '';
      if (!clientId) {
        sendJson(res, 400, { error: 'GitHub OAuth client ID is not configured. Set it in Settings.' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const name = str(body.name, 'name', { max: 120 }).trim();
      // body.scope is the CONNECTION scope (personal|shared), NOT the OAuth scope.
      const connectionScope = typeof body.scope === 'string' ? body.scope.trim() : 'personal';
      if (!['personal', 'shared'].includes(connectionScope)) {
        sendJson(res, 400, { error: 'scope must be personal or shared' });
        return;
      }
      if (connectionScope === 'shared' && !req.user!.is_admin) {
        sendJson(res, 403, { error: 'Only admins can create shared connections' });
        return;
      }
      // Fixed server-side OAuth scope — space-delimited per GitHub docs.
      const oauthScope = 'repo read:org';

      try {
        const result = await _gitConnProviders.githubDeviceStart(clientId, oauthScope);
        const flowId = generateId();
        deviceFlows.set(flowId, {
          clientId,
          deviceCode: result.deviceCode,
          expiresAt: Date.now() + result.expiresIn * 1000,
          interval: result.interval,
          name,
          scope: connectionScope,
          userId: req.user!.id,
        });

        appendAudit(
          getDb(),
          req.user!.id,
          'git-connection.github.device-start',
          null,
          { name, scope: connectionScope },
          req.ip,
        );

        sendJson(res, 200, {
          flowId,
          verificationUri: result.verificationUri,
          userCode: result.userCode,
          expiresIn: result.expiresIn,
          interval: result.interval,
        });
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        sendJson(res, 502, { error: `Could not start GitHub device flow: ${error.slice(0, 300)}` });
      }
    },
  );

  // ── GitHub device-flow: poll ─────────────────────────────────────────────
  // POST /api/git-connections/github/device/poll
  router.post(
    '/api/git-connections/github/device/poll',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireBrowserAuth(req, res)) return;

      const body = req.body as Record<string, unknown>;
      const flowId = str(body.flowId, 'flowId', { max: 100 }).trim();

      const state = deviceFlows.get(flowId);
      if (!state) {
        sendJson(res, 200, { status: 'expired' });
        return;
      }
      if (state.userId !== req.user!.id) {
        sendJson(res, 403, { error: 'Not your device flow' });
        return;
      }
      if (Date.now() > state.expiresAt) {
        deviceFlows.delete(flowId);
        sendJson(res, 200, { status: 'expired' });
        return;
      }

      try {
        const result = await _gitConnProviders.githubDevicePoll(state.clientId, state.deviceCode);

        if (result.status === 'slow_down') {
          // GitHub wants us to slow down — honour the new interval it returns
          if (result.interval != null && result.interval > state.interval) {
            state.interval = result.interval;
          }
          sendJson(res, 200, { status: 'pending', slowDown: true, interval: state.interval });
          return;
        }
        if (result.status === 'pending') {
          sendJson(res, 200, { status: 'pending' });
          return;
        }
        if (result.status === 'expired') {
          deviceFlows.delete(flowId);
          sendJson(res, 200, { status: 'expired' });
          return;
        }
        if (result.status === 'denied') {
          deviceFlows.delete(flowId);
          sendJson(res, 200, { status: 'denied' });
          return;
        }

        // complete — create connection
        deviceFlows.delete(flowId);
        const token = result.token!;
        const credentialsEnc = encrypt(JSON.stringify({ token }), config.secretKey);
        const id = generateId();
        const ts = now();

        const conn = await getGitConnectionsRepository().create({
          id,
          name: state.name,
          provider: 'github',
          credentials_enc: credentialsEnc,
          scope: state.scope,
          owner_id: req.user!.id,
          created_at: ts,
        });

        appendAudit(
          getDb(),
          req.user!.id,
          'git-connection.github.device-complete',
          `connection:${id}`,
          { name: state.name },
          req.ip,
        );

        sendJson(res, 200, {
          status: 'complete',
          connection: safeConnection(conn),
        });
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        sendJson(res, 502, { error: `Device flow poll failed: ${error.slice(0, 300)}` });
      }
    },
  );

  // GET /api/git-connections
  router.get('/api/git-connections', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const connections = await getGitConnectionsRepository().listByUserOrShared(req.user.id);

    sendJson(res, 200, { connections: connections.map(safeConnection) });
  });

  // POST /api/git-connections
  router.post('/api/git-connections', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireBrowserAuth(req, res)) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const provider = str(body.provider, 'provider', { max: 32 }).trim();
    const scope = typeof body.scope === 'string' ? body.scope : 'personal';

    if (!['github', 'codecommit', 'bitbucket', 'git'].includes(provider)) {
      sendJson(res, 400, { error: 'provider must be github, codecommit, bitbucket, or git' });
      return;
    }
    if (!['personal', 'shared'].includes(scope)) {
      sendJson(res, 400, { error: 'scope must be personal or shared' });
      return;
    }

    // Validate provider-specific credentials
    if (provider === 'bitbucket' && body.credentials && typeof body.credentials === 'object') {
      const c = body.credentials as Record<string, unknown>;
      if (!c.email || !c.apiToken) {
        sendJson(res, 400, { error: 'Bitbucket credentials require email and apiToken' });
        return;
      }
    }
    if (provider === 'codecommit' && body.credentials && typeof body.credentials === 'object') {
      const c = body.credentials as Record<string, unknown>;
      if (!c.region) {
        sendJson(res, 400, { error: 'CodeCommit credentials require region' });
        return;
      }
      if (!['keys', 'aws-account', 'portal-sso'].includes(String(c.mode ?? 'keys'))) {
        sendJson(res, 400, { error: 'CodeCommit mode must be keys, aws-account, or portal-sso' });
        return;
      }
      const validationError = validateCodeCommitCreds(c);
      if (validationError) {
        sendJson(res, 400, { error: validationError });
        return;
      }
    }

    let credentialsEnc: string | null = null;
    if (body.credentials && typeof body.credentials === 'object') {
      const plain = JSON.stringify(body.credentials);
      credentialsEnc = encrypt(plain, config.secretKey);
    }

    const id = generateId();
    const ts = now();

    const conn = await getGitConnectionsRepository().create({
      id,
      name,
      provider,
      credentials_enc: credentialsEnc,
      scope,
      owner_id: req.user!.id,
      created_at: ts,
    });

    appendAudit(
      getDb(),
      req.user!.id,
      'git-connection.create',
      `connection:${id}`,
      { name, provider, scope },
      req.ip,
    );

    sendJson(res, 201, { connection: safeConnection(conn) });
  });

  // PUT /api/git-connections/:id
  router.put('/api/git-connections/:id', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const conn = await getGitConnectionsRepository().getById(req.params.id);
    if (!conn) { sendJson(res, 404, { error: 'Connection not found' }); return; }
    if (!requireConnectionAccess(req, res, conn)) return;

    const body = req.body as Record<string, unknown>;
    const patch: Partial<GitConnectionRecord> = {};

    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.scope !== undefined) {
      const s = String(body.scope);
      if (!['personal', 'shared'].includes(s)) {
        sendJson(res, 400, { error: 'scope must be personal or shared' });
        return;
      }
      patch.scope = s;
    }
    if (body.credentials !== undefined && typeof body.credentials === 'object') {
      const storedCreds = decryptCreds(conn);
      const mergeResult = mergeCredentialsOnUpdate(
        conn.provider,
        body.credentials as Record<string, unknown>,
        storedCreds,
      );
      if ('error' in mergeResult) {
        sendJson(res, 400, { error: mergeResult.error });
        return;
      }
      const merged = mergeResult.merged;
      if (conn.provider === 'codecommit') {
        const validationError = validateCodeCommitCreds(merged);
        if (validationError) {
          sendJson(res, 400, { error: validationError });
          return;
        }
      }
      patch.credentials_enc = encrypt(JSON.stringify(merged), config.secretKey);
      // Invalidate repo discovery cache for this connection.
      for (const key of repoCache.keys()) {
        if (key.startsWith(`${conn.id}:`)) repoCache.delete(key);
      }
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const updated = await getGitConnectionsRepository().update(conn.id, patch);
    sendJson(res, 200, { connection: updated ? safeConnection(updated) : null });
  });

  // DELETE /api/git-connections/:id
  router.delete('/api/git-connections/:id', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const conn = await getGitConnectionsRepository().getById(req.params.id);
    if (!conn) { sendJson(res, 404, { error: 'Connection not found' }); return; }
    if (!requireConnectionAccess(req, res, conn)) return;

    await getGitConnectionsRepository().delete(conn.id);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/git-connections/:id/test
  // Tests credentials against the provider API; returns account info.
  router.post(
    '/api/git-connections/:id/test',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

      const conn = await getGitConnectionsRepository().getById(req.params.id);
      if (!conn) { sendJson(res, 404, { error: 'Connection not found' }); return; }

      // Personal connections: owner or admin only.
      // Shared connections: any authenticated user can test.
      if (conn.scope === 'personal' && !req.user.is_admin && conn.owner_id !== req.user.id) {
        sendJson(res, 403, { error: 'You do not have access to this connection' });
        return;
      }

      const creds = decryptCreds(conn);

      try {
        let account: { login?: string; email?: string; name: string };

        if (conn.provider === 'github') {
          if (!creds.token) {
            sendJson(res, 200, { ok: false, error: 'No GitHub token stored on this connection' });
            return;
          }
          const info = await _gitConnProviders.githubTestConnection(creds.token);
          account = { login: info.login, name: info.name };

        } else if (conn.provider === 'bitbucket') {
          if (!creds.email || !creds.apiToken) {
            sendJson(res, 200, { ok: false, error: 'No Bitbucket credentials stored on this connection' });
            return;
          }
          const info = await _gitConnProviders.bitbucketTestConnection(creds.email, creds.apiToken);
          account = { email: info.email, name: info.name };

        } else if (conn.provider === 'codecommit') {
          const mode = (creds.mode as 'keys' | 'aws-account' | 'portal-sso') ?? 'keys';
          const region = creds.region ?? 'us-east-1';
          const info = await _gitConnProviders.codecommitTestConnection({
            mode,
            region,
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken,
            awsAccountId: creds.awsAccountId,
            connectionOwnerId: conn.owner_id ?? req.user.id,
            callerIsAdmin: Boolean(req.user.is_admin),
          });
          account = { login: info.login, name: info.name };

        } else {
          // Generic git: run git ls-remote on a URL from the body.
          // Without a URL, return a soft error (200 ok=false) so the UI can display it.
          const body = req.body as Record<string, unknown>;
          const url = typeof body.url === 'string' ? body.url.trim() : '';
          if (!url) {
            sendJson(res, 200, {
              ok: false,
              error: 'Enter a repository URL to test a generic Git connection',
            });
            return;
          }
          const gitEnv = await buildGitEnv(creds, conn.provider, url);
          await testGitRemote(url, gitEnv);
          account = { login: 'git', name: 'git' };
        }

        appendAudit(
          getDb(),
          req.user.id,
          'git-connection.test',
          `connection:${conn.id}`,
          { provider: conn.provider, ok: true },
          req.ip,
        );

        sendJson(res, 200, { ok: true, account });
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        const userError = conn.provider === 'codecommit' ? (classifyAwsTokenError(e) ?? error) : error;
        appendAudit(
          getDb(),
          req.user.id,
          'git-connection.test',
          `connection:${conn.id}`,
          { provider: conn.provider, ok: false, error: error.slice(0, 200) },
          req.ip,
        );
        sendJson(res, 200, { ok: false, account: null, error: userError.slice(0, 500) });
      }
    },
  );

  // GET /api/git-connections/:id/repos
  // GET /api/git-connections/:id/repos
  // Discover repos via the provider API (with 2-min server-side cache).
  router.get(
    '/api/git-connections/:id/repos',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

      const conn = await getGitConnectionsRepository().getById(req.params.id);
      if (!conn) { sendJson(res, 404, { error: 'Connection not found' }); return; }

      if (conn.scope === 'personal' && !req.user.is_admin && conn.owner_id !== req.user.id) {
        sendJson(res, 403, { error: 'You do not have access to this connection' });
        return;
      }

      const q = req.query.get('q') ?? '';
      const pageParam = req.query.get('page') ?? '';
      const workspaceParam = req.query.get('workspace') ?? '';
      const creds = decryptCreds(conn);
      const codecommitRegion = conn.provider === 'codecommit'
        ? (creds.region ?? 'us-east-1')
        : undefined;

      // Cache key includes connection, q, page and workspace so each distinct
      // query has its own cached entry.
      const cacheKey = `${conn.id}:${conn.provider}:${q}:${pageParam}:${workspaceParam}`;
      const cached = repoCache.get(cacheKey);
      if (cached && Date.now() < cached.expiry) {
        sendJson(res, 200, {
          repos: cached.repos,
          nextPage: null,
          workspaces: cached.workspaces,
          ...(cached.region ? { region: cached.region } : {}),
        });
        return;
      }

      try {
        let repos: DiscoveredRepo[] = [];
        let nextPage: string | null = null;
        let workspaces: string[] | undefined;

        if (conn.provider === 'github') {
          if (!creds.token) throw new Error('No GitHub token on this connection');
          const page = parseInt(pageParam, 10) || 1;
          const result = await _gitConnProviders.githubListRepos(creds.token, q, page);
          repos = result.repos;
          nextPage = result.nextPage !== null ? String(result.nextPage) : null;

        } else if (conn.provider === 'bitbucket') {
          if (!creds.email || !creds.apiToken) throw new Error('No Bitbucket credentials on this connection');

          // Collect workspaces (respect optional filter)
          const allWorkspaces = await _gitConnProviders.bitbucketListWorkspaces(creds.email, creds.apiToken);
          workspaces = allWorkspaces;

          const workspace = workspaceParam || creds.workspace || allWorkspaces[0] || '';
          if (!workspace) throw new Error('No Bitbucket workspace found for this account');

          const page = parseInt(pageParam, 10) || 1;
          const result = await _gitConnProviders.bitbucketListRepos(
            creds.email, creds.apiToken, workspace, q, page,
          );
          repos = result.repos;
          nextPage = result.nextPage !== null ? String(result.nextPage) : null;

        } else if (conn.provider === 'codecommit') {
          const mode = (creds.mode as 'keys' | 'aws-account' | 'portal-sso') ?? 'keys';
          const region = codecommitRegion!;
          const result = await _gitConnProviders.codecommitListRepos(
            {
              mode,
              region,
              accessKeyId: creds.accessKeyId,
              secretAccessKey: creds.secretAccessKey,
              sessionToken: creds.sessionToken,
              awsAccountId: creds.awsAccountId,
              connectionOwnerId: conn.owner_id ?? req.user.id,
              callerIsAdmin: Boolean(req.user.is_admin),
            },
            q,
            pageParam,
          );
          repos = result.repos;
          nextPage = result.nextPage;

        } else {
          sendJson(res, 400, { error: `Repo discovery is not supported for provider: ${conn.provider}` });
          return;
        }

        repoCache.set(cacheKey, {
          expiry: Date.now() + 2 * 60_000,
          repos,
          workspaces,
          ...(codecommitRegion ? { region: codecommitRegion } : {}),
        });

        sendJson(res, 200, { repos, nextPage, ...(workspaces ? { workspaces } : {}), ...(codecommitRegion ? { region: codecommitRegion } : {}) });
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        const userError = conn.provider === 'codecommit' ? (classifyAwsTokenError(e) ?? error) : error;
        sendJson(res, 200, { repos: [], nextPage: null, error: userError.slice(0, 500), ...(codecommitRegion ? { region: codecommitRegion } : {}) });
      }
    },
  );
}
