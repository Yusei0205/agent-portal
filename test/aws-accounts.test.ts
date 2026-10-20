import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootServer, Client, type TestServer } from './client.ts';

// Loaded after the test server has set its temporary data folder (see test/jira.test.ts).
let exec: typeof import('../server/db.ts').run;
let profileFromUrl: typeof import('../server/aws-accounts.ts').profileFromUrl;

let srv: TestServer;
let admin: Client;
let editor: Client;
let viewer: Client;
let a: string; // project with its own keys
let b: string; // project on the Settings credentials
let c: string; // project the editor cannot reach
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awsacct-'));
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['PORTAL_AWS_BIN', 'PORTAL_AWS_BIN_ARGS', 'AWS_ACCESS_KEY_ID'];

// A stand-in for `aws sts get-caller-identity`: the account depends on who is asking.
const FAKE_AWS = path.join(tmp, 'fake-aws.cjs');
fs.writeFileSync(
  FAKE_AWS,
  `const key = process.env.AWS_ACCESS_KEY_ID || '';
const profile = process.env.AWS_PROFILE || '';
let account = '999988887777';
if (key === 'AKIAPROJECTAAAAAAAA1') account = '111122223333';
if (profile === 'shared') account = '111122223333';
if (profile === 'broken') { console.error('The config profile (broken) could not be found'); process.exit(255); }
console.log(JSON.stringify({ UserId: 'AIDAEXAMPLE', Account: account, Arn: 'arn:aws:iam::' + account + ':user/dev' }));
`,
);

