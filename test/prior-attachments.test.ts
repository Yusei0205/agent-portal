/**
 * Files attached to an earlier message are put back for every later turn (a later turn starts on a fresh machine, and the agent used to
 * search the whole disk for a scan zip it had been given two messages ago).
 */
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { stagePriorAttachments } from '../server/session-attachments.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import { _setEngineOverride } from '../server/agent/runner.ts';
import { config } from '../server/config.ts';

let baseUrl: string, cookie: string, projectId: string, slug: string;
before(async () => {
  ({ baseUrl } = await createTestServer());
  cookie = (await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `prior-${Date.now()}@test.com`, password: 'password1234', name: 'Admin', provider: 'demo' } })).cookie!;
  const project = await fetchJson(baseUrl, '/api/projects', { method: 'POST', cookie, body: { name: 'Prior files' } });
  projectId = (project.body as { project: { id: string } }).project.id;
  slug = ((await fetchJson(baseUrl, '/api/projects/' + projectId, { cookie })).body as { project: { slug: string } }).project.slug;
});
after(async () => { _setEngineOverride(null); await cleanup(); });

// Built once: a zip carries the time it was made (to the second), so two builds can differ.
let zipBytes: Buffer | null = null;
const realZip = async (): Promise<Buffer> => zipBytes ??= await (async () => { const z = new JSZip(); z.file('findings.csv', 'a,b,1,2'); return z.generateAsync({ type: 'nodebuffer' }); })();
const upload = async (name: string, data: string | Buffer): Promise<string> => {
  const form = new FormData();
  form.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), name);
  const r = await fetch(baseUrl + '/api/projects/' + projectId + '/ai-attachments', { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'agent-portal' }, body: form });
  assert.equal(r.status, 201);
  return ((await r.json()) as { attachment: { id: string } }).attachment.id;
};
const session = async (goal: string): Promise<string> => {
  const r = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows', { method: 'POST', cookie, body: { goal, engine: 'demo', start: false } });
  return String(((r.body as { workflow: { id: string } }).workflow).id);
};
const send = async (wid: string, message: string, files: Array<[string, string | Buffer]> = []) => {
  const attachmentIds = [];
  for (const [n, d] of files) attachmentIds.push(await upload(n, d));
  const r = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows/' + wid + '/message', { method: 'POST', cookie, body: files.length ? { message, attachmentIds } : { message } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const attachmentsOf = async (wid: string) => {
  const events = await getSessionsRepository().listHumanWorkflowEvents(wid, null, null, null);
  return events.flatMap((e) => (JSON.parse(e.data || '{}').attachments ?? []) as Array<{ path: string; name: string; size: number }>);
};
const workDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'prior-work-'));
const listed = async (dir: string) => (await fs.readdir(path.join(dir, 'attachments')).catch(() => [])).sort();

