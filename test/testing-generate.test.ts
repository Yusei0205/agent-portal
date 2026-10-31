/**
 * Tests for AI generation resilience (F12c):
 *   - retry-then-success: first call invalid, retry returns fully valid steps
 *   - retry-then-partial: first call invalid, retry still has some invalid steps
 *     → partial success with warnings, valid steps kept
 *   - all-invalid-fails: both calls return all-invalid steps → status 'failed'
 *   - repair-case: assert_text missing locator but has text → repaired to {text:}
 *   - fenced-JSON extraction: model output wrapped in ```json fences is accepted
 *   - extractJsonArray unit tests: fences, chatter, plain text
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { setModelCallFn, extractJsonArray } from '../server/testing/index.ts';
import { setBedrockClientFactory } from '../server/testing/model-provider.ts';
import { setSetting } from '../server/settings.ts';
import { getDb, openDb, closeDb, isDbOpen, insert as dbInsert } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BedrockClientLike, BedrockConverseInput } from '../server/testing/model-provider.ts';
import type { ModelCallContext } from '../server/testing/generate.ts';

// ── Shared test setup ─────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string) {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `gen-test-${Date.now()}@example.com`, name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200);
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, adminCookie: string) {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: 'Gen Resilience Project' },
    cookie: adminCookie,
  });
  assert.equal(r.status, 201);
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createTestProject(baseUrl: string, adminCookie: string, projectId: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
    method: 'POST',
    body: { name: 'Gen Resilience Tests', appUrl: 'http://gen-test.example.com' },
    cookie: adminCookie,
  });
  assert.equal(r.status, 201);
  return (r.body as { testProject: { id: string } }).testProject.id;
}

async function createGroup(baseUrl: string, adminCookie: string, projectId: string, tpId: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/groups`, {
    method: 'POST',
    body: { name: 'Gen Group' },
    cookie: adminCookie,
  });
  assert.equal(r.status, 201);
  return (r.body as { group: { id: string } }).group.id;
}

/**
 * Poll the generation status endpoint until terminal state (done/failed).
 * Returns the full generation object from the response.
 */
async function pollGeneration(
  baseUrl: string,
  cookie: string,
  projectId: string,
  tpId: string,
  genId: string,
  maxMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const sr = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/tests/${tpId}/generate/${genId}`,
      { cookie },
    );
    const gen = (sr.body as { generation: Record<string, unknown> }).generation;
    if (gen.status === 'done' || gen.status === 'failed') return gen;
  }
  throw new Error(`Generation did not reach terminal state within ${maxMs}ms`);
}

// ── extractJsonArray unit tests ───────────────────────────────────────────────

describe('extractJsonArray — JSON extraction from model text', () => {
  it('parses a plain JSON array', () => {
    const result = extractJsonArray('[{"kind":"goto","path":"/"}]');
    assert.deepEqual(result, [{ kind: 'goto', path: '/' }]);
  });

  it('extracts JSON array from surrounding prose', () => {
    const text = 'Here are the steps:\n[{"kind":"goto","path":"/"}]\nHope this helps!';
    const result = extractJsonArray(text);
    assert.deepEqual(result, [{ kind: 'goto', path: '/' }]);
  });

  it('extracts from ```json fenced block', () => {
    const text = '```json\n[{"kind":"goto","path":"/login"}]\n```';
    const result = extractJsonArray(text);
    assert.deepEqual(result, [{ kind: 'goto', path: '/login' }]);
  });

  it('extracts from plain ``` fenced block (no language tag)', () => {
    const text = 'Here:\n```\n[{"kind":"assert_url","url":"/dashboard"}]\n```\nDone.';
    const result = extractJsonArray(text);
    assert.deepEqual(result, [{ kind: 'assert_url', url: '/dashboard' }]);
  });

  it('extracts multi-step array from fenced block with leading newline', () => {
    const text = '```json\n[\n  {"kind":"goto","path":"/"}, \n  {"kind":"click","locator":{"css":"button"}}\n]\n```';
    const result = extractJsonArray(text) as unknown[];
    assert.equal(Array.isArray(result), true);
    assert.equal(result.length, 2);
  });

  it('throws when text has no JSON array', () => {
    assert.throws(
      () => extractJsonArray('No JSON here at all.'),
      /did not contain a JSON array/,
    );
  });

  it('throws when fenced block has invalid JSON', () => {
    assert.throws(
      () => extractJsonArray('```json\nnot valid json\n```'),
      /did not contain a JSON array/,
    );
  });
});

