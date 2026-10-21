import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';

// The Kiro CLI provider against a fake `kiro-cli acp` that logs what it receives.
const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-fake-')), 'log.jsonl');
process.env.PORTAL_KIRO_FAKE = path.join(import.meta.dirname, 'fake-kiro-acp.mjs');
process.env.FAKE_KIRO_LOG = logFile;
process.env.PORTAL_SHOULD_NOT_LEAK = 'nope';

let srv: TestServer;
let c: Client;
let pid: string;
let projectPath: string;

const entries = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const clearLog = () => fs.rmSync(logFile, { force: true });
const rpc = (method: string) => entries().filter((e) => e.event === 'rpc' && e.method === method);

before(async () => {
  srv = await bootServer();
  c = new Client(srv.base);
  await c.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  pid = (await c.post('/api/projects', { name: 'Kiro check' })).project.id;
  projectPath = path.join(srv.dataDir, 'projects', 'kiro-check');
});

after(() => srv.close());

test('Kiro settings: provider mode, kiro-cli path validation, model pins', async () => {
  const bad = await c.req('PUT', '/api/settings', { kiro: { command: 'C:\\Windows\\System32\\cmd.exe' } });
  assert.equal(bad.status, 400, 'only a kiro-cli executable may be configured');
  const inject = await c.req('PUT', '/api/settings', { kiro: { command: 'kiro-cli; rm -rf /' } });
  assert.equal(inject.status, 400);
  const ok = await c.put('/api/settings', { provider: { mode: 'kiro' }, kiro: { command: '', models: { haiku: '' } } });
  assert.equal(ok.provider.mode, 'kiro');
  assert.deepEqual(ok.kiro, { command: '', models: { sonnet: '', haiku: '', opus: '' } });
  const unknown = await c.req('PUT', '/api/settings', { provider: { mode: 'nope' } });
  assert.equal(unknown.status, 400);
});

test('Kiro connection test: tool-less profile, API key passed, no portal secrets, haiku alias resolved', async () => {
  await c.post('/api/settings/secrets/kiro.api_key', { value: 'ksk_example_key_123456' });
  clearLog();
  const t = await c.post('/api/settings/test');
  assert.equal(t.ok, true);
  assert.equal(t.provider, 'kiro');

  const start = entries().find((e) => e.event === 'start');
  assert.equal(start.env.KIRO_API_KEY, 'ksk_example_key_123456');
  assert.equal(start.env.PORTAL_SECRET_KEY, null);
  assert.equal(start.env.PORTAL_SHOULD_NOT_LEAK, null);
  assert.deepEqual(start.profile.tools, []);
  assert.deepEqual(start.profile.mcpServers, {});
  assert.equal(start.profile.includeMcpJson, false);
  assert.equal('useLegacyMcpJson' in start.profile, false, 'kiro-cli 2.x rejects a profile that sets both aliases');
  assert.match(start.profile.prompt, /connection test/);
  assert.equal(rpc('session/set_model')[0].params.modelId, 'claude-haiku-4.5');
});

