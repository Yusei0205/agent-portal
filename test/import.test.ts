/**
 * Tests for:
 *  1. Import agents/skills from ZIP, folder entries JSON, and server path
 *  2. Draft agent/skill from a plain-language prompt (Demo mode)
 *
 * Uses the same bootServer / Client helpers as e2e.test.ts.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { bootServer, Client, type TestServer } from './client.ts';

/* ------------------------------------------------------------------ */
/* Shared fixture                                                      */
/* ------------------------------------------------------------------ */

let srv: TestServer;
let admin: Client;
let editor: Client;
let viewer: Client;
let pid: string;
let projectDir: string;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  editor = new Client(srv.base);
  viewer = new Client(srv.base);

  await admin.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'editor@example.com', name: 'Eddie', password: 'a-long-password-2' });
  await admin.post('/api/users', { email: 'viewer@example.com', name: 'Vera', password: 'a-long-password-3' });
  await editor.post('/api/auth/login', { email: 'editor@example.com', password: 'a-long-password-2' });
  await viewer.post('/api/auth/login', { email: 'viewer@example.com', password: 'a-long-password-3' });

  const { project } = await admin.post('/api/projects', { name: 'Import Test', description: 'Project for import tests' });
  pid = project.id;
  projectDir = path.join(srv.dataDir, 'projects', project.slug);

  await admin.post(`/api/projects/${pid}/members`, { email: 'editor@example.com', access: 'editor', role: '' });
  await admin.post(`/api/projects/${pid}/members`, { email: 'viewer@example.com', access: 'viewer', role: '' });
});

after(async () => {
  await srv.close();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Build a minimal agent frontmatter + body string. */
function agentMd(opts: { name: string; description?: string; tools?: string[]; model?: string; skills?: string[]; color?: string }) {
  const fm: Record<string, unknown> = {
    name: opts.name,
    description: opts.description ?? `Use when you need a ${opts.name}.`,
    tools: opts.tools ?? ['Read', 'Grep', 'Glob'],
    skills: opts.skills ?? [],
  };
  if (opts.model && opts.model !== 'inherit') fm.model = opts.model;
  if (opts.color) fm.color = opts.color;
  const lines = ['---', ...Object.entries(fm).map(([k, v]) => Array.isArray(v) ? `${k}: ${JSON.stringify(v)}` : `${k}: ${v}`), '---', '', `You are the ${opts.name} agent.`, ''];
  return lines.join('\n');
}

/** Build a minimal skill SKILL.md string. */
function skillMd(opts: { name: string; description?: string; argumentHint?: string }) {
  const fm: Record<string, unknown> = {
    name: opts.name,
    description: opts.description ?? `Use when you need the ${opts.name} skill.`,
  };
  if (opts.argumentHint) fm['argument-hint'] = opts.argumentHint;
  const lines = ['---', ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), '---', '', `# ${opts.name}`, '', '1. Step one', '2. Step two', ''];
  return lines.join('\n');
}

/** Build a zip with the ai-delivery-team structure (9 agents, 11 skills). */
async function makeDeliveryTeamZip(): Promise<Buffer> {
  const zip = new JSZip();

  const agents = [
    { name: 'business-analyst', tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'], skills: ['requirements-analysis', 'repo-structure'], color: 'blue' },
    { name: 'solution-architect', tools: ['Read', 'Grep', 'Glob', 'Write'], skills: ['solution-architecture', 'repo-structure'] },
    { name: 'developer', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], skills: ['feature-implementation', 'repo-structure'] },
    { name: 'qa-engineer', tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'], skills: ['test-design', 'repo-structure'] },
    { name: 'tech-lead', tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], skills: ['task-breakdown', 'repo-structure'] },
    { name: 'devops-engineer', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], skills: ['cicd-pipeline', 'aws-infrastructure'] },
    { name: 'cloud-infra-engineer', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], skills: ['aws-infrastructure'] },
    { name: 'project-manager', tools: ['Read', 'Grep', 'Glob', 'Write'], skills: ['project-planning', 'task-breakdown'] },
    { name: 'security-reviewer', tools: ['Read', 'Grep', 'Glob'], skills: ['security-review'] },
  ];

  const skills = [
    'requirements-analysis',
    'repo-structure',
    'solution-architecture',
    'feature-implementation',
    'test-design',
    'task-breakdown',
    'cicd-pipeline',
    'aws-infrastructure',
    'project-planning',
    'security-review',
    'deliver-project',
  ];

  for (const a of agents) {
    zip.file(`.claude/agents/${a.name}.md`, agentMd(a));
  }
  for (const s of skills) {
    zip.file(`.claude/skills/${s}/SKILL.md`, skillMd({ name: s }));
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}

