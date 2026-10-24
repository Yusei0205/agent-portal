// Delegated sessions: hand-off through the status line, waiting for a child, and delegating by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor, Client, type TestServer } from './client.ts';
import { bootWorkflowFixture, settleSession, type WorkflowFixture } from './workflows-fixture.ts';

let srv: TestServer;
let admin: Client;
let viewer: Client;
let pid: string;
let exec: WorkflowFixture['exec'];

before(async () => {
  ({ srv, admin, viewer, pid, exec } = await bootWorkflowFixture());
});

after(async () => {
  await srv.close();
});

const settle = (id: string, wanted?: string[]) => settleSession(admin, id, wanted);
const create = (body: Record<string, unknown>) => admin.post(`/api/projects/${pid}/workflows`, { model: 'haiku', playground: true, ...body });

test('a session delegates, waits for its child, then carries on to bring the work together', async () => {
  const { workflow } = await create({ goal: 'Split it [demo-delegate: backend] [demo-iterations: 1]' });
  const parent = await waitFor(async () => {
    const d = await admin.get(`/api/workflows/${workflow.id}`);
    return d.workflow.status === 'done' && !d.driving ? d : null;
  }, 'parent done after its child', 60_000);
  assert.equal(parent.workflow.children.length, 1);
  const childId = parent.workflow.children[0].id;
  const child = (await admin.get(`/api/workflows/${childId}`)).workflow;
  assert.equal(child.title, 'backend');
  assert.equal(child.status, 'done');
  assert.equal(child.parent.id, workflow.id);
  assert.equal(child.depth, 1);
  const kinds = parent.events.map((e: any) => `${e.kind}:${e.body}`).join('\n');
  assert.match(kinds, /delegate:The agents handed "backend" to a separate session/);
  assert.match(kinds, /Waiting for 1 delegated session/);
  assert.match(kinds, /delegate:Delegated session "backend" finished/);
  assert.match(kinds, /carries on to bring their work together/);
  const lastRun = (await admin.get(`/api/runs/${parent.workflow.last_run_id}`)).run;
  assert.match(lastRun.prompt, /## Delegated sessions\n.*\n- backend: done \(new since the last iteration\)/, 'the parent reads what its child did');
  assert.ok(!(await admin.get(`/api/workflows/${childId}`)).workflow.children.length, 'a delegated session cannot delegate further by default');
});

test('people can delegate too, within the limits in Settings', async () => {
  const { workflow } = await create({ goal: 'Parked parent', start: false });
  await admin.put('/api/settings', { delegation: { maxPerParent: 1 } });
  const { workflow: child } = await admin.post(`/api/workflows/${workflow.id}/delegate`, { title: 'Docs', goal: 'Write the docs [demo-stuck]' });
  assert.equal(child.parent.id, workflow.id);
  // Demo sessions finish at once in tests; mark the child as still running to check the limit.
  await settle(child.id);
  exec("UPDATE workflows SET status = 'running' WHERE id = ?", child.id);
  const second = await admin.req('POST', `/api/workflows/${workflow.id}/delegate`, { goal: 'More' });
  assert.equal(second.status, 400);
  assert.match(second.data.error, /1 delegated sessions of this one are running already/);
  assert.equal((await viewer.req('POST', `/api/workflows/${workflow.id}/delegate`, { goal: 'x' })).status, 403);
  await admin.post(`/api/workflows/${child.id}/stop`);
  await admin.put('/api/settings', { delegation: { enabled: false } });
  assert.match((await admin.req('POST', `/api/workflows/${workflow.id}/delegate`, { goal: 'x' })).data.error, /turned off/);
  await admin.put('/api/settings', { delegation: { enabled: true, maxPerParent: 3 } });
  // Deleting the parent leaves the child, on its own.
  await admin.del(`/api/workflows/${workflow.id}`);
  assert.equal((await admin.get(`/api/workflows/${child.id}`)).workflow.parent, null);
});

test('delegated sessions inherit playground flag from parent', async () => {
  const pg = await create({ goal: 'Parent playground [demo-delegate: backend] [demo-iterations: 1]', playground: true });
  const parent = await waitFor(async () => {
    const d = await admin.get(`/api/workflows/${pg.workflow.id}`);
    return d.workflow.status === 'done' && !d.driving && d.workflow.children.length > 0 ? d : null;
  }, 'parent with child', 30_000);
  const child = (await admin.get(`/api/workflows/${parent.workflow.children[0].id}`)).workflow;
  assert.equal(child.playground, true, 'child inherits playground from parent');
  assert.equal(child.push_mode, 'never', 'playground child stays never push');
});
