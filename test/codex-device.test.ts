import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one } from '../server/db.ts';
import { config } from '../server/config.ts';
import { decrypt } from '../server/secrets.ts';
import { SqliteCodexStore } from '../server/repositories/codex-store.ts';
import { _setAgentCoreInvokerOverride } from '../server/agent/kiro-agentcore.ts';
import { createCodexRunnerServer } from '../codex-runner/src/service.ts';
import { cloudCodexAuth, cloudCodexDeviceStatus } from '../server/codex-device.ts';
import { openDeviceCredential, sealDeviceCredential, nativeCredential } from '../server/codex-device-protocol.ts';
import { callCodexText } from '../server/agent/codex-text.ts';

describe('Cloud Codex device login across Lambda requests', () => {
  let base: string, cookie: string, userId: string, root: string;
  const store = new SqliteCodexStore();
  const runners = new Map<string, { server: http.Server; url: string; root: string }>();
  const keys = ['PORTAL_CODEX_AGENTCORE_RUNTIME_ARN', 'PORTAL_CODEX_AUTH_MODE', 'PORTAL_CODEX_OAUTH_CLIENT_ID', 'PORTAL_CODEX_BIN', 'STORAGE_BACKEND'];
  const saved = new Map(keys.map(k => [k, process.env[k]]));
  let pollGate: Promise<void> | null = null, refreshGate: Promise<void> | null = null;
  let refreshes = 0;
  const invoke = async function* (_arn: string, session: string, payload: Record<string, unknown>): AsyncGenerator<any> {
    let runner = runners.get(session);
    if (!runner) {
      const home = path.join(root, session);
      const server = createCodexRunnerServer({ root: home });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      runner = { server, url: 'http://127.0.0.1:' + (server.address() as any).port, root: home }; runners.set(session, runner);
    }
    if (payload.mode === 'device-refresh') {
      refreshes++;
      assert.equal(JSON.stringify(payload).includes('fake-secret-never-display'), false);
    }
    const response = await fetch(runner.url + '/invocations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }); let i: number;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          if (!block.startsWith('data: ')) continue;
          if (payload.mode === 'device-poll') await pollGate;
          if (payload.mode === 'device-refresh') await refreshGate;
          yield JSON.parse(block.slice(6));
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  };
  const post = (suffix: string) => fetchJson(base, '/api/codex/' + suffix, { method: 'POST', cookie, body: {} });
  const connect = async () => {
    const start = await post('login'); assert.equal(start.status, 200); assert.equal((start.body as any).status, 'pending');
    await new Promise(resolve => setTimeout(resolve, 100));
    const status = await fetchJson(base, '/api/codex/status', { cookie });
    assert.equal((status.body as any).signedIn, true); return status;
  };
  before(async () => {
    ({ baseUrl: base } = await createTestServer());
    const setup = await fetchJson(base, '/api/auth/setup', { method: 'POST', body: { name: 'Admin', email: 'device@example.test', password: 'password1234' } });
    cookie = setup.cookie!; userId = one<any>('SELECT id FROM users WHERE email = ?', 'device@example.test').id;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-codex-device-test-'));
    process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/codex_fixture';
    process.env.PORTAL_CODEX_BIN = path.resolve('test/fake-codex.mjs'); process.env.STORAGE_BACKEND = 's3';
    delete process.env.PORTAL_CODEX_OAUTH_CLIENT_ID; process.env.PORTAL_CODEX_AUTH_MODE = 'device';
    _setAgentCoreInvokerOverride(invoke);
  });
  beforeEach(async () => { pollGate = null; refreshGate = null; refreshes = 0; await post('logout'); });
  after(async () => {
    _setAgentCoreInvokerOverride(null);
    for (const [session, runner] of runners) {
      if (session.startsWith('codex-device-')) await fetch(runner.url + '/invocations', { method: 'POST', body: JSON.stringify({ mode: 'device-cancel', attemptId: session }) });
      runner.server.closeAllConnections(); await new Promise<void>(resolve => runner.server.close(() => resolve()));
    }
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await cleanup();
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('portal-codex-device-test-')) await fs.rm(root, { recursive: true, force: true });
  });
  it('requires no registered client and stores only encrypted per-user credentials', async () => {
    const empty = (await fetchJson(base, '/api/codex/status', { cookie })).body as any;
    assert.equal(empty.supported, true); assert.equal(empty.authMode, 'device'); assert.equal(empty.signedIn, false);
    assert.equal(empty.experimental, true);
    const status = await connect();
    assert.equal((status.body as any).email, 'codex@example.test');
    assert.equal(JSON.stringify(status.body).includes('fake-secret'), false);
    assert.equal((await store.get(userId))!.ciphertext.includes('fake-secret'), false);
    assert.equal(await cloudCodexDeviceStatus('another-user'), null);
    // A subsequent Lambda request needs no in-memory portal login object.
    assert.equal((await cloudCodexDeviceStatus(userId))!.signedIn, true);
  });
  it('uses native external tokens for inference without placing auth.json in the agent workspace', async () => {
    await connect();
    const result = JSON.parse(await callCodexText('EXTERNAL_AUTH', userId));
    assert.deepEqual(result, { external: true, account: 'fixture-chatgpt-account', authOnDisk: false });
    const auth = await cloudCodexAuth(userId);
    assert.ok('chatgptAuthTokens' in auth); assert.equal(JSON.stringify(auth).includes('refresh_token'), false);
    const authSession = [...runners.entries()].find(([s]) => s.startsWith('codex-device-'))!;
    assert.equal((await fetch(authSession[1].url + '/invocations', { method: 'POST', body: JSON.stringify({ mode: 'inspect', op: 'tree' }) })).status, 403);
  });
  it('requires explicit opt-in even when native credentials have already been saved', async () => {
    await connect();
    delete process.env.PORTAL_CODEX_AUTH_MODE;
    try { await assert.rejects(cloudCodexAuth(userId), /could not be opened/); }
    finally { process.env.PORTAL_CODEX_AUTH_MODE = 'device'; }
  });
  it('serializes renewal, persists rotated credentials, and keeps the transport encrypted', async () => {
    await connect();
    let release!: () => void; refreshGate = new Promise<void>(resolve => { release = resolve; });
    const first = cloudCodexAuth(userId, true);
    while (!refreshes) await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(cloudCodexAuth(userId, true), /being renewed/);
    release(); await first;
    const row = (await store.get(userId))!;
    const stored = JSON.parse(decrypt(row.ciphertext, config.secretKey));
    assert.match(JSON.parse(stored.auth).tokens.refresh_token, /rotated/);
    assert.equal(row.ciphertext.includes('rotated'), false);
  });
  it('answers native token renewal during a model turn without exposing credentials', async () => {
    await connect();
    assert.equal(await callCodexText('REQUEST_AUTH_REFRESH', userId), 'Renewed account');
    assert.equal(refreshes, 1);
  });
  it('does not resurrect login when logout races a completed poll', async () => {
    await post('login'); await new Promise(resolve => setTimeout(resolve, 100));
    let release!: () => void; pollGate = new Promise<void>(resolve => { release = resolve; });
    const poll = cloudCodexDeviceStatus(userId);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await post('logout')).status, 200);
    release(); await poll;
    assert.equal(((await fetchJson(base, '/api/codex/status', { cookie })).body as any).signedIn, false);
    assert.equal((await store.get(userId))!.ciphertext, '');
  });
  it('does not resurrect rotated credentials when logout races renewal', async () => {
    await connect();
    let release!: () => void; refreshGate = new Promise<void>(resolve => { release = resolve; });
    const renewal = cloudCodexAuth(userId, true); void renewal.catch(() => {});
    while (!refreshes) await new Promise(resolve => setTimeout(resolve, 10));
    await post('logout'); release();
    await assert.rejects(renewal, /disconnected during renewal/);
    assert.equal((await store.get(userId))!.ciphertext, '');
  });
  it('cancels pending attempts and keeps a generation after cancellation', async () => {
    await post('login'); assert.equal((await post('login/cancel')).status, 200);
    assert.equal((await cloudCodexDeviceStatus(userId)), null);
    assert.ok((await store.get(userId))!.version > 1);
  });
  it('rejects API keys and tampered credential envelopes', () => {
    const key = randomBytes(32).toString('base64url'), envelope = sealDeviceCredential('protected', key);
    assert.equal(openDeviceCredential(envelope, key), 'protected');
    assert.throws(() => openDeviceCredential(envelope, randomBytes(32).toString('base64url')));
    assert.throws(() => nativeCredential(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'never-use' })));
  });
});
