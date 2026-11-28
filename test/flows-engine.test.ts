/**
 * Running a flow end to end on the demo engine: each step is a child session, a step starts when the steps it waits
 * for are done, the parent's agent is not woken by the steps, and the page API shows the progress. Also the /flow chat
 * command and stopping a flow.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { startFlow, stopFlow, readFlowState } from '../server/flows/engine.ts';
import { validateRecipe } from '../server/flows/recipe.ts';
import { one } from '../server/db.ts';

async function waitFor<T>(fn: () => Promise<T | null | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('flow engine (demo engine)', () => {
  let baseUrl: string;
  let cookie = '';
  let userId = '';
  let projectId = '';

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const r = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST', body: { email: 'flow-admin@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = r.cookie ?? '';
    userId = String((one('SELECT id FROM users WHERE email = ?', 'flow-admin@example.com') as { id: string }).id);
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Flow Test' }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  });

  after(async () => cleanup());

  async function newSession(): Promise<string> {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: 'Parent', engine: 'demo' }, cookie });
    return ((r.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  }

  it('runs a diamond of steps in order and finishes without waking the parent agent', async () => {
    const parentId = await newSession();
    const repo = getSessionsRepository();
    const recipe = validateRecipe({
      name: 'diamond',
      steps: [
        { id: 'a', prompt: 'Step A: {{input}}' },
        { id: 'b', needs: ['a'], prompt: 'Step B after {{steps.a.result}}' },
        { id: 'c', needs: ['a'], prompt: 'Step C after {{steps.a.result}}' },
        { id: 'd', needs: ['b', 'c'], prompt: 'Step D' },
      ],
    }, 'diamond');
    const parent = (await repo.getWorkflowById(parentId))!;
    const started = await startFlow(parent, recipe, 'the input', userId);
    assert.equal(started.status, 'running');
    assert.equal(started.steps.a.status, 'running');
    assert.equal(started.steps.b.status, 'pending');

    const done = await waitFor(async () => {
      const w = await repo.getWorkflowById(parentId);
      const s = w ? readFlowState(w) : null;
      return s && s.status !== 'running' ? s : null;
    });
    assert.equal(done.status, 'done', done.note);
    for (const id of ['a', 'b', 'c', 'd']) assert.equal(done.steps[id].status, 'done', id);
    // Four child sessions, each its own session titled after the flow and step.
    const children = await repo.listChildWorkflows(parentId);
    assert.equal(children.length, 4);
    assert.deepEqual(children.map((c) => c.title).sort(), ['diamond: a', 'diamond: b', 'diamond: c', 'diamond: d']);
    // The steps' results went to the flow, not to the parent's agent as child-result events.
    const unconsumed = await repo.listUnconsumedWorkflowEvents(parentId);
    assert.equal(unconsumed.filter((e) => e.kind === 'child-result').length, 0);

    const page = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${parentId}/flow`, { cookie });
    assert.equal(page.status, 200);
    const flow = (page.body as { flow: { status: string; steps: Array<{ id: string; status: string }> } }).flow;
    assert.equal(flow.status, 'done');
    assert.deepEqual(flow.steps.map((s) => s.status), ['done', 'done', 'done', 'done']);
  });

  it('refuses a second flow while one runs, and stops it', async () => {
    const parentId = await newSession();
    const repo = getSessionsRepository();
    const recipe = validateRecipe({ name: 'slow', steps: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }] }, 'slow');
    const parent = (await repo.getWorkflowById(parentId))!;
    await startFlow(parent, recipe, '', userId);
    await assert.rejects(startFlow(parent, recipe, '', userId), /still running/);
    const stopped = await stopFlow(parentId);
    assert.equal(stopped?.status, 'stopped');
    assert.equal(readFlowState((await repo.getWorkflowById(parentId))!)?.status, 'stopped');
    assert.equal(await stopFlow(parentId), null); // nothing left to stop
    // A flow can start again once the last one ended.
    const again = await startFlow((await repo.getWorkflowById(parentId))!, recipe, '', userId);
    assert.equal(again.status, 'running');
    await stopFlow(parentId);
  });

  it('answers /flow in the chat: empty list, unknown recipe, status', async () => {
    const parentId = await newSession();
    // The demo engine does not take /flow (it answers every "/" itself); a Kiro session does.
    await getSessionsRepository().updateWorkflow(parentId, { engine: 'kiro' });
    const send = async (message: string) => fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${parentId}/message`, { method: 'POST', body: { message }, cookie });
    const lastResult = async (): Promise<string> => {
      const t = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${parentId}/transcript`, { cookie });
      const rows = JSON.stringify(t.body);
      return rows;
    };
    assert.equal((await send('/flow')).status, 200);
    assert.match(await lastResult(), /No recipes yet/);
    assert.equal((await send('/flow run nothing-here')).status, 200);
    assert.match(await lastResult(), /No recipe named \\"nothing-here\\"/);
    assert.equal((await send('/flow status')).status, 200);
    assert.match(await lastResult(), /No flow has run in this session/);
    assert.equal((await send('/flow stop')).status, 200);
    assert.match(await lastResult(), /No flow is running/);
    // Back to demo so the test server does not try to start a Kiro run on teardown.
    await getSessionsRepository().updateWorkflow(parentId, { engine: 'demo' });
  });
});
