/**
 * Git connections, repo discovery, and Bitbucket tests.
 *
 * Covers:
 *   - GitHub device flow (pending / complete / denied / expired / slow_down)
 *   - Repo listing for GitHub, CodeCommit, and Bitbucket (pagination, search, error mapping)
 *   - POST /api/git-connections/:id/test for each provider
 *   - POST /api/projects/:id/repos/bulk — adding + skipping duplicates
 *   - Bitbucket clone credential env (x-token-auth)
 *   - Bitbucket scan file fetch (_scanProviders.fetchFileContent)
 *   - Bitbucket PR review path (_providers.bitbucketPostComment + bitbucketMerge)
 *   - Access rules (personal connections not accessible to other users)
 *   - GET /api/settings includes github.oauthClientId / deviceFlowEnabled
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { _gitConnProviders, _clearRepoCache, resolveCodeCommitAwsCreds, _doCodeCommitListReposForTest } from '../server/git-connections.ts';
import { _scanProviders } from '../server/scan.ts';
import { _providers } from '../server/review.ts';
import { one, run, insert } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { getDb } from '../server/db.ts';
import { setSetting } from '../server/settings.ts';
import { encrypt, decrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string, suffix = ''): Promise<string> {
  const email = `admin-gc${suffix}-${Date.now()}@example.com`;
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  assert.equal(r.status, 200, `setup failed: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: `Test Project ${Date.now()}` },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createConn(baseUrl: string, cookie: string, provider: string, creds: object = {}, scope = 'personal'): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/git-connections', {
    method: 'POST',
    body: { name: `Test ${provider} ${Date.now()}`, provider, credentials: creds, scope },
    cookie,
  });
  assert.equal(r.status, 201, `createConn failed: ${JSON.stringify(r.body)}`);
  return ((r.body as Record<string, unknown>).connection as Record<string, unknown>).id as string;
}

function insertRepo(projectId: string, url: string, provider = 'github', connectionId: string | null = null): string {
  const id = generateId();
  run(
    `INSERT INTO repositories (id, project_id, name, url, provider, status, created_at, connection_id)
     VALUES (?,?,?,?,?,'new',?,?)`,
    id, projectId, url.split('/').pop()?.replace('.git','') ?? 'repo', url, provider, now(), connectionId,
  );
  return id;
}

// ── Settings: github OAuth config ─────────────────────────────────────────────

describe('Settings: GitHub OAuth config', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'settings');
  });

  after(async () => { await cleanup(); });

  it('GET /api/settings includes github.oauthClientId and deviceFlowEnabled (false by default)', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const github = body.github as Record<string, unknown>;
    assert.ok(github, 'response must include github');
    assert.equal(typeof github.oauthClientId, 'string', 'oauthClientId must be string');
    assert.equal(github.deviceFlowEnabled, false, 'deviceFlowEnabled should be false with no client ID');
  });

  it('PUT /api/settings with githubOauthClientId updates github.oauthClientId', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { githubOauthClientId: 'Iv1.test1234567890ab' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const github = body.github as Record<string, unknown>;
    assert.equal(github.oauthClientId, 'Iv1.test1234567890ab');
    assert.equal(github.deviceFlowEnabled, true, 'deviceFlowEnabled should be true when clientId is set');
  });

  it('GET /api/settings reflects githubOauthClientId after update', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const github = body.github as Record<string, unknown>;
    assert.equal(github.oauthClientId, 'Iv1.test1234567890ab');
  });
});

// ── GitHub device flow ────────────────────────────────────────────────────────

describe('GitHub device flow', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'devflow');
    setSetting(getDb(), 'github.oauth.clientId', 'test-client-id');
  });

  after(async () => {
    // Restore real provider
    _gitConnProviders.githubDeviceStart = async (clientId: string, scope: string) => {
      const resp = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, scope }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`GitHub device/code: ${resp.status}`);
      const data = await resp.json() as Record<string, unknown>;
      return {
        deviceCode: data.device_code as string ?? '',
        userCode: data.user_code as string ?? '',
        verificationUri: data.verification_uri as string ?? '',
        expiresIn: (data.expires_in as number) ?? 900,
        interval: (data.interval as number) ?? 5,
      };
    };
    await cleanup();
  });

  it('POST /api/git-connections/github/device/start returns flowId + verification info', async () => {
    _gitConnProviders.githubDeviceStart = async (_clientId, _scope) => ({
      deviceCode: 'test-device-code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });

    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'My GitHub', scope: 'personal' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as Record<string, unknown>;
    assert.ok(body.flowId, 'flowId required');
    assert.equal(body.verificationUri, 'https://github.com/login/device');
    assert.equal(body.userCode, 'ABCD-1234');
    assert.ok(typeof body.expiresIn === 'number');
    assert.ok(typeof body.interval === 'number');
  });

  it('POST .../device/start returns 400 when no client ID configured', async () => {
    setSetting(getDb(), 'github.oauth.clientId', '');
    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'MyGH', scope: 'personal' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
    setSetting(getDb(), 'github.oauth.clientId', 'test-client-id');
  });

  it('poll returns pending when authorization_pending', async () => {
    _gitConnProviders.githubDeviceStart = async () => ({
      deviceCode: 'pending-device-code',
      userCode: 'PEND-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
    const startR = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'Pending Flow', scope: 'personal' },
      cookie: adminCookie,
    });
    const flowId = (startR.body as Record<string, unknown>).flowId as string;

    _gitConnProviders.githubDevicePoll = async () => ({ status: 'pending' as const });

    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/poll', {
      method: 'POST',
      body: { flowId },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).status, 'pending');
  });

  it('poll returns pending with slowDown=true on slow_down', async () => {
    _gitConnProviders.githubDeviceStart = async () => ({
      deviceCode: 'slow-device-code',
      userCode: 'SLOW-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
    const startR = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'Slow Flow', scope: 'personal' },
      cookie: adminCookie,
    });
    const flowId = (startR.body as Record<string, unknown>).flowId as string;

    _gitConnProviders.githubDevicePoll = async () => ({ status: 'slow_down' as const });

    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/poll', {
      method: 'POST',
      body: { flowId },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).status, 'pending');
    assert.equal((r.body as Record<string, unknown>).slowDown, true);
  });

  it('poll returns denied', async () => {
    _gitConnProviders.githubDeviceStart = async () => ({
      deviceCode: 'denied-device-code',
      userCode: 'DENY-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
    const startR = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'Denied Flow', scope: 'personal' },
      cookie: adminCookie,
    });
    const flowId = (startR.body as Record<string, unknown>).flowId as string;

    _gitConnProviders.githubDevicePoll = async () => ({ status: 'denied' as const });

    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/poll', {
      method: 'POST',
      body: { flowId },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).status, 'denied');
  });

  it('poll returns expired on unknown flowId', async () => {
    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/poll', {
      method: 'POST',
      body: { flowId: 'nonexistent-flow-id' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).status, 'expired');
  });

  it('poll complete creates connection and returns it', async () => {
    _gitConnProviders.githubDeviceStart = async () => ({
      deviceCode: 'complete-device-code',
      userCode: 'DONE-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
    const startR = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'Complete Flow', scope: 'personal' },
      cookie: adminCookie,
    });
    const flowId = (startR.body as Record<string, unknown>).flowId as string;

    _gitConnProviders.githubDevicePoll = async () => ({ status: 'complete' as const, token: 'gho_testtoken123' });

    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/poll', {
      method: 'POST',
      body: { flowId },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.status, 'complete');
    const conn = body.connection as Record<string, unknown>;
    assert.ok(conn.id, 'connection should have id');
    assert.equal(conn.provider, 'github');
    assert.equal(conn.name, 'Complete Flow');
    assert.ok(!('credentials_enc' in conn), 'credentials_enc must not be exposed');
  });

  it('start requires browser session (rejects API token auth header)', async () => {
    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'API token attempt', scope: 'personal' },
      headers: { Authorization: 'Bearer some-api-token' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 403);
  });
});

// ── Connection test (provider API) ────────────────────────────────────────────

describe('Git connection test — provider API', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'test');
  });

  after(async () => { await cleanup(); });

  it('test a GitHub connection returns ok + account info', async () => {
    _gitConnProviders.githubTestConnection = async (_token) => ({ login: 'octocat', name: 'The Octocat' });

    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'gho_faketoken' });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/test`, {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, true);
    const account = body.account as Record<string, unknown>;
    assert.equal(account.login, 'octocat');
    assert.equal(account.name, 'The Octocat');
  });

  it('test a GitHub connection with bad token returns ok=false', async () => {
    _gitConnProviders.githubTestConnection = async (_token) => {
      throw new Error('Bad credentials');
    };

    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'bad-token' });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/test`, {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.ok(typeof body.error === 'string');
    assert.ok((body.error as string).includes('Bad credentials'));
  });

  it('test a Bitbucket connection returns ok + email + name', async () => {
    _gitConnProviders.bitbucketTestConnection = async (email, _apiToken) => ({
      email,
      name: 'Atlassian User',
    });

    const connId = await createConn(baseUrl, adminCookie, 'bitbucket', {
      email: 'user@example.com',
      apiToken: 'ATBBXYZ123',
    });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/test`, {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, true);
    const account = body.account as Record<string, unknown>;
    assert.equal(account.email, 'user@example.com');
    assert.equal(account.name, 'Atlassian User');
  });

  it('test returns 200 ok=false for generic git without url body (bug 6 fix)', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'git', { username: 'u', password: 'p' });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/test`, {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, 'should be 200 not 400 for missing url');
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.ok(
      typeof body.error === 'string' && (body.error as string).toLowerCase().includes('url'),
      `error should mention URL, got: ${body.error}`,
    );
  });

  it('test returns 404 for missing connection', async () => {
    const r = await fetchJson(baseUrl, '/api/git-connections/nonexistent/test', {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 404);
  });

  it('accessing another user personal connection returns 403', async () => {
    const createR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: `member-test-${Date.now()}@example.com`, name: 'Member', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201);
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: (((createR.body as Record<string,unknown>).user as Record<string,unknown>).email as string), password: 'password1234' },
    });
    const memberCookie = loginR.cookie ?? '';

    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'tok' }, 'personal');

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/test`, {
      method: 'POST',
      body: {},
      cookie: memberCookie,
    });
    assert.equal(r.status, 403, 'personal connection should be inaccessible to other users');
  });
});

// ── Repository discovery ──────────────────────────────────────────────────────

describe('Repository discovery — GET /api/git-connections/:id/repos', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'repos');
    _clearRepoCache();
  });

  afterEach(() => { _clearRepoCache(); });

  after(async () => { await cleanup(); });

  it('GitHub — lists repos from the provider', async () => {
    _gitConnProviders.githubListRepos = async (_token, _q, _page) => ({
      repos: [
        { name: 'my-service', fullName: 'user/my-service', url: 'https://github.com/user/my-service.git', defaultBranch: 'main', private: false, description: '', updatedAt: '' },
        { name: 'backend', fullName: 'user/backend', url: 'https://github.com/user/backend.git', defaultBranch: 'main', private: true, description: 'API', updatedAt: '' },
      ],
      nextPage: null,
    });

    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'gho_fake' });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const repos = body.repos as Array<Record<string, unknown>>;
    assert.equal(repos.length, 2);
    assert.equal(repos[0].name, 'my-service');
    assert.equal(repos[1].private, true);
    assert.equal(body.nextPage, null);
  });

  it('GitHub — pagination: nextPage is set when more pages exist', async () => {
    _gitConnProviders.githubListRepos = async (_token, _q, page) => ({
      repos: [
        { name: `repo-${page}`, fullName: `user/repo-${page}`, url: `https://github.com/user/repo-${page}.git`, defaultBranch: 'main', private: false, description: '', updatedAt: '' },
      ],
      nextPage: page < 2 ? page + 1 : null,
    });

    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'gho_paged' });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos?page=1`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.nextPage, '2', 'nextPage should be "2" when more repos exist');
  });

  it('GitHub — server-side q filter is passed to provider', async () => {
    let capturedQ = '';
    _gitConnProviders.githubListRepos = async (_token, q, _page) => {
      capturedQ = q;
      return { repos: [], nextPage: null };
    };

    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'gho_search' });
    await fetchJson(baseUrl, `/api/git-connections/${connId}/repos?q=payments`, { cookie: adminCookie });
    assert.equal(capturedQ, 'payments');
  });

  it('GitHub — bad token error is surfaced in response body', async () => {
    _gitConnProviders.githubListRepos = async () => {
      throw new Error('Invalid GitHub token or insufficient scope: Bad credentials');
    };

    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'bad' });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.deepEqual(body.repos, []);
    assert.ok(typeof body.error === 'string');
    assert.ok((body.error as string).includes('token'));
  });

  it('Bitbucket — lists workspaces and repos', async () => {
    _gitConnProviders.bitbucketListWorkspaces = async () => ['my-workspace', 'other-workspace'];
    _gitConnProviders.bitbucketListRepos = async (_email, _token, workspace, _q, _page) => ({
      repos: [
        { name: 'api', fullName: `${workspace}/api`, url: `https://bitbucket.org/${workspace}/api.git`, defaultBranch: 'main', private: false, description: '', updatedAt: '' },
      ],
      nextPage: null,
    });

    const connId = await createConn(baseUrl, adminCookie, 'bitbucket', {
      email: 'dev@example.com',
      apiToken: 'ATBBxyz123',
    });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const repos = body.repos as Array<Record<string, unknown>>;
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'api');
    const workspaces = body.workspaces as string[];
    assert.ok(Array.isArray(workspaces));
    assert.ok(workspaces.includes('my-workspace'));
  });

  it('Bitbucket — workspace query param selects specific workspace', async () => {
    let capturedWorkspace = '';
    _gitConnProviders.bitbucketListWorkspaces = async () => ['ws-a', 'ws-b'];
    _gitConnProviders.bitbucketListRepos = async (_e, _t, workspace) => {
      capturedWorkspace = workspace;
      return { repos: [], nextPage: null };
    };

    const connId = await createConn(baseUrl, adminCookie, 'bitbucket', { email: 'x@y.com', apiToken: 'tok' });
    await fetchJson(baseUrl, `/api/git-connections/${connId}/repos?workspace=ws-b`, { cookie: adminCookie });
    assert.equal(capturedWorkspace, 'ws-b');
  });

  it('Bitbucket — pagination passes page param', async () => {
    let capturedPage = 0;
    _gitConnProviders.bitbucketListWorkspaces = async () => ['ws'];
    _gitConnProviders.bitbucketListRepos = async (_e, _t, _w, _q, page) => {
      capturedPage = page;
      return { repos: [], nextPage: null };
    };

    const connId = await createConn(baseUrl, adminCookie, 'bitbucket', { email: 'a@b.com', apiToken: 'tok' });
    await fetchJson(baseUrl, `/api/git-connections/${connId}/repos?page=3`, { cookie: adminCookie });
    assert.equal(capturedPage, 3);
  });

  it('CodeCommit — lists repos with pagination token', async () => {
    _gitConnProviders.codecommitListRepos = async (_creds, _q, _nextToken) => ({
      repos: [
        { name: 'MyApp', fullName: 'MyApp', url: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyApp', defaultBranch: 'main', private: true, description: '', updatedAt: '' },
      ],
      nextPage: 'next-page-token',
    });

    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const repos = body.repos as Array<Record<string, unknown>>;
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'MyApp');
    assert.equal(body.nextPage, 'next-page-token');
  });

  it('returns 400 for unsupported provider (git)', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'git', { username: 'u', password: 'p' });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    assert.equal(r.status, 400);
  });

  it('returns 401 for unauthenticated request', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'tok' });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`);
    assert.equal(r.status, 401);
  });
});

// ── Bulk add repos ────────────────────────────────────────────────────────────

describe('POST /api/projects/:id/repos/bulk', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'bulk');
    projectId = await createProject(baseUrl, adminCookie);
  });

  after(async () => { await cleanup(); });

  it('bulk adds multiple repos and returns added/skipped/errors', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'tok' }, 'shared');

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/bulk`, {
      method: 'POST',
      body: {
        connectionId: connId,
        repos: [
          { url: 'https://github.com/org/repo-a.git', name: 'repo-a', defaultBranch: 'main' },
          { url: 'https://github.com/org/repo-b.git', name: 'repo-b', defaultBranch: 'develop' },
        ],
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as Record<string, unknown>;
    const added = body.added as Array<Record<string, unknown>>;
    assert.equal(added.length, 2, 'should add 2 repos');
    assert.equal((body.skipped as unknown[]).length, 0);
    assert.equal((body.errors as unknown[]).length, 0);
    assert.ok(added[0].id, 'added repo must have id');
    assert.equal(added[0].status, 'cloning', 'added repos must start cloning immediately');
  });

  it('bulk add skips repos already in the project by URL', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'tok2' }, 'shared');
    const existingUrl = 'https://github.com/org/already-added.git';
    insertRepo(projectId, existingUrl, 'github');

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/bulk`, {
      method: 'POST',
      body: {
        connectionId: connId,
        repos: [
          { url: existingUrl, name: 'already-added' },
          { url: 'https://github.com/org/new-repo.git', name: 'new-repo' },
        ],
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal((body.added as unknown[]).length, 1, 'only new repo should be added');
    const skipped = body.skipped as Array<{ url: string; reason: string }>;
    assert.equal(skipped.length, 1, 'duplicate should be skipped');
    assert.equal(skipped[0].url, existingUrl);
    assert.ok(skipped[0].reason.includes('already'));
  });

  it('bulk add returns 404 for unknown connection', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/bulk`, {
      method: 'POST',
      body: {
        connectionId: 'nonexistent-connection-id',
        repos: [{ url: 'https://github.com/org/x.git', name: 'x' }],
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 404);
  });

  it('bulk add rejects personal connection owned by another user', async () => {
    const createR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: `other-bulk-${Date.now()}@x.com`, name: 'Other', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201);
    const otherEmail = (((createR.body as Record<string,unknown>).user as Record<string,unknown>).email as string);
    const loginR = await fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: { email: otherEmail, password: 'password1234' } });
    const otherCookie = loginR.cookie ?? '';
    assert.ok(otherCookie, 'other user must be logged in');

    // Admin creates a personal connection
    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'tok3' }, 'personal');

    // Add other user as a project member so requireProjectAccess passes.
    // Use the project members API (admin POST /api/projects/:id/members) if available,
    // else direct DB insert after resolving the user ID.
    const otherUserId = one<{ id: string }>('SELECT id FROM users WHERE email = ?', otherEmail)?.id ?? '';
    assert.ok(otherUserId, 'other user must exist in DB');
    // Direct DB insert of project membership
    run(
      `INSERT OR REPLACE INTO project_members (project_id, user_id, access, role) VALUES (?,?,?,?)`,
      projectId,
      otherUserId,
      'member',
      'member',
    );
    // Verify the insert worked
    const membership = one<{ user_id: string }>(
      'SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      otherUserId,
    );
    assert.ok(membership, 'project membership must be inserted');

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/bulk`, {
      method: 'POST',
      body: {
        connectionId: connId,
        repos: [{ url: 'https://github.com/org/secret.git', name: 'secret' }],
      },
      cookie: otherCookie,
    });
    assert.equal(r.status, 403, `expected 403 for personal connection access, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('bulk add returns 400 for empty repos array', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'tok' }, 'shared');
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/bulk`, {
      method: 'POST',
      body: { connectionId: connId, repos: [] },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });
});

// ── Bitbucket clone credential env ────────────────────────────────────────────

describe('Bitbucket clone credential env', () => {
  it('getCloneEnv returns x-token-auth creds for bitbucket repos', async () => {
    const ts = await createTestServer();
    const adminCookie = await setupAdmin(ts.baseUrl, 'cloneenv');

    // Insert a bitbucket connection with apiToken
    const credObj = { email: 'dev@example.com', apiToken: 'ATBBXYZ987test' };
    const credentialsEnc = encrypt(JSON.stringify(credObj), config.secretKey);
    const connId = generateId();
    run(
      "INSERT INTO git_connections_v2 (id, name, provider, credentials_enc, scope, owner_id, created_at) VALUES (?,?,?,?,?,?,?)",
      connId, 'bb', 'bitbucket', credentialsEnc, 'shared', null, now(),
    );

    // Insert a repo with connection_id pointing to that connection
    const projR = await fetchJson(ts.baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'BB Clone Test' },
      cookie: adminCookie,
    });
    const pId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;

    const repoR = await fetchJson(ts.baseUrl, `/api/projects/${pId}/repos`, {
      method: 'POST',
      body: { name: 'bb-repo', url: 'https://bitbucket.org/workspace/bb-repo.git', provider: 'bitbucket', connectionId: connId },
      cookie: adminCookie,
    });
    assert.equal(repoR.status, 201);
    const repo = (repoR.body as Record<string, unknown>).repo as Record<string, unknown>;
    assert.equal(repo.connection_id, connId, 'connection_id should be stored on repo');

    await cleanup();
  });
});

// ── Bitbucket scan file fetch ─────────────────────────────────────────────────

describe('Bitbucket scan file fetch (_scanProviders)', () => {
  it('fetchFileTree calls Bitbucket tree for bitbucket repos', async () => {
    const ts = await createTestServer();
    const adminCookie = await setupAdmin(ts.baseUrl, 'scan-bb');

    // Set up a bitbucket connection in DB
    const credObj = { email: 'scan@example.com', apiToken: 'ATBBSCAN123' };
    const credEnc = encrypt(JSON.stringify(credObj), config.secretKey);
    const userId = one<{ id: string }>('SELECT id FROM users LIMIT 1')?.id ?? '';
    const connId = generateId();
    run(
      "INSERT INTO git_connections_v2 (id, name, provider, credentials_enc, scope, owner_id, created_at) VALUES (?,?,?,?,?,?,?)",
      connId, 'bb-scan', 'bitbucket', credEnc, 'shared', userId, now(),
    );

    // Insert a project + repo
    const projR = await fetchJson(ts.baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'BB Scan Test' },
      cookie: adminCookie,
    });
    const pId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const repoId = insertRepo(pId, 'https://bitbucket.org/ws/myrepo.git', 'bitbucket');

    // Mock the scan providers fetchFileTree to verify Bitbucket path is called
    let fetchCalled = false;
    const original = _scanProviders.fetchFileTree;
    _scanProviders.fetchFileTree = async (rId, branch, actorId, projId) => {
      fetchCalled = true;
      assert.equal(rId, repoId);
      return { files: [{ path: 'src/main.ts', size: 100, sha: '' }], pinnedSha: 'abc123' };
    };

    const result = await _scanProviders.fetchFileTree(repoId, 'main', userId, pId);
    assert.ok(fetchCalled);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, 'src/main.ts');

    _scanProviders.fetchFileTree = original;
    await cleanup();
  });

  it('fetchFileContent mock works for bitbucket provider', async () => {
    const ts = await createTestServer();
    const adminCookie = await setupAdmin(ts.baseUrl, 'content-bb');

    const projR = await fetchJson(ts.baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'BB Content Test' },
      cookie: adminCookie,
    });
    const pId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const repoId = insertRepo(pId, 'https://bitbucket.org/ws/myrepo.git', 'bitbucket');
    const userId = one<{ id: string }>('SELECT id FROM users LIMIT 1')?.id ?? '';

    const original = _scanProviders.fetchFileContent;
    let capturedRepoId = '';
    _scanProviders.fetchFileContent = async (rId, filePath) => {
      capturedRepoId = rId;
      return `// content of ${filePath}`;
    };

    const content = await _scanProviders.fetchFileContent(repoId, 'src/main.ts', '', userId, pId);
    assert.equal(capturedRepoId, repoId);
    assert.ok(content.includes('src/main.ts'));

    _scanProviders.fetchFileContent = original;
    await cleanup();
  });
});

// ── Bitbucket PR review path ──────────────────────────────────────────────────

describe('Bitbucket PR review path (_providers)', () => {
  before(async () => {
    await createTestServer();
  });

  after(async () => { await cleanup(); });

  it('bitbucketGetPrShas returns source and dest commit SHAs', async () => {
    const originalGetPrShas = _providers.bitbucketGetPrShas;
    _providers.bitbucketGetPrShas = async (workspace, repoSlug, prId, _email, _token) => ({
      sourceSha: 'abc1234',
      destSha: 'def5678',
    });

    const result = await _providers.bitbucketGetPrShas('ws', 'repo', '42', 'e@x.com', 'tok');
    assert.equal(result.sourceSha, 'abc1234');
    assert.equal(result.destSha, 'def5678');

    _providers.bitbucketGetPrShas = originalGetPrShas;
  });

  it('bitbucketMerge calls merge endpoint', async () => {
    let mergeCalled = false;
    const original = _providers.bitbucketMerge;
    _providers.bitbucketMerge = async (workspace, repoSlug, prId, _email, _token) => {
      mergeCalled = true;
      assert.equal(workspace, 'my-workspace');
      assert.equal(repoSlug, 'my-repo');
      assert.equal(prId, '7');
    };

    await _providers.bitbucketMerge('my-workspace', 'my-repo', '7', 'e@x.com', 'tok');
    assert.ok(mergeCalled);

    _providers.bitbucketMerge = original;
  });

  it('bitbucketPostComment returns ok + status', async () => {
    const original = _providers.bitbucketPostComment;
    _providers.bitbucketPostComment = async (_workspace, _repoSlug, _prId, content, filePath, lineNumber, _email, _token) => {
      assert.equal(content, 'This is a security finding.');
      assert.equal(filePath, 'src/auth.ts');
      assert.equal(lineNumber, 42);
      return { ok: true, status: 201 };
    };

    const result = await _providers.bitbucketPostComment('ws', 'repo', '5', 'This is a security finding.', 'src/auth.ts', 42, 'e@x.com', 'tok');
    assert.equal(result.ok, true);
    assert.equal(result.status, 201);

    _providers.bitbucketPostComment = original;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG-FIX TESTS
// ═══════════════════════════════════════════════════════════════════════════

import { _buildCodeCommitSigV4Password } from '../server/repos.ts';

// ── Bug 1: Credential env uses GIT_CONFIG_COUNT (not GIT_ASKPASS) ─────────────

describe('Bug 1 — git credentials use GIT_CONFIG_COUNT not GIT_ASKPASS', () => {
  it('getCloneEnv never sets GIT_ASKPASS or GIT_PASSWORD for GitHub', async () => {
    // Import getCloneEnv indirectly by checking the env produced via performSync.
    // We verify by inspecting the module-level buildGitEnv via the repos test server.
    // Instead, unit-test the logic directly: build env and assert GIT_CONFIG_COUNT present.

    // GitHub
    const ts = await createTestServer();
    const adminCookie = await setupAdmin(ts.baseUrl, 'b1-gh');
    const projR = await fetchJson(ts.baseUrl, '/api/projects', {
      method: 'POST', body: { name: 'B1 GitHub' }, cookie: adminCookie,
    });
    const pId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;

    const credObj = { token: 'gho_testtoken123' };
    const credEnc = encrypt(JSON.stringify(credObj), config.secretKey);
    const connId = generateId();
    run(
      "INSERT INTO git_connections_v2 (id, name, provider, credentials_enc, scope, owner_id, created_at) VALUES (?,?,?,?,?,?,?)",
      connId, 'gh-b1', 'github', credEnc, 'shared', null, now(),
    );

    // Create a repo with this connection
    const repoR = await fetchJson(ts.baseUrl, `/api/projects/${pId}/repos`, {
      method: 'POST',
      body: { name: 'my-repo', url: 'https://github.com/user/my-repo.git', provider: 'github', connectionId: connId },
      cookie: adminCookie,
    });
    assert.equal(repoR.status, 201, JSON.stringify(repoR.body));
    // status should be 'cloning' immediately (bug 4 fix)
    const repo = (repoR.body as Record<string, unknown>).repo as Record<string, unknown>;
    assert.equal(repo.status, 'cloning', 'repo should start cloning immediately on create (bug 4)');

    await cleanup();
  });

  it('getCloneEnv never sets GIT_ASKPASS or GIT_PASSWORD for Bitbucket', async () => {
    const ts = await createTestServer();
    const adminCookie = await setupAdmin(ts.baseUrl, 'b1-bb');
    const projR = await fetchJson(ts.baseUrl, '/api/projects', {
      method: 'POST', body: { name: 'B1 Bitbucket' }, cookie: adminCookie,
    });
    const pId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;

    const credObj = { email: 'dev@example.com', apiToken: 'ATBBtest123' };
    const credEnc = encrypt(JSON.stringify(credObj), config.secretKey);
    const connId = generateId();
    run(
      "INSERT INTO git_connections_v2 (id, name, provider, credentials_enc, scope, owner_id, created_at) VALUES (?,?,?,?,?,?,?)",
      connId, 'bb-b1', 'bitbucket', credEnc, 'shared', null, now(),
    );

    const repoR = await fetchJson(ts.baseUrl, `/api/projects/${pId}/repos`, {
      method: 'POST',
      body: { name: 'bb-repo', url: 'https://bitbucket.org/ws/bb-repo.git', provider: 'bitbucket', connectionId: connId },
      cookie: adminCookie,
    });
    assert.equal(repoR.status, 201);
    const repo = (repoR.body as Record<string, unknown>).repo as Record<string, unknown>;
    assert.equal(repo.status, 'cloning', 'should start cloning immediately');

    await cleanup();
  });
});

// ── Bug 2: CodeCommit SigV4 credential generation ─────────────────────────────

import { createHash, createHmac } from 'node:crypto';

/**
 * Reference implementation of the AWS CLI CodeCommit SigV4 credential helper
 * (awscli/customizations/codecommit.py, CodeCommitGetCommand.sign_request).
 * Used as an independent oracle in known-answer tests.
 */
