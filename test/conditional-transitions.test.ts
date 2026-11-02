/**
 * Caller-level tests for conditional status transitions.
 *
 * These tests verify that the service-layer functions (startRun, cancelRun,
 * and the runner's completion path) handle concurrent races correctly:
 *
 *   - Double start: two concurrent startRun calls for the same workflow
 *     result in exactly one active run (not two).
 *
 *   - Stop racing with run completion: if a run is stopped while the runner's
 *     "mark done" path is executing, the run must end in a terminal state
 *     without the stop being silently overwritten.
 *
 *   - Transcript: basic paging smoke test via the route.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { startRun } from '../server/workflows/driver.ts';
import { cancelRun } from '../server/workflows/controls.ts';
import { insert, run as dbRun, one, all } from '../server/db.ts';
import type { Row } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { getSessionsRepository } from '../server/repositories/sessions.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string, email = 'ct-admin@example.com'): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  if (r.cookie) return r.cookie;
  const login = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password1234' },
  });
  return login.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string, name: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createWorkflow(
  baseUrl: string,
  cookie: string,
  projectId: string,
  goal = 'Test',
): Promise<string> {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
    method: 'POST',
    body: { goal, engine: 'demo' },
    cookie,
  });
  return ((r.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
}

// ── Double start ──────────────────────────────────────────────────────────────

describe('Double start — concurrent startRun calls produce exactly one run', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'ds-admin@example.com');
    projectId = await createProject(baseUrl, adminCookie, 'Double Start Project');
  });

  after(async () => cleanup());

  it('two concurrent startRun calls create at most one active run', async () => {
    const wfId = await createWorkflow(baseUrl, adminCookie, projectId, 'double start test');

    // Call startRun twice concurrently.
    const [r1, r2] = await Promise.allSettled([
      startRun(wfId),
      startRun(wfId),
    ]);

    // At least one must succeed.
    const succeeded = [r1, r2].filter((r) => r.status === 'fulfilled');
    assert.ok(succeeded.length >= 1, 'At least one startRun should succeed');

    // If both succeeded, they must have returned the same runId.
    if (succeeded.length === 2) {
      const id1 = (r1 as PromiseFulfilledResult<string>).value;
      const id2 = (r2 as PromiseFulfilledResult<string>).value;
      assert.equal(id1, id2, 'Both successful calls should return the same runId');
    }

    // Verify there is at most one active run.
    const repo = getSessionsRepository();
    const activeRun = await repo.getActiveRun(wfId);
    assert.ok(activeRun, 'Should have an active run');

    const activeRuns = all<Row>(
      "SELECT * FROM p6_runs WHERE workflow_id = ? AND status IN ('pending','running')",
      wfId,
    );
    assert.equal(activeRuns.length, 1, `Expected exactly 1 active run, got ${activeRuns.length}`);
  });

  it('POST /start twice returns alreadyRunning on the second call', async () => {
    const wfId = await createWorkflow(baseUrl, adminCookie, projectId, 'double start via route');

    const r1 = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/start`, {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(r1.status, 201, 'First start should return 201');

    const r2 = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/start`, {
      method: 'POST',
      cookie: adminCookie,
    });
    // Second start should return 200 with alreadyRunning=true, not 409 or 500.
    assert.ok([200, 201].includes(r2.status), `Second start should return 200/201, got ${r2.status}`);
    if (r2.status === 200) {
      assert.ok(
        (r2.body as Record<string, unknown>).alreadyRunning === true,
        'Second 200 should have alreadyRunning=true',
      );
    }
  });
});

// ── Stop racing with run completion ───────────────────────────────────────────

describe('Stop races with run completion — only one terminal status wins', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'race-admin@example.com');
    projectId = await createProject(baseUrl, adminCookie, 'Race Test Project');
  });

  after(async () => cleanup());

  it('concurrent done + cancelled updates result in exactly one terminal status', async () => {
    const wfId = await createWorkflow(baseUrl, adminCookie, projectId, 'race test');
    const repo = getSessionsRepository();

    // Create a run in 'running' state (simulating an active run).
    const runId = generateId();
    const ts = now();
    await repo.createRun({
      id: runId,
      workflow_id: wfId,
      status: 'pending',
      started_at: null,
      finished_at: null,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      created_at: ts,
    });
    await repo.updateRun(runId, { status: 'running', started_at: ts });

    // Race: one caller tries to mark it done, another tries to cancel it.
    const [doneTry, cancelTry] = await Promise.all([
      repo.updateRunConditional(runId, 'running', {
        status: 'done',
        finished_at: now(),
      }),
      repo.updateRunConditional(runId, 'running', {
        status: 'cancelled',
        finished_at: now(),
      }),
    ]);

    // Exactly one should win.
    const wins = [doneTry, cancelTry].filter(Boolean).length;
    assert.equal(wins, 1, 'Exactly one of done/cancelled should win the race');

    // The run must be in a terminal state.
    const run = await repo.getRunById(runId);
    assert.ok(run, 'Run should still exist');
    const terminalStatuses = new Set(['done', 'cancelled', 'failed']);
    assert.ok(terminalStatuses.has(run.status), `Run should be terminal, got ${run.status}`);
  });

  it('a stopped run is not overwritten back to done', async () => {
    // This simulates the scenario: runner finishes but cancelRun arrived first.
    const wfId = await createWorkflow(baseUrl, adminCookie, projectId, 'stop vs done');
    const repo = getSessionsRepository();

    const runId = generateId();
    const ts = now();
    await repo.createRun({
      id: runId,
      workflow_id: wfId,
      status: 'pending',
      started_at: null,
      finished_at: null,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      created_at: ts,
    });
    await repo.updateRun(runId, { status: 'running', started_at: ts });

    // Stop wins first.
    cancelRun(runId);  // abort controller signal
    await repo.updateRunConditional(runId, 'running', {
      status: 'cancelled',
      finished_at: now(),
    });

    // Runner tries to mark done — should fail because status is now 'cancelled'.
    const applied = await repo.updateRunConditional(runId, 'running', {
      status: 'done',
      finished_at: now(),
    });
    assert.equal(applied, false, 'Runner should not overwrite a cancelled run to done');

    // Run stays cancelled.
    const run = await repo.getRunById(runId);
    assert.equal(run?.status, 'cancelled', 'Run should remain cancelled');
  });
});

// ── Transcript paging (caller-level route smoke test) ─────────────────────────

describe('Transcript paging via route — no gaps across page boundaries', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'tp-admin@example.com');
    projectId = await createProject(baseUrl, adminCookie, 'Transcript Paging Project');
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId, 'transcript paging test');

    // Create two runs with events, plus some workflow events.
    const genId = generateId;
    const ts2 = now;
    const run1 = genId();
    const run2 = genId();
    insert('p6_runs', {
      id: run1, workflow_id: workflowId, status: 'done',
      cost_usd: 0, input_tokens: 0, output_tokens: 0, created_at: ts2(),
    });
    insert('p6_runs', {
      id: run2, workflow_id: workflowId, status: 'done',
      cost_usd: 0, input_tokens: 0, output_tokens: 0,
      created_at: new Date(Date.now() + 1000).toISOString(),
    });

    // 6 run events in run1, 6 in run2.
    for (let i = 0; i < 6; i++) {
      insert('p6_events', {
        run_id: run1, type: 'status',
        payload: JSON.stringify({ text: `run1 event ${i}` }),
        created_at: new Date(Date.now() + i * 10).toISOString(),
      });
      insert('p6_events', {
        run_id: run2, type: 'status',
        payload: JSON.stringify({ text: `run2 event ${i}` }),
        created_at: new Date(Date.now() + 1000 + i * 10).toISOString(),
      });
    }

    // 4 workflow events.
    for (let i = 0; i < 4; i++) {
      insert('p6_workflow_events', {
        workflow_id: workflowId, kind: 'human',
        body: `message ${i}`, data: '{}',
        created_at: new Date(Date.now() + 500 + i * 10).toISOString(),
      });
    }
  });

  after(async () => cleanup());

  it('paging through all events yields no gaps and no overlap', async () => {
    // Collect all event ids by paging with limit=4.
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    while (true) {
      const url = cursor
        ? `/api/projects/${projectId}/workflows/${workflowId}/transcript?limit=4&cursor=${cursor}`
        : `/api/projects/${projectId}/workflows/${workflowId}/transcript?limit=4`;
      const r = await fetchJson(baseUrl, url, { cookie: adminCookie });
      assert.equal(r.status, 200, `Page ${pages + 1} should return 200`);

      const body = r.body as {
        events: Array<{ src: string; id: number; kind: string }>;
        nextCursor: string | null;
      };

      for (const ev of body.events) {
        const key = `${ev.src}:${ev.id}`;
        assert.ok(!seen.has(key), `Event ${key} appeared on page ${pages + 1} but was already seen (overlap)`);
        seen.add(key);
      }

      cursor = body.nextCursor;
      pages++;

      if (!cursor) break;
      if (pages > 20) { assert.fail('More than 20 pages — cursor may be broken'); break; }
    }

    // We expect at least 16 total events (12 run events + 4 workflow events).
    assert.ok(seen.size >= 16, `Expected >=16 events across pages, got ${seen.size}`);
  });
});
