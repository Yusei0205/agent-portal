import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one, all } from '../server/db.ts';
import { stageChatAttachments } from '../server/session-attachments.ts';
import { collectInputFiles } from '../server/agent/runner-files.ts';
import { config } from '../server/config.ts';

let baseUrl: string, cookie: string, projectId: string, workflowId: string;
before(async () => {
  ({ baseUrl } = await createTestServer());
  const setup = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: 'chat-files@test.com', password: 'password1234', name: 'Admin', provider: 'demo' } });
  cookie = setup.cookie!;
  const project = await fetchJson(baseUrl, '/api/projects', { method: 'POST', cookie, body: { name: 'Chat files' } });
  projectId = (project.body as { project: { id: string } }).project.id;
  const workflow = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows', { method: 'POST', cookie, body: { goal: 'Read attachments', engine: 'demo' } });
  workflowId = (workflow.body as { workflow: { id: string } }).workflow.id;
});
after(cleanup);

async function upload(name: string, data: string, pid = projectId): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([data]), name);
  const response = await fetch(baseUrl + '/api/projects/' + pid + '/ai-attachments', { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'agent-portal' }, body: form });
  assert.equal(response.status, 201);
  return ((await response.json()) as { attachment: { id: string } }).attachment.id;
}
const message = (body: object) => fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows/' + workflowId + '/message', { method: 'POST', cookie, body });