/* ------------------------------------------------------------------ */
/* ZIP import                                                          */
/* ------------------------------------------------------------------ */

test('import: preview from zip finds 9 agents and 11 skills', async () => {
  const zipBuf = await makeDeliveryTeamZip();
  const res = await admin.req('POST', `/api/projects/${pid}/builder/import/zip`, undefined, { raw: zipBuf });
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
  const { items, parsed } = res.data;
  const agents = items.filter((i: any) => i.kind === 'agent');
  const skills = items.filter((i: any) => i.kind === 'skill');
  assert.equal(agents.length, 9, `Expected 9 agents, got ${agents.length}`);
  assert.equal(skills.length, 11, `Expected 11 skills, got ${skills.length}`);

  // No invalid items
  const invalid = items.filter((i: any) => i.invalid);
  assert.equal(invalid.length, 0, `Expected no invalid items, got: ${invalid.map((i: any) => `${i.kind}:${i.name} (${i.invalidReasons?.join(', ')})`).join('; ')}`);

  // Verify color is preserved in extra
  const ba = parsed.find((p: any) => p.name === 'business-analyst');
  assert.ok(ba, 'business-analyst in parsed');
  assert.equal(ba.extra?.color, 'blue', 'color extra field preserved');

  // Parsed must have same count
  assert.equal(parsed.length, 20, `Expected 20 parsed items (9+11), got ${parsed.length}`);
});

test('import: confirm from zip writes files and commits', async () => {
  const zipBuf = await makeDeliveryTeamZip();
  const preview = await admin.req('POST', `/api/projects/${pid}/builder/import/zip`, undefined, { raw: zipBuf });
  assert.equal(preview.status, 200);
  const { items, parsed } = preview.data;

  // Accept all items
  const confirmItems = items.map((item: any) => ({ kind: item.kind, name: item.name, choice: 'overwrite' }));

  const result = await admin.post(`/api/projects/${pid}/builder/import/confirm`, { items: confirmItems, parsed });
  assert.equal(result.imported, 20, `Expected 20 imported, got ${result.imported}`);
  assert.equal(result.skipped, 0);

  // Check files exist
  const claudeDir = path.join(projectDir, '.claude');
  assert.ok(fs.existsSync(path.join(claudeDir, 'agents', 'business-analyst.md')), 'business-analyst agent file exists');
  assert.ok(fs.existsSync(path.join(claudeDir, 'skills', 'aws-infrastructure', 'SKILL.md')), 'aws-infrastructure skill exists');

  // Check git history contains a commit
  const { execFileSync } = await import('node:child_process');
  const log = execFileSync('git', ['-C', projectDir, 'log', '--oneline', '-5'], { encoding: 'utf8' });
  assert.ok(log.includes('Import 20'), `Git log should mention Import 20: ${log}`);

  // Check that color extra field was preserved in the written file
  const baContent = fs.readFileSync(path.join(claudeDir, 'agents', 'business-analyst.md'), 'utf8');
  assert.ok(baContent.includes('color: blue'), 'color field preserved in agent file');

  // Verify agents and skills are returned by the API
  const agents = await admin.get(`/api/projects/${pid}/agents`);
  const skills = await admin.get(`/api/projects/${pid}/skills`);
  assert.ok(agents.agents.some((a: any) => a.name === 'business-analyst'), 'business-analyst in agent list');
  assert.ok(skills.skills.some((s: any) => s.name === 'aws-infrastructure'), 'aws-infrastructure in skill list');
});

