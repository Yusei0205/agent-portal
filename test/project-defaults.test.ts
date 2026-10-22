/** Project defaults for new work: the lead agent and model new sessions and runs start with. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;
let pid: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'defaults@example.com', name: 'Admin', password: 'a-very-long-test-password' });
  pid = (await admin.post('/api/projects', { name: 'Defaults project', description: 'x' })).project.id;
});
after(() => srv.close());

test('a new project has no defaults', async () => {
  const { project } = await admin.get(`/api/projects/${pid}`);
  assert.equal(project.default_lead_agent, '');
  assert.equal(project.default_model, '');
});

test('defaults are saved, returned and cleared', async () => {
  const { project } = await admin.patch(`/api/projects/${pid}`, { defaultLeadAgent: 'lead-agent', defaultModel: 'claude-opus-5.5' });
  assert.equal(project.default_lead_agent, 'lead-agent');
  assert.equal(project.default_model, 'claude-opus-5.5');
  assert.equal((await admin.get(`/api/projects/${pid}`)).project.default_model, 'claude-opus-5.5');
  // Other fields are untouched by a defaults-only change.
  assert.equal((await admin.get(`/api/projects/${pid}`)).project.name, 'Defaults project');
  const cleared = await admin.patch(`/api/projects/${pid}`, { defaultLeadAgent: '', defaultModel: '' });
  assert.equal(cleared.project.default_lead_agent, '');
  assert.equal(cleared.project.default_model, '');
});

test('bad names and model IDs are refused', async () => {
  assert.equal((await admin.req('PATCH', `/api/projects/${pid}`, { defaultLeadAgent: '../etc' })).status, 400);
  assert.equal((await admin.req('PATCH', `/api/projects/${pid}`, { defaultModel: 'bad model id' })).status, 400);
});
