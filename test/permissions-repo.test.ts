/**
 * Contract tests for PermissionsRepository.
 *
 * The same assertions run against both SQLite and DynamoDB implementations.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqlitePermissionsRepository } from '../server/repositories/permissions-sqlite.ts';
import type { PermissionsRepository } from '../server/repositories/permissions.ts';
import { clearPermissionsRepository } from '../server/repositories/permissions.ts';
import { now, generateId } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Contract suite ────────────────────────────────────────────────────────────

function runContract(
  label: string,
  makeRepo: () => Promise<PermissionsRepository>,
  opts: {
    seedGroup: (groupId: string) => Promise<void>;
    seedProject: (projectId: string) => Promise<void>;
  },
): void {
  describe(`${label} — PermissionsRepository contract`, () => {
    let repo: PermissionsRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => {
      repo = await makeRepo();
    });    after(() => {
      clearPermissionsRepository();
    });

    // ── Portal permissions (singleton) ────────────────────────────────────────

    test('getPortalDefaultGroupId — returns null or a string when no setting exists', async () => {
      const id = await repo.getPortalDefaultGroupId();
      // In SQLite, it's seeded with 'standard'. In DynamoDB, it may be null.
      // Both are valid.
      assert.ok(id === null || typeof id === 'string');
    });

    test('setPortalDefaultGroupId / getPortalDefaultGroupId — round trip', async () => {
      await repo.setPortalDefaultGroupId(`grp-${sfx}`);
      const id = await repo.getPortalDefaultGroupId();
      assert.equal(id, `grp-${sfx}`);
    });

    // ── Permission rule groups ─────────────────────────────────────────────────

    test('listGroups — returns an array', async () => {
      const groups = await repo.listGroups();
      assert.ok(Array.isArray(groups), 'listGroups should return an array');
    });

    test('getGroupById — returns null for unknown id', async () => {
      const result = await repo.getGroupById('no-such-group-00000');
      assert.equal(result, null);
    });

    // ── Permission rules ──────────────────────────────────────────────────────

    test('createRule / getRulesForGroup — round trip', async () => {
      const groupId = `grp-rules-${sfx}`;
      await opts.seedGroup(groupId);
      const ruleId = `rule-${sfx}-1`;
      const ts = now();

      await repo.createRule({
        id: ruleId,
        group_id: groupId,
        name: `Test Rule ${sfx}`,
        pattern: `test-${sfx}.*`,
        category: null,
        action: 'block',
        scope: 'always',
        reason: 'contract test',
        sort_order: 10,
        created_at: ts,
        updated_at: ts,
      });

      const rules = await repo.getRulesForGroup(groupId);
      assert.ok(rules.length > 0, 'should find at least 1 rule for group');
      const rule = rules.find((r) => r.id === ruleId);
      assert.ok(rule, 'created rule should appear in getRulesForGroup');
      assert.equal(rule.action, 'block');
      assert.equal(rule.scope, 'always');
      assert.equal(rule.name, `Test Rule ${sfx}`);
    });

    test('createRule — sort_order respected (rules returned in sort_order order)', async () => {
      const groupId = `grp-sort-${sfx}`;
      await opts.seedGroup(groupId);
      const ts = now();

      await repo.createRule({ id: `sort-b-${sfx}`, group_id: groupId, name: 'B', pattern: null, category: null, action: 'allow', scope: 'always', reason: null, sort_order: 20, created_at: ts, updated_at: ts });
      await repo.createRule({ id: `sort-a-${sfx}`, group_id: groupId, name: 'A', pattern: null, category: null, action: 'allow', scope: 'always', reason: null, sort_order: 10, created_at: ts, updated_at: ts });
      await repo.createRule({ id: `sort-c-${sfx}`, group_id: groupId, name: 'C', pattern: null, category: null, action: 'allow', scope: 'always', reason: null, sort_order: 30, created_at: ts, updated_at: ts });

      const rules = await repo.getRulesForGroup(groupId);
      const ids = rules.map((r) => r.id);
      const ia = ids.indexOf(`sort-a-${sfx}`);
      const ib = ids.indexOf(`sort-b-${sfx}`);
      const ic = ids.indexOf(`sort-c-${sfx}`);
      assert.ok(ia < ib, 'A (sort 10) should come before B (sort 20)');
      assert.ok(ib < ic, 'B (sort 20) should come before C (sort 30)');
    });

    test('deleteRule — removes rule from getRulesForGroup', async () => {
      const groupId = `grp-del-${sfx}`;
      await opts.seedGroup(groupId);
      const ruleId = `rule-del-${sfx}`;
      const ts = now();
      await repo.createRule({
        id: ruleId, group_id: groupId, name: 'Del Rule',
        pattern: null, category: null, action: 'allow', scope: 'always',
        reason: null, sort_order: 0, created_at: ts, updated_at: ts,
      });
      const before = await repo.getRulesForGroup(groupId);
      assert.ok(before.some((r) => r.id === ruleId), 'rule should exist before delete');

      await repo.deleteRule(ruleId);

      const after = await repo.getRulesForGroup(groupId);
      assert.ok(!after.some((r) => r.id === ruleId), 'rule should be gone after delete');
    });

    // ── getAllBlockRules ───────────────────────────────────────────────────────

    test('getAllBlockRules — returns block+always rules', async () => {
      const groupId = `grp-blk-${sfx}`;
      await opts.seedGroup(groupId);
      const ts = now();
      await repo.createRule({ id: `blk-${sfx}-1`, group_id: groupId, name: 'Block Rule', pattern: `blocked-${sfx}`, category: null, action: 'block', scope: 'always', reason: null, sort_order: 0, created_at: ts, updated_at: ts });
      await repo.createRule({ id: `alw-${sfx}-1`, group_id: groupId, name: 'Allow Rule', pattern: null, category: null, action: 'allow', scope: 'always', reason: null, sort_order: 1, created_at: ts, updated_at: ts });

      const blockRules = await repo.getAllBlockRules();
      assert.ok(blockRules.some((r) => r.id === `blk-${sfx}-1`), 'block rule should appear');
      assert.ok(!blockRules.some((r) => r.id === `alw-${sfx}-1`), 'allow rule should NOT appear');
    });

    // ── Project permissions ───────────────────────────────────────────────────

    test('getProjectPermissions — returns null when no override', async () => {
      const result = await repo.getProjectPermissions(`proj-none-${sfx}`);
      assert.equal(result, null);
    });

    test('setProjectPermissions / getProjectPermissions — round trip', async () => {
      const projectId = `proj-${sfx}-1`;
      await opts.seedProject(projectId);
      const ruleGroupId = `grp-proj-${sfx}`;
      await opts.seedGroup(ruleGroupId);
      await repo.setProjectPermissions(projectId, ruleGroupId);
      const result = await repo.getProjectPermissions(projectId);
      assert.ok(result, 'should find project permissions');
      assert.equal(result.rule_group_id, ruleGroupId);
    });

    test('clearProjectPermissions — removes the override', async () => {
      const projectId = `proj-${sfx}-clear`;
      await opts.seedProject(projectId);
      const ruleGroupId = `grp-clr-${sfx}`;
      await opts.seedGroup(ruleGroupId);
      await repo.setProjectPermissions(projectId, ruleGroupId);
      const before = await repo.getProjectPermissions(projectId);
      assert.ok(before, 'should have override before clear');

      await repo.clearProjectPermissions(projectId);

      const after = await repo.getProjectPermissions(projectId);
      assert.equal(after, null, 'should have no override after clear');
    });

    // ── Project tool rules ────────────────────────────────────────────────────

    test('createProjectToolRule / getProjectToolRules — round trip', async () => {
      const projectId = `proj-${sfx}-tr`;
      await opts.seedProject(projectId);
      const ruleId = `tr-${sfx}-1`;
      const ts = now();
      await repo.createProjectToolRule({
        id: ruleId,
        project_id: projectId,
        tool_name: 'bash',
        action: 'ask',
        command_pattern: `rm -rf ${sfx}`,
        scope: 'always',
        created_at: ts,
        updated_at: ts,
      });

      const rules = await repo.getProjectToolRules(projectId);
      assert.ok(rules.length > 0, 'should have at least 1 tool rule');
      const rule = rules.find((r) => r.id === ruleId);
      assert.ok(rule, 'created rule should appear');
      assert.equal(rule.tool_name, 'bash');
      assert.equal(rule.action, 'ask');
      assert.equal(rule.command_pattern, `rm -rf ${sfx}`);
    });

    test('deleteProjectToolRule — removes the rule', async () => {
      const projectId = `proj-${sfx}-trdel`;
      await opts.seedProject(projectId);
      const ruleId = `tr-del-${sfx}`;
      const ts = now();
      await repo.createProjectToolRule({
        id: ruleId, project_id: projectId, tool_name: 'node',
        action: 'block', command_pattern: null, scope: 'always',
        created_at: ts, updated_at: ts,
      });
      const before = await repo.getProjectToolRules(projectId);
      assert.ok(before.some((r) => r.id === ruleId), 'rule should exist before delete');

      await repo.deleteProjectToolRule(projectId, ruleId);

      const after = await repo.getProjectToolRules(projectId);
      assert.ok(!after.some((r) => r.id === ruleId), 'rule should be gone after delete');
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite', () => {
  before(() => createTestDb());
  after(cleanup);

  runContract('SQLite', async () => {
    clearPermissionsRepository();
    return new SqlitePermissionsRepository();
  }, {
    seedGroup: async (groupId) => {
      try {
        insert('permission_rule_groups', {
          id: groupId, name: `Test Group ${groupId}`, description: 'contract test',
          is_builtin: 0, created_at: now(), updated_at: now(),
        });
      } catch { /* already exists */ }
    },
    seedProject: async (projectId) => {
      try {
        insert('projects', {
          id: projectId, name: `Test Project ${projectId}`, slug: `tp-${projectId.slice(-6)}`,
          description: '', archived: 0, created_at: now(),
        });
      } catch { /* already exists */ }
    },
  });
});

