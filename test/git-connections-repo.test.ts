/**
 * Contract tests for GitConnectionsRepository.
 * SQLite and DynamoDB suites run the same assertions.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteGitConnectionsRepository } from '../server/repositories/git-connections-sqlite.ts';
import type { GitConnectionsRepository } from '../server/repositories/git-connections.ts';
import { clearGitConnectionsRepository } from '../server/repositories/git-connections.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function insertUser(userId: string): void {
  try {
    insert('users', {
      id: userId, email: `${userId}@test.example`, name: userId,
      password_hash: '', is_admin: 0, disabled: 0, created_at: now(),
    });
  } catch { /* ignore duplicate */ }
}

function runContract(label: string, makeRepo: () => Promise<GitConnectionsRepository>): void {
  describe(`${label} -- GitConnectionsRepository contract`, () => {
    let repo: GitConnectionsRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    before(async () => { repo = await makeRepo(); });
    after(() => { clearGitConnectionsRepository(); });

    test('create -- stores connection', async () => {
      const userId = `user-c-${sfx}`;
      if (isSqlite) insertUser(userId);
      const id = generateId();
      const conn = await repo.create({
        id, name: `conn-${sfx}`, provider: 'github', credentials_enc: null,
        scope: 'personal', owner_id: userId, created_at: now(),
      });
      assert.equal(conn.id, id);
      assert.equal(conn.provider, 'github');
    });

    test('getById -- returns connection', async () => {
      const userId = `user-g-${sfx}`;
      if (isSqlite) insertUser(userId);
      const id = generateId();
      await repo.create({ id, name: `c2-${sfx}`, provider: 'bitbucket', credentials_enc: null, scope: 'personal', owner_id: userId, created_at: now() });
      const c = await repo.getById(id);
      assert.ok(c);
      assert.equal(c!.provider, 'bitbucket');
    });

    test('getById -- returns null for unknown', async () => {
      const c = await repo.getById(`nope-${sfx}`);
      assert.equal(c, null);
    });

    test('listByUserOrShared -- returns personal and shared', async () => {
      const uid = `listuser-${sfx}`;
      const adminUid = `admin-${sfx}`;
      const otherUid = `other-${sfx}`;
      if (isSqlite) { insertUser(uid); insertUser(adminUid); insertUser(otherUid); }
      const id1 = generateId();
      const id2 = generateId();
      const id3 = generateId();
      await repo.create({ id: id1, name: `personal-${sfx}`, provider: 'github', credentials_enc: null, scope: 'personal', owner_id: uid, created_at: now() });
      await repo.create({ id: id2, name: `shared-${sfx}`, provider: 'github', credentials_enc: null, scope: 'shared', owner_id: adminUid, created_at: now() });
      await repo.create({ id: id3, name: `other-${sfx}`, provider: 'github', credentials_enc: null, scope: 'personal', owner_id: otherUid, created_at: now() });
      const list = await repo.listByUserOrShared(uid);
      const ids = list.map((c) => c.id);
      assert.ok(ids.includes(id1), 'personal connection should be listed');
      assert.ok(ids.includes(id2), 'shared connection should be listed');
      assert.ok(!ids.includes(id3), 'other user personal should not be listed');
    });

    test('listByProviderForUser -- filters by provider', async () => {
      const uid = `provuser-${sfx}`;
      if (isSqlite) insertUser(uid);
      const id1 = generateId();
      const id2 = generateId();
      await repo.create({ id: id1, name: `gh-${sfx}`, provider: 'github', credentials_enc: null, scope: 'personal', owner_id: uid, created_at: now() });
      await repo.create({ id: id2, name: `bb-${sfx}`, provider: 'bitbucket', credentials_enc: null, scope: 'personal', owner_id: uid, created_at: now() });
      const ghList = await repo.listByProviderForUser('github', uid);
      assert.ok(ghList.some((c) => c.id === id1));
      assert.ok(!ghList.some((c) => c.id === id2));
    });

    test('update -- changes fields', async () => {
      const uid = `u3-${sfx}`;
      if (isSqlite) insertUser(uid);
      const id = generateId();
      await repo.create({ id, name: `upd-${sfx}`, provider: 'github', credentials_enc: null, scope: 'personal', owner_id: uid, created_at: now() });
      const updated = await repo.update(id, { name: `updated-${sfx}` });
      assert.ok(updated);
      assert.equal(updated!.name, `updated-${sfx}`);
    });

    test('delete -- removes connection', async () => {
      const uid = `u4-${sfx}`;
      if (isSqlite) insertUser(uid);
      const id = generateId();
      await repo.create({ id, name: `del-${sfx}`, provider: 'github', credentials_enc: null, scope: 'personal', owner_id: uid, created_at: now() });
      const ok = await repo.delete(id);
      assert.equal(ok, true);
      assert.equal(await repo.getById(id), null);
    });
  });
}

describe('SQLite suite', () => {
  before(() => { createTestDb(); });
  after(() => { cleanup(); });
  runContract('SQLite', async () => new SqliteGitConnectionsRepository());
});

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB) throw new Error('REQUIRE_DYNAMODB is set but DYNAMODB_ENDPOINT is not');
    test.skip('DynamoDB suite skipped (DYNAMODB_ENDPOINT not set)');
    return;
  }
  process.env.DYNAMODB_TABLE_PORTAL_P10 = `portal-p10-test-gc-${RUN_TAG}`;
  const { DynamoDbGitConnectionsRepository } = await import('../server/repositories/git-connections-dynamodb.ts');
  runContract('DynamoDB', async () => {
    const repo = new DynamoDbGitConnectionsRepository();
    await repo.ensureTables();
    return repo;
  });
});
