/**
 * Contract tests for InboxRepository.
 *
 * The same assertions run against both SQLite and DynamoDB implementations.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * To run locally (PowerShell 5.1 — no &&):
 *   docker run -d --rm --name ddb-inbox -p 8000:8000 amazon/dynamodb-local
 *   $env:DYNAMODB_ENDPOINT='http://localhost:8000'; $env:REQUIRE_DYNAMODB='1'
 *   npm run test:affected -- --module inbox --backend-only
 *   docker stop ddb-inbox
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteInboxRepository } from '../server/repositories/inbox-sqlite.ts';
import type { InboxRepository } from '../server/repositories/inbox.ts';
import { clearInboxRepository } from '../server/repositories/inbox.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Helpers (SQLite FK satisfaction) ──────────────────────────────────────────

function insertProject(projectId: string): void {
  insert('projects', {
    id: projectId,
    slug: projectId,
    name: `test-${projectId}`,
    description: '',
    notes: '',
    created_by: null,
    created_at: now(),
    archived: 0,
    default_lead_agent: '',
    default_model: '',
    monthly_budget_usd: null,
    team_id: null,
    vault_generated: 0,
  });
}

function insertUser(userId: string): void {
  try {
    insert('users', {
      id: userId,
      email: `${userId}@test.example`,
      name: userId,
      password_hash: '',
      is_admin: 0,
      disabled: 0,
      created_at: now(),
    });
  } catch {
    // Ignore duplicate
  }
}

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(label: string, makeRepo: () => Promise<InboxRepository>): void {
  describe(`${label} -- InboxRepository contract`, () => {
    let repo: InboxRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    // FK helpers — only needed for SQLite, no-op for DynamoDB
    function maybeProject(id: string): void { if (isSqlite) insertProject(id); }
    function maybeUser(id: string): void { if (isSqlite) insertUser(id); }

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearInboxRepository();
    });

    test('create -- stores item and returns it', async () => {
      const id = generateId();
      const ts = now();
      const item = await repo.create({
        id,
        project_id: null,
        workflow_id: null,
        run_id: null,
        type: 'push',
        payload: JSON.stringify({ msg: 'hello' }),
        created_at: ts,
      });
      assert.equal(item.id, id);
      assert.equal(item.type, 'push');
      assert.equal(item.resolved, 0);
      assert.equal(item.project_id, null);
    });

    test('getById -- returns item', async () => {
      const id = generateId();
      const ts = now();
      await repo.create({
        id, project_id: null, workflow_id: null, run_id: null,
        type: 'question', payload: '{}', created_at: ts,
      });
      const found = await repo.getById(id);
      assert.ok(found);
      assert.equal(found.id, id);
      assert.equal(found.type, 'question');
    });

    test('getById -- returns null for unknown', async () => {
      const found = await repo.getById(`nonexistent-${sfx}`);
      assert.equal(found, null);
    });

    test('listUnresolvedByProjects -- returns unresolved newest first', async () => {
      const pid = `lpid-${sfx}`;
      maybeProject(pid);
      const ids = [generateId(), generateId(), generateId()];
      const base = new Date(Date.now() - 3000).toISOString();
      const mid = new Date(Date.now() - 2000).toISOString();
      const latest = new Date(Date.now() - 1000).toISOString();

      await repo.create({ id: ids[0], project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: base });
      await repo.create({ id: ids[1], project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: mid });
      await repo.create({ id: ids[2], project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: latest });

      const result = await repo.listUnresolvedByProjects([pid], { limit: 10 });
      assert.ok(result.total >= 3);
      const ourItems = result.items.filter((i) => ids.includes(i.id));
      assert.ok(ourItems.length >= 3);
      for (let i = 0; i < ourItems.length - 1; i++) {
        assert.ok(ourItems[i].created_at >= ourItems[i + 1].created_at);
      }
    });

    test('listUnresolvedByProjects -- empty projectIds returns empty', async () => {
      const result = await repo.listUnresolvedByProjects([], { limit: 10 });
      assert.equal(result.items.length, 0);
      assert.equal(result.total, 0);
    });

    test('listUnresolvedByProjects -- does not include resolved items', async () => {
      const pid = `rpid-${sfx}`;
      maybeProject(pid);
      const userId = `usr-rpid-${sfx}`;
      maybeUser(userId);
      const id = generateId();
      const ts = now();
      await repo.create({ id, project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });
      await repo.resolveConditional(id, userId, now());

      const result = await repo.listUnresolvedByProjects([pid], { limit: 10 });
      const found = result.items.find((i) => i.id === id);
      assert.equal(found, undefined, 'resolved item should not appear in unresolved list');
    });

    test('listAllUnresolved -- returns all unresolved', async () => {
      const pid = `allpid-${sfx}`;
      maybeProject(pid);
      const id1 = generateId();
      const id2 = generateId();
      const ts = now();
      await repo.create({ id: id1, project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });
      await repo.create({ id: id2, project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });

      const result = await repo.listAllUnresolved({ limit: 200 });
      const ourIds = result.items.map((i) => i.id);
      assert.ok(ourIds.includes(id1), 'item1 in listAllUnresolved');
      assert.ok(ourIds.includes(id2), 'item2 in listAllUnresolved');
    });

    test('countUnresolvedByProjects -- counts only unresolved', async () => {
      const pid = `cpid-${sfx}`;
      maybeProject(pid);
      const ts = now();
      const id1 = generateId();
      const id2 = generateId();
      await repo.create({ id: id1, project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });
      await repo.create({ id: id2, project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });

      const before = await repo.countUnresolvedByProjects([pid]);
      assert.ok(before >= 2);

      const resolveUserId = `usr-count-${sfx}`;
      maybeUser(resolveUserId);
      await repo.resolveConditional(id1, resolveUserId, now());

      const after = await repo.countUnresolvedByProjects([pid]);
      assert.equal(after, before - 1);
    });

    test('countAllUnresolved -- includes items across projects', async () => {
      const pid1 = `ca1-${sfx}`;
      const pid2 = `ca2-${sfx}`;
      maybeProject(pid1);
      maybeProject(pid2);
      const ts = now();
      await repo.create({ id: generateId(), project_id: pid1, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });
      await repo.create({ id: generateId(), project_id: pid2, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });

      const count = await repo.countAllUnresolved();
      assert.ok(count >= 2);
    });

    test('resolveConditional -- one winner among concurrent resolves', async () => {
      const id = generateId();
      const ts = now();
      const pid = `rcp-${sfx}`;
      maybeProject(pid);
      await repo.create({ id, project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });

      const resolveUser1 = `usr-r1-${sfx}`;
      const resolveUser2 = `usr-r2-${sfx}`;
      maybeUser(resolveUser1);
      maybeUser(resolveUser2);
      const [r1, r2] = await Promise.all([
        repo.resolveConditional(id, resolveUser1, now()),
        repo.resolveConditional(id, resolveUser2, now()),
      ]);

      assert.ok(r1 !== r2, 'exactly one resolve should win');
      assert.ok(r1 || r2);
      assert.ok(!(r1 && r2));

      const item = await repo.getById(id);
      assert.ok(item);
      assert.equal(item.resolved, 1);
    });

    test('resolveConditional -- returns false when already resolved', async () => {
      const id = generateId();
      const ts = now();
      const pid = `rr-${sfx}`;
      maybeProject(pid);
      await repo.create({ id, project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });
      const resolveU1 = `usr-rr1-${sfx}`;
      const resolveU2 = `usr-rr2-${sfx}`;
      maybeUser(resolveU1);
      maybeUser(resolveU2);
      await repo.resolveConditional(id, resolveU1, now());

      const r2 = await repo.resolveConditional(id, resolveU2, now());
      assert.equal(r2, false);
    });

    test('paging -- no gaps or overlap', async () => {
      const pid = `page-${sfx}`;
      maybeProject(pid);
      const count = 7;
      const base = new Date(Date.now() - count * 1000);
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = generateId();
        ids.push(id);
        const ts = new Date(base.getTime() + i * 1000).toISOString();
        await repo.create({ id, project_id: pid, workflow_id: null, run_id: null, type: 'push', payload: '{}', created_at: ts });
      }

      const p1 = await repo.listUnresolvedByProjects([pid], { limit: 3, offset: 0 });
      const p2 = await repo.listUnresolvedByProjects([pid], { limit: 3, offset: 3 });
      const p3 = await repo.listUnresolvedByProjects([pid], { limit: 3, offset: 6 });

      const allIds = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id);
      for (const id of ids) {
        const occurrences = allIds.filter((x) => x === id).length;
        assert.equal(occurrences, 1, `id ${id} should appear exactly once across pages`);
      }
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite suite', () => {
  before(async () => {
    await createTestDb();
  });
  after(cleanup);
  runContract('SQLite', async () => new SqliteInboxRepository());
});

// ── DynamoDB Local suite ──────────────────────────────────────────────────────

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB === '1') {
      throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    }
    test.skip('DynamoDB Local not available — set DYNAMODB_ENDPOINT to run');
    return;
  }

  let repo: import('../server/repositories/inbox-dynamodb.ts').DynamoDbInboxRepository;

  before(async () => {
    const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
    clearDynamoDbClient();
    process.env.DYNAMODB_TABLE_PORTAL_RUNS = `portal-runs-inbox-test-${RUN_TAG}`;
    const { DynamoDbInboxRepository } = await import('../server/repositories/inbox-dynamodb.ts');
    repo = new DynamoDbInboxRepository();
    await repo.ensureTables();
  });

  after(async () => {
    delete process.env.DYNAMODB_TABLE_PORTAL_RUNS;
    const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
    clearDynamoDbClient();
    clearInboxRepository();
  });

  runContract('DynamoDB', async () => repo);
});
