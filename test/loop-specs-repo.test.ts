/**
 * Contract tests for LoopSpecsRepository.
 * SQLite and DynamoDB suites run the same assertions.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteLoopSpecsRepository } from '../server/repositories/loop-specs-sqlite.ts';
import type { LoopSpecsRepository } from '../server/repositories/loop-specs.ts';
import { clearLoopSpecsRepository } from '../server/repositories/loop-specs.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function insertProject(id: string): void {
  insert('projects', {
    id, slug: id, name: id, description: '', notes: '', created_by: null, created_at: now(),
    archived: 0, default_lead_agent: '', default_model: '', monthly_budget_usd: null, team_id: null, vault_generated: 0,
  });
}

function runContract(label: string, makeRepo: () => Promise<LoopSpecsRepository>): void {
  describe(`${label} -- LoopSpecsRepository contract`, () => {
    let repo: LoopSpecsRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    before(async () => { repo = await makeRepo(); });
    after(() => { clearLoopSpecsRepository(); });

    test('createSpec -- stores spec', async () => {
      const pid = `lp-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      const spec = await repo.createSpec({ id, project_id: pid, name: `spec-${sfx}`, description: null, trigger_type: 'manual', trigger_config: '{}', goal_template: 'hello', rules: null, stop_config: '{}', max_iterations: 3, enabled: 1, is_builtin: 0, created_at: now() });
      assert.equal(spec.id, id);
      assert.equal(spec.max_iterations, 3);
    });

    test('getSpecById -- returns spec', async () => {
      const pid = `lp2-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.createSpec({ id, project_id: pid, name: `s2-${sfx}`, description: null, trigger_type: 'cron', trigger_config: '{}', goal_template: 'g', rules: null, stop_config: '{}', max_iterations: 1, enabled: 1, is_builtin: 0, created_at: now() });
      const s = await repo.getSpecById(id);
      assert.ok(s);
      assert.equal(s!.trigger_type, 'cron');
    });

    test('getSpecById -- null for unknown', async () => {
      assert.equal(await repo.getSpecById(`nope-${sfx}`), null);
    });

    test('listSpecsByProject -- includes project specs', async () => {
      const pid = `lp3-${sfx}`;
      if (isSqlite) insertProject(pid);
      await repo.createSpec({ id: generateId(), project_id: pid, name: `sp1-${sfx}`, description: null, trigger_type: 'manual', trigger_config: '{}', goal_template: 'g', rules: null, stop_config: '{}', max_iterations: 1, enabled: 1, is_builtin: 0, created_at: now() });
      const list = await repo.listSpecsByProject(pid);
      assert.ok(list.some((s) => s.project_id === pid));
    });

    test('updateSpec -- changes fields', async () => {
      const pid = `lp4-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.createSpec({ id, project_id: pid, name: `upd-${sfx}`, description: null, trigger_type: 'manual', trigger_config: '{}', goal_template: 'old', rules: null, stop_config: '{}', max_iterations: 1, enabled: 1, is_builtin: 0, created_at: now() });
      const updated = await repo.updateSpec(id, pid, { goal_template: 'new', max_iterations: 5 });
      assert.ok(updated);
      assert.equal(updated!.goal_template, 'new');
      assert.equal(updated!.max_iterations, 5);
    });

    test('deleteSpec -- removes spec', async () => {
      const pid = `lp5-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.createSpec({ id, project_id: pid, name: `del-${sfx}`, description: null, trigger_type: 'manual', trigger_config: '{}', goal_template: 'g', rules: null, stop_config: '{}', max_iterations: 1, enabled: 1, is_builtin: 0, created_at: now() });
      const ok = await repo.deleteSpec(id, pid);
      assert.equal(ok, true);
      assert.equal(await repo.getSpecById(id), null);
    });

    test('createRun + getLastRunBySpec + listRunsBySpec', async () => {
      const pid = `lp6-${sfx}`;
      if (isSqlite) insertProject(pid);
      const specId = generateId();
      await repo.createSpec({ id: specId, project_id: pid, name: `run-${sfx}`, description: null, trigger_type: 'manual', trigger_config: '{}', goal_template: 'g', rules: null, stop_config: '{}', max_iterations: 1, enabled: 1, is_builtin: 0, created_at: now() });
      const runId = generateId();
      await repo.createRun({ id: runId, spec_id: specId, status: 'running', iteration: 0, last_workflow_id: null, started_at: now(), finished_at: null });
      const lastRun = await repo.getLastRunBySpec(specId);
      assert.ok(lastRun);
      assert.equal(lastRun!.spec_id, specId);
      const runs = await repo.listRunsBySpec(specId, 10);
      assert.ok(runs.length >= 1);
    });
  });
}

describe('SQLite suite', () => {
  before(() => { createTestDb(); });
  after(() => { cleanup(); });
  runContract('SQLite', async () => new SqliteLoopSpecsRepository());
});

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB) throw new Error('REQUIRE_DYNAMODB is set but DYNAMODB_ENDPOINT is not');
    test.skip('DynamoDB suite skipped (DYNAMODB_ENDPOINT not set)');
    return;
  }
  process.env.DYNAMODB_TABLE_PORTAL_P10 = `portal-p10-test-ls-${RUN_TAG}`;
  const { DynamoDbLoopSpecsRepository } = await import('../server/repositories/loop-specs-dynamodb.ts');
  runContract('DynamoDB', async () => {
    const repo = new DynamoDbLoopSpecsRepository();
    await repo.ensureTables();
    return repo;
  });
});
