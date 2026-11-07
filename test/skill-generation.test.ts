import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let admin: Client;
let viewer: Client;
let pid: string;
let docId: string;
const policy = '# Coding rules\n\nUse explicit return types for exported functions.\n\n# Code review\n\nA reviewer must approve changes before merging.\n';
before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);
  viewer = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'test-password-long' });
  await admin.post('/api/users', { email: 'viewer@example.com', name: 'Viewer', password: 'test-password-long' });
  await viewer.post('/api/auth/login', { email: 'viewer@example.com', password: 'test-password-long' });
  pid = (await admin.post('/api/projects', { name: 'Skill generation' })).project.id;
  await admin.post(`/api/projects/${pid}/members`, { email: 'viewer@example.com', access: 'viewer' });
  const uploaded = await admin.ok('PUT', `/api/projects/${pid}/documents?name=Company-policy.md`, undefined, { raw: Buffer.from(policy) });
  docId = uploaded.document.id;
});
after(async () => { await srv?.close(); });

test('document draft stays inactive until reviewed save and cannot overwrite a skill', async () => {
  const beforeSkills = await admin.get(`/api/projects/${pid}/skills`);
  const result = await admin.post(`/api/projects/${pid}/skills/generate`, { docId });
  assert.match(result.draft.body, /explicit return types/);
  assert.match(result.draft.body, /reviewer must approve/);
  assert.deepEqual(result.draft.allowedTools, []);
  assert.ok(result.sources.every((s: any) => s.docId === docId));
  assert.deepEqual(await admin.get(`/api/projects/${pid}/skills`), beforeSkills);
  const run = await admin.get(`/api/runs/${result.runId}`);
  assert.equal(run.run.status, 'completed');
  const draft = { ...result.draft, name: 'reviewed-company-policy', body: result.draft.body + '\nHuman reviewed.', createOnly: true };
  const saved = await admin.put(`/api/projects/${pid}/skills/${draft.name}`, draft);
  assert.equal(saved.skill.enabled, true);
  assert.match(saved.skill.body, /Human reviewed/);
  assert.equal((await admin.req('PUT', `/api/projects/${pid}/skills/${draft.name}`, draft)).status, 409);
  await admin.post(`/api/projects/${pid}/skills/${draft.name}/enabled`, { enabled: false });
  assert.equal((await admin.req('PUT', `/api/projects/${pid}/skills/${draft.name}`, draft)).status, 409);
});

test('generation requires editor and isolates documents by project', async () => {
  assert.equal((await viewer.req('POST', `/api/projects/${pid}/skills/generate`, { docId })).status, 403);
  const other = (await admin.post('/api/projects', { name: 'Other project' })).project.id;
  assert.equal((await admin.req('POST', `/api/projects/${other}/skills/generate`, { docId })).status, 404);
  assert.equal((await admin.req('POST', `/api/projects/${pid}/skills/generate`, {})).status, 400);
  const decisions = (await admin.get(`/api/projects/${pid}/documents`)).documents.find((d: any) => d.kind === 'decisions');
  assert.equal((await admin.req('POST', `/api/projects/${pid}/skills/generate`, { docId: decisions.id })).status, 400);
});

test('unreadable and oversized source documents are rejected before generation', async () => {
  const { run } = await import('../server/db.ts');
  run('UPDATE sections SET content = ? WHERE doc_id = ?', ' ', docId);
  assert.equal((await admin.req('POST', `/api/projects/${pid}/skills/generate`, { docId })).status, 400);
  run('UPDATE sections SET content = ? WHERE doc_id = ?', 'x'.repeat(60_001), docId);
  assert.equal((await admin.req('POST', `/api/projects/${pid}/skills/generate`, { docId })).status, 400);
});

test('invalid model drafts fail closed and model tool permissions are ignored', async () => {
  const { validateSkillDraft } = await import('../server/skill-generation.ts');
  for (const value of ['{}', '[]', 'not JSON', JSON.stringify({ name: '../escape', description: 'desc', body: 'text' }), JSON.stringify({ name: 'valid', description: ' ', body: 'text' })]) {
    assert.throws(() => validateSkillDraft(value), (e: any) => e.status === 502);
  }
  const draft = validateSkillDraft(JSON.stringify({ name: 'company-review', description: 'Use when reviewing', body: 'Require review', allowedTools: ['Bash'] }));
  assert.deepEqual(draft.allowedTools, []);
});