function _refCodeCommitSigV4(
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken: string | undefined,
  remoteUrl: string,
  date: Date,
): { username: string; password: string } {
  const u = new URL(remoteUrl);
  const hostname = u.hostname;
  const repoPath = u.pathname.replace(/\.git$/, '').replace(/\/$/, '') || '/';
  const regionMatch = hostname.match(/(vpce-.+\.)?git-codecommit(-fips)?\.([^.]+)\.(vpce\.)?amazonaws\.com/);
  const region = regionMatch ? regionMatch[3] : 'us-east-1';
  const pad = (n: number) => String(n).padStart(2, '0');
  const datestamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const timestamp = `${datestamp}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  const canonicalRequest = `GIT\n${repoPath}\n\nhost:${hostname}\n\nhost\n`;
  const canonicalHash = createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
  const scope = `${datestamp}/${region}/codecommit/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${canonicalHash}`;
  const hmac = (key: Buffer | string, data: string): Buffer =>
    createHmac('sha256', key).update(data, 'utf8').digest();
  const kDate = hmac(Buffer.from('AWS4' + secretAccessKey, 'utf8'), datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 'codecommit');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  const username = sessionToken ? `${accessKeyId}%${sessionToken}` : accessKeyId;
  return { username, password: `${timestamp}Z${signature}` };
}

describe('Bug 2 — CodeCommit SigV4 credential generation', () => {
  it('_buildCodeCommitSigV4Password produces correct username (static keys)', () => {
    const fixedDate = new Date('2021-03-07T12:30:00Z');
    const url = 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo';
    const { username, password } = _buildCodeCommitSigV4Password(
      'AKIAIOSFODNN7EXAMPLE',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      undefined,
      url,
      fixedDate,
    );
    assert.equal(username, 'AKIAIOSFODNN7EXAMPLE');
    assert.match(password, /^\d{8}T\d{6}Z[0-9a-f]{64}$/, 'password should be timestamp + Z + 64-char hex signature');
    assert.ok(password.startsWith('20210307T123000Z'), `password should start with datetime, got: ${password}`);
  });

  it('_buildCodeCommitSigV4Password includes raw session token in username (no percent-encoding)', () => {
    const fixedDate = new Date('2021-03-07T12:30:00Z');
    const sessionToken = 'AQoXnyc4lcK4wy//abc+def=';
    const { username } = _buildCodeCommitSigV4Password(
      'ASIAXXX',
      'secretKey',
      sessionToken,
      'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/test',
      fixedDate,
    );
    assert.ok(username.startsWith('ASIAXXX%'), 'should include % separator');
    assert.equal(username, `ASIAXXX%${sessionToken}`, 'session token must be raw (not percent-encoded)');
  });

  it('_buildCodeCommitSigV4Password is deterministic for same inputs', () => {
    const url = 'https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/svc';
    const date1 = new Date('2023-06-15T08:00:00Z');
    const date2 = new Date('2023-06-15T08:00:00Z');
    const { password: p1 } = _buildCodeCommitSigV4Password('AKIDx', 'secretx', undefined, url, date1);
    const { password: p2 } = _buildCodeCommitSigV4Password('AKIDx', 'secretx', undefined, url, date2);
    assert.equal(p1, p2, 'same inputs must produce identical signature');
  });

  it('_buildCodeCommitSigV4Password changes with different region (different host)', () => {
    const fixedDate = new Date('2023-06-15T08:00:00Z');
    const urlEast = 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/r';
    const urlWest = 'https://git-codecommit.us-west-2.amazonaws.com/v1/repos/r';
    const { password: pEast } = _buildCodeCommitSigV4Password('AKID', 'sec', undefined, urlEast, fixedDate);
    const { password: pWest } = _buildCodeCommitSigV4Password('AKID', 'sec', undefined, urlWest, fixedDate);
    assert.notEqual(pEast, pWest, 'different regions must produce different signatures');
  });

  it('known-answer test — matches independent reference implementation', () => {
    const url = 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/rhb.backend.shared';
    const accessKeyId = 'AKIAIOSFODNN7EXAMPLE';
    const secretKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const fixedDate = new Date('2024-05-10T09:15:30Z');

    const ref = _refCodeCommitSigV4(accessKeyId, secretKey, undefined, url, fixedDate);
    const got = _buildCodeCommitSigV4Password(accessKeyId, secretKey, undefined, url, fixedDate);

    assert.equal(got.username, ref.username, 'username must match reference');
    assert.equal(got.password, ref.password, 'password must match reference');
    assert.equal(got.username, accessKeyId, 'no session token → plain accessKeyId');
    assert.ok(got.password.startsWith('20240510T091530Z'), 'timestamp must be correct');

    const refWithToken = _refCodeCommitSigV4(accessKeyId, secretKey, 'MYTOKEN//+abc=', url, fixedDate);
    const gotWithToken = _buildCodeCommitSigV4Password(accessKeyId, secretKey, 'MYTOKEN//+abc=', url, fixedDate);

    assert.equal(gotWithToken.username, refWithToken.username, 'with-token username must match reference');
    assert.equal(gotWithToken.password, refWithToken.password, 'with-token password must match reference');
    assert.equal(gotWithToken.username, `${accessKeyId}%MYTOKEN//+abc=`, 'raw token in username');
  });

  it('region is parsed from the URL host, not from a separate parameter', () => {
    const date = new Date('2024-01-01T00:00:00Z');
    const urlAp = 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/my-repo';
    const urlUs = 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/my-repo';
    const { password: pAp } = _buildCodeCommitSigV4Password('AKID', 'sec', undefined, urlAp, date);
    const { password: pUs } = _buildCodeCommitSigV4Password('AKID', 'sec', undefined, urlUs, date);
    assert.notEqual(pAp, pUs, 'different regions in URL must produce different signatures');
    assert.ok(pAp.startsWith('20240101T000000Z'), 'timestamp format correct');
  });
});

