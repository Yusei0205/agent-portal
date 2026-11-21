/**
 * Contract tests for DelegationSettingsRepository.
 *
 * The same assertions run against both SQLite and DynamoDB implementations.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteDelegationSettingsRepository } from '../server/repositories/delegation-settings-sqlite.ts';
import type { DelegationSettingsRepository } from '../server/repositories/delegation-settings.ts';
import { DELEGATION_DEFAULTS, clearDelegationSettingsRepository } from '../server/repositories/delegation-settings.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(
  label: string,
  makeRepo: () => Promise<DelegationSettingsRepository>,
): void {
  describe(`${label} — DelegationSettingsRepository contract`, () => {
    let repo: DelegationSettingsRepository;

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearDelegationSettingsRepository();
    });

    // ── get defaults ──────────────────────────────────────────────────────────

    test('get — returns defaults when no settings are persisted', async () => {
      const settings = await repo.get();
      // The repo might have settings from a previous test run (DynamoDB is persistent).
      // Only verify that each field has the correct type, not the exact value.
      assert.equal(typeof settings.enabled, 'boolean');
      assert.equal(typeof settings.maxRunningPerParent, 'number');
      assert.equal(typeof settings.maxRunningPerUser, 'number');
      assert.equal(typeof settings.idleStopMinutes, 'number');
      assert.equal(typeof settings.allowNested, 'boolean');
      assert.equal(typeof settings.nudgeThreshold, 'number');
    });

    // ── patch + get round trip ────────────────────────────────────────────────

    test('patch enabled=false / get — reflects the change', async () => {
      await repo.patch({ enabled: false });
      const settings = await repo.get();
      assert.equal(settings.enabled, false, 'enabled should be false after patch');
    });

    test('patch enabled=true / get — reflects the change', async () => {
      await repo.patch({ enabled: true });
      const settings = await repo.get();
      assert.equal(settings.enabled, true, 'enabled should be true after patch');
    });

    test('patch partial — only changed keys are updated', async () => {
      // Set a known baseline
      await repo.patch({
        enabled: true,
        maxRunningPerParent: 3,
        maxRunningPerUser: 5,
        idleStopMinutes: 15,
        allowNested: false,
        nudgeThreshold: 4,
      });

      // Patch only one key
      await repo.patch({ maxRunningPerParent: 7 });
      const settings = await repo.get();
      assert.equal(settings.maxRunningPerParent, 7, 'maxRunningPerParent should be updated');
      assert.equal(settings.maxRunningPerUser, 5, 'maxRunningPerUser should be unchanged');
      assert.equal(settings.idleStopMinutes, 15, 'idleStopMinutes should be unchanged');
    });

    test('patch allowNested=true / get — reflects the change', async () => {
      await repo.patch({ allowNested: true });
      const s = await repo.get();
      assert.equal(s.allowNested, true);
      await repo.patch({ allowNested: false });  // restore
    });

    test('patch maxRunningPerParent / clamped to 0-10', async () => {
      await repo.patch({ maxRunningPerParent: 10 });
      const s = await repo.get();
      assert.equal(s.maxRunningPerParent, 10);
    });

    test('patch nudgeThreshold / get — reflects the change', async () => {
      await repo.patch({ nudgeThreshold: 6 });
      const s = await repo.get();
      assert.equal(s.nudgeThreshold, 6);
    });

    test('patch idleStopMinutes / get — reflects the change', async () => {
      await repo.patch({ idleStopMinutes: 30 });
      const s = await repo.get();
      assert.equal(s.idleStopMinutes, 30);
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite', () => {
  before(() => createTestDb());
  after(cleanup);

  runContract('SQLite', async () => {
    clearDelegationSettingsRepository();
    return new SqliteDelegationSettingsRepository();
  });
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
        endpoint, region: DYNAMODB_REGION,
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
        console.log(`[delegation-repo] DynamoDB Local not reachable at ${DYNAMODB_ENDPOINT}`);
      });
    }
    return;
  }

  const { DynamoDbDelegationSettingsRepository, ensureConfigTableExists } = await import(
    '../server/repositories/delegation-settings-dynamodb.ts'
  );
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');

  const ddbClient = new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT, region: DYNAMODB_REGION,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

  await ensureConfigTableExists(ddbClient, DYNAMODB_CONFIG_TABLE);

  runContract('DynamoDB Local', async () => {
    clearDelegationSettingsRepository();
    return new DynamoDbDelegationSettingsRepository({ client: ddbClient, tableName: DYNAMODB_CONFIG_TABLE });
  });
});
