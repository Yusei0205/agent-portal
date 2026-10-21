import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;
let ed: Client;
let viewer: Client;
let pid: string;
let dir: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  ed = new Client(srv.base);
  viewer = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'e@example.com', name: 'Eve', password: 'a-long-password-2' });
  await admin.post('/api/users', { email: 'v@example.com', name: 'Vic', password: 'a-long-password-3' });
  await ed.post('/api/auth/login', { email: 'e@example.com', password: 'a-long-password-2' });
  await viewer.post('/api/auth/login', { email: 'v@example.com', password: 'a-long-password-3' });
  const { project } = await admin.post('/api/projects', { name: 'Config', description: 'd' });
  pid = project.id;
  dir = path.join(srv.dataDir, 'projects', project.slug);
  await admin.post(`/api/projects/${pid}/members`, { email: 'e@example.com', access: 'editor', role: 'Dev' });
  await admin.post(`/api/projects/${pid}/members`, { email: 'v@example.com', access: 'viewer', role: 'Reader' });
});

after(() => srv.close());

const put = (c: Client, p: string, content: string) => c.req('PUT', `/api/projects/${pid}/config/file`, { path: p, content });

test('editors change agents and skills as files; every save is committed and the agent shows up', async () => {
  const agent = '---\nname: api-reviewer\ndescription: Reviews API changes\n---\nCheck every endpoint.\n';
  assert.equal((await put(ed, '.claude/agents/api-reviewer.md', agent)).status, 200);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'agents', 'api-reviewer.md'), 'utf8'), agent);
  assert.match(execFileSync('git', ['log', '--oneline', '-3'], { cwd: dir }).toString(), /Add \.claude\/agents\/api-reviewer\.md \(Eve\)/);
  assert.ok((await ed.get(`/api/projects/${pid}/agents`)).agents.some((a: any) => a.name === 'api-reviewer'), 'the Agents and skills page sees it');
  const read = await viewer.get(`/api/projects/${pid}/config/file?path=${encodeURIComponent('.claude/agents/api-reviewer.md')}`);
  assert.equal(read.content, agent);
  assert.equal((await put(viewer, '.claude/agents/x.md', 'x')).status, 403, 'viewers only read');
  const files = (await ed.get(`/api/projects/${pid}/config/files?root=.claude`)).files.map((f: any) => f.path);
  assert.ok(files.includes('.claude/agents/api-reviewer.md'));
});

test('paths stay inside .claude and .kiro, JSON must be valid, and generated Kiro profiles are hidden', async () => {
  for (const bad of ['../outside.md', '.claude/../../escape.md', '.git/config', 'CLAUDE.md', '.claude//x', '.kiro/agents/agent-portal-1234.json']) {
    assert.equal((await put(admin, bad, 'x')).status, 400, `refused: ${bad}`);
  }
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'projects', 'outside.md')));
  const broken = await put(ed, '.kiro/prompts/notes.json', '{ "a": ');
  assert.equal(broken.status, 400);
  assert.match(broken.data.error, /not valid JSON/);
  fs.mkdirSync(path.join(dir, '.kiro', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.kiro', 'agents', 'agent-portal-abcd.json'), '{}');
  const kiro = (await ed.get(`/api/projects/${pid}/config/files?root=.kiro`)).files.map((f: any) => f.path);
  assert.ok(!kiro.some((p: string) => p.includes('agent-portal-')), 'a run’s own profiles are not listed');
});

test('settings, hooks and MCP config are admin-only, also when deleting the folder around them', async () => {
  const forbidden = await put(ed, '.claude/settings.json', '{"hooks":{}}');
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.data.error, /Only admins/);
  assert.equal((await put(ed, '.claude/hooks/pre.sh', 'echo hi')).status, 403);
  assert.equal((await put(ed, '.kiro/settings/mcp.json', '{}')).status, 403);
  assert.equal((await put(admin, '.claude/settings.json', '{"permissions":{}}')).status, 200);
  assert.equal((await put(admin, '.claude/extra/hooks/x.sh', 'echo')).status, 200);
  assert.equal((await ed.req('DELETE', `/api/projects/${pid}/config/file?path=${encodeURIComponent('.claude/extra')}`)).status, 403, 'a folder holding a hook is admin-only too');
  const listed = (await ed.get(`/api/projects/${pid}/config/files?root=.claude`)).files.find((f: any) => f.path === '.claude/settings.json');
  assert.equal(listed.protected, true);
});

test('zip export and import: added or replaced, never outside the folder, all checked first', async () => {
  const exported = await ed.req('GET', `/api/projects/${pid}/config/export?root=.claude`);
  assert.equal(exported.status, 200);
  const z = await JSZip.loadAsync(exported.buf!);
  assert.ok(z.file('.claude/agents/api-reviewer.md'), 'export keeps the folder name');

  const zip = new JSZip();
  zip.file('skills/release-notes/SKILL.md', '---\nname: release-notes\ndescription: Writes release notes\n---\nList the changes.\n');
  zip.file('.claude/commands/ship.md', 'Ship it.');
  const ok = await ed.req('PUT', `/api/projects/${pid}/config/import?root=.claude`, undefined, { raw: await zip.generateAsync({ type: 'nodebuffer' }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.files.sort(), ['.claude/commands/ship.md', '.claude/skills/release-notes/SKILL.md']);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'release-notes', 'SKILL.md')));

  const evil = new JSZip();
  evil.file('agents/fine.md', 'fine');
  evil.file('../../escape.md', 'nope');
  const refused = await ed.req('PUT', `/api/projects/${pid}/config/import?root=.claude`, undefined, { raw: await evil.generateAsync({ type: 'nodebuffer' }) });
  assert.equal(refused.status, 400);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents', 'fine.md')), 'nothing is written when any entry is refused');

  const sneaky = new JSZip();
  sneaky.file('settings.json', '{}');
  assert.equal((await ed.req('PUT', `/api/projects/${pid}/config/import?root=.claude`, undefined, { raw: await sneaky.generateAsync({ type: 'nodebuffer' }) })).status, 403, 'importing settings is admin-only too');
});
