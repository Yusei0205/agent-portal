/**
 * A turn whose process was lost (the job container died without a word) must not leave its session "running" for ever:
 * it is told apart from a quiet one by its heartbeat, closed with a reason, and the next message goes on.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';
import type { RunRecord } from '../server/repositories/sessions.ts';
import { startRun, sweepLostRuns, queuedDeps } from '../server/workflows/driver.ts';
import { lostRunReason, closeLostRun, HEARTBEAT_MS, LOST_AFTER_MS, PENDING_LOST_AFTER_MS, PAST_LIMIT_GRACE_MS } from '../server/workflows/lost-runs.ts';
import { registerRun, deregisterRun } from '../server/workflows/controls.ts';
import { all, one } from '../server/db.ts';

const base = (over: Partial<RunRecord>): RunRecord => ({
  id: 'r1', workflow_id: 'w1', status: 'running', started_at: null, finished_at: null, cost_usd: 0, credits: 0, input_tokens: 0, output_tokens: 0,
  cache_write_tokens: 0, cache_read_tokens: 0, created_at: '2026-11-15T05:00:00.000Z', stop_reason: null, time_limit_at: null, heartbeat_at: null,
  model: null, error: null, ...over,
} as RunRecord);
const at = (iso: string, plusMs: number): number => Date.parse(iso) + plusMs;

describe('when a run counts as lost (the rules)', () => {
  const beat = '2026-11-15T05:40:00.000Z';

  it('a run that keeps saying it is alive is never lost, however long it runs', () => {
    assert.equal(lostRunReason(base({ heartbeat_at: beat }), at(beat, 10_000)), null);
    assert.equal(lostRunReason(base({ heartbeat_at: beat }), at(beat, LOST_AFTER_MS)), null, 'exactly at the limit is still fine');
    assert.equal(lostRunReason(base({ heartbeat_at: beat, created_at: '2026-11-14T00:00:00Z' }), at(beat, 20_000)), null, 'an old run with a fresh heartbeat');
  });

  it('a run that went quiet for more than five minutes is lost, and the reason says since when', () => {
    const why = lostRunReason(base({ heartbeat_at: beat }), at(beat, LOST_AFTER_MS + 1));
    assert.ok(why && /no sign of life since 05:40:00 UTC/.test(why) && /Send a message to carry on/.test(why), String(why));
    assert.ok(HEARTBEAT_MS * 5 < LOST_AFTER_MS, 'many beats may be missed before a run is called lost');
  });

  it('a run from before heartbeats is only judged by its own time limit', () => {
    const limit = '2026-11-15T06:41:42.000Z';
    assert.equal(lostRunReason(base({ time_limit_at: limit }), at(limit, -60 * 60_000)), null, 'still inside its limit');
    assert.equal(lostRunReason(base({ time_limit_at: limit }), at(limit, PAST_LIMIT_GRACE_MS)), null, 'just past it: the run may still be ending');
    assert.ok(lostRunReason(base({ time_limit_at: limit }), at(limit, PAST_LIMIT_GRACE_MS + 1)), 'well past it and silent');
    assert.equal(lostRunReason(base({}), Date.parse('2030-01-01')), null, 'no heartbeat and no limit: nothing to judge by, so left alone');
  });

  it('a run nobody picked up is lost after fifteen minutes, a finished run never is', () => {
    const created = '2026-11-15T05:00:00.000Z';
    assert.equal(lostRunReason(base({ status: 'pending', created_at: created }), at(created, PENDING_LOST_AFTER_MS)), null);
    assert.ok(lostRunReason(base({ status: 'pending', created_at: created }), at(created, PENDING_LOST_AFTER_MS + 1)));
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      assert.equal(lostRunReason(base({ status, heartbeat_at: beat }), at(beat, 99 * 60_000)), null, status);
    }
  });
});

describe('closing and recovering lost runs', () => {
  let baseUrl = '', cookie = '', projectId = '';
  const repo = () => getSessionsRepository();
  const realStart = queuedDeps.startRun;

  before(async () => {
    createTestDb();
    baseUrl = (await createTestServer()).baseUrl;
    cookie = (await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `lost-${Date.now()}@test.com`, name: 'Admin', password: 'password1234', provider: 'demo' } })).cookie ?? '';
    projectId = (((await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `Lost-${Date.now()}` }, cookie })).body as any).project as any).id;
  });
  after(async () => { queuedDeps.startRun = realStart; await cleanup(); });

  const session = async (): Promise<string> => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', cookie, body: { goal: 'Check the scan', engine: 'demo', start: false } });
    return String(((r.body as any).workflow ?? r.body).id);
  };
  /** A session whose turn is "running" with the given last sign of life (an ISO time, or null for none). */
  const runningTurn = async (wid: string, heartbeat: string | null, extra: Partial<RunRecord> = {}): Promise<string> => {
    const id = `run-${Math.random().toString(36).slice(2, 10)}`;
    const t = new Date(Date.now() - 3 * 3600_000).toISOString();
    await repo().createRun({ id, workflow_id: wid, status: 'running', started_at: t, finished_at: null, cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: t });
    await repo().updateRun(id, { heartbeat_at: heartbeat, ...extra });
    await repo().updateWorkflow(wid, { status: 'running', updated_at: t });
    return id;
  };
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const runOf = async (id: string) => (await repo().getRunById(id))!;

  it('closes a lost run as failed with the reason, leaves the session ready, and says so in the chat', async () => {
    const wid = await session();
    const rid = await runningTurn(wid, ago(40 * 60_000));
    const why = lostRunReason(await runOf(rid))!;
    assert.ok(why);
    assert.equal(await closeLostRun(rid, why), true);

    const run = await runOf(rid);
    assert.equal(run.status, 'failed');
    assert.ok(run.finished_at);
    assert.match(String(run.error), /stopped responding/);
    const wf = (await repo().getWorkflowById(wid))!;
    assert.equal(wf.status, 'paused', 'no longer "running"');
    assert.equal(wf.stop_reason, 'interrupted', 'the person can carry on with a message');
    const events = all<{ type: string; payload: string }>('SELECT type, payload FROM p6_events WHERE run_id = ?', rid);
    assert.ok(events.some((e) => e.type === 'run-failed' && /stopped responding/.test(e.payload)), 'the chat shows why the turn ended');
    assert.equal(await repo().getActiveRun(wid), null, 'nothing is active any more');
  });

  it('closing twice changes nothing, and a run that finished by itself first is left alone', async () => {
    const wid = await session();
    const rid = await runningTurn(wid, ago(30 * 60_000));
    assert.equal(await closeLostRun(rid, 'lost'), true);
    const finished = (await runOf(rid)).finished_at;
    assert.equal(await closeLostRun(rid, 'lost again'), false);
    assert.equal((await runOf(rid)).finished_at, finished);
    assert.equal((await runOf(rid)).error, 'lost');

    const slow = await session();
    const done = await runningTurn(slow, ago(30 * 60_000));
    await repo().updateRun(done, { status: 'done', finished_at: new Date().toISOString() });
    assert.equal(await closeLostRun(done, 'lost'), false, 'a finished run is not turned into a failure');
    assert.equal((await runOf(done)).status, 'done');
  });

  it('the next message is not left waiting behind a lost turn: the lost run is closed and a new turn starts', async () => {
    const wid = await session();
    const lost = await runningTurn(wid, ago(40 * 60_000));
    const started = await startRun(wid);
    assert.notEqual(started, lost, 'a new run, not the dead one');
    assert.equal((await runOf(lost)).status, 'failed');
    assert.ok(await runOf(started));
    for (let i = 0; i < 50 && ['pending', 'running'].includes((await runOf(started)).status); i++) await new Promise((r) => setTimeout(r, 100));
  });

  it('negation: a turn that is only quiet (recent heartbeat) is not touched, and a message still waits for it', async () => {
    const wid = await session();
    const alive = await runningTurn(wid, ago(60_000));
    assert.equal(await startRun(wid), alive, 'the live run is returned, nothing new starts');
    assert.equal((await runOf(alive)).status, 'running');
    assert.equal((await repo().getWorkflowById(wid))!.status, 'running');
    assert.equal(await sweepLostRuns() >= 0, true);
    assert.equal((await runOf(alive)).status, 'running', 'the sweep leaves it alone too');
  });

  it('a run from before heartbeats that is far past its time limit is closed the same way', async () => {
    const wid = await session();
    const rid = await runningTurn(wid, null, { time_limit_at: ago(20 * 60_000) });
    assert.equal(await sweepLostRuns() >= 1, true);
    const run = await runOf(rid);
    assert.equal(run.status, 'failed');
    assert.match(String(run.error), /time limit/);
  });

  it('the sweep closes lost runs and starts the turn for a message that was waiting behind them', async () => {
    const wid = await session();
    const lost = await runningTurn(wid, ago(45 * 60_000));
    await repo().appendWorkflowEvent({ workflow_id: wid, kind: 'human', body: 'any update?', data: '{}', created_at: new Date().toISOString() });
    const started: string[] = [];
    queuedDeps.startRun = (async (id: string) => { started.push(id); return 'next-run'; }) as typeof realStart;
    const closed = await sweepLostRuns();
    queuedDeps.startRun = realStart;
    assert.ok(closed >= 1);
    assert.equal((await runOf(lost)).status, 'failed');
    assert.deepEqual(started, [wid], 'the waiting message gets its turn');
  });

  it('Stop on a lost turn ends it at once, so the session is free to carry on', async () => {
    const wid = await session();
    const lost = await runningTurn(wid, ago(50 * 60_000));
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wid}/cancel`, { method: 'POST', cookie, body: { source: 'stop-button' } });
    assert.equal(r.status, 200);
    assert.equal((await runOf(lost)).status, 'failed');
    assert.equal(await repo().getActiveRun(wid), null);
    assert.equal((await repo().getWorkflowById(wid))!.status, 'paused');
  });

  it('a registered run keeps saying it is alive, and stops when it is done', async () => {
    const wid = await session();
    const rid = await runningTurn(wid, null);
    assert.equal((await runOf(rid)).heartbeat_at, null);
    registerRun(rid);
    await new Promise((r) => setTimeout(r, 150));
    const first = (await runOf(rid)).heartbeat_at;
    assert.ok(first && Date.now() - Date.parse(first) < 5_000, `a beat is written at once: ${first}`);
    deregisterRun(rid);
    await repo().updateRun(rid, { heartbeat_at: null });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await runOf(rid)).heartbeat_at, null, 'no more beats after the run ended');
    assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM p6_runs WHERE id = ? AND heartbeat_at IS NOT NULL", rid)!.n, 0);
  });
});