describe('earlier attachments are put back', () => {
  it('a file attached to message 1 is there for a turn that has no attachment of its own', async () => {
    const wid = await session('Check the scan');
    await send(wid, 'here is the scan', [['sonarscan.zip', await realZip()]]);
    await send(wid, 'now summarise it');
    const [first] = await attachmentsOf(wid);
    const dir = await workDir();
    const r = await stagePriorAttachments(projectId, wid, [], dir);
    assert.deepEqual(r.staged.map((a) => a.name), ['sonarscan.zip']);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(await listed(dir), [first.path]);
    assert.deepEqual(await fs.readFile(path.join(dir, 'attachments', first.path)), await realZip());
  });

  it('the same file attached again is one file, the current message\'s own files are not brought back twice, and the newest copy wins', async () => {
    const wid = await session('Dedupe');
    await send(wid, 'one', [['report.txt', 'same']]);
    await send(wid, 'again', [['report.txt', 'same']]);
    await send(wid, 'other', [['notes.txt', 'notes']]);
    const all = await attachmentsOf(wid);
    const dir = await workDir();
    const r = await stagePriorAttachments(projectId, wid, [all[2]], dir);
    assert.deepEqual(r.staged.map((a) => a.name), ['report.txt'], 'notes.txt is the current one; report.txt twice is one');
    assert.equal(r.staged[0].path, all[1].path, 'the newest copy');
    assert.deepEqual(await listed(dir), [all[1].path]);
  });

  it('only what came after the last /clear', async () => {
    const wid = await session('Clear');
    await send(wid, 'before', [['old.txt', 'old']]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows/' + wid + '/message', { method: 'POST', cookie, body: { message: '/clear' } })).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    await send(wid, 'after', [['new.txt', 'new']]);
    const dir = await workDir();
    const r = await stagePriorAttachments(projectId, wid, [], dir);
    assert.deepEqual(r.staged.map((a) => a.name), ['new.txt']);
  });

  it('what does not fit is reported as skipped, newest first fill the room, and a file that is gone never fails the turn', async () => {
    const wid = await session('Limits');
    // 3 files of 1.5 MB: the inline total is 8 MB, so all fit; make them not fit with a per-file limit instead (2 MB without large files).
    await send(wid, 'a', [['small.txt', 'small']]);
    await send(wid, 'b', [['gone.txt', 'will vanish']]);
    const [small, gone] = await attachmentsOf(wid);
    await fs.rm(path.join(config.dataDir, 'projects', slug, 'uploads', wid, 'chat', gone.path));
    const dir = await workDir();
    const r = await stagePriorAttachments(projectId, wid, [], dir);
    assert.deepEqual(r.staged.map((a) => a.name), ['small.txt']);
    assert.deepEqual(r.skipped.map((a) => a.name), ['gone.txt']);
    assert.deepEqual(await listed(dir), [small.path]);
    // Too big for what the runner takes: skipped, not copied.
    const tooBig = { path: small.path, name: 'huge.bin', size: 900 * 1024 * 1024 };
    const dir2 = await workDir();
    const events = await getSessionsRepository().listHumanWorkflowEvents(wid, null, null, null);
    assert.ok(events.length);
    const wid2 = await session('Limits 2');
    await getSessionsRepository().appendWorkflowEvent({ workflow_id: wid2, kind: 'human', body: 'huge', data: JSON.stringify({ attachments: [tooBig] }), created_at: new Date().toISOString() });
    const r2 = await stagePriorAttachments(projectId, wid2, [], dir2);
    assert.deepEqual(r2.staged, []);
    assert.deepEqual(r2.skipped.map((a) => a.name), ['huge.bin']);
    assert.deepEqual(await listed(dir2), []);
  });

  it('a path that is not an upload file name is ignored (no traversal out of the upload folder)', async () => {
    const wid = await session('Hostile');
    await getSessionsRepository().appendWorkflowEvent({
      workflow_id: wid, kind: 'human', body: 'x', created_at: new Date().toISOString(),
      data: JSON.stringify({ attachments: [{ path: '../../../etc/passwd', name: 'passwd', size: 10 }, { path: 'a/b.txt', name: 'b', size: 10 }] }),
    });
    const dir = await workDir();
    const r = await stagePriorAttachments(projectId, wid, [], dir);
    assert.deepEqual(r, { staged: [], skipped: [] });
  });

  it('the real run: turn 2 has no attachment, yet the agent is told about the file and it is in attachments/', async () => {
    const wid = await session('Check the scan');
    await send(wid, 'here is the scan', [['sonarscan.zip', await realZip()]]);
    const [first] = await attachmentsOf(wid);
    const seen: Array<{ goal: string; files: string[] }> = [];
    // A zip is unpacked into a folder of its own name before the agent starts.
    const has = (files: string[]): boolean => files.includes(first.path) || files.includes(first.path.replace(/\.zip$/, ''));
    _setEngineOverride(async (ctx) => {
      seen.push({ goal: ctx.run.goal, files: await fs.readdir(path.join(ctx.run.workDir, 'attachments')).catch(() => [] as string[]) });
      return 'ok';
    });
    const { startRun } = await import('../server/workflows/driver.ts');
    // A turn is over when its run has left running/pending (the test must not end while the run is still saving its end).
    const waitIdle = async (notRun?: string) => {
      for (let i = 0; i < 300; i++) {
        const run = await getSessionsRepository().getLatestRun(wid);
        if (run && run.id !== notRun && run.status !== 'running' && run.status !== 'pending') return run.id;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the turn did not finish');
    };
    await startRun(wid);
    const firstRun = await waitIdle();
    assert.equal(seen.length, 1);
    assert.ok(has(seen[0].files), 'turn 1 has its own file: ' + JSON.stringify(seen[0].files));
    assert.doesNotMatch(seen[0].goal, /earlier messages/, 'nothing earlier to bring back in turn 1');

    await send(wid, 'now summarise the scan');
    await startRun(wid);
    await waitIdle(firstRun);
    assert.equal(seen.length, 2);
    assert.ok(has(seen[1].files), 'the scan is back in attachments/ for turn 2: ' + JSON.stringify(seen[1].files));
    assert.match(seen[1].goal, /attached to earlier messages in this conversation, available again/);
    assert.match(seen[1].goal, /"sonarscan\.zip" — attachments\//);
    assert.match(seen[1].goal, /a zip, already unpacked into attachments\//, 'and the agent is told where the unpacked copy is');
  });
});
