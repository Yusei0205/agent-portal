import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootServer, Client, type TestServer } from './client.ts';
import { ROLE_TEMPLATES, roleAgents } from '../server/roles.ts';
import { LIBRARY_ROLES } from '../server/roles-library.ts';

let srv: TestServer;
let admin: Client;
let pid: string;
let claude: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  const { project } = await admin.post('/api/projects', { name: 'Roles', description: 'd' });
  pid = project.id;
  claude = path.join(srv.dataDir, 'projects', project.slug, '.claude');
});
after(() => srv.close());

const agentFile = (name: string, on = true) => path.join(claude, on ? 'agents' : '_disabled/agents', `${name}.md`);
const skillDir = (name: string, on = true) => path.join(claude, on ? 'skills' : '_disabled/skills', name);
const apply = (key: string) => admin.post(`/api/projects/${pid}/roles/${key}/apply`);

test('library roles are complete, portable and do not clash with the starter roles', () => {
  assert.equal(LIBRARY_ROLES.length, 8);
  const keys = ROLE_TEMPLATES.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'role keys are unique');
  const agentNames = ROLE_TEMPLATES.flatMap((r) => roleAgents(r).map((a) => a.name));
  assert.equal(new Set(agentNames).size, agentNames.length, 'agent names are unique across all roles');
  for (const r of LIBRARY_ROLES) {
    const have = new Set(r.skills.map((s) => s.name));
    for (const a of roleAgents(r)) {
      assert.match(a.name, /^[a-z0-9-]+$/);
      assert.ok(a.description.length > 10 && a.prompt.length > 200, `${a.name} has a description and instructions`);
      assert.ok(['haiku', 'sonnet', 'opus'].includes(a.model), `${a.name} model`);
      assert.ok(a.tools.length > 0, `${a.name} lists its tools`);
      for (const t of a.tools) assert.match(t, /^[A-Za-z][A-Za-z0-9_]*(\(.{0,200}\))?$/, `${a.name} tool ${t}`);
      assert.ok(!a.tools.includes('PowerShell'), `${a.name} has no PowerShell`);
      assert.ok(!/C:[\\/]Users|stop_gate|block_dangerous|format_on_write/.test(a.prompt), `${a.name} has no local hook or path`);
    }
    for (const s of r.skills) assert.ok(s.body.length > 100 && s.description, `${s.name} skill`);
    assert.equal(have.size, r.skills.length, `${r.key} skills are unique`);
  }
  const doc = LIBRARY_ROLES.find((r) => r.key === 'tech-doc-team')!;
  assert.equal(doc.team!.length, 7);
  assert.match(doc.agent.tools.join(','), /Agent\(doc-architecture-agent/);
  assert.match(doc.agent.prompt, /^## Running inside Agent Portal/);
  assert.match(doc.agent.prompt, /Technical Documentation Lead/, 'the original instructions are kept');
});

test('the roles API lists library roles with their team', async () => {
  const { roles } = await admin.get('/api/roles');
  const doc = roles.find((r: any) => r.key === 'tech-doc-team');
  assert.equal(doc.team.length, 7);
  assert.equal(doc.agent.name, 'doc-lead-agent');
  assert.equal(roles.find((r: any) => r.key === 'aws-backend-engineer').skills.length, 4);
});

test('adding a team role installs every agent, tagged with the role and without hooks', async () => {
  await apply('tech-doc-team');
  const names = ['doc-lead-agent', 'doc-architecture-agent', 'doc-backend-agent', 'doc-table-design-agent', 'doc-api-design-agent', 'doc-security-agent', 'doc-dr-agent', 'doc-testing-agent'];
  for (const n of names) {
    const text = fs.readFileSync(agentFile(n), 'utf8');
    assert.match(text, /^---\nname: /);
    assert.match(text, /tech-doc-team/, `${n} is tagged with its role`);
    assert.ok(!/hooks:/.test(text), `${n} has no hooks`);
  }
  const { agents } = await admin.get(`/api/projects/${pid}/agents`);
  assert.ok(names.every((n) => agents.some((a: any) => a.name === n && a.enabled)));
  const lead = agents.find((a: any) => a.name === 'doc-lead-agent');
  assert.ok(lead.tools.some((t: string) => t.startsWith('Agent(')), 'the lead may start the section writers');
});

test('turning a team role off and on moves all of its agents together', async () => {
  await admin.post(`/api/projects/${pid}/roles/tech-doc-team/enabled`, { enabled: false });
  assert.ok(fs.existsSync(agentFile('doc-lead-agent', false)) && fs.existsSync(agentFile('doc-testing-agent', false)));
  assert.ok(!fs.existsSync(agentFile('doc-lead-agent')) && !fs.existsSync(agentFile('doc-dr-agent')));
  await admin.post(`/api/projects/${pid}/roles/tech-doc-team/enabled`, { enabled: true });
  assert.ok(fs.existsSync(agentFile('doc-dr-agent')) && !fs.existsSync(agentFile('doc-dr-agent', false)));
});

test('a skill shared by two roles survives turning off or removing one of them', async () => {
  await apply('aws-backend-engineer'); // backend-lambda is used by this role and by the backend test engineer
  await apply('backend-test-engineer');
  assert.ok(fs.existsSync(skillDir('backend-lambda')) && fs.existsSync(skillDir('testing-backend')));

  await admin.post(`/api/projects/${pid}/roles/backend-test-engineer/enabled`, { enabled: false });
  assert.ok(fs.existsSync(skillDir('backend-lambda')), 'still on: the backend engineer needs it');
  assert.ok(!fs.existsSync(skillDir('testing-backend')) && fs.existsSync(skillDir('testing-backend', false)), 'its own skill moved');

  await admin.post(`/api/projects/${pid}/roles/backend-test-engineer/enabled`, { enabled: true });
  await admin.del(`/api/projects/${pid}/roles/backend-test-engineer`);
  assert.ok(fs.existsSync(skillDir('backend-lambda')), 'shared skill kept after removal');
  assert.ok(!fs.existsSync(skillDir('testing-backend')) && !fs.existsSync(agentFile('backend-testing-agent')), 'the removed role is gone');
  assert.ok(fs.existsSync(agentFile('backend-agent')), 'the other role is untouched');

  await admin.del(`/api/projects/${pid}/roles/aws-backend-engineer`);
  assert.ok(!fs.existsSync(skillDir('backend-lambda')), 'last user removed: now the shared skill goes');
});

test('removing a team role removes every agent', async () => {
  await admin.del(`/api/projects/${pid}/roles/tech-doc-team`);
  for (const n of ['doc-lead-agent', 'doc-architecture-agent', 'doc-testing-agent']) {
    assert.ok(!fs.existsSync(agentFile(n)) && !fs.existsSync(agentFile(n, false)), `${n} removed`);
  }
});

test('every library role can be added and the project lists its agents and skills', async () => {
  for (const r of LIBRARY_ROLES) await apply(r.key);
  const { agents } = await admin.get(`/api/projects/${pid}/agents`);
  const total = LIBRARY_ROLES.reduce((n, r) => n + roleAgents(r).length, 0);
  assert.ok(agents.filter((a: any) => a.role).length >= total, `all ${total} agents installed`);
  const { skills } = await admin.get(`/api/projects/${pid}/skills`);
  for (const name of ['backend-cdk', 'testing-frontend', 'lead-orchestration', 'pptx-generation', 'make-documents', 'document-code']) {
    assert.ok(skills.some((s: any) => s.name === name), `skill ${name} listed`);
  }
});

/* ---------------- AI delivery team ---------------- */

import { DELIVERY_ROLES } from '../server/roles-delivery.ts';

const DELIVERY = DELIVERY_ROLES[0];

test('delivery team: nine agents, renamed where they clash, each with its own skills', () => {
  assert.equal(DELIVERY_ROLES.length, 1);
  assert.equal(DELIVERY.key, 'ai-delivery-team');
  const agents = roleAgents(DELIVERY);
  assert.deepEqual(agents.map((a) => a.name), [
    'project-manager',
    'delivery-business-analyst',
    'delivery-solution-architect',
    'tech-lead',
    'delivery-qa-engineer',
    'developer',
    'devops-engineer',
    'cloud-infra-engineer',
    'security-reviewer',
  ]);
  const skillNames = new Set(DELIVERY.skills.map((s) => s.name));
  assert.equal(skillNames.size, 12);
  for (const a of agents) {
    assert.ok(a.skills && a.skills.length >= 3, `${a.name} lists its skills`);
    for (const s of a.skills!) assert.ok(skillNames.has(s), `${a.name} uses ${s}, which the role installs`);
    assert.ok(a.skills!.includes('repo-structure') && a.skills!.includes('delivery-conventions'), `${a.name} follows the shared standards`);
    assert.equal(a.model, 'inherit');
    assert.match(a.prompt, /^## Running inside Agent Portal/);
    assert.ok(!/(?<![\w-])(business-analyst|solution-architect|qa-engineer)(?![\w-])/.test(a.prompt), `${a.name} only uses the renamed agents`);
  }
});

test('delivery team: the orchestrator and conventions keep the system together', () => {
  const deliver = DELIVERY.skills.find((s) => s.name === 'deliver-project')!;
  assert.match(deliver.body, /Running inside Agent Portal/);
  for (const n of ['delivery-business-analyst', 'delivery-solution-architect', 'delivery-qa-engineer', 'tech-lead', 'developer', 'cloud-infra-engineer']) {
    assert.ok(deliver.body.includes(n), `the orchestrator knows ${n}`);
  }
  assert.ok(deliver.body.includes('01-requirements-business-analyst.md'), 'handoff file names are untouched');
  assert.ok(!/Follow `CLAUDE\.md`/.test(deliver.body), 'it follows the conventions skill, not CLAUDE.md');
  const conv = DELIVERY.skills.find((s) => s.name === 'delivery-conventions')!;
  for (const marker of ['REQ-FR-###', 'STORY-###', 'TC-<story>', 'Coordination protocol', 'Global rules', 'terraform apply']) {
    assert.ok(conv.body.includes(marker), `conventions keep "${marker}"`);
  }
  assert.ok(conv.body.includes('`delivery-qa-engineer`') && !conv.body.includes('`qa-engineer`'), 'the team table uses the renamed agents');
  assert.ok(!/^# AI Delivery Team . Project Conventions/m.test(conv.body), 'the original title line is replaced');
});

test('delivery team installs next to the starter roles with every agent and its own skills', async () => {
  await apply('business-analyst'); // starter role with the original agent name
  await apply('qa-engineer');
  await apply('ai-delivery-team');
  for (const n of ['business-analyst', 'qa-engineer', 'delivery-business-analyst', 'delivery-qa-engineer', 'delivery-solution-architect', 'project-manager', 'tech-lead', 'developer', 'devops-engineer', 'cloud-infra-engineer', 'security-reviewer']) {
    assert.ok(fs.existsSync(agentFile(n)), `${n} installed`);
  }
  // each agent file preloads its own skills
  const dev = fs.readFileSync(agentFile('developer'), 'utf8');
  assert.match(dev, /feature-implementation/);
  assert.match(dev, /repo-structure/);
  assert.match(dev, /delivery-conventions/);
  const qa = fs.readFileSync(agentFile('delivery-qa-engineer'), 'utf8');
  assert.match(qa, /test-design/);
  for (const s of DELIVERY.skills) assert.ok(fs.existsSync(path.join(skillDir(s.name), 'SKILL.md')), `skill ${s.name} installed`);
  const { agents } = await admin.get(`/api/projects/${pid}/agents`);
  assert.equal(agents.filter((a: any) => a.role === 'ai-delivery-team').length, 9);
  assert.equal(agents.filter((a: any) => a.name === 'business-analyst').length, 1, 'the starter agent is untouched');
  // switching the whole team off and removing it leaves the starter roles alone
  await admin.post(`/api/projects/${pid}/roles/ai-delivery-team/enabled`, { enabled: false });
  assert.ok(!fs.existsSync(agentFile('developer')) && fs.existsSync(agentFile('business-analyst')));
  await admin.post(`/api/projects/${pid}/roles/ai-delivery-team/enabled`, { enabled: true });
  await admin.del(`/api/projects/${pid}/roles/ai-delivery-team`);
  assert.ok(!fs.existsSync(agentFile('developer')) && !fs.existsSync(skillDir('deliver-project')));
  assert.ok(fs.existsSync(agentFile('business-analyst')) && fs.existsSync(agentFile('qa-engineer')), 'starter roles stay');
});

/* ---------------- Skill template catalog ---------------- */

test('the skill catalog lists every template skill once and installs one on its own', async () => {
  const expected = new Set(ROLE_TEMPLATES.flatMap((r) => r.skills.map((s) => s.name)));
  const { skills } = await admin.get('/api/skill-templates');
  assert.equal(skills.length, expected.size);
  assert.deepEqual(skills.map((s: any) => s.name), [...expected].sort((a, b) => a.localeCompare(b)), 'unique and sorted');
  for (const s of skills) assert.ok(s.description && s.chars > 100 && s.roles.length >= 1, `${s.name} has a description, a body and roles`);
  const lambda = skills.find((s: any) => s.name === 'backend-lambda');
  assert.deepEqual(lambda.roles.map((r: any) => r.key).sort(), ['aws-backend-engineer', 'backend-test-engineer'], 'a shared skill lists every role that uses it');
  assert.ok(skills.some((s: any) => s.name === 'deliver-project') && skills.some((s: any) => s.name === 'frontend-architecture'), 'skills from every source are there');

  const { skill } = await admin.get('/api/skill-templates/test-design');
  assert.match(skill.body, /Test/);

  // a fresh project: install one skill without its role
  const { project } = await admin.post('/api/projects', { name: 'Catalog', description: 'd' });
  const dir = path.join(srv.dataDir, 'projects', project.slug, '.claude/skills/security-review');
  assert.ok(!fs.existsSync(dir));
  await admin.post(`/api/projects/${project.id}/skill-templates/security-review/add`);
  const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: security-review\n/);
  assert.ok(!/portal-role/.test(text), 'a standalone skill is not tied to a role');
  const listed = (await admin.get(`/api/projects/${project.id}/skills`)).skills.map((s: any) => s.name);
  assert.ok(listed.includes('security-review'));
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'projects', project.slug, '.claude/agents/security-reviewer.md')), 'no agent came with it');

  // never overwrites, and unknown names are refused
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: security-review\ndescription: mine\n---\nmy edits\n');
  const again = await admin.req('POST', `/api/projects/${project.id}/skill-templates/security-review/add`);
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already in this project/);
  assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /my edits/, 'the team’s edits are kept');
  assert.equal((await admin.req('POST', `/api/projects/${project.id}/skill-templates/nope/add`)).status, 404);
  assert.equal((await admin.req('GET', '/api/skill-templates/nope')).status, 404);
});