// ── Integration tests via HTTP API ────────────────────────────────────────────

describe('AI generation resilience — retry and partial success', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let tpId: string;
  let gid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, adminCookie);
    tpId = await createTestProject(baseUrl, adminCookie, projectId);
    gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
  });

  after(async () => {
    setModelCallFn(null);
    setBedrockClientFactory(null);
    await cleanup();
  });

  beforeEach(() => {
    setModelCallFn(null);
    setBedrockClientFactory(null);
  });

  afterEach(() => {
    setModelCallFn(null);
    setBedrockClientFactory(null);
  });

  // ── Retry → success ─────────────────────────────────────────────────────────

  it('retry-then-success: first call invalid, retry returns valid → done with no warnings', async () => {
    let callCount = 0;
    setModelCallFn(async (_prompt: string, ctx: ModelCallContext) => {
      callCount++;
      if (callCount === 1) {
        // First call: return invalid steps (click without locator)
        return [
          { kind: 'goto', path: '/login' },
          { kind: 'click' }, // invalid — no locator
        ];
      }
      // Retry: return fully valid steps
      return [
        { kind: 'goto', path: '/login' },
        { kind: 'click', locator: { role: 'button', name: 'Sign in' } },
        { kind: 'assert_url', url: '/dashboard' },
      ];
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Retry success test', groupId: gid },
      cookie: adminCookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'done', `Expected done: ${gen.error}`);
    const warnings = gen.warnings as string[];
    assert.ok(Array.isArray(warnings) && warnings.length === 0, `Expected no warnings on clean retry: ${JSON.stringify(warnings)}`);
    assert.equal(callCount, 2, 'Model should have been called exactly twice (first call + one retry)');

    // Verify the script has the valid (retried) steps
    const scripts = (await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/tests/${tpId}/generate/${genId}`,
      { cookie: adminCookie },
    )).body as { scripts: Array<{ steps: unknown[] }> };
    assert.equal(scripts.scripts[0].steps.length, 3, 'Script should have 3 valid steps from retry');
  });

  it('retry-then-success: retry context includes validationErrors field', async () => {
    let retryCtx: ModelCallContext | null = null;
    let callCount = 0;
    setModelCallFn(async (_prompt: string, ctx: ModelCallContext) => {
      callCount++;
      if (callCount === 1) return [{ kind: 'click' }]; // invalid
      retryCtx = ctx;
      return [{ kind: 'goto', path: '/' }]; // valid retry
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Retry ctx check', groupId: gid },
      cookie: adminCookie,
    });
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'done');
    assert.ok(retryCtx !== null, 'Retry call context should have been captured');
    const capturedCtx = retryCtx as ModelCallContext;
    assert.ok(
      Array.isArray(capturedCtx.validationErrors) && capturedCtx.validationErrors.length > 0,
      `Retry context should carry validationErrors, got: ${JSON.stringify(capturedCtx.validationErrors)}`,
    );
  });

  // ── Retry → partial ─────────────────────────────────────────────────────────

  it('retry-then-partial: retry still has invalid steps → done with warnings, valid steps kept', async () => {
    let callCount = 0;
    setModelCallFn(async () => {
      callCount++;
      // Both calls return mixed valid/invalid
      return [
        { kind: 'goto', path: '/home' },          // valid
        { kind: 'click' },                         // invalid — missing locator
        { kind: 'assert_url', url: '/home' },      // valid
        { kind: 'fill', locator: { invalid: true }, value: 'x' }, // invalid locator
      ];
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Partial retry test', groupId: gid },
      cookie: adminCookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'done', `Expected done, got ${gen.status}: ${gen.error}`);

    const warnings = gen.warnings as string[];
    assert.ok(Array.isArray(warnings) && warnings.length > 0, `Expected at least one warning: ${JSON.stringify(warnings)}`);
    // The 2 dropped steps should be mentioned
    const droppedCount = warnings.filter((w) => w.includes('dropped')).length;
    assert.equal(droppedCount, 2, `Expected 2 dropped warnings, got: ${JSON.stringify(warnings)}`);

    // Verify the script only has the valid 2 steps
    const sr = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/tests/${tpId}/generate/${genId}`,
      { cookie: adminCookie },
    );
    const scripts = (sr.body as { scripts: Array<{ steps: unknown[] }> }).scripts;
    assert.equal(scripts.length, 1, 'Should have one script');
    assert.equal(scripts[0].steps.length, 2, `Expected 2 valid steps, got: ${scripts[0].steps.length}`);
  });

  // ── All-invalid → failed ─────────────────────────────────────────────────────

  it('all-invalid-fails: both calls return all-invalid steps → status failed', async () => {
    setModelCallFn(async () => [
      { kind: 'click' },                                          // missing locator, no text
      { kind: 'fill', locator: { invalid: true }, value: 'x' }, // bad locator key, no text
      { kind: 'assert_visible', locator: { other: 'key' } },     // invalid locator, no text
    ]);

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'All invalid test', groupId: gid },
      cookie: adminCookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'failed', `Expected failed status`);
    assert.ok(String(gen.error).includes('invalid steps'), `Expected 'invalid steps' in error: ${gen.error}`);
  });

  it('non-array model output → failed immediately (no retry)', async () => {
    setModelCallFn(async () => ({ kind: 'goto', path: '/' })); // object, not array

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Non-array test', groupId: gid },
      cookie: adminCookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'failed');
    assert.ok(String(gen.error).includes('JSON array'), `Expected array error: ${gen.error}`);
  });

  // ── Repair case ──────────────────────────────────────────────────────────────

  it('repair: assert_text with missing locator but text present → repaired, warning recorded', async () => {
    let callCount = 0;
    setModelCallFn(async () => {
      callCount++;
      return [
        { kind: 'goto', path: '/dashboard' },
        // assert_text with no locator, but text field present — repairable
        { kind: 'assert_text', text: 'Welcome back', exact: false },
        { kind: 'assert_url', url: '/dashboard' },
      ];
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Repair locator test', groupId: gid },
      cookie: adminCookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'done', `Expected done, got ${gen.status}: ${gen.error}`);

    const warnings = gen.warnings as string[];
    assert.ok(Array.isArray(warnings) && warnings.length > 0, `Expected repair warning: ${JSON.stringify(warnings)}`);
    const repairWarnings = warnings.filter((w) => w.includes('repaired'));
    assert.ok(repairWarnings.length > 0, `Expected at least one 'repaired' warning: ${JSON.stringify(warnings)}`);

    // The repaired step should be in the script (3 steps total: goto + assert_text repaired + assert_url)
    const sr = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/tests/${tpId}/generate/${genId}`,
      { cookie: adminCookie },
    );
    const scripts = (sr.body as { scripts: Array<{ steps: unknown[] }> }).scripts;
    assert.equal(scripts[0].steps.length, 3, 'All 3 steps should be present after repair');
  });

  it('repair: click with text but missing locator → repaired, warning recorded', async () => {
    setModelCallFn(async () => [
      // click step missing locator but has text — repairable
      { kind: 'click', text: 'Submit' },
    ]);

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Repair click test', groupId: gid },
      cookie: adminCookie,
    });
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'done', `Expected done: ${gen.error}`);
    const warnings = gen.warnings as string[];
    assert.ok(warnings.some((w) => w.includes('repaired') && w.includes('click')), `Expected repaired click warning: ${JSON.stringify(warnings)}`);
  });

  // ── Fenced JSON via Bedrock mock ──────────────────────────────────────────────

  it('fenced-JSON extraction: model output in ```json fences is accepted', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.region', 'us-east-1');
    setSetting(db, 'bedrock.auth', 'ambient');
    setSetting(db, 'model.sonnet', 'anthropic.claude-3-5-sonnet-20241022-v1:0');

    const fencedResponse = [
      '```json',
      '[',
      '  {"kind":"goto","path":"/login"},',
      '  {"kind":"click","locator":{"role":"button","name":"Sign in"}},',
      '  {"kind":"assert_url","url":"/dashboard"}',
      ']',
      '```',
    ].join('\n');

    setBedrockClientFactory((_region: string, _creds?: unknown): BedrockClientLike => ({
      async converse(_input: BedrockConverseInput) {
        return {
          output: {
            message: {
              content: [{ text: fencedResponse }],
            },
          },
        };
      },
    }));

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Fenced JSON extraction test', groupId: gid },
      cookie: adminCookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'done', `Expected done with fenced JSON, got ${gen.status}: ${gen.error}`);

    const sr = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/tests/${tpId}/generate/${genId}`,
      { cookie: adminCookie },
    );
    const scripts = (sr.body as { scripts: Array<{ steps: unknown[] }> }).scripts;
    assert.equal(scripts[0].steps.length, 3, 'Should have 3 steps extracted from fenced JSON');

    // Cleanup provider settings
    try { setSetting(db, 'provider.mode', 'demo'); } catch { /* ok */ }
    try { setSetting(db, 'model.sonnet', ''); } catch { /* ok */ }
  });

  it('fenced JSON with leading chatter is extracted correctly', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.region', 'us-east-1');
    setSetting(db, 'bedrock.auth', 'ambient');
    setSetting(db, 'model.sonnet', 'anthropic.claude-3-5-sonnet-20241022-v1:0');

    const chatteredResponse = [
      'Here are the test steps for your scenario:',
      '',
      '```json',
      '[{"kind":"goto","path":"/"},{"kind":"assert_url","url":"/"}]',
      '```',
      '',
      'These steps will navigate to the home page and verify the URL.',
    ].join('\n');

    setBedrockClientFactory((_region: string, _creds?: unknown): BedrockClientLike => ({
      async converse(_input: BedrockConverseInput) {
        return { output: { message: { content: [{ text: chatteredResponse }] } } };
      },
    }));

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Chattered fenced JSON test', groupId: gid },
      cookie: adminCookie,
    });
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'done', `Got ${gen.status}: ${gen.error}`);

    // Cleanup
    try { setSetting(db, 'provider.mode', 'demo'); } catch { /* ok */ }
    try { setSetting(db, 'model.sonnet', ''); } catch { /* ok */ }
  });

  // ── API response warnings field ───────────────────────────────────────────────

  it('generation API response includes warnings field (empty array on clean generation)', async () => {
    setModelCallFn(async () => [
      { kind: 'goto', path: '/' },
      { kind: 'assert_url', url: '/' },
    ]);

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Clean generation warnings field test', groupId: gid },
      cookie: adminCookie,
    });
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, adminCookie, projectId, tpId, genId);

    assert.equal(gen.status, 'done');
    assert.ok('warnings' in gen, 'API response generation object must include warnings field');
    assert.ok(Array.isArray(gen.warnings), `warnings must be an array, got: ${typeof gen.warnings}`);
    assert.equal((gen.warnings as string[]).length, 0, 'Clean generation should have zero warnings');
  });
});

