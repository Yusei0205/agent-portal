/**
 * Contract tests for GitReposRepository (repositories table).
 * SQLite and DynamoDB suites run the same assertions.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteGitReposRepository } from '../server/repositories/git-repos-sqlite.ts';
import type { GitReposRepository } from '../server/repositories/git-repos.ts';
import { clearGitReposRepository } from '../server/repositories/git-repos.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function insertProject(id: string): void {
  insert('projects', {
    id, slug: id, name: id, description: '', notes: '', created_by: null, created_at: now(),
    archived: 0, default_lead_agent: '', default_model: '', monthly_budget_usd: null, team_id: null, vault_generated: 0,
  });
}

function runContract(label: string, makeRepo: () => Promise<GitReposRepository>): void {
  describe(`${label} -- GitReposRepository contract`, () => {
    let repo: GitReposRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    before(async () => { repo = await makeRepo(); });
    after(() => { clearGitReposRepository(); });

    test('create -- stores repo and returns it', async () => {
      const pid = `rp-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      const r = await repo.create({ id, project_id: pid, name: `repo-${sfx}`, url: `https://github.com/org/repo-${sfx}`, provider: 'github', status: 'cloning', default_branch: null, identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null });
      assert.equal(r.id, id);
      assert.equal(r.provider, 'github');
    });

    test('getById -- returns repo', async () => {
      const pid = `rp2-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `r2-${sfx}`, url: `https://github.com/o/r2-${sfx}`, provider: 'github', status: 'ready', default_branch: 'main', identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null });
      const r = await repo.getById(id);
      assert.ok(r);
      assert.equal(r!.id, id);
    });

    test('getById -- null for unknown', async () => {
      assert.equal(await repo.getById(`nope-${sfx}`), null);
    });

    test('getByIdForProject -- returns when project matches', async () => {
      const pid = `rp3-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `r3-${sfx}`, url: `https://github.com/o/r3-${sfx}`, provider: 'github', status: 'ready', default_branch: null, identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null });
      const r = await repo.getByIdForProject(id, pid);
      assert.ok(r);
    });

    test('getByIdForProject -- null for wrong project', async () => {
      const pid = `rp4-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `r4-${sfx}`, url: `https://github.com/o/r4-${sfx}`, provider: 'github', status: 'ready', default_branch: null, identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null });
      const r = await repo.getByIdForProject(id, `wrong-${sfx}`);
      assert.equal(r, null);
    });

    test('listByProject -- returns project repos', async () => {
      const pid = `rp5-${sfx}`;
      if (isSqlite) insertProject(pid);
      await repo.create({ id: generateId(), project_id: pid, name: `la-${sfx}`, url: `https://github.com/o/la-${sfx}`, provider: 'github', status: 'ready', default_branch: null, identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null });
      await repo.create({ id: generateId(), project_id: pid, name: `lb-${sfx}`, url: `https://github.com/o/lb-${sfx}`, provider: 'github', status: 'ready', default_branch: null, identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null });
      const list = await repo.listByProject(pid);
      assert.ok(list.length >= 2);
    });

    test('updateStatus -- changes status', async () => {
      const pid = `rp6-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `rs-${sfx}`, url: `https://g.com/o/rs-${sfx}`, provider: 'github', status: 'cloning', default_branch: null, identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null });
      await repo.updateStatus(id, 'ready', { lastSyncedAt: now(), defaultBranch: 'main' });
      const r = await repo.getById(id);
      assert.equal(r!.status, 'ready');
      assert.equal(r!.default_branch, 'main');
    });

    test('delete -- removes repo', async () => {
      const pid = `rp7-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create({ id, project_id: pid, name: `del-${sfx}`, url: `https://g.com/del-${sfx}`, provider: 'github', status: 'ready', default_branch: null, identity: null, last_synced_at: null, last_error: null, created_at: now(), connection_id: null });
      const ok = await repo.delete(id, pid);
      assert.equal(ok, true);
      assert.equal(await repo.getById(id), null);
    });
  });
}

describe('SQLite suite', () => {
  before(() => { createTestDb(); });
  after(() => { cleanup(); });
  runContract('SQLite', async () => new SqliteGitReposRepository());
});

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB) throw new Error('REQUIRE_DYNAMODB is set but DYNAMODB_ENDPOINT is not');
    test.skip('DynamoDB suite skipped (DYNAMODB_ENDPOINT not set)');
    return;
  }
  process.env.DYNAMODB_TABLE_PORTAL_CODE = `portal-code-test-gr-${RUN_TAG}`;
  const { DynamoDbGitReposRepository } = await import('../server/repositories/git-repos-dynamodb.ts');
  runContract('DynamoDB', async () => {
    const repo = new DynamoDbGitReposRepository();
    await repo.ensureTables();
    return repo;
  });
});