before(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PORTAL_AWS_BIN = process.execPath;
  process.env.PORTAL_AWS_BIN_ARGS = JSON.stringify([FAKE_AWS]);
  delete process.env.AWS_ACCESS_KEY_ID;
  srv = await bootServer();
  ({ run: exec } = await import('../server/db.ts'));
  ({ profileFromUrl } = await import('../server/aws-accounts.ts'));
  admin = new Client(srv.base);
  editor = new Client(srv.base);
  viewer = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'e@example.com', name: 'Eddie', password: 'a-long-password-2' });
  await admin.post('/api/users', { email: 'v@example.com', name: 'Vic', password: 'a-long-password-3' });
  await editor.post('/api/auth/login', { email: 'e@example.com', password: 'a-long-password-2' });
  await viewer.post('/api/auth/login', { email: 'v@example.com', password: 'a-long-password-3' });
  a = (await admin.post('/api/projects', { name: 'Client A', description: 'd' })).project.id;
  b = (await admin.post('/api/projects', { name: 'Client B', description: 'd' })).project.id;
  c = (await admin.post('/api/projects', { name: 'Client C', description: 'd' })).project.id;
  await admin.post(`/api/projects/${a}/members`, { email: 'e@example.com', access: 'editor', role: 'Developer' });
  await admin.post(`/api/projects/${b}/members`, { email: 'e@example.com', access: 'editor', role: 'Developer' });
  await admin.post(`/api/projects/${b}/members`, { email: 'v@example.com', access: 'viewer', role: 'Reader' });
  await admin.put(`/api/projects/${a}/aws`, { auth: 'keys', region: 'eu-west-1', accessKeyId: 'AKIAPROJECTAAAAAAAA1', secretAccessKey: 'project-a-secret-key-0123456789' });
  const repo = (id: string, pid: string, name: string, url: string) =>
    exec('INSERT INTO repos (id, project_id, name, slug, provider, url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, pid, name, name, 'codecommit', url, 'ready', new Date().toISOString());
  repo('g_a1', a, 'ledger', 'https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/ledger');
  repo('g_b1', b, 'portal', 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/portal');
  repo('g_b2', b, 'shared-lib', 'codecommit::ap-southeast-1://shared@shared-lib');
  repo('g_c1', c, 'secret-c', 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/secret-c');
});

after(async () => {
  await srv.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const groupOf = (groups: any[], repoId: string) => groups.find((g) => g.repos.some((r: any) => r.id === repoId));

test('the profile named in a CodeCommit address is recognised', () => {
  assert.equal(profileFromUrl('codecommit::ap-southeast-1://shared@repo'), 'shared');
  assert.equal(profileFromUrl('codecommit://client-b-admin@repo'), 'client-b-admin');
  assert.equal(profileFromUrl('https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/x'), null);
});

test('repositories are grouped by the credentials they use, before anything has been checked', async () => {
  const { groups } = await admin.get('/api/aws/accounts');
  const own = groupOf(groups, 'g_a1');
  const settings = groupOf(groups, 'g_b1');
  const profile = groupOf(groups, 'g_b2');
  assert.ok(own && settings && profile);
  assert.notEqual(own.id, settings.id, "a project's own keys are not the Settings credentials");
  assert.notEqual(profile.id, settings.id, 'a repository that names a profile is grouped by that profile');
  assert.equal(profile.repos[0].viaAddress, 'shared');
  assert.equal(settings.bedrock, true, 'the Settings credentials are the Bedrock ones');
  assert.ok(groupOf(groups, 'g_c1'), 'admins see every project');
  assert.equal(own.accountId, null, 'nothing is known until a check is run');
});

test('checking asks AWS which account the credentials belong to, and credentials of one account are shown together', async () => {
  const k1 = await admin.post('/api/aws/check', { key: `project:${a}` });
  assert.equal(k1.account, '111122223333');
  const k2 = await admin.post('/api/aws/check', { key: 'profile:shared' });
  assert.equal(k2.account, '111122223333');
  const k3 = await admin.post('/api/aws/check', { key: 'settings' });
  assert.equal(k3.account, '999988887777');
  const { groups } = await admin.get('/api/aws/accounts');
  const together = groupOf(groups, 'g_a1');
  assert.equal(together.id, 'acct:111122223333');
  assert.ok(together.repos.some((r: any) => r.id === 'g_b2'), 'the profile in the address reaches the same account as project A');
  assert.equal(together.sources.length, 2);
  assert.deepEqual(together.projects.map((p: any) => p.name).sort(), ['Client A', 'Client B']);
  const settings = groupOf(groups, 'g_b1');
  assert.equal(settings.accountId, '999988887777');
  assert.equal(settings.bedrock, true);
  assert.ok(!JSON.stringify(groups).includes('project-a-secret-key'), 'no secret is ever returned');
});

test('a profile that does not work reports the reason and changes nothing', async () => {
  exec('INSERT INTO repos (id, project_id, name, slug, provider, url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'g_b3', b, 'bad', 'bad', 'codecommit', 'codecommit://broken@bad', 'ready', new Date().toISOString());
  const r = await admin.req('POST', '/api/aws/check', { key: 'profile:broken' });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /could not be found/);
  const { groups } = await admin.get('/api/aws/accounts');
  assert.equal(groupOf(groups, 'g_b3').accountId, null);
});

test('people only see their own projects and may only check what they can edit', async () => {
  const mine = await editor.get('/api/aws/accounts');
  const text = JSON.stringify(mine.groups);
  assert.ok(!text.includes('secret-c') && !text.includes('Client C'), 'a project you are not on is not listed');
  assert.ok(groupOf(mine.groups, 'g_a1') && groupOf(mine.groups, 'g_b1'));
  assert.equal((await editor.req('POST', '/api/aws/check', { key: 'settings' })).status, 403, 'only admins check the Settings credentials');
  assert.equal((await editor.req('POST', '/api/aws/check', { key: `project:${c}` })).status, 403, 'a project you are not on cannot be checked');
  assert.equal((await editor.post('/api/aws/check', { key: `project:${a}` })).account, '111122223333', 'an editor can check their project');
  assert.equal((await editor.post('/api/aws/check', { key: 'profile:shared' })).account, '111122223333');

  const theirs = await viewer.get('/api/aws/accounts');
  assert.ok(groupOf(theirs.groups, 'g_b1'));
  assert.ok(!groupOf(theirs.groups, 'g_a1'), 'a viewer of project B does not see project A');
  assert.equal((await viewer.req('POST', '/api/aws/check', { key: 'profile:shared' })).status, 403, 'a viewer cannot use a profile');
  assert.equal((await viewer.req('POST', '/api/aws/check', { key: `project:${b}` })).status, 403);
  assert.equal((await editor.req('POST', '/api/aws/check', { key: 'nonsense' })).status, 400);
  const sets = theirs.groups.flatMap((g: any) => g.sources).find((s: any) => s.key === 'settings');
  assert.ok(!sets || sets.canCheck === false);
  assert.ok(!/Access keys|profile /i.test(sets?.how ?? ''), 'how the Settings credentials sign in is only shown to admins');
});

test('a project that gets its own account moves to its own group', async () => {
  await admin.put(`/api/projects/${b}/aws`, { auth: 'keys', region: 'us-east-1', accessKeyId: 'AKIAPROJECTBBBBBBBB1', secretAccessKey: 'project-b-secret-key-0123456789' });
  const { groups } = await admin.get('/api/aws/accounts');
  const g = groupOf(groups, 'g_b1');
  assert.ok(g.sources.some((s: any) => s.key === `project:${b}`));
  assert.equal(g.bedrock, false, 'Bedrock stays with the Settings credentials');
});
