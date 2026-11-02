/**
 * Contract tests for ReviewsRepository.
 * SQLite and DynamoDB suites run the same assertions.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteReviewsRepository } from '../server/repositories/reviews-sqlite.ts';
import type { ReviewsRepository } from '../server/repositories/reviews.ts';
import { clearReviewsRepository } from '../server/repositories/reviews.ts';
import { generateId, now, newId } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function insertProject(id: string): void {
  insert('projects', {
    id, slug: id, name: id, description: '', notes: '', created_by: null, created_at: now(),
    archived: 0, default_lead_agent: '', default_model: '', monthly_budget_usd: null, team_id: null, vault_generated: 0,
  });
}

function insertWorkflow(id: string, projectId: string): void {
  try {
    insert('p6_workflows', {
      id, project_id: projectId, goal: 'test', status: 'pending', engine: 'demo',
      trust_tools: 0, lead_agent: null, workspace_id: null, output_files_enabled: 0,
      repo_ids: '[]', iteration_count: 0, max_iterations: 1, created_by: null,
      created_at: now(), updated_at: now(),
    });
  } catch { /* ignore */ }
}

function makeReviewInput(id: string, pid: string, wfId?: string) {
  return {
    id, project_id: pid, base_ref: 'main', head_ref: 'feature/x', pr_number: null,
    repo_id: null, status: 'pending' as const, post_mode: 'draft', from_loop: null,
    workflow_id: wfId ?? null, min_severity: 'high', summary: null, raw_output: null,
    created_by: null, created_at: now(), parent_review_id: null, source_sha: null,
    dest_sha: null, provider_id: null, model_id: null, jira_context: '{}', run_log: '[]',
    input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
    llm_requests: 0, retry_count: 0, tool_calls: 0, files_reviewed: 0, duration_ms: null,
    started_at: null, merged_at: null, merged_by: null, head_commit_sha: null,
  };
}

