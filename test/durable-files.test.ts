/**
 * durable-files: files under DATA_DIR are mirrored to the storage backend (S3) only when STORAGE_BACKEND=s3,
 * restored when missing locally, and removed on delete. Uses an in-memory storage backend.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setConfig } from '../server/config.ts';
import { createTestConfig } from './fixtures.ts';
import { setStorage } from '../server/storage-instance.ts';
import type { StorageBackend } from '../server/storage/index.ts';
import { persistFile, restoreFile, forgetFile, restoreTree, forgetTree, persistTree, syncTree } from '../server/durable-files.ts';

function memoryStorage(): StorageBackend & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async write(p, d) { objects.set(p, d); return p; },
    async read(p) { const v = objects.get(p); if (!v) throw new Error('missing'); return v; },
    async delete(p) { objects.delete(p); },
    async exists(p) { return objects.has(p); },
    async list(prefix) { return [...objects.keys()].filter((k) => k.startsWith(prefix)); },
    async publicUrl(p) { return p; },
    async ping() {},
  };
}

describe('durable-files', () => {
  let saved: string | undefined;
  let dir: string;
  let store: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    saved = process.env.STORAGE_BACKEND;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-'));
    setConfig(createTestConfig({ dataDir: dir }));
    store = memoryStorage();
    setStorage(store);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('does nothing when the backend is local', async () => {
    delete process.env.STORAGE_BACKEND;
    const f = path.join(dir, 'vault', 'a.txt');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    await persistFile(f);
    assert.equal(store.objects.size, 0);
    fs.rmSync(f);
    assert.equal(await restoreFile(f), false);
  });

  test('persists, restores after local loss, and forgets', async () => {
    process.env.STORAGE_BACKEND = 's3';
    const f = path.join(dir, 'vault', 'portal', 'a.txt');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'hello');
    await persistFile(f);
    assert.deepEqual([...store.objects.keys()], ['vault/portal/a.txt']);

    fs.rmSync(path.join(dir, 'vault'), { recursive: true });
    assert.equal(await restoreFile(f), true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello');

    await forgetFile(f);
    fs.rmSync(f);
    assert.equal(await restoreFile(f), false);
  });

  test('ignores paths outside DATA_DIR', async () => {
    process.env.STORAGE_BACKEND = 's3';
    const outside = path.join(os.tmpdir(), 'durable-outside.txt');
    fs.writeFileSync(outside, 'x');
    await persistFile(outside);
    assert.equal(store.objects.size, 0);
    fs.rmSync(outside);
  });

  test('restores a whole folder after local loss, but not other folders', async () => {
    process.env.STORAGE_BACKEND = 's3';
    const work = path.join(dir, 'projects', 'p', 'work', 'r1');
    fs.mkdirSync(path.join(work, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(work, 'notes.md'), 'n');
    fs.writeFileSync(path.join(work, 'uploads', 'a.txt'), 'a');
    const other = path.join(dir, 'projects', 'p', 'work', 'r2', 'x.txt');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'x');
    await persistTree(path.join(dir, 'projects', 'p', 'work'));
    assert.equal(store.objects.size, 3);

    fs.rmSync(path.join(dir, 'projects'), { recursive: true });
    await restoreTree(work);
    assert.equal(fs.readFileSync(path.join(work, 'uploads', 'a.txt'), 'utf8'), 'a');
    assert.equal(fs.readFileSync(path.join(work, 'notes.md'), 'utf8'), 'n');
    assert.equal(fs.existsSync(other), false);
  });

  test('forgetTree removes every mirrored file under a folder', async () => {
    process.env.STORAGE_BACKEND = 's3';
    const a = path.join(dir, 'w', 'one', 'a.txt');
    const b = path.join(dir, 'w', 'keep', 'b.txt');
    for (const f of [a, b]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); await persistFile(f); }
    await forgetTree(path.join(dir, 'w', 'one'));
    assert.deepEqual([...store.objects.keys()], ['w/keep/b.txt']);
  });
});

/** Memory storage that reports a version per file, like S3 ETags. */
function versionedStorage(): StorageBackend & { objects: Map<string, Buffer> } {
  const base = memoryStorage();
  const versions = new Map<string, number>();
  let n = 0;
  return {
    ...base,
    async write(p, d) { base.objects.set(p, d); versions.set(p, ++n); return p; },
    async delete(p) { base.objects.delete(p); versions.delete(p); },
    async listVersions(prefix) {
      return [...base.objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ path: k, version: String(versions.get(k)) }));
    },
  };
}

