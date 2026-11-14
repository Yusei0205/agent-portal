/**
 * Contract tests for IntegrationsRepository.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { closeDb } from '../server/db.ts';
import type { IntegrationsRepository } from '../server/repositories/integrations.ts';
import { clearIntegrationsRepository } from '../server/repositories/integrations.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function projId() { return `proj-int-${RUN_TAG}-${generateId().slice(0, 6)}`; }
function intId() { return `int-${RUN_TAG}-${generateId().slice(0, 6)}`; }

function maybeProject(id: string, isSqlite: boolean): void {
  if (!isSqlite) return;
  try {
    insert('projects', { id, slug: `slug-${id}`, name: `Project ${id}`, description: '', notes: '', created_by: null, created_at: now(), archived: 0, default_lead_agent: '', default_model: '', monthly_budget_usd: null, team_id: null, vault_generated: 0 });
  } catch { /* duplicate */ }
}

function runSuite(
  label: string,
  setup: () => Promise<IntegrationsRepository>,
  isSqlite: boolean,
): void {
  describe(label, () => {
    let repo: IntegrationsRepository;

    before(async () => {
      if (isSqlite) createTestDb();
      repo = await setup();
    });

    after(() => {
      clearIntegrationsRepository();
      if (isSqlite) closeDb();
    });

    test('create and getByIdAndProject round trip', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      const id = intId();
      const item = await repo.create({ id, project_id: pid, name: 'Test Integration', type: 'http', config_enc: null, enabled: 1, created_by: null, created_at: now() });
      assert.equal(item.id, id);
      assert.equal(item.type, 'http');
      const fetched = await repo.getByIdAndProject(id, pid);
      assert.ok(fetched);
      assert.equal(fetched.id, id);
    });

    test('getByIdAndProject returns null for wrong project', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      const id = intId();
      await repo.create({ id, project_id: pid, name: 'Int', type: 'stdio', config_enc: null, enabled: 1, created_by: null, created_at: now() });
      assert.equal(await repo.getByIdAndProject(id, 'wrong-proj'), null);
    });

    test('listByProject returns all integrations', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      for (let i = 0; i < 3; i++) {
        await repo.create({ id: intId(), project_id: pid, name: `Int ${i}`, type: 'http', config_enc: null, enabled: 1, created_by: null, created_at: now() });
      }
      assert.equal((await repo.listByProject(pid)).length, 3);
    });

    test('update modifies name and enabled', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      const id = intId();
      await repo.create({ id, project_id: pid, name: 'Original', type: 'http', config_enc: null, enabled: 1, created_by: null, created_at: now() });
      const updated = await repo.update(id, pid, { name: 'Updated', enabled: 0 });
      assert.ok(updated);
      assert.equal(updated.name, 'Updated');
      assert.equal(updated.enabled, 0);
    });

    test('delete removes integration and returns true', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      const id = intId();
      await repo.create({ id, project_id: pid, name: 'ToDelete', type: 'http', config_enc: null, enabled: 1, created_by: null, created_at: now() });
      assert.equal(await repo.delete(id, pid), true);
      assert.equal(await repo.getByIdAndProject(id, pid), null);
    });

    test('delete returns false for non-existent', async () => {
      const pid = projId();
      maybeProject(pid, isSqlite);
      assert.equal(await repo.delete('no-such-id', pid), false);
    });
  });
}

runSuite('SQLite', async () => {
  const { SqliteIntegrationsRepository } = await import('../server/repositories/integrations-sqlite.ts');
  return new SqliteIntegrationsRepository();
}, true);

(async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const require2 = process.env.REQUIRE_DYNAMODB === '1';
  if (!endpoint) {
    if (require2) throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT not set');
    describe('DynamoDB Local suite', () => { test('SKIP — DynamoDB Local not reachable', () => {}); });
    return;
  }

  process.env.DYNAMODB_TABLE_PORTAL_PROJECTS = `portal-projects-int-test-${RUN_TAG}`;
  const { clearDynamoDbClient, getDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
  clearDynamoDbClient();
  const { DynamoDbIntegrationsRepository, ensureIntegrationsTableExists } =
    await import('../server/repositories/integrations-dynamodb.ts');
  await ensureIntegrationsTableExists(getDynamoDbClient());

  runSuite('DynamoDB Local suite', async () => new DynamoDbIntegrationsRepository(), false);
})();
