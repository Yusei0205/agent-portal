import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { bootServer, Client, type TestServer } from './client.ts';

// Loaded after the test server has set its temporary data folder (see test/jira.test.ts).
let one: typeof import('../server/db.ts').one;
let projectAwsEnv: typeof import('../server/project-aws.ts').projectAwsEnv;
let projectRunEnv: typeof import('../server/project-aws.ts').projectRunEnv;
let ensureAwsShims: typeof import('../server/project-aws.ts').ensureAwsShims;
let agentEnv: typeof import('../server/settings.ts').agentEnv;
let repoGitEnv: typeof import('../server/repos.ts').repoGitEnv;
let getRepo: typeof import('../server/repos.ts').getRepo;

let srv: TestServer;
let admin: Client;
let editor: Client;
let pid: string;
let slug: string;
let other: string;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paws-'));
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['PORTAL_AWS_BIN', 'PORTAL_AWS_BIN_ARGS', 'FAKE_AWS_OUT', 'FAKE_AWS_FAIL', 'AWS_ACCESS_KEY_ID'];

// A stand-in for `aws sts get-caller-identity` that records the AWS_* variables it was started with.
const FAKE_AWS = path.join(tmp, 'fake-aws.cjs');
fs.writeFileSync(
  FAKE_AWS,
  `const fs = require('fs');
const seen = {};
for (const [k, v] of Object.entries(process.env)) if (/^AWS_/.test(k)) seen[k] = v;
fs.writeFileSync(process.env.FAKE_AWS_OUT, JSON.stringify({ argv: process.argv.slice(2), seen }));
if (process.env.FAKE_AWS_FAIL === 'silent') { process.stderr.write('\\r\\n'); process.exit(255); }
if (process.env.FAKE_AWS_FAIL) { console.error('An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation'); process.exit(255); }
console.log(JSON.stringify({ UserId: 'AIDAEXAMPLE', Account: '111122223333', Arn: 'arn:aws:iam::111122223333:user/dev' }));
`,
);
const seenByFake = () => JSON.parse(fs.readFileSync(path.join(tmp, 'seen.json'), 'utf8'));

before(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PORTAL_AWS_BIN = process.execPath;
  process.env.PORTAL_AWS_BIN_ARGS = JSON.stringify([FAKE_AWS]);
  process.env.FAKE_AWS_OUT = path.join(tmp, 'seen.json');
  process.env.AWS_ACCESS_KEY_ID = 'AKIASERVERPROCESSKEY'; // must never leak into a project's test
  srv = await bootServer();
  ({ one } = await import('../server/db.ts'));
  ({ projectAwsEnv, projectRunEnv, ensureAwsShims } = await import('../server/project-aws.ts'));
  ({ agentEnv } = await import('../server/settings.ts'));
  ({ repoGitEnv, getRepo } = await import('../server/repos.ts'));
  admin = new Client(srv.base);
  editor = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'e@example.com', name: 'Eddie', password: 'a-long-password-2' });
  await editor.post('/api/auth/login', { email: 'e@example.com', password: 'a-long-password-2' });
  const { project } = await admin.post('/api/projects', { name: 'Account A', description: 'd' });
  pid = project.id;
  slug = project.slug;
  other = (await admin.post('/api/projects', { name: 'Account B', description: 'd' })).project.id;
  await admin.post(`/api/projects/${pid}/members`, { email: 'e@example.com', access: 'editor', role: 'Developer' });
  // Settings: the credentials the portal uses for the Bedrock model
  await admin.put('/api/settings', { aws: { region: 'us-east-1', auth: 'keys' } });
  await admin.post('/api/settings/secrets/aws.access_key_id', { value: 'AKIABEDROCKSETTINGS1' });
  await admin.post('/api/settings/secrets/aws.secret_access_key', { value: 'bedrock-settings-secret-key-0123456789' });
});

