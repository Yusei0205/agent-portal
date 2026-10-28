/**
 * Project Kiro agents: the Kiro tab of Agents and skills, imports, and Kiro runs built from them.
 * Runs use the fake ACP server, and "~/.kiro" is a temporary folder: no real kiro-cli and no real ~/.kiro.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { bootServer, Client, waitFor, type TestServer, startSingleRun, startSingleRunReq } from './client.ts';

process.env.PORTAL_KIRO_FAKE = path.join(import.meta.dirname, 'fake-kiro-acp.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-agents-test-'));
const logFile = path.join(tmp, 'log.jsonl');
const home = path.join(tmp, 'home', '.kiro');
process.env.FAKE_KIRO_LOG = logFile;
process.env.PORTAL_KIRO_HOME = home;

let srv: TestServer;
let admin: Client;
let ed: Client;
let pid: string;
let dir: string;

const entries = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const clearLog = () => fs.rmSync(logFile, { force: true });
const write = (rel: string, content: string | object) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};
const putAgent = (c: Client, name: string, json: object, prompt?: string) => c.req('PUT', `/api/projects/${pid}/kiro-agents/${name}`, { json, prompt });
/** Wait for a run to end, turning down anything it asks on the way (the fake's default path runs a command). */
const finish = (c: Client, runId: string) =>
  waitFor(async () => {
    const r = await c.get(`/api/runs/${runId}`);
    for (const i of r.inputs.filter((x: any) => x.status === 'pending')) await c.post(`/api/inputs/${i.id}/answer`, { decision: 'deny', message: 'not in tests' });
    return ['completed', 'failed'].includes(r.run.status) ? r : null;
  }, 'completion');
const gitLog = () => execFileSync('git', ['log', '--format=%s', '-30'], { cwd: dir }).toString();

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  ed = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'e@example.com', name: 'Eve', password: 'a-long-password-2' });
  await ed.post('/api/auth/login', { email: 'e@example.com', password: 'a-long-password-2' });
  await admin.put('/api/settings', { provider: { mode: 'kiro' }, kiro: { command: '' } });
  const { project } = await admin.post('/api/projects', { name: 'Kiro agents', description: 'd' });
  pid = project.id;
  dir = path.join(srv.dataDir, 'projects', project.slug);
  await admin.post(`/api/projects/${pid}/members`, { email: 'e@example.com', access: 'editor', role: 'Dev' });
});

after(() => {
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the Kiro tab lists project agents, never the portal’s per-run profiles, and never follows a prompt out of .kiro', async () => {
  write('.kiro/agents/agent-portal-deadbeef.json', { name: 'agent-portal-deadbeef', prompt: 'generated' });
  write('.kiro/agents/agent-portal-deadbeef-backend.json', { name: 'agent-portal-deadbeef-backend', prompt: 'generated' });
  fs.mkdirSync(path.join(tmp, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'outside', 'secret.txt'), 'TOP SECRET');
  write('.kiro/agents/sneaky.json', { name: 'sneaky', description: 'd', prompt: `file://${path.join(tmp, 'outside', 'secret.txt').replace(/\\/g, '/')}` });
  write('.kiro/agents/homey.json', { name: 'homey', description: 'd', prompt: 'file://~/.aws/credentials' });
  const { agents } = await admin.get(`/api/projects/${pid}/kiro-agents`);
  assert.deepEqual(agents.map((a: any) => a.name), ['homey', 'sneaky']);
  assert.ok(agents.every((a: any) => a.prompt === ''), 'absolute and home prompt files are not read');
  assert.ok(!JSON.stringify(agents).includes('TOP SECRET'));
  for (const f of ['agent-portal-deadbeef', 'agent-portal-deadbeef-backend', 'sneaky', 'homey']) fs.rmSync(path.join(dir, '.kiro', 'agents', `${f}.json`));
});

