/**
 * Contract tests for CredentialsRepository.
 *
 * Same assertions run against both SQLite and DynamoDB Local.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * To run locally (PowerShell 5.1):
 *   docker run -d --rm --name ddb-b -p 8002:8000 amazon/dynamodb-local
 *   $env:DYNAMODB_ENDPOINT='http://localhost:8002'; $env:REQUIRE_DYNAMODB='1'
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/credentials-repo.test.ts
 *   docker stop ddb-b
 *   Remove-Item Env:DYNAMODB_ENDPOINT; Remove-Item Env:REQUIRE_DYNAMODB
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { closeDb } from '../server/db.ts';
import type { CredentialsRepository } from '../server/repositories/credentials.ts';
import { clearCredentialsRepository } from '../server/repositories/credentials.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function userId(n: number) { return `user-cred-${RUN_TAG}-${n}`; }
function credId() { return `cred-${RUN_TAG}-${generateId().slice(0, 8)}`; }

function makeInput(overrides: Record<string, unknown> = {}) {
  const uid = userId(1);
  return {
    id: credId(), user_id: uid, engine: 'kiro', name: 'Test credential',
    mode: 'api_key', secret_enc: null as string | null, extra_config: '{}',
    is_default: 0, last4: '1234', created_at: now(), updated_at: now(), updated_by: uid,
    ...overrides,
  };
}

function runSuite(
  label: string,
  setup: () => Promise<CredentialsRepository>,
  isSqlite: boolean,
): void {
  describe(label, () => {
    let repo: CredentialsRepository;

    before(async () => {
      if (isSqlite) createTestDb();
      repo = await setup();
      // Create test users (SQLite FK enforcement)
      if (isSqlite) {
        for (let i = 1; i <= 5; i++) {
          try {
            insert('users', { id: userId(i), email: `${userId(i)}@test.com`, name: `User ${i}`, password_hash: 'x', is_admin: 0, disabled: 0, created_at: now() });
          } catch { /* duplicate */ }
        }
      }
    });

    after(() => {
      clearCredentialsRepository();
      if (isSqlite) closeDb();
    });

    test('create and getById round trip', async () => {
      const input = makeInput({ user_id: userId(1) });
      const created = await repo.create(input);
      assert.equal(created.id, input.id);
      assert.equal(created.engine, 'kiro');
      const fetched = await repo.getById(input.id);
      assert.ok(fetched);
      assert.equal(fetched.user_id, userId(1));
    });

    test('getByIdAndUser returns null for wrong user', async () => {
      const input = makeInput({ user_id: userId(1) });
      await repo.create(input);
      assert.equal(await repo.getByIdAndUser(input.id, userId(2)), null);
    });

    test('getByIdAndUser returns correct record for owner', async () => {
      const input = makeInput({ user_id: userId(1) });
      await repo.create(input);
      const result = await repo.getByIdAndUser(input.id, userId(1));
      assert.ok(result);
      assert.equal(result.id, input.id);
    });

    test('getDefaultByUserAndEngine returns default credential', async () => {
      const input = makeInput({ user_id: userId(1), is_default: 1, engine: 'claude-code' });
      await repo.create(input);
      const result = await repo.getDefaultByUserAndEngine(userId(1), 'claude-code');
      assert.ok(result);
      assert.equal(result.id, input.id);
    });

    test('getDefaultByUserAndEngine returns null when no default', async () => {
      assert.equal(await repo.getDefaultByUserAndEngine(userId(2), 'unknown-engine'), null);
    });

    test('listByUser returns credentials for user', async () => {
      const u3 = userId(3);
      await repo.create(makeInput({ user_id: u3, engine: 'kiro', is_default: 1 }));
      await repo.create(makeInput({ user_id: u3, engine: 'kiro', is_default: 0 }));
      const list = await repo.listByUser(u3);
      assert.ok(list.length >= 2);
    });

    test('updateToken updates secret fields', async () => {
      const input = makeInput({ user_id: userId(1) });
      await repo.create(input);
      await repo.updateToken(input.id, 'enc123', '{"k":"v"}', 'abcd', now());
      const fetched = await repo.getById(input.id);
      assert.ok(fetched);
      assert.equal(fetched.secret_enc, 'enc123');
      assert.equal(fetched.last4, 'abcd');
    });

    test('updateTokenConditional succeeds when ciphertext matches', async () => {
      const input = makeInput({ user_id: userId(1), secret_enc: 'original' });
      await repo.create(input);
      const ok = await repo.updateTokenConditional(input.id, 'new-enc', '{}', 'wxyz', now(), 'original');
      assert.equal(ok, true);
      assert.equal((await repo.getById(input.id))?.secret_enc, 'new-enc');
    });

    test('updateTokenConditional fails when ciphertext does not match', async () => {
      const input = makeInput({ user_id: userId(1), secret_enc: 'current' });
      await repo.create(input);
      const ok = await repo.updateTokenConditional(input.id, 'new-enc', '{}', 'wxyz', now(), 'wrong');
      assert.equal(ok, false);
      assert.equal((await repo.getById(input.id))?.secret_enc, 'current');
    });

    test('clearDefaults and setDefault work', async () => {
      const u4 = userId(4);
      const id1 = credId(); const id2 = credId();
      await repo.create(makeInput({ id: id1, user_id: u4, engine: 'kiro', is_default: 1 }));
      await repo.create(makeInput({ id: id2, user_id: u4, engine: 'kiro', is_default: 0 }));
      await repo.clearDefaults(u4, 'kiro');
      await repo.setDefault(id2, now());
      const def = await repo.getDefaultByUserAndEngine(u4, 'kiro');
      assert.ok(def);
      assert.equal(def.id, id2);
    });

    test('delete removes the record', async () => {
      const input = makeInput({ user_id: userId(1) });
      await repo.create(input);
      await repo.delete(input.id);
      assert.equal(await repo.getById(input.id), null);
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

runSuite('SQLite', async () => {
  const { SqliteCredentialsRepository } = await import('../server/repositories/credentials-sqlite.ts');
  return new SqliteCredentialsRepository();
}, true);

// ── DynamoDB Local suite ──────────────────────────────────────────────────────

(async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const require2 = process.env.REQUIRE_DYNAMODB === '1';

  if (!endpoint) {
    if (require2) throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT not set');
    describe('DynamoDB Local suite', () => {
      test('SKIP — DynamoDB Local not reachable', () => {});
    });
    return;
  }

  process.env.DYNAMODB_TABLE_PORTAL_USERS = `portal-users-cred-test-${RUN_TAG}`;

  const { clearDynamoDbClient, getDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
  clearDynamoDbClient();
  const { DynamoDbCredentialsRepository, ensureCredentialsTableExists } =
    await import('../server/repositories/credentials-dynamodb.ts');
  await ensureCredentialsTableExists(getDynamoDbClient());

  runSuite('DynamoDB Local suite', async () => new DynamoDbCredentialsRepository(), false);
})();
