import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootServer, Client, type TestServer } from './client.ts';

// AWS accounts are set up once on the AWS accounts page, then picked by projects.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awsconn-'));
const FAKE_AWS = path.join(tmp, 'fake-aws.cjs');
fs.writeFileSync(
  FAKE_AWS,
  `const fs = require('fs');
const seen = {};
for (const [k, v] of Object.entries(process.env)) if (/^AWS_/.test(k)) seen[k] = v;
fs.writeFileSync(process.env.FAKE_AWS_OUT, JSON.stringify(seen));
const acct = process.env.AWS_PROFILE === 'team-b' ? '222233334444' : '111122223333';
console.log(JSON.stringify({ UserId: 'AIDA', Account: acct, Arn: 'arn:aws:iam::' + acct + ':user/dev' }));
`,
);
process.env.PORTAL_AWS_BIN = process.execPath;
process.env.PORTAL_AWS_BIN_ARGS = JSON.stringify([FAKE_AWS]);
process.env.FAKE_AWS_OUT = path.join(tmp, 'seen.json');
process.env.PORTAL_SDK_MODULE = pathToFileURL(path.join(import.meta.dirname, 'fake-sdk.mjs')).href;
const seen = () => JSON.parse(fs.readFileSync(process.env.FAKE_AWS_OUT!, 'utf8'));
const sdkEnv = () => ((globalThis as any).__fakeSdkCalls as any[]).at(-1).options.env;

let srv: TestServer;
let admin: Client;
let owner: Client;
let pid: string;
let projectAwsEnv: typeof import('../server/project-aws.ts').projectAwsEnv;
let adopt: typeof import('../server/aws-connections.ts').adoptProjectCredentials;
let exec: typeof import('../server/db.ts').run;
let setSecret: typeof import('../server/secrets.ts').setSecret;

before(async () => {
  srv = await bootServer();
  ({ projectAwsEnv } = await import('../server/project-aws.ts'));
  ({ adoptProjectCredentials: adopt } = await import('../server/aws-connections.ts'));
  ({ run: exec } = await import('../server/db.ts'));
  ({ setSecret } = await import('../server/secrets.ts'));
  admin = new Client(srv.base);
  owner = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'o@example.com', name: 'Olive', password: 'a-long-password-2' });
  await owner.post('/api/auth/login', { email: 'o@example.com', password: 'a-long-password-2' });
  pid = (await admin.post('/api/projects', { name: 'Payments', description: 'd' })).project.id;
  await admin.post(`/api/projects/${pid}/members`, { email: 'o@example.com', access: 'owner', role: 'Lead' });
});

after(() => srv.close());

test('an admin sets up an AWS account once; saving checks which account it reaches', async () => {
  const bad = await admin.req('POST', '/api/aws/connections', { name: 'X', auth: 'profile', profile: 'a b', region: 'ap-southeast-1' });
  assert.equal(bad.status, 400);
  const denied = await owner.req('POST', '/api/aws/connections', { name: 'Mine', auth: 'profile', profile: 'team-a', region: 'ap-southeast-1' });
  assert.equal(denied.status, 403, 'only admins create AWS accounts');

  const r = await admin.post('/api/aws/connections', { name: 'Team A', auth: 'profile', profile: 'team-a', region: 'ap-southeast-1' });
  assert.equal(r.check.ok, true);
  assert.equal(r.check.account, '111122223333');
  assert.equal(seen().AWS_PROFILE, 'team-a');
  assert.equal(seen().AWS_REGION, 'ap-southeast-1');
  const keys = await admin.post('/api/aws/connections', { name: 'Team K', auth: 'keys', region: 'us-east-1', accessKeyId: 'AKIACONNECTIONKEY001', secretAccessKey: 'connection-secret-key-0123456789' });
  assert.equal(keys.connection.accessKey.set, true);
  assert.equal(JSON.stringify(keys).includes('connection-secret-key'), false, 'the secret is never sent back');

  const list = await owner.get('/api/aws/connections');
  assert.equal(list.canManage, false);
  const a = list.connections.find((c: any) => c.name === 'Team A');
  assert.equal(a.account, '111122223333');
  assert.equal(a.profile, undefined, 'non-admins do not see profile names');
  assert.equal((await owner.req('GET', '/api/aws/profiles')).status, 403);
});

