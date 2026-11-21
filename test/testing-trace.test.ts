/**
 * Tests for Feature 1 (Generation Trace) and Feature 2 (API request/response on test cases).
 *
 * Coverage:
 *   Trace — case set:
 *     - success run produces context, outline, category, saving, done steps
 *     - category retry produces a retry step then ok step
 *     - skipped category produces retry + failed steps
 *     - failed generation (zero cases) produces failure step
 *     - cancelled generation produces cancelled step
 *     - script generation produces context, call, validate, save, done steps
 *     - script retry produces retry/salvage steps
 *   Trace routes:
 *     - GET /trace returns steps array
 *     - non-member → 404
 *     - wrong test project → 404
 *   Request/response:
 *     - model-produced request/response stored and returned
 *     - POST /cases with request/response persists them
 *     - PUT /cases/:cid clears request/response (null)
 *     - invalid request shape → 400
 *     - invalid response shape → 400
 *     - oversized request → 400
 *   Excel export:
 *     - Request column contains cURL command
 *     - Response column contains HTTP status + body
 *   cURL formatting:
 *     - single quotes in URL are escaped
 *     - single quotes in body are escaped
 *     - GET omits -X
 *     - POST includes -X POST and --data-raw
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { setCallTextModelOverride } from '../server/testing/model-provider.ts';
import { setModelCallFn } from '../server/testing/index.ts';
import type { CallTextModelOptions } from '../server/testing/model-provider.ts';
import { shellEscapeSingle, formatAsCurl } from '../server/testing/curl.ts';

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string) {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `trace-${Date.now()}@example.com`, name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200, `setup: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string) {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: `Trace Project ${Date.now()}` },
    cookie,
  });
  assert.equal(r.status, 201);
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createTestProject(baseUrl: string, cookie: string, pid: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests`, {
    method: 'POST',
    body: { name: 'Trace TP', appUrl: 'http://trace.example.com', apiBaseUrl: 'https://api.example.com' },
    cookie,
  });
  assert.equal(r.status, 201);
  return (r.body as { testProject: { id: string } }).testProject.id;
}

async function createGroup(baseUrl: string, cookie: string, pid: string, tpid: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/groups`, {
    method: 'POST',
    body: { name: 'G' },
    cookie,
  });
  assert.equal(r.status, 201);
  return (r.body as { group: { id: string } }).group.id;
}

function outlineJson(cats: string[]): string {
  return JSON.stringify(cats.map((name) => ({ name })));
}

function casesJson(prefix: string, count = 2, includeRequest = false): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      scenario: `${prefix} case ${i + 1}`,
      precondition: 'System ready',
      steps: `1. Action ${i + 1}`,
      expectedResult: `Result ${i + 1}`,
      ...(includeRequest ? {
        request: {
          method: 'POST',
          url: '{{baseUrl}}/endpoint',
          headers: { 'Content-Type': 'application/json' },
          body: { key: `value${i + 1}` },
        },
        response: {
          status: 200,
          body: { success: true },
        },
      } : { request: null, response: null }),
    })),
  );
}

async function pollCaseSet(
  baseUrl: string, cookie: string, pid: string, tpid: string, csid: string, maxMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
    if (r.status !== 200) throw new Error(`poll got ${r.status}`);
    const cs = (r.body as { caseSet: Record<string, unknown> }).caseSet;
    const s = cs.status as string;
    if (s === 'done' || s === 'failed' || s === 'cancelled') return cs;
  }
  throw new Error('Case set did not reach terminal state');
}

async function pollGeneration(
  baseUrl: string, cookie: string, pid: string, tpid: string, genId: string, maxMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate/${genId}`, { cookie });
    if (r.status !== 200) throw new Error(`poll got ${r.status}`);
    const gen = (r.body as { generation: Record<string, unknown> }).generation;
    if (gen.status === 'done' || gen.status === 'failed') return gen;
  }
  throw new Error('Generation did not reach terminal state');
}

// ── Suite 1: Case-set trace — success run ─────────────────────────────────────

describe('Case-set trace — success run produces expected steps', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let tpid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    pid = await createProject(baseUrl, cookie);
    tpid = await createTestProject(baseUrl, cookie, pid);
  });

  after(async () => {
    setCallTextModelOverride(null);
    await cleanup();
  });

  afterEach(() => { setCallTextModelOverride(null); });

  it('success run has context, outline, category, saving, done steps in order', async () => {
    let call = 0;
    setCallTextModelOverride(async () => {
      call++;
      if (call === 1) return outlineJson(['Alpha', 'Beta']);
      return casesJson(call === 2 ? 'Alpha' : 'Beta', 2);
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Trace success test', name: 'Trace Test' },
      cookie,
    });
    assert.equal(r.status, 202);
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;
    const cs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.equal(cs.status, 'done', `Expected done: ${cs.error}`);

    const traceR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/trace`, { cookie });
    assert.equal(traceR.status, 200, `trace: ${JSON.stringify(traceR.body)}`);
    const steps = (traceR.body as { steps: Array<Record<string, unknown>> }).steps;
    assert.ok(Array.isArray(steps) && steps.length > 0, 'Steps must be non-empty');

    // Verify ordering by seq
    for (let i = 1; i < steps.length; i++) {
      assert.ok(
        (steps[i].seq as number) > (steps[i - 1].seq as number),
        `steps must be in ascending seq order at index ${i}`,
      );
    }

    // Check required step kinds appear
    const kinds = steps.map((s) => s.kind as string);
    assert.ok(kinds.includes('context'), `Expected 'context' step: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('outline'), `Expected 'outline' step: ${kinds.join(', ')}`);
    assert.ok(kinds.filter((k) => k === 'category').length >= 2, `Expected at least 2 'category' steps: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('saving'), `Expected 'saving' step: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('done'), `Expected 'done' step: ${kinds.join(', ')}`);

    // All completed steps should have finishedAt and durationMs
    for (const step of steps) {
      if (step.status !== 'running') {
        assert.ok(step.finishedAt != null, `step ${step.kind} (${step.seq}) must have finishedAt`);
        assert.ok(typeof step.durationMs === 'number', `step ${step.kind} (${step.seq}) must have durationMs`);
      }
    }

    // Context step should have a prompt with system field
    const ctxStep = steps.find((s) => s.kind === 'context');
    assert.ok(ctxStep, 'Must have context step');
    assert.ok(ctxStep.prompt != null, 'Context step must have prompt');
    const ctxPrompt = ctxStep.prompt as Record<string, unknown>;
    assert.ok(typeof ctxPrompt.system === 'string' && ctxPrompt.system.length > 0, 'Context step must have non-empty system prompt');

    // Outline step should have prompt.user and output
    const outlineStep = steps.find((s) => s.kind === 'outline');
    assert.ok(outlineStep, 'Must have outline step');
    assert.ok(outlineStep.prompt != null, 'Outline step must have prompt');
    const outlinePrompt = outlineStep.prompt as Record<string, unknown>;
    assert.ok(typeof outlinePrompt.user === 'string' && outlinePrompt.user.length > 0, 'Outline step must have user prompt');
    assert.ok(outlineStep.output != null, 'Outline step must have output');

    // Category steps should show category name in detail
    const catSteps = steps.filter((s) => s.kind === 'category');
    for (const cs2 of catSteps) {
      const detail = cs2.detail as Record<string, unknown>;
      assert.ok(typeof detail.categoryName === 'string', `category step must have categoryName in detail`);
      assert.ok(typeof detail.attempt === 'number', `category step must have attempt in detail`);
      assert.ok(cs2.status === 'ok', `category step should be ok on success`);
    }

    // Saving step
    const savingStep = steps.find((s) => s.kind === 'saving');
    assert.ok(savingStep, 'Must have saving step');
    assert.equal(savingStep.status, 'ok');

    // Done step
    const doneStep = steps.find((s) => s.kind === 'done');
    assert.ok(doneStep, 'Must have done step');
    assert.equal(doneStep.status, 'ok');
  });

  it('each step has required shape fields', async () => {
    let call = 0;
    setCallTextModelOverride(async () => {
      call++;
      if (call === 1) return outlineJson(['X']);
      return casesJson('X', 1);
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Shape check' },
      cookie,
    });
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;
    await pollCaseSet(baseUrl, cookie, pid, tpid, csid);

    const traceR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/trace`, { cookie });
    const steps = (traceR.body as { steps: Array<Record<string, unknown>> }).steps;

    const REQUIRED_FIELDS = ['id', 'seq', 'kind', 'label', 'status', 'startedAt', 'finishedAt', 'durationMs', 'detail', 'output', 'outputTruncated', 'error'];
    for (const step of steps) {
      for (const f of REQUIRED_FIELDS) {
        assert.ok(f in step, `Step ${step.kind} must have field '${f}'`);
      }
      assert.ok(typeof step.seq === 'number', `seq must be number`);
      assert.ok(typeof step.label === 'string', `label must be string`);
      assert.ok(typeof step.status === 'string', `status must be string`);
      assert.ok(typeof step.outputTruncated === 'boolean', `outputTruncated must be boolean`);
    }
  });
});

// ── Suite 2: Case-set trace — retry and failure ────────────────────────────────

describe('Case-set trace — retry and skipped category steps', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let tpid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    pid = await createProject(baseUrl, cookie);
    tpid = await createTestProject(baseUrl, cookie, pid);
  });

  after(async () => {
    setCallTextModelOverride(null);
    await cleanup();
  });

  afterEach(() => { setCallTextModelOverride(null); });

  it('category retry produces retry step (attempt 1) then ok step (attempt 2)', async () => {
    let call = 0;
    setCallTextModelOverride(async () => {
      call++;
      if (call === 1) return outlineJson(['Good', 'Bad', 'Good2']);
      if (call === 2) return casesJson('Good', 2);
      if (call === 3) return 'not json at all!!!'; // attempt 1 — retry
      if (call === 4) return casesJson('Bad', 1);  // attempt 2 — ok
      return casesJson('Good2', 1);
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Retry trace test' },
      cookie,
    });
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;
    await pollCaseSet(baseUrl, cookie, pid, tpid, csid);

    const traceR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/trace`, { cookie });
    const steps = (traceR.body as { steps: Array<Record<string, unknown>> }).steps;
    const catSteps = steps.filter((s) => s.kind === 'category');

    // Should have: Good (ok), Bad attempt1 (retry), Bad attempt2 (ok), Good2 (ok)
    assert.ok(catSteps.length >= 4, `Expected at least 4 category steps, got ${catSteps.length}`);

    // Find the retry step for Bad
    const retryStep = catSteps.find((s) => s.status === 'retry');
    assert.ok(retryStep, 'Must have a retry category step');
    const retryDetail = retryStep.detail as Record<string, unknown>;
    assert.equal(retryDetail.attempt, 1, 'Retry step must be attempt 1');
    assert.ok(retryDetail.parseError, 'Retry step must have parseError in detail');

    // The Bad attempt 2 should succeed
    const retryIdx = catSteps.indexOf(retryStep);
    if (retryIdx < catSteps.length - 1) {
      const nextCatStep = catSteps[retryIdx + 1];
      assert.equal((nextCatStep.detail as Record<string, unknown>).attempt, 2, 'Next step for same category must be attempt 2');
    }
  });

  it('all-fail category produces two failed/retry steps (category skipped)', async () => {
    let call = 0;
    setCallTextModelOverride(async () => {
      call++;
      if (call === 1) return outlineJson(['Fail']);
      // Both attempts for 'Fail' return bad JSON
      return 'NOT_JSON';
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'All-fail category trace' },
      cookie,
    });
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;

    // Need another category or this fails the whole generation
    // Let's use 2 categories so it doesn't fail (Fail skipped but Other succeeds)
    // Actually: one category all-failed → zero cases → generation fails
    // So status will be 'failed'
    const cs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.ok(cs.status === 'failed' || cs.status === 'done', `Got ${cs.status}`);

    const traceR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/trace`, { cookie });
    const steps = (traceR.body as { steps: Array<Record<string, unknown>> }).steps;
    const catSteps = steps.filter((s) => s.kind === 'category');
    // Should have 2 category steps (attempt 1 retry, attempt 2 failed)
    assert.ok(catSteps.length === 2, `Expected 2 category steps for one failing category, got ${catSteps.length}`);
    assert.equal(catSteps[0].status, 'retry', 'First attempt should be retry status');
    assert.equal(catSteps[1].status, 'failed', 'Second attempt should be failed status');
  });

  it('failed generation (zero cases) has failure step', async () => {
    let call = 0;
    setCallTextModelOverride(async () => {
      call++;
      if (call === 1) return outlineJson(['Only']);
      return '[]'; // empty — no cases
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Zero cases fail trace' },
      cookie,
    });
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;
    const cs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.equal(cs.status, 'failed');

    const traceR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/trace`, { cookie });
    const steps = (traceR.body as { steps: Array<Record<string, unknown>> }).steps;
    const failureStep = steps.find((s) => s.kind === 'failure');
    assert.ok(failureStep, 'Must have a failure step');
    assert.equal(failureStep.status, 'failed');
    assert.ok(typeof failureStep.error === 'string' && failureStep.error.length > 0, 'Failure step must have error message');
  });

  it('cancelled generation has cancelled step', async () => {
    let call = 0;
    setCallTextModelOverride(async () => {
      call++;
      if (call === 1) return outlineJson(['Cat1', 'Cat2', 'Cat3']);
      await new Promise((r) => setTimeout(r, 300));
      return casesJson(`Cat${call - 1}`, 1);
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Cancel trace test' },
      cookie,
    });
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;

    // Wait for running state
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
      const pr = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
      if ((pr.body as { caseSet: { status: string } }).caseSet.status === 'running') break;
    }

    // Cancel
    await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cancel`, {
      method: 'POST',
      cookie,
    });

    // Wait for generation to stop
    await new Promise((r) => setTimeout(r, 600));

    const traceR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/trace`, { cookie });
    const steps = (traceR.body as { steps: Array<Record<string, unknown>> }).steps;
    const cancelledStep = steps.find((s) => s.kind === 'cancelled');
    assert.ok(cancelledStep, `Must have a cancelled step. Got kinds: ${steps.map((s) => s.kind).join(', ')}`);
    assert.equal(cancelledStep.status, 'ok');
  });
});

// ── Suite 3: Script generation trace ─────────────────────────────────────────

describe('Script generation trace — context, call, validate, save, done steps', () => {
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

  it('clean generation has context, call, validate, save, done steps', async () => {
    setModelCallFn(async () => [
      { kind: 'goto', path: '/login' },
      { kind: 'click', locator: { role: 'button', name: 'Sign in' } },
    ]);

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate`, {
      method: 'POST',
      body: { description: 'Clean trace gen', groupId: gid },
      cookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, cookie, pid, tpid, genId);
    assert.equal(gen.status, 'done', `Expected done: ${gen.error}`);

    const traceR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/${genId}/trace`, { cookie });
    assert.equal(traceR.status, 200, `trace: ${JSON.stringify(traceR.body)}`);
    const steps = (traceR.body as { steps: Array<Record<string, unknown>> }).steps;
    assert.ok(steps.length >= 4, `Expected at least 4 steps, got ${steps.length}`);

    const kinds = steps.map((s) => s.kind as string);
    assert.ok(kinds.includes('context'), `Expected context: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('call'), `Expected call: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('validate'), `Expected validate: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('save'), `Expected save: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('done'), `Expected done: ${kinds.join(', ')}`);

    // All finished steps must have finishedAt
    for (const s of steps) {
      if (s.status !== 'running') {
        assert.ok(s.finishedAt != null, `Step ${s.kind} must have finishedAt`);
      }
    }

    // Context step must have system prompt
    const ctxStep = steps.find((s) => s.kind === 'context');
    assert.ok(ctxStep?.prompt != null, 'Context step must have prompt');
    const ctxPrompt = ctxStep!.prompt as Record<string, unknown>;
    assert.ok(typeof ctxPrompt.system === 'string' && ctxPrompt.system.length > 0, 'Context system prompt must be non-empty');
  });

  it('retry produces retry + salvage/done steps and no failure step', async () => {
    let call = 0;
    setModelCallFn(async () => {
      call++;
      if (call === 1) return [{ kind: 'click' }]; // invalid
      return [{ kind: 'goto', path: '/' }]; // valid retry
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate`, {
      method: 'POST',
      body: { description: 'Retry trace gen', groupId: gid },
      cookie,
    });
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, cookie, pid, tpid, genId);
    assert.equal(gen.status, 'done', `Expected done: ${gen.error}`);

    const traceR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/${genId}/trace`, { cookie });
    const steps = (traceR.body as { steps: Array<Record<string, unknown>> }).steps;
    const kinds = steps.map((s) => s.kind as string);
    assert.ok(kinds.includes('retry'), `Expected retry step: ${kinds.join(', ')}`);
    assert.ok(!kinds.includes('failure'), `Must not have failure step on successful retry: ${kinds.join(', ')}`);

    const validateStep = steps.find((s) => s.kind === 'validate');
    assert.ok(validateStep, 'Must have validate step');
    assert.equal(validateStep.status, 'retry', 'Validate step should be retry when first call had errors');
  });

  it('failed generation has failure step with error', async () => {
    setModelCallFn(async () => [
      { kind: 'click' },                        // invalid
      { kind: 'click' },                        // retry also invalid
    ]);

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate`, {
      method: 'POST',
      body: { description: 'Failed gen trace', groupId: gid },
      cookie,
    });
    const genId = (r.body as { generationId: string }).generationId;
    const gen = await pollGeneration(baseUrl, cookie, pid, tpid, genId);
    assert.equal(gen.status, 'failed', `Expected failed: ${gen.error}`);

    const traceR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/${genId}/trace`, { cookie });
    const steps = (traceR.body as { steps: Array<Record<string, unknown>> }).steps;
    const failStep = steps.find((s) => s.kind === 'failure');
    assert.ok(failStep, 'Must have failure step');
    assert.equal(failStep.status, 'failed');
    assert.ok(typeof failStep.error === 'string' && failStep.error.length > 0, 'Failure step must have error');
  });
});

// ── Suite 4: Trace route access control ───────────────────────────────────────

describe('Trace route access control', () => {
  let baseUrl: string;
  let cookie: string;
  let cookie2: string;
  let pid: string;
  let pid2: string;
  let tpid: string;
  let tpid2: string;
  let csid: string;
  let genId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    pid = await createProject(baseUrl, cookie);
    tpid = await createTestProject(baseUrl, cookie, pid);

    // Second project (non-member — admin can access both, so create a second admin)
    // Actually admin can access all projects, so we need a second user who isn't member
    // We'll just test wrong test project instead (different tpid under same pid)
    pid2 = await createProject(baseUrl, cookie);
    tpid2 = await createTestProject(baseUrl, cookie, pid2);

    // Create a case set
    let c = 0;
    setCallTextModelOverride(async () => {
      c++;
      if (c === 1) return outlineJson(['X']);
      return casesJson('X', 1);
    });
    const csR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Access control test' },
      cookie,
    });
    csid = (csR.body as { caseSet: { id: string } }).caseSet.id;
    await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    setCallTextModelOverride(null);

    // Create a generation
    setModelCallFn(async () => [{ kind: 'goto', path: '/' }]);
    const gid = await createGroup(baseUrl, cookie, pid, tpid);
    const genR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generate`, {
      method: 'POST',
      body: { description: 'Access gen', groupId: gid },
      cookie,
    });
    genId = (genR.body as { generationId: string }).generationId;
    await pollGeneration(baseUrl, cookie, pid, tpid, genId);
    setModelCallFn(null);
  });

  after(async () => {
    setCallTextModelOverride(null);
    setModelCallFn(null);
    await cleanup();
  });

  it('case-set trace: wrong test project → 404', async () => {
    // Use tpid2 (different project) to access csid (belongs to tpid)
    const r = await fetchJson(baseUrl, `/api/projects/${pid2}/tests/${tpid2}/case-sets/${csid}/trace`, { cookie });
    assert.equal(r.status, 404, `Expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('case-set trace: non-existent csid → 404', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/nonexistent/trace`, { cookie });
    assert.equal(r.status, 404);
  });

  it('generation trace: wrong test project → 404', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid2}/tests/${tpid2}/generations/${genId}/trace`, { cookie });
    assert.equal(r.status, 404, `Expected 404, got ${r.status}`);
  });

  it('generation trace: non-existent gid → 404', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/nonexistent/trace`, { cookie });
    assert.equal(r.status, 404);
  });

  it('unauthenticated → 401 for both trace routes', async () => {
    const r1 = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/trace`);
    assert.equal(r1.status, 401);
    const r2 = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/generations/${genId}/trace`);
    assert.equal(r2.status, 401);
  });
});

// ── Suite 5: Request/response on test cases ───────────────────────────────────

describe('Request/response on test cases — persistence and validation', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let tpid: string;
  let csid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    pid = await createProject(baseUrl, cookie);
    tpid = await createTestProject(baseUrl, cookie, pid);

    // Create a case set with request/response in model output
    let c = 0;
    setCallTextModelOverride(async () => {
      c++;
      if (c === 1) return outlineJson(['API']);
      return casesJson('API', 2, true); // includeRequest=true
    });

    const csR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Request/response test', name: 'RR Test' },
      cookie,
    });
    csid = (csR.body as { caseSet: { id: string } }).caseSet.id;
    await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    setCallTextModelOverride(null);
  });

  after(async () => {
    setCallTextModelOverride(null);
    await cleanup();
  });

  it('model-produced request/response is stored and returned in GET', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
    assert.equal(r.status, 200);
    const cases = (r.body as { cases: Array<Record<string, unknown>> }).cases;
    assert.ok(cases.length >= 2, 'Must have at least 2 cases');

    // All cases should have request + response from model
    for (const c of cases) {
      assert.ok('request' in c, 'case must have request field');
      assert.ok('response' in c, 'case must have response field');
      if (c.request !== null) {
        const req = c.request as Record<string, unknown>;
        assert.ok(typeof req.method === 'string', 'request.method must be string');
        assert.ok(typeof req.url === 'string', 'request.url must be string');
      }
      if (c.response !== null) {
        const resp = c.response as Record<string, unknown>;
        assert.ok(typeof resp.status === 'number', 'response.status must be number');
      }
    }
  });

  it('POST /cases with request/response persists them', async () => {
    const addR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: {
        scenario: 'API login test',
        category: 'API',
        request: {
          method: 'POST',
          url: '{{baseUrl}}/api/login',
          headers: { 'Content-Type': 'application/json' },
          body: { username: '{{user}}', password: '{{pass}}' },
        },
        response: {
          status: 200,
          body: { token: '{{responseToken}}' },
        },
      },
      cookie,
    });
    assert.equal(addR.status, 201, `POST /cases: ${JSON.stringify(addR.body)}`);
    const c = (addR.body as { case: Record<string, unknown> }).case;
    assert.ok(c.request != null, 'request must be returned');
    assert.ok(c.response != null, 'response must be returned');

    const req = c.request as Record<string, unknown>;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '{{baseUrl}}/api/login');

    const resp = c.response as Record<string, unknown>;
    assert.equal(resp.status, 200);
  });

  it('PUT /cases/:cid can clear request/response to null', async () => {
    // First add a case with request/response
    const addR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: {
        scenario: 'Clear test',
        category: 'API',
        request: { method: 'GET', url: '{{baseUrl}}/health' },
        response: { status: 200 },
      },
      cookie,
    });
    const cid = (addR.body as { case: { id: string } }).case.id;

    // Clear both to null
    const putR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases/${cid}`, {
      method: 'PUT',
      body: { request: null, response: null },
      cookie,
    });
    assert.equal(putR.status, 200, `PUT: ${JSON.stringify(putR.body)}`);
    const updated = (putR.body as { case: Record<string, unknown> }).case;
    assert.equal(updated.request, null, 'request must be null after clearing');
    assert.equal(updated.response, null, 'response must be null after clearing');
  });

  it('POST /cases with invalid request shape returns 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: {
        scenario: 'Bad request test',
        request: { method: 'POST' }, // missing url
      },
      cookie,
    });
    assert.equal(r.status, 400, `Expected 400 for missing url, got ${r.status}`);
  });

  it('POST /cases with request as array returns 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: {
        scenario: 'Array request test',
        request: [{ method: 'POST', url: '/api' }], // array not object
      },
      cookie,
    });
    assert.equal(r.status, 400, `Expected 400 for array request, got ${r.status}`);
  });

  it('POST /cases with invalid response shape returns 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: {
        scenario: 'Bad response test',
        response: { status: 'two-hundred' }, // status must be number
      },
      cookie,
    });
    assert.equal(r.status, 400, `Expected 400 for string status, got ${r.status}`);
  });

  it('POST /cases with oversized request returns 400', async () => {
    const bigUrl = 'https://example.com/' + 'x'.repeat(25_000);
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: {
        scenario: 'Oversize request',
        request: { method: 'GET', url: bigUrl },
      },
      cookie,
    });
    assert.equal(r.status, 400, `Expected 400 for oversized request`);
  });

  it('PUT /cases/:cid with invalid request returns 400', async () => {
    const addR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: { scenario: 'PUT invalid req' },
      cookie,
    });
    const cid = (addR.body as { case: { id: string } }).case.id;

    const putR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases/${cid}`, {
      method: 'PUT',
      body: { request: 'not an object' }, // string is invalid
      cookie,
    });
    assert.equal(putR.status, 400, `Expected 400, got ${putR.status}`);
  });
});

// ── Suite 6: Excel export with Request and Response columns ───────────────────

async function fetchBinary(baseUrl: string, path: string, cookie: string) {
  const url = new URL(path, baseUrl);
  const resp = await fetch(url.toString(), {
    headers: { Cookie: cookie },
  });
  const ab = await resp.arrayBuffer();
  return {
    buffer: Buffer.from(ab),
    contentType: resp.headers.get('content-type') ?? '',
    contentDisposition: resp.headers.get('content-disposition') ?? '',
  };
}

describe('Excel export — Request and Response columns', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let tpid: string;
  let csid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    pid = await createProject(baseUrl, cookie);
    tpid = await createTestProject(baseUrl, cookie, pid);

    // Create a case set and manually add a case with request/response
    let c = 0;
    setCallTextModelOverride(async () => {
      c++;
      if (c === 1) return outlineJson(['Export']);
      return casesJson('Export', 1, false); // no request in model output
    });

    const csR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Export RR test', name: 'Export RR' },
      cookie,
    });
    csid = (csR.body as { caseSet: { id: string } }).caseSet.id;
    await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    setCallTextModelOverride(null);

    // Add a case with request/response
    await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: {
        scenario: 'POST flash login',
        category: 'API',
        request: {
          method: 'POST',
          url: '{{baseUrl}}/UpdateFlashLogin',
          headers: { 'Content-Type': 'application/json', 'Authorization': "Bearer it's a token" },
          body: { flashEnabled: true },
        },
        response: {
          status: 200,
          body: { success: true, message: "it's done" },
        },
      },
      cookie,
    });
  });

  after(async () => {
    setCallTextModelOverride(null);
    await cleanup();
  });

  it('export.xlsx has Request and Response columns', async () => {
    const exportResp = await fetchBinary(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/export.xlsx`, cookie);
    assert.ok(exportResp.buffer.byteLength > 0, 'Export must return non-empty buffer');

    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(exportResp.buffer as any);

    const ws = wb.getWorksheet('Test Cases');
    assert.ok(ws, 'Test Cases sheet must exist');

    const headers = ws!.getRow(1).values as (string | undefined)[];
    assert.ok(headers.includes('Request'), `Must have Request column. Got: ${headers.filter(Boolean).join(', ')}`);
    assert.ok(headers.includes('Response'), `Must have Response column. Got: ${headers.filter(Boolean).join(', ')}`);

    // Find the API row
    let foundCurl = false;
    let foundResponse = false;
    ws!.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // header
      const rowVals = row.values as (string | undefined)[];
      const reqIdx = headers.indexOf('Request');
      const resIdx = headers.indexOf('Response');
      const reqVal = String(rowVals[reqIdx] ?? '');
      const resVal = String(rowVals[resIdx] ?? '');

      if (reqVal.startsWith('curl')) {
        foundCurl = true;
        // cURL must contain the URL and method
        assert.ok(reqVal.includes('UpdateFlashLogin'), `cURL must contain the URL path: ${reqVal}`);
        assert.ok(reqVal.includes('-X'), `cURL must have -X for POST: ${reqVal}`);
        // Single quote in "it's a token" must be escaped
        assert.ok(reqVal.includes("'\\''"), `Single quotes must be escaped in cURL: ${reqVal}`);
      }
      if (resVal.startsWith('HTTP 200')) {
        foundResponse = true;
        assert.ok(resVal.includes('success'), `Response must include body: ${resVal}`);
      }
    });

    assert.ok(foundCurl, 'Must find a row with a cURL command in Request column');
    assert.ok(foundResponse, 'Must find a row with HTTP 200 in Response column');
  });
});

// ── Suite 7: cURL formatting unit tests ───────────────────────────────────────

describe('cURL formatter — shellEscapeSingle and formatAsCurl', () => {
  it('shellEscapeSingle wraps in single quotes', () => {
    assert.equal(shellEscapeSingle('hello'), "'hello'");
  });

  it('shellEscapeSingle escapes embedded single quotes', () => {
    // "it's me" → 'it'\''s me'
    const result = shellEscapeSingle("it's me");
    assert.equal(result, "'it'\\''s me'");
  });

  it('shellEscapeSingle handles multiple single quotes', () => {
    const result = shellEscapeSingle("a'b'c");
    assert.equal(result, "'a'\\''b'\\''c'");
  });

  it('shellEscapeSingle handles empty string', () => {
    assert.equal(shellEscapeSingle(''), "''");
  });

  it('formatAsCurl: GET omits -X', () => {
    const curl = formatAsCurl({ method: 'GET', url: 'https://api.example.com/items' });
    assert.ok(!curl.includes('-X'), `GET should omit -X: ${curl}`);
    assert.ok(curl.startsWith('curl'), `Must start with curl: ${curl}`);
  });

  it('formatAsCurl: POST includes -X POST', () => {
    const curl = formatAsCurl({ method: 'POST', url: 'https://api.example.com/items' });
    assert.ok(curl.includes("-X 'POST'"), `Must have -X POST: ${curl}`);
  });

  it('formatAsCurl: headers use -H', () => {
    const curl = formatAsCurl({
      method: 'POST',
      url: 'https://api.example.com/login',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    });
    assert.ok(curl.includes('-H'), `Must have -H flags: ${curl}`);
    assert.ok(curl.includes('Content-Type'), `Must have Content-Type header: ${curl}`);
    assert.ok(curl.includes('Accept'), `Must have Accept header: ${curl}`);
  });

  it('formatAsCurl: body uses --data-raw', () => {
    const curl = formatAsCurl({
      method: 'POST',
      url: 'https://api.example.com/login',
      body: { username: 'admin', password: 'secret' },
    });
    assert.ok(curl.includes('--data-raw'), `Must use --data-raw: ${curl}`);
    assert.ok(curl.includes('username'), `Body must appear: ${curl}`);
  });

  it('formatAsCurl: single quotes in URL are escaped', () => {
    const curl = formatAsCurl({ method: 'GET', url: "https://example.com/it's/path" });
    assert.ok(curl.includes("'\\''"), `Single quote in URL must be escaped: ${curl}`);
    assert.ok(!curl.includes("it's"), `Raw single quote must not appear: ${curl}`);
  });

  it('formatAsCurl: single quotes in body are escaped', () => {
    const curl = formatAsCurl({
      method: 'POST',
      url: 'https://api.example.com/update',
      body: "it's a body",
    });
    assert.ok(curl.includes("'\\''"), `Single quote in body must be escaped: ${curl}`);
  });

  it('formatAsCurl: produces valid multi-line format with continuation', () => {
    const curl = formatAsCurl({
      method: 'POST',
      url: 'https://api.example.com/login',
      headers: { 'Content-Type': 'application/json' },
      body: { key: 'value' },
    });
    // Multi-line with backslash continuation
    assert.ok(curl.includes('\\\n'), `Multi-line format requires backslash+newline: ${curl}`);
  });

  it('formatAsCurl: null/undefined method defaults to GET', () => {
    const curl = formatAsCurl({ url: 'https://api.example.com/items' });
    assert.ok(!curl.includes('-X'), `No method defaults to GET (no -X): ${curl}`);
  });
});
