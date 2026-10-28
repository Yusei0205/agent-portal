import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootServer, Client, waitFor, type TestServer, startSingleRun } from './client.ts';

// One connection per project: each project picks its model provider and AWS account, and runs follow it.
const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conn-')), 'kiro.jsonl');
process.env.PORTAL_SDK_MODULE = pathToFileURL(path.join(import.meta.dirname, 'fake-sdk.mjs')).href;
process.env.PORTAL_KIRO_FAKE = path.join(import.meta.dirname, 'fake-kiro-acp.mjs');
process.env.FAKE_KIRO_LOG = logFile;

let srv: TestServer;
let admin: Client;
let owner: Client;
const sdkCalls = () => (globalThis as any).__fakeSdkCalls as any[];
const kiroStarts = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'start') : []);
const pids: Record<string, string> = {};

async function finish(c: Client, runId: string) {
  return waitFor(async () => {
    const r = await c.get(`/api/runs/${runId}`);
    for (const i of r.inputs.filter((x: any) => x.status === 'pending')) {
      await c.post(`/api/inputs/${i.id}/answer`, i.type === 'question' ? { answers: { 'Which database?': 'Postgres' } } : { decision: 'allow' });
    }
    return ['completed', 'failed', 'stopped'].includes(r.run.status) ? r : null;
  }, `run ${runId}`);
}

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  owner = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'owner@example.com', name: 'Olive', password: 'a-long-password-2' });
  await owner.post('/api/auth/login', { email: 'owner@example.com', password: 'a-long-password-2' });
  // Settings default: Bedrock on the Settings keys.
  await admin.put('/api/settings', { provider: { mode: 'bedrock' }, aws: { region: 'us-east-1', auth: 'keys' } });
  await admin.post('/api/settings/secrets/aws.access_key_id', { value: 'AKIASETTINGSKEY00001' });
  await admin.post('/api/settings/secrets/aws.secret_access_key', { value: 'settings-secret-key-0123456789' });
  for (const name of ['Kiro project', 'Own Bedrock', 'Split', 'Inherit all', 'Owned']) {
    pids[name] = (await admin.post('/api/projects', { name, description: 'd' })).project.id;
  }
  const kiroAgents = path.join(srv.dataDir, 'projects', 'kiro-project', '.kiro', 'agents');
  fs.mkdirSync(kiroAgents, { recursive: true });
  fs.writeFileSync(path.join(kiroAgents, 'builder.json'), JSON.stringify({ name: 'builder', description: 'A Kiro agent so the project can run on Kiro', prompt: 'You build things.' }));
  await admin.post(`/api/projects/${pids.Owned}/members`, { email: 'owner@example.com', access: 'owner', role: 'Lead' });
});

after(() => srv.close());

test('a project on Kiro CLI runs through kiro-cli while Settings stays on Bedrock', async () => {
  const pid = pids['Kiro project'];
  await admin.put(`/api/projects/${pid}/aws`, { auth: 'inherit', provider: 'kiro' });
  const conn = await admin.get(`/api/projects/${pid}/connection`);
  assert.equal(conn.provider, 'kiro');
  assert.equal(conn.providerSource, 'project');
  assert.equal(conn.modelAws, null);

  const t = await admin.post(`/api/projects/${pid}/connection/test`);
  assert.equal(t.ok, true);
  assert.equal(t.provider, 'kiro');
  assert.equal(kiroStarts().length, 1, 'the test went through kiro-cli');

  const { run } = await startSingleRun(admin, pid, { prompt: 'Write some notes' });
  const done = await finish(admin, run.id);
  assert.equal(done.run.provider, 'kiro');
  assert.equal(done.run.status, 'completed', done.run.error);

  const models = await admin.get(`/api/models?projectId=${pid}&refresh=1`);
  assert.equal(models.mode, 'kiro');
  assert.ok(models.models.some((m: any) => m.id === 'claude-sonnet-5.5'));
  const global = await admin.get('/api/models');
  assert.equal(global.mode, 'bedrock', 'without a project the Settings provider applies');
});

test('a project on Bedrock with its own AWS account uses that one account for the model and the agent', async () => {
  const pid = pids['Own Bedrock'];
  await admin.put(`/api/projects/${pid}/aws`, { auth: 'keys', provider: 'bedrock', region: 'ap-southeast-1', accessKeyId: 'AKIAPROJECTOWN00001', secretAccessKey: 'project-own-secret-key-0123456789' });
  const conn = await admin.get(`/api/projects/${pid}/connection`);
  assert.equal(conn.provider, 'bedrock');
  assert.equal(conn.modelAws, 'project');
  assert.equal(conn.aws.source, 'project');
  assert.equal(conn.aws.region, 'ap-southeast-1');

  await admin.post(`/api/projects/${pid}/connection/test`);
  const env = sdkCalls().at(-1).options.env;
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIAPROJECTOWN00001');
  assert.equal(env.AWS_REGION, 'ap-southeast-1');
  // Claude Code keeps AWS_SECRET_ACCESS_KEY from its shell commands, so the agent reaches the same account through the
  // aws wrapper and the run's own credentials file (removed when the run ends).
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, process.platform === 'win32' ? '1' : undefined);
  assert.ok(env.PROJECT_AWS_FILES?.startsWith(path.join(srv.dataDir, 'run-aws') + path.sep), 'the agent uses the same account');
  assert.ok(!fs.existsSync(env.PROJECT_AWS_FILES), 'the credentials file went with the run');
  assert.ok(Object.entries(env).some(([k, v]) => k.toLowerCase() === 'path' && String(v).startsWith(path.join(srv.dataDir, 'bin') + path.delimiter)), 'the aws wrapper is first on PATH');
});