test('create, edit (prompt file kept), disable, enable and delete; every change is committed', async () => {
  const created = await putAgent(ed, 'reviewer', { description: 'Reviews code', tools: ['read', 'grep'], model: 'claude-sonnet-4.6' }, 'You review code.');
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.agent.prompt, 'You review code.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.kiro/agents/reviewer.json'), 'utf8')).prompt, 'You review code.');
  assert.equal((await putAgent(ed, 'agent-portal-1234', { description: 'x' })).status, 400, 'the per-run prefix is reserved');

  // An agent whose prompt lives in its own file keeps it there.
  write('.kiro/agents/writer.json', { name: 'writer', description: 'Writes docs', prompt: 'file://./writer-prompt.md', tools: ['read'] });
  write('.kiro/agents/writer-prompt.md', 'Old instructions');
  const w = (await admin.get(`/api/projects/${pid}/kiro-agents/writer`)).agent;
  assert.equal(w.prompt, 'Old instructions');
  assert.equal(w.promptFile, '.kiro/agents/writer-prompt.md');
  await ed.put(`/api/projects/${pid}/kiro-agents/writer`, { json: w.json, prompt: 'New instructions' });
  assert.equal(fs.readFileSync(path.join(dir, '.kiro/agents/writer-prompt.md'), 'utf8'), 'New instructions');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.kiro/agents/writer.json'), 'utf8')).prompt, 'file://./writer-prompt.md');

  // Disabled agents move out of .kiro/agents (prompt file too), so Kiro does not load them either.
  const off = await ed.put(`/api/projects/${pid}/kiro-agents/writer/enabled`, { enabled: false });
  assert.equal(off.agent.enabled, false);
  assert.ok(fs.existsSync(path.join(dir, '.kiro/agents-disabled/writer.json')));
  assert.ok(fs.existsSync(path.join(dir, '.kiro/agents-disabled/writer-prompt.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.kiro/agents/writer.json')));
  assert.equal(off.agent.prompt, 'New instructions');
  assert.ok(!(await admin.get(`/api/projects/${pid}/leads?engine=kiro`)).leads.some((l: any) => l.name === 'writer'), 'a disabled agent cannot lead');
  await ed.put(`/api/projects/${pid}/kiro-agents/writer/enabled`, { enabled: true });
  assert.ok(fs.existsSync(path.join(dir, '.kiro/agents/writer-prompt.md')));

  await ed.del(`/api/projects/${pid}/kiro-agents/writer`);
  assert.ok(!fs.existsSync(path.join(dir, '.kiro/agents/writer-prompt.md')), 'its prompt file goes with it');
  assert.equal((await admin.req('GET', `/api/projects/${pid}/kiro-agents/writer`)).status, 404);
  const log = gitLog();
  for (const m of ['Create Kiro agent reviewer (Eve)', 'Update Kiro agent writer (Eve)', 'Disable Kiro agent writer (Eve)', 'Enable Kiro agent writer (Eve)', 'Delete Kiro agent writer (Eve)']) assert.ok(log.includes(m), m);
  await admin.del(`/api/projects/${pid}/kiro-agents/reviewer`);
});

test('hooks and MCP servers in Kiro agents can only be changed by admins, in the form and in Configuration', async () => {
  const hooks = { agentSpawn: [{ command: 'echo hi' }] };
  const r = await putAgent(ed, 'hooked', { description: 'd', hooks }, 'x');
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Only admins/);
  assert.equal((await putAgent(ed, 'hooked', { description: 'd', mcpServers: { x: { command: 'node' } } }, 'x')).status, 403);
  const cfg = await ed.req('PUT', `/api/projects/${pid}/config/file`, { path: '.kiro/agents/hooked.json', content: JSON.stringify({ name: 'hooked', hooks }) });
  assert.equal(cfg.status, 403, 'the file editor checks too');
  assert.equal((await putAgent(admin, 'hooked', { description: 'd', hooks }, 'x')).status, 200);
  // An editor may change everything else and keeps the hooks as they are.
  const keep = await putAgent(ed, 'hooked', { description: 'changed', hooks }, 'y');
  assert.equal(keep.status, 200);
  assert.equal(keep.data.agent.hasHooks, true);
  assert.equal((await putAgent(ed, 'hooked', { description: 'changed' }, 'y')).status, 403, 'removing them counts as a change');
  await admin.del(`/api/projects/${pid}/kiro-agents/hooked`);
});