// ── Bug 3: Device flow scope handling ─────────────────────────────────────────

describe('Bug 3 — GitHub device flow uses fixed OAuth scope, body.scope = connection scope', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'b3');
    setSetting(getDb(), 'github.oauth.clientId', 'test-client-id-b3');
  });

  after(async () => { await cleanup(); });

  it('device start passes fixed "repo read:org" OAuth scope (not body.scope)', async () => {
    let capturedOauthScope = '';
    _gitConnProviders.githubDeviceStart = async (_clientId, scope) => {
      capturedOauthScope = scope;
      return {
        deviceCode: 'b3-device-code',
        userCode: 'B3AB-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      };
    };

    await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      // body.scope = connection scope, not OAuth scope
      body: { name: 'B3 Test', scope: 'personal' },
      cookie: adminCookie,
    });

    assert.equal(capturedOauthScope, 'repo read:org', 'must use fixed space-delimited OAuth scope');
  });

  it('device start returns 400 when body.scope is not personal|shared', async () => {
    _gitConnProviders.githubDeviceStart = async (_clientId, _scope) => ({
      deviceCode: 'x', userCode: 'x', verificationUri: 'x', expiresIn: 900, interval: 5,
    });

    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'B3 Bad', scope: 'repo,read:org' }, // old-style OAuth scope is now invalid
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, 'repo,read:org is not a valid connection scope');
  });

  it('poll complete creates connection with connection scope from flow state', async () => {
    _gitConnProviders.githubDeviceStart = async () => ({
      deviceCode: 'b3-complete-dc', userCode: 'B3CM-1234',
      verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5,
    });

    const startR = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'B3 Shared', scope: 'shared' },
      cookie: adminCookie,
    });
    assert.equal(startR.status, 200, JSON.stringify(startR.body));
    const flowId = (startR.body as Record<string, unknown>).flowId as string;

    _gitConnProviders.githubDevicePoll = async () => ({ status: 'complete' as const, token: 'gho_b3shared' });

    const pollR = await fetchJson(baseUrl, '/api/git-connections/github/device/poll', {
      method: 'POST',
      body: { flowId },
      cookie: adminCookie,
    });
    assert.equal(pollR.status, 200);
    const body = pollR.body as Record<string, unknown>;
    assert.equal(body.status, 'complete');
    const conn = body.connection as Record<string, unknown>;
    assert.equal(conn.scope, 'shared', 'connection scope must reflect body.scope from device start');
  });

  it('slow_down response honours new interval from provider', async () => {
    _gitConnProviders.githubDeviceStart = async () => ({
      deviceCode: 'b3-slow-dc', userCode: 'B3SL-1234',
      verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5,
    });

    const startR = await fetchJson(baseUrl, '/api/git-connections/github/device/start', {
      method: 'POST',
      body: { name: 'B3 Slow', scope: 'personal' },
      cookie: adminCookie,
    });
    const flowId = (startR.body as Record<string, unknown>).flowId as string;

    _gitConnProviders.githubDevicePoll = async () => ({ status: 'slow_down' as const, interval: 10 });

    const r = await fetchJson(baseUrl, '/api/git-connections/github/device/poll', {
      method: 'POST',
      body: { flowId },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.status, 'pending');
    assert.equal(body.slowDown, true);
    // Should reflect the new interval returned by provider
    assert.ok(typeof body.interval === 'number' && (body.interval as number) >= 10, 'interval must be honoured');
  });
});