after(async () => {
  await srv.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const put = (body: unknown, c = admin, id = pid) => c.req('PUT', `/api/projects/${id}/aws`, body);

test('a new project uses the Settings credentials, and says so', async () => {
  const v = await admin.get(`/api/projects/${pid}/aws`);
  assert.equal(v.auth, 'inherit');
  assert.equal(v.defaultRegion, 'us-east-1');
  assert.equal(v.accessKey.set, false);
  const env = await projectAwsEnv(pid);
  assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIABEDROCKSETTINGS1', 'without its own account a project falls back to Settings');
});

test('only the project owner can set the project’s AWS account; input is validated', async () => {
  assert.equal((await put({ auth: 'keys', accessKeyId: 'AKIAPROJECTKEY00001', secretAccessKey: 'x'.repeat(40) }, editor)).status, 403, 'an editor cannot change it');
  assert.equal((await put({ auth: 'nope' })).status, 400);
  assert.equal((await put({ auth: 'inherit', region: 'mars-1' })).status, 400, 'bad region');
  assert.equal((await put({ auth: 'profile', profile: 'bad profile!' })).status, 400, 'bad profile name');
  assert.equal((await put({ auth: 'keys', accessKeyId: 'lowercase', secretAccessKey: 'x'.repeat(40) })).status, 400, 'bad key id');
  assert.equal((await put({ auth: 'keys', accessKeyId: 'AKIAPROJECTKEY00001', secretAccessKey: 'short' })).status, 400, 'bad secret');
  const missing = await put({ auth: 'keys', accessKeyId: 'AKIAPROJECTKEY00001' });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /both the access key ID and the secret/);
});

test('project access keys are stored encrypted and never returned; the editor sees only that they are set', async () => {
  const r = await put({ auth: 'keys', region: 'ap-southeast-1', accessKeyId: 'AKIAPROJECTKEY00001', secretAccessKey: 'project-a-secret-access-key-0123456789', sessionToken: 'tok/en+with=chars' });
  assert.equal(r.status, 200);
  assert.equal(r.data.auth, 'keys');
  assert.equal(r.data.region, 'ap-southeast-1');
  assert.equal(r.data.secretSet, true);
  assert.equal(r.data.tokenSet, true);
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes('project-a-secret') && !text.includes('tok/en'), 'secrets are not returned');
  const asEditor = await editor.get(`/api/projects/${pid}/aws`);
  assert.equal(asEditor.accessKey.set, true);
  assert.equal(asEditor.accessKey.hint, undefined, 'only the owner sees which key is stored');
  for (const w of ['access_key_id', 'secret_access_key', 'session_token']) {
    const row = one<{ value: string }>('SELECT value FROM secrets WHERE name = ?', `project.${pid}.aws.${w}`)!;
    assert.ok(row && !/AKIAPROJECTKEY|project-a-secret|tok\/en/.test(row.value), `${w} is encrypted at rest`);
  }
  assert.equal((await admin.get(`/api/projects/${other}/aws`)).auth, 'inherit', 'another project is not affected');
  // updating only the region keeps the stored keys
  const keep = await put({ auth: 'keys', region: 'eu-west-1' });
  assert.equal(keep.status, 200);
  assert.equal(keep.data.secretSet, true);
  assert.equal((await projectAwsEnv(pid)).AWS_REGION, 'eu-west-1');
  await put({ auth: 'keys', region: 'ap-southeast-1' });
});

test('the project’s environment is its own account, not the Settings one', async () => {
  const env = await projectAwsEnv(pid);
  assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIAPROJECTKEY00001');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, 'project-a-secret-access-key-0123456789');
  assert.equal(env.AWS_SESSION_TOKEN, 'tok/en+with=chars');
  assert.equal(env.AWS_REGION, 'ap-southeast-1');
  assert.equal((await projectAwsEnv(other)).AWS_ACCESS_KEY_ID, 'AKIABEDROCKSETTINGS1', 'the other project still uses Settings');
});

