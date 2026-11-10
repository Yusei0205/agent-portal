/**
 * Tests for the Agent Performance Dashboard API.
 *
 * Covers:
 *   - GET /api/dashboard              (shape, auth, period validation, access control)
 *   - GET /api/dashboard/agents/:agent/runs (drill-down)
 *   - Admin vs member vs stranger access
 *   - projectId scoping
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { now } from '../server/util.ts';
import { hashPassword } from '../server/auth.ts';

let baseUrl: string;
let adminCookie: string;

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  const srv = await createTestServer();
  baseUrl = srv.baseUrl;

  await fetchJson(baseUrl, '/api/auth/setup', {
    body: { email: 'admin@dash.test', password: 'adminpass1', name: 'Admin' },
  });
  const login = await fetchJson(baseUrl, '/api/auth/login', {
    body: { email: 'admin@dash.test', password: 'adminpass1' },
  });
  adminCookie = login.cookie ?? '';
});

after(cleanup);

// ── Helper ────────────────────────────────────────────────────────────────────

function seedWorkflowAndRun(
  projectId: string,
  leadAgent: string,
  runStatus: 'pending' | 'running' | 'done' | 'failed' | 'cancelled',
  opts: { parentId?: string } = {},
): { workflowId: string; runId: string } {
  const db = getDb();
  const wid = `wf-${Math.random().toString(36).slice(2)}`;
  const rid = `run-${Math.random().toString(36).slice(2)}`;
  const ts = now();
  const finishedAt = ['done', 'failed', 'cancelled'].includes(runStatus) ? ts : null;
  const startedAt = runStatus !== 'pending' ? ts : null;

  db.prepare(`
    INSERT INTO p6_workflows
      (id, project_id, goal, status, engine, trust_tools, lead_agent, parent_id, created_at, updated_at)
    VALUES (?, ?, 'test goal', 'done', 'demo', 0, ?, ?, ?, ?)
  `).run(wid, projectId, leadAgent, opts.parentId ?? null, ts, ts);

  db.prepare(`
    INSERT INTO p6_runs
      (id, workflow_id, status, started_at, finished_at, cost_usd, input_tokens, output_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, 0.01, 100, 50, ?)
  `).run(rid, wid, runStatus, startedAt, finishedAt, ts);

  return { workflowId: wid, runId: rid };
}

function seedProject(name: string): string {
  const db = getDb();
  const id = `proj-dash-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO projects (id, name, slug, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, name, `slug-${id}`, now());
  return id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/dashboard', () => {
  test('requires authentication', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard');
    assert.equal(r.status, 401);
  });

  test('rejects invalid period', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard?period=bad', { cookie: adminCookie });
    assert.equal(r.status, 400);
  });

  test('returns correct shape on empty DB', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;

    assert.ok('period' in body, 'period');
    assert.ok('generatedAt' in body, 'generatedAt');
    assert.ok('summary' in body, 'summary');
    assert.ok('network' in body, 'network');
    assert.ok('agents' in body, 'agents');
    assert.ok('recentSessions' in body, 'recentSessions');
    assert.ok('activeSession' in body, 'activeSession');

    const summary = body.summary as Record<string, unknown>;
    assert.equal(summary.totalAgents, 0);
    assert.equal(summary.activeAgents, 0);
    assert.equal(summary.runningSessions, 0);
    assert.equal(summary.queuedSessions, 0);
    assert.equal(summary.completedToday, 0);
    assert.equal(summary.completedYesterday, 0);
    assert.equal(summary.successRate, 0);
    assert.equal(summary.successRatePrev, null);

    const network = body.network as Record<string, unknown>;
    assert.ok(Array.isArray(network.nodes));
    assert.ok(Array.isArray(network.edges));

    assert.ok(Array.isArray(body.agents));
    assert.ok(Array.isArray(body.recentSessions));
    assert.equal(body.activeSession, null);
  });

  test('defaults to period=7d', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).period, '7d');
  });

  test('accepts period=today', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard?period=today', { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).period, 'today');
  });

  test('accepts period=30d', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard?period=30d', { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).period, '30d');
  });

  test('returns 404 for unknown projectId', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard?projectId=no-such-proj', { cookie: adminCookie });
    assert.equal(r.status, 404);
  });

  test('aggregates agents from p6_runs in period', async () => {
    const projId = seedProject('Dash Agg');
    seedWorkflowAndRun(projId, 'planner', 'done');
    seedWorkflowAndRun(projId, 'developer', 'failed');
    seedWorkflowAndRun(projId, 'planner', 'done'); // same agent, second run

    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const summary = body.summary as Record<string, unknown>;
    assert.ok(Number(summary.totalAgents) >= 2, 'at least 2 distinct agents');
  });

  test('per-agent stats include successRate and runs', async () => {
    const projId = seedProject('Dash Perf');
    seedWorkflowAndRun(projId, 'researcher', 'done');
    seedWorkflowAndRun(projId, 'researcher', 'done');
    seedWorkflowAndRun(projId, 'researcher', 'failed');

    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const researcher = agents.find((a) => a.agent === 'researcher');
    assert.ok(researcher, 'researcher agent should be present');
    assert.ok(Number(researcher.runs) >= 3, 'at least 3 runs');
    assert.ok(Number(researcher.completed) >= 2, 'at least 2 completed');
    assert.ok(Number(researcher.failed) >= 1, 'at least 1 failed');
    assert.ok(Number(researcher.successRate) > 0, 'successRate > 0');
  });

  test('empty lead_agent maps to "default" agent name', async () => {
    const projId = seedProject('Dash Default');
    seedWorkflowAndRun(projId, '', 'done');

    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const def = agents.find((a) => a.agent === 'default');
    assert.ok(def, '"default" agent should appear for empty lead_agent');
  });

  test('network edges are populated for child workflows', async () => {
    const projId = seedProject('Dash Edges');
    const { workflowId: parentWfId } = seedWorkflowAndRun(projId, 'orchestrator', 'done');
    // Seed a child workflow referencing the parent
    seedWorkflowAndRun(projId, 'worker', 'done', { parentId: parentWfId });

    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const edges = ((r.body as Record<string, unknown>).network as Record<string, unknown>).edges as Array<Record<string, unknown>>;
    const edge = edges.find((e) => e.source === 'orchestrator' && e.target === 'worker');
    assert.ok(edge, 'orchestrator→worker edge should be present');
    assert.ok(Number(edge.count) >= 1);
  });

  test('recentSessions has at most 10 entries', async () => {
    const projId = seedProject('Dash Recent');
    for (let i = 0; i < 12; i++) {
      seedWorkflowAndRun(projId, 'bot', 'done');
    }
    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const sessions = (r.body as Record<string, unknown>).recentSessions as unknown[];
    assert.ok(sessions.length <= 10, `recentSessions should be ≤10, got ${sessions.length}`);
  });

  test('projectId scoping: admin with projectId', async () => {
    const projId = seedProject('Dash Scoped');
    seedWorkflowAndRun(projId, 'scoped-agent', 'done');

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projId}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const hasScoped = agents.some((a) => a.agent === 'scoped-agent');
    assert.ok(hasScoped, 'scoped-agent should appear with projectId filter');
  });
});

describe('GET /api/dashboard access control', () => {
  test('non-admin user cannot see projects they are not a member of', async () => {
    // Create a non-admin user directly in the DB
    const db = getDb();
    const memberEmail = `member-${Date.now()}@dash.test`;
    const memberId = `user-member-${Date.now()}`;
    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at)
      VALUES (?, ?, 'Member User', ?, 0, 0, ?)
    `).run(memberId, memberEmail, hashPassword('memberpass123'), now());

    const login = await fetchJson(baseUrl, '/api/auth/login', {
      body: { email: memberEmail, password: 'memberpass123' },
    });
    assert.equal(login.status, 200, 'member login should succeed');
    const memberCookie = login.cookie ?? '';

    // Create a project without adding the member user
    const projId = seedProject('Private Proj');
    seedWorkflowAndRun(projId, 'hidden-agent', 'done');

    // Non-member sees their scope (no member projects → agents from those projects invisible)
    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie: memberCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const leaked = agents.some((a) => a.agent === 'hidden-agent');
    assert.ok(!leaked, 'hidden-agent must not leak to non-member');
  });

  test('non-admin gets 403 when specifying a project they cannot access', async () => {
    const db = getDb();
    const memberEmail = `member2-${Date.now()}@dash.test`;
    const memberId = `user-member2-${Date.now()}`;
    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at)
      VALUES (?, ?, 'Member2 User', ?, 0, 0, ?)
    `).run(memberId, memberEmail, hashPassword('memberpass456'), now());

    const login = await fetchJson(baseUrl, '/api/auth/login', {
      body: { email: memberEmail, password: 'memberpass456' },
    });
    assert.equal(login.status, 200, 'member2 login should succeed');
    const memberCookie = login.cookie ?? '';

    const projId = seedProject('Restricted Proj');
    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projId}`, { cookie: memberCookie });
    assert.equal(r.status, 403);
  });
});

describe('GET /api/dashboard/agents/:agent/runs', () => {
  test('requires authentication', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard/agents/planner/runs');
    assert.equal(r.status, 401);
  });

  test('rejects invalid period', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard/agents/planner/runs?period=xyz', { cookie: adminCookie });
    assert.equal(r.status, 400);
  });

  test('returns correct shape', async () => {
    const r = await fetchJson(baseUrl, '/api/dashboard/agents/planner/runs', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok('runs' in body, 'should have runs array');
    assert.ok(Array.isArray(body.runs));
  });

  test('drill-down returns runs for the correct agent', async () => {
    const projId = seedProject('Drill Proj');
    seedWorkflowAndRun(projId, 'drill-agent', 'done');
    seedWorkflowAndRun(projId, 'other-agent', 'done');

    const r = await fetchJson(baseUrl, '/api/dashboard/agents/drill-agent/runs', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const runs = (r.body as Record<string, unknown>).runs as Array<Record<string, unknown>>;
    assert.ok(runs.length >= 1, 'at least one run for drill-agent');
    for (const run of runs) {
      assert.ok('id' in run);
      assert.ok('workflowId' in run);
      assert.ok('projectId' in run);
      assert.ok('title' in run);
      assert.ok('status' in run);
      assert.ok('costUsd' in run);
      assert.ok('tokens' in run);
      assert.ok('toolCalls' in run);
      assert.ok('createdAt' in run);
    }
  });

  test('"default" agent maps to empty lead_agent', async () => {
    const projId = seedProject('Default Drill');
    seedWorkflowAndRun(projId, '', 'done');

    const r = await fetchJson(baseUrl, '/api/dashboard/agents/default/runs', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const runs = (r.body as Record<string, unknown>).runs as Array<Record<string, unknown>>;
    assert.ok(runs.length >= 1, 'default agent drill-down should return runs');
  });

  test('returns at most 50 runs', async () => {
    const projId = seedProject('Drill50 Proj');
    for (let i = 0; i < 55; i++) {
      seedWorkflowAndRun(projId, 'flood-agent', 'done');
    }
    const r = await fetchJson(baseUrl, '/api/dashboard/agents/flood-agent/runs', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const runs = (r.body as Record<string, unknown>).runs as unknown[];
    assert.ok(runs.length <= 50, `should be ≤50, got ${runs.length}`);
  });
});

// ── Additional imports (for new test groups) ─────────────────────────────────

import http from 'node:http';
import { notifyDashboard } from '../server/agent/runner.ts';

// ── Additional test helpers ───────────────────────────────────────────────────

/**
 * Open an SSE connection via the low-level http module.
 * Returns { ready, events, close } — ready resolves on the ": connected" frame.
 * Pattern copied from themes.test.ts.
 */
