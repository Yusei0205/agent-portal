/**
 * Contract tests for WorkspacesRepository.
 * SQLite and DynamoDB suites run the same assertions.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteWorkspacesRepository } from '../server/repositories/workspaces-sqlite.ts';
import type { WorkspacesRepository } from '../server/repositories/workspaces.ts';
import { clearWorkspacesRepository } from '../server/repositories/workspaces.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function insertProject(projectId: string): void {
  insert('projects', {
    id: projectId, slug: projectId, name: `test-${projectId}`, description: '',
    notes: '', created_by: null, created_at: now(), archived: 0,
    default_lead_agent: '', default_model: '', monthly_budget_usd: null, team_id: null, vault_generated: 0,
  });
}

function runContract(label: string, makeRepo: () => Promise<WorkspacesRepository>): void {
  describe(`${label} -- WorkspacesRepository contract`, () => {
    let repo: WorkspacesRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    before(async () => {
      repo = await makeRepo();
    });
    after(() => { clearWorkspacesRepository(); });

    test('create -- stores workspace and returns it', async () => {
      if (isSqlite) insertProject(`proj-${sfx}`);
      const id = generateId();
      const ws = await repo.create({
        id, project_id: `proj-${sfx}`, name: `ws-${sfx}`, repo_ids: '[]',
        created_at: now(), default_engine: 'demo', default_agent: '', default_model: '',
      });
      assert.equal(ws.id, id);
      assert.equal(ws.name, `ws-${sfx}`);
      assert.equal(ws.default_engine, 'demo');
    });

    test('getById -- returns workspace', async () => {
      const pid = `proj2-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `ws2-${sfx}`, repo_ids: '[]', created_at: now(), default_engine: '', default_agent: '', default_model: '' });
      const ws = await repo.getById(id);
      assert.ok(ws, 'should find workspace');
      assert.equal(ws!.id, id);
    });

    test('getById -- returns null for unknown id', async () => {
      const ws = await repo.getById(`nonexistent-${sfx}`);
      assert.equal(ws, null);
    });

    test('getByIdForProject -- returns workspace when project matches', async () => {
      const pid = `proj3-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `ws3-${sfx}`, repo_ids: '[]', created_at: now(), default_engine: '', default_agent: '', default_model: '' });
      const ws = await repo.getByIdForProject(id, pid);
      assert.ok(ws);
    });

    test('getByIdForProject -- returns null for wrong project', async () => {
      const pid = `proj4-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `ws4-${sfx}`, repo_ids: '[]', created_at: now(), default_engine: '', default_agent: '', default_model: '' });
      const ws = await repo.getByIdForProject(id, `wrong-${sfx}`);
      assert.equal(ws, null);
    });

    test('listByProject -- returns only matching project workspaces', async () => {
      const pid = `proj5-${sfx}`;
      const pid2 = `proj5b-${sfx}`;
      if (isSqlite) { insertProject(pid); insertProject(pid2); }
      await repo.create({ id: generateId(), project_id: pid, name: `a-${sfx}`, repo_ids: '[]', created_at: now(), default_engine: '', default_agent: '', default_model: '' });
      await repo.create({ id: generateId(), project_id: pid, name: `b-${sfx}`, repo_ids: '[]', created_at: now(), default_engine: '', default_agent: '', default_model: '' });
      await repo.create({ id: generateId(), project_id: pid2, name: `c-${sfx}`, repo_ids: '[]', created_at: now(), default_engine: '', default_agent: '', default_model: '' });
      const list = await repo.listByProject(pid);
      assert.ok(list.length >= 2);
      assert.ok(list.every((w) => w.project_id === pid));
    });

    test('update -- changes fields', async () => {
      const pid = `proj6-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `old-${sfx}`, repo_ids: '[]', created_at: now(), default_engine: '', default_agent: '', default_model: '' });
      const updated = await repo.update(id, pid, { name: `new-${sfx}`, default_engine: 'kiro' });
      assert.ok(updated);
      assert.equal(updated!.name, `new-${sfx}`);
      assert.equal(updated!.default_engine, 'kiro');
    });

    test('update -- returns null for wrong project', async () => {
      const pid = `proj7-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `x-${sfx}`, repo_ids: '[]', created_at: now(), default_engine: '', default_agent: '', default_model: '' });
      const result = await repo.update(id, `wrong-${sfx}`, { name: 'new' });
      assert.equal(result, null);
    });

    test('delete -- removes workspace', async () => {
      const pid = `proj8-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `del-${sfx}`, repo_ids: '[]', created_at: now(), default_engine: '', default_agent: '', default_model: '' });
      const ok = await repo.delete(id, pid);
      assert.equal(ok, true);
      const after = await repo.getById(id);
      assert.equal(after, null);
    });

    test('delete -- returns false for non-existent', async () => {
      const ok = await repo.delete(`nope-${sfx}`, `nope-${sfx}`);
      assert.equal(ok, false);
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

describe('SQLite suite', () => {
  before(() => { createTestDb(); });
  after(() => { cleanup(); });
  runContract('SQLite', async () => new SqliteWorkspacesRepository());
});

// ── DynamoDB suite ────────────────────────────────────────────────────────────

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB) {
      throw new Error('REQUIRE_DYNAMODB is set but DYNAMODB_ENDPOINT is not');
    }
    test.skip('DynamoDB suite skipped (DYNAMODB_ENDPOINT not set)');
    return;
  }

  process.env.DYNAMODB_TABLE_PORTAL_CODE = `portal-code-test-ws-${RUN_TAG}`;
  const { DynamoDbWorkspacesRepository } = await import('../server/repositories/workspaces-dynamodb.ts');

  runContract('DynamoDB', async () => {
    const repo = new DynamoDbWorkspacesRepository();
    await repo.ensureTables();
    return repo;
  });
});
