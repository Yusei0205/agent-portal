/**
 * Storage backend tests.
 *
 * Tests:
 *   - LocalStorageBackend.write() writes file to correct path
 *   - LocalStorageBackend.read() reads back what was written
 *   - LocalStorageBackend.delete() removes the file
 *   - LocalStorageBackend.exists() returns false for missing file
 *   - LocalStorageBackend.publicUrl() returns /api/storage-file?path=...
 *   - createStorageBackend() returns LocalStorageBackend when STORAGE_BACKEND env not set
 *   - GET /api/ready returns storage:'skip' for local backend
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { LocalStorageBackend } from '../server/storage/local.ts';
import { createStorageBackend } from '../server/storage/index.ts';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

// ── Helper ────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
}

// ── LocalStorageBackend ───────────────────────────────────────────────────────

describe('LocalStorageBackend', () => {
  let tmpDir: string;
  let backend: LocalStorageBackend;

  beforeEach(() => {
    tmpDir = makeTempDir();
    backend = new LocalStorageBackend(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('write() writes file to correct path', async () => {
    const data = Buffer.from('hello world');
    await backend.write('test/file.txt', data);
    const abs = path.join(tmpDir, 'test', 'file.txt');
    assert.ok(fs.existsSync(abs), 'File should exist at the resolved path');
    const content = fs.readFileSync(abs);
    assert.deepEqual(content, data);
  });

  it('write() creates parent directories', async () => {
    const data = Buffer.from('nested');
    await backend.write('deep/nested/dir/file.bin', data);
    const abs = path.join(tmpDir, 'deep', 'nested', 'dir', 'file.bin');
    assert.ok(fs.existsSync(abs), 'Nested directories should be created');
  });

  it('write() returns the logical path', async () => {
    const returned = await backend.write('myfile.txt', Buffer.from('x'));
    assert.equal(returned, 'myfile.txt');
  });

  it('read() reads back what was written', async () => {
    const data = Buffer.from('read me back');
    await backend.write('readtest.txt', data);
    const result = await backend.read('readtest.txt');
    assert.deepEqual(result, data);
  });

  it('delete() removes the file', async () => {
    await backend.write('todelete.txt', Buffer.from('bye'));
    const abs = path.join(tmpDir, 'todelete.txt');
    assert.ok(fs.existsSync(abs), 'File should exist before delete');
    await backend.delete('todelete.txt');
    assert.ok(!fs.existsSync(abs), 'File should be gone after delete');
  });

  it('delete() silently ignores missing files', async () => {
    // Should not throw
    await backend.delete('does-not-exist.txt');
  });

  it('exists() returns true for an existing file', async () => {
    await backend.write('exists.txt', Buffer.from('yes'));
    const result = await backend.exists('exists.txt');
    assert.equal(result, true);
  });

  it('exists() returns false for a missing file', async () => {
    const result = await backend.exists('no-such-file.txt');
    assert.equal(result, false);
  });

  it('publicUrl() returns /api/storage-file?path=...', async () => {
    const url = await backend.publicUrl('vault/my-doc.pdf');
    assert.equal(url, '/api/storage-file?path=vault%2Fmy-doc.pdf');
  });

  it('publicUrl() encodes special characters in the path', async () => {
    const url = await backend.publicUrl('vault/my doc (v2).pdf');
    assert.ok(url.startsWith('/api/storage-file?path='), 'URL should start with proxy prefix');
    assert.ok(!url.includes(' '), 'Spaces should be encoded');
  });

  it('ping() succeeds when dataDir exists', async () => {
    await backend.ping(); // should not throw
  });

  it('ping() throws when dataDir is missing', async () => {
    const missingDir = path.join(os.tmpdir(), 'storage-test-nonexistent-' + Date.now());
    const badBackend = new LocalStorageBackend(missingDir);
    await assert.rejects(() => badBackend.ping());
  });
});

// ── createStorageBackend ──────────────────────────────────────────────────────

describe('createStorageBackend', () => {
  afterEach(() => {
    delete process.env.STORAGE_BACKEND;
    delete process.env.DATA_DIR;
  });

  it('returns LocalStorageBackend when STORAGE_BACKEND is not set', async () => {
    delete process.env.STORAGE_BACKEND;
    const tmpDir = makeTempDir();
    process.env.DATA_DIR = tmpDir;
    try {
      const backend = await createStorageBackend();
      assert.ok(backend instanceof LocalStorageBackend, 'Should be a LocalStorageBackend');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns LocalStorageBackend when STORAGE_BACKEND=local', async () => {
    process.env.STORAGE_BACKEND = 'local';
    const tmpDir = makeTempDir();
    process.env.DATA_DIR = tmpDir;
    try {
      const backend = await createStorageBackend();
      assert.ok(backend instanceof LocalStorageBackend, 'Should be a LocalStorageBackend');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── /api/ready includes storage check ────────────────────────────────────────

describe('GET /api/ready storage check', () => {
  let baseUrl: string;

  before(async () => {
    delete process.env.STORAGE_BACKEND;
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
  });

  after(async () => {
    await cleanup();
  });

  it('returns storage:skip when STORAGE_BACKEND is not s3', async () => {
    const r = await fetchJson(baseUrl, '/api/ready');
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, true);
    const checks = body.checks as Record<string, string>;
    assert.equal(checks.db, 'ok');
    assert.equal(checks.dataDir, 'ok');
    assert.equal(checks.secretKey, 'ok');
    assert.equal(checks.storage, 'skip');
  });
});
