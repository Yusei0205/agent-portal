/**
 * Session files are mirrored to the storage backend (S3 on Lambda) and come back after the local disk is lost.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { config } from '../server/config.ts';
import { setStorage } from '../server/storage-instance.ts';
import type { StorageBackend } from '../server/storage/index.ts';

const objects = new Map<string, Buffer>();
const memory: StorageBackend = {
  async write(p, d) { objects.set(p, d); return p; },
  async read(p) { const v = objects.get(p); if (!v) throw new Error('missing'); return v; },
  async delete(p) { objects.delete(p); },
  async exists(p) { return objects.has(p); },
  async list(prefix) { return [...objects.keys()].filter((k) => k.startsWith(prefix)); },
  async publicUrl(p) { return p; },
  async ping() {},
};

describe('session files mirror', () => {
  let baseUrl = '';
  let cookie = '';
  let workflowId = '';
  let savedBackend: string | undefined;

  before(async () => {
    savedBackend = process.env.STORAGE_BACKEND;
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    process.env.STORAGE_BACKEND = 's3';
    setStorage(memory);
    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'mirror@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'mirror@example.com', password: 'password1234' } })).cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Mirror' }, cookie });
    const projectId = ((p.body as any).project as any).id as string;
    const wf = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: 'g', engine: 'demo' }, cookie });
    workflowId = ((wf.body as any).workflow as any).id as string;
  });

  after(async () => {
    if (savedBackend === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = savedBackend;
    await cleanup();
  });

  it('a file written in the session survives loss of the local disk', async () => {
    const created = await fetchJson(baseUrl, `/api/workflows/${workflowId}/ide/file`, {
      method: 'POST', cookie, body: { scope: 'uploads', path: 'notes/today.md', content: 'hello mirror' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.ok([...objects.keys()].some((k) => k.endsWith('notes/today.md')), 'file is in storage');

    // Simulate a Lambda restart: local disk is gone.
    fs.rmSync(path.join(config.dataDir, 'projects', 'mirror', 'uploads'), { recursive: true, force: true });

    const tree = await fetchJson(baseUrl, `/api/workflows/${workflowId}/ide/tree?scope=uploads&path=notes`, { cookie });
    assert.equal(tree.status, 200, JSON.stringify(tree.body));
    assert.ok(JSON.stringify(tree.body).includes('today.md'), 'listing shows the restored file');

    const read = await fetchJson(baseUrl, `/api/workflows/${workflowId}/ide/file?scope=uploads&path=notes/today.md`, { cookie });
    assert.equal(read.status, 200);
    assert.ok(JSON.stringify(read.body).includes('hello mirror'));
  });

  it('deleting the file removes it from storage', async () => {
    const del = await fetchJson(baseUrl, `/api/workflows/${workflowId}/ide/file?scope=uploads&path=notes/today.md`, { method: 'DELETE', cookie });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok(![...objects.keys()].some((k) => k.endsWith('notes/today.md')));
  });
});
