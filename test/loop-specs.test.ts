/**
 * P10 Loop Specs tests.
 *
 * Tests:
 *   - Built-in loop specs are seeded on DB init (7 specs)
 *   - GET /api/projects/:id/loop-specs returns built-ins + project specs
 *   - POST /api/projects/:id/loop-specs creates custom spec
 *   - POST .../run triggers a loop run
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { all, one, run } from '../server/db.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: {
      email: `admin-loops-${Date.now()}@example.com`,
      name: 'Admin',
      password: 'password1234',
      provider: 'demo',
    },
  });
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string, name: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

// ── Seeded built-in specs ─────────────────────────────────────────────────────

describe('Built-in loop specs seeded on DB init', () => {
  before(async () => {
    await createTestServer();
  });

  after(async () => { await cleanup(); });

  it('seeds exactly 7 built-in specs', () => {
    const specs = all('SELECT * FROM p10_loop_specs WHERE is_builtin = 1');
    assert.equal(specs.length, 7, `expected 7 built-in specs, got ${specs.length}`);
  });

  it('seeds investigate-and-fix spec', () => {
    const spec = one('SELECT * FROM p10_loop_specs WHERE id = ?', 'builtin-investigate-fix');
    assert.ok(spec, 'investigate-and-fix spec should exist');
    assert.equal(spec!.trigger_type, 'manual');
    assert.ok(String(spec!.goal_template).includes('{{ticket}}'));
  });

  it('seeds feature-from-ticket spec', () => {
    const spec = one('SELECT * FROM p10_loop_specs WHERE id = ?', 'builtin-feature-ticket');
    assert.ok(spec);
    assert.equal(spec!.trigger_type, 'jira');
    assert.ok(String(spec!.goal_template).includes('{{ticket.title}}'));
  });

  it('seeds bug-fix spec', () => {
    const spec = one('SELECT * FROM p10_loop_specs WHERE id = ?', 'builtin-bug-fix');
    assert.ok(spec);
    assert.equal(spec!.trigger_type, 'manual');
    assert.ok(String(spec!.goal_template).includes('{{description}}'));
  });

  it('seeds nightly-test-fixer spec with cron trigger', () => {
    const spec = one('SELECT * FROM p10_loop_specs WHERE id = ?', 'builtin-nightly-test-fixer');
    assert.ok(spec);
    assert.equal(spec!.trigger_type, 'cron');
    const config = JSON.parse(String(spec!.trigger_config));
    assert.equal(config.cron, '0 2 * * *');
  });

  it('seeds dependency-update spec with Monday 3am cron', () => {
    const spec = one('SELECT * FROM p10_loop_specs WHERE id = ?', 'builtin-dependency-update');
    assert.ok(spec);
    assert.equal(spec!.trigger_type, 'cron');
    const config = JSON.parse(String(spec!.trigger_config));
    assert.equal(config.cron, '0 3 * * 1');
  });

  it('seeds keep-docs-current spec with github trigger', () => {
    const spec = one('SELECT * FROM p10_loop_specs WHERE id = ?', 'builtin-keep-docs-current');
    assert.ok(spec);
    assert.equal(spec!.trigger_type, 'github');
    const config = JSON.parse(String(spec!.trigger_config));
    assert.ok(Array.isArray(config.actions));
    assert.ok(config.actions.includes('refresh_diagrams'));
  });

  it('seeds review-new-pull-requests spec with github trigger', () => {
    const spec = one('SELECT * FROM p10_loop_specs WHERE id = ?', 'builtin-review-prs');
    assert.ok(spec);
    assert.equal(spec!.trigger_type, 'github');
    const config = JSON.parse(String(spec!.trigger_config));
    assert.equal(config.action, 'review_pr');
    assert.equal(config.postMode, 'draft');
  });
});

// ── GET /api/projects/:id/loop-specs ─────────────────────────────────────────

describe('GET /api/projects/:id/loop-specs', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'Loop Specs List Project');
  });

  after(async () => { await cleanup(); });

  it('returns built-ins and project specs', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.specs), 'should return specs array');
    const specs = body.specs as Record<string, unknown>[];
    // Should have 7 built-ins at least
    assert.ok(specs.length >= 7, `expected at least 7 specs, got ${specs.length}`);
  });

  it('includes built-in specs with is_builtin=1', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, { cookie });
    const specs = (r.body as Record<string, unknown>).specs as Record<string, unknown>[];
    const builtins = specs.filter((s) => s.is_builtin === 1 || s.is_builtin === true);
    assert.ok(builtins.length >= 7, 'should include 7 built-in specs');
  });

  it('returns 401 when not authenticated', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`);
    assert.equal(r.status, 401);
  });
});

// ── POST /api/projects/:id/loop-specs ────────────────────────────────────────

describe('POST /api/projects/:id/loop-specs', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'Loop Specs Create Project');
  });

  after(async () => { await cleanup(); });

  it('creates a custom manual spec', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, {
      method: 'POST',
      body: {
        name: 'My Custom Spec',
        description: 'A test spec',
        triggerType: 'manual',
        goalTemplate: 'Do {{task}} in {{repo}}',
        maxIterations: 5,
      },
      cookie,
    });
    assert.equal(r.status, 201);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.spec, 'should return a spec');
    const spec = body.spec as Record<string, unknown>;
    assert.equal(spec.name, 'My Custom Spec');
    assert.equal(spec.trigger_type, 'manual');
    assert.equal(spec.max_iterations, 5);
    assert.equal(spec.is_builtin, 0);
    assert.ok(spec.id, 'should have an id');
  });

  it('creates a cron spec', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, {
      method: 'POST',
      body: {
        name: 'Nightly Cleanup',
        triggerType: 'cron',
        triggerConfig: { cron: '0 0 * * *' },
        goalTemplate: 'Clean up old files',
        maxIterations: 1,
      },
      cookie,
    });
    assert.equal(r.status, 201);
    const spec = (r.body as Record<string, unknown>).spec as Record<string, unknown>;
    assert.equal(spec.trigger_type, 'cron');
    const tc = spec.trigger_config as Record<string, unknown>;
    assert.equal(tc.cron, '0 0 * * *');
  });

  it('returns 400 when name is missing', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, {
      method: 'POST',
      body: { triggerType: 'manual', goalTemplate: 'Do something' },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('spec appears in GET list', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, {
      method: 'POST',
      body: { name: 'Listed Spec', triggerType: 'manual', goalTemplate: 'Do X' },
      cookie,
    });
    const specId = ((createR.body as Record<string, unknown>).spec as Record<string, unknown>).id as string;

    const listR = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, { cookie });
    const specs = (listR.body as Record<string, unknown>).specs as Record<string, unknown>[];
    const found = specs.find((s) => s.id === specId);
    assert.ok(found, 'created spec should appear in list');
  });
});

// ── POST /api/projects/:id/loop-specs/:sid/run ────────────────────────────────

describe('POST /api/projects/:id/loop-specs/:sid/run', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let specId: string;
  let builtinSpecId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'Loop Run Project');

    // Create a custom spec
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/loop-specs`, {
      method: 'POST',
      body: { name: 'Run Test Spec', triggerType: 'manual', goalTemplate: 'Test {{task}}', maxIterations: 3 },
      cookie,
    });
    specId = ((r.body as Record<string, unknown>).spec as Record<string, unknown>).id as string;

    // Use the built-in investigate-and-fix spec
    builtinSpecId = 'builtin-investigate-fix';
  });

  after(async () => { await cleanup(); });

  it('creates a loop run for a custom spec', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/loop-specs/${specId}/run`,
      { method: 'POST', body: { vars: { task: 'cleanup' } }, cookie },
    );
    assert.equal(r.status, 201);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.run, 'should return a run');
    const loopRun = body.run as Record<string, unknown>;
    assert.equal(loopRun.status, 'running');
    assert.equal(loopRun.spec_id, specId);
    assert.ok(loopRun.id, 'should have an id');
  });

  it('fills template vars in the goal', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/loop-specs/${specId}/run`,
      { method: 'POST', body: { vars: { task: 'my-task' } }, cookie },
    );
    assert.equal(r.status, 201);
    const body = r.body as Record<string, unknown>;
    assert.ok(String(body.goal).includes('my-task'), 'goal should have vars substituted');
  });

  it('creates a loop run for a built-in spec', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/loop-specs/${builtinSpecId}/run`,
      { method: 'POST', body: {}, cookie },
    );
    assert.equal(r.status, 201);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.run, 'should return a run for built-in spec');
  });

  it('run appears in GET runs list', async () => {
    // Trigger a run
    await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/loop-specs/${specId}/run`,
      { method: 'POST', body: {}, cookie },
    );

    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/loop-specs/${specId}/runs`,
      { cookie },
    );
    assert.equal(r.status, 200);
    const runs = (r.body as Record<string, unknown>).runs as unknown[];
    assert.ok(runs.length >= 1, 'should have at least 1 run in history');
  });

  it('returns 404 for unknown spec', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/loop-specs/nonexistent/run`,
      { method: 'POST', body: {}, cookie },
    );
    assert.equal(r.status, 404);
  });

  it('returns 401 when not authenticated', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/loop-specs/${specId}/run`,
      { method: 'POST', body: {} },
    );
    assert.equal(r.status, 401);
  });
});