test('Kiro run: guard, approvals, tool events, credits, profile cleanup', async () => {
  clearLog();
  const { run } = await c.post(`/api/projects/${pid}/runs`, { prompt: 'Write some notes' });

  // The write outside the run folder is refused without asking anyone; the one inside asks.
  const write = await waitFor(async () => (await c.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.type === 'approval' && i.status === 'pending'), 'write approval');
  assert.equal(write.tool_name, 'Write');
  assert.ok(String(write.payload.input.file_path).includes(path.join('work', run.id)));
  await c.post(`/api/inputs/${write.id}/answer`, { decision: 'allow' });

  const shell = await waitFor(async () => (await c.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.tool_name === 'Bash' && i.status === 'pending'), 'shell approval');
  assert.equal(shell.payload.input.command, 'npm test');
  await c.post(`/api/inputs/${shell.id}/answer`, { decision: 'deny', message: 'not now' });

  const done = await waitFor(async () => {
    const r = await c.get(`/api/runs/${run.id}`);
    return ['completed', 'failed'].includes(r.run.status) ? r : null;
  }, 'completion');
  assert.equal(done.run.status, 'completed', done.run.error);
  assert.equal(done.run.provider, 'kiro');
  assert.equal(done.run.session_id, 'kiro-sess-1');
  assert.equal(done.run.result, 'Done here.');
  assert.equal(done.run.cost_usd, 0);
  assert.equal(done.run.meta.kiroCredits, 0.2);

  const perms = entries().filter((e) => e.event === 'permission');
  assert.deepEqual(perms.map((p) => [p.tool, p.decision]), [['write', 'reject_once'], ['write', 'allow_once'], ['shell', 'reject_once']]);
  assert.equal(done.inputs.filter((i: any) => i.type === 'approval').length, 2, 'the outside write never reached a person');

  const toolUses = done.events.filter((e: any) => e.type === 'assistant').flatMap((e: any) => e.data.message.content).filter((b: any) => b.type === 'tool_use');
  assert.deepEqual(toolUses.map((b: any) => b.name), ['Read', 'Write', 'Write', 'Bash']);
  assert.ok(done.events.some((e: any) => e.type === 'system:portal_blocked'));
  assert.ok(done.events.some((e: any) => e.type === 'user'), 'tool results are recorded');

  const start = entries().find((e) => e.event === 'start');
  assert.deepEqual(start.profile.tools, ['read', 'write', 'shell', 'grep', 'glob', 'subagent']);
  assert.deepEqual(start.profile.allowedTools, ['read', 'grep', 'glob']);
  assert.deepEqual(start.profile.toolsSettings.subagent.availableAgents, [`${start.profile.name}-general`], 'only the run’s own subagents, never the user’s global Kiro agents');
  assert.equal(start.profile.toolsSettings.subagent.trustedAgents, undefined, 'subagents are never trusted to skip the portal’s checks');
  assert.equal(start.cwd, projectPath);
  assert.match(start.profile.prompt, /Agent Portal/);
  assert.equal(rpc('session/set_model')[0].params.modelId, 'claude-sonnet-5.5', 'sonnet alias resolves to the newest sonnet');

  const agentsDir = path.join(projectPath, '.kiro', 'agents');
  await waitFor(async () => !fs.existsSync(agentsDir) || fs.readdirSync(agentsDir).length === 0, 'per-run profile removed');
  assert.match(fs.readFileSync(path.join(projectPath, '.git', 'info', 'exclude'), 'utf8'), /\.kiro\/agents\/agent-portal-\*/);
});

test('Kiro follow-up resumes the same session and ignores the replayed history', async () => {
  const prev = (await c.get(`/api/projects/${pid}/runs`)).runs.find((r: any) => r.kind === 'chat' && r.status === 'completed');
  clearLog();
  const { run } = await c.post(`/api/runs/${prev.id}/continue`, { prompt: 'And one more thing', permissionMode: 'acceptEdits' });
  // acceptEdits: the inside write needs nobody; the shell command still asks.
  const shell = await waitFor(async () => (await c.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.tool_name === 'Bash' && i.status === 'pending'), 'shell approval');
  await c.post(`/api/inputs/${shell.id}/answer`, { decision: 'allow' });
  const done = await waitFor(async () => {
    const r = await c.get(`/api/runs/${run.id}`);
    return ['completed', 'failed'].includes(r.run.status) ? r : null;
  }, 'completion');
  assert.equal(done.run.status, 'completed', done.run.error);
  assert.equal(rpc('session/load')[0].params.sessionId, 'kiro-sess-1');
  assert.equal(rpc('session/new').length, 0);
  assert.ok(!JSON.stringify(done.events).includes('OLD HISTORY'));
});

