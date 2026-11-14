/**
 * GET /api/workflows/:wid/browser/live-view tells the page when the agent is waiting for a person to sign in: the latest
 * browser-waiting note of the current browser session says "waiting", and a later "done" (or a new session) clears it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';

describe('live view: the agent is waiting for the person', () => {
  const saved: Record<string, string | undefined> = {};
  let baseUrl = '', cookie = '', workflowId = '', runId = '';
  let tick = 0;
  const at = (): string => new Date(Date.parse('2026-11-14T10:00:00Z') + (tick++) * 1000).toISOString();
  const note = (type: string, payload: object) => getSessionsRepository().appendRunEvent(runId, type, JSON.stringify(payload), at());
  const view = async () => (await fetchJson(baseUrl, `/api/workflows/${workflowId}/browser/live-view`, { cookie })).body as Record<string, any>;

  before(async () => {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION']) saved[k] = process.env[k];
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secretexample', AWS_SESSION_TOKEN: 'tokenexample', AWS_REGION: 'ap-southeast-1' });
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `lv-${Date.now()}@test.com`, name: 'Admin', password: 'password1234', provider: 'demo' } });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `LV-${Date.now()}` }, cookie });
    const projectId = ((p.body as any).project as any).id as string;
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
});
