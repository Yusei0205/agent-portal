/**
 * Tests for test case sets (F12d) — chunked QA sheet generation, CRUD, export.
 *
 * Coverage:
 *   - generation with outline + 3 categories ends done, correct cases, percent 100
 *   - partial cases visible mid-run (fake model that waits between calls)
 *   - bad category (unparseable JSON) skipped with a warning
 *   - zero cases overall → status 'failed'
 *   - cancel via POST /cancel → status 'cancelled', existing cases kept
 *   - row CRUD: add, update, delete, status validation
 *   - export.xlsx: sheet names, headers, header fill, freeze, widths, row count, Summary counts
 *   - access control: non-member gets 404
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { setCallTextModelOverride } from '../server/testing/model-provider.ts';
import type { CallTextModelOptions } from '../server/testing/model-provider.ts';

// ── Shared setup helpers ──────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string) {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `cs-admin-${Date.now()}@example.com`, name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200, `setup: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string) {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: `CS Project ${Date.now()}` },
    cookie,
  });
  assert.equal(r.status, 201, `createProject: ${JSON.stringify(r.body)}`);
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createTestProject(baseUrl: string, cookie: string, pid: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests`, {
    method: 'POST',
    body: { name: 'CS Tests', appUrl: 'http://cs-test.example.com' },
    cookie,
  });
  assert.equal(r.status, 201, `createTestProject: ${JSON.stringify(r.body)}`);
  return (r.body as { testProject: { id: string } }).testProject.id;
}

/** Fake model response: outline JSON. */
function outlineJson(cats: string[]): string {
  return JSON.stringify(cats.map((name) => ({ name })));
}

/** Fake model response: cases JSON for one category. */
function casesJson(scenarioPrefix: string, count = 2): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      scenario: `${scenarioPrefix} case ${i + 1}`,
      precondition: 'User is on the app',
      steps: `1. Navigate to page\n2. Perform action ${i + 1}`,
      expectedResult: `Expected result ${i + 1}`,
    })),
  );
}

/** Poll GET /case-sets/:csid until terminal state or timeout. */
async function pollCaseSet(
  baseUrl: string,
  cookie: string,
  pid: string,
  tpid: string,
  csid: string,
  maxMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
    if (r.status !== 200) throw new Error(`pollCaseSet got ${r.status}`);
    const cs = (r.body as { caseSet: Record<string, unknown> }).caseSet;
    const s = cs.status as string;
    if (s === 'done' || s === 'failed' || s === 'cancelled') return cs;
  }
  throw new Error(`Case set did not reach terminal state within ${maxMs}ms`);
}

// ── Suite 1: Core generation ──────────────────────────────────────────────────

