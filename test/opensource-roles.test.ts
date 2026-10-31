/**
 * Open-source roles: skills taken from public Agent Skills repositories (roles-opensource.ts), installed with their
 * reference files and licence, and the shared "AWS documentation" integration.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bootServer, Client, type TestServer } from './client.ts';
import { ROLE_TEMPLATES, roleAgents } from '../server/roles.ts';
import { OPEN_SOURCE_ROLES } from '../server/roles-opensource.ts';

let srv: TestServer;
let admin: Client;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
});
after(() => srv.close());

const SOURCES: Record<string, string> = {
  'aws/agent-toolkit-for-aws': 'Apache-2.0',
  'hashicorp/agent-skills': 'MPL-2.0',
  'microsoft/playwright-cli': 'Apache-2.0',
  'anthropics/skills': 'Apache-2.0',
  'obra/superpowers': 'MIT',
  'wshobson/agents': 'MIT',
};
const LICENCE_TEXT: Record<string, RegExp> = { 'Apache-2.0': /Apache License/, MIT: /Permission is hereby granted, free of charge/, 'MPL-2.0': /Mozilla Public License Version 2\.0/ };

async function newProject(name: string): Promise<{ id: string; dir: string }> {
  const { project } = await admin.post('/api/projects', { name, description: 'd' });
  return { id: project.id, dir: path.join(srv.dataDir, 'projects', project.slug) };
}

test('open-source roles: five roles whose skills all carry a known source, licence and reviewed commit', () => {
  assert.deepEqual(OPEN_SOURCE_ROLES.map((r) => r.key), ['qa-automation-engineer', 'backend-engineer', 'frontend-engineer', 'platform-engineer', 'aws-solutions-engineer']);
  const keys = ROLE_TEMPLATES.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'role keys are unique');
  const agents = ROLE_TEMPLATES.flatMap((r) => roleAgents(r).map((a) => a.name));
  assert.equal(new Set(agents).size, agents.length, 'agent names are unique');
  const skillNames = OPEN_SOURCE_ROLES.flatMap((r) => r.skills.map((s) => s.name));
  assert.equal(skillNames.length, 50);
  assert.equal(new Set(skillNames).size, 50, 'no skill is in two open-source roles');
  const others = new Set(ROLE_TEMPLATES.filter((r) => !OPEN_SOURCE_ROLES.includes(r)).flatMap((r) => r.skills.map((s) => s.name)));
  assert.deepEqual(skillNames.filter((n) => others.has(n)), [], 'no clash with the other roles\' skills');

  for (const r of OPEN_SOURCE_ROLES) {
    const a = r.agent;
    assert.match(a.prompt, /^## Running inside Agent Portal/, `${a.name} starts with the portal notes`);
    assert.ok(a.tools.includes('Skill'), `${a.name} can load skills`);
    assert.ok((a.skills ?? []).every((n) => r.skills.some((s) => s.name === n)), `${a.name} preloads only its own skills`);
    for (const s of r.skills) {
      const src = s.source!;
      assert.ok(src, `${s.name} has a source`);
      assert.equal(src.license, SOURCES[src.repo], `${s.name}: ${src.repo} is a known source with its licence`);
      assert.match(src.commit, /^[0-9a-f]{40}$/);
      assert.equal(src.url, `https://github.com/${src.repo}/tree/${src.commit}/${src.path}`);
      assert.ok(s.description && !s.description.includes('\n'), `${s.name} has a one-line description`);
      assert.ok(s.body.length > 1000 && !s.body.startsWith('---'), `${s.name} has its instructions and no frontmatter of its own`);
      const license = s.files!.find((f) => f.path === 'LICENSE.txt')!;
      assert.match(license.content, LICENCE_TEXT[src.license], `${s.name} carries its licence text`);
      assert.ok(license.content.includes(src.url), `${s.name}: the licence notice names where it comes from`);
      for (const f of s.files!) {
        assert.ok(!/(^|\/)scripts\//.test(f.path), `${s.name}: no scripts (${f.path})`);
        assert.match(f.path, /\.(md|txt|ya?ml|json|tf|hcl|template|tpl|csv)$/, `${s.name}: only text files (${f.path})`);
      }
    }
  }
  // The AWS skills are big, so the AWS lead loads them when needed rather than up front.
  const aws = OPEN_SOURCE_ROLES.find((r) => r.key === 'aws-solutions-engineer')!;
  assert.deepEqual(aws.agent.skills, []);
  assert.equal(aws.skills.length, 17);

  const notices = fs.readFileSync(path.join(import.meta.dirname, '..', 'THIRD_PARTY_SKILLS.md'), 'utf8');
  for (const r of OPEN_SOURCE_ROLES) for (const s of r.skills) assert.ok(notices.includes(s.source!.commit.slice(0, 7)) && notices.includes(`\`${s.name}\``), `THIRD_PARTY_SKILLS.md lists ${s.name}`);
});

test('the roles API shows where each open-source role\'s skills come from', async () => {
  const { roles } = await admin.get('/api/roles');
  const qa = roles.find((r: any) => r.key === 'qa-automation-engineer');
  assert.deepEqual(qa.sources.map((s: any) => s.repo).sort(), ['microsoft/playwright-cli', 'obra/superpowers', 'wshobson/agents']);
  assert.equal(qa.skills.find((s: any) => s.name === 'playwright-cli').source.license, 'Apache-2.0');
  assert.deepEqual(roles.find((r: any) => r.key === 'business-analyst').sources, [], 'the portal\'s own roles have none');
});

test('adding an open-source role writes each skill with its reference files and licence, without allowed-tools', async () => {
  const p = await newProject('Open source roles');
  await admin.post(`/api/projects/${p.id}/roles/aws-solutions-engineer/apply`);
  await admin.post(`/api/projects/${p.id}/roles/qa-automation-engineer/apply`);
  const skills = path.join(p.dir, '.claude', 'skills');

  const cdk = fs.readFileSync(path.join(skills, 'aws-cdk', 'SKILL.md'), 'utf8');
  assert.match(cdk, /^---\nname: aws-cdk\ndescription: /);
  assert.match(cdk, /portal-role: aws-solutions-engineer/);
  assert.match(cdk, /references\/troubleshooting-deployment\.md/, 'the skill points to its reference files');
  assert.ok(fs.existsSync(path.join(skills, 'aws-cdk', 'references', 'troubleshooting-deployment.md')), 'and they are there');
  assert.ok(fs.existsSync(path.join(skills, 'aws-observability', 'references', 'cloudwatch')), 'nested reference folders too');
  assert.ok(!fs.existsSync(path.join(skills, 'aws-observability', 'scripts')), 'scripts are left out');
  assert.match(fs.readFileSync(path.join(skills, 'aws-cdk', 'LICENSE.txt'), 'utf8'), /aws\/agent-toolkit-for-aws[\s\S]*Apache License/);

  // Microsoft's skill pre-approves playwright-cli commands in its own frontmatter; the portal keeps approvals in its hands.
  const pw = fs.readFileSync(path.join(skills, 'playwright-cli', 'SKILL.md'), 'utf8');
  assert.ok(!/allowed-tools/.test(pw), 'no allowed-tools');
  assert.match(pw, /playwright-cli open/);
  assert.match(fs.readFileSync(path.join(skills, 'playwright-cli', 'LICENSE.txt'), 'utf8'), /microsoft\/playwright-cli/);

  const lead = fs.readFileSync(path.join(p.dir, '.claude', 'agents', 'qa-automation-engineer.md'), 'utf8');
  assert.match(lead, /skills: verification-before-completion, e2e-testing-patterns/);
  assert.match(lead, /Skill/);

  const log = execFileSync('git', ['-C', p.dir, 'log', '--oneline', '-3'], { encoding: 'utf8' });
  assert.match(log, /Add role: QA automation engineer/, 'the files are committed to the project');
  const tracked = execFileSync('git', ['-C', p.dir, 'ls-files', '.claude/skills/aws-observability'], { encoding: 'utf8' });
  assert.ok(tracked.split('\n').filter(Boolean).length > 20, 'with every reference file');
});

test('the skill catalog shows the source and licence, lists reference files and installs them', async () => {
  const { skills } = await admin.get('/api/skill-templates');
  const tf = skills.find((s: any) => s.name === 'terraform-style-guide');
  assert.equal(tf.source.repo, 'hashicorp/agent-skills');
  assert.equal(tf.source.license, 'MPL-2.0');
  assert.ok(tf.files >= 2, 'its reference file and LICENSE.txt');
  assert.equal(skills.find((s: any) => s.name === 'test-design').source, null, 'the portal\'s own skills have no source');

  const { skill } = await admin.get('/api/skill-templates/aws-iam');
  assert.ok(skill.files.length > 1 && skill.files.every((f: any) => typeof f.path === 'string' && f.size > 0 && !('content' in f)), 'files are listed, not sent');

  const p = await newProject('One skill');
  await admin.post(`/api/projects/${p.id}/skill-templates/terraform-test/add`);
  const dir = path.join(p.dir, '.claude', 'skills', 'terraform-test');
  assert.ok(fs.readdirSync(dir).includes('LICENSE.txt'));
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE.txt'), 'utf8'), /Mozilla Public License/);
  assert.ok(fs.readdirSync(dir, { recursive: true }).length > 2, 'with its reference files');
});

test('the shared AWS documentation integration is created once, read-only, and stays deleted', async () => {
  const { integrations } = await admin.get('/api/integrations');
  const docs = integrations.find((i: any) => i.name === 'AWS documentation');
  assert.ok(docs, 'it is there');
  assert.equal(docs.kind, 'http');
  assert.equal(docs.allowWrites, false);
  assert.equal(docs.config?.url ?? docs.url, 'https://knowledge-mcp.global.api.aws');

  await admin.del(`/api/integrations/${docs.id}`);
  const { ensureBuiltInAwsDocsIntegration } = await import('../server/integrations.ts');
  ensureBuiltInAwsDocsIntegration(); // what the next start does
  assert.ok(!(await admin.get('/api/integrations')).integrations.some((i: any) => i.name === 'AWS documentation'), 'not created again');
});