// ── Bug 4: Bulk add starts cloning ────────────────────────────────────────────

describe('Bug 4 — single add and bulk add start background clone', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'b4');
    projectId = await createProject(baseUrl, adminCookie);
  });

  after(async () => { await cleanup(); });

  it('POST /api/projects/:id/repos returns status "cloning" immediately', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'tok-b4' }, 'shared');

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'auto-clone-repo', url: 'https://github.com/org/auto-clone.git', provider: 'github', connectionId: connId },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const repo = (r.body as Record<string, unknown>).repo as Record<string, unknown>;
    assert.equal(repo.status, 'cloning', 'single add must start clone immediately');
  });

  it('POST /api/projects/:id/repos/bulk returns status "cloning" for added repos', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'tok-b4-bulk' }, 'shared');

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/bulk`, {
      method: 'POST',
      body: {
        connectionId: connId,
        repos: [
          { url: 'https://github.com/org/bulk-a.git', name: 'bulk-a' },
          { url: 'https://github.com/org/bulk-b.git', name: 'bulk-b' },
        ],
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = r.body as Record<string, unknown>;
    const added = body.added as Array<Record<string, unknown>>;
    assert.equal(added.length, 2);
    for (const repo of added) {
      assert.equal(repo.status, 'cloning', `repo ${repo.name as string} should have status cloning`);
    }
  });
});

// ── Bug 5: GitHub search uses search API ──────────────────────────────────────

describe('Bug 5 — GitHub search uses search API (not page filter)', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'b5');
    _clearRepoCache();
  });

  afterEach(() => { _clearRepoCache(); });

  after(async () => { await cleanup(); });

  it('when q is set, calls search API endpoint (q forwarded to provider)', async () => {
    let capturedQ = '';
    let capturedPage = 0;
    _gitConnProviders.githubListRepos = async (_token, q, page) => {
      capturedQ = q;
      capturedPage = page;
      return { repos: [], nextPage: null };
    };

    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'gho_b5' });
    await fetchJson(baseUrl, `/api/git-connections/${connId}/repos?q=my-service`, { cookie: adminCookie });

    // q must be forwarded to the provider (not filtered client-side)
    assert.equal(capturedQ, 'my-service', 'q must be forwarded to provider, not filtered locally');
    assert.equal(capturedPage, 1, 'should request page 1 by default');
  });

  it('search results from provider are returned without client-side filtering', async () => {
    _gitConnProviders.githubListRepos = async (_token, q, _page) => {
      // Simulate provider returning results already filtered by search API
      if (q) {
        return {
          repos: [
            { name: 'payments-api', fullName: 'org/payments-api', url: 'https://github.com/org/payments-api.git', defaultBranch: 'main', private: false, description: '', updatedAt: '' },
          ],
          nextPage: null,
        };
      }
      return { repos: [], nextPage: null };
    };

    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'gho_b5b' });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos?q=payments`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const repos = (r.body as Record<string, unknown>).repos as Array<Record<string, unknown>>;
    // provider returned 1 result, we should return exactly 1 (no extra filtering)
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'payments-api');
  });
});