test('a project picks an AWS account; runs, the model and the badge use it', async () => {
  const conns = (await admin.get('/api/aws/connections')).connections;
  const teamA = conns.find((c: any) => c.name === 'Team A');
  const denied = await owner.req('PUT', `/api/projects/${pid}/aws`, { auth: 'connection', connectionId: teamA.id, provider: 'bedrock' });
  assert.equal(denied.status, 403, 'only an admin connects a project to an AWS account');
  const missing = await admin.req('PUT', `/api/projects/${pid}/aws`, { auth: 'connection', connectionId: 'awc_nope', provider: 'bedrock' });
  assert.equal(missing.status, 400);
  const saved = await admin.put(`/api/projects/${pid}/aws`, { auth: 'connection', connectionId: teamA.id, provider: 'bedrock' });
  assert.equal(saved.connection.name, 'Team A');
  assert.equal(saved.connection.account, '111122223333');

  const env = await projectAwsEnv(pid);
  assert.equal(env.AWS_PROFILE, 'team-a');
  assert.equal(env.AWS_REGION, 'ap-southeast-1');
  const conn = await admin.get(`/api/projects/${pid}/connection`);
  assert.equal(conn.aws.how, 'Team A');
  assert.equal(conn.aws.account, '111122223333');
  assert.equal(conn.aws.region, 'ap-southeast-1');
  assert.equal(conn.modelAws, 'project');

  await admin.post(`/api/projects/${pid}/connection/test`);
  assert.equal(sdkEnv().AWS_PROFILE, 'team-a', 'Bedrock uses the project’s AWS account');
  assert.equal(sdkEnv().CLAUDE_CODE_USE_BEDROCK, '1');

  // The owner may still change the model provider while keeping the same AWS account.
  const keep = await owner.req('PUT', `/api/projects/${pid}/aws`, { auth: 'connection', connectionId: teamA.id, provider: 'kiro' });
  assert.equal(keep.status, 200);

  const t = await admin.post(`/api/projects/${pid}/aws/test`);
  assert.equal(t.account, '111122223333');
  const groups = (await admin.get('/api/aws/accounts')).groups;
  const g = groups.find((x: any) => x.accountId === '111122223333');
  assert.ok(g.sources.some((s: any) => s.label === 'Team A' && s.connectionId === teamA.id));
  assert.ok(g.projects.some((p: any) => p.name === 'Payments'));
});

test('editing re-checks; an AWS account in use cannot be deleted', async () => {
  const teamA = (await admin.get('/api/aws/connections')).connections.find((c: any) => c.name === 'Team A');
  const ed = await admin.put(`/api/aws/connections/${teamA.id}`, { name: 'Team A (B)', auth: 'profile', profile: 'team-b', region: 'ap-southeast-1' });
  assert.equal(ed.check.account, '222233334444');
  assert.equal((await admin.get(`/api/projects/${pid}/connection`)).aws.account, '222233334444');
  const del = await admin.req('DELETE', `/api/aws/connections/${teamA.id}`);
  assert.equal(del.status, 400);
  assert.match(del.data.error, /Payments/);
  await admin.put(`/api/projects/${pid}/aws`, { auth: 'inherit', provider: 'inherit' });
  assert.equal((await admin.req('DELETE', `/api/aws/connections/${teamA.id}`)).status, 200);
});

test('projects with their own credentials move onto AWS accounts once, and keep working', async () => {
  const p1 = (await admin.post('/api/projects', { name: 'Old profile 1', description: 'd' })).project.id;
  const p2 = (await admin.post('/api/projects', { name: 'Old profile 2', description: 'd' })).project.id;
  const p3 = (await admin.post('/api/projects', { name: 'Old keys', description: 'd' })).project.id;
  const t = new Date().toISOString();
  for (const id of [p1, p2]) exec("INSERT INTO project_aws (project_id, auth, profile, region, provider, updated_at) VALUES (?, 'profile', 'legacy', 'eu-west-1', 'inherit', ?)", id, t);
  exec("INSERT INTO project_aws (project_id, auth, profile, region, provider, updated_at) VALUES (?, 'keys', '', '', 'bedrock', ?)", p3, t);
  await setSecret(`project.${p3}.aws.access_key_id`, 'AKIALEGACYPROJECT001');
  await setSecret(`project.${p3}.aws.secret_access_key`, 'legacy-project-secret-0123456789');

  assert.equal(await adopt(), 3);
  assert.equal(await adopt(), 0, 'runs once');
  const conns = (await admin.get('/api/aws/connections')).connections;
  const legacy = conns.filter((c: any) => c.how === 'Named profile legacy');
  assert.equal(legacy.length, 1, 'the same profile and region become one shared AWS account');
  assert.deepEqual(legacy[0].projects.map((p: any) => p.name).sort(), ['Old profile 1', 'Old profile 2']);
  assert.equal((await projectAwsEnv(p1)).AWS_PROFILE, 'legacy');
  assert.equal((await projectAwsEnv(p1)).AWS_REGION, 'eu-west-1');
  const k = await projectAwsEnv(p3);
  assert.equal(k.AWS_ACCESS_KEY_ID, 'AKIALEGACYPROJECT001', 'keys are copied into the new AWS account');
  assert.equal((await admin.get(`/api/projects/${p3}/aws`)).auth, 'connection');
  assert.equal((await admin.get(`/api/projects/${p3}/connection`)).modelAws, 'project', 'Bedrock on its own account still uses it');
});