test('Test connection reports the account behind the project’s credentials, and only those', async () => {
  const r = await admin.post(`/api/projects/${pid}/aws/test`);
  assert.deepEqual(r, { ok: true, account: '111122223333', arn: 'arn:aws:iam::111122223333:user/dev', userId: 'AIDAEXAMPLE', region: 'ap-southeast-1' });
  const seen = seenByFake();
  assert.deepEqual(seen.argv, ['sts', 'get-caller-identity', '--output', 'json']);
  assert.equal(seen.seen.AWS_ACCESS_KEY_ID, 'AKIAPROJECTKEY00001', "the project's key was used");
  assert.notEqual(seen.seen.AWS_ACCESS_KEY_ID, 'AKIASERVERPROCESSKEY', "the server process's own AWS variables are not leaked in");
  assert.equal(seen.seen.AWS_SESSION_TOKEN, 'tok/en+with=chars');
  assert.equal((await editor.post(`/api/projects/${pid}/aws/test`)).ok, true, 'an editor can test it');
  process.env.FAKE_AWS_FAIL = '1';
  const bad = await admin.req('POST', `/api/projects/${pid}/aws/test`);
  delete process.env.FAKE_AWS_FAIL;
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /AWS did not accept these credentials: .*InvalidClientTokenId/);
  // A CLI that fails without a message (only a Windows line break) still gives a reason, never an empty one.
  process.env.FAKE_AWS_FAIL = 'silent';
  const silent = await admin.req('POST', `/api/projects/${pid}/aws/test`);
  delete process.env.FAKE_AWS_FAIL;
  assert.equal(silent.status, 502);
  assert.match(silent.data.error, /exited with code 255 without saying why/);
  process.env.PORTAL_AWS_BIN = path.join(tmp, 'no-such-aws');
  const missing = await admin.req('POST', `/api/projects/${pid}/aws/test`);
  process.env.PORTAL_AWS_BIN = process.execPath;
  assert.equal(missing.status, 502);
  assert.match(missing.data.error, /AWS CLI is not installed/);
});