function runContract(label: string, makeRepo: () => Promise<ReviewsRepository>): void {
  describe(`${label} -- ReviewsRepository contract`, () => {
    let repo: ReviewsRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    before(async () => { repo = await makeRepo(); });
    after(() => { clearReviewsRepository(); });

    test('create -- stores review', async () => {
      const pid = `rv-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      const r = await repo.create(makeReviewInput(id, pid));
      assert.equal(r.id, id);
      assert.equal(r.status, 'pending');
    });

    test('getById -- returns review', async () => {
      const pid = `rv2-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create(makeReviewInput(id, pid));
      const r = await repo.getById(id);
      assert.ok(r);
      assert.equal(r!.id, id);
    });

    test('getById -- null for unknown', async () => {
      assert.equal(await repo.getById(`nope-${sfx}`), null);
    });

    test('getByWorkflowId -- finds review by workflow', async () => {
      const pid = `rv3-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      const wfId = generateId();
      if (isSqlite) insertWorkflow(wfId, pid);
      await repo.create(makeReviewInput(id, pid, wfId));
      const r = await repo.getByWorkflowId(wfId);
      assert.ok(r);
      assert.equal(r!.id, id);
    });

    test('listByProject -- returns reviews with count', async () => {
      const pid = `rv4-${sfx}`;
      if (isSqlite) insertProject(pid);
      await repo.create(makeReviewInput(generateId(), pid));
      await repo.create(makeReviewInput(generateId(), pid));
      const result = await repo.listByProject(pid, { limit: 10, offset: 0 });
      assert.ok(result.items.length >= 2);
      assert.ok(result.total >= 2);
    });

    test('listByProjectIds -- returns reviews since date', async () => {
      const pid = `rv5-${sfx}`;
      if (isSqlite) insertProject(pid);
      await repo.create(makeReviewInput(generateId(), pid));
      const all = await repo.listByProjectIds([pid], '2020-01-01T00:00:00Z');
      assert.ok(all.length >= 1);
    });

    test('update -- changes fields', async () => {
      const pid = `rv6-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create(makeReviewInput(id, pid));
      await repo.update(id, { status: 'done', summary: 'looks good' });
      const r = await repo.getById(id);
      assert.equal(r!.status, 'done');
      assert.equal(r!.summary, 'looks good');
    });

    test('delete -- removes review', async () => {
      const pid = `rv7-${sfx}`;
      if (isSqlite) insertProject(pid);
      const id = generateId();
      await repo.create(makeReviewInput(id, pid));
      const ok = await repo.delete(id, pid);
      assert.equal(ok, true);
      assert.equal(await repo.getById(id), null);
    });

    test('createFinding + listFindings', async () => {
      const pid = `rv8-${sfx}`;
      if (isSqlite) insertProject(pid);
      const rid = generateId();
      await repo.create(makeReviewInput(rid, pid));
      const fid = newId('f_');
      await repo.createFinding({ id: fid, review_id: rid, file_path: 'src/x.ts', line_number: 10, severity: 'high', title: 'Issue', body: 'Details', confidence: null, accepted: 0, posted_at: null, created_at: now() });
      const findings = await repo.listFindings(rid);
      assert.ok(findings.some((f) => f.id === fid));
    });

    test('getFindingById -- returns finding', async () => {
      const pid = `rv9-${sfx}`;
      if (isSqlite) insertProject(pid);
      const rid = generateId();
      await repo.create(makeReviewInput(rid, pid));
      const fid = newId('f_');
      await repo.createFinding({ id: fid, review_id: rid, file_path: 'a.ts', line_number: null, severity: 'low', title: 'T', body: 'B', confidence: null, accepted: 0, posted_at: null, created_at: now() });
      const f = await repo.getFindingById(fid, rid);
      assert.ok(f);
      assert.equal(f!.severity, 'low');
    });

    test('updateFinding -- changes accepted', async () => {
      const pid = `rv10-${sfx}`;
      if (isSqlite) insertProject(pid);
      const rid = generateId();
      await repo.create(makeReviewInput(rid, pid));
      const fid = newId('f_');
      await repo.createFinding({ id: fid, review_id: rid, file_path: 'b.ts', line_number: null, severity: 'medium', title: 'T2', body: 'B2', confidence: null, accepted: 0, posted_at: null, created_at: now() });
      await repo.updateFinding(fid, { accepted: 1, review_id: rid });
      const f = await repo.getFindingById(fid, rid);
      assert.equal(f!.accepted, 1);
    });

    test('markFindingPosted -- sets posted_at', async () => {
      const pid = `rv11-${sfx}`;
      if (isSqlite) insertProject(pid);
      const rid = generateId();
      await repo.create(makeReviewInput(rid, pid));
      const fid = newId('f_');
      await repo.createFinding({ id: fid, review_id: rid, file_path: 'c.ts', line_number: null, severity: 'info', title: 'T3', body: 'B3', confidence: null, accepted: 0, posted_at: null, created_at: now() });
      const ts = now();
      await repo.markFindingPosted(fid, ts);
      const f = await repo.getFindingById(fid, rid);
      assert.ok(f!.posted_at);
    });
  });
}

describe('SQLite suite', () => {
  before(() => { createTestDb(); });
  after(() => { cleanup(); });
  runContract('SQLite', async () => new SqliteReviewsRepository());
});

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB) throw new Error('REQUIRE_DYNAMODB is set but DYNAMODB_ENDPOINT is not');
    test.skip('DynamoDB suite skipped (DYNAMODB_ENDPOINT not set)');
    return;
  }
  process.env.DYNAMODB_TABLE_PORTAL_P10 = `portal-p10-test-rv-${RUN_TAG}`;
  const { DynamoDbReviewsRepository } = await import('../server/repositories/reviews-dynamodb.ts');
  runContract('DynamoDB', async () => {
    const repo = new DynamoDbReviewsRepository();
    await repo.ensureTables();
    return repo;
  });
});
