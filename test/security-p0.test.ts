/**
 * Security hardening: the storage proxy never serves the database or key files and stays inside the data folder;
 * cross-origin calls are allowed only from the portal's own address.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isInside, isServableStoragePath } from '../server/storage-path.ts';
import { isAllowedOrigin } from '../server/http.ts';

const data = path.resolve('/srv/portal/data');

describe('isServableStoragePath', () => {
  it('serves ordinary files inside the data folder', () => {
    assert.equal(isServableStoragePath(path.join(data, 'vault', 'a.pdf'), data), true);
  });
  it('refuses the database, its journals, the master key and env files', () => {
    for (const f of ['portal.db', 'portal.db-wal', 'x/app.sqlite', 'master.key', '.env', '.env.local']) {
      assert.equal(isServableStoragePath(path.join(data, f), data), false, f);
    }
  });
  it('refuses paths outside the folder, including a sibling that shares the prefix', () => {
    assert.equal(isServableStoragePath(path.resolve(data, '..', 'data-evil', 'a.txt'), data), false);
    assert.equal(isServableStoragePath(path.resolve(data, '..', 'etc', 'passwd'), data), false);
    assert.equal(isServableStoragePath(data, data), false);
  });
  it('isInside is strict about the separator', () => {
    assert.equal(isInside('/a/b', '/a/b/c'), true);
    assert.equal(isInside('/a/b', '/a/bc'), false);
  });
});

describe('isAllowedOrigin', () => {
  const env = { PORTAL_PUBLIC_URL: 'https://portal.example.com/', PORTAL_ALLOWED_ORIGINS: 'https://tools.example.com' } as NodeJS.ProcessEnv;
  it('allows the public address and listed origins', () => {
    assert.equal(isAllowedOrigin('https://portal.example.com', 'lambda.internal', env), true);
    assert.equal(isAllowedOrigin('https://tools.example.com', 'lambda.internal', env), true);
  });
  it('allows the host the request arrived on (local use)', () => {
    assert.equal(isAllowedOrigin('http://localhost:8787', 'localhost:8787', {} as NodeJS.ProcessEnv), true);
  });
  it('refuses any other origin', () => {
    assert.equal(isAllowedOrigin('https://evil.example', 'lambda.internal', env), false);
    assert.equal(isAllowedOrigin('https://portal.example.com.evil.example', 'lambda.internal', env), false);
    assert.equal(isAllowedOrigin('not a url', 'x', env), false);
  });
});