/* ------------------------------------------------------------------ */
/* Folder entries import                                               */
/* ------------------------------------------------------------------ */

test('import: preview from folder entries', async () => {
  const entries = [
    { path: '.claude/agents/refund-expert.md', content: Buffer.from(agentMd({ name: 'refund-expert', color: 'green' })).toString('base64') },
    { path: '.claude/skills/refund-math/SKILL.md', content: Buffer.from(skillMd({ name: 'refund-math', argumentHint: 'amount' })).toString('base64') },
  ];
  const res = await admin.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  assert.equal(res.items.length, 2);
  const agent = res.items.find((i: any) => i.kind === 'agent');
  const skill = res.items.find((i: any) => i.kind === 'skill');
  assert.ok(agent, 'agent found');
  assert.ok(skill, 'skill found');
  assert.equal(agent.name, 'refund-expert');
  assert.equal(skill.name, 'refund-math');
  // Extra field argument-hint preserved in parsed
  const parsedSkill = res.parsed.find((p: any) => p.name === 'refund-math');
  assert.equal(parsedSkill?.argumentHint, 'amount', 'argument-hint preserved');
});

/* ------------------------------------------------------------------ */
/* Server path import                                                  */
/* ------------------------------------------------------------------ */

test('import: preview from server path (admin)', async () => {
  // Create a temp .claude directory structure
  const tempDir = path.join(srv.dataDir, 'test-claude-import');
  fs.mkdirSync(path.join(tempDir, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '.claude', 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.claude', 'agents', 'my-agent.md'), agentMd({ name: 'my-agent' }));
  fs.writeFileSync(path.join(tempDir, '.claude', 'skills', 'my-skill', 'SKILL.md'), skillMd({ name: 'my-skill' }));

  const res = await admin.post(`/api/projects/${pid}/builder/import/path`, { path: tempDir });
  assert.equal(res.items.length, 2);
  assert.ok(res.items.find((i: any) => i.name === 'my-agent'));
  assert.ok(res.items.find((i: any) => i.name === 'my-skill'));
});

test('import: server path requires admin', async () => {
  const res = await editor.req('POST', `/api/projects/${pid}/builder/import/path`, { path: '/tmp' });
  assert.equal(res.status, 403);
});

test('import: server path rejects nonexistent path', async () => {
  const res = await admin.req('POST', `/api/projects/${pid}/builder/import/path`, { path: '/does/not/exist/at/all' });
  assert.equal(res.status, 404);
});

/* ------------------------------------------------------------------ */
/* Conflict handling                                                   */
/* ------------------------------------------------------------------ */

test('import: conflict detection — existing agents shown as conflict', async () => {
  // business-analyst was imported in the confirm test above
  const entries = [
    { path: 'agents/business-analyst.md', content: Buffer.from(agentMd({ name: 'business-analyst' })).toString('base64') },
  ];
  const res = await admin.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  const agent = res.items.find((i: any) => i.name === 'business-analyst');
  assert.ok(agent, 'business-analyst found in preview');
  assert.equal(agent.conflict, true, 'conflict flag set for existing agent');
});

test('import: skip choice means agent is not overwritten', async () => {
  // Read current content
  const claudeDir = path.join(projectDir, '.claude');
  const originalContent = fs.readFileSync(path.join(claudeDir, 'agents', 'business-analyst.md'), 'utf8');

  const entries = [
    { path: 'agents/business-analyst.md', content: Buffer.from(agentMd({ name: 'business-analyst', description: 'CHANGED DESCRIPTION' })).toString('base64') },
  ];
  const preview = await admin.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  const confirmItems = preview.items.map((i: any) => ({ kind: i.kind, name: i.name, choice: 'skip' }));
  const result = await admin.post(`/api/projects/${pid}/builder/import/confirm`, {
    items: confirmItems,
    parsed: preview.parsed,
  });

  assert.equal(result.skipped, 1);
  assert.equal(result.imported, 0);

  const newContent = fs.readFileSync(path.join(claudeDir, 'agents', 'business-analyst.md'), 'utf8');
  assert.equal(newContent, originalContent, 'file unchanged when skipped');
});

test('import: rename choice writes agent with new name', async () => {
  const entries = [
    { path: 'agents/refund-expert.md', content: Buffer.from(agentMd({ name: 'refund-expert' })).toString('base64') },
  ];
  const preview = await admin.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  const confirmItems = [{ kind: 'agent', name: 'refund-expert', choice: 'rename', renameTo: 'refund-specialist' }];
  const result = await admin.post(`/api/projects/${pid}/builder/import/confirm`, {
    items: confirmItems,
    parsed: preview.parsed,
  });
  assert.equal(result.imported, 1);
  const claudeDir = path.join(projectDir, '.claude');
  assert.ok(fs.existsSync(path.join(claudeDir, 'agents', 'refund-specialist.md')), 'renamed agent file exists');
  assert.ok(!fs.existsSync(path.join(claudeDir, 'agents', 'refund-expert.md')), 'original name not written');
});

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

test('import: invalid agent name flagged in preview', async () => {
  const entries = [
    { path: 'agents/Bad_Name.md', content: Buffer.from(agentMd({ name: 'Bad_Name' })).toString('base64') },
  ];
  const res = await admin.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  const item = res.items[0];
  assert.equal(item.invalid, true, 'bad name should be invalid');
  assert.ok(item.invalidReasons.length > 0, 'invalidReasons present');
});

test('import: unknown tool flagged in preview', async () => {
  const entries = [
    { path: 'agents/test-agent.md', content: Buffer.from(agentMd({ name: 'test-agent', tools: ['Read', 'FakeUnknownTool'] })).toString('base64') },
  ];
  const res = await admin.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  const item = res.items.find((i: any) => i.name === 'test-agent');
  assert.ok(item, 'test-agent found');
  assert.equal(item.invalid, true, 'unknown tool should be invalid');
  assert.ok(item.invalidReasons.some((r: string) => r.includes('FakeUnknownTool')), 'reason mentions the bad tool');
});

test('import: missing referenced skills flagged in preview', async () => {
  const entries = [
    { path: 'agents/agent-with-missing-skill.md', content: Buffer.from(agentMd({ name: 'agent-with-missing-skill', skills: ['nonexistent-skill-xyz'] })).toString('base64') },
  ];
  const res = await admin.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  const item = res.items.find((i: any) => i.name === 'agent-with-missing-skill');
  assert.ok(item, 'agent found in preview');
  assert.ok(item.missingSkills?.includes('nonexistent-skill-xyz'), 'missing skill flagged');
});

test('import: path traversal blocked in skill extra files', async () => {
  const zip = new JSZip();
  zip.file('agents/safe-agent.md', agentMd({ name: 'safe-agent' }));
  zip.file('skills/safe-skill/SKILL.md', skillMd({ name: 'safe-skill' }));
  // Try to include a traversal file - this should be dropped silently
  zip.file('skills/safe-skill/../../evil.md', 'evil content');
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });

  const preview = await admin.req('POST', `/api/projects/${pid}/builder/import/zip`, undefined, { raw: zipBuf });
  assert.equal(preview.status, 200);
  // Confirm and check no evil.md appears
  const confirmItems = preview.data.items.map((i: any) => ({ kind: i.kind, name: i.name, choice: 'overwrite' }));
  await admin.post(`/api/projects/${pid}/builder/import/confirm`, { items: confirmItems, parsed: preview.data.parsed });

  // Make sure evil.md doesn't exist anywhere in project
  const projectRoot = path.join(srv.dataDir, 'projects');
  assert.ok(!fs.existsSync(path.join(projectRoot, 'evil.md')), 'no path traversal to root');
});

