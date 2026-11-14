/**
 * Trace helpers (startStep / finishStep / getCaseSetTrace / getGenerationTrace) on both backends.
 * The DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { SqliteTestingRepository } from '../server/repositories/testing-data-sqlite.ts';
import { setTestingRepository, clearTestingRepository } from '../server/repositories/testing-data.ts';
import type { TestingRepository } from '../server/repositories/testing-data.ts';
import { startStep, finishStep, getCaseSetTrace, getGenerationTrace } from '../server/testing/trace.ts';
import { now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const TAG = Date.now().toString(36).slice(-5);

function suite(label: string, make: () => Promise<TestingRepository>, sqlite: boolean): void {
  describe(`${label} — trace steps`, () => {
    let repo: TestingRepository;
    const projectId = `p-${label}-${TAG}`;
    const userId = `u-${label}-${TAG}`;
    const tpId = `tp-${label}-${TAG}`;
    const csId = `cs-${label}-${TAG}`;
    const genId = `gn-${label}-${TAG}`;

    before(async () => {
      if (sqlite) {
        createTestDb();
        insert('users', { id: userId, email: `${userId}@t.com`, name: 'T', password_hash: 'x', is_admin: 1, created_at: now() });
        insert('projects', { id: projectId, name: projectId, slug: projectId, created_by: userId, created_at: now(), archived: 0 });
      }
      repo = await make();
      setTestingRepository(repo);
      await repo.createTestProject({
        id: tpId, project_id: projectId, name: 'T', app_url: 'http://x', api_base_url: null, repo_ids: '[]',
        vault_doc_paths: '[]', viewport_width: 1, viewport_height: 1, timeout_secs: 30, rules_for_ai: '',
        created_by: userId, created_at: now(), updated_at: now(),
      });
      await repo.createCaseSet({
        id: csId, test_project_id: tpId, name: 'cs', description: '', status: 'running', progress: '{}', error: null,
        warnings: '[]', created_by: userId, created_at: now(), started_at: now(), finished_at: null, cancelled: 0,
        outline_categories: null, attachment_ids: '[]',
      });
      await repo.createGeneration({
        id: genId, test_project_id: tpId, script_id: null, kind: 'generate', description: 'd', status: 'running',
        error: null, result_script_ids: '[]', warnings: '[]', created_by: userId, created_at: now(), finished_at: null,
        progress: '{}', started_at: now(), cancelled_at: null,
      });
    });
    after(() => clearTestingRepository());

    test('a case-set step is created running and finished with status, duration and output', async () => {
      const s = await startStep({ parentKind: 'case_set', parentId: csId, seq: 1, kind: 'outline', label: 'Outline', detail: { a: 1 } });
      const running = (await getCaseSetTrace(csId)).find((x) => x.id === s.id);
      assert.equal(running?.status, 'running');
      await finishStep(s.id, s.startedAt, { status: 'ok', output: 'result text', detail: { done: true } });
      const done = (await getCaseSetTrace(csId)).find((x) => x.id === s.id);
      assert.equal(done?.status, 'ok');
      assert.equal(done?.output, 'result text');
      assert.deepEqual(done?.detail, { done: true });
      assert.ok(done?.finishedAt);
    });

    test('steps come back in seq order and long output is truncated with a flag', async () => {
      const a = await startStep({ parentKind: 'case_set', parentId: csId, seq: 3, kind: 'x', label: 'third' });
      const b = await startStep({ parentKind: 'case_set', parentId: csId, seq: 2, kind: 'x', label: 'second' });
      await finishStep(a.id, a.startedAt, { status: 'ok', output: 'z'.repeat(30_000) });
      await finishStep(b.id, b.startedAt, { status: 'failed', error: 'boom' });
      const steps = await getCaseSetTrace(csId);
      assert.deepEqual(steps.map((x) => x.seq), [1, 2, 3]);
      const third = steps.find((x) => x.id === a.id);
      assert.equal(third?.outputTruncated, true);
      assert.equal(String(third?.output).length, 20_000);
      assert.equal(steps.find((x) => x.id === b.id)?.error, 'boom');
    });

    test('generation steps are separate from case-set steps', async () => {
      const g = await startStep({ parentKind: 'generation', parentId: genId, seq: 1, kind: 'context', label: 'ctx' });
      await finishStep(g.id, g.startedAt, { status: 'ok' });
      const steps = await getGenerationTrace(genId);
      assert.equal(steps.length, 1);
      assert.equal(steps[0].status, 'ok');
      assert.ok(!(await getCaseSetTrace(csId)).some((x) => x.id === g.id));
    });
  });
}

suite('SQLite', async () => new SqliteTestingRepository(), true);

describe('DynamoDB Local — trace steps', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB === '1') throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    test.skip('DynamoDB Local not available (DYNAMODB_ENDPOINT not set)', () => {});
    return;
  }
  const { DynamoDbTestingRepository, ensureTestingTableExists } = await import('../server/repositories/testing-data-dynamodb.ts');
  const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
  const tableName = `portal-testing-trace-${TAG}`;
  before(async () => {
    clearDynamoDbClient();
    const r = new DynamoDbTestingRepository({ tableName });
    await ensureTestingTableExists(r.getClient(), tableName);
  });
  suite('DynamoDB', async () => new DynamoDbTestingRepository({ tableName }), false);
});
