/**
 * Contract tests for OutputFilesRepository.
 *
 * The same assertions run against both SQLite and DynamoDB Local.
 * DynamoDB suite runs only when DYNAMODB_ENDPOINT is set.
 * Set REQUIRE_DYNAMODB=1 to turn the skip into a failure.
 *
 * To run locally (PowerShell 5.1 — no &&):
 *   docker run -d --rm --name ddb-outfiles -p 8000:8000 amazon/dynamodb-local
 *   $env:DYNAMODB_ENDPOINT='http://localhost:8000'; $env:REQUIRE_DYNAMODB='1'
 *   node --disable-warning=ExperimentalWarning --import tsx --test test/output-files-repo.test.ts
 *   docker stop ddb-outfiles
 *   Remove-Item Env:DYNAMODB_ENDPOINT; Remove-Item Env:REQUIRE_DYNAMODB
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './fixtures.ts';
import { SqliteOutputFilesRepository } from '../server/repositories/output-files-sqlite.ts';
import type { OutputFilesRepository } from '../server/repositories/output-files.ts';
import { clearOutputFilesRepository } from '../server/repositories/output-files.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

// ── FK helpers ────────────────────────────────────────────────────────────────

function maybeWorkflow(wfId: string, runId: string, isSqlite: boolean): void {
  if (!isSqlite) return;
  try {
    insert('projects', {
      id: `proj-${wfId}`,
      slug: `slug-${wfId}`,
      name: `proj-${wfId}`,
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
  } catch { /* dup */ }
  try {
    insert('p6_workflows', {
      id: wfId,
      project_id: `proj-${wfId}`,
      goal: 'test',
      status: 'done',
      engine: 'demo',
      trust_tools: 0,
      created_at: now(),
      updated_at: now(),
      stop_reason: '',
      lead_agent: 'test',
      title: 'test',
      jira_key: '',
      jira_summary: '',
    });
  } catch { /* dup */ }
  try {
    insert('p6_runs', {
      id: runId,
      workflow_id: wfId,
      status: 'done',
      created_at: now(),
      started_at: null,
      finished_at: null,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
  } catch { /* dup */ }
}

function makeInput(wfId: string, runId: string, overrides: Partial<Parameters<OutputFilesRepository['create']>[0]> = {}) {
  return {
    id: generateId(),
    workflow_id: wfId,
    run_id: runId,
    name: 'output.md',
    path: 'output.md',
    size_bytes: 512,
    mime_type: 'text/markdown',
    version: 1,
    refused_reason: null,
    hash: generateId(),
    created_at: now(),
    ...overrides,
  };
}

// ── Shared contract ───────────────────────────────────────────────────────────

function runContract(label: string, makeRepo: () => Promise<OutputFilesRepository>): void {
  describe(`${label} -- OutputFilesRepository contract`, () => {
    let repo: OutputFilesRepository;
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    const isSqlite = label === 'SQLite';

    before(async () => {
      repo = await makeRepo();
    });

    after(() => {
      clearOutputFilesRepository();
    });

    // ── CRUD ─────────────────────────────────────────────────────────────────

    test('create -- stores and returns output file', async () => {
      const wfId = `owf1-${sfx}`;
      const runId = `or1-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      const id = generateId();
      const f = await repo.create(makeInput(wfId, runId, { id, name: 'out.pdf' }));
      assert.equal(f.id, id);
      assert.equal(f.name, 'out.pdf');
      assert.equal(f.version, 1);
    });

    test('getById -- returns file for correct workflow', async () => {
      const wfId = `owf2-${sfx}`;
      const runId = `or2-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      const id = generateId();
      await repo.create(makeInput(wfId, runId, { id }));
      const found = await repo.getById(id, wfId);
      assert.ok(found);
      assert.equal(found.id, id);
    });

    test('getById -- returns null for wrong workflow', async () => {
      const wfId = `owf3-${sfx}`;
      const runId = `or3-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      const id = generateId();
      await repo.create(makeInput(wfId, runId, { id }));
      const notFound = await repo.getById(id, `other-wf-${sfx}`);
      assert.equal(notFound, null);
    });

    test('getLatestByPath -- returns latest version', async () => {
      const wfId = `owf4-${sfx}`;
      const runId = `or4-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      await repo.create(makeInput(wfId, runId, { path: 'report.md', version: 1, hash: 'h1', created_at: '2026-01-01T00:00:00.000Z' }));
      await repo.create(makeInput(wfId, runId, { path: 'report.md', version: 2, hash: 'h2', created_at: '2026-01-02T00:00:00.000Z' }));
      const latest = await repo.getLatestByPath(wfId, 'report.md');
      assert.ok(latest);
      assert.equal(latest.version, 2);
    });

    test('getLatestByPath -- excludes refused files', async () => {
      const wfId = `owf5-${sfx}`;
      const runId = `or5-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      await repo.create(makeInput(wfId, runId, { path: 'big.pdf', version: 1, refused_reason: 'Too large', hash: null }));
      const found = await repo.getLatestByPath(wfId, 'big.pdf');
      assert.equal(found, null);
    });

    test('getLatestByPath -- returns null when no file exists', async () => {
      const wfId = `owf6-${sfx}`;
      const runId = `or6-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      const found = await repo.getLatestByPath(wfId, 'nonexistent.md');
      assert.equal(found, null);
    });

    // ── listLatestByWorkflow ──────────────────────────────────────────────────

    test('listLatestByWorkflow -- returns latest version per path', async () => {
      const wfId = `owf7-${sfx}`;
      const runId = `or7-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      // Two versions of the same path + one unique path
      await repo.create(makeInput(wfId, runId, { path: 'a.md', version: 1, hash: 'h1', created_at: '2026-01-01T00:00:00.000Z' }));
      await repo.create(makeInput(wfId, runId, { path: 'a.md', version: 2, hash: 'h2', created_at: '2026-01-02T00:00:00.000Z' }));
      await repo.create(makeInput(wfId, runId, { path: 'b.md', version: 1, hash: 'h3', created_at: '2026-01-03T00:00:00.000Z' }));
      const files = await repo.listLatestByWorkflow(wfId);
      // Should have exactly 2 unique paths
      const paths = files.map((f) => f.path);
      assert.ok(paths.includes('a.md'));
      assert.ok(paths.includes('b.md'));
      assert.equal(paths.filter((p) => p === 'a.md').length, 1, 'only latest version of a.md');
      const aFile = files.find((f) => f.path === 'a.md')!;
      assert.equal(aFile.version, 2, 'latest version must be 2');
    });

    test('listLatestByWorkflow -- excludes refused files', async () => {
      const wfId = `owf8-${sfx}`;
      const runId = `or8-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      await repo.create(makeInput(wfId, runId, { path: 'refused.pdf', version: 1, refused_reason: 'Too large', hash: null }));
      await repo.create(makeInput(wfId, runId, { path: 'valid.md', version: 1, hash: 'h1' }));
      const files = await repo.listLatestByWorkflow(wfId);
      assert.ok(!files.some((f) => f.path === 'refused.pdf'), 'refused files must be excluded');
      assert.ok(files.some((f) => f.path === 'valid.md'));
    });

    // ── Vault file ID link ────────────────────────────────────────────────────

    test('updateVaultFileId -- links vault file', async () => {
      const wfId = `owfv1-${sfx}`;
      const runId = `orv1-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      const id = generateId();
      await repo.create(makeInput(wfId, runId, { id }));
      const vaultFileId = `vf-${generateId()}`;
      await repo.updateVaultFileId(id, vaultFileId);
      const f = await repo.getById(id, wfId);
      assert.ok(f);
      assert.equal(f.vault_file_id, vaultFileId);
    });

    // ── Count ─────────────────────────────────────────────────────────────────

    test('countByWorkflow -- counts non-refused files', async () => {
      const wfId = `owfc1-${sfx}`;
      const runId = `orc1-${sfx}`;
      maybeWorkflow(wfId, runId, isSqlite);
      await repo.create(makeInput(wfId, runId, { path: 'a.md', hash: 'h1' }));
      await repo.create(makeInput(wfId, runId, { path: 'b.md', hash: 'h2' }));
      await repo.create(makeInput(wfId, runId, { path: 'c.pdf', refused_reason: 'Too big', hash: null }));
      const count = await repo.countByWorkflow(wfId);
      assert.equal(count, 2);
    });
  });
}

// ── SQLite suite ──────────────────────────────────────────────────────────────

runContract('SQLite', async () => {
  createTestDb();
  return new SqliteOutputFilesRepository();
});

// ── DynamoDB suite ────────────────────────────────────────────────────────────

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const require = process.env.REQUIRE_DYNAMODB === '1';

  if (!endpoint) {
    if (require) throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    test.skip('DynamoDB Local suite -- DYNAMODB_ENDPOINT not set');
    return;
  }

  const { DynamoDbOutputFilesRepository } = await import('../server/repositories/output-files-dynamodb.ts');

  runContract('DynamoDB', async () => {
    const repo = new DynamoDbOutputFilesRepository();
    await repo.ensureTables();
    return repo;
  });
});