// ── GET /generations list endpoint tests ─────────────────────────────────────

describe('GET /generations — list endpoint', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let tpId: string;
  let tpId2: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, adminCookie);
    tpId = await createTestProject(baseUrl, adminCookie, projectId);
    // Second test project for cross-project isolation tests
    const r2 = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
      method: 'POST',
      body: { name: 'Isolation TP', appUrl: 'http://other.example.com' },
      cookie: adminCookie,
    });
    assert.equal(r2.status, 201);
    tpId2 = (r2.body as { testProject: { id: string } }).testProject.id;
  });

  after(async () => {
    setModelCallFn(null);
    setBedrockClientFactory(null);
    await cleanup();
  });

  /** Insert a test_generation row directly into the active in-memory DB. */
  function seedGeneration(testProjectId: string, overrides: Partial<{
    kind: string;
    description: string;
    status: string;
    created_at: string;
    script_id: string | null;
    error: string | null;
  }> = {}): string {
    const id = generateId();
    dbInsert('test_generations', {
      id,
      test_project_id: testProjectId,
      script_id: overrides.script_id ?? null,
      kind: overrides.kind ?? 'generate',
      description: overrides.description ?? 'test description',
      status: overrides.status ?? 'done',
      error: overrides.error ?? null,
      result_script_ids: '[]',
      warnings: '[]',
      created_by: null,
      created_at: overrides.created_at ?? now(),
      finished_at: overrides.status === 'done' || overrides.status === 'failed' ? now() : null,
    });
    return id;
  }

  it('returns empty array when no generations exist', async () => {
    // Use a fresh test project with no generations
    const r0 = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
      method: 'POST',
      body: { name: 'Empty TP', appUrl: 'http://empty.example.com' },
      cookie: adminCookie,
    });
    const emptyTpId = (r0.body as { testProject: { id: string } }).testProject.id;

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${emptyTpId}/generations`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const { generations } = r.body as { generations: unknown[] };
    assert.ok(Array.isArray(generations), 'generations must be an array');
    assert.equal(generations.length, 0, 'should be empty for a fresh test project');
  });

  it('returns generations ordered newest first', async () => {
    const id1 = seedGeneration(tpId, { description: 'oldest', created_at: new Date(Date.now() - 3000).toISOString() });
    const id2 = seedGeneration(tpId, { description: 'middle', created_at: new Date(Date.now() - 2000).toISOString() });
    const id3 = seedGeneration(tpId, { description: 'newest', created_at: new Date(Date.now() - 1000).toISOString() });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const ids = (r.body as { generations: Array<{ id: string }> }).generations.map((g) => g.id);

    const idx1 = ids.indexOf(id1);
    const idx2 = ids.indexOf(id2);
    const idx3 = ids.indexOf(id3);
    assert.ok(idx1 !== -1 && idx2 !== -1 && idx3 !== -1, 'All seeded generations should be present');
    assert.ok(idx3 < idx2, `Newest (${idx3}) should come before middle (${idx2})`);
    assert.ok(idx2 < idx1, `Middle (${idx2}) should come before oldest (${idx1})`);
  });

  it('active=1 returns only pending/running generations', async () => {
    const idDone = seedGeneration(tpId, { description: 'active-done', status: 'done' });
    const idPending = seedGeneration(tpId, { description: 'active-pending', status: 'pending' });
    const idFailed = seedGeneration(tpId, { description: 'active-failed', status: 'failed' });
    const idRunning = seedGeneration(tpId, { description: 'active-running', status: 'running' });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations?active=1`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const gens = (r.body as { generations: Array<{ id: string; status: string }> }).generations;
    const ids = gens.map((g) => g.id);

    assert.ok(ids.includes(idPending), 'pending should be included');
    assert.ok(ids.includes(idRunning), 'running should be included');
    assert.ok(!ids.includes(idDone), 'done should be excluded');
    assert.ok(!ids.includes(idFailed), 'failed should be excluded');
    assert.ok(gens.every((g) => g.status === 'pending' || g.status === 'running'), 'all items must be pending or running');
  });

  it('limit parameter caps results (default 20, max 50)', async () => {
    // Seed 5 additional rows to ensure we can test limit=3
    for (let i = 0; i < 5; i++) {
      seedGeneration(tpId, { description: `limit-test-${i}` });
    }

    const r3 = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations?limit=3`, { cookie: adminCookie });
    assert.equal(r3.status, 200);
    const gens3 = (r3.body as { generations: unknown[] }).generations;
    assert.ok(gens3.length <= 3, `Expected at most 3 with limit=3, got ${gens3.length}`);

    // Limit of 999 should be clamped to 50
    const r50 = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations?limit=999`, { cookie: adminCookie });
    assert.equal(r50.status, 200);
    const gens50 = (r50.body as { generations: unknown[] }).generations;
    assert.ok(gens50.length <= 50, `Expected at most 50 (capped), got ${gens50.length}`);
  });

  it('cross-project isolation: only returns generations for the requested test project', async () => {
    const otherId = seedGeneration(tpId2, { description: 'other-project-gen', status: 'done' });
    const ownId = seedGeneration(tpId, { description: 'own-project-gen', status: 'done' });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const ids = (r.body as { generations: Array<{ id: string }> }).generations.map((g) => g.id);

    assert.ok(ids.includes(ownId), 'Own test project generation must be present');
    assert.ok(!ids.includes(otherId), 'Other test project generation must NOT appear');
  });

  it('description is truncated to 200 chars in the response', async () => {
    const longDesc = 'a'.repeat(300);
    const id = seedGeneration(tpId, { description: longDesc });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const gens = (r.body as { generations: Array<{ id: string; description: string | null }> }).generations;
    const gen = gens.find((g) => g.id === id);
    assert.ok(gen, 'Generation must be found');
    assert.ok(
      gen.description !== null && gen.description.length <= 200,
      `description must be <= 200 chars, got ${gen.description?.length}`,
    );
  });

  it('response items include all required fields with correct types', async () => {
    const id = seedGeneration(tpId, { description: 'shape-check', status: 'done', kind: 'refine' });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const gens = (r.body as { generations: Array<Record<string, unknown>> }).generations;
    const gen = gens.find((g) => g.id === id);
    assert.ok(gen, 'Generation must be found');

    const requiredFields = ['id', 'kind', 'description', 'status', 'error', 'warnings', 'scriptId', 'resultScriptIds', 'createdBy', 'createdAt', 'finishedAt'];
    for (const field of requiredFields) {
      assert.ok(field in gen, `Field '${field}' must be present in response`);
    }
    assert.ok(Array.isArray(gen.warnings), `warnings must be an array, got ${typeof gen.warnings}`);
    assert.ok(Array.isArray(gen.resultScriptIds), `resultScriptIds must be an array, got ${typeof gen.resultScriptIds}`);
  });

  it('unauthenticated request returns 401', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations`);
    assert.equal(r.status, 401);
  });

  it('API token without read scope returns 403', async () => {
    // The token creation endpoint always includes 'read', so to test the guard
    // we insert a token directly into the DB without 'read' in its scopes.
    const stateR = await fetchJson(baseUrl, '/api/auth/state', { cookie: adminCookie });
    const userId = ((stateR.body as Record<string, unknown>).user as Record<string, unknown>).id as string;

    const { createHash, randomBytes: rb } = await import('node:crypto');
    const rawToken = `ap_${rb(16).toString('hex')}`;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const tokenId = generateId();
    dbInsert('api_tokens', {
      id: tokenId,
      user_id: userId,
      name: `no-read-scope-${Date.now()}`,
      token_hash: tokenHash,
      prefix: rawToken.slice(0, 10),
      scope: 'read',
      scopes: JSON.stringify(['tests']), // deliberately omit 'read'
      project_id: null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      created_at: now(),
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations`, {
      headers: { 'Authorization': `Bearer ${rawToken}` },
    });
    assert.equal(r.status, 403, `Expected 403 for token without read scope, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('API token with read scope returns 200', async () => {
    const tokenR = await fetchJson(baseUrl, '/api/api-tokens', {
      method: 'POST',
      body: { name: `list-gen-read-${Date.now()}`, scopes: ['read'] },
      cookie: adminCookie,
    });
    assert.equal(tokenR.status, 201);
    const token = (tokenR.body as Record<string, unknown>).token as string;

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generations`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    assert.equal(r.status, 200, `Expected 200 for token with read scope, got ${r.status}`);
  });
});

