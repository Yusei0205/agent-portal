/**
 * Idle time per runner: a runner with a setting has its AgentCore sessions stopped (StopRuntimeSession) once the portal session has
 * been idle that long; a runner without one is left to the platform timeout; each idle period is stopped once; admins only.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { hashPassword } from '../server/auth.ts';
import { now } from '../server/util.ts';
import { setSetting } from '../server/settings.ts';
import { sweepAgentCoreIdle, getIdleMinutes } from '../server/agentcore-idle.ts';
import { agentCoreSessionId } from '../server/agent/agentcore-session.ts';
import { _setAgentCoreEndpointOverride } from '../server/agent/kiro-agentcore.ts';

const CODEX_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/agentPortalCodexRunner-test000000';
const calls: Array<{ url: string; session: string }> = [];
let status = 200;
let server: http.Server;
let baseUrl: string;
let adminCookie = '';
let memberCookie = '';

before(async () => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIATESTTESTTESTTEST';
  process.env.AWS_SECRET_ACCESS_KEY = 'secret-secret-secret-secret-secret-xx';
  process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN = CODEX_ARN;
  server = http.createServer((req, res) => {
    calls.push({ url: req.url ?? '', session: String(req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] ?? '') });
    req.resume();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  _setAgentCoreEndpointOverride(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

  ({ baseUrl } = await createTestServer());
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@idle.test', password: 'adminpass1', name: 'Admin' } });
  adminCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@idle.test', password: 'adminpass1' } })).cookie ?? '';
  getDb().prepare('INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
    .run('user-idle-member', 'member@idle.test', 'Member', hashPassword('memberpass1'), now());
  memberCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'member@idle.test', password: 'memberpass1' } })).cookie ?? '';
});
after(async () => {
  _setAgentCoreEndpointOverride(null);
  delete process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN;
  await new Promise<void>((r) => server.close(() => r()));
  await cleanup();
});
beforeEach(() => { calls.length = 0; status = 200; getDb().prepare('DELETE FROM p6_workflows').run(); });

const seed = (engine: string, minutesAgo: number, wid = `wf-idle-${Math.random().toString(36).slice(2)}`): string => {
  const ts = now();
  getDb().prepare(`INSERT INTO p6_workflows (id, goal, title, status, engine, trust_tools, lead_agent, created_at, updated_at, last_turn_at, stop_reason)
    VALUES (?, 'g', 't', 'done', ?, 0, 'default', ?, ?, ?, '')`).run(wid, engine, ts, ts, new Date(Date.now() - minutesAgo * 60_000).toISOString());
  return wid;
};
const setMinutes = (engine: string, v: string) => setSetting(getDb(), `agentcore.idle_minutes.${engine}`, v);

describe('sweepAgentCoreIdle', () => {
  test('does nothing for a runner with no setting', async () => {
    await setMinutes('codex', '');
    seed('codex', 120);
    assert.equal(await sweepAgentCoreIdle(), 0);
    assert.equal(calls.length, 0);
  });

  test('stops a session idle longer than the setting, on the right runtime, with its session id', async () => {
    await setMinutes('codex', '5');
    const wid = seed('codex', 20);
    assert.equal(await sweepAgentCoreIdle(), 1);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes(encodeURIComponent(CODEX_ARN)) && calls[0].url.includes('/stopruntimesession'));
    assert.equal(calls[0].session, agentCoreSessionId(wid, 'codex'));
  });

  test('leaves a session that has not been idle long enough', async () => {
    await setMinutes('codex', '30');
    seed('codex', 10);
    assert.equal(await sweepAgentCoreIdle(), 0);
  });

  test('stops each idle period once, and again after a new turn', async () => {
    await setMinutes('codex', '5');
    const wid = seed('codex', 20);
    assert.equal(await sweepAgentCoreIdle(), 1);
    assert.equal(await sweepAgentCoreIdle(), 0);
    getDb().prepare('UPDATE p6_workflows SET last_turn_at = ? WHERE id = ?').run(new Date(Date.now() - 10 * 60_000).toISOString(), wid);
    assert.equal(await sweepAgentCoreIdle(), 1);
  });

  test('0 stops a session as soon as the turn has ended', async () => {
    await setMinutes('codex', '0');
    seed('codex', 1);
    assert.equal(await sweepAgentCoreIdle(), 1);
  });

  test('a session already gone counts as stopped; a platform error is retried on the next pass', async () => {
    await setMinutes('codex', '5');
    seed('codex', 20);
    status = 404;
    assert.equal(await sweepAgentCoreIdle(), 1);
    calls.length = 0;
    seed('codex', 20);
    status = 500;
    assert.equal(await sweepAgentCoreIdle(), 0);
    status = 200;
    assert.equal(await sweepAgentCoreIdle(), 1);
  });
});

describe('/api/agentcore/idle', () => {
  test('is for admins only', async () => {
    assert.equal((await fetchJson(baseUrl, '/api/agentcore/idle', { cookie: memberCookie })).status, 403);
    assert.equal((await fetchJson(baseUrl, '/api/agentcore/idle', { method: 'PUT', cookie: memberCookie, body: { engine: 'codex', minutes: 5 } })).status, 403);
  });

  test('saves a value, clears it with null, and rejects bad input', async () => {
    const put = (body: unknown) => fetchJson(baseUrl, '/api/agentcore/idle', { method: 'PUT', cookie: adminCookie, body });
    assert.equal((await put({ engine: 'kiro', minutes: 7 })).status, 200);
    assert.equal(getIdleMinutes('kiro'), 7);
    const list = await fetchJson(baseUrl, '/api/agentcore/idle', { cookie: adminCookie });
    assert.equal(list.body.engines.find((e: any) => e.engine === 'kiro').minutes, 7);
    assert.equal((await put({ engine: 'kiro', minutes: null })).status, 200);
    assert.equal(getIdleMinutes('kiro'), null);
    assert.equal((await put({ engine: 'nope', minutes: 5 })).status, 400);
    assert.equal((await put({ engine: 'kiro', minutes: -1 })).status, 400);
    assert.equal((await put({ engine: 'kiro', minutes: 99999 })).status, 400);
    assert.equal((await put({ engine: 'kiro', minutes: 2.5 })).status, 400);
  });
});
