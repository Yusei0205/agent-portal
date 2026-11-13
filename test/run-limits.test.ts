/**
 * Run limits: spend cap, working-time limit, and stop reason (FR-GUARD-10).
 *
 * Tests:
 *   - GET /api/settings returns agents.maxBudgetUsdPerRun, runTimeoutMinutes, effort
 *   - PUT /api/settings validates and saves agent limits
 *   - Budget stop_reason is recorded when the SDK returns error_max_budget_usd
 *   - p6_runs.time_limit_at is set when runTimeoutMinutes is configured
 *   - Run with a very short time limit is aborted and gets stop_reason
 *   - p6_runs.stop_reason is exposed on GET /api/runs/:id
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getDb, one } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import { estimateCost } from '../server/agent/pricing.ts';
import { abortAllRuns } from '../server/workflows/controls.ts';
import { shutdownStopReason, shutdownMessage } from '../server/agent/runner.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SDK = path.resolve(__dirname, 'fake-sdk.mjs');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: {
      email: `admin-rl-${Date.now()}@test.com`,
      name: 'Admin',
      password: 'password1234',
      provider: 'demo',
    },
  });
  return r.cookie ?? '';
}

async function waitForRunStatus(
  baseUrl: string,
  cookie: string,
  projectId: string,
  workflowId: string,
  runId: string,
  expected: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/workflows/${workflowId}/runs/${runId}`,
      { cookie },
    );
    const run = (r.body as Record<string, unknown>).run as Record<string, unknown>;
    if (run && run.status === expected) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Run did not reach "${expected}" status within ${timeoutMs}ms`);
}

// ── Settings tests ────────────────────────────────────────────────────────────

describe('Agent limits settings', () => {
  let baseUrl: string;
  let cookie: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
  });

  after(async () => { await cleanup(); });

  it('GET /api/settings returns agents section with defaults', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', { cookie });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const body = r.body as Record<string, unknown>;
    const agents = body.agents as Record<string, unknown> | undefined;
    assert.ok(agents, 'Expected agents section in settings');
    assert.equal(typeof agents.approvalExpiryMinutes, 'number', 'approvalExpiryMinutes should be a number');
    assert.equal(agents.maxBudgetUsdPerRun, 5, 'default maxBudgetUsdPerRun should be 5');
    assert.equal(agents.runTimeoutMinutes, 60, 'default runTimeoutMinutes should be 60');
  });

  it('PUT /api/settings updates agent limits', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { agents: { maxBudgetUsdPerRun: 10, runTimeoutMinutes: 30, approvalExpiryMinutes: 15 } },
      cookie,
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const agents = (r.body as Record<string, unknown>).agents as Record<string, unknown>;
    assert.equal(agents.maxBudgetUsdPerRun, 10);
    assert.equal(agents.runTimeoutMinutes, 30);
    assert.equal(agents.approvalExpiryMinutes, 15);
  });

  it('PUT /api/settings with null maxBudgetUsdPerRun removes the limit', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { agents: { maxBudgetUsdPerRun: null } },
      cookie,
    });
    assert.equal(r.status, 200);
    const agents = (r.body as Record<string, unknown>).agents as Record<string, unknown>;
    assert.equal(agents.maxBudgetUsdPerRun, null);
  });

  it('PUT /api/settings validates out-of-range maxBudgetUsdPerRun', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { agents: { maxBudgetUsdPerRun: 99999 } },
      cookie,
    });
    assert.equal(r.status, 400, `Expected 400 for out-of-range budget, got ${r.status}`);
  });

  it('PUT /api/settings validates approvalExpiryMinutes range', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { agents: { approvalExpiryMinutes: 999999 } },
      cookie,
    });
    assert.equal(r.status, 400);
  });
});

// ── Run limit integration tests ───────────────────────────────────────────────

describe('Budget stop — SDK error_max_budget_usd is recorded as stop_reason', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);

    const pR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: `RunLimits-Budget-${Date.now()}` },
      cookie,
    });
    projectId = ((pR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;

    // Seed provider + fake key
    const db = getDb();
    const fakeEnc = encrypt('sk-ant-fake', config.secretKey);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('provider.mode', 'anthropic')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('anthropic.key.enc', ?)").run(fakeEnc);

    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'budget';
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    await cleanup();
  });

  it('run with budget scenario: stop_reason is recorded and run is done', async () => {
    const wfR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Test budget stop', engine: 'claude-code' },
      cookie,
    });
    const workflowId = ((wfR.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;

    const runR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/start`, {
      method: 'POST',
      body: {},
      cookie,
    });
    const runId = ((runR.body as Record<string, unknown>).run as Record<string, unknown>).id as string;

    // Wait for run to complete (budget stop still completes the run, not fails it)
    const terminal = await waitForRunStatus(baseUrl, cookie, projectId, workflowId, runId, 'done', 10_000).catch(
      () => waitForRunStatus(baseUrl, cookie, projectId, workflowId, runId, 'failed', 10_000),
    );

    // Check stop_reason was recorded via GET /api/runs/:id
    const runDetail = await fetchJson(baseUrl, `/api/runs/${runId}`, { cookie });
    const run = (runDetail.body as Record<string, unknown>).run as Record<string, unknown>;
    assert.ok(run, 'Expected run object');
    // The engine reports a budget stop in the result's subtype; the portal records it.
    assert.match(String(run.stop_reason ?? ''), /spend cap reached/, 'the budget stop is recorded');
  });
});

describe('Time limit — run is aborted and stop_reason is recorded', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);

    const pR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: `RunLimits-Time-${Date.now()}` },
      cookie,
    });
    projectId = ((pR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;

    // Set a very short run timeout (0.01 minutes = 0.6 seconds)
    await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { agents: { runTimeoutMinutes: 0.01 } },
      cookie,
    });

    // Seed provider + fake key
    const db = getDb();
    const fakeEnc = encrypt('sk-ant-fake', config.secretKey);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('provider.mode', 'anthropic')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('anthropic.key.enc', ?)").run(fakeEnc);

    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'spend-then-hang';
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    // Reset timeout
    await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { agents: { runTimeoutMinutes: 60 } },
      cookie,
    });
    await cleanup();
  });

  it('run is cancelled by time limit and stop_reason is set', async () => {
    const wfR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Test time limit', engine: 'claude-code' },
      cookie,
    });
    const workflowId = ((wfR.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;

    const runR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/start`, {
      method: 'POST',
      body: {},
      cookie,
    });
    const runId = ((runR.body as Record<string, unknown>).run as Record<string, unknown>).id as string;

    // Wait for cancellation (short timeout — 8 seconds)
    const terminal = await waitForRunStatus(baseUrl, cookie, projectId, workflowId, runId, 'cancelled', 8_000).catch(
      () => waitForRunStatus(baseUrl, cookie, projectId, workflowId, runId, 'failed', 8_000),
    );

    // time_limit_at should have been set on the run
    const runRow = one<{ status: string; time_limit_at: string | null; stop_reason: string | null; cost_usd: number; input_tokens: number; output_tokens: number; model: string }>(
      'SELECT status, time_limit_at, stop_reason, cost_usd, input_tokens, output_tokens, model FROM p6_runs WHERE id = ?',
      runId,
    );
    assert.ok(runRow, 'Run row should exist');
    assert.equal(runRow.status, 'cancelled', `terminal status: ${JSON.stringify(terminal)}`);
    assert.ok(runRow.time_limit_at, 'time_limit_at should be set');
    // The engine stops with an abort; the runner still records which limit stopped it.
    assert.match(String(runRow.stop_reason), /time limit reached/);
    // The model was used before the limit (spend-then-hang: 50 in, 20 out); that spend is kept.
    assert.equal(runRow.input_tokens, 50);
    assert.equal(runRow.output_tokens, 20);
    assert.ok(runRow.cost_usd > 0, `spend recorded: ${runRow.cost_usd}`);
    // Priced for the run's own model (the engine reported no total before the stop).
    assert.equal(runRow.cost_usd, estimateCost(runRow.model, { input_tokens: 50, output_tokens: 20 }), `model ${runRow.model}`);
    const spend = one<{ n: number }>('SELECT COUNT(*) AS n FROM budget_usage WHERE workflow_id = ?', workflowId)!;
    assert.equal(spend.n, 1, 'the stopped run counts toward the budget');
  });
});

describe('p6_runs.stop_reason exposed via GET /api/runs/:id', () => {
  let baseUrl: string;
  let cookie: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
  });

  after(async () => { await cleanup(); });

  it('stop_reason field is present in run view', async () => {
    const db = getDb();
    const projR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'RunLimits-View' },
      cookie,
    });
    const projectId = ((projR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;

    const wfId = `wf-sl-${generateId()}`;
    const runId = `run-sl-${generateId()}`;
    db.prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at) VALUES (?, ?, 'test', 'done', 'demo', 0, '[]', ?, ?)",
    ).run(wfId, projectId, now(), now());
    db.prepare(
      "INSERT INTO p6_runs (id, workflow_id, status, stop_reason, created_at) VALUES (?, ?, 'cancelled', 'spend cap reached ($5)', ?)",
    ).run(runId, wfId, now());

    const r = await fetchJson(baseUrl, `/api/runs/${runId}`, { cookie });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const run = (r.body as Record<string, unknown>).run as Record<string, unknown>;
    assert.equal(run.stop_reason, 'spend cap reached ($5)');
  });
});

describe('a run the portal\'s shutdown stops says so (it is not a person\'s Stop)', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    const pR = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `RunLimits-Shutdown-${Date.now()}` }, cookie });
    projectId = ((pR.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    await fetchJson(baseUrl, '/api/settings', { method: 'PUT', body: { agents: { runTimeoutMinutes: 60 } }, cookie });
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('provider.mode', 'anthropic')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('anthropic.key.enc', ?)").run(encrypt('sk-ant-fake', config.secretKey));
    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'spend-then-hang';
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    await cleanup();
  });

  it('records why the run stopped and tells the person to send another message', async () => {
    const wfR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal: 'A long task', engine: 'claude-code' }, cookie });
    const workflowId = ((wfR.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
    const runR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/start`, { method: 'POST', body: {}, cookie });
    const runId = ((runR.body as Record<string, unknown>).run as Record<string, unknown>).id as string;
    await waitForRunStatus(baseUrl, cookie, projectId, workflowId, runId, 'running', 8_000);
    await new Promise((r) => setTimeout(r, 500)); // the engine has started and spent, then waits

    // What closeDb() does when the process gets SIGTERM (a restart, or the end of a Lambda invocation).
    abortAllRuns();
    await waitForRunStatus(baseUrl, cookie, projectId, workflowId, runId, 'cancelled', 8_000);

    const row = one<{ stop_reason: string | null; input_tokens: number }>('SELECT stop_reason, input_tokens FROM p6_runs WHERE id = ?', runId)!;
    assert.equal(row.stop_reason, shutdownStopReason(), 'the reason is recorded');
    assert.equal(row.input_tokens, 50, 'the spend up to the stop is kept');
    const failed = one<{ payload: string }>("SELECT payload FROM p6_events WHERE run_id = ? AND type = 'run-failed'", runId)!;
    assert.equal(JSON.parse(failed.payload).error, shutdownMessage(), 'the session shows why, not a bare "Cancelled"');
    assert.match(shutdownMessage(), /Send another message to continue/);

    // On Lambda the reason names the 15-minute limit of a cloud turn.
    const saved = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'agent-portal';
    try {
      assert.match(shutdownStopReason(), /at most 15 minutes/);
      assert.match(shutdownMessage(), /at most 15 minutes/);
    } finally {
      if (saved === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      else process.env.AWS_LAMBDA_FUNCTION_NAME = saved;
    }
  });
});
