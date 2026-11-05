/**
 * Agent setup files (~/.claude, ~/.kiro) are kept in the storage backend (S3 on Lambda). On Lambda the local
 * disk is /tmp: empty after a restart, and separate for each server instance. The files must survive a restart,
 * and a change made through one server must show through another. Uses an in-memory, versioned storage backend.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { config } from '../server/config.ts';
import { setStorage } from '../server/storage-instance.ts';
import type { StorageBackend } from '../server/storage/index.ts';

const objects = new Map<string, Buffer>();
const versions = new Map<string, number>();
let version = 0;
const storage: StorageBackend = {
  async write(p, d) { objects.set(p, d); versions.set(p, ++version); return p; },
  async read(p) { const v = objects.get(p); if (!v) throw new Error('missing'); return v; },
  async delete(p) { objects.delete(p); versions.delete(p); },
  async exists(p) { return objects.has(p); },
  async list(prefix) { return [...objects.keys()].filter((k) => k.startsWith(prefix)); },
  async listVersions(prefix) {
    return [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ path: k, version: String(versions.get(k)) }));
  },
  async publicUrl(p) { return p; },
  async ping() {},
};

const agentFile = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nYou help with ${description}.\n`;

describe('agent setup files are kept in storage', () => {
  let baseUrl = '';
  let cookie = '';
  let prefix = '';
  let savedBackend: string | undefined;

  /** A Lambda restart, or a request served by another instance: this server's local copy is gone. */
  const restart = (): void => fs.rmSync(path.join(config.dataDir, 'user-config'), { recursive: true, force: true });
  const storedPaths = (): string[] => [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
  const agentNames = async (): Promise<string[]> => {
    const r = await fetchJson(baseUrl, '/api/user-config/agents?engine=claude-code', { cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return ((r.body as { agents: Array<{ name: string }> }).agents).map((a) => a.name).sort();
  };
  const readFile = async (rel: string) => fetchJson(baseUrl, `/api/user-config/claude/file?path=${encodeURIComponent(rel)}`, { cookie });

  before(async () => {
    savedBackend = process.env.STORAGE_BACKEND;
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    process.env.STORAGE_BACKEND = 's3';
    setStorage(storage);
    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'durable-cfg@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'durable-cfg@example.com', password: 'password1234' } })).cookie ?? '';
  });

  after(async () => {
    if (savedBackend === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = savedBackend;
    await cleanup();
  });

  it('a saved agent is stored, and is still listed and readable after a restart', async () => {
    const created = await fetchJson(baseUrl, '/api/user-config/claude/file', {
      method: 'POST', cookie, body: { path: 'agents/reviewer.md', content: agentFile('reviewer', 'code review') },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const key = [...objects.keys()].find((k) => /^user-config\/[^/]+\/claude\/agents\/reviewer\.md$/.test(k));
    assert.ok(key, `stored under user-config/<user>/claude: ${[...objects.keys()].join(', ')}`);
    prefix = key.slice(0, key.length - 'agents/reviewer.md'.length);
    assert.deepEqual(storedPaths(), ['agents/reviewer.md']);

    restart();
    assert.deepEqual(await agentNames(), ['reviewer'], 'workspace and session agent pickers list it');
    const tree = await fetchJson(baseUrl, '/api/user-config/claude/tree?path=agents', { cookie });
    assert.ok(JSON.stringify(tree.body).includes('reviewer.md'), JSON.stringify(tree.body));

    restart();
    const read = await readFile('agents/reviewer.md');
    assert.equal(read.status, 200, 'opening the file works, not "File not found"');
    assert.ok(String((read.body as { content: string }).content).includes('name: reviewer'));
  });

  it('a change saved through another server is shown here', async () => {
    await storage.write(`${prefix}agents/reviewer.md`, Buffer.from(agentFile('reviewer', 'careful review')));
    const read = await readFile('agents/reviewer.md');
    assert.ok(String((read.body as { content: string }).content).includes('careful review'));
  });

  it('a file added through another server is not overwritten by creating it here', async () => {
    await storage.write(`${prefix}agents/planner.md`, Buffer.from(agentFile('planner', 'planning')));
    const created = await fetchJson(baseUrl, '/api/user-config/claude/file', {
      method: 'POST', cookie, body: { path: 'agents/planner.md', content: agentFile('planner', 'mine') },
    });
    assert.equal(created.status, 409, 'the agent pack keeps files you already have');
    assert.ok(String(objects.get(`${prefix}agents/planner.md`)).includes('planning'));
    assert.deepEqual(await agentNames(), ['planner', 'reviewer']);
  });

  it('a file deleted through another server disappears here', async () => {
    await storage.delete(`${prefix}agents/planner.md`);
    assert.deepEqual(await agentNames(), ['reviewer']);
  });

  it('rename and delete here update storage', async () => {
    const renamed = await fetchJson(baseUrl, '/api/user-config/claude/rename', {
      method: 'PATCH', cookie, body: { from: 'agents/reviewer.md', to: 'agents/code-reviewer.md' },
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.deepEqual(storedPaths(), ['agents/code-reviewer.md']);

    const del = await fetchJson(baseUrl, `/api/user-config/claude/file?path=${encodeURIComponent('agents/code-reviewer.md')}`, { method: 'DELETE', cookie });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.deepEqual(storedPaths(), []);
    restart();
    assert.deepEqual(await agentNames(), []);
  });

  it('importing a zip replaces the stored copy', async () => {
    await fetchJson(baseUrl, '/api/user-config/claude/file', {
      method: 'POST', cookie, body: { path: 'agents/old.md', content: agentFile('old', 'old work') },
    });
    const zip = new JSZip();
    zip.file('agents/imported.md', agentFile('imported', 'imported work'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const res = await fetch(`${baseUrl}/api/user-config/claude/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'X-Requested-With': 'agent-portal', Cookie: cookie, Connection: 'close' },
      body: new Blob([new Uint8Array(buf)]),
    });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(storedPaths(), ['agents/imported.md']);
    restart();
    assert.deepEqual(await agentNames(), ['imported']);
  });
});