function openSseHttp(
  sseBaseUrl: string,
  path: string,
  cookie: string,
): { ready: Promise<void>; events: object[]; close: () => void } {
  const events: object[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let readyDone = false;

  const { hostname, port } = new URL(sseBaseUrl);
  const req = http.request(
    {
      hostname,
      port: port ? parseInt(port, 10) : 80,
      path,
      method: 'GET',
      headers: { Cookie: cookie },
    },
    (res) => {
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          if (part.trimStart().startsWith(':')) {
            if (!readyDone) { readyDone = true; resolveReady(); }
            continue;
          }
          for (const line of part.split('\n')) {
            if (line.startsWith('data: ')) {
              try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ }
            }
          }
        }
      });
    },
  );

  req.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'ECONNRESET' && !readyDone) rejectReady(err as Error);
  });
  req.setTimeout(6000, () => {
    if (!readyDone) rejectReady(new Error('SSE connection timed out'));
    req.destroy();
  });
  req.end();

  return { events, ready, close: () => req.destroy() };
}

/** ISO timestamp for N days ago. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/**
 * Seed a p6_workflow with an explicit status.
 * Returns the new workflow id.
 */
function seedWorkflowWithStatus(
  projectId: string,
  leadAgent: string,
  workflowStatus: string,
  opts: { parentId?: string; createdAt?: string; title?: string } = {},
): string {
  const db = getDb();
  const wid = `wf-${Math.random().toString(36).slice(2)}`;
  const ts = opts.createdAt ?? now();
  db.prepare(`
    INSERT INTO p6_workflows
      (id, project_id, goal, status, engine, trust_tools, lead_agent, parent_id, title, created_at, updated_at)
    VALUES (?, ?, 'test goal', ?, 'demo', 0, ?, ?, ?, ?, ?)
  `).run(wid, projectId, workflowStatus, leadAgent, opts.parentId ?? null, opts.title ?? '', ts, ts);
  return wid;
}