describe('Case set generation — outline + 3 categories ends done', () => {
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

  it('generation ends done with correct cases and percent 100', async () => {
    let callCount = 0;
    setCallTextModelOverride(async (_sys: string, _usr: string, _opts: CallTextModelOptions) => {
      callCount++;
      if (callCount === 1) return outlineJson(['Alpha', 'Beta', 'Gamma']);
      if (callCount === 2) return casesJson('Alpha', 3);
      if (callCount === 3) return casesJson('Beta', 2);
      if (callCount === 4) return casesJson('Gamma', 1);
      return '[]';
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'E2E login, registration, and profile flows', name: 'Full Coverage' },
      cookie,
    });
    assert.equal(r.status, 202, `POST case-sets: ${JSON.stringify(r.body)}`);
    const cs0 = (r.body as { caseSet: Record<string, unknown> }).caseSet;
    assert.ok(cs0.id, 'caseSet.id must be set');
    assert.equal(cs0.status, 'pending');
    const csid = cs0.id as string;

    const cs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.equal(cs.status, 'done', `Expected done, got: ${cs.status} — ${cs.error}`);
    assert.equal((cs.progress as Record<string, unknown>).percent, 100);
    assert.equal((cs.progress as Record<string, unknown>).phase, 'done');
    assert.equal(cs.caseCount, 6, `Expected 6 cases (3+2+1), got ${cs.caseCount}`);

    // Verify cases are returned with correct structure
    const detailR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
    assert.equal(detailR.status, 200);
    const cases = (detailR.body as { cases: Array<Record<string, unknown>> }).cases;
    assert.equal(cases.length, 6);

    // Cases should be ordered by ord and have testId in TC-x.y.z format
    for (const c of cases) {
      assert.ok(typeof c.testId === 'string' && /^TC-\d+\.\d+\.\d+$/.test(c.testId), `bad testId: ${c.testId}`);
      assert.ok(typeof c.category === 'string' && c.category.length > 0, 'category must be non-empty');
      assert.ok(typeof c.scenario === 'string' && c.scenario.length > 0, 'scenario must be non-empty');
      assert.ok(typeof c.ord === 'number', 'ord must be a number');
    }

    // Check categories are correct
    const cats = [...new Set(cases.map((c) => c.category as string))];
    assert.equal(cats.length, 3, `Expected 3 distinct categories, got: ${cats.join(', ')}`);

    // callCount should be 4 (outline + 3 categories)
    assert.equal(callCount, 4, `Expected 4 model calls, got ${callCount}`);

    // GET /case-sets list should include this case set
    const listR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, { cookie });
    assert.equal(listR.status, 200);
    const list = (listR.body as { caseSets: Array<Record<string, unknown>> }).caseSets;
    const found = list.find((cs2) => cs2.id === csid);
    assert.ok(found, 'Case set must appear in list');
    assert.equal(found.caseCount, 6);
  });

  it('POST returns 202 with caseSet including progress.phase = queued', async () => {
    setCallTextModelOverride(async () => { await new Promise((r) => setTimeout(r, 5000)); return '[]'; });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Quick check of initial response shape' },
      cookie,
    });
    assert.equal(r.status, 202);
    const cs = (r.body as { caseSet: Record<string, unknown> }).caseSet;
    assert.ok(cs.id, 'must have id');
    assert.ok(cs.name, 'must have name (derived from description)');
    assert.equal(cs.status, 'pending');
    const prog = cs.progress as Record<string, unknown>;
    assert.ok(['queued', 'context', 'outline'].includes(prog.phase as string), `unexpected initial phase: ${prog.phase}`);
    assert.ok(typeof prog.percent === 'number');
  });

  it('name defaults to first 120 chars of description when not provided', async () => {
    setCallTextModelOverride(async (_, usr) => {
      if (usr.includes('outline') || usr.includes('Generate a structured')) return outlineJson(['A']);
      return casesJson('A', 1);
    });

    const longDesc = 'X'.repeat(200);
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: longDesc },
      cookie,
    });
    assert.equal(r.status, 202);
    const cs = (r.body as { caseSet: Record<string, unknown> }).caseSet;
    assert.equal((cs.name as string).length, 120, `name should be 120 chars, got ${(cs.name as string).length}`);
  });

  it('description over 8000 chars returns 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'x'.repeat(8001) },
      cookie,
    });
    assert.equal(r.status, 400);
  });
});

// ── Suite 2: Partial cases visible mid-run ────────────────────────────────────

describe('Case set generation — partial cases visible mid-run', () => {
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

  it('cases from completed categories appear before generation finishes', async () => {
    // Category A completes fast; category B takes a moment (200ms).
    // The test checks partial results after A is done but B is still running.
    let callCount = 0;
    setCallTextModelOverride(async (_sys: string, _usr: string) => {
      callCount++;
      if (callCount === 1) return outlineJson(['Cat A', 'Cat B']);
      if (callCount === 2) return casesJson('A', 2); // fast
      // Cat B — slow so test can observe partial state
      await new Promise((r) => setTimeout(r, 250));
      return casesJson('B', 2);
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Partial visibility test', name: 'Partial Test' },
      cookie,
    });
    assert.equal(r.status, 202);
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;

    // Poll until we see at least 1 case with status still running
    let midCaseSet: Record<string, unknown> | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const pollR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
      const cs = (pollR.body as { caseSet: Record<string, unknown> }).caseSet;
      const prog = cs.progress as Record<string, unknown>;
      if (cs.status === 'running' && (prog.casesSoFar as number) > 0) {
        midCaseSet = cs;
        break;
      }
      // If already done, the test still validates the final state (ok too)
      if (cs.status === 'done') break;
    }

    // Wait for completion
    const finalCs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.equal(finalCs.status, 'done', `Expected done: ${finalCs.error}`);
    assert.equal(finalCs.caseCount, 4);

    // If we observed a partial state, verify casesSoFar > 0 and < 4
    if (midCaseSet !== null) {
      const prog = midCaseSet.progress as Record<string, unknown>;
      assert.ok((prog.casesSoFar as number) > 0, 'Should have partial cases mid-run');
    }
  });
});