/* ------------------------------------------------------------------ */
/* Auth checks                                                         */
/* ------------------------------------------------------------------ */

test('import: viewer cannot import', async () => {
  const zipBuf = await makeDeliveryTeamZip();
  const res = await viewer.req('POST', `/api/projects/${pid}/builder/import/zip`, undefined, { raw: zipBuf });
  assert.equal(res.status, 403, 'viewer should get 403');
});

test('import: editor can preview and confirm', async () => {
  const entries = [
    { path: 'agents/editor-test-agent.md', content: Buffer.from(agentMd({ name: 'editor-test-agent' })).toString('base64') },
  ];
  const preview = await editor.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  assert.ok(preview.items.length > 0);
  const confirmItems = preview.items.map((i: any) => ({ kind: i.kind, name: i.name, choice: 'overwrite' }));
  const result = await editor.post(`/api/projects/${pid}/builder/import/confirm`, { items: confirmItems, parsed: preview.parsed });
  assert.equal(result.imported, 1);
});

/* ------------------------------------------------------------------ */
/* Save to library option                                              */
/* ------------------------------------------------------------------ */

test('import: saveToLibrary copies to shared library', async () => {
  const entries = [
    { path: 'agents/library-agent.md', content: Buffer.from(agentMd({ name: 'library-agent' })).toString('base64') },
  ];
  const preview = await admin.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  const confirmItems = preview.items.map((i: any) => ({ kind: i.kind, name: i.name, choice: 'overwrite' }));
  await admin.post(`/api/projects/${pid}/builder/import/confirm`, { items: confirmItems, parsed: preview.parsed, saveToLibrary: true });

  const lib = await admin.get('/api/library');
  assert.ok(lib.agents.some((a: any) => a.name === 'library-agent'), 'agent saved to shared library');
});

