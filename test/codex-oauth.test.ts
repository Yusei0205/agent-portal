import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one, insert } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { runCodexViaAgentCore } from '../server/agent/codex-agentcore.ts';
import { _setAgentCoreInvokerOverride } from '../server/agent/kiro-agentcore.ts';
import { getStorage, setStorage } from '../server/storage-instance.ts';
import type { RunContext } from '../server/agent/types.ts';
import { callCodexText } from '../server/agent/codex-text.ts';
import { config } from '../server/config.ts';
import { encrypt } from '../server/secrets.ts';
import { SqliteCodexStore } from '../server/repositories/codex-store.ts';
import { startCodexOAuth, completeCodexOAuth, readCodexAccount, codexAccessToken, setCodexOAuthFetchForTests, disconnectCodexOAuth } from '../server/codex-oauth.ts';

describe('Codex hosted OAuth and durable renewal', () => {
  let base: string, cookie: string, userId: string;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const store = new SqliteCodexStore();
  const environment = ['PORTAL_CODEX_AGENTCORE_RUNTIME_ARN', 'PORTAL_CODEX_OAUTH_CLIENT_ID', 'PORTAL_CODEX_OAUTH_REDIRECT_URI', 'STORAGE_BACKEND', 'PORTAL_CODEX_OAUTH_CLIENT_AUTH'];
  const saved = new Map(environment.map(k => [k, process.env[k]]));
  let nonce = '', badIdentity = false, scope = '', refreshes = 0;
  let refreshGate: Promise<void> | null = null;
  const scopes = 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct';
  const jwt = () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: badIdentity ? 'wrong-client' : 'oaiapp_fixture',
      sub: 'subject-fixture', email: 'codex@example.test', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    return header + '.' + body + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + body), keys.privateKey).toString('base64url');
  };
  const fetcher = (async (url, init) => {
    const address = String(url);
    if (address.endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
      token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/revoke' });
    if (address.endsWith('jwks.json')) return Response.json({ keys: [jwk] });
    if (address.endsWith('/revoke')) return new Response('', { status: 200 });
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('resource'), 'https://api.openai.com/v1');
    assert.equal(form.get('client_id'), 'oaiapp_fixture');
    if (form.get('grant_type') === 'refresh_token') {
      refreshes++; await refreshGate;
      return Response.json({ access_token: 'new-short-lived-token', refresh_token: 'rotated-refresh-token', expires_in: 3600 });
    }
    assert.ok(form.get('code_verifier'));
    assert.equal(form.get('redirect_uri'), 'https://portal.example/api/codex/oauth/callback');
    return Response.json({ id_token: jwt(), access_token: 'short-lived-token', refresh_token: 'renewable-secret', expires_in: 3600, scope });
  }) as typeof fetch;
  const attempt = async () => {
    const url = new URL(await startCodexOAuth(userId)); nonce = url.searchParams.get('nonce')!;
    return new URLSearchParams({ state: url.searchParams.get('state')!, code: 'fixture-code' });
  };
  before(async () => {
    ({ baseUrl: base } = await createTestServer());
    const setup = await fetchJson(base, '/api/auth/setup', { method: 'POST', body: { name: 'Admin', email: 'oauth-admin@example.test', password: 'password1234' } });
    cookie = setup.cookie!;
    userId = one<{ id: string }>('SELECT id FROM users WHERE email = ?', 'oauth-admin@example.test')!.id;
    process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/codex_fixture';
    process.env.PORTAL_CODEX_OAUTH_CLIENT_ID = 'oaiapp_fixture';
    process.env.PORTAL_CODEX_OAUTH_REDIRECT_URI = 'https://portal.example/api/codex/oauth/callback';
    process.env.PORTAL_CODEX_OAUTH_CLIENT_AUTH = 'none';
    process.env.STORAGE_BACKEND = 's3';
    setCodexOAuthFetchForTests(fetcher);
  });
  beforeEach(async () => {
    const row = await store.get(userId); if (row) await store.remove(userId, row.version);
    badIdentity = false; scope = scopes; refreshes = 0; refreshGate = null;
  });
  after(async () => {
    setCodexOAuthFetchForTests(null);
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await cleanup();
  });

  it('uses PKCE and durable one-time state, encrypts credentials, and exposes only account metadata', async () => {
    const query = await attempt();
    await completeCodexOAuth(userId, query);
    await assert.rejects(completeCodexOAuth(userId, query), /already used/);
    const row = (await store.get(userId))!;
    assert.equal(row.ciphertext.includes('renewable-secret'), false);
    assert.equal((await readCodexAccount(userId))!.account.subject, 'subject-fixture');
    const status = await fetchJson(base, '/api/codex/status', { cookie });
    assert.equal((status.body as any).signedIn, true);
    assert.equal((status.body as any).remote, true);
    assert.equal(JSON.stringify(status.body).includes('short-lived-token'), false);
  });
  it('does not let another portal user consume an authorization attempt', async () => {
    const query = await attempt();
    await assert.rejects(completeCodexOAuth('another-user', query), /another user/);
    await completeCodexOAuth(userId, query);
  });
  it('rejects the wrong signed token audience and identity-only grants', async () => {
    const first = await attempt(); badIdentity = true;
    await assert.rejects(completeCodexOAuth(userId, first), /identity could not be verified/);
    assert.equal(await readCodexAccount(userId), null);
    badIdentity = false; scope = 'openid profile email';
    await assert.rejects(completeCodexOAuth(userId, await attempt()), /Identity-only/);
    assert.equal(await readCodexAccount(userId), null);
  });
  it('allows only the lease owner to unlock and prevents stale credential writes', async () => {
    await completeCodexOAuth(userId, await attempt());
    const old = (await store.get(userId))!;
    assert.equal(await store.lock(userId, 'instance-A', Date.now(), Date.now() + 60_000), true);
    await store.unlock(userId, 'instance-B');
    assert.equal(await store.lock(userId, 'instance-B', Date.now(), Date.now() + 60_000), false);
    await store.unlock(userId, 'instance-A');
    assert.equal(await store.put(userId, old.ciphertext, old.version), true);
    assert.equal(await store.put(userId, old.ciphertext, old.version), false);
  });
  async function expire(): Promise<void> {
    const current = (await readCodexAccount(userId))!;
    await store.put(userId, encrypt(JSON.stringify({ ...current.account, expiresAt: 0 }), config.secretKey), current.version);
  }
  it('serializes rotating-token renewal across independent callers', async () => {
    await completeCodexOAuth(userId, await attempt()); await expire();
    const results = await Promise.allSettled([codexAccessToken(userId), codexAccessToken(userId)]);
    assert.equal(refreshes, 1);
    assert.ok(results.some(r => r.status === 'fulfilled' && r.value === 'new-short-lived-token'));
    assert.equal((await readCodexAccount(userId))!.account.refreshToken, 'rotated-refresh-token');
  });
  it('never resurrects credentials when disconnect races a token refresh', async () => {
    await completeCodexOAuth(userId, await attempt()); await expire();
    let release!: () => void; refreshGate = new Promise(resolve => { release = resolve; });
    const renewing = codexAccessToken(userId);
    for (let i = 0; i < 30 && !refreshes; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const current = (await store.get(userId))!; await store.remove(userId, current.version);
    release();
    await assert.rejects(renewing, /changed during renewal/);
    assert.equal(await readCodexAccount(userId), null);
  });
  it('invalidates pending callbacks at logout and never reuses a connection generation', async () => {
    const pending = await attempt();
    await disconnectCodexOAuth(userId);
    await assert.rejects(completeCodexOAuth(userId, pending), /connection changed/);
    await completeCodexOAuth(userId, await attempt());
    const stale = (await store.get(userId))!;
    await disconnectCodexOAuth(userId);
    await completeCodexOAuth(userId, await attempt());
    assert.equal(await store.put(userId, 'stale-credentials', stale.version), false);
    assert.equal((await readCodexAccount(userId))!.account.subject, 'subject-fixture');
  });
  it('revokes the renewable session and removes durable credentials on logout', async () => {
    await completeCodexOAuth(userId, await attempt());
    assert.equal(await disconnectCodexOAuth(userId), true);
    assert.equal(await readCodexAccount(userId), null);
  });
  it('bridges cloud events and persists thread identity only after durable completion', async () => {
    await completeCodexOAuth(userId, await attempt());
    const project = await fetchJson(base, '/api/projects', { method: 'POST', cookie, body: { name: 'Cloud Codex test' } });
    const projectId = (project.body as any).project.id;
    const workflowId = generateId(), runId = generateId();
    insert('p6_workflows', { id: workflowId, project_id: projectId, goal: 'test', engine: 'codex', status: 'running', repo_ids: '[]', created_at: now(), updated_at: now(), created_by: userId });
    const emitted: any[] = [], recorded: any[] = [];
    const ctx: RunContext = { run: { workflowId, runId, projectId: null, credentialOwnerId: userId, workDir: config.dataDir,
      permissions: { rules: [], toolRules: [], projectId }, trusted: false, goal: 'Test', kind: null, engine: 'codex',
      dataDir: config.dataDir, repoIds: [], leadAgent: null, credentialId: null, model: null, engineSessionId: null },
      emit: (type: string, payload: object) => emitted.push({ type, payload }), signal: null, allowed: new Set(),
      awaitInput: async () => ({ decision: 'allow', remember: false, message: '' }) };
    const storage = getStorage(); let durable = false;
    setStorage({ exists: async () => false, presign: async (key: string) => 'https://fixture.s3.amazonaws.com/' + key } as any);
    _setAgentCoreInvokerOverride(async function* (_arn, session, payload): AsyncGenerator<any> {
      assert.equal(session.startsWith('wf-x-'), true);
      assert.equal(payload.accessToken, 'short-lived-token');
      assert.equal('refreshToken' in payload, false);
      assert.ok(JSON.stringify(payload.stateSnapshot).includes('codex-state-snapshots/'));
      yield { type: 'portal-event', eventType: 'assistant-text', payload: { text: 'short-lived-token safe text' } };
      yield { type: 'portal-event', eventType: 'run-complete', payload: {} }; // worker cannot forge portal completion
      yield { type: 'result', exitCode: 0, stateSaved: durable, text: 'Done', threadId: 'cloud-thread', model: 'fixture', inputTokens: 11, outputTokens: 3 };
    });
    try {
      await assert.rejects(runCodexViaAgentCore(ctx, 'Goal', async usage => { recorded.push(usage); }), /durable conversation/);
      assert.equal(one<any>('SELECT engine_session_id FROM p6_workflows WHERE id = ?', workflowId).engine_session_id, null);
      durable = true;
      assert.equal((await runCodexViaAgentCore(ctx, 'Goal', async usage => { recorded.push(usage); })).text, 'Done');
      assert.equal(one<any>('SELECT engine_session_id FROM p6_workflows WHERE id = ?', workflowId).engine_session_id, 'cloud-thread');
      assert.equal(recorded.at(-1).inputTokens, 11);
      assert.equal(emitted.some(e => e.type === 'run-complete'), false);
      assert.equal(JSON.stringify(emitted).includes('short-lived-token'), false);
    } finally { _setAgentCoreInvokerOverride(null); setStorage(storage); }
  });
  it('sends cloud Portal AI requests through isolated short sessions with no renewable credentials', async () => {
    await completeCodexOAuth(userId, await attempt());
    _setAgentCoreInvokerOverride(async function* (_arn, session, payload): AsyncGenerator<any> {
      assert.ok(session.startsWith('codex-text-'));
      assert.equal(payload.mode, 'codex-text'); assert.equal(payload.model, 'fixture-model');
      assert.equal(payload.accessToken, 'short-lived-token');
      assert.equal(JSON.stringify(payload).includes('renewable-secret'), false);
      yield { type: 'result', exitCode: 0, text: 'Generated output' };
    });
    try { assert.equal(await callCodexText('Generate output', userId, 'fixture-model'), 'Generated output'); }
    finally { _setAgentCoreInvokerOverride(null); }
  });
});