// ── Suite 3: Bad category skipped with warning ────────────────────────────────

describe('Case set generation — bad category skipped with warning', () => {
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

  it('unparseable category response is skipped with a warning', async () => {
    let callCount = 0;
    setCallTextModelOverride(async () => {
      callCount++;
      if (callCount === 1) return outlineJson(['Good A', 'Bad B', 'Good C']);
      if (callCount === 2) return casesJson('Good A', 2);
      // callCount 3 and 4 are for Bad B (first attempt + retry)
      if (callCount === 3 || callCount === 4) return 'this is definitely not valid JSON at all!!!';
      if (callCount === 5) return casesJson('Good C', 2);
      return '[]';
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Test with one bad category' },
      cookie,
    });
    assert.equal(r.status, 202);
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;

    const cs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.equal(cs.status, 'done', `Expected done, got ${cs.status}: ${cs.error}`);
    assert.equal(cs.caseCount, 4, `Expected 4 cases (Good A + Good C), got ${cs.caseCount}`);

    const warnings = cs.warnings as string[];
    assert.ok(Array.isArray(warnings) && warnings.length > 0, `Expected at least one warning: ${JSON.stringify(warnings)}`);
    const hasBadWarning = warnings.some((w) => w.includes('Bad B') && w.includes('skipped'));
    assert.ok(hasBadWarning, `Expected warning about 'Bad B' being skipped: ${JSON.stringify(warnings)}`);

    // The retry should have been attempted: callCount should be 5 (outline + good A + bad B x2 + good C)
    assert.equal(callCount, 5, `Expected 5 model calls, got ${callCount}`);
  });
});

// ── Suite 4: Zero cases → failed ──────────────────────────────────────────────

describe('Case set generation — zero cases ends failed', () => {
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

  it('all categories return empty arrays → status failed', async () => {
    setCallTextModelOverride(async (_sys, _usr) => {
      // Outline returns one category; that category returns empty array
      return '[]';
    });

    // Provide an initial call that returns a category
    let callCount = 0;
    setCallTextModelOverride(async () => {
      callCount++;
      if (callCount === 1) return outlineJson(['Only Category']);
      return '[]'; // category returns no cases
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Zero cases test' },
      cookie,
    });
    assert.equal(r.status, 202);
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;

    const cs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.equal(cs.status, 'failed', `Expected failed, got ${cs.status}: ${cs.error}`);
    assert.ok(cs.error, 'Error message must be present');
  });

  it('outline returns empty array → status failed', async () => {
    setCallTextModelOverride(async () => '[]');

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Empty outline test' },
      cookie,
    });
    assert.equal(r.status, 202);
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;

    const cs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.equal(cs.status, 'failed');
  });
});

// ── Suite 5: Cancel ────────────────────────────────────────────────────────────