describe('durable-files syncTree (folders edited from more than one server)', () => {
  let saved: string | undefined;
  let dir: string;
  let store: ReturnType<typeof versionedStorage>;
  const put = (rel: string, content: string): string => {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    return f;
  };
  /** Make a local file look older than the upload grace period. */
  const age = (f: string): void => { const t = new Date(Date.now() - 5 * 60_000); fs.utimesSync(f, t, t); };

  beforeEach(() => {
    saved = process.env.STORAGE_BACKEND;
    process.env.STORAGE_BACKEND = 's3';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-sync-'));
    setConfig(createTestConfig({ dataDir: dir }));
    store = versionedStorage();
    setStorage(store);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.STORAGE_BACKEND; else process.env.STORAGE_BACKEND = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('brings back every file after the local disk is lost', async () => {
    const root = path.join(dir, 'cfg-restore');
    await persistFile(put('cfg-restore/agents/a.md', 'A'));
    await persistFile(put('cfg-restore/skills/s/SKILL.md', 'S'));
    fs.rmSync(root, { recursive: true });
    await syncTree(root);
    assert.equal(fs.readFileSync(path.join(root, 'agents', 'a.md'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(root, 'skills', 's', 'SKILL.md'), 'utf8'), 'S');
  });

  test('picks up a file another server changed', async () => {
    const root = path.join(dir, 'cfg-change');
    const f = put('cfg-change/agents/a.md', 'old');
    await persistFile(f);
    age(f);
    await syncTree(root); // this server now knows the stored version
    await store.write('cfg-change/agents/a.md', Buffer.from('new')); // saved on another server
    await syncTree(root);
    assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  });

  test('removes a file another server deleted, and the folder it leaves empty', async () => {
    const root = path.join(dir, 'cfg-delete');
    const gone = put('cfg-delete/agents/old/a.md', 'A');
    const kept = put('cfg-delete/agents/b.md', 'B');
    await persistTree(root);
    age(gone); age(kept);
    await syncTree(root); // this server now knows the stored versions
    await store.delete('cfg-delete/agents/old/a.md'); // deleted on another server
    await syncTree(root);
    assert.equal(fs.existsSync(gone), false);
    assert.equal(fs.existsSync(path.join(root, 'agents', 'old')), false, 'empty folder removed');
    assert.equal(fs.readFileSync(kept, 'utf8'), 'B');
  });

  test('keeps a save from this server whose upload has not finished', async () => {
    const root = path.join(dir, 'cfg-pending');
    const f = put('cfg-pending/agents/a.md', 'v1');
    await persistFile(f);
    await syncTree(root);
    fs.writeFileSync(f, 'v2'); // written here, upload still running
    const fresh = put('cfg-pending/agents/new.md', 'N'); // new here, not uploaded yet
    await syncTree(root);
    assert.equal(fs.readFileSync(f, 'utf8'), 'v2', 'not overwritten by the older stored copy');
    assert.equal(fs.readFileSync(fresh, 'utf8'), 'N', 'not deleted');
  });

  test('removes an old local file that was never stored', async () => {
    const root = path.join(dir, 'cfg-stale');
    const f = put('cfg-stale/agents/stale.md', 'x');
    age(f);
    await syncTree(root);
    assert.equal(fs.existsSync(f), false);
  });

  test('without version tags, only missing files are fetched', async () => {
    const plain = memoryStorage();
    setStorage(plain);
    const root = path.join(dir, 'cfg-plain');
    const f = put('cfg-plain/a.md', 'mine');
    await persistFile(f);
    plain.objects.set('cfg-plain/a.md', Buffer.from('theirs'));
    plain.objects.set('cfg-plain/b.md', Buffer.from('B'));
    await syncTree(root);
    assert.equal(fs.readFileSync(f, 'utf8'), 'mine');
    assert.equal(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'B');
  });

  test('does nothing when the backend is local', async () => {
    delete process.env.STORAGE_BACKEND;
    const root = path.join(dir, 'cfg-local');
    const f = put('cfg-local/a.md', 'x');
    age(f);
    await syncTree(root);
    assert.equal(fs.existsSync(f), true);
  });
});
