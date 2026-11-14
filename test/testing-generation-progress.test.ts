/**
 * Tests for generation progress, cancellation, 0-steps failure, parser shapes (F12c hardening).
 *
 *   - zero-steps: model returns [] or all-invalid → failed with specific message, no script left
 *   - parser shapes: ANSI codes, {steps:[...]}, truncated array, fenced block all parsed
 *   - progress: GET /generations list includes progress, startedAt, createdAt
 *   - cancel: POST /cancel stops generation, saves no script, returns {generation}
 *   - cancel no-op: cancelling a finished job returns current state unchanged
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { setModelCallFn, extractJsonArray } from '../server/testing/index.ts';
import { insert as dbInsert } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import type { ModelCallContext } from '../server/testing/generate.ts';

// ── Shared setup helpers ──────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string) {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `prog-test-${Date.now()}@example.com`, name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200);
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string) {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: 'Progress Test Project' },
    cookie,
  });
  assert.equal(r.status, 201);
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createTestProject(baseUrl: string, cookie: string, pid: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests`, {
    method: 'POST',
    body: { name: 'Progress TP', appUrl: 'http://progress-test.example.com' },
    cookie,
  });
  assert.equal(r.status, 201);
  return (r.body as { testProject: { id: string } }).testProject.id;
}

async function createGroup(baseUrl: string, cookie: string, pid: string, tpid: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/groups`, {
    method: 'POST',
    body: { name: 'Group' },
    cookie,
  });
  assert.equal(r.status, 201);
  return (r.body as { group: { id: string } }).group.id;
}

async function startGeneration(
  baseUrl: string, cookie: string, pid: string, tpid: string,
  description = 'test', gid?: string,
) {
  const body: Record<string, unknown> = { description };
  if (gid) body.groupId = gid;
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate`, {
    method: 'POST', body, cookie,
  });
  assert.equal(r.status, 202);
  return (r.body as { generationId: string }).generationId;
}

async function pollGeneration(
  baseUrl: string, cookie: string, pid: string, tpid: string, genId: string,
  maxMs = 8_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    const sr = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate/${genId}`, { cookie });
    const gen = (sr.body as { generation: Record<string, unknown> }).generation;
    if (gen.status === 'done' || gen.status === 'failed') return gen;
  }
  throw new Error(`Generation did not reach terminal state within ${maxMs}ms`);
}

// ── Parser shape unit tests ───────────────────────────────────────────────────

describe('extractJsonArray — extended output shapes', () => {
  it('strips ANSI escape sequences before parsing', () => {
    const ansiText = '\x1B[32m[\x1B[0m{"kind":"goto","path":"/"}\x1B[32m]\x1B[0m';
    const result = extractJsonArray(ansiText);
    assert.ok(Array.isArray(result), 'ANSI-wrapped array must be parsed');
    assert.equal((result as unknown[]).length, 1);
  });

  it('unwraps {steps:[...]} object returned by some Kiro CLI versions', () => {
    const text = '{"steps":[{"kind":"goto","path":"/"},{"kind":"assert_url","url":"/"}]}';
    const result = extractJsonArray(text);
    assert.ok(Array.isArray(result), '{steps:[...]} must be unwrapped to array');
    assert.equal((result as unknown[]).length, 2);
  });

  it('unwraps {steps:[...]} inside a fenced block', () => {
    const text = '```json\n{"steps":[{"kind":"goto","path":"/login"}]}\n```';
    const result = extractJsonArray(text);
    assert.ok(Array.isArray(result), '{steps:[...]} inside fenced block must be unwrapped');
    assert.equal((result as unknown[]).length, 1);
  });

  it('recovers a truncated JSON array (output cut off mid-element)', () => {
    // Simulate Kiro CLI output that got cut off before the closing bracket
    const truncated = '[{"kind":"goto","path":"/"},{"kind":"click","locator":{"role":"butt';
    const result = extractJsonArray(truncated);
    assert.ok(Array.isArray(result), 'truncated array must be recovered');
    // At least the first complete element should be recovered
    assert.ok((result as unknown[]).length >= 1, 'at least one complete element should be recovered');
  });

  it('recovers truncated array with complete elements plus garbage at end', () => {
    const truncated = '[{"kind":"goto","path":"/"},{"kind":"assert_url","url":"/home"}' + ',{"kind":"fill","locator":{"label":"Em';
    const result = extractJsonArray(truncated);
    assert.ok(Array.isArray(result), 'partially-truncated array must be recovered');
    assert.ok((result as unknown[]).length >= 2, 'two complete elements should be recovered');
  });

  it('ANSI codes around a {steps:[...]} object are stripped and unwrapped', () => {
    const ansi = '\x1B[1m{\x1B[0m"steps":[{"kind":"wait","ms":100}]}';
    const result = extractJsonArray(ansi);
    assert.ok(Array.isArray(result));
    assert.equal((result as unknown[]).length, 1);
  });

  it('empty steps array in a {steps:[]} object is returned as empty array', () => {
    const text = '{"steps":[]}';
    const result = extractJsonArray(text);
    assert.ok(Array.isArray(result));
    assert.equal((result as unknown[]).length, 0);
  });
});

// ── Zero-steps failure ────────────────────────────────────────────────────────

describe('zero-steps generation failure', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let tpid: string;
  let gid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    pid = await createProject(baseUrl, cookie);
    tpid = await createTestProject(baseUrl, cookie, pid);
    gid = await createGroup(baseUrl, cookie, pid, tpid);
  });

  after(async () => {
    setModelCallFn(null);
    await cleanup();
  });

  afterEach(() => { setModelCallFn(null); });

  it('model returns [] → retries → still 0 → failed with specific message, no script created', async () => {
    let callCount = 0;
    setModelCallFn(async () => { callCount++; return []; });

    const genId = await startGeneration(baseUrl, cookie, pid, tpid, 'empty output test', gid);
    const gen = await pollGeneration(baseUrl, cookie, pid, tpid, genId);

    assert.equal(gen.status, 'failed', `Expected failed, got ${gen.status}: ${gen.error}`);
    assert.ok(
      String(gen.error).includes('no usable steps'),
      `Error must mention "no usable steps", got: ${gen.error}`,
    );
    // Model should have been called twice (first + retry)
    assert.equal(callCount, 2, `Expected 2 model calls (first + retry), got ${callCount}`);

    // No script should have been created
    const statusR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate/${genId}`, { cookie });
    const scripts = (statusR.body as { scripts: unknown[] }).scripts;
    assert.equal(scripts.length, 0, 'No script should be created on 0-steps failure');
  });

  it('model returns all-invalid steps → salvage → 0 steps → specific error message', async () => {
    setModelCallFn(async () => [
      { kind: 'click' }, // no locator, no text → dropped
      { kind: 'fill', locator: { bad: 'key' }, value: 'x' }, // bad locator → dropped
    ]);

    const genId = await startGeneration(baseUrl, cookie, pid, tpid, 'all invalid test', gid);
    const gen = await pollGeneration(baseUrl, cookie, pid, tpid, genId);

    assert.equal(gen.status, 'failed');
    assert.ok(
      String(gen.error).includes('no usable steps'),
      `Expected specific "no usable steps" message, got: ${gen.error}`,
    );
  });
});

// ── Progress in generations list ──────────────────────────────────────────────

describe('GET /generations — progress, startedAt, createdAt fields', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let tpid: string;
  let gid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    pid = await createProject(baseUrl, cookie);
    tpid = await createTestProject(baseUrl, cookie, pid);
    gid = await createGroup(baseUrl, cookie, pid, tpid);
  });

  after(async () => {
    setModelCallFn(null);
    await cleanup();
  });

  afterEach(() => { setModelCallFn(null); });

  it('completed generation has progress, startedAt and createdAt in list', async () => {
    setModelCallFn(async () => [
      { kind: 'goto', path: '/' },
      { kind: 'assert_url', url: '/' },
    ]);

    const genId = await startGeneration(baseUrl, cookie, pid, tpid, 'progress fields test', gid);
    await pollGeneration(baseUrl, cookie, pid, tpid, genId);

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations`, { cookie });
    assert.equal(r.status, 200);
    const gens = (r.body as { generations: Array<Record<string, unknown>> }).generations;
    const gen = gens.find((g) => g.id === genId);
    assert.ok(gen, 'generation must appear in list');

    assert.ok('progress' in gen, 'progress field must be present');
    assert.ok('startedAt' in gen, 'startedAt field must be present');
    assert.ok('createdAt' in gen, 'createdAt field must be present');
    assert.ok(typeof gen.progress === 'object' && gen.progress !== null, 'progress must be an object');
    assert.ok(typeof gen.createdAt === 'string', 'createdAt must be a string');
    // startedAt should be set (generation ran)
    assert.ok(typeof gen.startedAt === 'string', `startedAt must be a non-null string for a completed generation, got: ${JSON.stringify(gen.startedAt)}`);
    // progress.phase should be 'done' after successful generation
    const progress = gen.progress as Record<string, unknown>;
    assert.equal(progress.phase, 'done', `progress.phase should be 'done', got: ${progress.phase}`);
  });

  it('list response includes all new fields with correct types for seeded rows', async () => {
    const id = generateId();
    dbInsert('test_generations', {
      id,
      test_project_id: tpid,
      script_id: null,
      kind: 'generate',
      description: 'seeded for shape check',
      status: 'done',
      error: null,
      result_script_ids: '[]',
      warnings: '[]',
      created_by: null,
      created_at: now(),
      finished_at: now(),
      started_at: now(),
      progress: JSON.stringify({ phase: 'done', message: 'Done', percent: 100, stepsSoFar: 2 }),
      cancelled_at: null,
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations`, { cookie });
    const gens = (r.body as { generations: Array<Record<string, unknown>> }).generations;
    const gen = gens.find((g) => g.id === id);
    assert.ok(gen, 'seeded generation must appear');

    assert.ok('progress' in gen && typeof gen.progress === 'object');
    assert.ok('startedAt' in gen);
    assert.ok('createdAt' in gen);
    const progress = gen.progress as Record<string, unknown>;
    assert.equal(progress.phase, 'done');
    assert.equal(progress.percent, 100);
    assert.equal(progress.stepsSoFar, 2);
  });
});

// ── Cancel endpoint ───────────────────────────────────────────────────────────

describe('POST /generations/:gid/cancel', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let tpid: string;
  let gid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    pid = await createProject(baseUrl, cookie);
    tpid = await createTestProject(baseUrl, cookie, pid);
    gid = await createGroup(baseUrl, cookie, pid, tpid);
  });

  after(async () => {
    setModelCallFn(null);
    await cleanup();
  });

  afterEach(() => { setModelCallFn(null); });

  it('cancel while pending/running: returns {generation} with status cancelled, no script saved', async () => {
    // Use a slow model that resolves only after cancel is called
    let resolveModel!: (v: unknown) => void;
    const modelPromise = new Promise<unknown>((res) => { resolveModel = res; });

    setModelCallFn(async (_prompt: string, _ctx: ModelCallContext) => {
      return modelPromise;
    });

    const genId = await startGeneration(baseUrl, cookie, pid, tpid, 'cancel test', gid);

    // Give runGeneration a moment to start (it becomes 'running')
    await new Promise((r) => setTimeout(r, 100));

    const cancelR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/${genId}/cancel`, {
      method: 'POST', cookie,
    });
    assert.equal(cancelR.status, 200, `Expected 200 from cancel, got ${cancelR.status}: ${JSON.stringify(cancelR.body)}`);
    const cancelGen = (cancelR.body as { generation: Record<string, unknown> }).generation;
    assert.equal(cancelGen.status, 'cancelled', `Expected cancelled status, got ${cancelGen.status}`);

    // Release the model call (generation would try to save but cancel check prevents it)
    resolveModel([{ kind: 'goto', path: '/' }]);

    // Wait a moment for runGeneration to complete
    await new Promise((r) => setTimeout(r, 300));

    // No script should exist — result was not saved
    const statusR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate/${genId}`, { cookie });
    const scripts = (statusR.body as { scripts: unknown[] }).scripts;
    assert.equal(scripts.length, 0, 'No script must be saved after cancel');
  });

  it('cancel a finished (done) job is a no-op — returns current state', async () => {
    setModelCallFn(async () => [
      { kind: 'goto', path: '/done' },
      { kind: 'assert_url', url: '/done' },
    ]);

    const genId = await startGeneration(baseUrl, cookie, pid, tpid, 'cancel no-op test', gid);
    await pollGeneration(baseUrl, cookie, pid, tpid, genId);

    // Cancel after done
    const cancelR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/${genId}/cancel`, {
      method: 'POST', cookie,
    });
    assert.equal(cancelR.status, 200);
    const cancelGen = (cancelR.body as { generation: Record<string, unknown> }).generation;
    // Should still be 'done' (no-op)
    assert.equal(cancelGen.status, 'done', `Finished generation status must not change on cancel, got: ${cancelGen.status}`);
  });

  it('cancel a failed job is a no-op — returns current failed state', async () => {
    setModelCallFn(async () => { throw new Error('forced model failure'); });

    const genId = await startGeneration(baseUrl, cookie, pid, tpid, 'cancel failed no-op', gid);
    await pollGeneration(baseUrl, cookie, pid, tpid, genId);

    const cancelR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/${genId}/cancel`, {
      method: 'POST', cookie,
    });
    assert.equal(cancelR.status, 200);
    const cancelGen = (cancelR.body as { generation: Record<string, unknown> }).generation;
    assert.equal(cancelGen.status, 'failed', `Failed generation status must not change on cancel, got: ${cancelGen.status}`);
  });

  it('cancel requires tests scope', async () => {
    const { createHash, randomBytes: rb } = await import('node:crypto');
    const stateR = await fetchJson(baseUrl, '/api/auth/state', { cookie });
    const userId = ((stateR.body as Record<string, unknown>).user as Record<string, unknown>).id as string;

    const rawToken = `ap_${rb(16).toString('hex')}`;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    dbInsert('api_tokens', {
      id: generateId(), user_id: userId, name: `no-tests-${Date.now()}`,
      token_hash: tokenHash, prefix: rawToken.slice(0, 10),
      scope: 'read', scopes: JSON.stringify(['read']),
      project_id: null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      created_at: now(),
    });

    const dummyId = generateId();
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/${dummyId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${rawToken}` },
    });
    assert.equal(r.status, 403, `Expected 403 for token without tests scope, got ${r.status}`);
  });

  it('cancel a non-existent generation returns 404', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/${generateId()}/cancel`, {
      method: 'POST', cookie,
    });
    assert.equal(r.status, 404);
  });
});