describe('chat attachment delivery', () => {
  it('accepts attachment-only messages, snapshots uploads, and stages runner bytes', async () => {
    const id = await upload('requirements.txt', 'Requirements for the agent');
    const sent = await message({ attachmentIds: [id] });
    assert.equal(sent.status, 200);
    const event = one<{ body: string; data: string }>('SELECT body, data FROM p6_workflow_events WHERE workflow_id = ? ORDER BY id DESC LIMIT 1', workflowId)!;
    assert.equal(event.body, 'Please read the attached files.');
    const meta = JSON.parse(event.data);
    assert.equal(meta.attachments[0].name, 'requirements.txt');
    // Source cleanup must not remove a file already attached to a saved message.
    const deleted = await fetchJson(baseUrl, '/api/projects/' + projectId + '/ai-attachments/' + id, { method: 'DELETE', cookie });
    assert.equal(deleted.status, 200);
    const dir = path.join(config.dataDir, 'chat-staging-test');
    await fs.mkdir(dir, { recursive: true });
    const staged = await stageChatAttachments(projectId, workflowId, [event], dir);
    const files = collectInputFiles(dir, staged.map(a => 'attachments/' + a.path));
    assert.equal(files.length, 1);
    assert.ok('data' in files[0], 'a small file is sent inline');
    assert.equal(Buffer.from((files[0] as { data: string }).data, 'base64').toString(), 'Requirements for the agent');
    assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM p6_runs WHERE workflow_id = ?', workflowId)!.n, 0, 'saving attachments must not invoke the AI');
  });
  it('keeps a copy of each uploaded file in the Vault, in the User uploads folder of the session, under its own name', async () => {
    const vault = () => all<{ name: string; folder: string; path: string; size_bytes: number; source_workflow_id: string; uploaded_by: string | null }>(
      "SELECT name, folder, path, size_bytes, source_workflow_id, uploaded_by FROM vault_files WHERE project_id = ? AND folder LIKE '%/User uploads' ORDER BY created_at, name", projectId);
    const before = vault().length;
    // A session of its own, so the files of the other tests here are not counted in it.
    const made = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows', { method: 'POST', cookie, body: { goal: 'Vault uploads check', engine: 'demo' } });
    const vaultWf = (made.body as { workflow: { id: string } }).workflow.id;
    const messageTo = (body: object) => fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows/' + vaultWf + '/message', { method: 'POST', cookie, body });
    const first = await upload('Sonar Scan 2026.txt', 'PK-first');
    assert.equal((await messageTo({ message: 'Use this scan', attachmentIds: [first] })).status, 200);
    const again = await upload('Sonar Scan 2026.txt', 'PK-second');
    assert.equal((await messageTo({ message: 'And this newer one', attachmentIds: [again] })).status, 200);
    const added = vault().slice(before);
    assert.deepEqual(added.map((f) => f.name), ['Sonar Scan 2026.txt', 'Sonar Scan 2026 (2).txt'], 'the same name twice keeps both');
    for (const f of added) {
      assert.equal(f.folder, `Sessions/Vault uploads check (${vaultWf.slice(0, 8)})/User uploads`);
      assert.equal(f.source_workflow_id, vaultWf);
      assert.ok(f.uploaded_by, 'who uploaded it');
    }
    assert.equal(await fs.readFile(path.join(config.dataDir, ...added[0].path.split('/')), 'utf8'), 'PK-first');
    assert.equal(await fs.readFile(path.join(config.dataDir, ...added[1].path.split('/')), 'utf8'), 'PK-second');
    // The agent still gets the file the usual way, and nothing started a run.
    assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM p6_runs WHERE workflow_id = ?', vaultWf)!.n, 0);
  });
  it('a message with a file is still saved when the Vault copy cannot be made', async () => {
    const { setVaultFilesRepository, getVaultFilesRepository } = await import('../server/repositories/vault-files.ts');
    const real = getVaultFilesRepository();
    setVaultFilesRepository(Object.assign(Object.create(real), { create: async () => { throw new Error('vault is full'); } }) as typeof real);
    try {
      const made = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows', { method: 'POST', cookie, body: { goal: 'Vault broken check', engine: 'demo' } });
      const wf = (made.body as { workflow: { id: string } }).workflow.id;
      const id = await upload('plain.txt', 'still delivered');
      const sent = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows/' + wf + '/message', { method: 'POST', cookie, body: { message: 'Read this one', attachmentIds: [id] } });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const event = one<{ data: string }>("SELECT data FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'human' ORDER BY id DESC LIMIT 1", wf)!;
      assert.equal(JSON.parse(event.data).attachments[0].name, 'plain.txt');
      // ...and the person is told the copy was not kept (the message above still went through).
      assert.deepEqual(sent.body, { ok: true, kind: 'human', resumed: false, vaultNotSaved: [{ name: 'plain.txt', reason: 'vault is full' }] });
    } finally { setVaultFilesRepository(real); }
  });
  it('keeps a file bigger than the Vault page upload limit (a 47 MB scan zip was silently skipped before)', async () => {
    const { saveUploadsToVault } = await import('../server/session-attachments.ts');
    const made = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows', { method: 'POST', cookie, body: { goal: 'Big upload check', engine: 'demo' } });
    const wf = (made.body as { workflow: { id: string } }).workflow;
    const slug = ((await fetchJson(baseUrl, '/api/projects/' + projectId, { cookie })).body as { project: { slug: string } }).project.slug;
    const dir = path.join(config.dataDir, 'projects', slug, 'uploads', wf.id, 'chat');
    await fs.mkdir(dir, { recursive: true });
    const size = 47 * 1024 * 1024;
    await fs.writeFile(path.join(dir, 'big.zip'), Buffer.alloc(size, 7));
    const result = await saveUploadsToVault({ id: wf.id, project_id: projectId, title: null, goal: 'Big upload check' }, [{ path: 'big.zip', name: 'sonarscan_20261112.zip', size }], null);
    assert.deepEqual(result, { saved: ['sonarscan_20261112.zip'], failed: [] });
    const row = one<{ size_bytes: number; folder: string; mime_type: string; path: string }>("SELECT size_bytes, folder, mime_type, path FROM vault_files WHERE source_workflow_id = ?", wf.id)!;
    assert.equal(row.size_bytes, size);
    assert.equal(row.mime_type, 'application/zip');
    assert.match(row.folder, /\/User uploads$/);
    assert.equal((await fs.stat(path.join(config.dataDir, ...row.path.split('/')))).size, size, 'the whole file was copied');
  });
  it('rejects malformed, foreign-project, oversized attachments and slash commands before saving a message', async () => {
    const count = () => all('SELECT id FROM p6_workflow_events WHERE workflow_id = ?', workflowId).length;
    const before = count();
    for (const attachmentIds of ['not-an-array', [null], ['missing'], Array(6).fill('x')]) {
      assert.equal((await message({ message: 'Read this', attachmentIds })).status, 400);
    }
    const other = await fetchJson(baseUrl, '/api/projects', { method: 'POST', cookie, body: { name: 'Other files' } });
    const foreign = await upload('foreign.txt', 'private', (other.body as { project: { id: string } }).project.id);
    assert.equal((await message({ message: 'Read this', attachmentIds: [foreign] })).status, 400);
    const own = await upload('note.txt', 'notes');
    assert.equal((await message({ message: '/cost', attachmentIds: [own] })).status, 400);
    const large = await upload('large.txt', 'a'.repeat(2 * 1024 * 1024 + 1));
    assert.equal((await message({ message: 'Read this', attachmentIds: [large] })).status, 400);
    assert.equal(count(), before);
  });
  it('rejects traversal and does not follow symlinks or overwrite hardlinked files', async () => {
    const event = one<{ data: string }>('SELECT data FROM p6_workflow_events WHERE workflow_id = ? ORDER BY id LIMIT 1', workflowId)!;
    const attachment = JSON.parse(event.data).attachments[0];
    const dir = path.join(config.dataDir, 'chat-link-test');
    await fs.mkdir(path.join(dir, 'attachments'), { recursive: true });
    const protectedFile = path.join(config.dataDir, 'protected-test.txt');
    await fs.writeFile(protectedFile, 'keep this content');
    await fs.link(protectedFile, path.join(dir, 'attachments', attachment.path));
    await stageChatAttachments(projectId, workflowId, [event], dir);
    assert.equal(await fs.readFile(protectedFile, 'utf8'), 'keep this content');
    const symlinkDir = path.join(config.dataDir, 'chat-symlink-test');
    await fs.mkdir(symlinkDir, { recursive: true });
    await fs.symlink(dir, path.join(symlinkDir, 'attachments'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(stageChatAttachments(projectId, workflowId, [event], symlinkDir), /Invalid attachment directory/);
    await assert.rejects(stageChatAttachments(projectId, workflowId, [{ data: JSON.stringify({ attachments: [{ path: '../outside.txt', name: 'outside', size: 1 }] }) }], dir), /Invalid attachment path/);
  });

  it('sends the actual attached file to the runner only when the user sends a message', async () => {
    const id = await upload('next.txt', 'Next turn attachment');
    assert.equal((await message({ message: 'Read next file', attachmentIds: [id] })).status, 200);
    const started = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows/' + workflowId + '/start', { method: 'POST', cookie });
    assert.equal(started.status, 201);
    for (let i = 0; i < 100; i++) {
      const workflow = one<{ status: string; work_dir: string }>('SELECT status, work_dir FROM p6_workflows WHERE id = ?', workflowId)!;
      if (workflow.status === 'done' || workflow.status === 'failed') {
        assert.equal(workflow.status, 'done');
        const entries = await fs.readdir(path.join(workflow.work_dir, 'attachments'));
        assert.equal(entries.length, 2);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Runner did not finish');
  });
});