test('import from ~/.kiro: prompt, skills and steering come along, paths are rewritten, secrets and outside files stay out', async () => {
  const k = (rel: string, content: string | object) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), typeof content === 'string' ? content : JSON.stringify(content));
  };
  k('agents/import-lead-prompt.md', 'You are the imported lead.\n');
  k('agents/import-lead.json', {
    name: 'import-lead',
    description: 'Imported lead',
    prompt: 'file://./import-lead-prompt.md',
    tools: ['*'],
    allowedTools: ['read', 'write', 'shell'],
    toolsSettings: { subagent: { availableAgents: ['import-dev'], trustedAgents: ['import-dev'] } },
    resources: ['skill://~/.kiro/skills/my-skill/SKILL.md', 'file://~/.kiro/steering/**/*.md', 'file://~/.aws/credentials', 'file://~/.kiro/settings/cli.json', 'file://README.md', 'file://~/.kiro/steering/gone.md'],
    mcpServers: { db: { command: 'db-mcp', env: { DB_PASSWORD: 'hunter2' }, headers: { Authorization: 'x' } } },
    hooks: { agentSpawn: [{ command: 'git status' }] },
    includeMcpJson: true,
  });
  k('agents/import-dev.json', { name: 'import-dev', description: 'Developer', prompt: 'You write code.', tools: ['read', 'write'] });
  k('agents/agent-portal-0badc0de.json', { name: 'agent-portal-0badc0de', prompt: 'x' });
  k('skills/my-skill/SKILL.md', '---\nname: my-skill\ndescription: Use it\n---\nHow.\n');
  k('skills/my-skill/scripts/run.sh', 'echo run\n');
  k('steering/rules.md', '# Rules\n');
  k('settings/cli.json', '{"token":"nope"}');
  k('sessions/cli/s1.jsonl', 'private');

  assert.equal((await ed.req('POST', `/api/projects/${pid}/kiro-agents/import`, { source: 'home' })).status, 403, 'only admins read the server’s ~/.kiro');
  const preview = await admin.post(`/api/projects/${pid}/kiro-agents/import`, { source: 'home' });
  assert.deepEqual(preview.agents.map((a: any) => a.name), ['import-dev', 'import-lead']);
  const lead = preview.agents.find((a: any) => a.name === 'import-lead');
  assert.deepEqual(lead.files.sort(), ['.kiro/skills/my-skill', '.kiro/steering']);
  assert.deepEqual(lead.skipped.sort(), ['file://~/.aws/credentials', 'file://~/.kiro/settings/cli.json']);
  assert.deepEqual(lead.missing, ['file://~/.kiro/steering/gone.md']);
  assert.deepEqual(lead.team, ['import-dev']);
  assert.ok(!fs.existsSync(path.join(dir, '.kiro/agents/import-lead.json')), 'a preview writes nothing');

  const done = await admin.post(`/api/projects/${pid}/kiro-agents/import`, { source: 'home', choices: {} });
  assert.deepEqual(done.imported, ['import-dev', 'import-lead']);
  const json = JSON.parse(fs.readFileSync(path.join(dir, '.kiro/agents/import-lead.json'), 'utf8'));
  assert.equal(json.prompt, 'You are the imported lead.\n');
  assert.deepEqual(json.resources, ['skill://.kiro/skills/my-skill/SKILL.md', 'file://.kiro/steering/**/*.md', 'file://README.md', 'file://.kiro/steering/gone.md']);
  assert.equal(json.includeMcpJson, false);
  assert.deepEqual(json.mcpServers, { db: { command: 'db-mcp' } }, 'MCP credentials never come along');
  assert.deepEqual(json.hooks, { agentSpawn: [{ command: 'git status' }] }, 'an admin’s import keeps hooks');
  assert.ok(fs.existsSync(path.join(dir, '.kiro/skills/my-skill/scripts/run.sh')), 'the whole skill folder');
  assert.ok(fs.existsSync(path.join(dir, '.kiro/steering/rules.md')));
  for (const gone of ['.kiro/settings', '.kiro/sessions', '.kiro/agents/agent-portal-0badc0de.json']) assert.ok(!fs.existsSync(path.join(dir, gone)), gone);
  assert.ok(!fs.readFileSync(path.join(dir, '.kiro/agents/import-lead.json'), 'utf8').includes('hunter2'));
  assert.match(gitLog(), /Import Kiro agents import-dev, import-lead from ~\/\.kiro on the portal server \(Ann\)/);

  // Again: both conflict and are skipped unless asked; "rename" imports a copy beside the existing one.
  const again = await admin.post(`/api/projects/${pid}/kiro-agents/import`, { source: 'home' });
  assert.ok(again.agents.every((a: any) => a.conflict));
  const renamed = await admin.post(`/api/projects/${pid}/kiro-agents/import`, { source: 'home', choices: { 'import-lead': 'rename' } });
  assert.deepEqual(renamed.imported, ['import-lead-2']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.kiro/agents/import-lead-2.json'), 'utf8')).name, 'import-lead-2');
  await admin.del(`/api/projects/${pid}/kiro-agents/import-lead-2`);
});

