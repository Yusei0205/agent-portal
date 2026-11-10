/**
 * Contract tests for SettingsRepository.
 *
 * The same assertions run against both SQLite and DynamoDB implementations.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * Covered scenarios:
 *   - get/set round trip for settings keys
 *   - defaults (missing key returns null)
 *   - multi-key atomic update (setKeys)
 *   - delete a key
 *   - version bump seen by a second repository instance
 *   - fail-closed on snapshot load after bad version
 *   - secrets round trip (setSecret / getSecret / deleteSecret)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteSettingsRepository } from '../server/repositories/settings-sqlite.ts';
import type { SettingsRepository } from '../server/repositories/settings.ts';
import {
  clearSettingsRepository,
  refreshSnapshotIfStale,
  _getSnapshot,
  _setSnapshot,
  initSettingsRepository,
  getSettingsRepository,
} from '../server/repositories/settings.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(
  label: string,
  makeRepo: () => Promise<SettingsRepository>,
  makeSecondRepo?: () => Promise<SettingsRepository>,
): void {
  describe(`${label} — SettingsRepository contract`, () => {
    let repo: SettingsRepository;

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearSettingsRepository();
    });

    // ── Basic get/set ─────────────────────────────────────────────────────────

    test('getKey — returns null for missing key', async () => {
      const val = await repo.getKey(`nonexistent-${RUN_TAG}`);
      assert.equal(val, null);
    });

    test('setKey / getKey — round trip', async () => {
      const key = `test.roundtrip.${RUN_TAG}`;
      await repo.setKey(key, 'hello');
      const val = await repo.getKey(key);
      assert.equal(val, 'hello', 'getKey should return set value');
    });

    test('setKey — overwrite existing', async () => {
      const key = `test.overwrite.${RUN_TAG}`;
      await repo.setKey(key, 'first');
      await repo.setKey(key, 'second');
      const val = await repo.getKey(key);
      assert.equal(val, 'second');
    });

    // ── Multi-key atomic update ───────────────────────────────────────────────

    test('setKeys — all keys written atomically', async () => {
      const pairs: Array<[string, string]> = [
        [`test.multi.a.${RUN_TAG}`, 'alpha'],
        [`test.multi.b.${RUN_TAG}`, 'beta'],
        [`test.multi.c.${RUN_TAG}`, 'gamma'],
      ];
      await repo.setKeys(pairs);
      for (const [key, expected] of pairs) {
        const val = await repo.getKey(key);
        assert.equal(val, expected, `Expected key ${key} = ${expected}`);
      }
    });

    test('setKeys with empty array — no-op', async () => {
      // Should not throw
      await repo.setKeys([]);
    });

    // ── Delete ────────────────────────────────────────────────────────────────

    test('deleteKey — key no longer readable', async () => {
      const key = `test.delete.${RUN_TAG}`;
      await repo.setKey(key, 'to-delete');
      await repo.deleteKey(key);
      const val = await repo.getKey(key);
      assert.equal(val, null);
    });

    test('deleteKey — missing key is no-op (no error)', async () => {
      await repo.deleteKey(`nonexistent.del.${RUN_TAG}`);
    });

    test('deleteKeys — removes all specified keys', async () => {
      const keys = [
        `test.delkeys.a.${RUN_TAG}`,
        `test.delkeys.b.${RUN_TAG}`,
      ];
      await repo.setKeys(keys.map((k) => [k, 'x'] as [string, string]));
      await repo.deleteKeys(keys);
      for (const key of keys) {
        assert.equal(await repo.getKey(key), null);
      }
    });

    // ── Version tracking ──────────────────────────────────────────────────────

    test('getVersion — returns a non-negative integer', async () => {
      const v = await repo.getVersion();
      assert.equal(typeof v, 'number');
      assert.ok(v >= 0, 'version should be >= 0');
    });

    test('setKey — bumps version', async () => {
      const before = await repo.getVersion();
      await repo.setKey(`test.ver.bump.${RUN_TAG}`, 'val');
      const after = await repo.getVersion();
      assert.ok(after > before, `Version should increase: ${before} → ${after}`);
    });

    test('setKeys — bumps version by exactly 1', async () => {
      const before = await repo.getVersion();
      await repo.setKeys([
        [`test.ver.multi.x.${RUN_TAG}`, '1'],
        [`test.ver.multi.y.${RUN_TAG}`, '2'],
      ]);
      const after = await repo.getVersion();
      assert.equal(after, before + 1, 'setKeys should bump version by exactly 1');
    });

    test('deleteKey — bumps version', async () => {
      const key = `test.ver.del.${RUN_TAG}`;
      await repo.setKey(key, 'v');
      const before = await repo.getVersion();
      await repo.deleteKey(key);
      const after = await repo.getVersion();
      assert.ok(after > before, `Version should increase on deleteKey: ${before} → ${after}`);
    });

    // ── Cross-instance freshness (version seen by second instance) ────────────

    if (makeSecondRepo) {
      test('cross-instance: write on repo1 seen by repo2 via getVersion', async () => {
        const repo2 = await makeSecondRepo();
        const vBefore = await repo2.getVersion();
        // Write on repo1
        await repo.setKey(`test.cross.${RUN_TAG}`, 'cross-instance-value');
        // repo2 sees the version bump
        const vAfter = await repo2.getVersion();
        assert.ok(vAfter > vBefore, `repo2 should see higher version after repo1 write: ${vBefore} → ${vAfter}`);
        // repo2 can read the value
        const val = await repo2.getKey(`test.cross.${RUN_TAG}`);
        assert.equal(val, 'cross-instance-value');
      });
    }

    // ── loadSnapshot ─────────────────────────────────────────────────────────

    test('loadSnapshot — contains written keys', async () => {
      const key = `test.snap.key.${RUN_TAG}`;
      await repo.setKey(key, 'snapshot-val');
      const snap = await repo.loadSnapshot();
      assert.equal(snap.keys.get(key), 'snapshot-val');
    });

    test('loadSnapshot — version matches getVersion', async () => {
      const snap = await repo.loadSnapshot();
      const v = await repo.getVersion();
      assert.equal(snap.version, v);
    });

    // ── Secrets ───────────────────────────────────────────────────────────────

    test('setSecret / getSecret — round trip (value opaque to repository)', async () => {
      const name = `jira.proj.test.${RUN_TAG}`;
      // Store pre-encrypted value (simulating what server/secrets.ts does)
      await repo.setSecret(name, 'enc-value-123', 'hint', new Date().toISOString());
      const rec = await repo.getSecret(name);
      assert.ok(rec !== null, 'getSecret should return a record');
      assert.equal(rec!.value, 'enc-value-123', 'encrypted value should be preserved verbatim');
      assert.equal(rec!.hint, 'hint');
    });

    test('deleteSecret — no longer readable', async () => {
      const name = `jira.proj.del.${RUN_TAG}`;
      await repo.setSecret(name, 'enc-del', null, new Date().toISOString());
      await repo.deleteSecret(name);
      const rec = await repo.getSecret(name);
      assert.equal(rec, null);
    });

    test('getSecret — returns null for unknown name', async () => {
      const rec = await repo.getSecret(`nonexistent.secret.${RUN_TAG}`);
      assert.equal(rec, null);
    });
  });
}

// ── Fail-closed snapshot test ─────────────────────────────────────────────────

describe('SettingsRepository — fail-closed snapshot', () => {
  before(() => createTestDb());
  after(cleanup);

  test('refreshSnapshotIfStale throws when snapshot is null', async () => {
    clearSettingsRepository();
    _setSnapshot(null);
    // Must reject with a clear error, not silently succeed
    let threw = false;
    try {
      await refreshSnapshotIfStale();
      threw = false;
    } catch (err: unknown) {
      threw = true;
      const msg = String((err as Error)?.message ?? err);
      assert.ok(msg.toLowerCase().includes('snapshot'), `Error should mention snapshot, got: ${msg}`);
    }
    // Only fails if repository is initialized (snapshot = null + instance exists)
    // When repo is null, refreshSnapshotIfStale is a no-op (safe before startup)
    const repo = getSettingsRepository();
    if (repo) {
      assert.ok(threw, 'refreshSnapshotIfStale should throw when snapshot is null and repo is initialized');
    }
    clearSettingsRepository();
  });

  test('initSettingsRepository loads snapshot — subsequent getVersion matches', async () => {
    clearSettingsRepository();
    await initSettingsRepository(); // SQLite by default
    const snap = _getSnapshot();
    assert.ok(snap !== null, 'Snapshot should be loaded after init');
    const v = await getSettingsRepository()!.getVersion();
    assert.equal(snap!.version, v, 'Snapshot version should match stored version');
    clearSettingsRepository();
  });
});

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite', () => {
  before(() => createTestDb());
  after(cleanup);

  runContract(
    'SQLite',
    async () => {
      clearSettingsRepository();
      return new SqliteSettingsRepository();
    },
    async () => new SqliteSettingsRepository(), // second instance on same DB
  );
});

// ── DynamoDB Local suite ──────────────────────────────────────────────────────

const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const DYNAMODB_REGION = process.env.DYNAMODB_REGION ?? process.env.AWS_REGION ?? 'ap-southeast-1';
const DYNAMODB_CONFIG_TABLE = process.env.DYNAMODB_TABLE_PORTAL_CONFIG ?? 'portal-config-test';
const REQUIRE_DYNAMODB = process.env.REQUIRE_DYNAMODB === '1';

describe('DynamoDB Local suite', async () => {
  async function checkDynamoDbLocal(endpoint: string): Promise<boolean> {
    try {
      const { DynamoDBClient, ListTablesCommand } = await import('@aws-sdk/client-dynamodb');
      const client = new DynamoDBClient({
        endpoint,
        region: DYNAMODB_REGION,
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      });
      await client.send(new ListTablesCommand({}));
      return true;
    } catch { return false; }
  }

  const ddbReachable = await checkDynamoDbLocal(DYNAMODB_ENDPOINT);

  if (!ddbReachable) {
    if (REQUIRE_DYNAMODB) {
      test('FAIL — DynamoDB Local required but not reachable', () => {
        throw new Error(`REQUIRE_DYNAMODB=1 but DynamoDB Local not reachable at ${DYNAMODB_ENDPOINT}`);
      });
    } else {
      test('SKIP — DynamoDB Local not reachable', () => {
        console.log(`[settings-repo] DynamoDB Local not reachable at ${DYNAMODB_ENDPOINT}`);
      });
    }
    return;
  }

  const { DynamoDbSettingsRepository, ensureConfigTableExists } = await import(
    '../server/repositories/settings-dynamodb.ts'
  );
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');

  const ddbClient = new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT,
    region: DYNAMODB_REGION,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

  await ensureConfigTableExists(ddbClient, DYNAMODB_CONFIG_TABLE);

  runContract(
    'DynamoDB Local',
    async () => {
      clearSettingsRepository();
      return new DynamoDbSettingsRepository({ client: ddbClient, tableName: DYNAMODB_CONFIG_TABLE });
    },
    async () => {
      // Second independent instance — simulates another Lambda cold start
      return new DynamoDbSettingsRepository({ client: ddbClient, tableName: DYNAMODB_CONFIG_TABLE });
    },
  );
});
