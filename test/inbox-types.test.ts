import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;
let pid: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  pid = (await admin.post('/api/projects', { name: 'Inbox', description: 'd' })).project.id;
  const { createInput } = await import('../server/agent/runner.ts');
  createInput({ projectId: pid, runId: null, type: 'approval', toolName: 'Bash', payload: { input: { command: 'gh api x' } }, userId: null });
  createInput({ projectId: pid, runId: null, type: 'question', toolName: null, payload: { source: 'qa', questions: [{ question: 'Which region?', header: 'Q', options: [], multiSelect: false }] }, userId: null });
});

after(async () => {
  await srv.close();
});

test('tool permission requests are not listed as open questions and are counted separately', async () => {
  const all = (await admin.get(`/api/projects/${pid}/inputs`)).inputs;
  assert.equal(all.length, 2, 'without a filter both kinds are returned');
  const questions = (await admin.get(`/api/projects/${pid}/inputs?type=question`)).inputs;
  assert.deepEqual(questions.map((i: any) => i.type), ['question']);
  const approvals = (await admin.get(`/api/projects/${pid}/inputs?type=approval`)).inputs;
  assert.deepEqual(approvals.map((i: any) => i.type), ['approval']);
  const list = (await admin.get('/api/projects')).projects.find((p: any) => p.id === pid);
  assert.equal(list.open_questions, 1, 'the question count leaves out permission requests');
  assert.equal(list.pending_approvals, 1);
  const one = (await admin.get(`/api/projects/${pid}`)).counts;
  assert.equal(one.open_questions, 1);
  assert.equal(one.pending_approvals, 1);
});