test('import from an uploaded folder or zip: editors can, without hooks or MCP servers; nothing climbs out', async () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const agent = JSON.stringify({ name: 'up', description: 'Uploaded', prompt: 'file://./up.md', hooks: { stop: [{ command: 'curl evil' }] }, mcpServers: { x: { command: 'x' } }, resources: ['file://../../../etc/passwd'] });
  const bad = await ed.req('POST', `/api/projects/${pid}/kiro-agents/import`, { files: [{ path: 'my/.kiro/agents/../../../x.json', content: b64('{}') }] });
  assert.equal(bad.status, 400);
  const files = [
    { path: 'my/.kiro/agents/up.json', content: b64(agent) },
    { path: 'my/.kiro/agents/up.md', content: b64('Uploaded instructions') },
    { path: 'my/.kiro/settings/mcp.json', content: b64('{"secret":1}') },
  ];
  const preview = await ed.post(`/api/projects/${pid}/kiro-agents/import`, { files });
  assert.deepEqual(preview.agents[0].dropped.sort(), ['MCP servers (admins only)', 'hooks (admins only)']);
  assert.deepEqual(preview.agents[0].skipped, ['file://../../../etc/passwd']);
  await ed.post(`/api/projects/${pid}/kiro-agents/import`, { files, choices: { up: 'import' } });
  const json = JSON.parse(fs.readFileSync(path.join(dir, '.kiro/agents/up.json'), 'utf8'));
  assert.equal(json.prompt, 'Uploaded instructions');
  assert.equal(json.hooks, undefined);
  assert.equal(json.mcpServers, undefined);
  assert.deepEqual(json.resources, []);
  assert.ok(!fs.existsSync(path.join(dir, '.kiro/settings')));

  // A zip that tries to climb out is refused, not quietly renamed.
  const evil = new JSZip();
  evil.file('agents/z.json', '{}');
  evil.file('../../escape.json', '{}');
  const evilZip = (await evil.generateAsync({ type: 'nodebuffer' })).toString('base64');
  assert.equal((await ed.req('POST', `/api/projects/${pid}/kiro-agents/import`, { zip: evilZip })).status, 400);
  const good = new JSZip();
  good.file('.kiro/agents/zipped.json', JSON.stringify({ name: 'zipped', description: 'From a zip', prompt: 'Zipped.' }));
  const res = await ed.post(`/api/projects/${pid}/kiro-agents/import`, { zip: (await good.generateAsync({ type: 'nodebuffer' })).toString('base64'), choices: {} });
  assert.deepEqual(res.imported, ['zipped']);
  for (const n of ['up', 'zipped']) await admin.del(`/api/projects/${pid}/kiro-agents/${n}`);
});