/**
 * Seed a p6_run for a workflow with full control over cost/token/timestamp fields.
 * Returns the new run id.
 */
function seedRunFor(
  workflowId: string,
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled',
  opts: {
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    startedAt?: string | null;
    finishedAt?: string | null;
    createdAt?: string;
  } = {},
): string {
  const db = getDb();
  const rid = `run-${Math.random().toString(36).slice(2)}`;
  const ts = opts.createdAt ?? now();
  const startedAt = opts.startedAt !== undefined
    ? opts.startedAt
    : (status !== 'pending' ? ts : null);
  const finishedAt = opts.finishedAt !== undefined
    ? opts.finishedAt
    : (['done', 'failed', 'cancelled'].includes(status) ? ts : null);
  db.prepare(`
    INSERT INTO p6_runs
      (id, workflow_id, status, started_at, finished_at, cost_usd, input_tokens, output_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(rid, workflowId, status, startedAt, finishedAt,
    opts.costUsd ?? 0.01, opts.inputTokens ?? 100, opts.outputTokens ?? 50, ts);
  return rid;
}

/** Insert p6_events rows of a given type for a run. */
function seedEvents(runId: string, type: 'tool-start' | 'tool-blocked', count = 1): void {
  const db = getDb();
  const ts = now();
  for (let i = 0; i < count; i++) {
    db.prepare(`INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, ?, '{}', ?)`)
      .run(runId, type, ts);
  }
}

/** Add a user as a member of a project. */
function addProjectMember(projectId: string, userId: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO project_members (project_id, user_id, access) VALUES (?, ?, 'editor')`)
    .run(projectId, userId);
}