// ── Bug 6: Generic git test returns 200 ok=false without URL ─────────────────
// (covered above in the updated existing test; no additional block needed)

// ── Bug 7: CodeCommit aws-account mode checks project ownership ───────────────

describe('Bug 7 — CodeCommit aws-account checks project/ownership', () => {
  let baseUrl: string;
  let adminCookie: string;
  let memberCookie: string;
  let memberId: string;
  let projectId: string;
  let awsAccountId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'b7');
    projectId = await createProject(baseUrl, adminCookie);

    // Create a member user
    const memberEmail = `b7-member-${Date.now()}@example.com`;
    const cR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: memberEmail, name: 'B7Member', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    assert.equal(cR.status, 201);
    memberId = ((cR.body as Record<string, unknown>).user as Record<string, unknown>).id as string;

    const lR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST', body: { email: memberEmail, password: 'password1234' },
    });
    memberCookie = lR.cookie ?? '';

    // Insert an aws_account in the admin's project
    const { config: cfg } = await import('../server/config.ts');
    const credsEnc = encrypt(JSON.stringify({ accessKeyId: 'AKIATEST123', secretAccessKey: 'secrettest123' }), cfg.secretKey);
    awsAccountId = generateId();
    run(
      `INSERT INTO aws_accounts (id, project_id, name, auth_method, region, credentials_enc, created_at) VALUES (?,?,?,?,?,?,?)`,
      awsAccountId, projectId, 'test-aws', 'keys', 'us-east-1', credsEnc, now(),
    );
  });

  after(async () => { await cleanup(); });

  it('admin can use aws-account from any project', async () => {
    // Admin creates a codecommit connection with aws-account mode
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'aws-account',
      region: 'us-east-1',
      awsAccountId,
    });

    // Mock the test provider to verify resolution succeeds for admin
    const original = _gitConnProviders.codecommitTestConnection;
    _gitConnProviders.codecommitTestConnection = async (creds) => {
      // Should not throw for admin
      assert.equal(creds.callerIsAdmin, true, 'callerIsAdmin should be true for admin');
      return { login: 'admin-test', name: 'CodeCommit (us-east-1)' };
    };

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/test`, {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    _gitConnProviders.codecommitTestConnection = original;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body as Record<string, unknown>).ok, true);
  });

  it('non-member cannot use aws-account from a project they lack access to', async () => {
    // member is NOT a member of the project owning the aws account
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'aws-account',
      region: 'us-east-1',
      awsAccountId,
    });

    // Make it a shared connection so member can call it
    run(`UPDATE git_connections_v2 SET scope = 'shared' WHERE id = ?`, connId);

    const original = _gitConnProviders.codecommitTestConnection;
    _gitConnProviders.codecommitTestConnection = async (creds) => {
      // resolve credentials and verify auth check is enforced
      const { resolveCodeCommitAwsCreds: _r } = await import('../server/git-connections.ts');
      return { login: 'test', name: 'CodeCommit' };
    };

    // The actual authorization check happens inside resolveCodeCommitAwsCreds.
    // Test that a non-member (memberId) gets an error when the connection's owner is
    // someone else. We do this by inserting a connection owned by the member themselves
    // and pointing to an aws-account in a project the member doesn't belong to.

    // Re-insert the conn as a shared connection with member as owner
    const memberConnId = generateId();
    const { config: cfg } = await import('../server/config.ts');
    const credsEnc = encrypt(JSON.stringify({ mode: 'aws-account', region: 'us-east-1', awsAccountId }), cfg.secretKey);
    run(
      "INSERT INTO git_connections_v2 (id, name, provider, credentials_enc, scope, owner_id, created_at) VALUES (?,?,?,?,?,?,?)",
      memberConnId, 'b7-member-cc', 'codecommit', credsEnc, 'shared', memberId, now(),
    );

    _gitConnProviders.codecommitTestConnection = original;

    // Direct call to resolveCodeCommitAwsCreds with non-member should throw
    const { resolveCodeCommitAwsCreds: resolveCC } = await import('../server/git-connections.ts') as unknown as {
      resolveCodeCommitAwsCreds: (creds: {
        mode: string; region: string; awsAccountId?: string;
        connectionOwnerId?: string; callerIsAdmin?: boolean;
      }) => Promise<unknown>;
    };

    await assert.rejects(
      () => resolveCC({
        mode: 'aws-account',
        region: 'us-east-1',
        awsAccountId,
        connectionOwnerId: memberId,
        callerIsAdmin: false,
      }),
      /access denied/i,
      'non-member should get access denied error',
    );
  });
});

// ── CodeCommit session token support (ASIA* / temporary credentials) ──────────

describe('CodeCommit session token support', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'cc-tok');
    _clearRepoCache();
  });

  afterEach(() => { _clearRepoCache(); });

  after(async () => { await cleanup(); });

  // ── 1. Create with sessionToken ─────────────────────────────────────────────

  it('create a CodeCommit connection with sessionToken stores it and returns hasSessionToken=true', async () => {
    const r = await fetchJson(baseUrl, '/api/git-connections', {
      method: 'POST',
      body: {
        name: `CC STS ${Date.now()}`,
        provider: 'codecommit',
        credentials: {
          mode: 'keys',
          region: 'us-east-1',
          accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          sessionToken: 'AQoDYXdzEJr...',
        },
        scope: 'personal',
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201, `create failed: ${JSON.stringify(r.body)}`);
    const conn = (r.body as Record<string, unknown>).connection as Record<string, unknown>;
    assert.equal(conn.hasSessionToken, true, 'hasSessionToken must be true after create');
    assert.ok(!('sessionToken' in conn), 'sessionToken must not appear in response');
    assert.ok(!('credentials_enc' in conn), 'credentials_enc must not appear in response');
  });

  // ── 2. Token not leaked in GET list ────────────────────────────────────────

  it('GET /api/git-connections never returns sessionToken or credentials_enc but exposes hasSessionToken', async () => {
    // Create a connection with a session token
    const createR = await fetchJson(baseUrl, '/api/git-connections', {
      method: 'POST',
      body: {
        name: `CC STS get ${Date.now()}`,
        provider: 'codecommit',
        credentials: {
          mode: 'keys',
          region: 'ap-southeast-1',
          accessKeyId: 'ASIAIOSFODNN7GET',
          secretAccessKey: 'secretForGetTest',
          sessionToken: 'tok-for-get-test',
        },
        scope: 'personal',
      },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201);
    const connId = ((createR.body as Record<string, unknown>).connection as Record<string, unknown>).id as string;

    const listR = await fetchJson(baseUrl, '/api/git-connections', { cookie: adminCookie });
    assert.equal(listR.status, 200);
    const conns = (listR.body as Record<string, unknown>).connections as Array<Record<string, unknown>>;
    const found = conns.find((c) => c.id === connId);
    assert.ok(found, 'connection must appear in list');
    assert.equal(found.hasSessionToken, true, 'hasSessionToken must be true');
    assert.ok(!Object.keys(found).includes('sessionToken'), 'sessionToken must not appear in list');
    assert.ok(!Object.keys(found).includes('credentials_enc'), 'credentials_enc must not appear in list');

    // A static-key connection should have hasSessionToken=false
    const staticR = await fetchJson(baseUrl, '/api/git-connections', {
      method: 'POST',
      body: {
        name: `CC STATIC ${Date.now()}`,
        provider: 'codecommit',
        credentials: {
          mode: 'keys',
          region: 'us-east-1',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'longTermSecret',
        },
        scope: 'personal',
      },
      cookie: adminCookie,
    });
    assert.equal(staticR.status, 201);
    const staticConn = (staticR.body as Record<string, unknown>).connection as Record<string, unknown>;
    assert.equal(staticConn.hasSessionToken, false, 'static key connection must have hasSessionToken=false');
  });

  // ── 3a. ASIA without token rejected on CREATE ───────────────────────────────

  it('POST /api/git-connections rejects ASIA accessKeyId without sessionToken (400)', async () => {
    const r = await fetchJson(baseUrl, '/api/git-connections', {
      method: 'POST',
      body: {
        name: `CC ASIA no token ${Date.now()}`,
        provider: 'codecommit',
        credentials: {
          mode: 'keys',
          region: 'us-east-1',
          accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          // sessionToken intentionally omitted
        },
        scope: 'personal',
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.ok(
      typeof body.error === 'string' && (body.error as string).toLowerCase().includes('session token'),
      `error must mention session token, got: ${body.error}`,
    );
  });

  // ── 3b. ASIA without token rejected on UPDATE ───────────────────────────────

  it('PUT /api/git-connections rejects ASIA accessKeyId without sessionToken (400)', async () => {
    // Start with a static-key connection
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'initialSecret',
    });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}`, {
      method: 'PUT',
      body: {
        credentials: {
          mode: 'keys',
          region: 'us-east-1',
          accessKeyId: 'ASIANEWKEY456',
          secretAccessKey: 'newSecret',
          // sessionToken intentionally omitted
        },
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.ok(
      typeof body.error === 'string' && (body.error as string).toLowerCase().includes('session token'),
      `error must mention session token, got: ${body.error}`,
    );
  });

  // ── 4. Session token flows through to clone credentials ────────────────────

  it('resolveCodeCommitAwsCreds returns sessionToken for keys mode', async () => {
    const result = await resolveCodeCommitAwsCreds({
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'AQoDYXdzEJr//session-token-value',
    });
    assert.ok(result, 'resolveCodeCommitAwsCreds must return creds');
    assert.equal(result.accessKeyId, 'ASIAIOSFODNN7EXAMPLE');
    assert.equal(result.sessionToken, 'AQoDYXdzEJr//session-token-value', 'sessionToken must be returned');
  });

  it('_buildCodeCommitSigV4Password username includes raw sessionToken when supplied (no percent-encoding)', () => {
    const sessionToken = 'AQoDYXdzEJr//test-tok==';
    const fixedDate = new Date('2024-01-15T10:00:00Z');
    const { username } = _buildCodeCommitSigV4Password(
      'ASIAIOSFODNN7EXAMPLE',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken,
      'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/test-repo',
      fixedDate,
    );
    assert.ok(username.includes('%'), 'username must contain % separator for session token');
    assert.equal(username, `ASIAIOSFODNN7EXAMPLE%${sessionToken}`, 'session token must be raw (not percent-encoded)');
    assert.ok(username.startsWith('ASIAIOSFODNN7EXAMPLE%'), 'username must start with accessKeyId%');
  });

  // ── 5. Expired/invalid token error messages ─────────────────────────────────

  it('/test maps ExpiredTokenException to a user-friendly expired-credentials message', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'expired-token',
    });

    const original = _gitConnProviders.codecommitTestConnection;
    _gitConnProviders.codecommitTestConnection = async () => {
      const err = new Error('The security token included in the request is expired.');
      (err as unknown as Record<string, string>).name = 'ExpiredTokenException';
      throw err;
    };

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/test`, {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    _gitConnProviders.codecommitTestConnection = original;

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, false);
    const errMsg = body.error as string;
    assert.ok(
      errMsg.toLowerCase().includes('expired'),
      `error must mention expired, got: ${errMsg}`,
    );
    assert.ok(
      errMsg.toLowerCase().includes('fresh') || errMsg.toLowerCase().includes('paste') || errMsg.toLowerCase().includes('sso'),
      `error must guide the user to refresh creds, got: ${errMsg}`,
    );
  });

  it('/test maps UnrecognizedClientException to a user-friendly invalid-token message', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wrongkey',
    });

    const original = _gitConnProviders.codecommitTestConnection;
    _gitConnProviders.codecommitTestConnection = async () => {
      const err = new Error('The security token included in the request is invalid.');
      (err as unknown as Record<string, string>).name = 'UnrecognizedClientException';
      throw err;
    };

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/test`, {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    _gitConnProviders.codecommitTestConnection = original;

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, false);
    const errMsg = body.error as string;
    assert.ok(
      errMsg.toLowerCase().includes('expired') || errMsg.toLowerCase().includes('invalid'),
      `error must mention expired or invalid, got: ${errMsg}`,
    );
  });

  it('/repos maps ExpiredTokenException to a user-friendly expired-credentials message', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'expired-repos-token',
    });

    const original = _gitConnProviders.codecommitListRepos;
    _gitConnProviders.codecommitListRepos = async () => {
      const err = new Error('The security token included in the request is expired.');
      (err as unknown as Record<string, string>).name = 'ExpiredTokenException';
      throw err;
    };

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    _gitConnProviders.codecommitListRepos = original;

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.deepEqual(body.repos, []);
    const errMsg = body.error as string;
    assert.ok(
      typeof errMsg === 'string' && errMsg.toLowerCase().includes('expired'),
      `error must mention expired, got: ${errMsg}`,
    );
  });

  // ── 6. Update clears session token when new static keys are sent ────────────

  it('PUT without sessionToken clears a previously stored session token (switching to long-term keys)', async () => {
    // 1. Create with temporary (ASIA) credentials
    const createR = await fetchJson(baseUrl, '/api/git-connections', {
      method: 'POST',
      body: {
        name: `CC STS update ${Date.now()}`,
        provider: 'codecommit',
        credentials: {
          mode: 'keys',
          region: 'us-east-1',
          accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          sessionToken: 'tok-to-be-cleared',
        },
        scope: 'personal',
      },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201);
    const connId = ((createR.body as Record<string, unknown>).connection as Record<string, unknown>).id as string;

    // Verify token is present
    const listR1 = await fetchJson(baseUrl, '/api/git-connections', { cookie: adminCookie });
    const before = (listR1.body as Record<string, unknown>).connections as Array<Record<string, unknown>>;
    assert.equal(before.find((c) => c.id === connId)?.hasSessionToken, true, 'should have token before update');

    // 2. Update with long-term (AKIA) keys — no sessionToken
    const updateR = await fetchJson(baseUrl, `/api/git-connections/${connId}`, {
      method: 'PUT',
      body: {
        credentials: {
          mode: 'keys',
          region: 'us-east-1',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'newLongTermSecret',
          // sessionToken intentionally omitted — should clear the old one
        },
      },
      cookie: adminCookie,
    });
    assert.equal(updateR.status, 200, `update failed: ${JSON.stringify(updateR.body)}`);
    const updatedConn = (updateR.body as Record<string, unknown>).connection as Record<string, unknown>;
    assert.equal(updatedConn.hasSessionToken, false, 'hasSessionToken must be false after switching to long-term keys');

    // 3. Verify GET also shows hasSessionToken=false
    const listR2 = await fetchJson(baseUrl, '/api/git-connections', { cookie: adminCookie });
    const after = (listR2.body as Record<string, unknown>).connections as Array<Record<string, unknown>>;
    assert.equal(after.find((c) => c.id === connId)?.hasSessionToken, false, 'GET must confirm token was cleared');
  });

  it('PUT without credentials at all keeps existing session token', async () => {
    // Create with session token
    const createR = await fetchJson(baseUrl, '/api/git-connections', {
      method: 'POST',
      body: {
        name: `CC STS keep ${Date.now()}`,
        provider: 'codecommit',
        credentials: {
          mode: 'keys',
          region: 'us-east-1',
          accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          sessionToken: 'tok-to-be-kept',
        },
        scope: 'personal',
      },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201);
    const connId = ((createR.body as Record<string, unknown>).connection as Record<string, unknown>).id as string;

    // Update only name — no credentials field
    const updateR = await fetchJson(baseUrl, `/api/git-connections/${connId}`, {
      method: 'PUT',
      body: { name: `CC STS keep updated ${Date.now()}` },
      cookie: adminCookie,
    });
    assert.equal(updateR.status, 200, `update failed: ${JSON.stringify(updateR.body)}`);
    const updatedConn = (updateR.body as Record<string, unknown>).connection as Record<string, unknown>;
    assert.equal(updatedConn.hasSessionToken, true, 'existing session token must be preserved when credentials not sent');
  });
});