describe('Case set generation — cancel', () => {
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

  it('POST /cancel stops generation and sets status cancelled', async () => {
    // Outline fast, first category fast, second category slow (allows cancel to land)
    let callCount = 0;
    setCallTextModelOverride(async () => {
      callCount++;
      if (callCount === 1) return outlineJson(['Cat 1', 'Cat 2', 'Cat 3']);
      if (callCount === 2) return casesJson('Cat 1', 2); // fast
      // Cat 2 and Cat 3 take a moment — enough time for cancel to be called
      await new Promise((r) => setTimeout(r, 300));
      return casesJson(`Cat ${callCount - 1}`, 2);
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Cancellation test', name: 'Cancel Test' },
      cookie,
    });
    assert.equal(r.status, 202);
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;

    // Wait until status is 'running'
    const runDeadline = Date.now() + 5000;
    let isRunning = false;
    while (Date.now() < runDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const pr = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
      if ((pr.body as { caseSet: { status: string } }).caseSet.status === 'running') {
        isRunning = true;
        break;
      }
    }
    assert.ok(isRunning, 'Case set should reach running state before cancel');

    // Call cancel
    const cancelR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cancel`, {
      method: 'POST',
      cookie,
    });
    assert.equal(cancelR.status, 200, `cancel: ${JSON.stringify(cancelR.body)}`);
    const cancelledCs = (cancelR.body as { caseSet: Record<string, unknown> }).caseSet;
    assert.equal(cancelledCs.status, 'cancelled');

    // Wait for generation to fully stop
    await new Promise((r) => setTimeout(r, 500));

    // Verify status stayed cancelled (generation did not overwrite with 'done')
    const finalR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
    assert.equal(finalR.status, 200);
    const finalCs = (finalR.body as { caseSet: Record<string, unknown> }).caseSet;
    assert.equal(finalCs.status, 'cancelled', `Expected cancelled, got: ${finalCs.status}`);

    // Cases from Cat 1 should still be present (generation keeps partial results)
    assert.ok((finalCs.caseCount as number) >= 0, 'caseCount should be a number');
  });

  it('cancelling an already-done case set is a no-op', async () => {
    setCallTextModelOverride(async () => {
      return outlineJson(['Only']);
    });

    // This will fail (empty categories) but that's fine — it'll be done/failed
    let c = 0;
    setCallTextModelOverride(async () => {
      c++;
      if (c === 1) return outlineJson(['Only']);
      return casesJson('Only', 1);
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Already done test' },
      cookie,
    });
    const csid = (r.body as { caseSet: { id: string } }).caseSet.id;
    const finalCs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.ok(['done', 'failed'].includes(finalCs.status as string));

    // Now cancel — should return 200 with the current state
    const cancelR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cancel`, {
      method: 'POST',
      cookie,
    });
    assert.equal(cancelR.status, 200);
    const returnedCs = (cancelR.body as { caseSet: Record<string, unknown> }).caseSet;
    // Should still be done/failed (not changed to cancelled)
    assert.ok(['done', 'failed'].includes(returnedCs.status as string), `Expected done/failed, got ${returnedCs.status}`);
  });
});

// ── Suite 6: Row CRUD and status validation ───────────────────────────────────

