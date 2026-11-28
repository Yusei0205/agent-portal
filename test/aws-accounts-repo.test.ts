/**
 * Contract tests for AwsAccountsRepository.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { closeDb } from '../server/db.ts';
import type { AwsAccountsRepository } from '../server/repositories/aws-accounts.ts';
import { clearAwsAccountsRepository } from '../server/repositories/aws-accounts.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function projId() { return `proj-aws-${RUN_TAG}-${generateId().slice(0, 6)}`; }
function acctId() { return `acct-${RUN_TAG}-${generateId().slice(0, 6)}`; }

function maybeProject(id: string, isSqlite: boolean): void {
  if (!isSqlite) return;
  try {
    insert('projects', { id, slug: `slug-${id}`, name: `Project ${id}`, description: '', notes: '', created_by: null, created_at: now(), archived: 0, default_lead_agent: '', default_model: '', monthly_budget_usd: null, team_id: null, vault_generated: 0 });
  } catch { /* duplicate */ }
}

function runSuite(
  label: string,
  setup: () => Promise<AwsAccountsRepository>,
  isSqlite: boolean,
): void {
  describe(label, () => {
    let repo: AwsAccountsRepository;

    before(async () => {
      if (isSqlite) createTestDb();
      repo = await setup();
    });

    after(() => {
      clearAwsAccountsRepository();
      if (isSqlite) closeDb();
    });

    test('create and getByIdAndProject round trip', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      const id = acctId();
      const acct = await repo.create({ id, project_id: pid, name: 'My AWS Account', auth_method: 'keys', region: 'us-east-1', credentials_enc: null, profile_name: null, created_by: null, created_at: now() });
      assert.equal(acct.id, id);
      const fetched = await repo.getByIdAndProject(id, pid);
      assert.ok(fetched);
      assert.equal(fetched.id, id);
    });

    test('getByIdAndProject returns null for wrong project', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      const id = acctId();
      await repo.create({ id, project_id: pid, name: 'Acct', auth_method: 'profile', region: null, credentials_enc: null, profile_name: null, created_by: null, created_at: now() });
      assert.equal(await repo.getByIdAndProject(id, 'wrong-proj'), null);
    });

    test('listByProject returns accounts', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      for (let i = 0; i < 2; i++) {
        await repo.create({ id: acctId(), project_id: pid, name: `Acct ${i}`, auth_method: 'instance-role', region: null, credentials_enc: null, profile_name: null, created_by: null, created_at: now() });
      }
      assert.equal((await repo.listByProject(pid)).length, 2);
    });

    test('update modifies fields', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      const id = acctId();
      await repo.create({ id, project_id: pid, name: 'Original', auth_method: 'keys', region: 'us-west-2', credentials_enc: null, profile_name: null, created_by: null, created_at: now() });
      const updated = await repo.update(id, pid, { name: 'Updated', region: 'eu-west-1' });
      assert.ok(updated);
      assert.equal(updated.name, 'Updated');
      assert.equal(updated.region, 'eu-west-1');
    });

    test('delete removes account and returns true', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      const id = acctId();
      await repo.create({ id, project_id: pid, name: 'ToDelete', auth_method: 'keys', region: null, credentials_enc: null, profile_name: null, created_by: null, created_at: now() });
      assert.equal(await repo.delete(id, pid), true);
      assert.equal(await repo.getByIdAndProject(id, pid), null);
    });

    test('delete returns false for non-existent account', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      assert.equal(await repo.delete('no-such-id', pid), false);
    });
  });
}

runSuite('SQLite', async () => {
  const { SqliteAwsAccountsRepository } = await import('../server/repositories/aws-accounts-sqlite.ts');
  return new SqliteAwsAccountsRepository();
}, true);

(async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const require2 = process.env.REQUIRE_DYNAMODB === '1';
  if (!endpoint) {
    if (require2) throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT not set');
    describe('DynamoDB Local suite', () => { test('SKIP — DynamoDB Local not reachable', () => {}); });
    return;
  }

  process.env.DYNAMODB_TABLE_PORTAL_PROJECTS = `portal-projects-aws-test-${RUN_TAG}`;
  const { clearDynamoDbClient, getDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
  clearDynamoDbClient();
  const { DynamoDbAwsAccountsRepository, ensureAwsAccountsTableExists } =
    await import('../server/repositories/aws-accounts-dynamodb.ts');
  await ensureAwsAccountsTableExists(getDynamoDbClient());

  runSuite('DynamoDB Local suite', async () => new DynamoDbAwsAccountsRepository(), false);
})();