test('a project that inherits the provider but has its own AWS keeps the older split', async () => {
  const pid = pids.Split;
  await admin.put(`/api/projects/${pid}/aws`, { auth: 'keys', accessKeyId: 'AKIAPROJECTSPLIT0001', secretAccessKey: 'project-split-secret-key-0123456789' });
  const conn = await admin.get(`/api/projects/${pid}/connection`);
  assert.equal(conn.providerSource, 'settings');
  assert.equal(conn.modelAws, 'settings');
  await admin.post(`/api/projects/${pid}/connection/test`);
  const env = sdkCalls().at(-1).options.env;
  assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIASETTINGSKEY00001', 'the model keeps the Settings account');
  assert.ok(env.PROJECT_AWS_FILES, 'the agent’s aws command goes to the project account');
  assert.equal(env.PROJECT_AWS_ACCESS_KEY_ID, undefined, 'keys travel in a file, not in variables');
});

test('a project that inherits everything behaves exactly as before', async () => {
  const pid = pids['Inherit all'];
  const conn = await admin.get(`/api/projects/${pid}/connection`);
  assert.equal(conn.provider, 'bedrock');
  assert.equal(conn.providerSource, 'settings');
  assert.equal(conn.aws.source, 'settings');
  await admin.post(`/api/projects/${pid}/connection/test`);
  assert.equal(sdkCalls().at(-1).options.env.AWS_ACCESS_KEY_ID, 'AKIASETTINGSKEY00001');
});

test('AWS SSO for a project: admin only, validated, and a clear error without an SSO sign-in', async () => {
  const pid = pids.Owned;
  const denied = await owner.req('PUT', `/api/projects/${pid}/aws`, { auth: 'sso', provider: 'bedrock', ssoAccountId: '474189600089', ssoRoleName: 'AdminAccess' });
  assert.equal(denied.status, 403, 'a project owner cannot hand out the admin’s SSO roles');
  const bad = await admin.req('PUT', `/api/projects/${pid}/aws`, { auth: 'sso', provider: 'bedrock', ssoAccountId: '4741', ssoRoleName: 'AdminAccess' });
  assert.equal(bad.status, 400);
  await admin.put(`/api/projects/${pid}/aws`, { auth: 'sso', provider: 'bedrock', region: 'ap-southeast-1', ssoAccountId: '474189600089', ssoRoleName: 'AdminAccess' });
  const conn = await admin.get(`/api/projects/${pid}/connection`);
  assert.equal(conn.aws.account, '474189600089');
  assert.equal(conn.aws.how, 'SSO AdminAccess');
  // The owner may still change the model provider without touching the SSO choice.
  const keep = await owner.req('PUT', `/api/projects/${pid}/aws`, { auth: 'sso', provider: 'kiro', region: 'ap-southeast-1', ssoAccountId: '474189600089', ssoRoleName: 'AdminAccess' });
  assert.equal(keep.status, 200);
  await admin.put(`/api/projects/${pid}/aws`, { auth: 'sso', provider: 'bedrock', region: 'ap-southeast-1', ssoAccountId: '474189600089', ssoRoleName: 'AdminAccess' });
  const t = await admin.req('POST', `/api/projects/${pid}/connection/test`);
  assert.equal(t.status, 502);
  assert.match(t.data.error, /AWS SSO for this project \(account 474189600089, role AdminAccess\): Not signed in with AWS SSO/);
});

test('a session on Kiro CLI pauses at its credit budget', async () => {
  const pid = pids['Kiro project'];
  // Each fake Kiro run reports 0.2 credits.
  const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, { goal: 'Keep writing notes', budgetCredits: 0.3, maxIterations: 10, playground: true });
  assert.equal(workflow.provider, 'kiro');
  assert.equal(workflow.budget_credits, 0.3);
  const w = await waitFor(async () => {
    const r = await admin.get(`/api/workflows/${workflow.id}`);
    return r.workflow.status !== 'running' && !r.driving ? r.workflow : null;
  }, 'session pause', 60_000);
  assert.equal(w.status, 'paused');
  assert.match(w.stop_reason, /0\.3 Kiro credits/);
  assert.equal(w.iteration, 2);
  assert.ok(Math.abs(w.spent_credits - 0.4) < 1e-9);
  assert.equal(w.spent_usd, 0);
  const again = await admin.req('POST', `/api/workflows/${workflow.id}/resume`);
  assert.equal(again.status, 400, 'resume is refused until the credit budget is raised');
  await admin.put(`/api/workflows/${workflow.id}`, { budgetCredits: 5 });
  await admin.post(`/api/workflows/${workflow.id}/pause`).catch(() => undefined);
});
