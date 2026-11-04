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
import { persistFile, restoreFile, forgetFile, restoreTree, forgetTree, persistTree } from '../server/durable-files.ts';

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