test('CodeCommit repositories of a project use the project’s account', async () => {
  const { repo } = await admin.req('POST', `/api/projects/${pid}/repos`, { provider: 'codecommit', url: 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/demo' }).then((r) => r.data);
  const env = await repoGitEnv(getRepo(repo.id));
  assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIAPROJECTKEY00001');
  assert.equal(env.AWS_REGION, 'ap-southeast-1');
  assert.match(env.GIT_CONFIG_VALUE_1 ?? '', /aws codecommit credential-helper/, 'git still asks the AWS helper');
  const { repo: repo2 } = await admin.req('POST', `/api/projects/${other}/repos`, { provider: 'codecommit', url: 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/demo' }).then((r) => r.data);
  assert.equal((await repoGitEnv(getRepo(repo2.id))).AWS_ACCESS_KEY_ID, 'AKIABEDROCKSETTINGS1', 'a project without its own account uses Settings');
});

test('agent runs: with Bedrock the model keeps Settings, and the project account rides alongside', async () => {
  await admin.put('/api/settings', { provider: { mode: 'bedrock' } });
  const env = await agentEnv(pid);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIABEDROCKSETTINGS1', 'the model process still signs in with the Settings credentials');
  assert.equal(env.PROJECT_AWS_ACCESS_KEY_ID, 'AKIAPROJECTKEY00001');
  assert.equal(env.PROJECT_AWS_SECRET_ACCESS_KEY, 'project-a-secret-access-key-0123456789');
  assert.equal(env.PROJECT_AWS_REGION, 'ap-southeast-1');
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path')!;
  const shimDir = ensureAwsShims();
  assert.ok(env[pathKey].startsWith(shimDir + path.delimiter), 'the aws wrapper is first on the PATH');
  assert.ok(fs.existsSync(path.join(shimDir, 'aws')) && fs.existsSync(path.join(shimDir, 'portal-aws-env')));
  const plain = await agentEnv(other);
  assert.equal(plain.PROJECT_AWS_ACCESS_KEY_ID, undefined, 'a project without its own account gets nothing extra');
  assert.ok(!plain[pathKey]?.startsWith(shimDir));
  assert.equal((await projectRunEnv(other, true)).pathPrefix, undefined);
});

test('agent runs: without Bedrock the project account is simply the AWS account', async () => {
  await admin.post('/api/settings/secrets/anthropic.api_key', { value: 'sk-ant-test-0123456789' });
  await admin.put('/api/settings', { provider: { mode: 'anthropic' } });
  const env = await agentEnv(pid);
  assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIAPROJECTKEY00001');
  assert.equal(env.AWS_REGION, 'ap-southeast-1');
  assert.equal(env.PROJECT_AWS_ACCESS_KEY_ID, undefined);
  assert.equal((await agentEnv(other)).AWS_ACCESS_KEY_ID, undefined, 'no project account, no AWS variables');
});

test('a named profile works the same way, and switching away removes the stored keys', async () => {
  const r = await put({ auth: 'profile', profile: 'client-b_admin', region: 'us-west-2' });
  assert.equal(r.status, 200);
  assert.equal(r.data.accessKey.set, false);
  const env = await projectAwsEnv(pid);
  assert.equal(env.AWS_PROFILE, 'client-b_admin');
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  for (const w of ['access_key_id', 'secret_access_key', 'session_token']) {
    assert.ok(!one('SELECT 1 FROM secrets WHERE name = ?', `project.${pid}.aws.${w}`), `${w} was deleted`);
  }
  await admin.put('/api/settings', { provider: { mode: 'bedrock' } });
  const run = await agentEnv(pid);
  assert.equal(run.PROJECT_AWS_PROFILE, 'client-b_admin');
  assert.equal(run.PROJECT_AWS_ACCESS_KEY_ID, undefined);
  assert.equal(run.AWS_ACCESS_KEY_ID, 'AKIABEDROCKSETTINGS1', 'the model is unaffected');
  await put({ auth: 'inherit' });
  assert.equal((await admin.get(`/api/projects/${pid}/aws`)).auth, 'inherit');
  assert.equal((await projectAwsEnv(pid)).AWS_ACCESS_KEY_ID, 'AKIABEDROCKSETTINGS1');
});

test('the project’s CLAUDE.md tells agents about its own AWS account only when it has one', async () => {
  const file = path.join(srv.dataDir, 'projects', slug, 'CLAUDE.md');
  assert.ok(!/own AWS account/.test(fs.readFileSync(file, 'utf8')));
  await put({ auth: 'keys', accessKeyId: 'AKIAPROJECTKEY00001', secretAccessKey: 'project-a-secret-access-key-0123456789' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /own AWS account/);
  assert.match(text, /portal-aws-env/);
  await put({ auth: 'inherit' });
  assert.ok(!/own AWS account/.test(fs.readFileSync(file, 'utf8')));
});

/* ---------------- The wrapper scripts, run for real in bash ---------------- */

const bash = spawnSync('bash', ['--version']);
const hasBash = bash.status === 0;

test('the aws wrapper sends the CLI to the project account and leaves the model’s variables alone', { skip: !hasBash && 'bash is not available' }, () => {
  const shimDir = ensureAwsShims().replace(/\\/g, '/');
  const fakeDir = path.join(tmp, 'realbin');
  fs.mkdirSync(fakeDir, { recursive: true });
  // a pretend "real" aws that prints the variables it sees
  fs.writeFileSync(path.join(fakeDir, 'aws'), '#!/usr/bin/env bash\necho "KEY=${AWS_ACCESS_KEY_ID:-} SECRET=${AWS_SECRET_ACCESS_KEY:-} TOKEN=${AWS_SESSION_TOKEN:-} PROFILE=${AWS_PROFILE:-} REGION=${AWS_REGION:-}/${AWS_DEFAULT_REGION:-} BEARER=${AWS_BEARER_TOKEN_BEDROCK:-} ARGS=$*"\n', { mode: 0o755 });
  const base = { ...process.env, PATH: [shimDir, fakeDir, process.env.PATH].join(path.delimiter) };
  const run = (extra: Record<string, string>) => execFileSync('bash', [`${shimDir}/aws`, 'sts', 'get-caller-identity'], { env: { ...base, ...extra }, encoding: 'utf8' }).trim();

  const withKeys = run({ AWS_ACCESS_KEY_ID: 'AKIAMODEL', AWS_SECRET_ACCESS_KEY: 'modelsecret', AWS_BEARER_TOKEN_BEDROCK: 'bearer', AWS_REGION: 'us-east-1', PROJECT_AWS_ACCESS_KEY_ID: 'AKIAPROJ', PROJECT_AWS_SECRET_ACCESS_KEY: 'projsecret', PROJECT_AWS_SESSION_TOKEN: 'ptoken', PROJECT_AWS_REGION: 'ap-southeast-1' });
  assert.equal(withKeys, 'KEY=AKIAPROJ SECRET=projsecret TOKEN=ptoken PROFILE= REGION=ap-southeast-1/ap-southeast-1 BEARER= ARGS=sts get-caller-identity');

  const withProfile = run({ AWS_ACCESS_KEY_ID: 'AKIAMODEL', PROJECT_AWS_PROFILE: 'client-b', PROJECT_AWS_REGION: 'us-west-2' });
  assert.equal(withProfile, 'KEY= SECRET= TOKEN= PROFILE=client-b REGION=us-west-2/us-west-2 BEARER= ARGS=sts get-caller-identity');

  // a project with no account of its own: nothing is changed
  const plain = run({ AWS_ACCESS_KEY_ID: 'AKIAMODEL', AWS_SECRET_ACCESS_KEY: 'modelsecret' });
  assert.match(plain, /^KEY=AKIAMODEL SECRET=modelsecret /);

  // it never calls itself, and says so when the real command is missing
  // (the restricted PATH is set inside bash, so Node can still find bash itself; even `dirname` is missing there, which also
  // proves the wrapper recognises itself by file identity and cannot call itself)
  const lonely = spawnSync('bash', ['-c', 'B="$(command -v bash)"; PATH="$1" "$B" "$1/aws" x', '_', shimDir], { encoding: 'utf8' });
  assert.equal(lonely.status, 127);
  assert.match(lonely.stderr, /was not found/);
});

test('portal-aws-env prints export lines that are safe to eval, even for awkward values', { skip: !hasBash && 'bash is not available' }, () => {
  const shimDir = ensureAwsShims().replace(/\\/g, '/');
  const script = `eval "$(bash ${shimDir}/portal-aws-env)"; printf '%s|%s|%s|%s' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" "$AWS_SESSION_TOKEN" "$AWS_REGION"`;
  const out = execFileSync('bash', ['-c', script], {
    env: { ...process.env, AWS_BEARER_TOKEN_BEDROCK: 'bearer', PROJECT_AWS_ACCESS_KEY_ID: 'AKIAPROJ', PROJECT_AWS_SECRET_ACCESS_KEY: `we"ird 'sec$ret;rm -rf /`, PROJECT_AWS_SESSION_TOKEN: 'tok/en+==', PROJECT_AWS_REGION: 'eu-west-1' },
    encoding: 'utf8',
  });
  assert.equal(out, `AKIAPROJ|we"ird 'sec$ret;rm -rf /|tok/en+==|eu-west-1`, 'values survive eval exactly and nothing is executed');
  const cleared = execFileSync('bash', ['-c', `eval "$(bash ${shimDir}/portal-aws-env)"; echo "[$AWS_BEARER_TOKEN_BEDROCK]"`], { env: { ...process.env, AWS_BEARER_TOKEN_BEDROCK: 'bearer', PROJECT_AWS_ACCESS_KEY_ID: 'AKIAPROJ', PROJECT_AWS_SECRET_ACCESS_KEY: 's' }, encoding: 'utf8' }).trim();
  assert.equal(cleared, '[]', 'the Bedrock variables are cleared for Terraform and SDK code');
  const none = spawnSync('bash', ['-c', `bash ${shimDir}/portal-aws-env`], { env: { ...process.env, PROJECT_AWS_ACCESS_KEY_ID: '', PROJECT_AWS_PROFILE: '' }, encoding: 'utf8' });
  assert.match(none.stdout, /nothing to set/);
});