/* ------------------------------------------------------------------ */
/* Draft from prompt (Demo mode)                                       */
/* ------------------------------------------------------------------ */

test('draft: agent draft from description returns valid structure', async () => {
  const res = await editor.post(`/api/projects/${pid}/builder/draft`, {
    kind: 'agent',
    description: 'A security reviewer that checks code for SQL injection and XSS vulnerabilities.',
    useDocuments: false,
  });
  assert.ok(res.draft, 'draft returned');
  assert.equal(res.draft.kind, 'agent');
  assert.ok(res.draft.name, 'name present');
  assert.ok(/^[a-z0-9][a-z0-9-]{0,62}$/.test(res.draft.name), `name valid: ${res.draft.name}`);
  assert.ok(res.draft.description, 'description present');
  assert.ok(res.draft.prompt, 'prompt/instructions present');
  assert.ok(Array.isArray(res.draft.tools), 'tools is array');
  assert.ok(Array.isArray(res.draft.skills), 'skills is array');
  assert.ok(['inherit', 'haiku', 'sonnet', 'opus'].includes(res.draft.model), `model valid: ${res.draft.model}`);
  // All tools must be known
  const { KNOWN_TOOLS } = await import('../server/builder.ts');
  for (const t of res.draft.tools) {
    assert.ok(KNOWN_TOOLS.includes(t), `tool ${t} is in KNOWN_TOOLS`);
  }
});

test('draft: skill draft from description returns valid structure', async () => {
  const res = await editor.post(`/api/projects/${pid}/builder/draft`, {
    kind: 'skill',
    description: 'How to write database migration scripts with proper rollback strategies.',
    useDocuments: false,
  });
  assert.ok(res.draft, 'draft returned');
  assert.equal(res.draft.kind, 'skill');
  assert.ok(res.draft.name, 'name present');
  assert.ok(/^[a-z0-9][a-z0-9-]{0,62}$/.test(res.draft.name), `name valid: ${res.draft.name}`);
  assert.ok(res.draft.description, 'description present');
  assert.ok(res.draft.body, 'body/instructions present');
});