// ── test_generations startup recovery tests ───────────────────────────────────

describe('test_generations startup recovery — stuck jobs marked failed on DB open', () => {
  let tmpDir: string;
  let tmpDbPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-gen-recov-'));
    tmpDbPath = path.join(tmpDir, 'recov.db');
    // Bootstrap the schema by opening and closing without any rows
    openDb(tmpDbPath);
    closeDb();
  });

  after(() => {
    if (isDbOpen()) closeDb();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /** Seed pending/running/done generations, close DB (simulating crash), return their IDs. */
  function seedStuckGenerations(): { pendingId: string; runningId: string; doneId: string } {
    openDb(tmpDbPath);
    const db2 = getDb();
    const ts = now();

    const projectRowId = generateId();
    db2.prepare(
      `INSERT INTO projects (id, slug, name, description, notes, created_at) VALUES (?,?,?,?,?,?)`,
    ).run(projectRowId, `slug-${projectRowId}`, 'Recovery Project', '', '', ts);

    const tpRowId = generateId();
    db2.prepare(
      `INSERT INTO test_projects (id, project_id, name, app_url, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run(tpRowId, projectRowId, 'Recovery TP', 'http://example.com', ts, ts);

    const pendingId = generateId();
    const runningId = generateId();
    const doneId = generateId();

    db2.prepare(
      `INSERT INTO test_generations (id, test_project_id, kind, description, status, created_at)
       VALUES (?,?,'generate','recovery-pending','pending',?)`,
    ).run(pendingId, tpRowId, ts);

    db2.prepare(
      `INSERT INTO test_generations (id, test_project_id, kind, description, status, created_at)
       VALUES (?,?,'generate','recovery-running','running',?)`,
    ).run(runningId, tpRowId, ts);

    db2.prepare(
      `INSERT INTO test_generations (id, test_project_id, kind, description, status, created_at, finished_at)
       VALUES (?,?,'generate','recovery-done','done',?,?)`,
    ).run(doneId, tpRowId, ts, ts);

    closeDb(); // simulate crash — rows are persisted, process ends
    return { pendingId, runningId, doneId };
  }

  it('pending → failed with restart error message on reopening DB', () => {
    const { pendingId, runningId, doneId } = seedStuckGenerations();

    // Reopen the DB — triggers the startup recovery block
    const db2 = openDb(tmpDbPath);

    type GenRow = { status: string; error: string | null };
    const pending = db2.prepare('SELECT status, error FROM test_generations WHERE id = ?').get(pendingId) as GenRow | undefined;
    const running = db2.prepare('SELECT status, error FROM test_generations WHERE id = ?').get(runningId) as GenRow | undefined;
    const done    = db2.prepare('SELECT status, error FROM test_generations WHERE id = ?').get(doneId)    as GenRow | undefined;

    closeDb();

    assert.equal(pending?.status, 'failed', 'pending generation must be flipped to failed on restart');
    assert.equal(running?.status, 'failed', 'running generation must be flipped to failed on restart');
    assert.ok(
      String(pending?.error ?? '').toLowerCase().includes('restart'),
      `pending error must mention restart, got: ${pending?.error}`,
    );
    assert.ok(
      String(running?.error ?? '').toLowerCase().includes('restart'),
      `running error must mention restart, got: ${running?.error}`,
    );
    assert.equal(done?.status, 'done', 'done generation must remain done (not touched by recovery)');
  });
});