/**
 * Create a non-admin user in the DB and return their session cookie.
 * tag is used to build a unique email address.
 */
async function createMemberUser(
  bUrl: string,
  tag: string,
): Promise<{ userId: string; cookie: string }> {
  const db = getDb();
  const ts = now();
  const uid = `user-${tag}-${Date.now()}`;
  const email = `${tag}-${Date.now()}@dash.test`;
  const pass = `pass-${tag}-xY7!`;
  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at)
    VALUES (?, ?, ?, ?, 0, 0, ?)
  `).run(uid, email, `${tag} user`, hashPassword(pass), ts);
  const login = await fetchJson(bUrl, '/api/auth/login', { body: { email, password: pass } });
  assert.equal(login.status, 200, `login failed for user tag=${tag}`);
  return { userId: uid, cookie: login.cookie ?? '' };
}

// ── Tests: positive member access ─────────────────────────────────────────────

describe('GET /api/dashboard – positive member access', () => {
  test('member sees their project agents but not non-member project agents', async () => {
    const { userId, cookie } = await createMemberUser(baseUrl, 'mem-vis');
    const projMy = seedProject('My Member Proj');
    const projForeign = seedProject('Foreign Proj A');
    addProjectMember(projMy, userId);

    seedWorkflowAndRun(projMy, 'visible-agent', 'done');
    seedWorkflowAndRun(projForeign, 'invisible-agent', 'done');

    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    assert.ok(agents.some((a) => a.agent === 'visible-agent'), 'own project agent must appear');
    assert.ok(!agents.some((a) => a.agent === 'invisible-agent'), 'foreign project agent must NOT appear');
  });

  test('member with ?projectId of own project gets 200', async () => {
    const { userId, cookie } = await createMemberUser(baseUrl, 'mem-own');
    const projMy = seedProject('Own Project 200');
    addProjectMember(projMy, userId);
    seedWorkflowAndRun(projMy, 'any-agent', 'done');

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projMy}`, { cookie });
    assert.equal(r.status, 200, 'member should get 200 for their own project');
  });

  test('member with ?projectId of foreign project gets 403', async () => {
    const { cookie } = await createMemberUser(baseUrl, 'mem-403');
    const projForeign = seedProject('Forbidden Proj');

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projForeign}`, { cookie });
    assert.equal(r.status, 403, 'non-member must get 403 for foreign projectId');
  });

  test('network edges from non-member projects do not leak', async () => {
    const { userId, cookie } = await createMemberUser(baseUrl, 'mem-edge');
    const projMy = seedProject('My Edge Proj');
    const projForeign = seedProject('Foreign Edge Proj');
    addProjectMember(projMy, userId);

    // Seed parent→child workflow pair in the foreign (non-member) project
    const { workflowId: parentWfId } = seedWorkflowAndRun(projForeign, 'leak-orchestrator', 'done');
    seedWorkflowAndRun(projForeign, 'leak-worker', 'done', { parentId: parentWfId });

    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie });
    assert.equal(r.status, 200);
    const edges = (
      (r.body as Record<string, unknown>).network as Record<string, unknown>
    ).edges as Array<Record<string, unknown>>;
    const leaked = edges.some(
      (e) => e.source === 'leak-orchestrator' || e.target === 'leak-worker',
    );
    assert.ok(!leaked, 'non-member edges must not appear in network');
  });

  test('recentSessions does not include non-member project workflows', async () => {
    const { userId, cookie } = await createMemberUser(baseUrl, 'mem-rec');
    const projMy = seedProject('My Recent Proj');
    const projForeign = seedProject('Foreign Recent Proj');
    addProjectMember(projMy, userId);
    seedWorkflowAndRun(projForeign, 'foreign-bot', 'done');

    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie });
    assert.equal(r.status, 200);
    const sessions = (r.body as Record<string, unknown>).recentSessions as Array<Record<string, unknown>>;
    assert.ok(
      !sessions.some((s) => s.projectId === projForeign),
      'foreign project must not appear in recentSessions',
    );
  });

  test('activeSession is null for member who can only see project with no running workflows', async () => {
    const { userId, cookie } = await createMemberUser(baseUrl, 'mem-act');
    const projMy = seedProject('My Active Proj (no runs)');
    const projForeign = seedProject('Foreign Running Proj');
    addProjectMember(projMy, userId);

    // Running workflow in non-member project — must NOT appear as activeSession
    const wfId = seedWorkflowWithStatus(projForeign, 'secret-runner', 'running');
    seedRunFor(wfId, 'running');

    const r = await fetchJson(baseUrl, '/api/dashboard', { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    // Either null, or if somehow non-null, must not be from projForeign
    if (body.activeSession !== null) {
      const session = body.activeSession as Record<string, unknown>;
      assert.notEqual(
        session.projectId,
        projForeign,
        'activeSession must not expose non-member project',
      );
    }
  });
});

// ── Tests: drill-down access ──────────────────────────────────────────────────

describe('GET /api/dashboard/agents/:agent/runs – drill-down access', () => {
  test('non-member gets no runs from projects they cannot access', async () => {
    const { userId, cookie } = await createMemberUser(baseUrl, 'drill-norun');
    const projMy = seedProject('My Drill Proj');
    const projForeign = seedProject('Foreign Drill Proj');
    addProjectMember(projMy, userId);
    // Seed run for unique agent name in foreign project only
    seedWorkflowAndRun(projForeign, 'inaccessible-drill-agent', 'done');

    const r = await fetchJson(
      baseUrl,
      '/api/dashboard/agents/inaccessible-drill-agent/runs',
      { cookie },
    );
    assert.equal(r.status, 200);
    const runs = (r.body as Record<string, unknown>).runs as unknown[];
    assert.equal(runs.length, 0, 'non-member must see 0 runs from foreign project');
  });

  test('non-member gets 403 when specifying a foreign projectId in drill-down', async () => {
    const { cookie } = await createMemberUser(baseUrl, 'drill-403');
    const projForeign = seedProject('Foreign Drill 403 Proj');

    const r = await fetchJson(
      baseUrl,
      `/api/dashboard/agents/some-agent/runs?projectId=${projForeign}`,
      { cookie },
    );
    assert.equal(r.status, 403, 'foreign projectId must return 403');
  });

  test('member gets 200 when specifying their own projectId in drill-down', async () => {
    const { userId, cookie } = await createMemberUser(baseUrl, 'drill-200');
    const projMy = seedProject('My Drill 200 Proj');
    addProjectMember(projMy, userId);
    seedWorkflowAndRun(projMy, 'my-drill-agent', 'done');

    const r = await fetchJson(
      baseUrl,
      `/api/dashboard/agents/my-drill-agent/runs?projectId=${projMy}`,
      { cookie },
    );
    assert.equal(r.status, 200, 'member should get 200 for their project drill-down');
    const runs = (r.body as Record<string, unknown>).runs as Array<Record<string, unknown>>;
    assert.ok(runs.length >= 1, 'should return at least one run for the member project');
  });
});

// ── Tests: exact numbers ──────────────────────────────────────────────────────

describe('GET /api/dashboard – exact numbers', () => {
  // Baseline timestamps: started_at is a fixed past anchor; finished_at offsets give
  // exact durations. created_at is now() so the run falls inside the 7d period.
  const START_TS = '2000-06-01T00:00:00.000Z';
  const msAfter = (ms: number): string =>
    new Date(new Date(START_TS).getTime() + ms).toISOString();

  test('exact successRate, completed, failed, runs', async () => {
    const projExact = seedProject('Exact Stats Proj');
    const wf1 = seedWorkflowWithStatus(projExact, 'precise-agent', 'done');
    const wf2 = seedWorkflowWithStatus(projExact, 'precise-agent', 'done');
    const wf3 = seedWorkflowWithStatus(projExact, 'precise-agent', 'failed');
    seedRunFor(wf1, 'done');
    seedRunFor(wf2, 'done');
    seedRunFor(wf3, 'failed');

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projExact}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const agent = agents.find((a) => a.agent === 'precise-agent');
    assert.ok(agent, 'precise-agent should be present');
    assert.equal(Number(agent.runs), 3, 'runs');
    assert.equal(Number(agent.completed), 2, 'completed');
    assert.equal(Number(agent.failed), 1, 'failed');
    // 2 done out of 3 terminal = 2/3
    assert.ok(Math.abs(Number(agent.successRate) - 2 / 3) < 1e-9, 'successRate should equal 2/3');
  });

  test('exact p50 and p95 durations', async () => {
    const projDur = seedProject('Exact Duration Proj');
    const wf1 = seedWorkflowWithStatus(projDur, 'dur-agent', 'done');
    const wf2 = seedWorkflowWithStatus(projDur, 'dur-agent', 'done');
    const wf3 = seedWorkflowWithStatus(projDur, 'dur-agent', 'failed');

    // durations: 1000ms, 2000ms, 4000ms → sorted [1000, 2000, 4000]
    seedRunFor(wf1, 'done', { startedAt: START_TS, finishedAt: msAfter(1000) });
    seedRunFor(wf2, 'done', { startedAt: START_TS, finishedAt: msAfter(2000) });
    seedRunFor(wf3, 'failed', { startedAt: START_TS, finishedAt: msAfter(4000) });

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projDur}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const agent = agents.find((a) => a.agent === 'dur-agent');
    assert.ok(agent, 'dur-agent should be present');
    // p50: idx = 0.5*(3-1) = 1 → sortedAsc[1] = 2000
    assert.ok(Math.abs(Number(agent.p50DurationMs) - 2000) <= 1, `p50 should be 2000ms, got ${agent.p50DurationMs}`);
    // p95: idx = 0.95*(3-1) = 1.9 → round(2000 + (4000-2000)*0.9) = 3800
    assert.ok(Math.abs(Number(agent.p95DurationMs) - 3800) <= 1, `p95 should be 3800ms, got ${agent.p95DurationMs}`);
  });

  test('a run created at the moment of the request is counted', async () => {
    // The range ends "now" and is exclusive: a run stamped in the same millisecond as the request used to be left out
    // (intermittent in CI). A run a moment ahead of the server's clock stands for it deterministically.
    const proj = seedProject('Same Millisecond Proj');
    const wf = seedWorkflowWithStatus(proj, 'edge-agent', 'done');
    seedRunFor(wf, 'done', { createdAt: new Date(Date.now() + 500).toISOString() });

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${proj}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    assert.ok(agents.find((a) => a.agent === 'edge-agent'), 'edge-agent should be present');
  });

  test('exact total cost and tokens', async () => {
    const projCost = seedProject('Exact Cost Proj');
    const wf1 = seedWorkflowWithStatus(projCost, 'cost-agent', 'done');
    const wf2 = seedWorkflowWithStatus(projCost, 'cost-agent', 'done');
    const wf3 = seedWorkflowWithStatus(projCost, 'cost-agent', 'failed');

    // costs: 1.0 + 2.0 + 0.5 = 3.5 (exact in IEEE 754)
    seedRunFor(wf1, 'done', { costUsd: 1.0, inputTokens: 1000, outputTokens: 500 });
    seedRunFor(wf2, 'done', { costUsd: 2.0, inputTokens: 2000, outputTokens: 1000 });
    seedRunFor(wf3, 'failed', { costUsd: 0.5, inputTokens: 500, outputTokens: 200 });

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projCost}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const agent = agents.find((a) => a.agent === 'cost-agent');
    assert.ok(agent, 'cost-agent should be present');
    assert.ok(Math.abs(Number(agent.costUsd) - 3.5) < 0.001, `costUsd should be 3.5, got ${agent.costUsd}`);
    assert.equal(Number(agent.inputTokens), 3500, 'inputTokens');
    assert.equal(Number(agent.outputTokens), 1700, 'outputTokens');
  });

  test('exact toolCalls (tool-start events) and toolErrors (tool-blocked events)', async () => {
    const projTool = seedProject('Exact Tool Proj');
    const wf1 = seedWorkflowWithStatus(projTool, 'tool-agent', 'done');
    const wf2 = seedWorkflowWithStatus(projTool, 'tool-agent', 'done');
    const wf3 = seedWorkflowWithStatus(projTool, 'tool-agent', 'failed');

    const r1 = seedRunFor(wf1, 'done');
    const r2 = seedRunFor(wf2, 'done');
    const r3 = seedRunFor(wf3, 'failed');

    // 3 + 2 = 5 tool-start events; 1 tool-blocked event
    seedEvents(r1, 'tool-start', 3);
    seedEvents(r2, 'tool-start', 2);
    seedEvents(r3, 'tool-blocked', 1);

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projTool}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const agent = agents.find((a) => a.agent === 'tool-agent');
    assert.ok(agent, 'tool-agent should be present');
    assert.equal(Number(agent.toolCalls), 5, 'toolCalls should be 5 (3+2 tool-start events)');
    assert.equal(Number(agent.toolErrors), 1, 'toolErrors should be 1 (tool-blocked event)');
  });
});

// ── Tests: period boundaries ──────────────────────────────────────────────────

describe('GET /api/dashboard – period boundaries', () => {
  test('runs older than the period are excluded from agent stats', async () => {
    const projOld = seedProject('Old Runs Proj');

    // 8 days ago → outside 7d period
    const wfOld = seedWorkflowWithStatus(projOld, 'bounds-agent', 'done', { createdAt: daysAgo(8) });
    seedRunFor(wfOld, 'done', { createdAt: daysAgo(8) });

    // 5 days ago → inside 7d period
    const wfNew = seedWorkflowWithStatus(projOld, 'bounds-agent', 'done', { createdAt: daysAgo(5) });
    seedRunFor(wfNew, 'done', { createdAt: daysAgo(5) });

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projOld}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Array<Record<string, unknown>>;
    const agent = agents.find((a) => a.agent === 'bounds-agent');
    assert.ok(agent, 'bounds-agent should be present');
    assert.equal(Number(agent.runs), 1, 'only the run within the 7d window should be counted');
  });

  test('successRatePrev is computed from the preceding window', async () => {
    const projPrev = seedProject('Prev Period Proj');

    // Runs in the previous 7d window (7–14 days ago): 1 done + 1 failed = 0.5
    const wfA = seedWorkflowWithStatus(projPrev, 'prev-agent', 'done', { createdAt: daysAgo(10) });
    seedRunFor(wfA, 'done', { createdAt: daysAgo(10) });
    const wfB = seedWorkflowWithStatus(projPrev, 'prev-agent', 'failed', { createdAt: daysAgo(12) });
    seedRunFor(wfB, 'failed', { createdAt: daysAgo(12) });

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projPrev}&period=7d`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const summary = (r.body as Record<string, unknown>).summary as Record<string, unknown>;
    // 1 done out of 2 terminal in prev window = 0.5
    assert.ok(summary.successRatePrev !== null, 'successRatePrev should not be null when prev period has runs');
    assert.ok(
      Math.abs(Number(summary.successRatePrev) - 0.5) < 1e-9,
      `successRatePrev should be 0.5, got ${summary.successRatePrev}`,
    );
  });

  test('completedToday and completedYesterday split on UTC midnight', async () => {
    const projDay = seedProject('Today Yesterday Proj');

    // UTC midnight of today
    const todayMid = new Date();
    todayMid.setUTCHours(0, 0, 0, 0);
    // 1 minute after today's UTC midnight → "today"
    const finishedToday = new Date(todayMid.getTime() + 60_000).toISOString();
    // 1 minute before today's UTC midnight → "yesterday"
    const finishedYesterday = new Date(todayMid.getTime() - 60_000).toISOString();

    // Both runs have created_at = now() (within 7d period)
    const wfT = seedWorkflowWithStatus(projDay, 'day-agent', 'done');
    seedRunFor(wfT, 'done', { finishedAt: finishedToday });
    const wfY = seedWorkflowWithStatus(projDay, 'day-agent', 'done');
    seedRunFor(wfY, 'done', { finishedAt: finishedYesterday });

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projDay}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const summary = (r.body as Record<string, unknown>).summary as Record<string, unknown>;
    assert.equal(Number(summary.completedToday), 1, 'completedToday');
    assert.equal(Number(summary.completedYesterday), 1, 'completedYesterday');
  });
});

