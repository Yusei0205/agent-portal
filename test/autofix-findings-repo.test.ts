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