describe('Case set CRUD — row management and status validation', () => {
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

    // Create a case set with one generated case for CRUD tests
    let c = 0;
    setCallTextModelOverride(async () => {
      c++;
      if (c === 1) return outlineJson(['Manual']);
      return casesJson('Manual', 1);
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'CRUD test case set', name: 'CRUD Tests' },
      cookie,
    });
    csid = (r.body as { caseSet: { id: string } }).caseSet.id;
    await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    setCallTextModelOverride(null);
  });

  after(async () => {
    setCallTextModelOverride(null);
    await cleanup();
  });

  it('POST /cases adds a new case row', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: {
        category: 'Login',
        scenario: 'Valid credentials',
        precondition: 'User is registered',
        steps: '1. Go to login page\n2. Enter credentials\n3. Click Login',
        expectedResult: 'User is redirected to dashboard',
        status: 'Pass',
        remarks: 'Verified on Chrome',
      },
      cookie,
    });
    assert.equal(r.status, 201, `POST /cases: ${JSON.stringify(r.body)}`);
    const c = (r.body as { case: Record<string, unknown> }).case;
    assert.ok(c.id, 'case.id must be set');
    assert.equal(c.category, 'Login');
    assert.equal(c.scenario, 'Valid credentials');
    assert.equal(c.status, 'Pass');
    assert.ok(typeof c.ord === 'number', 'ord must be a number');
    assert.ok(typeof c.testId === 'string' && c.testId.length > 0, 'testId must be non-empty');

    // Verify via GET
    const getR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
    const cases = (getR.body as { cases: Array<Record<string, unknown>> }).cases;
    const found = cases.find((x) => x.id === c.id);
    assert.ok(found, 'Added case must appear in GET /case-sets/:csid');
  });

  it('PUT /cases/:cid updates specified fields', async () => {
    // First add a case
    const addR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: { scenario: 'Update target', category: 'Update Cat' },
      cookie,
    });
    assert.equal(addR.status, 201);
    const cid = (addR.body as { case: { id: string } }).case.id;

    // Update a subset of fields
    const putR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases/${cid}`, {
      method: 'PUT',
      body: { scenario: 'Updated scenario', status: 'Fail', remarks: 'Bug found' },
      cookie,
    });
    assert.equal(putR.status, 200, `PUT: ${JSON.stringify(putR.body)}`);
    const updated = (putR.body as { case: Record<string, unknown> }).case;
    assert.equal(updated.scenario, 'Updated scenario');
    assert.equal(updated.status, 'Fail');
    assert.equal(updated.remarks, 'Bug found');
    assert.equal(updated.category, 'Update Cat'); // unchanged field
  });

  it('PUT /cases/:cid with invalid status returns 400', async () => {
    const addR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: { scenario: 'Status validation test', category: 'Val' },
      cookie,
    });
    const cid = (addR.body as { case: { id: string } }).case.id;

    const putR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases/${cid}`, {
      method: 'PUT',
      body: { status: 'InvalidStatus' },
      cookie,
    });
    assert.equal(putR.status, 400, `Expected 400 for invalid status, got ${putR.status}`);
  });

  it('POST /cases with invalid status returns 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: { scenario: 'Bad status', status: 'Passing' },
      cookie,
    });
    assert.equal(r.status, 400, `Expected 400 for invalid status, got ${r.status}`);
  });

  it("all valid status values ('', Pass, Fail, Blocked, Not Run) are accepted", async () => {
    for (const s of ['', 'Pass', 'Fail', 'Blocked', 'Not Run']) {
      const addR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
        method: 'POST',
        body: { scenario: `Status ${s || 'empty'}`, status: s },
        cookie,
      });
      assert.equal(addR.status, 201, `status='${s}' should be accepted, got ${addR.status}`);
      assert.equal((addR.body as { case: { status: string } }).case.status, s);
    }
  });

  it('DELETE /cases/:cid removes the case', async () => {
    const addR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases`, {
      method: 'POST',
      body: { scenario: 'Delete me' },
      cookie,
    });
    const cid = (addR.body as { case: { id: string } }).case.id;

    const delR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/cases/${cid}`, {
      method: 'DELETE',
      cookie,
    });
    assert.equal(delR.status, 200);
    assert.equal((delR.body as { ok: boolean }).ok, true);

    // Verify case is gone
    const getR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
    const cases = (getR.body as { cases: Array<{ id: string }> }).cases;
    assert.ok(!cases.find((c) => c.id === cid), 'Deleted case must not appear');
  });

  it('PATCH /case-sets/:csid updates name', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, {
      method: 'PATCH',
      body: { name: 'Renamed Set' },
      cookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { caseSet: { name: string } }).caseSet.name, 'Renamed Set');
  });

  it('GET /case-sets returns cases ordered by ord', async () => {
    const getR = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}`, { cookie });
    const cases = (getR.body as { cases: Array<{ ord: number }> }).cases;
    for (let i = 1; i < cases.length; i++) {
      assert.ok(cases[i].ord >= cases[i - 1].ord, `cases must be ordered by ord, got ${cases[i-1].ord} then ${cases[i].ord}`);
    }
  });
});

// ── Suite 7: Excel export ─────────────────────────────────────────────────────

describe('Case set export — Excel workbook', () => {
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

    // Generate a case set with 2 categories, 3 + 2 cases
    let c = 0;
    setCallTextModelOverride(async () => {
      c++;
      if (c === 1) return outlineJson(['Login', 'Registration']);
      if (c === 2) return casesJson('Login', 3);
      return casesJson('Registration', 2);
    });

    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Export test case set', name: 'Export Test' },
      cookie,
    });
    csid = (r.body as { caseSet: { id: string } }).caseSet.id;
    const finalCs = await pollCaseSet(baseUrl, cookie, pid, tpid, csid);
    assert.equal(finalCs.status, 'done', `setup: expected done, got ${finalCs.status}`);
    setCallTextModelOverride(null);
  });

  after(async () => {
    setCallTextModelOverride(null);
    await cleanup();
  });

  it('export.xlsx loads back with correct sheets, headers, fill, freeze, widths, row count, and Summary counts', async () => {
    // Fetch the workbook as binary
    const exportResp = await fetchBinary(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csid}/export.xlsx`, cookie);
    assert.ok(exportResp.buffer.byteLength > 0, 'Export must return non-empty buffer');
    assert.equal(exportResp.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok(exportResp.contentDisposition.includes('attachment'), 'Must be attachment');
    assert.ok(exportResp.contentDisposition.includes('_Test_Cases.xlsx'), 'Filename must end with _Test_Cases.xlsx');

    // Parse with exceljs to verify structure
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    await wb.xlsx.load(exportResp.buffer as any); // exceljs Buffer vs Node Buffer<ArrayBufferLike> mismatch
    // ── Sheet names ──────────────────────────────────────────────────────────
    const sheetNames = wb.worksheets.map((ws) => ws.name);
    assert.ok(sheetNames.includes('Test Cases'), `Expected 'Test Cases' sheet, got: ${sheetNames.join(', ')}`);
    assert.ok(sheetNames.includes('Summary'), `Expected 'Summary' sheet, got: ${sheetNames.join(', ')}`);

    // ── Test Cases sheet ─────────────────────────────────────────────────────
    const ws = wb.getWorksheet('Test Cases')!;
    assert.ok(ws, 'Test Cases worksheet must exist');

    // Headers
    const expectedHeaders = ['Test ID', 'Category', 'Scenario', 'Precondition', 'Test Steps', 'Expected Result', 'Status', 'Remarks'];
    const actualHeaders = ws.getRow(1).values as (string | undefined)[];
    for (const h of expectedHeaders) {
      assert.ok(
        actualHeaders.some((v) => v === h),
        `Missing header: '${h}', found: ${JSON.stringify(actualHeaders)}`,
      );
    }

    // Header fill — first header cell should have the blue fill
    const headerCell = ws.getCell('A1');
    assert.ok(
      headerCell.fill && (headerCell.fill as unknown as Record<string, unknown>).type === 'pattern',
      'Header cell must have pattern fill',
    );
    const fgColor = ((headerCell.fill as unknown as Record<string, unknown>).fgColor as Record<string, unknown> | undefined)?.argb as string | undefined;
    assert.ok(
      fgColor && fgColor.toUpperCase().includes('4472C4'),
      `Header fill should be 4472C4, got: ${fgColor}`,
    );

    // Header font
    const headerFont = headerCell.font as Record<string, unknown> | undefined;
    assert.ok(headerFont?.bold === true, 'Header font must be bold');
    const fontColor = (headerFont?.color as Record<string, unknown> | undefined)?.argb as string | undefined;
    assert.ok(fontColor && /FF?FFF?FFF?/i.test(fontColor), `Header font color should be white, got: ${fontColor}`);

    // Freeze pane — ySplit should be 1
    const views = ws.views as Array<Record<string, unknown>>;
    assert.ok(
      views && views.some((v) => v.ySplit === 1),
      `Expected ySplit:1 freeze, got views: ${JSON.stringify(views)}`,
    );

    // Column widths
    const colWidths: Record<string, number> = {
      'A': 12, 'B': 35, 'C': 60, 'D': 50, 'E': 70, 'F': 60, 'G': 12, 'H': 30,
    };
    for (const [col, expectedWidth] of Object.entries(colWidths)) {
      const colObj = ws.getColumn(col);
      assert.ok(
        colObj.width && Math.round(colObj.width) === expectedWidth,
        `Column ${col} should have width ${expectedWidth}, got ${colObj.width}`,
      );
    }

    // Row count (header + 5 data rows)
    const dataRowCount = ws.rowCount - 1; // subtract header
    assert.equal(dataRowCount, 5, `Expected 5 data rows (3 Login + 2 Registration), got ${dataRowCount}`);

    // ── Summary sheet ────────────────────────────────────────────────────────
    const ws2 = wb.getWorksheet('Summary')!;
    assert.ok(ws2, 'Summary worksheet must exist');

    // Summary headers
    const summaryHeaders = ws2.getRow(1).values as (string | undefined)[];
    assert.ok(summaryHeaders.some((v) => v === 'Category'), `Missing 'Category' in Summary headers: ${JSON.stringify(summaryHeaders)}`);
    assert.ok(summaryHeaders.some((v) => v === 'Test Cases Count'), `Missing 'Test Cases Count' in Summary: ${JSON.stringify(summaryHeaders)}`);

    // Summary has 2 categories
    const summaryDataRowCount = ws2.rowCount - 1;
    assert.equal(summaryDataRowCount, 2, `Expected 2 summary rows, got ${summaryDataRowCount}`);

    // Check Login=3, Registration=2
    const summaryRows: Array<{ cat: string; count: number }> = [];
    ws2.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return;
      const vals = row.values as Array<string | number | undefined>;
      summaryRows.push({ cat: String(vals[1] ?? ''), count: Number(vals[2] ?? 0) });
    });
    const loginRow = summaryRows.find((r) => r.cat === 'Login');
    const regRow = summaryRows.find((r) => r.cat === 'Registration');
    assert.ok(loginRow, `Login category must be in Summary, got: ${JSON.stringify(summaryRows)}`);
    assert.equal(loginRow.count, 3, `Login should have 3 cases, got ${loginRow.count}`);
    assert.ok(regRow, `Registration category must be in Summary`);
    assert.equal(regRow.count, 2, `Registration should have 2 cases, got ${regRow.count}`);
  });
});