test('a Kiro run led by a project Kiro agent: its own profile and team, with every pre-approval removed', async () => {
  for (const n of ['import-dev', 'import-lead']) await admin.del(`/api/projects/${pid}/kiro-agents/${n}`);
  await putAgent(
    admin,
    'kiro-lead',
    {
      description: 'Tech lead',
      tools: ['*'],
      allowedTools: ['read', 'write', 'shell', '@builtin', 'grep'],
      toolsSettings: {
        shell: { allowedCommands: ['git status'], autoAllowReadonly: true, deniedCommands: ['rm .*'] },
        write: { allowedPaths: ['src/**'] },
        subagent: { availableAgents: ['kiro-backend', 'nobody'], trustedAgents: ['kiro-backend'] },
      },
      hooks: { agentSpawn: [{ command: 'git status' }] },
      resources: ['file://.kiro/steering/**/*.md', 'file://~/.aws/config', `file://${tmp.replace(/\\/g, '/')}/x.md`],
      permissions: { rules: [{ capability: 'execute_bash', match: ['**'], effect: 'allow' }] },
      includeMcpJson: true,
      model: 'claude-sonnet-4.6',
      welcomeMessage: 'Hi',
    },
    'You are the tech lead.',
  );
  await putAgent(admin, 'kiro-backend', { description: 'Backend specialist', tools: ['*', 'subagent'], allowedTools: ['read', 'shell'], toolsSettings: { subagent: { availableAgents: ['kiro-lead'] }, shell: { allowedCommands: ['npm test'] } } }, 'You are the backend agent.');
  await putAgent(admin, 'kiro-other', { description: 'Not on the team', tools: ['read'] }, 'Other.');
  write('.claude/agents/claude-only.md', '---\nname: claude-only\ndescription: A Claude Code agent\n---\nx\n');

  clearLog();
  const { run } = await startSingleRun(admin, pid, { prompt: 'Build the API [delegate]', engine: 'kiro', leadAgent: 'kiro-lead', permissionMode: 'acceptEdits' });
  const spawn = await waitFor(async () => (await admin.get(`/api/runs/${run.id}`)).inputs.find((i: any) => i.tool_name === 'Subagents' && i.status === 'pending'), 'subagent approval');
  await admin.post(`/api/inputs/${spawn.id}/answer`, { decision: 'allow', inputHash: spawn.payload.inputHash });
  const done = await waitFor(async () => {
    const r = await admin.get(`/api/runs/${run.id}`);
    return ['completed', 'failed'].includes(r.run.status) ? r : null;
  }, 'completion');
  assert.equal(done.run.status, 'completed', done.run.error);

  const p = entries().find((e) => e.event === 'start').profile;
  assert.match(p.name, /^agent-portal-[0-9a-f]{8}$/);
  assert.match(p.prompt, /^You are the tech lead\./, 'the lead’s own instructions come first');
  assert.match(p.prompt, new RegExp(`- ${p.name}-kiro-backend — kiro-backend: Backend specialist`));
  assert.match(p.prompt, /Agent Portal rules/);
  assert.ok(!p.prompt.includes('kiro-other'), 'only the lead’s team');
  assert.deepEqual(p.toolsSettings.subagent, { availableAgents: [`${p.name}-kiro-backend`] }, 'per-run names, no trustedAgents, unknown names dropped');
  assert.deepEqual(p.toolsSettings.shell, { deniedCommands: ['rm .*'] }, 'restrictions stay, pre-approvals go');
  assert.equal(p.toolsSettings.write, undefined);
  assert.deepEqual(p.allowedTools, ['read', 'grep']);
  assert.deepEqual(p.permissions, { rules: [{ capability: 'fs_read', match: ['**'], effect: 'allow' }] });
  assert.equal(p.includeMcpJson, false);
  assert.deepEqual(p.mcpServers, {});
  assert.ok(p.tools.includes('subagent') && p.tools.includes('write') && !p.tools.includes('*'));
  assert.deepEqual(p.resources, ['file://.kiro/steering/**/*.md'], 'nothing from the home folder or outside the project');
  assert.deepEqual(p.hooks, { agentSpawn: [{ command: 'git status' }] });
  assert.equal(p.model, 'claude-sonnet-4.6');
  assert.equal(p.welcomeMessage, 'Hi');

  const role = entries().find((e) => e.event === 'role-profile');
  assert.equal(role.role, `${p.name}-kiro-backend`);
  assert.match(role.roleProfile.prompt, /You are the backend agent/);
  assert.ok(!role.roleProfile.tools.includes('subagent'), 'a subagent cannot reach other agents');
  assert.equal(role.roleProfile.toolsSettings.subagent, undefined);
  assert.deepEqual(role.roleProfile.allowedTools, ['read']);
  assert.equal(role.roleProfile.toolsSettings.shell, undefined);

  const agentCall = done.events.filter((e: any) => e.type === 'assistant').flatMap((e: any) => e.data.message.content).find((b: any) => b.type === 'tool_use' && b.name === 'Agent');
  assert.equal(agentCall.input.subagent_type, 'kiro-backend', 'runs show the project agent’s name');
  await waitFor(async () => !fs.readdirSync(path.join(dir, '.kiro/agents')).some((f) => f.startsWith('agent-portal-')), 'per-run profiles are removed afterwards');
});