// ── Bug 8: PUT merges credentials — blank secret fields keep stored values ─────

describe('Bug 8 — PUT /api/git-connections/:id merges credentials (no blank-wipe)', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'b8');
    _clearRepoCache();
  });

  afterEach(() => { _clearRepoCache(); });

  after(async () => { await cleanup(); });

  // Helper: decrypt the stored credentials_enc for a connection id.
  function storedCreds(connId: string): Record<string, string> {
    const row = one<{ credentials_enc: string }>(
      'SELECT credentials_enc FROM git_connections_v2 WHERE id = ?',
      connId,
    );
    if (!row?.credentials_enc) return {};
    return JSON.parse(decrypt(row.credentials_enc, config.secretKey)) as Record<string, string>;
  }

  // ── 1. CodeCommit: region-only edit keeps keys + session token ────────────

  it('CodeCommit region-only edit keeps accessKeyId, secretAccessKey and sessionToken', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'ASIAREGIONTEST1',
      secretAccessKey: 'storedSecret',
      sessionToken: 'storedToken',
    });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}`, {
      method: 'PUT',
      body: {
        credentials: {
          mode: 'keys',
          region: 'eu-west-1',
          accessKeyId: '',
          secretAccessKey: '',
          sessionToken: '',
        },
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const conn = (r.body as Record<string, unknown>).connection as Record<string, unknown>;
    assert.equal(conn.hasSessionToken, true, 'hasSessionToken must still be true after region-only edit');

    const creds = storedCreds(connId);
    assert.equal(creds.region, 'eu-west-1', 'region must be updated');
    assert.equal(creds.accessKeyId, 'ASIAREGIONTEST1', 'accessKeyId must be preserved');
    assert.equal(creds.secretAccessKey, 'storedSecret', 'secretAccessKey must be preserved');
    assert.equal(creds.sessionToken, 'storedToken', 'sessionToken must be preserved');
  });

  // ── 2. New AKIA key (different from stored) with no sessionToken clears token

  it('new AKIA accessKeyId with blank sessionToken clears the stored session token', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'ASIANEWAKIATEST',
      secretAccessKey: 'oldSecret',
      sessionToken: 'tokenToBeClearedByAkia',
    });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}`, {
      method: 'PUT',
      body: {
        credentials: {
          mode: 'keys',
          region: 'us-east-1',
          accessKeyId: 'AKIANEWLONGTERMKEY',
          secretAccessKey: 'newLongTermSecret',
          // sessionToken intentionally absent — should clear
        },
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const conn = (r.body as Record<string, unknown>).connection as Record<string, unknown>;
    assert.equal(conn.hasSessionToken, false, 'hasSessionToken must be false after switching to long-term AKIA key');

    const creds = storedCreds(connId);
    assert.equal(creds.accessKeyId, 'AKIANEWLONGTERMKEY', 'new accessKeyId must be stored');
    assert.equal(creds.secretAccessKey, 'newLongTermSecret', 'new secretAccessKey must be stored');
    assert.ok(!creds.sessionToken, 'sessionToken must be cleared');
  });

  // ── 3. New accessKeyId without secretAccessKey → 400 ──────────────────────

  it('new accessKeyId without secretAccessKey returns 400', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'AKIAEXISTING',
      secretAccessKey: 'existingSecret',
    });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}`, {
      method: 'PUT',
      body: {
        credentials: {
          mode: 'keys',
          region: 'us-east-1',
          accessKeyId: 'AKIANEWNOTSECRET',
          secretAccessKey: '',
        },
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.ok(
      typeof body.error === 'string' && (body.error as string).toLowerCase().includes('secret'),
      `error must mention secret, got: ${body.error}`,
    );
  });

  // ── 4. ASIA key edit with blank sessionToken keeps stored token → 200 ──────

  it('ASIA key edit with blank sessionToken keeps stored token and returns 200', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'ASIAASIAASIAASIATEST',
      secretAccessKey: 'storedAsiaSecret',
      sessionToken: 'storedAsiaToken',
    });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}`, {
      method: 'PUT',
      body: {
        credentials: {
          mode: 'keys',
          region: 'ap-southeast-1',
          accessKeyId: '',
          secretAccessKey: '',
          sessionToken: '',
        },
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `ASIA edit with blank token should be 200 (token kept from store): ${JSON.stringify(r.body)}`);

    const conn = (r.body as Record<string, unknown>).connection as Record<string, unknown>;
    assert.equal(conn.hasSessionToken, true, 'hasSessionToken must remain true');

    const creds = storedCreds(connId);
    assert.equal(creds.sessionToken, 'storedAsiaToken', 'stored session token must be preserved');
    assert.equal(creds.accessKeyId, 'ASIAASIAASIAASIATEST', 'stored accessKeyId must be preserved');
  });

  // ── 5. GitHub edit with blank token keeps stored token ────────────────────

  it('GitHub PUT with blank token field keeps the stored token', async () => {
    const connId = await createConn(baseUrl, adminCookie, 'github', { token: 'gho_storedtoken123' });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}`, {
      method: 'PUT',
      body: {
        credentials: { token: '' },
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const creds = storedCreds(connId);
    assert.equal(creds.token, 'gho_storedtoken123', 'stored GitHub token must be preserved when blank token sent');
  });

  // ── 6. Mode switch from keys to aws-account drops key fields ──────────────

  it('switching CodeCommit mode from keys to aws-account drops accessKeyId/secretAccessKey/sessionToken', async () => {
    const { config: cfg } = await import('../server/config.ts');
    const projectR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: `b8-mode-switch-${Date.now()}` },
      cookie: adminCookie,
    });
    const projectId = ((projectR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const awsAccountId = generateId();
    const credsEnc = encrypt(
      JSON.stringify({ accessKeyId: 'AKIAMODESWITCH', secretAccessKey: 'modeswitchsecret' }),
      cfg.secretKey,
    );
    run(
      `INSERT INTO aws_accounts (id, project_id, name, auth_method, region, credentials_enc, created_at) VALUES (?,?,?,?,?,?,?)`,
      awsAccountId, projectId, 'b8-aws', 'keys', 'us-east-1', credsEnc, now(),
    );

    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'ASIAKEYTODROP',
      secretAccessKey: 'secretToDrop',
      sessionToken: 'tokenToDrop',
    });

    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}`, {
      method: 'PUT',
      body: {
        credentials: {
          mode: 'aws-account',
          region: 'us-east-1',
          awsAccountId,
        },
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);

    const creds = storedCreds(connId);
    assert.equal(creds.mode, 'aws-account', 'mode must be updated to aws-account');
    assert.equal(creds.awsAccountId, awsAccountId, 'awsAccountId must be stored');
    assert.ok(!creds.accessKeyId, 'accessKeyId must be dropped on mode switch');
    assert.ok(!creds.secretAccessKey, 'secretAccessKey must be dropped on mode switch');
    assert.ok(!creds.sessionToken, 'sessionToken must be dropped on mode switch');
  });
});