// ── DynamoDB Local suite ──────────────────────────────────────────────────────

const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const DYNAMODB_REGION = process.env.DYNAMODB_REGION ?? process.env.AWS_REGION ?? 'ap-southeast-1';
const DYNAMODB_CONFIG_TABLE = process.env.DYNAMODB_TABLE_PORTAL_CONFIG ?? 'portal-config-test';
const DYNAMODB_PROJECTS_TABLE = process.env.DYNAMODB_TABLE_PORTAL_PROJECTS ?? 'portal-projects-test';
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
    } catch {
      return false;
    }
  }

  const ddbReachable = await checkDynamoDbLocal(DYNAMODB_ENDPOINT);

  if (!ddbReachable) {
    if (REQUIRE_DYNAMODB) {
      test('FAIL — DynamoDB Local required but not reachable', () => {
        throw new Error(`REQUIRE_DYNAMODB=1 but DynamoDB Local not reachable at ${DYNAMODB_ENDPOINT}`);
      });
    } else {
      test('SKIP — DynamoDB Local not reachable', () => {
        console.log(`[permissions-repo] DynamoDB Local not reachable at ${DYNAMODB_ENDPOINT}`);
      });
    }
    return;
  }

  const {
    DynamoDbPermissionsRepository,
    ensureConfigTableExists,
    ensureProjectsTableExists,
  } = await import('../server/repositories/permissions-dynamodb.ts');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');

  const ddbClient = new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT, region: DYNAMODB_REGION,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

  await ensureConfigTableExists(ddbClient, DYNAMODB_CONFIG_TABLE);
  await ensureProjectsTableExists(ddbClient, DYNAMODB_PROJECTS_TABLE);

  runContract('DynamoDB Local', async () => {
    clearPermissionsRepository();
    return new DynamoDbPermissionsRepository({
      client: ddbClient,
      configTable: DYNAMODB_CONFIG_TABLE,
      projectsTable: DYNAMODB_PROJECTS_TABLE,
    });
  }, {
    seedGroup: async (groupId) => {
      // DynamoDB: create a PERM_GROUP entry so listGroups() can find it
      // (needed for deleteRule and getAllBlockRules which iterate via listGroups)
      await ddbClient.send(
        new (await import('@aws-sdk/client-dynamodb')).PutItemCommand({
          TableName: DYNAMODB_CONFIG_TABLE,
          Item: {
            PK: { S: 'PERM_GROUP' },
            SK: { S: `G#${groupId}` },
            id: { S: groupId },
            name: { S: `Test Group ${groupId}` },
            description: { S: 'contract test' },
            isBuiltin: { N: '0' },
            createdAt: { S: new Date().toISOString() },
            updatedAt: { S: new Date().toISOString() },
          },
        }),
      );
    },
    seedProject: async (_projectId) => {
      // DynamoDB has no FK constraints; no seeding needed for projects
    },
  });
});
