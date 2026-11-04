/**
 * Contract tests for UserConfigRepository.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { closeDb } from '../server/db.ts';
import type { UserConfigRepository } from '../server/repositories/user-config.ts';
import { clearUserConfigRepository } from '../server/repositories/user-config.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function userId(n: number) { return `user-uc-${RUN_TAG}-${n}`; }

function runSuite(
  label: string,
  setup: () => Promise<UserConfigRepository>,
  isSqlite: boolean,
): void {
  describe(label, () => {
    let repo: UserConfigRepository;

    before(async () => {
      if (isSqlite) {
        createTestDb();
        for (let i = 1; i <= 3; i++) {
          try {
            insert('users', { id: userId(i), email: `${userId(i)}@test.com`, name: `User ${i}`, password_hash: 'x', is_admin: 0, disabled: 0, created_at: now() });
          } catch { /* duplicate */ }
        }
      }
      repo = await setup();
    });

    after(() => {
      clearUserConfigRepository();
      if (isSqlite) closeDb();
    });

    test('getState returns null for unknown user/folder', async () => {
      assert.equal(await repo.getState(`nostate-${RUN_TAG}`, 'kiro'), null);
    });

    test('setState creates state, getState reads it', async () => {
      const uid = userId(1);
      await repo.setState(uid, 'kiro', { following: 0, customised_at: now(), team_version_id: null });
      const state = await repo.getState(uid, 'kiro');
      assert.ok(state);
      assert.equal(state.following, 0);
    });

    test('setState updates existing state', async () => {
      const uid = userId(2);
      await repo.setState(uid, 'claude', { following: 1, customised_at: null, team_version_id: null });
      await repo.setState(uid, 'claude', { following: 0, customised_at: now(), team_version_id: null });
      const state = await repo.getState(uid, 'claude');
      assert.equal(state?.following, 0);
    });

    test('getLatestTeamVersion returns null when no version', async () => {
      assert.equal(await repo.getLatestTeamVersion('aws'), null);
    });

    test('publishTeamVersion and getLatestTeamVersion round trip', async () => {
      const verId = `ver-${RUN_TAG}-${generateId().slice(0, 6)}`;
      const published = await repo.publishTeamVersion({ id: verId, folder: 'kiro', files_json: '[]', published_by: null, published_at: now() });
      assert.equal(published.id, verId);
      const latest = await repo.getLatestTeamVersion('kiro');
      assert.ok(latest);
      assert.equal(latest.id, verId);
    });

    test('listTeamVersions returns versions newest first', async () => {
      const v1 = `ver-${RUN_TAG}-a-${generateId().slice(0, 4)}`;
      const v2 = `ver-${RUN_TAG}-b-${generateId().slice(0, 4)}`;
      const t1 = new Date(Date.now() - 10000).toISOString();
      const t2 = now();
      await repo.publishTeamVersion({ id: v1, folder: 'claude', files_json: '[]', published_by: null, published_at: t1 });
      await repo.publishTeamVersion({ id: v2, folder: 'claude', files_json: '[]', published_by: null, published_at: t2 });
      const versions = await repo.listTeamVersions('claude');
      assert.ok(versions.length >= 2);
      const idx1 = versions.findIndex((v) => v.id === v1);
      const idx2 = versions.findIndex((v) => v.id === v2);
      assert.ok(idx2 < idx1, `Newest v2 (${idx2}) should appear before older v1 (${idx1})`);
    });
  });
}

runSuite('SQLite', async () => {
  const { SqliteUserConfigRepository } = await import('../server/repositories/user-config-sqlite.ts');
  return new SqliteUserConfigRepository();
}, true);

(async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const require2 = process.env.REQUIRE_DYNAMODB === '1';
  if (!endpoint) {
    if (require2) throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT not set');
    describe('DynamoDB Local suite', () => { test('SKIP — DynamoDB Local not reachable', () => {}); });
    return;
  }

  process.env.DYNAMODB_TABLE_PORTAL_USERS = `portal-users-uc-test-${RUN_TAG}`;
  process.env.DYNAMODB_TABLE_PORTAL_CONFIG = `portal-config-uc-test-${RUN_TAG}`;
  const { clearDynamoDbClient, getDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
  clearDynamoDbClient();
  const { DynamoDbUserConfigRepository, ensureUserConfigTablesExist } =
    await import('../server/repositories/user-config-dynamodb.ts');
  await ensureUserConfigTablesExist(getDynamoDbClient());

  runSuite('DynamoDB Local suite', async () => new DynamoDbUserConfigRepository(), false);
})();
