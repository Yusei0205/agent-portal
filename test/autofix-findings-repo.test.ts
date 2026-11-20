/**
 * Contract tests for AutofixFindingsRepository.
 *
 * The same assertions run against SQLite and DynamoDB. The DynamoDB suite runs only when DYNAMODB_ENDPOINT is set
 * (REQUIRE_DYNAMODB=1 turns the skip into a failure).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup } from './fixtures.ts';
import { SqliteAutofixFindingsRepository } from '../server/repositories/autofix-findings-sqlite.ts';
import type { AutofixFindingsRepository, FindingStatus, UpsertFindingInput } from '../server/repositories/autofix-findings.ts';
import { clearAutofixFindingsRepository } from '../server/repositories/autofix-findings.ts';
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

const ALL_STATUSES: FindingStatus[] = ['new', 'triaged', 'fixing', 'pr_open', 'resolved', 'dismissed', 'suppressed', 'needs_human'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runContract(label: string, makeRepo: () => Promise<AutofixFindingsRepository>): void {
  describe(`${label} -- AutofixFindingsRepository contract`, () => {
    let repo: AutofixFindingsRepository;
    const isSqlite = label === 'SQLite';
    const sfx = label.replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() + RUN_TAG;
    let seq = 0;
    const pid = (n: string) => `afp-${n}-${sfx}`;
    const maybeProject = (id: string) => { if (isSqlite) insertProject(id); return id; };
    const input = (projectId: string, fp: string, over: Partial<UpsertFindingInput> = {}): UpsertFindingInput => ({
      project_id: projectId, source: 'ci_failed', kind: 'test', fingerprint: fp, severity: 'medium', evidence: 'boom',
      repo_id: null, branch: 'main', commit_sha: 'abc123', ...over,
    });
    const fp = () => `fp-${++seq}-${sfx}`;

    before(async () => { repo = await makeRepo(); });
    after(() => { clearAutofixFindingsRepository(); });

    test('upsert creates, second upsert with same fingerprint returns created=false and occurrences=2', async () => {
      const p = maybeProject(pid('a'));
      const f = fp();
      const first = await repo.upsertByFingerprint(input(p, f));
      assert.equal(first.created, true);
      assert.equal(first.finding.status, 'new');
      assert.equal(first.finding.occurrences, 1);
      assert.equal(first.finding.attempts, 0);
      assert.equal(first.finding.cost_usd, 0);
      assert.equal(first.finding.pr_number, null);
      const second = await repo.upsertByFingerprint(input(p, f, { evidence: 'again' }));
      assert.equal(second.created, false);
      assert.equal(second.finding.id, first.finding.id);
      assert.equal(second.finding.occurrences, 2);
      assert.equal((await repo.getById(first.finding.id))?.occurrences, 2);
      assert.equal((await repo.getByFingerprint(p, f))?.id, first.finding.id);
    });

    test('upsert on the same fingerprint in another project creates a separate finding', async () => {
      const p1 = maybeProject(pid('b1'));
      const p2 = maybeProject(pid('b2'));
      const f = fp();
      const a = await repo.upsertByFingerprint(input(p1, f));
      const b = await repo.upsertByFingerprint(input(p2, f));
      assert.equal(a.created, true);
      assert.equal(b.created, true);
      assert.notEqual(a.finding.id, b.finding.id);
    });

    test('transition applies only when current status is in from; returns false otherwise', async () => {
      const p = maybeProject(pid('c'));
      const { finding } = await repo.upsertByFingerprint(input(p, fp()));
      assert.equal(await repo.transition(finding.id, ['triaged'], { status: 'fixing' }), false);
      assert.equal((await repo.getById(finding.id))?.status, 'new');
      assert.equal(await repo.transition(finding.id, ['new', 'triaged'], { status: 'triaged', attempts: 1 }), true);
      const got = await repo.getById(finding.id);
      assert.equal(got?.status, 'triaged');
      assert.equal(got?.attempts, 1);
      assert.equal(await repo.transition('missing-id', ['new'], { status: 'triaged' }), false);
    });

    test("two concurrent transitions from 'new' to 'triaged': exactly one returns true", async () => {
      const p = maybeProject(pid('d'));
      const { finding } = await repo.upsertByFingerprint(input(p, fp()));
      const results = await Promise.all([
        repo.transition(finding.id, ['new'], { status: 'triaged' }),
        repo.transition(finding.id, ['new'], { status: 'triaged' }),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
    });

    test('getByFixBranch and getByWorkflowId find the finding after a transition sets them', async () => {
      const p = maybeProject(pid('e'));
      const { finding } = await repo.upsertByFingerprint(input(p, fp()));
      const wf = `wf-${sfx}-${++seq}`;
      const branch = `autofix/${sfx}-${seq}`;
      assert.equal(await repo.getByFixBranch(p, branch), null);
      assert.equal(await repo.getByWorkflowId(wf), null);
      assert.equal(await repo.transition(finding.id, ['new'], {
        status: 'pr_open', workflow_id: wf, fix_branch: branch, pr_number: 7, pr_url: 'https://example.test/pr/7',
      }), true);
      assert.equal((await repo.getByFixBranch(p, branch))?.id, finding.id);
      assert.equal((await repo.getByWorkflowId(wf))?.id, finding.id);
      assert.equal((await repo.getByFixBranch(p, branch))?.pr_number, 7);
      assert.equal(await repo.getByFixBranch(maybeProject(pid('e2')), branch), null);
    });

    test('list filters by status and orders newest first', async () => {
      const p = maybeProject(pid('f'));
      const a = await repo.upsertByFingerprint(input(p, fp()));
      await sleep(5);
      const b = await repo.upsertByFingerprint(input(p, fp()));
      await sleep(5);
      const c = await repo.upsertByFingerprint(input(p, fp()));
      await repo.transition(b.finding.id, ['new'], { status: 'dismissed' });
      const everything = await repo.list(p, { limit: 10 });
      assert.deepEqual(everything.map((x) => x.id), [c.finding.id, b.finding.id, a.finding.id]);
      const onlyNew = await repo.list(p, { status: 'new', limit: 10 });
      assert.deepEqual(onlyNew.map((x) => x.id), [c.finding.id, a.finding.id]);
      assert.equal((await repo.list(p, { limit: 1 })).length, 1);
    });

    test('a patch never changes fingerprint or created_at; list orders by created_at then id, newest first', async () => {
      const p = maybeProject(pid('ord'));
      const a = await repo.upsertByFingerprint(input(p, fp()));
      const patch = { status: 'triaged', fingerprint: 'tampered', created_at: '2000-01-01T00:00:00.000Z' } as unknown as Parameters<AutofixFindingsRepository['transition']>[2];
      assert.equal(await repo.transition(a.finding.id, ['new'], patch), true);
      const got = (await repo.getById(a.finding.id))!;
      assert.equal(got.fingerprint, a.finding.fingerprint);
      assert.equal(got.created_at, a.finding.created_at);
      assert.equal((await repo.getByFingerprint(p, a.finding.fingerprint))!.id, a.finding.id);
      // Several findings, some created in the same millisecond: the order is exactly (created_at, id) descending.
      for (let n = 0; n < 6; n++) await repo.upsertByFingerprint(input(p, fp()));
      const rows = await repo.list(p, { limit: 50 });
      const expected = [...rows].sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id.localeCompare(x.id)).map((x) => x.id);
      assert.deepEqual(rows.map((x) => x.id), expected);
    });

    test('countByStatus returns a zero for every status', async () => {
      const p = maybeProject(pid('g'));
      const empty = await repo.countByStatus(p);
      assert.deepEqual(Object.keys(empty).sort(), [...ALL_STATUSES].sort());
      for (const s of ALL_STATUSES) assert.equal(empty[s], 0);
      const a = await repo.upsertByFingerprint(input(p, fp()));
      await repo.upsertByFingerprint(input(p, fp()));
      await repo.transition(a.finding.id, ['new'], { status: 'resolved' });
      const counts = await repo.countByStatus(p);
      assert.equal(counts.new, 1);
      assert.equal(counts.resolved, 1);
      assert.equal(counts.fixing, 0);
    });

    test('sumCostSince sums cost_usd of findings updated since the timestamp', async () => {
      const p = maybeProject(pid('h'));
      assert.equal(await repo.sumCostSince(p, '1970-01-01T00:00:00.000Z'), 0);
      const a = await repo.upsertByFingerprint(input(p, fp()));
      await repo.transition(a.finding.id, ['new'], { status: 'triaged', cost_usd: 0.5 });
      await sleep(20);
      const since = now();
      await sleep(20);
      const b = await repo.upsertByFingerprint(input(p, fp()));
      await repo.transition(b.finding.id, ['new'], { status: 'triaged', cost_usd: 0.25 });
      const c = await repo.upsertByFingerprint(input(p, fp()));
      await repo.transition(c.finding.id, ['new'], { status: 'triaged', cost_usd: 1 });
      assert.equal(await repo.sumCostSince(p, since), 1.25);
      assert.equal(await repo.sumCostSince(p, '1970-01-01T00:00:00.000Z'), 1.75);
    });
  });
}

describe('SQLite suite', () => {
  before(async () => { await createTestDb(); });
  after(cleanup);
  runContract('SQLite', async () => new SqliteAutofixFindingsRepository());
});

describe('DynamoDB Local suite', async () => {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    if (process.env.REQUIRE_DYNAMODB === '1') throw new Error('REQUIRE_DYNAMODB=1 but DYNAMODB_ENDPOINT is not set');
    test.skip('DynamoDB Local not available — set DYNAMODB_ENDPOINT to run');
    return;
  }

  let repo: import('../server/repositories/autofix-findings-dynamodb.ts').DynamoDbAutofixFindingsRepository;

  before(async () => {
    const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
    clearDynamoDbClient();
    process.env.DYNAMODB_TABLE_PORTAL_PROJECTS = `portal-projects-autofix-test-${RUN_TAG}`;
    const { DynamoDbAutofixFindingsRepository } = await import('../server/repositories/autofix-findings-dynamodb.ts');
    repo = new DynamoDbAutofixFindingsRepository();
    await repo.ensureTables();
  });

  after(async () => {
    delete process.env.DYNAMODB_TABLE_PORTAL_PROJECTS;
    const { clearDynamoDbClient } = await import('../server/repositories/dynamo-client.ts');
    clearDynamoDbClient();
    clearAutofixFindingsRepository();
  });

  runContract('DynamoDB', async () => repo);
});

describe('DynamoDB transaction conflicts (stubbed client; the DynamoDB Local suite above needs DYNAMODB_ENDPOINT)', () => {
  type Sent = { input: unknown };
  const conflict = () => Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }] });
  const failedCondition = () => Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] });

  async function repoWith(responses: Array<unknown | Error>) {
    const { DynamoDbAutofixFindingsRepository } = await import('../server/repositories/autofix-findings-dynamodb.ts');
    const r = new DynamoDbAutofixFindingsRepository();
    const sent: Sent[] = [];
    let n = 0;
    (r as unknown as { client: { send: (c: Sent) => Promise<unknown> } }).client = {
      send: async (c: Sent) => {
        sent.push(c);
        // The first send is the id lookup (getItem).
        if (sent.length === 1) return { Item: { PK: { S: 'AFID#f1' }, SK: { S: '#META' }, project_id: { S: 'p1' } } };
        const next = responses[n++];
        if (next instanceof Error) throw next;
        return next ?? {};
      },
    };
    return { r, sent };
  }

  test('a conflict is retried (up to 3 tries) and then applies', async () => {
    const { r, sent } = await repoWith([conflict(), conflict(), {}]);
    assert.equal(await r.transition('f1', ['new'], { status: 'triaged', workflow_id: 'wf1' }), true);
    assert.equal(sent.length, 4);
  });

  test('a transaction that keeps conflicting reports an error after 3 tries; it is not reported as a failed condition', async () => {
    const { r, sent } = await repoWith([conflict(), conflict(), conflict()]);
    await assert.rejects(() => r.transition('f1', ['new'], { status: 'triaged', workflow_id: 'wf1' }), /cancelled/);
    assert.equal(sent.length, 4);
  });

  test('a failed condition returns false at once (no retry)', async () => {
    const { r, sent } = await repoWith([failedCondition()]);
    assert.equal(await r.transition('f1', ['new'], { status: 'triaged', workflow_id: 'wf1' }), false);
    assert.equal(sent.length, 2);
  });

  test('a plain update that collides with a transaction is retried too', async () => {
    const { r } = await repoWith([Object.assign(new Error('c'), { name: 'TransactionConflictException' }), {}]);
    assert.equal(await r.transition('f1', ['new'], { status: 'triaged' }), true);
  });
});