test('draft: requires editor role', async () => {
  const res = await viewer.req('POST', `/api/projects/${pid}/builder/draft`, {
    kind: 'agent',
    description: 'A test agent.',
    useDocuments: false,
  });
  assert.equal(res.status, 403);
});

test('draft: missing description returns 400', async () => {
  const res = await editor.req('POST', `/api/projects/${pid}/builder/draft`, {
    kind: 'agent',
    description: '',
    useDocuments: false,
  });
  assert.equal(res.status, 400);
});

test('draft: nothing is saved until PUT — draft does not create agent automatically', async () => {
  const res = await editor.post(`/api/projects/${pid}/builder/draft`, {
    kind: 'agent',
    description: 'A very-specific-draft agent that detects invoice discrepancies.',
    useDocuments: false,
  });
  assert.ok(res.draft, 'draft returned');
  const draftName = res.draft.name;
  assert.ok(draftName, 'draft has a name');

  // The agent should NOT exist yet — no PUT has been called
  const agents = await admin.get(`/api/projects/${pid}/agents`);
  const found = agents.agents.find((a: any) => a.name === draftName);
  assert.equal(found, undefined, `Agent ${draftName} must not exist until explicitly saved via PUT`);
});

test('draft: model is always valid (sanitized from any AI output)', async () => {
  // In Demo mode the output is fixed, but we verify the endpoint always returns a MODELS member.
  const VALID_MODELS = ['inherit', 'haiku', 'sonnet', 'opus'];
  for (const kind of ['agent', 'skill'] as const) {
    const res = await editor.post(`/api/projects/${pid}/builder/draft`, {
      kind,
      description: `A ${kind} that validates payment amounts for compliance.`,
      useDocuments: false,
    });
    assert.ok(res.draft, `draft returned for ${kind}`);
    if (kind === 'agent') {
      assert.ok(VALID_MODELS.includes(res.draft.model), `model "${res.draft.model}" must be one of ${VALID_MODELS.join(', ')}`);
    }
  }
});

test('draft: budget check is bypassed in Demo mode (draft always succeeds)', async () => {
  // Set a $0 budget — in Demo mode this must not block draft generation
  await admin.put('/api/settings', { budget: { monthlyUsd: 0 } });
  try {
    const res = await editor.post(`/api/projects/${pid}/builder/draft`, {
      kind: 'agent',
      description: 'A payment validator that checks transaction limits.',
      useDocuments: false,
    });
    assert.ok(res.draft, 'draft must still return in Demo mode even with $0 budget');
    assert.equal(res.draft.kind, 'agent');
  } finally {
    // Restore unlimited budget so other tests are unaffected
    await admin.put('/api/settings', { budget: { monthlyUsd: null } });
  }
});

/* ------------------------------------------------------------------ */
/* Oversized / malformed uploads                                       */
/* ------------------------------------------------------------------ */

test('import: oversized zip returns 400 or connection error', async () => {
  // Build a buffer larger than MAX_UPLOAD_BYTES (20 MB).
  // The server may reject with 413 or reset the connection depending on timing.
  const oversize = Buffer.alloc(21 * 1024 * 1024, 0x50); // 21 MB
  try {
    const res = await admin.req('POST', `/api/projects/${pid}/builder/import/zip`, undefined, { raw: oversize });
    // If we get a response, it must be an error status
    assert.ok([400, 413].includes(res.status), `Expected 400 or 413 for oversized upload, got ${res.status}`);
  } catch (e: any) {
    // Connection reset by server (req.destroy()) is also a valid rejection
    assert.ok(
      e?.message?.includes('fetch failed') || e?.message?.includes('ECONNRESET') || e?.message?.includes('UND_ERR'),
      `Expected a network error for oversized upload, got: ${e?.message}`,
    );
  }
});