// ── Tests: activeSession ──────────────────────────────────────────────────────

describe('GET /api/dashboard – activeSession', () => {
  test('null when no running workflow in the scope', async () => {
    const projStatic = seedProject('Static Only Proj');
    // Only done runs — no running workflow
    seedWorkflowAndRun(projStatic, 'static-agent', 'done');

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projStatic}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).activeSession, null, 'activeSession must be null');
  });

  test('running workflow returns activeSession with steps in chronological order and correct kind values', async () => {
    const projLive = seedProject('Live Workflow Proj');

    // Parent running workflow
    const wfId = seedWorkflowWithStatus(projLive, 'parent-runner', 'running');

    // Fixed anchor for ordering (all well in the past so sorting is clear)
    const T0 = '2001-01-01T00:00:00.000Z';
    const T1 = '2001-01-01T00:00:01.000Z';
    const T2 = '2001-01-01T00:00:02.000Z';
    const T3 = '2001-01-01T00:00:03.000Z';

    // Own run 1: started at T1
    const runId1 = seedRunFor(wfId, 'done', { startedAt: T1, finishedAt: T2, createdAt: T1 });
    // Own run 2: pending (no started_at) — should sort last
    const runId2 = seedRunFor(wfId, 'pending', { startedAt: null, finishedAt: null, createdAt: T3 });

    // Child workflow created at T0 (before run1 started) — should sort first
    const childId1 = seedWorkflowWithStatus(projLive, 'child-agent-early', 'done', {
      parentId: wfId,
      createdAt: T0,
    });
    // Child workflow created at T2
    const childId2 = seedWorkflowWithStatus(projLive, 'child-agent-late', 'running', {
      parentId: wfId,
      createdAt: T2,
    });

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projLive}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const active = body.activeSession as Record<string, unknown> | null;
    assert.ok(active !== null, 'activeSession must not be null');
    assert.equal(active.id, wfId, 'activeSession.id must match workflow id');
    assert.equal(active.agent, 'parent-runner', 'activeSession.agent');
    assert.equal(active.status, 'running', 'activeSession.status');

    const steps = active.steps as Array<Record<string, unknown>>;
    assert.ok(steps.length >= 3, `should have at least 3 steps, got ${steps.length}`);

    // Verify kind values: own runs → 'run', child workflows → 'child'
    const runSteps = steps.filter((s) => s.kind === 'run');
    const childSteps = steps.filter((s) => s.kind === 'child');
    assert.ok(runSteps.length >= 1, 'should have at least one run step');
    assert.ok(childSteps.length >= 2, 'should have at least two child steps');

    // The pending run (no startedAt) must sort last
    const lastStep = steps[steps.length - 1];
    assert.equal(lastStep.startedAt, null, 'pending run with null startedAt must be last');
    assert.equal(lastStep.kind, 'run', 'last step must be the pending run');

    // Chronological order: among non-null startedAt, earlier timestamps come first
    const nonNullSteps = steps.filter((s) => s.startedAt !== null);
    for (let i = 1; i < nonNullSteps.length; i++) {
      const prev = String(nonNullSteps[i - 1].startedAt);
      const curr = String(nonNullSteps[i].startedAt);
      assert.ok(prev <= curr, `steps must be in chronological order: ${prev} <= ${curr}`);
    }
  });
});