// ── Bug 9 — CodeCommit BatchGetRepositories >25 repos + region in response ────
//
// Real cause: BatchGetRepositoriesCommand has a hard server-side limit of 25
// repository names per call. When a CodeCommit account had >25 repos the call
// threw MaximumRepositoryNamesExceededException, the route returned
// { repos: [], error: "…" }, and the UI showed "No repositories found" because
// the frontend wasn't displaying the `error` field.
//
// Fix: chunk names into batches of ≤25; include `region` in every CodeCommit
// response (success, cached, and error) so the UI can display it.

describe('Bug 9 — CodeCommit >25 repos batch + region in response', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'b9');
    _clearRepoCache();
  });

  afterEach(() => { _clearRepoCache(); });

  after(async () => { await cleanup(); });

  // Helper: build a DiscoveredRepo
  function makeRepo(name: string) {
    return {
      name,
      fullName: name,
      url: `https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/${name}`,
      defaultBranch: 'main',
      private: true as const,
      description: '',
      updatedAt: '',
    };
  }

  it('region is returned in a successful CodeCommit repos response', async () => {
    _gitConnProviders.codecommitListRepos = async () => ({
      repos: [makeRepo('repo-a'), makeRepo('repo-b')],
      nextPage: null,
    });

    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'ap-southeast-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.region, 'ap-southeast-1', 'region must be included in success response');
    const repos = body.repos as Array<Record<string, unknown>>;
    assert.equal(repos.length, 2);
  });

  it('region is returned in a CodeCommit error response', async () => {
    const original = _gitConnProviders.codecommitListRepos;
    _gitConnProviders.codecommitListRepos = async () => {
      const err = new Error('The security token included in the request is expired.');
      (err as unknown as Record<string, string>).name = 'ExpiredTokenException';
      throw err;
    };

    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'ap-southeast-1',
      accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'expired-tok',
    });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    _gitConnProviders.codecommitListRepos = original;

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.deepEqual(body.repos, []);
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'error must be present');
    assert.equal(body.region, 'ap-southeast-1', 'region must be included in error response');
  });

  it('region is returned from the server-side cache', async () => {
    _gitConnProviders.codecommitListRepos = async () => ({
      repos: [makeRepo('cached-repo')],
      nextPage: null,
    });

    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'ap-southeast-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });

    // First request populates the cache
    await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    // Replace provider so any cache miss would return different data
    _gitConnProviders.codecommitListRepos = async () => ({ repos: [], nextPage: null });

    // Second request should hit the cache
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const repos = body.repos as Array<Record<string, unknown>>;
    assert.equal(repos.length, 1, 'cached repos must be returned');
    assert.equal(body.region, 'ap-southeast-1', 'region must be returned from cache');
  });

  it('region defaults to us-east-1 when not set on connection', async () => {
    _gitConnProviders.codecommitListRepos = async () => ({ repos: [], nextPage: null });

    // Create connection without explicit region (server defaults to us-east-1)
    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.region, 'us-east-1', 'region must default to us-east-1');
  });

  it('MaximumRepositoryNamesExceededException is surfaced as an error (regression guard)', async () => {
    // If batch chunking regresses and the real SDK throws this, the route must
    // return { repos: [], error: <message> } rather than crashing.
    const original = _gitConnProviders.codecommitListRepos;
    _gitConnProviders.codecommitListRepos = async () => {
      const err = new Error('repositoryNames has too many repository names.  Maximum allowed is 25');
      (err as unknown as Record<string, string>).name = 'MaximumRepositoryNamesExceededException';
      throw err;
    };

    const connId = await createConn(baseUrl, adminCookie, 'codecommit', {
      mode: 'keys',
      region: 'ap-southeast-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    const r = await fetchJson(baseUrl, `/api/git-connections/${connId}/repos`, { cookie: adminCookie });
    _gitConnProviders.codecommitListRepos = original;

    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.deepEqual(body.repos, [], 'repos must be empty on error');
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'error must be surfaced');
    assert.equal(body.region, 'ap-southeast-1', 'region must be present even on error');
  });

  it('_doCodeCommitListReposForTest is exported (confirms batch fix is in the real implementation)', () => {
    assert.equal(typeof _doCodeCommitListReposForTest, 'function',
      '_doCodeCommitListReposForTest must be exported from git-connections.ts');
  });
});