test('leads per engine: Kiro agents lead on Kiro when the project has them, Claude Code agents otherwise', async () => {
  const kiroLeads = (await admin.get(`/api/projects/${pid}/leads?engine=kiro`)).leads;
  assert.deepEqual(kiroLeads.map((l: any) => [l.name, l.kind]), [['kiro-backend', 'kiro'], ['kiro-lead', 'kiro'], ['kiro-other', 'kiro']]);
  assert.deepEqual((await admin.get(`/api/projects/${pid}/leads?engine=claude`)).leads.map((l: any) => l.name), ['claude-only']);

  const ok = await admin.post(`/api/projects/${pid}/workflows`, { goal: 'Kiro lead', start: false, playground: true, leadAgent: 'kiro-lead' });
  assert.equal(ok.workflow.lead_agent, 'kiro-lead');
  const refused = await admin.req('POST', `/api/projects/${pid}/workflows`, { goal: 'Claude lead on Kiro', start: false, playground: true, leadAgent: 'claude-only' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /not an enabled Kiro agent/);
  assert.equal((await admin.req('PUT', `/api/workflows/${ok.workflow.id}`, { leadAgent: 'nobody' })).status, 400);
  assert.equal((await startSingleRunReq(admin, pid, { prompt: 'x', engine: 'kiro', leadAgent: 'claude-only' })).status, 400);

  // Without a lead, the portal's main agent leads and every enabled project Kiro agent is on its team.
  await admin.put(`/api/projects/${pid}/kiro-agents/kiro-other/enabled`, { enabled: false });
  clearLog();
  const { run } = await startSingleRun(admin, pid, { prompt: 'Look around', engine: 'kiro', permissionMode: 'acceptEdits' });
  await finish(admin, run.id);
  const p = entries().find((e) => e.event === 'start').profile;
  assert.deepEqual(p.toolsSettings.subagent.availableAgents, [`${p.name}-kiro-backend`, `${p.name}-kiro-lead`], 'disabled agents are left out');
  assert.match(p.prompt, /You run inside Agent Portal/);
});

test('PUT /api/workflows/:id with engine switch validates lead against the new engine', async () => {
  // Re-enable kiro-other so we have a clean project with all Kiro agents.
  await admin.put(`/api/projects/${pid}/kiro-agents/kiro-other/enabled`, { enabled: true });

  // Create a workflow on the default Kiro engine (engine: '' = project default = kiro) with no lead.
  const { workflow } = await admin.post(`/api/projects/${pid}/workflows`, { goal: 'Engine switch test', start: false, playground: true });
  assert.equal(workflow.engine, '');

  // Setting a Kiro-only lead on kiro engine (explicit) is accepted.
  const kiroOk = await admin.req('PUT', `/api/workflows/${workflow.id}`, { engine: 'kiro', leadAgent: 'kiro-lead' });
  assert.equal(kiroOk.status, 200, `Kiro lead on kiro engine should be accepted: ${JSON.stringify(kiroOk.data)}`);
  assert.equal(kiroOk.data.workflow.engine, 'kiro');
  assert.equal(kiroOk.data.workflow.lead_agent, 'kiro-lead');

  // Setting a .claude-only agent as lead on kiro engine is refused (Kiro uses kiro agents, not claude agents).
  const claudeAsLeadRefused = await admin.req('PUT', `/api/workflows/${workflow.id}`, { engine: 'kiro', leadAgent: 'claude-only' });
  assert.equal(claudeAsLeadRefused.status, 400, `Claude-only agent should be refused on kiro engine: ${JSON.stringify(claudeAsLeadRefused.data)}`);
  assert.match(claudeAsLeadRefused.data.error, /not an enabled Kiro agent/);

  // Setting a non-existent agent is refused on any engine.
  const nobody = await admin.req('PUT', `/api/workflows/${workflow.id}`, { engine: 'kiro', leadAgent: 'nobody-agent' });
  assert.equal(nobody.status, 400, `Non-existent agent should be refused: ${JSON.stringify(nobody.data)}`);

  // Clearing the lead (empty string) always works.
  const cleared = await admin.req('PUT', `/api/workflows/${workflow.id}`, { engine: 'kiro', leadAgent: '' });
  assert.equal(cleared.status, 200, `Clearing lead should always work: ${JSON.stringify(cleared.data)}`);
  assert.equal(cleared.data.workflow.lead_agent, '');

  // On the project default engine (kiro as default), kiro agents are accepted as leads.
  const defaultEngineKiroLead = await admin.req('PUT', `/api/workflows/${workflow.id}`, { engine: '', leadAgent: 'kiro-backend' });
  assert.equal(defaultEngineKiroLead.status, 200, `Kiro lead on default-kiro engine should be accepted: ${JSON.stringify(defaultEngineKiroLead.data)}`);
  assert.equal(defaultEngineKiroLead.data.workflow.engine, '');
  assert.equal(defaultEngineKiroLead.data.workflow.lead_agent, 'kiro-backend');

  // On the project default engine (kiro as default), claude-only agents are rejected as leads.
  const defaultEngineClaudeLeadRefused = await admin.req('PUT', `/api/workflows/${workflow.id}`, { engine: '', leadAgent: 'claude-only' });
  assert.equal(defaultEngineClaudeLeadRefused.status, 400, `Claude-only agent should be refused on default-kiro engine: ${JSON.stringify(defaultEngineClaudeLeadRefused.data)}`);
  assert.match(defaultEngineClaudeLeadRefused.data.error, /not an enabled Kiro agent/);

  // Cleanup.
  await admin.del(`/api/workflows/${workflow.id}`);
});

test('a project without Kiro agents does not borrow its .claude agents on Kiro (D-12)', async () => {
  const { project } = await admin.post('/api/projects', { name: 'Claude only', description: 'd' });
  const other = path.join(srv.dataDir, 'projects', project.slug);
  fs.mkdirSync(path.join(other, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(other, '.claude', 'agents', 'backend-agent.md'), '---\nname: backend-agent\ndescription: Builds the API\n---\nYou build backend code.\n');
  assert.deepEqual((await admin.get(`/api/projects/${project.id}/leads?engine=kiro`)).leads, [], 'Kiro offers no .claude agent');
  assert.equal((await admin.get(`/api/projects/${project.id}/leads?engine=claude`)).leads.length, 1, 'Claude still does');
  const refused = await startSingleRunReq(admin, project.id, { prompt: 'Look around', leadAgent: 'backend-agent', permissionMode: 'acceptEdits' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /not an enabled Kiro agent/);
});
