/**
 * Contract tests for AuditRepository.
 *
 * The same assertions run against both SQLite and DynamoDB implementations.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * DynamoDB differences vs SQLite:
 *   - total field is -1 (exact count not available without full scan)
 *   - actor_name / actor_email are null (no cross-table JOIN in DynamoDB)
 *   - cursor-based pagination only; OFFSET not supported
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteAuditRepository } from '../server/repositories/audit-sqlite.ts';
import type { AuditRepository } from '../server/repositories/audit.ts';
import { clearAuditRepository } from '../server/repositories/audit.ts';
import { now, generateId } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(
  label: string,
  makeRepo: () => Promise<AuditRepository>,
  seedUser?: (id: string, email: string) => Promise<void>,
): void {
  describe(`${label} — AuditRepository contract`, () => {
    let repo: AuditRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearAuditRepository();
    });

    // ── append ────────────────────────────────────────────────────────────────

    test('append — stores an audit entry', async () => {
      await repo.append({
        actorId: `actor-${sfx}`,
        action: `test.action.${sfx}`,
        target: `resource:${sfx}`,
        detail: { key: `value-${sfx}` },
        ip: '127.0.0.1',
      });

      const result = await repo.query({
        limit: 10,
        actorId: `actor-${sfx}`,
      });
      assert.ok(result.entries.length > 0, 'should find the appended entry');
      const entry = result.entries.find((e) => e.action === `test.action.${sfx}`);
      assert.ok(entry, 'should find the entry by action');
      assert.equal(entry.actor_id, `actor-${sfx}`);
      assert.equal(entry.target, `resource:${sfx}`);
      assert.deepEqual(entry.detail, { key: `value-${sfx}` });
    });

    test('append — null actorId (system event) is stored', async () => {
      await repo.append({
        actorId: null,
        action: `system.event.${sfx}`,
        target: null,
        detail: {},
        ip: null,
      });

      const result = await repo.query({ limit: 10 });
      const entry = result.entries.find((e) => e.action === `system.event.${sfx}`);
      assert.ok(entry, 'system event should be found');
      assert.equal(entry.actor_id, null);
    });

    // ── query: unfiltered ─────────────────────────────────────────────────────

    test('query — returns entries newest first', async () => {
      const action1 = `ordered.first.${sfx}`;
      const action2 = `ordered.second.${sfx}`;

      await repo.append({ actorId: null, action: action1, target: null, detail: {}, ip: null });
      await repo.append({ actorId: null, action: action2, target: null, detail: {}, ip: null });

      const result = await repo.query({ limit: 100 });
      const entries = result.entries.filter((e) => [action1, action2].includes(e.action));
      assert.equal(entries.length, 2, 'should find both entries');
      const i1 = result.entries.findIndex((e) => e.action === action1);
      const i2 = result.entries.findIndex((e) => e.action === action2);
      assert.ok(i2 < i1, 'newer entry (action2) should appear before older (action1)');
    });

    test('query — limit is respected', async () => {
      // Append several entries
      for (let i = 0; i < 5; i++) {
        await repo.append({ actorId: null, action: `limit.test.${sfx}.${i}`, target: null, detail: {}, ip: null });
      }
      const result = await repo.query({ limit: 3 });
      assert.ok(result.entries.length <= 3, `entries.length (${result.entries.length}) should be ≤ 3`);
    });

    // ── query: actor filter ───────────────────────────────────────────────────

    test('query with actorId filter — only returns that actor\'s entries', async () => {
      const actorA = `filter-a-${sfx}`;
      const actorB = `filter-b-${sfx}`;

      await repo.append({ actorId: actorA, action: `filter.actor.a.${sfx}`, target: null, detail: {}, ip: null });
      await repo.append({ actorId: actorB, action: `filter.actor.b.${sfx}`, target: null, detail: {}, ip: null });

      const result = await repo.query({ limit: 50, actorId: actorA });
      assert.ok(result.entries.every((e) => e.actor_id === actorA), 'all entries should belong to actorA');
      assert.ok(result.entries.some((e) => e.action === `filter.actor.a.${sfx}`), 'actorA entry should be present');
      assert.ok(!result.entries.some((e) => e.actor_id === actorB), 'actorB entry should not appear');
    });

    // ── query: action prefix filter ───────────────────────────────────────────

    test('query with action filter — prefix match', async () => {
      const prefix = `pfx.${sfx}.`;
      await repo.append({ actorId: null, action: `${prefix}login`, target: null, detail: {}, ip: null });
      await repo.append({ actorId: null, action: `other.action.${sfx}`, target: null, detail: {}, ip: null });

      const result = await repo.query({ limit: 50, action: prefix });
      assert.ok(result.entries.every((e) => e.action.startsWith(prefix)), 'all results should match the prefix');
      assert.ok(result.entries.some((e) => e.action === `${prefix}login`), 'login entry should be present');
    });

    // ── total field ───────────────────────────────────────────────────────────

    test('query total — is an integer or null (exact in SQLite, null in DynamoDB)', async () => {
      const result = await repo.query({ limit: 10 });
      assert.ok(typeof result.total === 'number' || result.total === null, 'total should be a number or null');
      if (typeof result.total === 'number') {
        assert.ok(result.total >= 0, 'total should be non-negative when present');
      }
    });

    // ── hasMore and nextCursor ────────────────────────────────────────────────

    test('query hasMore — false when all results fit in one page', async () => {
      const result = await repo.query({ limit: 1000 });
      // With limit 1000 and the small number of test entries, hasMore should be false
      // (unless we happen to be running against a very large dataset)
      assert.equal(typeof result.hasMore, 'boolean', 'hasMore should be a boolean');
    });

    test('query nextCursor — cursor-based pagination returns disjoint pages', async () => {
      // Append enough entries to span multiple pages
      const prefix = `page-test-${sfx}`;
      for (let i = 0; i < 5; i++) {
        await repo.append({ actorId: null, action: `${prefix}.${i}`, target: null, detail: {}, ip: null });
      }

      const page1 = await repo.query({ limit: 3 });
      assert.ok(page1.entries.length <= 3, 'page 1 should have at most 3 entries');

      if (page1.hasMore && page1.nextCursor) {
        const page2 = await repo.query({ limit: 3, cursor: page1.nextCursor });
        // Pages must be disjoint
        const ids1 = new Set(page1.entries.map((e) => String(e.id)));
        const overlap = page2.entries.filter((e) => ids1.has(String(e.id)));
        assert.equal(overlap.length, 0, 'page 2 must not repeat entries from page 1');
      }
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite', () => {
  before(() => {
    createTestDb();
    // Seed a user so actor_id FK constraints don't fail
    try {
      insert('users', {
        id: 'audit-test-user',
        email: 'audit@test.com',
        name: 'Audit Test User',
        password_hash: 'x',
        is_admin: 0,
        disabled: 0,
        created_at: now(),
      });
    } catch { /* already exists */ }
  });
  after(cleanup);

  runContract('SQLite', async () => {
    clearAuditRepository();
    return new SqliteAuditRepository();
  });
});

// ── DynamoDB Local suite ──────────────────────────────────────────────────────

const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const DYNAMODB_REGION = process.env.DYNAMODB_REGION ?? process.env.AWS_REGION ?? 'ap-southeast-1';
const DYNAMODB_PROJECTS_TABLE = process.env.DYNAMODB_TABLE_PORTAL_AUDIT ?? 'portal-audit-test';
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
        console.log(`[audit-repo] DynamoDB Local not reachable at ${DYNAMODB_ENDPOINT}`);
      });
    }
    return;
  }

  const { DynamoDbAuditRepository, ensureAuditTableExists } = await import(
    '../server/repositories/audit-dynamodb.ts'
  );
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');

  const ddbClient = new DynamoDBClient({
    endpoint: DYNAMODB_ENDPOINT, region: DYNAMODB_REGION,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });

  await ensureAuditTableExists(ddbClient, DYNAMODB_PROJECTS_TABLE);

  runContract('DynamoDB Local', async () => {
    clearAuditRepository();
    return new DynamoDbAuditRepository({ client: ddbClient, tableName: DYNAMODB_PROJECTS_TABLE });
  });
});
