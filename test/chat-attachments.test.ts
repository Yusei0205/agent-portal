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
    assert.equal(Buffer.from(files[0].data, 'base64').toString(), 'Requirements for the agent');
    assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM p6_runs WHERE workflow_id = ?', workflowId)!.n, 0, 'saving attachments must not invoke the AI');
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
