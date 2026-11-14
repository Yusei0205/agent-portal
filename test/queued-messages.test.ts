/**
 * A message sent while the agent is mid-turn is saved but not part of that turn (messages are read when a turn starts). When the turn
 * ends, a waiting message from the person starts the next turn by itself.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { continueWithQueuedMessages, queuedDeps } from '../server/workflows/driver.ts';

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
});