test('Kiro model list and an unavailable pinned model', async () => {
  const list = await c.get('/api/models?refresh=1');
  assert.equal(list.mode, 'kiro');
  assert.equal(list.error, '');
  assert.ok(list.models.some((m: any) => m.id === 'claude-sonnet-5.5' && m.family === 'sonnet'));

  await c.put('/api/settings', { kiro: { models: { opus: 'claude-opus-9' } } });
  const r = await c.req('POST', '/api/settings/test');
  // The connection test uses haiku, so it still works; an opus run fails with a clear message.
  assert.equal(r.status, 200);
  const { run } = await c.post(`/api/projects/${pid}/runs`, { prompt: 'Plan it', model: 'opus' });
  const failed = await waitFor(async () => {
    const x = await c.get(`/api/runs/${run.id}`);
    return ['completed', 'failed'].includes(x.run.status) ? x : null;
  }, 'failure');
  assert.equal(failed.run.status, 'failed');
  assert.match(failed.run.error, /does not offer the model "claude-opus-9"/);
  await c.put('/api/settings', { kiro: { models: { opus: '' } } });
});

test('Kiro subagents: the project roles become the team, each subagent is its own agent, and its writes are checked', async () => {
  clearLog();
  fs.mkdirSync(path.join(projectPath, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, '.claude', 'agents', 'backend-agent.md'), '---\nname: backend-agent\ndescription: Builds the API\ntools: Read, Grep, Write, Bash\n---\nYou build backend code.\n');
  const { run } = await c.post(`/api/projects/${pid}/runs`, { prompt: 'Split the work [delegate]', permissionMode: 'acceptEdits' });

  // Starting subagents asks first, like any tool that is not a plain edit.
  const spawn = await waitFor(async () => (await c.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.tool_name === 'Subagents' && i.status === 'pending'), 'subagent approval');
  await c.post(`/api/inputs/${spawn.id}/answer`, { decision: 'allow' });
  const done = await waitFor(async () => {
    const r = await c.get(`/api/runs/${run.id}`);
    return ['completed', 'failed'].includes(r.run.status) ? r : null;
  }, 'completion');
  assert.equal(done.run.status, 'completed', done.run.error);
  assert.equal(done.run.result, 'All done.', 'the subagent’s words do not end up in the main agent’s answer');
  assert.equal(done.run.meta.kiroCredits, 0.25, 'subagent credits count too');

  const start = entries().find((e) => e.event === 'start');
  const names = start.profile.toolsSettings.subagent.availableAgents;
  assert.deepEqual(names, [`${start.profile.name}-backend-agent`, `${start.profile.name}-general`]);
  assert.match(start.profile.prompt, new RegExp(`- ${start.profile.name}-backend-agent — backend-agent: Builds the API`));
  const role = entries().find((e) => e.event === 'role-profile').roleProfile;
  assert.deepEqual(role.tools, ['read', 'grep', 'write', 'shell']);
  assert.deepEqual(role.allowedTools, ['read', 'grep'], 'writes and commands of a subagent still ask');
  assert.match(role.prompt, /You build backend code/);
  assert.ok(!role.tools.includes('subagent'), 'subagents do not start subagents of their own');

  // The subagent's write outside the run folder was refused by the portal; the one inside went ahead.
  const perms = entries().filter((e) => e.event === 'permission').map((p) => [p.tool, p.decision]);
  assert.deepEqual(perms, [['subagent', 'allow_once'], ['write', 'reject_once'], ['write', 'allow_once']]);

  // The subagent shows as an Agent call of the main agent, with its own work under it.
  const assistant = done.events.filter((e: any) => e.type === 'assistant');
  const agentCall = assistant.flatMap((e: any) => e.data.message.content).find((b: any) => b.type === 'tool_use' && b.name === 'Agent');
  assert.equal(agentCall.input.subagent_type, 'backend-agent');
  const under = assistant.filter((e: any) => e.parent === agentCall.id).flatMap((e: any) => e.data.message.content);
  assert.deepEqual(under.filter((b: any) => b.type === 'tool_use').map((b: any) => b.name), ['Write', 'Write', 'Summary']);
  assert.ok(under.some((b: any) => b.type === 'text' && b.text === 'Writing the notes.'));
  const closed = done.events.find((e: any) => e.type === 'user' && e.data.message.content[0].tool_use_id === agentCall.id);
  assert.equal(closed.data.message.content[0].content, 'Wrote notes.md.', 'the subagent’s summary is its report');

  const agentsDir = path.join(projectPath, '.kiro', 'agents');
  await waitFor(async () => !fs.existsSync(agentsDir) || fs.readdirSync(agentsDir).length === 0, 'all generated profiles removed');
});