test('import: empty zip body returns 400', async () => {
  const res = await admin.req('POST', `/api/projects/${pid}/builder/import/zip`, undefined, { raw: Buffer.alloc(0) });
  assert.equal(res.status, 400, 'Empty upload must return 400');
});

test('import: zip with no agents or skills returns 400', async () => {
  const zip = new JSZip();
  zip.file('README.md', '# Nothing here');
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
  const res = await admin.req('POST', `/api/projects/${pid}/builder/import/zip`, undefined, { raw: zipBuf });
  assert.equal(res.status, 400, 'Zip with no agents/skills must return 400');
});

/* ------------------------------------------------------------------ */
/* Extra skill files preserved                                         */
/* ------------------------------------------------------------------ */

test('import: extra skill files are preserved through preview → confirm round-trip', async () => {
  const zip = new JSZip();
  zip.file('.claude/agents/filer-agent.md', agentMd({ name: 'filer-agent', skills: ['filing-skill'] }));
  zip.file('.claude/skills/filing-skill/SKILL.md', skillMd({ name: 'filing-skill' }));
  zip.file('.claude/skills/filing-skill/templates/invoice.md', '# Invoice template\n\n- Line item\n');
  zip.file('.claude/skills/filing-skill/examples.json', JSON.stringify({ example: true }));
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });

  const preview = await admin.req('POST', `/api/projects/${pid}/builder/import/zip`, undefined, { raw: zipBuf });
  assert.equal(preview.status, 200);

  const skill = preview.data.items.find((i: any) => i.kind === 'skill' && i.name === 'filing-skill');
  assert.ok(skill, 'filing-skill in preview');
  assert.equal(skill.extraFileCount, 2, 'Two extra files counted in preview');

  // Confirm import
  const confirmItems = preview.data.items.map((i: any) => ({ kind: i.kind, name: i.name, choice: 'overwrite' }));
  await admin.post(`/api/projects/${pid}/builder/import/confirm`, { items: confirmItems, parsed: preview.data.parsed });

  // Verify extra files were written
  const claudeDir = path.join(projectDir, '.claude');
  const templateFile = path.join(claudeDir, 'skills', 'filing-skill', 'templates', 'invoice.md');
  const examplesFile = path.join(claudeDir, 'skills', 'filing-skill', 'examples.json');
  assert.ok(fs.existsSync(templateFile), 'templates/invoice.md extra file exists after import');
  assert.ok(fs.existsSync(examplesFile), 'examples.json extra file exists after import');
  assert.ok(fs.readFileSync(templateFile, 'utf8').includes('Invoice template'), 'extra file content correct');
});

/* ------------------------------------------------------------------ */
/* Layout variants                                                     */
/* ------------------------------------------------------------------ */

test('import: direct agents/ + skills/ layout (no .claude prefix) works via folder entries', async () => {
  // The user may upload a folder whose top level is agents/ and skills/, not .claude/
  const entries = [
    { path: 'agents/direct-agent.md', content: Buffer.from(agentMd({ name: 'direct-agent' })).toString('base64') },
    { path: 'skills/direct-skill/SKILL.md', content: Buffer.from(skillMd({ name: 'direct-skill' })).toString('base64') },
  ];
  const res = await admin.post(`/api/projects/${pid}/builder/import/folder`, { entries });
  assert.equal(res.items.length, 2, 'Both items found with direct layout');
  assert.ok(res.items.find((i: any) => i.name === 'direct-agent'), 'direct-agent found');
  assert.ok(res.items.find((i: any) => i.name === 'direct-skill'), 'direct-skill found');
});

