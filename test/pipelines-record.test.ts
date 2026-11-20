import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup } from './fixtures.ts';
import { insert, getDb } from '../server/db.ts';
import { now } from '../server/util.ts';
import { getInboxRepository, setInboxRepository, clearInboxRepository } from '../server/repositories/inbox.ts';
import { getPipelineRunsRepository } from '../server/repositories/pipeline-runs.ts';
import { setChatUrl, _setChatFetch, _setChatBackoff } from '../server/pipelines/chat.ts';
import { recordPipelineRun } from '../server/pipelines/record.ts';
import type { WorkflowRunEvent } from '../server/pipelines/events.ts';

const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdWXYZ';
const actor = { actorId: 'u1', ip: null };
const repo = { id: 'repo1', default_branch: 'main' };
let seq = 0;
let sent: string[] = [];
let chatStatus = 200;

function mkProject(): string {
  const id = `rec-${++seq}-${Date.now().toString(36)}`;
  const uid = `u-${id}`;
  getDb().prepare('INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
    .run(uid, `${uid}@rec.test`, uid, 'x', now());
  insert('projects', {
    id, slug: id, name: id, description: '', notes: '', created_by: uid, created_at: now(), archived: 0,
    default_lead_agent: '', default_model: '', monthly_budget_usd: null, team_id: null, vault_generated: 0,
  });
  return id;
}
function ev(over: Partial<WorkflowRunEvent> = {}): WorkflowRunEvent {
  return {
    repoFullName: 'acme/app', runId: 100, runAttempt: 1, runNumber: 10, workflowId: 7, workflowName: 'Deploy portal', branch: 'main',
    headSha: 'abcdef1234567890', actor: 'dev', event: 'push', status: 'failure', htmlUrl: 'https://github.com/acme/app/actions/runs/100',
    startedAt: null, completedAt: null, ...over,
  };
}
async function items(pid: string) {
  return (await getInboxRepository().listUnresolvedByProjects([pid], { limit: 50 })).items;
}
before(async () => { await createTestServer(); });
after(() => { _setChatFetch(null); _setChatBackoff(null); return cleanup(); });
beforeEach(() => {
  sent = []; chatStatus = 200; _setChatBackoff([0, 0]);
  _setChatFetch((async (_u: string, init: RequestInit) => {
    sent.push(String(JSON.parse(String(init.body)).text));
    return { status: chatStatus, ok: chatStatus < 300 } as Response;
  }) as typeof fetch);
});

describe('recordPipelineRun', () => {
  it('failed deploy on main: one Inbox item (exact payload), one chat', async () => {
    const p = mkProject(); await setChatUrl(p, SLACK, actor);
    await recordPipelineRun(p, repo, ev());
    const it1 = await items(p);
    assert.equal(it1.length, 1);
    assert.equal(it1[0].type, 'blocked');
    assert.deepEqual(JSON.parse(it1[0].payload), {
      kind: 'pipeline', title: 'Deploy portal on acme/app@main', workflow: 'Deploy portal', repo: 'acme/app', branch: 'main', sha: 'abcdef1', actor: 'dev',
      url: 'https://github.com/acme/app/actions/runs/100', failures: 1,
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Deploy failed/);
  });

  it('the same delivery twice: still one each', async () => {
    const p = mkProject(); await setChatUrl(p, SLACK, actor);
    await recordPipelineRun(p, repo, ev());
    await recordPipelineRun(p, repo, ev());
    assert.equal((await items(p)).length, 1);
    assert.equal(sent.length, 1);
  });

  it('two different failing runs: one open alert, failures 2, one item', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev());
    await recordPipelineRun(p, repo, ev({ runId: 101, runNumber: 11 }));
    assert.equal((await items(p)).length, 1);
    const a = await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main');
    assert.equal(a?.open, true);
    assert.equal(a?.failures, 2);
    assert.equal(a?.last_run_id, 101);
    assert.ok(a?.inbox_id);
  });

  it('racing deliveries of different runs create one Inbox item', async () => {
    const p = mkProject();
    await Promise.all([1, 2, 3].map((n) => recordPipelineRun(p, repo, ev({ runId: 200 + n, runNumber: 20 + n }))));
    assert.equal((await items(p)).length, 1);
    const a = await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main');
    assert.equal(a?.failures, 3);
    assert.ok(a?.inbox_id);
  });

  it('success with a higher run number closes the alert, resolves the item, sends recovered once', async () => {
    const p = mkProject(); await setChatUrl(p, SLACK, actor);
    await recordPipelineRun(p, repo, ev());
    const ok = ev({ runId: 101, runNumber: 11, status: 'success' });
    await recordPipelineRun(p, repo, ok);
    await recordPipelineRun(p, repo, ok);
    assert.equal((await items(p)).length, 0);
    assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.open, false);
    assert.equal(sent.filter((s) => /recovered/.test(s)).length, 1);
  });

  it('an older run succeeding after a newer failure resolves nothing', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev({ runId: 101, runNumber: 11 }));
    await recordPipelineRun(p, repo, ev({ runId: 100, runNumber: 10, status: 'success' }));
    assert.equal((await items(p)).length, 1);
    assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.open, true);
  });

  it('an older failure after a newer success does not reopen', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev({ runId: 101, runNumber: 11 }));
    await recordPipelineRun(p, repo, ev({ runId: 102, runNumber: 12, status: 'success' }));
    await recordPipelineRun(p, repo, ev({ runId: 103, runNumber: 9 }));
    assert.equal((await items(p)).length, 0);
    assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.open, false);
  });

  it('a successful re-run attempt of the failing run resolves', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev());
    await recordPipelineRun(p, repo, ev({ runAttempt: 2, status: 'success' }));
    assert.equal((await items(p)).length, 0);
    assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.open, false);
  });

  it('a failure after recovery opens a new alert and item', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev());
    await recordPipelineRun(p, repo, ev({ runId: 101, runNumber: 11, status: 'success' }));
    await recordPipelineRun(p, repo, ev({ runId: 102, runNumber: 12 }));
    assert.equal((await items(p)).length, 1);
    assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.failures, 1);
  });

  it('non-deploy workflow or feature branch: stored, not alerted', async () => {
    const p = mkProject(); await setChatUrl(p, SLACK, actor);
    await recordPipelineRun(p, repo, ev({ workflowName: 'CI' }));
    await recordPipelineRun(p, repo, ev({ runId: 101, branch: 'feature/x' }));
    assert.equal((await items(p)).length, 0);
    assert.equal(sent.length, 0);
    assert.equal((await getPipelineRunsRepository().latestPerBranch(p)).length, 2);
  });

  it('no chat target: Inbox only', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev());
    assert.equal((await items(p)).length, 1);
    assert.equal(sent.length, 0);
  });

  it('a chat failure neither prevents nor duplicates the Inbox item', async () => {
    const p = mkProject(); await setChatUrl(p, SLACK, actor); chatStatus = 500;
    await recordPipelineRun(p, repo, ev());
    await recordPipelineRun(p, repo, ev());
    assert.equal((await items(p)).length, 1);
  });

  it('an item resolved by hand, then recovery: no error', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev());
    await getInboxRepository().resolveConditional((await items(p))[0].id, null, now());
    await assert.doesNotReject(recordPipelineRun(p, repo, ev({ runId: 101, runNumber: 11, status: 'success' })));
    assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.open, false);
  });

  it('run 11 succeeds, then a late run 10 timed_out: nothing opens', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev({ runId: 111, runNumber: 11, status: 'success' }));
    await recordPipelineRun(p, repo, ev({ runId: 110, runNumber: 10, status: 'timed_out' }));
    assert.equal((await items(p)).length, 0);
    assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.open, false);
  });

  it('attempt 2 succeeds, then a late attempt 1 failure: nothing opens', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev({ runAttempt: 2, status: 'success' }));
    await recordPipelineRun(p, repo, ev({ runAttempt: 1, status: 'failure' }));
    assert.equal((await items(p)).length, 0);
    assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.open ?? false, false);
  });

  it('a duplicate delivery of a successful re-run attempt sends recovered once', async () => {
    const p = mkProject(); await setChatUrl(p, SLACK, actor);
    await recordPipelineRun(p, repo, ev());
    const ok = ev({ runAttempt: 2, status: 'success' });
    await recordPipelineRun(p, repo, ok);
    await recordPipelineRun(p, repo, ok);
    assert.equal(sent.filter((s) => /recovered/.test(s)).length, 1);
    assert.equal((await items(p)).length, 0);
  });

  it('an item resolved by hand while the alert is open: the next failure raises a new one', async () => {
    const p = mkProject();
    await recordPipelineRun(p, repo, ev());
    await getInboxRepository().resolveConditional((await items(p))[0].id, null, now());
    await recordPipelineRun(p, repo, ev({ runId: 101, runNumber: 11 }));
    assert.equal((await items(p)).length, 1);
    const a = await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main');
    assert.equal(a?.open, true);
    assert.equal(a?.failures, 2);
  });

  it('createInboxItem failing releases the alert so the next failure raises the item', async () => {
    const p = mkProject();
    const real = getInboxRepository();
    let fail = true;
    setInboxRepository(new Proxy(real, {
      get(t, k, r) {
        if (k === 'create') return async (i: never) => { if (fail) throw new Error('boom'); return t.create(i); };
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }));
    try {
      await recordPipelineRun(p, repo, ev());
      assert.equal((await items(p)).length, 0);
      assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.open, false);
      fail = false;
      await recordPipelineRun(p, repo, ev({ runId: 101, runNumber: 11 }));
      assert.equal((await items(p)).length, 1);
      assert.equal((await getPipelineRunsRepository().getAlert(p, 'repo1', 7, 'main'))?.open, true);
    } finally { setInboxRepository(real); void clearInboxRepository; }
  });
});