// ── Tests: summary live counts ────────────────────────────────────────────────

describe('GET /api/dashboard – summary live counts', () => {
  test('runningSessions and queuedSessions reflect live workflow statuses', async () => {
    const projCounts = seedProject('Live Counts Proj');

    // 2 running workflows
    seedWorkflowWithStatus(projCounts, 'counter-agent', 'running');
    seedWorkflowWithStatus(projCounts, 'counter-agent', 'running');
    // 3 pending (queued) workflows
    seedWorkflowWithStatus(projCounts, 'counter-agent', 'pending');
    seedWorkflowWithStatus(projCounts, 'counter-agent', 'pending');
    seedWorkflowWithStatus(projCounts, 'counter-agent', 'pending');

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projCounts}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const summary = (r.body as Record<string, unknown>).summary as Record<string, unknown>;
    assert.equal(Number(summary.runningSessions), 2, 'runningSessions should be 2');
    assert.equal(Number(summary.queuedSessions), 3, 'queuedSessions should be 3');
  });

  test('activeAgents counts distinct agents with a running run', async () => {
    const projActive = seedProject('Active Agents Proj');

    const wf1 = seedWorkflowWithStatus(projActive, 'live-agent-one', 'running');
    const wf2 = seedWorkflowWithStatus(projActive, 'live-agent-two', 'running');
    // Only wf1 has an actually running run
    seedRunFor(wf1, 'running');
    // wf2 has only a done run — its agent should NOT count
    seedRunFor(wf2, 'done');

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projActive}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const summary = (r.body as Record<string, unknown>).summary as Record<string, unknown>;
    assert.equal(Number(summary.activeAgents), 1, 'only live-agent-one has a running run');
  });

  test('network node running flag is true for agent with a running run', async () => {
    const projRunning = seedProject('Network Running Flag Proj');

    // Seed a workflow for the agent and a running run
    const wfRun = seedWorkflowWithStatus(projRunning, 'running-network-agent', 'running');
    seedRunFor(wfRun, 'running');
    // Also seed a terminal run for a different agent to confirm non-running flag is false
    const wfDone = seedWorkflowWithStatus(projRunning, 'done-network-agent', 'done');
    seedRunFor(wfDone, 'done');

    const r = await fetchJson(baseUrl, `/api/dashboard?projectId=${projRunning}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const nodes = ((r.body as Record<string, unknown>).network as Record<string, unknown>)
      .nodes as Array<Record<string, unknown>>;

    const runningNode = nodes.find((n) => n.id === 'running-network-agent');
    assert.ok(runningNode, 'running-network-agent must appear as a network node');
    assert.equal(runningNode!.running, true, 'running flag must be true for agent with running run');

    const doneNode = nodes.find((n) => n.id === 'done-network-agent');
    if (doneNode) {
      assert.equal(doneNode.running, false, 'running flag must be false for agent with no running run');
    }
  });
});

// ── Tests: SSE notifications ──────────────────────────────────────────────────

describe('GET /api/dashboard – SSE notifications', () => {
  test('burst of notifyDashboard calls emits exactly one dashboard.changed event after debounce', async () => {
    const sse = openSseHttp(baseUrl, '/api/events', adminCookie);
    await sse.ready;

    const testProjectId = `proj-sse-${Date.now()}`;

    // Burst: 5 rapid calls for the same projectId → debounce collapses to 1 event
    for (let i = 0; i < 5; i++) {
      notifyDashboard(testProjectId);
    }

    // Wait longer than the 500ms debounce window
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    sse.close();

    const dashboardEvents = (sse.events as Array<Record<string, unknown>>).filter(
      (e) => e.type === 'dashboard.changed',
    );
    assert.equal(
      dashboardEvents.length,
      1,
      `expected exactly 1 dashboard.changed event, got ${dashboardEvents.length}`,
    );
    // The event must carry no project-identifying data (cross-project leak prevention)
    assert.ok(
      !('projectId' in dashboardEvents[0]),
      'dashboard.changed event must not expose projectId',
    );
  });
});

// ── Tests: URL edge cases ─────────────────────────────────────────────────────

describe('GET /api/dashboard/agents/:agent/runs – URL edge cases', () => {
  test('agent name with spaces and special characters works in drill-down', async () => {
    const projSpecial = seedProject('URL Special Chars Proj');
    // Agent name with a space and ampersand
    const agentName = 'review bot v2';
    seedWorkflowAndRun(projSpecial, agentName, 'done');

    // URL-encode the agent name (spaces → %20)
    const encoded = encodeURIComponent(agentName);
    const r = await fetchJson(baseUrl, `/api/dashboard/agents/${encoded}/runs`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const runs = (r.body as Record<string, unknown>).runs as Array<Record<string, unknown>>;
    assert.ok(runs.length >= 1, `drill-down for "${agentName}" (encoded: ${encoded}) should return runs`);
    for (const run of runs) {
      assert.ok('id' in run, 'run must have id');
      assert.ok('status' in run, 'run must have status');
    }
  });

  test('agent name with forward slash (percent-encoded %2F) works in drill-down', async () => {
    const projSlash = seedProject('Slash Agent Proj');
    const agentName = 'qa/review';
    seedWorkflowAndRun(projSlash, agentName, 'done');

    // %2F encodes the slash — router should decode it back via decodeURIComponent
    const r = await fetchJson(baseUrl, `/api/dashboard/agents/qa%2Freview/runs`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const runs = (r.body as Record<string, unknown>).runs as Array<Record<string, unknown>>;
    assert.ok(runs.length >= 1, 'drill-down for "qa/review" via %2F should return runs');
  });
});