test('import: root-with-.claude layout works via zip', async () => {
  // Zip has a project root directory containing .claude/agents/ and .claude/skills/
  const zip = new JSZip();
  zip.file('my-project/.claude/agents/root-agent.md', agentMd({ name: 'root-agent' }));
  zip.file('my-project/.claude/skills/root-skill/SKILL.md', skillMd({ name: 'root-skill' }));
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });

  const preview = await admin.req('POST', `/api/projects/${pid}/builder/import/zip`, undefined, { raw: zipBuf });
  assert.equal(preview.status, 200, `Expected 200, got ${preview.status}: ${JSON.stringify(preview.data)}`);
  assert.ok(preview.data.items.find((i: any) => i.name === 'root-agent'), 'root-agent found in nested layout');
  assert.ok(preview.data.items.find((i: any) => i.name === 'root-skill'), 'root-skill found in nested layout');
});

/* ------------------------------------------------------------------ */
/* Real folder import (server path)                                    */
/* ------------------------------------------------------------------ */

const REAL_FOLDER = 'C:\\Users\\tanch\\Desktop\\ai-delivery-team (claude)';

test('import: real ai-delivery-team server path yields 9 agents and 11 skills', async () => {
  // Skip if the folder doesn't exist on this machine
  if (!fs.existsSync(REAL_FOLDER)) {
    // Mark as skipped
    return;
  }
  const res = await admin.post(`/api/projects/${pid}/builder/import/path`, { path: REAL_FOLDER });
  assert.ok(res.items, 'items returned');
  const agents = res.items.filter((i: any) => i.kind === 'agent');
  const skills = res.items.filter((i: any) => i.kind === 'skill');
  const invalid = res.items.filter((i: any) => i.invalid);

  assert.equal(agents.length, 9, `Expected 9 agents from real folder, got ${agents.length}`);
  assert.equal(skills.length, 11, `Expected 11 skills from real folder, got ${skills.length}`);
  assert.equal(invalid.length, 0, `Expected 0 invalid items from real folder, got ${invalid.length}: ${invalid.map((i: any) => i.name).join(', ')}`);

  // Check that business-analyst has color preserved as extra
  const ba = res.parsed?.find((p: any) => p.name === 'business-analyst');
  assert.ok(ba, 'business-analyst in parsed');
  assert.equal(ba.extra?.color, 'blue', 'color extra field preserved from real folder');
});

/* ------------------------------------------------------------------ */
/* Sample folder import (acceptance test)                              */
/* ------------------------------------------------------------------ */

test('import: sample ai-delivery-team zip yields 9 agents and 11 skills with no invalid items', async () => {
  // Create a second project to avoid conflicts from previous tests
  const { project: p2 } = await admin.post('/api/projects', { name: 'Delivery Team', description: 'AI delivery team import test' });
  const p2id = p2.id;

  const zipBuf = await makeDeliveryTeamZip();
  const preview = await admin.req('POST', `/api/projects/${p2id}/builder/import/zip`, undefined, { raw: zipBuf });
  assert.equal(preview.status, 200);
  const { items, parsed } = preview.data;

  const agents = items.filter((i: any) => i.kind === 'agent');
  const skills = items.filter((i: any) => i.kind === 'skill');
  const invalid = items.filter((i: any) => i.invalid);

  assert.equal(agents.length, 9, `Expected 9 agents, got ${agents.length}`);
  assert.equal(skills.length, 11, `Expected 11 skills, got ${skills.length}`);
  assert.equal(invalid.length, 0, `Expected 0 invalid, got ${invalid.length}: ${invalid.map((i: any) => i.name).join(', ')}`);

  // Confirm all items
  const confirmItems = items.map((i: any) => ({ kind: i.kind, name: i.name, choice: 'overwrite' }));
  const result = await admin.post(`/api/projects/${p2id}/builder/import/confirm`, { items: confirmItems, parsed });
  assert.equal(result.imported, 20, `Expected 20 imported total`);

  // Verify via agent/skill API
  const agentsData = await admin.get(`/api/projects/${p2id}/agents`);
  const skillsData = await admin.get(`/api/projects/${p2id}/skills`);
  // project-docs is always present
  assert.ok(agentsData.agents.length >= 9, `At least 9 agents in project`);
  assert.ok(skillsData.skills.length >= 11, `At least 11 skills in project`);
});
