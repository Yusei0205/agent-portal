/**
 * One execution model: a single run is a session whose max_iterations is 1.
 *
 * Covers the launcher's "Single run" through POST /api/projects/:pid/workflows { singleRun: true }, its approval choice
 * (permissionMode), follow-ups (an instruction re-opens the session), failure, the Inbox for an attended run's
 * approvals, the legacy run lookup, and the verification-step flag name (`required`, never `failStop`).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, waitFor, startSingleRun, startSingleRunReq, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;
let pid: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'admin@single.test', name: 'Admin', password: 'long-password-1' });
  pid = (await admin.post('/api/projects', { name: 'Single run', description: 'd' })).project.id;
});

after(() => srv.close());

const workflowOf = async (id: string) => (await admin.get(`/api/workflows/${id}`)).workflow;
const settled = (id: string) =>
  waitFor(async () => {
    const w = await workflowOf(id);
    return ['done', 'failed', 'blocked', 'paused', 'stopped'].includes(w.status) ? w : null;
  }, 'the session to settle');

test('a single run is a session with one iteration that finishes as done', async () => {
  const { workflow, run } = await startSingleRun(admin, pid, { prompt: 'Write a short summary of the refund policy', permissionMode: 'acceptEdits' });
  assert.equal(workflow.max_iterations, 1);
  assert.equal(workflow.single_run, true);
  assert.equal(workflow.permission_mode, 'acceptEdits');
  assert.equal(workflow.push_mode, 'never', 'a single run is pushed by a person from its Changes tab');
  assert.equal(run.workflow_id, workflow.id, 'the agent run belongs to the session');
  assert.equal(run.title, 'Write a short summary of the refund policy', 'the run keeps the plain title');

  const w = await settled(workflow.id);
  assert.equal(w.status, 'done', w.stop_reason);
  assert.equal(w.iteration, 1);
  assert.ok(w.summary, 'the reply is kept as the session summary');

  const detail = await admin.get(`/api/workflows/${workflow.id}`);
  assert.equal(detail.runs.length, 1);
  const r = (await admin.get(`/api/runs/${run.id}`)).run;
  assert.equal(r.status, 'completed');
  assert.doesNotMatch(r.prompt, /WORKFLOW_STATUS/, 'a single run is not asked for a status line');
  assert.match(r.prompt, /single run/);
  assert.match(r.prompt, /refund policy/);

  const standalone = (await admin.get(`/api/projects/${pid}/runs?standalone=1&kind=chat`)).runs;
  assert.ok(!standalone.some((x: any) => x.id === run.id), 'a session iteration is not a standalone run');
  const all = (await admin.get(`/api/projects/${pid}/runs?kind=chat`)).runs;
  assert.ok(all.some((x: any) => x.id === run.id && x.workflow_id === workflow.id));
});

test('an attended single run asks for approval, and the Inbox lists it under its session', async () => {
  const { workflow, run } = await startSingleRun(admin, pid, { prompt: 'Design and build the refund approval flow' });
  assert.equal(workflow.permission_mode, 'default', 'without a choice the portal default applies');
  const q = await waitFor(async () => (await admin.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.type === 'question' && i.status === 'pending'), 'question');

  const inbox = await admin.get('/api/inbox');
  const item = inbox.items.find((i: any) => i.kind === 'waiting' && i.workflowId === workflow.id);
  assert.ok(item, 'the pending question is listed with the id of its session');
  assert.equal(item.sessionTitle, workflow.title);

  await admin.post(`/api/workflows/${workflow.id}/stop`);
  const w = await settled(workflow.id);
  assert.equal(w.status, 'stopped');
  const left = (await admin.get(`/api/projects/${pid}/inputs`)).inputs.filter((i: any) => i.id === q.id && i.status === 'pending');
  assert.equal(left.length, 0, 'stopping the session cancels the waiting question');
});

test('an instruction re-opens a finished single run and its next iteration continues the conversation', async () => {
  const { workflow, run } = await startSingleRun(admin, pid, { prompt: 'Write a short summary of the refund policy', permissionMode: 'acceptEdits' });
  assert.equal((await settled(workflow.id)).status, 'done');
  await admin.post(`/api/workflows/${workflow.id}/messages`, { body: 'Now add the exceptions' });
  const second = await waitFor(async () => {
    const w = await workflowOf(workflow.id);
    return w.last_run_id && w.last_run_id !== run.id ? w : null;
  }, 'the follow-up iteration');
  assert.equal(second.iteration, 2);
  const w = await settled(workflow.id);
  assert.equal(w.status, 'done', 'a single run stays a single pass each time it is re-opened');
  const follow = (await admin.get(`/api/runs/${w.last_run_id}`)).run;
  assert.equal(follow.resume_of, run.id);
  assert.match(follow.prompt, /exceptions/);
});

test('a single run that fails ends as failed, with the error', async () => {
  await admin.put('/api/settings', { provider: { mode: 'anthropic' } });
  try {
    const r = await startSingleRunReq(admin, pid, { prompt: 'Build it' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const w = await settled(r.data.workflow.id);
    assert.equal(w.status, 'failed');
    assert.match(w.stop_reason, /Anthropic API key/);
  } finally {
    await admin.put('/api/settings', { provider: { mode: 'demo' } });
  }
});

test('a single run needs a prompt, a viewer cannot start one, and the sessions and runs routes agree', async () => {
  assert.equal((await startSingleRunReq(admin, pid, { prompt: '   ' })).status, 400);
  assert.equal((await startSingleRunReq(admin, pid, { prompt: 'x', permissionMode: 'sometimes' })).status, 400);
  assert.ok([404, 405].includes((await admin.req('POST', `/api/projects/${pid}/runs`, { prompt: 'x' })).status), 'the old start-a-run route is gone');

  await admin.post('/api/users', { email: 'viewer@single.test', name: 'Viewer', password: 'long-password-2' });
  await admin.post(`/api/projects/${pid}/members`, { email: 'viewer@single.test', access: 'viewer' });
  const viewer = new Client(srv.base);
  await viewer.post('/api/auth/login', { email: 'viewer@single.test', password: 'long-password-2' });
  assert.equal((await startSingleRunReq(viewer, pid, { prompt: 'x' })).status, 403);

  const { workflow, run } = await startSingleRun(admin, pid, { prompt: 'Write a short summary of the refund policy', permissionMode: 'acceptEdits' });
  await settled(workflow.id);
  const stop = await admin.req('POST', `/api/runs/${run.id}/stop`, {});
  assert.equal(stop.status, 400, 'a session’s run is stopped through its session');
  assert.match(stop.data.error, /stop the session/);
});

test('a full session is unchanged: it can run more than one iteration', async () => {
  const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, { goal: 'Add a refund limit check [demo-iterations: 2]', playground: true });
  assert.equal(workflow.single_run, false);
  const w = await waitFor(async () => {
    const x = await workflowOf(workflow.id);
    return x.status === 'done' ? x : null;
  }, 'the session to finish');
  assert.equal(w.iteration, 2);
});

test('verification steps use one flag name: required', async () => {
  const step = { step: 'lint', cmd: 'npm run lint', timeout: 60 };
  const ok = await admin.post(`/api/projects/${pid}/loop-specs`, {
    name: 'Flag name',
    triggerKind: 'manual',
    goalTemplate: 'Do the thing',
    verification: [{ ...step, required: false }, { step: 'test', cmd: 'npm test' }],
  });
  const saved = ok.spec.verification;
  assert.equal(saved[0].required, false);
  assert.equal(saved[1].required, true, 'required is the default');
  assert.ok(saved.every((s: any) => !('failStop' in s)));

  const old = await admin.req('POST', `/api/projects/${pid}/loop-specs`, {
    name: 'Old flag',
    triggerKind: 'manual',
    goalTemplate: 'x',
    verification: [{ ...step, failStop: false }],
  });
  assert.equal(old.status, 400);
  assert.match(old.data.error, /required/);
});
