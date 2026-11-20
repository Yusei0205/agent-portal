/**
 * Contract tests for PipelineRunsRepository.
 *
 * The same assertions run against SQLite and DynamoDB. The DynamoDB suite runs only when DYNAMODB_ENDPOINT is set
 * (REQUIRE_DYNAMODB=1 turns the skip into a failure).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqlitePipelineRunsRepository } from '../server/repositories/pipeline-runs-sqlite.ts';
import type { PipelineAlert, PipelineRun, PipelineRunsRepository, PipelineStatus } from '../server/repositories/pipeline-runs.ts';
import { clearPipelineRunsRepository } from '../server/repositories/pipeline-runs.ts';
import { now } from '../server/util.ts';
import { insert } from '../server/db.ts';

const RUN_TAG = Date.now().toString(36).slice(-5);

function insertProject(projectId: string): void {
  insert('projects', {
    id: projectId, slug: projectId, name: `test-${projectId}`, description: '', notes: '', created_by: null,
    created_at: now(), archived: 0, default_lead_agent: '', default_model: '', monthly_budget_usd: null,
    team_id: null, vault_generated: 0,
  });
}

type RunInput = Parameters<PipelineRunsRepository['upsertRun']>[0];

function runContract(label: string, makeRepo: () => Promise<PipelineRunsRepository>): void {
  describe(`${label} -- PipelineRunsRepository contract`, () => {
    let repo: PipelineRunsRepository;
    const isSqlite = label === 'SQLite';
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    let seq = 0;
    const pid = (n: string) => `plp-${n}-${sfx}`;
    const maybeProject = (id: string) => { if (isSqlite) insertProject(id); return id; };
    // Run ids are unique per test (GitHub run ids are global), so tests never meet each other's rows.
    const nextId = () => 1_000_000 + (++seq);
    const input = (projectId: string, over: Partial<RunInput> = {}): RunInput => ({
      project_id: projectId, repo_id: 'repo1', repo_full_name: 'acme/app', run_id: nextId(), run_attempt: 1, run_number: 1,
      workflow_id: 7, workflow_name: 'Deploy portal', branch: 'main', head_sha: 'abcdef1234567', actor: 'octo', event: 'push',
      status: 'in_progress' as PipelineStatus, html_url: 'https://github.com/acme/app/actions/runs/1', started_at: '2026-11-20T10:00:00Z', completed_at: null, ...over,
    });
    const alert = (projectId: string, over: Partial<PipelineAlert> = {}): PipelineAlert => ({
      project_id: projectId, repo_id: 'repo1', workflow_id: 7, branch: 'main', open: true, inbox_id: 'inbox1', last_run_id: 5,
      last_run_number: 5, failures: 1, updated_at: '2026-11-20T10:00:00.000Z', ...over,
    });

    before(async () => { repo = await makeRepo(); });
    after(() => { clearPipelineRunsRepository(); });

    test('upsert creates and a second upsert of the same run updates it', async () => {
      const p = maybeProject(pid('a'));
      const i = input(p);
      const first = await repo.upsertRun(i);
      assert.equal(first.created, true);
      assert.equal(first.run.status, 'in_progress');
      assert.equal(first.run.inbox_alerted_attempt, 0);
      assert.equal(first.run.chat_alerted_attempt, 0);
      assert.equal(first.run.run_id, i.run_id);
      assert.equal(first.run.completed_at, null);
      assert.ok(first.run.updated_at);
      const second = await repo.upsertRun({ ...i, status: 'failure', completed_at: '2026-11-20T10:05:00Z' });
      assert.equal(second.created, false);
      assert.equal(second.run.status, 'failure');
      assert.equal(second.run.completed_at, '2026-11-20T10:05:00Z');
      assert.equal((await repo.history(p, 'repo1', 7, 'main', 10)).length, 1);
    });

    test('a late in_progress does not overwrite a completed status of the same attempt', async () => {
      const p = maybeProject(pid('b'));
      const i = input(p, { status: 'failure', completed_at: '2026-11-20T10:05:00Z' });
      await repo.upsertRun(i);
      const late = await repo.upsertRun({ ...i, status: 'in_progress', completed_at: null });
      assert.equal(late.created, false);
      assert.equal(late.run.status, 'failure');
      assert.equal(late.run.completed_at, '2026-11-20T10:05:00Z');
      assert.equal((await repo.history(p, 'repo1', 7, 'main', 10))[0].status, 'failure');
    });

    test('a higher run_attempt replaces the row', async () => {
      const p = maybeProject(pid('c'));
      const i = input(p, { status: 'failure', completed_at: '2026-11-20T10:05:00Z' });
      await repo.upsertRun(i);
      const re = await repo.upsertRun({ ...i, run_attempt: 2, status: 'in_progress', completed_at: null });
      assert.equal(re.run.run_attempt, 2);
      assert.equal(re.run.status, 'in_progress');
      // A late delivery of the older attempt does not bring it back.
      const old = await repo.upsertRun({ ...i, run_attempt: 1, status: 'failure' });
      assert.equal(old.run.run_attempt, 2);
      assert.equal(old.run.status, 'in_progress');
    });

    test('latestPerBranch returns one row per repo+workflow+branch, the highest run_number', async () => {
      const p = maybeProject(pid('d'));
      await repo.upsertRun(input(p, { run_number: 1, status: 'success' }));
      await repo.upsertRun(input(p, { run_number: 3, status: 'failure' }));
      await repo.upsertRun(input(p, { run_number: 2, status: 'success' }));
      await repo.upsertRun(input(p, { run_number: 1, branch: 'feature/x', status: 'success' }));
      await repo.upsertRun(input(p, { run_number: 4, workflow_id: 8, workflow_name: 'CI', status: 'success' }));
      await repo.upsertRun(input(p, { run_number: 9, repo_id: 'repo2', repo_full_name: 'acme/other', status: 'success' }));
      const rows = await repo.latestPerBranch(p);
      assert.equal(rows.length, 4);
      const key = (r: PipelineRun) => `${r.repo_id}/${r.workflow_id}/${r.branch}`;
      assert.equal(new Set(rows.map(key)).size, 4);
      assert.equal(rows.find((r) => key(r) === 'repo1/7/main')?.run_number, 3);
      assert.equal(rows.find((r) => key(r) === 'repo1/7/feature/x')?.run_number, 1);
      assert.equal(rows.find((r) => key(r) === 'repo1/8/main')?.run_number, 4);
      assert.equal(rows.find((r) => key(r) === 'repo2/7/main')?.run_number, 9);
      assert.deepEqual(await repo.latestPerBranch(maybeProject(pid('d-empty'))), []);
    });

    test('history is newest first and limited', async () => {
      const p = maybeProject(pid('e'));
      for (const n of [2, 5, 1, 4, 3]) await repo.upsertRun(input(p, { run_number: n, status: 'success' }));
      await repo.upsertRun(input(p, { run_number: 9, branch: 'other', status: 'success' }));
      const h = await repo.history(p, 'repo1', 7, 'main', 3);
      assert.deepEqual(h.map((r) => r.run_number), [5, 4, 3]);
      assert.equal((await repo.history(p, 'repo1', 7, 'main', 50)).length, 5);
    });

    test('prune keeps 50 per repo+workflow but never the latest run of a branch', async () => {
      const p = maybeProject(pid('f'));
      // The feature branch run is older than every main run, so only the latest-of-branch rule keeps it.
      await repo.upsertRun(input(p, { run_number: 1, branch: 'feature/x', status: 'success' }));
      for (let n = 2; n <= 61; n++) await repo.upsertRun(input(p, { run_number: n, status: 'success' }));
      // Another workflow is not touched by pruning workflow 7.
      await repo.upsertRun(input(p, { run_number: 1, workflow_id: 8, workflow_name: 'CI', status: 'success' }));
      const deleted = await repo.prune(p, 'repo1', 7, 50);
      assert.equal(deleted, 10);
      const main = await repo.history(p, 'repo1', 7, 'main', 100);
      assert.equal(main.length, 50);
      assert.equal(main[0].run_number, 61);
      assert.equal(main[49].run_number, 12);
      assert.equal((await repo.history(p, 'repo1', 7, 'feature/x', 100)).length, 1);
      assert.equal((await repo.history(p, 'repo1', 8, 'main', 100)).length, 1);
      assert.equal(await repo.prune(p, 'repo1', 7, 50), 0);
    });

    test('markAlerted returns true once per run+attempt+channel, false on repeat, and true again for a higher attempt', async () => {
      const p = maybeProject(pid('g'));
      const i = input(p, { status: 'failure' });
      await repo.upsertRun(i);
      assert.equal(await repo.markAlerted(p, i.run_id, 1, 'inbox'), true);
      assert.equal(await repo.markAlerted(p, i.run_id, 1, 'inbox'), false);
      assert.equal(await repo.markAlerted(p, i.run_id, 1, 'chat'), true, 'channels are independent');
      assert.equal(await repo.markAlerted(p, i.run_id, 1, 'chat'), false);
      assert.equal(await repo.markAlerted(p, i.run_id, 2, 'inbox'), true);
      assert.equal(await repo.markAlerted(p, i.run_id, 1, 'inbox'), false, 'a lower attempt never lowers it');
      const run = (await repo.history(p, 'repo1', 7, 'main', 5))[0];
      assert.equal(run.inbox_alerted_attempt, 2);
      assert.equal(run.chat_alerted_attempt, 1);
      assert.equal(await repo.markAlerted(p, 999_999_999, 1, 'inbox'), false, 'an unknown run is not alerted');
      // A re-delivery of the run keeps the alerted marks.
      const again = await repo.upsertRun({ ...i, run_attempt: 3 });
      assert.equal(again.run.inbox_alerted_attempt, 2);
    });

    test('two concurrent markAlerted calls: exactly one true', async () => {
      const p = maybeProject(pid('h'));
      const i = input(p, { status: 'failure' });
      await repo.upsertRun(i);
      const results = await Promise.all([repo.markAlerted(p, i.run_id, 1, 'chat'), repo.markAlerted(p, i.run_id, 1, 'chat')]);
      assert.equal(results.filter(Boolean).length, 1);
    });

    test('putAlert creates only when absent, and with a stale updated_at returns false', async () => {
      const p = maybeProject(pid('i'));
      assert.equal(await repo.getAlert(p, 'repo1', 7, 'main'), null);
      const a1 = alert(p);
      assert.equal(await repo.putAlert(a1, null), true);
      assert.equal(await repo.putAlert(a1, null), false, 'must not exist');
      const got = await repo.getAlert(p, 'repo1', 7, 'main');
      assert.deepEqual(got, a1);
      const a2 = alert(p, { failures: 2, last_run_id: 6, last_run_number: 6, updated_at: '2026-11-20T10:01:00.000Z' });
      assert.equal(await repo.putAlert(a2, a1.updated_at), true);
      assert.deepEqual(await repo.getAlert(p, 'repo1', 7, 'main'), a2);
      const stale = alert(p, { open: false, updated_at: '2026-11-20T10:02:00.000Z' });
      assert.equal(await repo.putAlert(stale, a1.updated_at), false);
      assert.deepEqual(await repo.getAlert(p, 'repo1', 7, 'main'), a2);
      const closed = alert(p, { open: false, inbox_id: null, updated_at: '2026-11-20T10:03:00.000Z' });
      assert.equal(await repo.putAlert(closed, a2.updated_at), true);
      const back = await repo.getAlert(p, 'repo1', 7, 'main');
      assert.equal(back?.open, false);
      assert.equal(back?.inbox_id, null);
      // Another branch and another project have their own alert.
      assert.equal(await repo.getAlert(p, 'repo1', 7, 'dev'), null);
      assert.equal(await repo.getAlert(maybeProject(pid('i2')), 'repo1', 7, 'main'), null);
    });

    test('two concurrent putAlert calls with the same expected updated_at: exactly one true', async () => {
      const p = maybeProject(pid('j'));
      const base = alert(p);
      await repo.putAlert(base, null);
      const results = await Promise.all([
        repo.putAlert(alert(p, { failures: 2, updated_at: '2026-11-20T11:00:00.000Z' }), base.updated_at),
        repo.putAlert(alert(p, { failures: 3, updated_at: '2026-11-20T11:00:01.000Z' }), base.updated_at),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
    });
  });
}

describe('SQLite suite', () => {
  before(async () => { await createTestDb(); });
  after(cleanup);
  runContract('SQLite', async () => new SqlitePipelineRunsRepository());
});

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB === '1') throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    test.skip('DynamoDB Local not available — set DYNAMODB_ENDPOINT to run');
    return;
  }

  let repo: import('../server/repositories/pipeline-runs-dynamodb.ts').DynamoDbPipelineRunsRepository;

  before(async () => {
    const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
    clearDynamoDbClient();
    process.env.DYNAMODB_TABLE_PORTAL_PROJECTS = `portal-projects-pipelines-test-${RUN_TAG}`;
    const { DynamoDbPipelineRunsRepository } = await import('../server/repositories/pipeline-runs-dynamodb.ts');
    repo = new DynamoDbPipelineRunsRepository();
    await repo.ensureTables();
  });

  after(async () => {
    delete process.env.DYNAMODB_TABLE_PORTAL_PROJECTS;
    const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
    clearDynamoDbClient();
    clearPipelineRunsRepository();
  });

  runContract('DynamoDB', async () => repo);
});

describe('DynamoDB conflicts (stubbed client; the DynamoDB Local suite above needs DYNAMODB_ENDPOINT)', () => {
  type Sent = { input: Record<string, unknown> };
  const conflictTx = () => Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] });
  const failedTx = () => Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
  const failedPlain = () => Object.assign(new Error('failed'), { name: 'ConditionalCheckFailedException' });
  const conflictPlain = () => Object.assign(new Error('c'), { name: 'TransactionConflictException' });

  async function repoWith(responses: Array<unknown>) {
    const { DynamoDbPipelineRunsRepository } = await import('../server/repositories/pipeline-runs-dynamodb.ts');
    const r = new DynamoDbPipelineRunsRepository();
    const sent: Sent[] = [];
    let n = 0;
    (r as unknown as { client: { send: (c: Sent) => Promise<unknown> } }).client = {
      send: async (c: Sent) => {
        sent.push(c);
        const next = responses[n++];
        if (next instanceof Error) throw next;
        return next ?? {};
      },
    };
    return { r, sent };
  }

  const a = alert();
  function alert(): PipelineAlert {
    return { project_id: 'p1', repo_id: 'r1', workflow_id: 7, branch: 'main', open: true, inbox_id: null, last_run_id: 1, last_run_number: 1, failures: 1, updated_at: 'u2' };
  }

  test('markAlerted is a conditional write; a failed condition (plain or in a transaction) is false with no retry', async () => {
    let t = await repoWith([failedPlain()]);
    assert.equal(await t.r.markAlerted('p1', 5, 1, 'inbox'), false);
    assert.equal(t.sent.length, 1);
    assert.match(String(t.sent[0].input.ConditionExpression), /<|attribute_exists/);
    t = await repoWith([failedTx()]);
    assert.equal(await t.r.markAlerted('p1', 5, 1, 'chat'), false);
    assert.equal(t.sent.length, 1);
  });

  test('markAlerted retries a conflict up to 3 tries, then applies or reports an error', async () => {
    let t = await repoWith([conflictTx(), conflictPlain(), {}]);
    assert.equal(await t.r.markAlerted('p1', 5, 1, 'inbox'), true);
    assert.equal(t.sent.length, 3);
    t = await repoWith([conflictTx(), conflictTx(), conflictTx(), {}]);
    await assert.rejects(() => t.r.markAlerted('p1', 5, 1, 'inbox'), /cancelled/);
    assert.equal(t.sent.length, 3);
  });

  test('putAlert is conditional: failed condition is false, a conflict is retried', async () => {
    let t = await repoWith([failedPlain()]);
    assert.equal(await t.r.putAlert(a, null), false);
    assert.match(String(t.sent[0].input.ConditionExpression), /attribute_not_exists/);
    t = await repoWith([failedTx()]);
    assert.equal(await t.r.putAlert(a, 'u1'), false);
    assert.match(JSON.stringify(t.sent[0].input), /:expected/);
    t = await repoWith([conflictTx(), conflictTx(), {}]);
    assert.equal(await t.r.putAlert(a, 'u1'), true);
    assert.equal(t.sent.length, 3);
  });
});
