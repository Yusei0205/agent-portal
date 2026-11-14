/**
 * A message sent while the agent is mid-turn is saved but not part of that turn (messages are read when a turn starts). When the turn
 * ends, a waiting message from the person starts the next turn by itself.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { continueWithQueuedMessages, queuedDeps } from '../server/workflows/driver.ts';
import { one } from '../server/db.ts';
import { buildConversationRecap } from '../server/agent/recap.ts';

describe('messages that arrive during a turn', () => {
  let baseUrl = '', cookie = '', projectId = '';
  const realStart = queuedDeps.startRun;

  const session = async (): Promise<string> => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', cookie, body: { goal: 'Check the account', engine: 'demo', start: false } });
    return String(((r.body as any).workflow ?? r.body).id);
  };
  const say = (wid: string, kind: string, body: string) => getSessionsRepository().appendWorkflowEvent({ workflow_id: wid, kind, body, data: '{}', created_at: new Date().toISOString() });

  before(async () => {
    createTestDb();
    baseUrl = (await createTestServer()).baseUrl;
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `qm-${Date.now()}@test.com`, name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie ?? '';
    projectId = (((await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `QM-${Date.now()}` }, cookie })).body as any).project as any).id;
  });
  after(async () => { queuedDeps.startRun = realStart; await cleanup(); });

  it('starts the next turn for a waiting message from the person', async () => {
    const wid = await session();
    await say(wid, 'human', 'check at Axrail Chatbot + XACT - Dev account');
    const started: string[] = [];
    queuedDeps.startRun = (async (id: string) => { started.push(id); return 'run-x'; }) as typeof realStart;
    assert.equal(await continueWithQueuedMessages(wid), true);
    assert.deepEqual(started, [wid]);
  });

  it('does nothing when no message is waiting, when only system notes are, or when a turn is already going', async () => {
    const started: string[] = [];
    queuedDeps.startRun = (async (id: string) => { started.push(id); return 'run-x'; }) as typeof realStart;
    const none = await session();
    assert.equal(await continueWithQueuedMessages(none), false);
    await say(none, 'system', 'Session stopped: idle for 30 minutes');
    assert.equal(await continueWithQueuedMessages(none), false);

    const busy = await session();
    await say(busy, 'human', 'wait');
    const repo = getSessionsRepository();
    const t = new Date().toISOString();
    await repo.createRun({ id: `run-busy-${Date.now()}`, workflow_id: busy, status: 'running', started_at: t, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: t });
    assert.equal(await continueWithQueuedMessages(busy), false);
    assert.deepEqual(started, []);
  });

  it('a message already read by a turn is not read again', async () => {
    const wid = await session();
    await say(wid, 'human', 'first');
    const repo = getSessionsRepository();
    const pending = await repo.listUnconsumedWorkflowEvents(wid);
    await repo.markWorkflowEventsConsumedUpTo(wid, pending[pending.length - 1].id);
    queuedDeps.startRun = (async () => { throw new Error('must not start'); }) as typeof realStart;
    assert.equal(await continueWithQueuedMessages(wid), false);
  });

  it('end to end: a message sent during a turn is answered by the next turn, started by the portal', async () => {
    queuedDeps.startRun = realStart;
    const wid = await session();
    const post = (path: string, body: object = {}) => fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}/${path}`, { method: 'POST', cookie, body });
    await post('message', { message: 'first request' });
    const s1 = await post('start');
    assert.ok([200, 201].includes(s1.status), JSON.stringify(s1.body));
    // Wait until the first turn has read its message (it is under way), then send the second one into the running turn.
    for (let i = 0; i < 4000; i++) {
      if (!(await getSessionsRepository().listUnconsumedWorkflowEvents(wid)).some((e) => e.kind === 'human')) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    // A second message while the first turn is running: the start call answers "already running".
    await post('message', { message: 'the evidence is in the other account' });
    const s2 = await post('start');
    const repo = getSessionsRepository();
    // Wait until every message was read: the portal started the second turn itself.
    const deadline = Date.now() + 60_000;
    let runs = 0;
    while (Date.now() < deadline) {
      runs = (await repo.listRunsByWorkflow(wid, 20)).length;
      const waiting = (await repo.listUnconsumedWorkflowEvents(wid)).filter((e) => e.kind === 'human');
      const active = await repo.getActiveRun(wid);
      if (!waiting.length && !active && runs >= 2) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const dbg = (await repo.listRunsByWorkflow(wid, 20)).map((r) => `${r.status}@${String(r.started_at).slice(11, 23)}`).join(',') + ' | unread=' + (await repo.listUnconsumedWorkflowEvents(wid)).map((e) => e.kind).join(',') + ' | s1=' + JSON.stringify(s1.body).slice(0, 60);
    assert.ok(runs >= 2, `${dbg}; two turns ran (the second one started by the portal); second start said ${JSON.stringify(s2.body).slice(0, 120)}; runs=${runs}`);
    assert.equal((await repo.listUnconsumedWorkflowEvents(wid)).filter((e) => e.kind === 'human').length, 0, 'nothing is left unread');
  });

  it('an interrupt (Esc, Ctrl+C, Stop) leaves the session ready: nothing to reopen, and the next message goes on in it', async () => {
    queuedDeps.startRun = realStart;
    const wid = await session();
    const repo = getSessionsRepository();
    const t = new Date().toISOString();
    await repo.updateWorkflow(wid, { status: 'running' });
    const runX = `run-int-${Date.now()}`;
    await repo.createRun({ id: runX, workflow_id: wid, status: 'running', started_at: t, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: t });
    const base = `/api/projects/${projectId}/workflows/${wid}`;
    assert.equal((await fetchJson(baseUrl, `${base}/cancel`, { method: 'POST', cookie, body: { source: 'shortcut' } })).status, 200);
    const audited = one<{ details: string }>(`SELECT detail AS details FROM audit_log WHERE action = 'session.interrupt' AND target = ? ORDER BY rowid DESC LIMIT 1`, `workflow:${wid}`);
    assert.match(String(audited?.details), /"source":"shortcut"/, 'the stop is recorded with where it came from');
    // The turn ends (the runner records it as cancelled).
    await repo.updateRun(runX, { status: 'cancelled', finished_at: new Date().toISOString() });
    const view = ((await fetchJson(baseUrl, base, { cookie })).body as any).workflow;
    assert.equal(view.status, 'paused');
    assert.equal(view.stop_reason, 'interrupted');
    assert.equal(view.resumable, false, 'no "Reopen this conversation" step after an interrupt');
    // The next message goes straight on: a new turn starts.
    const sent = await fetchJson(baseUrl, `${base}/message`, { method: 'POST', cookie, body: { message: 'carry on with the report' } });
    assert.equal((sent.body as any).resumed, true);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (await repo.listRunsByWorkflow(wid, 10)).length < 2) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await repo.listRunsByWorkflow(wid, 10)).length, 2);
    assert.equal(((await fetchJson(baseUrl, base, { cookie })).body as any).workflow.stop_reason === 'interrupted', false, 'the next message cleared it');
  });

  it('a message sent while an interrupted turn is still ending starts the next turn when it has ended', async () => {
    queuedDeps.startRun = realStart;
    const wid = await session();
    const repo = getSessionsRepository();
    await say(wid, 'human', 'sent right after Esc');
    // The runner's end of an interrupted turn asks for the queued message to be started.
    assert.equal(await continueWithQueuedMessages(wid), true);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (await repo.listRunsByWorkflow(wid, 10)).length < 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await repo.listRunsByWorkflow(wid, 10)).length, 1);
  });

  it('a turn the person interrupted is part of what the next turn is told (the request and what the agent had said so far)', async () => {
    const wid = await session();
    const repo = getSessionsRepository();
    const t = (n: number) => new Date(Date.now() - 600_000 + n * 1000).toISOString();
    // Turn 1 completes; turn 2 is interrupted part-way; the person's next message is turn 3.
    await repo.appendWorkflowEvent({ workflow_id: wid, kind: 'human', body: 'Scan the repo for hard-coded secrets', data: '{}', created_at: t(1) });
    await repo.createRun({ id: 'r-done', workflow_id: wid, status: 'done', started_at: t(2), finished_at: t(10), cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: t(2) });
    await repo.appendRunEvent('r-done', 'run-complete', JSON.stringify({ result: 'Found 3 candidates in config/.' }), t(10));
    await repo.appendWorkflowEvent({ workflow_id: wid, kind: 'human', body: 'Now write the summary report for each finding', data: '{}', created_at: t(20) });
    await repo.createRun({ id: 'r-int', workflow_id: wid, status: 'cancelled', started_at: t(21), finished_at: t(40), cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: t(21) });
    await repo.appendRunEvent('r-int', 'assistant-text', JSON.stringify({ text: 'Starting the report with finding 1 (config/prod.env)' }), t(30));
    await repo.appendRunEvent('r-int', 'run-failed', JSON.stringify({ error: 'Cancelled' }), t(40));
    await repo.createRun({ id: 'r-next', workflow_id: wid, status: 'running', started_at: t(50), finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: t(50) });
    const recap = await buildConversationRecap(wid, 'r-next');
    assert.match(recap, /Scan the repo for hard-coded secrets/);
    assert.match(recap, /Found 3 candidates/);
    assert.match(recap, /Now write the summary report for each finding/, 'the request that was interrupted is not forgotten');
    assert.match(recap, /Starting the report with finding 1/, 'nor what the agent had said so far');
    assert.match(recap, /stopped before it finished/);
  });
});
