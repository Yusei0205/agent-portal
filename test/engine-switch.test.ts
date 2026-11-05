/**
 * Switching a session to another engine (POST /api/projects/:id/workflows/:wid/engine),
 * e.g. when Kiro credits are used up and the work should carry on with Claude Code.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run as dbRun, one, insert } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { resumableEngineSessionId } from '../server/agent/runner.ts';

async function setupAdmin(baseUrl: string): Promise<string> {
  const email = 'es-admin@example.com';
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  if (r.cookie) return r.cookie;
  const login = await fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: { email, password: 'password1234' } });
  return login.cookie ?? '';
}

describe('resumableEngineSessionId', () => {
  it('only lets the engine that created a session resume it', () => {
    assert.equal(resumableEngineSessionId({ engine: 'kiro', engine_session_id: 's1', engine_session_engine: 'kiro' }), 's1');
    assert.equal(resumableEngineSessionId({ engine: 'claude-code', engine_session_id: 's1', engine_session_engine: 'kiro' }), null);
    // Older rows did not record the engine: keep resuming as before.
    assert.equal(resumableEngineSessionId({ engine: 'kiro', engine_session_id: 's1', engine_session_engine: null }), 's1');
    assert.equal(resumableEngineSessionId({ engine: 'kiro', engine_session_id: null }), null);
  });
});

describe('POST /api/projects/:id/workflows/:wid/engine', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let userId: string;

  const createSession = async (engine = 'demo'): Promise<string> => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: 'Fix the bug', engine }, cookie });
    return ((r.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  };
  const sw = (wid: string, body: Record<string, unknown>) =>
    fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}/engine`, { method: 'POST', body, cookie });
  const addCredential = (engine: string, owner = userId): string => {
    const id = generateId();
    insert('engine_credentials', { id, user_id: owner, engine, name: `${engine} sign-in`, mode: 'api_key', is_default: 1 });
    return id;
  };

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Switch project' }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    userId = String(one<{ id: string }>("SELECT id FROM users WHERE email = 'es-admin@example.com'")!.id);
  });

  after(async () => cleanup());

  it('moves a Kiro session to Claude Code and drops the Kiro engine session', async () => {
    const wid = await createSession('kiro');
    dbRun("UPDATE p6_workflows SET engine_session_id = 'kiro-sess', engine_session_engine = 'kiro', model = 'kiro-model', lead_agent = 'kiro-agent' WHERE id = ?", wid);
    const credId = addCredential('claude-code');

    const r = await sw(wid, { engine: 'claude-code', credentialId: credId, model: 'sonnet' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = one<Record<string, unknown>>('SELECT * FROM p6_workflows WHERE id = ?', wid)!;
    assert.equal(w.engine, 'claude-code');
    assert.equal(w.credential_id, credId);
    assert.equal(w.model, 'sonnet');
    assert.equal(w.lead_agent, null, 'a Kiro agent does not carry over to Claude');
    assert.equal(w.engine_session_id, null);
    assert.equal(w.engine_session_engine, null);

    const ev = one<{ kind: string; body: string }>("SELECT kind, body FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'engine-switch'", wid);
    assert.equal(ev?.body, 'Switched engine from Kiro to Claude Code');
    const audit = one<{ action: string }>("SELECT action FROM audit_log WHERE action = 'session.engine-switch' AND target = ?", `workflow:${wid}`);
    assert.ok(audit, 'the switch is in the audit log');
  });

  it('shows the switch in the transcript', async () => {
    const wid = await createSession('kiro');
    await sw(wid, { engine: 'claude-code' });
    const t = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}/transcript`, { cookie });
    const events = (t.body as { events: Array<{ kind?: string; type?: string }> }).events;
    assert.ok(events.some((e) => (e.kind ?? e.type) === 'engine-switch'));
  });

  it('refuses while a run is going', async () => {
    const wid = await createSession('kiro');
    insert('p6_runs', { id: generateId(), workflow_id: wid, status: 'running', cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: now() });
    const r = await sw(wid, { engine: 'claude-code' });
    assert.equal(r.status, 409);
    assert.equal(one<{ engine: string }>('SELECT engine FROM p6_workflows WHERE id = ?', wid)!.engine, 'kiro');
  });

  it("refuses a sign-in for the wrong engine, or someone else's", async () => {
    const wid = await createSession('kiro');
    const kiroCred = addCredential('kiro');
    assert.equal((await sw(wid, { engine: 'claude-code', credentialId: kiroCred })).status, 400);

    dbRun("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('other-user', 'other@example.com', 'Other', 'x', 0, ?)", now());
    const othersCred = addCredential('claude-code', 'other-user');
    assert.equal((await sw(wid, { engine: 'claude-code', credentialId: othersCred })).status, 400);
    assert.equal(one<{ engine: string }>('SELECT engine FROM p6_workflows WHERE id = ?', wid)!.engine, 'kiro');
  });

  it('only the person who started the session can switch it', async () => {
    const wid = await createSession('kiro');
    dbRun("UPDATE p6_workflows SET created_by = 'other-user' WHERE id = ?", wid);
    const r = await sw(wid, { engine: 'claude-code' });
    assert.equal(r.status, 403);
  });

  it('rejects an unknown engine and a switch that changes nothing', async () => {
    const wid = await createSession('kiro');
    assert.equal((await sw(wid, { engine: 'gpt' })).status, 400);
    assert.equal((await sw(wid, {})).status, 400);
    assert.equal((await sw(wid, { engine: 'kiro' })).status, 400);
  });
});
