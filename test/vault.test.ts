import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';

let srv: TestServer;
let ann: Client;
let bob: Client;
let pid: string;
let projectRoot: string;

before(async () => {
  srv = await bootServer();
  ann = new Client(srv.base);
  bob = new Client(srv.base);
  await ann.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  await ann.post('/api/users', { email: 'b@example.com', name: 'Bob', password: 'a-long-password-2' });
  await bob.post('/api/auth/login', { email: 'b@example.com', password: 'a-long-password-2' });
  const { project } = await ann.post('/api/projects', { name: 'Vaulted', description: 'd' });
  pid = project.id;
  projectRoot = path.join(srv.dataDir, 'projects', project.slug);
});

after(() => srv.close());

const up = (c: Client, scope: string, p: string, text: string) => c.req('PUT', `/api/vault/file?scope=${scope}&path=${encodeURIComponent(p)}`, undefined, { raw: Buffer.from(text) });

test('your vault is yours; the team vault is everyone’s; paths stay inside', async () => {
  assert.equal((await up(ann, 'mine', 'templates/report.md', '# Report')).status, 200);
  assert.equal((await up(bob, 'team', 'glossary.md', 'Refund: money back')).status, 200);
  const mine = (await ann.get('/api/vault?scope=mine')).files.map((f: any) => f.path);
  assert.deepEqual(mine, ['templates', 'templates/report.md']);
  assert.deepEqual((await bob.get('/api/vault?scope=mine')).files, [], 'Bob does not see Ann’s vault');
  assert.deepEqual((await ann.get('/api/vault?scope=team')).files.map((f: any) => f.path), ['glossary.md']);
  const dl = await ann.req('GET', `/api/vault/download?scope=mine&path=${encodeURIComponent('templates/report.md')}`);
  assert.equal(dl.buf!.toString(), '# Report');
  for (const bad of ['../escape.md', 'a/../../b.md', '', 'x/./y.md']) assert.equal((await up(ann, 'mine', bad, 'x')).status, 400, `refused: ${bad}`);
  assert.equal((await ann.req('GET', '/api/vault?scope=everyone')).status, 400);
  assert.equal((await ann.req('DELETE', `/api/vault/file?scope=mine&path=${encodeURIComponent('templates')}`)).status, 200);
  assert.deepEqual((await ann.get('/api/vault?scope=mine')).files, []);
});

test('a run gets copies of the team vault and of its owner’s vault in its folder', async () => {
  await up(ann, 'mine', 'notes/mine.txt', 'only Ann');
  const { run } = await ann.post(`/api/projects/${pid}/runs`, { prompt: 'Read the vault', permissionMode: 'plan' });
  await waitFor(async () => {
    const r = await ann.get(`/api/runs/${run.id}`);
    return ['completed', 'failed', 'waiting'].includes(r.run.status) ? r : null;
  }, 'run');
  const work = path.join(projectRoot, 'work', run.id, 'vault');
  assert.equal(fs.readFileSync(path.join(work, 'mine', 'notes', 'mine.txt'), 'utf8'), 'only Ann');
  assert.equal(fs.readFileSync(path.join(work, 'team', 'glossary.md'), 'utf8'), 'Refund: money back');
  // A run of Bob's gets the team vault but not Ann's.
  await ann.post(`/api/projects/${pid}/members`, { email: 'b@example.com', access: 'editor', role: 'Dev' });
  const { run: bobRun } = await bob.post(`/api/projects/${pid}/runs`, { prompt: 'Read', permissionMode: 'plan' });
  await waitFor(async () => {
    const r = await bob.get(`/api/runs/${bobRun.id}`);
    return ['completed', 'failed', 'waiting'].includes(r.run.status) ? r : null;
  }, 'Bob’s run');
  assert.ok(!fs.existsSync(path.join(projectRoot, 'work', bobRun.id, 'vault', 'mine')));
  assert.ok(fs.existsSync(path.join(projectRoot, 'work', bobRun.id, 'vault', 'team', 'glossary.md')));
});
