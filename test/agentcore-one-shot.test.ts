/**
 * One-shot AgentCore calls (a model list, a limits read, a text generation) must not leave their machine running until the idle
 * timeout: the session is stopped as soon as the call ends. And a good model list is cached, so opening a dialog does not start a
 * machine every time. Run against a local server that plays AgentCore's invoke and stop endpoints.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { invokeAgentCore, invokeAgentCoreOneShot, _setAgentCoreEndpointOverride } from '../server/agent/kiro-agentcore.ts';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one, insert } from '../server/db.ts';
import { generateId } from '../server/util.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import { getEngineModels } from '../server/models.ts';

const ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/oneShotTest-abc123';
const ev = (o: object): string => `data: ${JSON.stringify(o)}\n\n`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('one-shot AgentCore calls', () => {
  let server: http.Server;
  let invokes: string[] = [];
  let stops: string[] = [];
  let invokeBehaviour: (res: http.ServerResponse) => void;
  let stopBehaviour: (res: http.ServerResponse) => void;
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'PORTAL_AGENTCORE_STOP_WAIT_MS', 'PORTAL_AGENTCORE_KEEP_ONE_SHOT', 'PORTAL_CURSOR_AGENTCORE_RUNTIME_ARN']) saved[k] = process.env[k];
    process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-for-the-one-shot-test';
    delete process.env.AWS_SESSION_TOKEN; delete process.env.AWS_PROFILE;
    server = http.createServer((req, res) => {
      const session = String(req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] ?? '');
      req.resume();
      if ((req.url ?? '').includes('/stopruntimesession')) { stops.push(session); stopBehaviour(res); }
      else { invokes.push(session); invokeBehaviour(res); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    _setAgentCoreEndpointOverride(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });
  after(async () => {
    _setAgentCoreEndpointOverride(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  });
  beforeEach(() => {
    invokes = []; stops = [];
    invokeBehaviour = (res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(ev({ type: 'status', text: 'working' })); res.end(ev({ type: 'result', text: 'done' })); };
    stopBehaviour = (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); };
    delete process.env.PORTAL_AGENTCORE_STOP_WAIT_MS; delete process.env.PORTAL_AGENTCORE_KEEP_ONE_SHOT;
  });

  const drain = async (gen: AsyncGenerator<any>): Promise<any[]> => { const out: any[] = []; for await (const e of gen) out.push(e); return out; };

  it('stops the session, by its own id, after the call completes', async () => {
    const events = await drain(invokeAgentCoreOneShot(ARN, 'one-shot-1', { mode: 'x' }));
    assert.deepEqual(events.map((e) => e.type), ['status', 'result']);
    assert.deepEqual(invokes, ['one-shot-1']);
    assert.deepEqual(stops, ['one-shot-1']);
  });

  it('stops it too when the caller stops reading early (it already has its answer)', async () => {
    for await (const e of invokeAgentCoreOneShot(ARN, 'one-shot-2', { mode: 'x' })) { if (e.type === 'status') break; }
    assert.deepEqual(stops, ['one-shot-2']);
  });

  it('stops it when the call fails, and the failure still reaches the caller', async () => {
    invokeBehaviour = (res) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"message":"boom"}'); };
    await assert.rejects(drain(invokeAgentCoreOneShot(ARN, 'one-shot-3', { mode: 'x' })));
    assert.deepEqual(stops, ['one-shot-3']);
  });

  it('never lets a failed stop change the result, and is not held up by a stop that hangs', async () => {
    stopBehaviour = (res) => { res.writeHead(500); res.end('nope'); };
    assert.equal((await drain(invokeAgentCoreOneShot(ARN, 'one-shot-4', { mode: 'x' }))).length, 2);
    process.env.PORTAL_AGENTCORE_STOP_WAIT_MS = '150';
    stopBehaviour = () => { /* never answers */ };
    const t0 = Date.now();
    assert.equal((await drain(invokeAgentCoreOneShot(ARN, 'one-shot-5', { mode: 'x' }))).length, 2);
    assert.ok(Date.now() - t0 < 2_000, 'waited for the stop only as long as the bound');
    assert.deepEqual(stops, ['one-shot-4', 'one-shot-5']);
  });

  it('can be switched off, and an ordinary call (a conversation turn) is never stopped', async () => {
    process.env.PORTAL_AGENTCORE_KEEP_ONE_SHOT = '1';
    await drain(invokeAgentCoreOneShot(ARN, 'one-shot-6', { mode: 'x' }));
    delete process.env.PORTAL_AGENTCORE_KEEP_ONE_SHOT;
    await drain(invokeAgentCore(ARN, 'conversation-1', { mode: 'x' }));
    assert.deepEqual(invokes, ['one-shot-6', 'conversation-1']);
    assert.deepEqual(stops, []);
  });

  describe('the Cursor model list through AgentCore', () => {
    let baseUrl = '', cookie = '', userId = '', credId = '';
    before(async () => {
      process.env.PORTAL_CURSOR_AGENTCORE_RUNTIME_ARN = ARN;
      const ts = await createTestServer(); baseUrl = ts.baseUrl;
      cookie = (await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: 'os@example.com', name: 'O', password: 'password1234', provider: 'demo' } })).cookie ?? '';
      userId = String(one<{ id: string }>("SELECT id FROM users WHERE email = 'os@example.com'")!.id);
      credId = generateId();
      insert('engine_credentials', { id: credId, user_id: userId, engine: 'cursor', name: 'k', mode: 'api_key', secret_enc: encrypt('crsr_oneshot_key_1111', config.secretKey), is_default: 1, last4: '1111' });
      void cookie;
    });
    after(async () => { await cleanup(); });

    it('starts a machine once, stops it at once, and serves the next ask from the cache until refreshed', async () => {
      invokeBehaviour = (res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(ev({ type: 'models', text: 'auto - Auto (default)\ncomposer-2.5 - Composer 2.5\n' })); };
      const first = await getEngineModels('cursor', userId, credId, false);
      assert.deepEqual(first.models.map((m) => m.id), ['auto', 'composer-2.5']);
      assert.equal(invokes.length, 1);
      assert.ok(invokes[0].startsWith('cursor-models-'));
      assert.deepEqual(stops, invokes, 'the throwaway session was stopped');

      const second = await getEngineModels('cursor', userId, credId, false);
      assert.deepEqual(second.models, first.models);
      assert.equal(invokes.length, 1, 'no second machine for the same list');

      await getEngineModels('cursor', userId, credId, true);
      assert.equal(invokes.length, 2, 'a refresh (the Test button) asks again');
      assert.equal(stops.length, 2);
    });

    it('does not cache a failure, so the next ask tries again', async () => {
      invokes.length = 0; stops.length = 0;
      // A different credential so the earlier good list is not in play.
      const other = generateId();
      insert('engine_credentials', { id: other, user_id: userId, engine: 'cursor', name: 'k2', mode: 'api_key', secret_enc: encrypt('crsr_oneshot_key_2222', config.secretKey), is_default: 0, last4: '2222' });
      invokeBehaviour = (res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(ev({ type: 'error', message: 'no' })); };
      assert.ok((await getEngineModels('cursor', userId, other, false)).error);
      assert.ok((await getEngineModels('cursor', userId, other, false)).error);
      assert.equal(invokes.length, 2, 'asked twice: the failure was not remembered');
      assert.equal(stops.length, 2);
      await sleep(0);
    });
  });
});
