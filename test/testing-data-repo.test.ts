/**
 * Contract tests for TestingRepository.
 *
 * Covers: test_projects, test_groups, test_scripts, test_vault_items,
 *         test_vault_files, test_runs, test_run_steps, test_case_sets,
 *         test_cases, test_generations, trace_steps.
 *
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteTestingRepository } from '../server/repositories/testing-data-sqlite.ts';
import type { TestingRepository } from '../server/repositories/testing-data.ts';
import { clearTestingRepository } from '../server/repositories/testing-data.ts';
import { now, generateId } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── Shared contract suite ─────────────────────────────────────────────────────

function runContract(
  label: string,
  makeRepo: () => Promise<TestingRepository>,
): void {
  describe(`${label} — TestingRepository contract`, () => {
    let repo: TestingRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const projectId = `proj-${sfx}`;
    const userId = `user-${sfx}`;
    let testProjectId: string;

    before(async () => {
      if (label.toLowerCase().includes('sqlite')) {
        createTestDb();
        try {
          insert('users', {
            id: userId, email: `${userId}@test.com`, name: 'Test',
            password_hash: 'x', is_admin: 1, created_at: now(),
          });
          insert('projects', {
            id: projectId, name: `proj-${sfx}`, slug: `proj-tst-${sfx}`,
            created_by: userId, created_at: now(), archived: 0,
          });
        } catch { /* may already exist */ }
      }
      repo = await makeRepo();
      // Create a test project to use for most tests
      testProjectId = `tp-${sfx}`;
      await repo.createTestProject({
        id: testProjectId, project_id: projectId, name: 'Test Project',
        app_url: 'http://localhost:3000', api_base_url: null,
        repo_ids: '[]', vault_doc_paths: '[]',
        viewport_width: 1440, viewport_height: 900, timeout_secs: 30,
        rules_for_ai: '', created_by: userId, created_at: now(), updated_at: now(),
      });
    });

    after(() => {
      clearTestingRepository();
      if (label.toLowerCase().includes('sqlite')) cleanup();
    });

    // ── test_projects ─────────────────────────────────────────────────────────

    test('createTestProject — round-trip', async () => {
      const id = `tp2-${sfx}`;
      const rec = await repo.createTestProject({
        id, project_id: projectId, name: 'TP2', app_url: 'http://app2.test', api_base_url: null,
        repo_ids: '[]', vault_doc_paths: '[]', viewport_width: 1280, viewport_height: 720,
        timeout_secs: 60, rules_for_ai: 'be careful', created_by: userId,
        created_at: now(), updated_at: now(),
      });
      assert.equal(rec.id, id);
      assert.equal(rec.rules_for_ai, 'be careful');
    });

    test('getTestProjectByProjectAndId — returns null for wrong project', async () => {
      const result = await repo.getTestProjectByProjectAndId(`wrong-${sfx}`, testProjectId);
      assert.equal(result, null);
    });

    test('listTestProjectsByProject — returns created project', async () => {
      const list = await repo.listTestProjectsByProject(projectId);
      assert.ok(list.some((tp) => tp.id === testProjectId));
    });

    // ── test_groups ───────────────────────────────────────────────────────────

    test('createTestGroup — round-trip', async () => {
      const id = `tg-${sfx}`;
      const rec = await repo.createTestGroup({
        id, test_project_id: testProjectId, name: 'Group A', sort_order: 0,
        created_at: now(), updated_at: now(),
      });
      assert.equal(rec.id, id);
      assert.equal(rec.name, 'Group A');
    });

    test('listGroupsByTestProject — includes created group', async () => {
      const id = `tg2-${sfx}`;
      await repo.createTestGroup({
        id, test_project_id: testProjectId, name: 'Group B', sort_order: 1,
        created_at: now(), updated_at: now(),
      });
      const list = await repo.listGroupsByTestProject(testProjectId);
      assert.ok(list.some((g) => g.id === id));
    });

    // ── test_scripts ──────────────────────────────────────────────────────────

    test('createTestScript — round-trip', async () => {
      const groupId = `tg-sc-${sfx}`;
      await repo.createTestGroup({
        id: groupId, test_project_id: testProjectId, name: 'G', sort_order: 0,
        created_at: now(), updated_at: now(),
      });
      const id = `ts-${sfx}`;
      const rec = await repo.createTestScript({
        id, test_project_id: testProjectId, test_group_id: groupId,
        name: 'Script A', sort_order: 0, steps: '[{"kind":"goto","path":"/"}]',
        created_by: userId, created_at: now(), updated_at: now(),
      });
      assert.equal(rec.id, id);
      assert.equal(rec.name, 'Script A');
    });

    // ── test_vault_items ──────────────────────────────────────────────────────

    test('createVaultItem — round-trip', async () => {
      const id = `tvi-${sfx}`;
      const rec = await repo.createVaultItem({
        id, test_project_id: testProjectId, name: `vault-${sfx}`, kind: 'login',
        username: 'admin', password_enc: 'enc123', totp_secret_enc: null, value_enc: null,
        created_by: userId, created_at: now(), updated_at: now(),
      });
      assert.equal(rec.id, id);
      assert.equal(rec.kind, 'login');
    });

    test('getVaultItemByTestProjectAndName — finds by name', async () => {
      const id = `tvi2-${sfx}`;
      const name = `secret-${sfx}`;
      await repo.createVaultItem({
        id, test_project_id: testProjectId, name, kind: 'secret',
        username: null, password_enc: null, totp_secret_enc: null, value_enc: 'val123',
        created_by: userId, created_at: now(), updated_at: now(),
      });
      const found = await repo.getVaultItemByTestProjectAndName(testProjectId, name);
      assert.ok(found, 'should find vault item by name');
      assert.equal(found.id, id);
    });

    // ── test_runs ─────────────────────────────────────────────────────────────

    test('createTestRun — round-trip', async () => {
      const id = `tr-${sfx}`;
      const rec = await repo.createTestRun({
        id, test_project_id: testProjectId, script_id: null, group_id: null,
        status: 'queued', error: null, artifact_dir: null, created_by: userId,
        created_at: now(), started_at: null, finished_at: null,
      });
      assert.equal(rec.id, id);
      assert.equal(rec.status, 'queued');
    });

    test('updateTestRun — updates status', async () => {
      const id = `tr2-${sfx}`;
      await repo.createTestRun({
        id, test_project_id: testProjectId, script_id: null, group_id: null,
        status: 'queued', error: null, artifact_dir: null, created_by: userId,
        created_at: now(), started_at: null, finished_at: null,
      });
      await repo.updateTestRun(id, { status: 'passed', finished_at: now() });
      const found = await repo.getTestRunById(id);
      assert.equal(found?.status, 'passed');
    });

    // ── test_case_sets ────────────────────────────────────────────────────────

    test('createCaseSet — round-trip', async () => {
      const id = `tcs-${sfx}`;
      const rec = await repo.createCaseSet({
        id, test_project_id: testProjectId, name: 'Auth Cases',
        description: 'Authentication test cases',
        status: 'pending', progress: '{}', error: null, warnings: '[]',
        created_by: userId, created_at: now(), started_at: null, finished_at: null,
        cancelled: 0, outline_categories: null, attachment_ids: '[]',
      });
      assert.equal(rec.id, id);
      assert.equal(rec.name, 'Auth Cases');
    });

    test('listCaseSetsByTestProject — returns created case set', async () => {
      const id = `tcs2-${sfx}`;
      await repo.createCaseSet({
        id, test_project_id: testProjectId, name: 'API Cases',
        description: '', status: 'done', progress: '{}', error: null, warnings: '[]',
        created_by: userId, created_at: now(), started_at: null, finished_at: null,
        cancelled: 0, outline_categories: null, attachment_ids: '[]',
      });
      const { items } = await repo.listCaseSetsByTestProject(testProjectId, 50, 0);
      assert.ok(items.some((cs) => cs.id === id));
    });

    // ── test_generations ──────────────────────────────────────────────────────

    test('createGeneration — round-trip', async () => {
      const id = `tgn-${sfx}`;
      const rec = await repo.createGeneration({
        id, test_project_id: testProjectId, script_id: null,
        kind: 'generate', description: 'Test generation', status: 'pending',
        error: null, result_script_ids: '[]', warnings: '[]',
        created_by: userId, created_at: now(), finished_at: null,
        progress: '{}', started_at: null, cancelled_at: null,
      });
      assert.equal(rec.id, id);
      assert.equal(rec.kind, 'generate');
    });

    // ── trace_steps ───────────────────────────────────────────────────────────

    test('createTraceStep — round-trip', async () => {
      const csId = `tcs-trace-${sfx}`;
      await repo.createCaseSet({
        id: csId, test_project_id: testProjectId, name: 'Trace Set',
        description: '', status: 'running', progress: '{}', error: null, warnings: '[]',
        created_by: userId, created_at: now(), started_at: now(), finished_at: null,
        cancelled: 0, outline_categories: null, attachment_ids: '[]',
      });
      const traceId = `trace-${sfx}`;
      const rec = await repo.createTraceStep({
        id: traceId, case_set_id: csId, generation_id: null,
        seq: 1, kind: 'context', label: 'Building context',
        status: 'running', started_at: now(), finished_at: null, duration_ms: null,
        detail: '{}', prompt: null, output: null, output_truncated: 0, error: null,
      });
      assert.equal(rec.id, traceId);
      assert.equal(rec.kind, 'context');

      const steps = await repo.listTraceByCaseSet(csId);
      assert.ok(steps.some((s) => s.id === traceId));
    });

    // ── cases and trace: update/delete with their parent context ──────────────

    test('cases — update, reorder and delete by case set', async () => {
      const csId = `tcs-cases-${sfx}`;
      await repo.createCaseSet({
        id: csId, test_project_id: testProjectId, name: 'Cases', description: '', status: 'done',
        progress: '{}', error: null, warnings: '[]', created_by: userId, created_at: now(),
        started_at: null, finished_at: null, cancelled: 0, outline_categories: null, attachment_ids: '[]',
      });
      const mk = (id: string, ord: number) => repo.createCase({
        id, case_set_id: csId, ord, test_id: `T${ord}`, category: 'Auth', scenario: `s${ord}`,
        precondition: '', steps: '', expected_result: '', status: 'Not Run', remarks: '',
        request: null, response: null, created_at: now(), updated_at: now(),
      });
      await mk(`c1-${sfx}`, 1);
      await mk(`c2-${sfx}`, 2);

      assert.equal((await repo.getCaseById(`c1-${sfx}`, csId))?.scenario, 's1');
      await repo.updateCase(`c1-${sfx}`, { scenario: 'changed', status: 'Pass' }, csId);
      const after = await repo.getCaseById(`c1-${sfx}`, csId);
      assert.equal(after?.scenario, 'changed');
      assert.equal(after?.status, 'Pass');

      // Reordering moves the case without duplicating it.
      await repo.updateCase(`c1-${sfx}`, { ord: 5 }, csId);
      const list = await repo.listCasesByCaseSet(csId);
      assert.deepEqual(list.map((c) => c.id), [`c2-${sfx}`, `c1-${sfx}`]);

      await repo.deleteCase(`c2-${sfx}`, csId);
      assert.deepEqual((await repo.listCasesByCaseSet(csId)).map((c) => c.id), [`c1-${sfx}`]);
    });

    test('trace step — update through its parent and seq', async () => {
      const csId = `tcs-trace2-${sfx}`;
      await repo.createCaseSet({
        id: csId, test_project_id: testProjectId, name: 'Trace 2', description: '', status: 'running',
        progress: '{}', error: null, warnings: '[]', created_by: userId, created_at: now(),
        started_at: now(), finished_at: null, cancelled: 0, outline_categories: null, attachment_ids: '[]',
      });
      const id = `trace2-${sfx}`;
      await repo.createTraceStep({
        id, case_set_id: csId, generation_id: null, seq: 3, kind: 'llm', label: 'Call',
        status: 'running', started_at: now(), finished_at: null, duration_ms: null,
        detail: '{}', prompt: null, output: null, output_truncated: 0, error: null,
      });
      await repo.updateTraceStep(id, { status: 'ok', duration_ms: 42, output: 'done' }, { case_set_id: csId, generation_id: null, seq: 3 });
      const step = (await repo.listTraceByCaseSet(csId)).find((x) => x.id === id);
      assert.equal(step?.status, 'ok');
      assert.equal(step?.duration_ms, 42);
      assert.equal(step?.output, 'done');
    });

    test("listScriptsByGroup — returns only that group's scripts", async () => {
      const mkGroup = (id: string, order: number) => repo.createTestGroup({
        id, test_project_id: testProjectId, name: id, sort_order: order, created_at: now(), updated_at: now(),
      } as never);
      await mkGroup(`g1-${sfx}`, 1);
      await mkGroup(`g2-${sfx}`, 2);
      const mkScript = (id: string, group: string, order: number) => repo.createTestScript({
        id, test_project_id: testProjectId, test_group_id: group, name: id, sort_order: order,
        steps: '[]', created_by: userId, created_at: now(), updated_at: now(),
      });
      await mkScript(`s1-${sfx}`, `g1-${sfx}`, 1);
      await mkScript(`s2-${sfx}`, `g2-${sfx}`, 1);
      assert.deepEqual((await repo.listScriptsByGroup(`g1-${sfx}`)).map((x) => x.id), [`s1-${sfx}`]);
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

runContract('SQLite', async () => new SqliteTestingRepository());

// ── DynamoDB suite ────────────────────────────────────────────────────────────

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB === '1') {
      throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    }
    test.skip('DynamoDB Local not available (DYNAMODB_ENDPOINT not set)', () => {});
    return;
  }

  const { DynamoDbTestingRepository, ensureTestingTableExists } = await import(
    '../server/repositories/testing-data-dynamodb.ts'
  );
  const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');

  const tableName = `portal-testing-test-${RUN_TAG}`;

  before(async () => {
    clearDynamoDbClient();
    process.env.DYNAMODB_TABLE_PORTAL_TESTING = tableName;
    const repo = new DynamoDbTestingRepository({ tableName });
    await ensureTestingTableExists(repo.getClient(), tableName);
  });

  after(() => {
    delete process.env.DYNAMODB_TABLE_PORTAL_TESTING;
    clearDynamoDbClient();
    clearTestingRepository();
  });

  runContract('DynamoDB', async () => new DynamoDbTestingRepository({ tableName }));
});
