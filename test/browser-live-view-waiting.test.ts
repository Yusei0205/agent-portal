/**
 * GET /api/workflows/:wid/browser/live-view tells the page when the agent is waiting for a person to sign in: the latest
 * browser-waiting note of the current browser session says "waiting", and a later "done" (or a new session) clears it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { deps, resumableBrowserSession, BROWSER_LIFETIME_MS } from '../server/browser-session.ts';

describe('live view: the agent is waiting for the person', () => {
  const saved: Record<string, string | undefined> = {};
  let baseUrl = '', cookie = '', workflowId = '', runId = '';
  let tick = 0;
  let projectIdOf = '';
  const repo = () => getSessionsRepository();
  const stopped: string[] = [];
  let open = true;
  const t0 = Date.now() - 10 * 60_000; // a browser announced ten minutes ago is well within its lifetime
  const at = (): string => new Date(t0 + (tick++) * 1000).toISOString();
  const note = (type: string, payload: object) => getSessionsRepository().appendRunEvent(runId, type, JSON.stringify(payload), at());
  const view = async () => (await fetchJson(baseUrl, `/api/workflows/${workflowId}/browser/live-view`, { cookie })).body as Record<string, any>;

  before(async () => {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION']) saved[k] = process.env[k];
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secretexample', AWS_SESSION_TOKEN: 'tokenexample', AWS_REGION: 'ap-southeast-1' });
    createTestDb();
    deps.status = async () => (open ? 'READY' : 'TERMINATED');
    deps.stop = async (_b: string, id: string) => { stopped.push(id); open = false; return true; };
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `lv-${Date.now()}@test.com`, name: 'Admin', password: 'password1234', provider: 'demo' } });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `LV-${Date.now()}` }, cookie });
    const projectId = ((p.body as any).project as any).id as string;
    projectIdOf = projectId;
    const w = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: 'Guide', engine: 'demo', start: false }, cookie });
    workflowId = String(((w.body as any).workflow ?? w.body).id);
    runId = `run-lv-${Date.now()}`;
    await getSessionsRepository().createRun({ id: runId, workflow_id: workflowId, status: 'running', started_at: at(), finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: at() });
  });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await cleanup();
  });

  it('is not waiting until the agent says so, and then shows its message', async () => {
    await note('browser-session', { browserId: 'aws.browser.v1', sessionId: 'sess-1', width: 1280, height: 800 });
    let v = await view();
    assert.equal(v.available, true);
    assert.equal(v.waiting, null);
    await note('browser-waiting', { state: 'waiting', message: 'Sign in as an administrator' });
    v = await view();
    assert.deepEqual(v.waiting, { message: 'Sign in as an administrator' });
    assert.match(String(v.url), /^https:\/\/bedrock-agentcore\.ap-southeast-1\.amazonaws\.com\/browser-streams\/aws\.browser\.v1\/sessions\/sess-1\/live-view\?/);
  });

  it('stops waiting when the agent says done, and a new browser session starts without a wait', async () => {
    await note('browser-waiting', { state: 'done', message: 'Signed in.' });
    assert.equal((await view()).waiting, null);
    await note('browser-waiting', { state: 'waiting', message: 'again' });
    assert.deepEqual((await view()).waiting, { message: 'again' });
    await note('browser-session', { browserId: 'aws.browser.v1', sessionId: 'sess-2', width: 1280, height: 800 });
    const v = await view();
    assert.equal(v.sessionId, 'sess-2');
    assert.equal(v.waiting, null, 'a wait belongs to the browser session it was announced in');
  });

  it('the browser of a session can be watched between turns (no run going), until AgentCore says it has ended', async () => {
    const repo = getSessionsRepository();
    await repo.updateRun(runId, { status: 'done', finished_at: at() });
    open = true;
    let v = await view();
    assert.equal(v.available, true, 'the browser stays open after the turn ends');
    assert.equal(v.sessionId, 'sess-2');
    assert.equal(v.waiting, null);
    open = false;
    v = await view();
    assert.equal(v.available, false, 'closed at AgentCore: nothing to watch');
  });

  it('a wait left behind by a turn that ended does not show', async () => {
    open = true;
    await note('browser-waiting', { state: 'waiting', message: 'left behind' });
    assert.equal((await view()).waiting, null);
  });

  it('the next turn reconnects to the browser the last one left, while it is within its lifetime', async () => {
    assert.equal(await resumableBrowserSession(workflowId), 'sess-2');
    const old = new Date(Date.now() - BROWSER_LIFETIME_MS).toISOString();
    const other = await fetchJson(baseUrl, '/api/projects/' + projectIdOf + '/workflows', { method: 'POST', body: { goal: 'Other', engine: 'demo', start: false }, cookie });
    const wid = String(((other.body as any).workflow ?? other.body).id);
    const rid = `run-old-${Date.now()}`;
    await repo().createRun({ id: rid, workflow_id: wid, status: 'done', started_at: old, finished_at: old, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: old });
    await repo().appendRunEvent(rid, 'browser-session', JSON.stringify({ browserId: 'aws.browser.v1', sessionId: 'sess-old' }), old);
    assert.equal(await resumableBrowserSession(wid), null, 'about to expire: start a new one');
  });

  it('closing the browser stops it at AgentCore, and only an editor can', async () => {
    open = true;
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/browser/close`, { method: 'POST', cookie, body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, closed: true });
    assert.deepEqual(stopped, ['sess-2']);
    assert.equal((await view()).available, false);
    const anon = await fetchJson(baseUrl, `/api/workflows/${workflowId}/browser/close`, { method: 'POST', body: {} });
    assert.ok([401, 403].includes(anon.status), String(anon.status));
  });
});