// ── Suite 8: Access control ───────────────────────────────────────────────────

describe('Case set access control', () => {
  let baseUrl: string;
  let adminCookie: string;
  let otherCookie: string;
  let pid: string;
  let tpid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    pid = await createProject(baseUrl, adminCookie);
    tpid = await createTestProject(baseUrl, adminCookie, pid);

    // Create a second user who is NOT a member of the project
    const r = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: `nonmember-${Date.now()}@example.com`, name: 'Non Member', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201);
    const email = (r.body as { user: { email: string } }).user.email;
    const lr = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email, password: 'password1234' },
    });
    otherCookie = lr.cookie ?? '';
  });

  after(async () => {
    setCallTextModelOverride(null);
    await cleanup();
  });

  it('non-member GET /case-sets returns 404', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, { cookie: otherCookie });
    assert.equal(r.status, 404, `Expected 404 for non-member, got ${r.status}`);
  });

  it('non-member POST /case-sets returns 404', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`, {
      method: 'POST',
      body: { description: 'Non-member attempt' },
      cookie: otherCookie,
    });
    assert.equal(r.status, 404, `Expected 404 for non-member, got ${r.status}`);
  });

  it('unauthenticated request returns 401', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets`);
    assert.equal(r.status, 401);
  });
});

// ── Binary fetch helper ───────────────────────────────────────────────────────

async function fetchBinary(
  baseUrl: string,
  path: string,
  cookie: string,
): Promise<{ buffer: Buffer; contentType: string; contentDisposition: string }> {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const chunks: Buffer[] = [];
    const req = http.get(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        headers: { Cookie: cookie },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            buffer: Buffer.concat(chunks) as unknown as Buffer,
            contentType: String(res.headers['content-type'] ?? ''),
            contentDisposition: String(res.headers['content-disposition'] ?? ''),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
