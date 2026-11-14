/**
 * Contract tests for ScansRepository.
 * SQLite and DynamoDB suites run the same assertions.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteScansRepository } from '../server/repositories/scans-sqlite.ts';
import type { ScansRepository } from '../server/repositories/scans.ts';
import { clearScansRepository } from '../server/repositories/scans.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function insertProject(id: string): void {
  insert('projects', {
    id, slug: id, name: id, description: '', notes: '', created_by: null, created_at: now(),
    archived: 0, default_lead_agent: '', default_model: '', monthly_budget_usd: null, team_id: null, vault_generated: 0,
  });
}

function makeScanInput(id: string, pid: string) {
  return {
    id, project_id: pid, repo_id: null, branch: 'main', pinned_sha: null,
    include_paths: '[]', exclude_paths: '[]', background_doc_ids: '[]',
    model_role: null, provider_id: null, model_id: null, status: 'estimating' as const,
    fail_reason: null, budget_tokens: null, estimated_files: null, estimated_bytes: null,
    estimated_tokens: null, estimated_cost_usd: null, estimated_minutes: null,
    files_total: 0, files_done: 0, tokens_used: 0, cost_usd: 0, input_tokens: 0,
    output_tokens: 0, summary: null, review_id: null, created_by: null,
    created_at: now(), started_at: null, completed_at: null, workflow_id: null,
  };
}

function runContract(label: string, makeRepo: () => Promise<ScansRepository>): void {
  describe(`${label} -- ScansRepository contract`, () => {
    let repo: ScansRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    before(async () => { repo = await makeRepo(); });
    after(() => { clearScansRepository(); });

    test('create -- stores scan', async () => {
      const pid = `sc-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      const s = await repo.create(makeScanInput(id, pid));
      assert.equal(s.id, id);
      assert.equal(s.status, 'estimating');
    });

    test('getById -- returns scan', async () => {
      const pid = `sc2-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create(makeScanInput(id, pid));
      const s = await repo.getById(id);
      assert.ok(s);
      assert.equal(s!.id, id);
    });

    test('getById -- null for unknown', async () => {
      assert.equal(await repo.getById(`nope-${sfx}`), null);
    });

    test('getByIdForProject -- matches project', async () => {
      const pid = `sc3-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create(makeScanInput(id, pid));
      const s = await repo.getByIdForProject(id, pid);
      assert.ok(s);
    });

    test('getByIdForProject -- null for wrong project', async () => {
      const pid = `sc4-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create(makeScanInput(id, pid));
      assert.equal(await repo.getByIdForProject(id, `wrong-${sfx}`), null);
    });

    test('listByProject -- returns scans', async () => {
      const pid = `sc5-${sfx}`;
      if (isSqlite) insertProject(pid);
      await repo.create(makeScanInput(generateId(), pid));
      await repo.create(makeScanInput(generateId(), pid));
      const result = await repo.listByProject(pid, { limit: 10, offset: 0 });
      assert.ok(result.items.length >= 2);
      assert.ok(result.total >= 2);
    });

    test('update -- changes fields', async () => {
      const pid = `sc6-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create(makeScanInput(id, pid));
      await repo.update(id, { status: 'estimate_ready', estimated_files: 10 });
      const s = await repo.getById(id);
      assert.equal(s!.status, 'estimate_ready');
      assert.equal(s!.estimated_files, 10);
    });

    test('delete -- removes scan', async () => {
      const pid = `sc7-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create(makeScanInput(id, pid));
      const ok = await repo.delete(id, pid);
      assert.equal(ok, true);
      assert.equal(await repo.getById(id), null);
    });

    test('createFile + listFiles', async () => {
      const pid = `sc8-${sfx}`;
      if (isSqlite) insertProject(pid);
      const scanId = generateId();
      await repo.create(makeScanInput(scanId, pid));
      const fid = generateId();
      await repo.createFile({ id: fid, scan_id: scanId, file_path: 'src/main.ts', status: 'pending', tokens_used: 0, done_at: null });
      const files = await repo.listFiles(scanId);
      assert.ok(files.some((f) => f.id === fid));
    });
  });
}

describe('SQLite suite', () => {
  before(() => { createTestDb(); });
  after(() => { cleanup(); });
  runContract('SQLite', async () => new SqliteScansRepository());
});

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB) throw new Error('REQUIRE_DYNAMODB is set but DYNAMODB_ENDPOINT is not');
    test.skip('DynamoDB suite skipped (DYNAMODB_ENDPOINT not set)');
    return;
  }
  process.env.DYNAMODB_TABLE_PORTAL_CODE = `portal-code-test-sc-${RUN_TAG}`;
  const { DynamoDbScansRepository } = await import('../server/repositories/scans-dynamodb.ts');
  runContract('DynamoDB', async () => {
    const repo = new DynamoDbScansRepository();
    await repo.ensureTables();
    return repo;
  });
});
