/**
 * P10 Code Review tests.
 *
 * Tests:
 *   - POST /api/projects/:id/reviews creates review + workflow
 *   - GET  /api/projects/:id/reviews returns reviews
 *   - processReviewOutput creates finding rows from structured agent output
 *   - PUT  .../findings/:fid accepts a finding (sets accepted=1)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { processReviewOutput } from '../server/review.ts';
import { openDb, closeDb, isDbOpen, one, all, run, insert } from '../server/db.ts';
import type { DatabaseSync } from 'node:sqlite';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: {
      email: `admin-review-${Date.now()}@example.com`,
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

// ── POST /api/projects/:id/reviews ────────────────────────────────────────────

describe('POST /api/projects/:id/reviews', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'Review Test Project');
  });

  after(async () => { await cleanup(); });

  it('creates a review with minimal body', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, {
      method: 'POST',
      body: { baseRef: 'main', headRef: 'feature/test' },
      cookie,
    });
    assert.equal(r.status, 201);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.review, 'should return a review');
    const review = body.review as Record<string, unknown>;
    assert.equal(review.base_ref, 'main');
    assert.equal(review.head_ref, 'feature/test');
    assert.equal(review.status, 'pending');
    assert.equal(review.post_mode, 'draft');
    assert.equal(review.min_severity, 'medium');
    assert.ok(review.id, 'should have an id');
    assert.ok(review.workflow_id, 'should create a workflow');
  });

  it('creates a review with prNumber and postMode=auto', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, {
      method: 'POST',
      body: { baseRef: 'main', headRef: 'pr/42', prNumber: 42, postMode: 'auto', minSeverity: 'high' },
      cookie,
    });
    assert.equal(r.status, 201);
    const review = (r.body as Record<string, unknown>).review as Record<string, unknown>;
    assert.equal(review.pr_number, 42);
    assert.equal(review.post_mode, 'auto');
    assert.equal(review.min_severity, 'high');
  });

  it('returns 400 when baseRef is missing', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, {
      method: 'POST',
      body: { headRef: 'feature/test' },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('returns 400 when headRef is missing', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, {
      method: 'POST',
      body: { baseRef: 'main' },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('returns 401 when not authenticated', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, {
      method: 'POST',
      body: { baseRef: 'main', headRef: 'feature/test' },
    });
    assert.equal(r.status, 401);
  });
});

// ── GET /api/projects/:id/reviews ─────────────────────────────────────────────

describe('GET /api/projects/:id/reviews', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'Review List Project');

    // Create a couple of reviews
    await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, {
      method: 'POST',
      body: { baseRef: 'main', headRef: 'branch-1' },
      cookie,
    });
    await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, {
      method: 'POST',
      body: { baseRef: 'main', headRef: 'branch-2' },
      cookie,
    });
  });

  after(async () => { await cleanup(); });

  it('lists reviews for the project', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.reviews), 'should return reviews array');
    assert.ok((body.reviews as unknown[]).length >= 2, 'should have at least 2 reviews');
  });

  it('includes finding_count in each review', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, { cookie });
    const reviews = (r.body as Record<string, unknown>).reviews as Record<string, unknown>[];
    for (const rev of reviews) {
      assert.ok(rev.finding_count !== undefined, 'should include finding_count');
    }
  });

  it('returns 404 for unknown project', async () => {
    const r = await fetchJson(baseUrl, '/api/projects/unknown-project/reviews', { cookie });
    assert.equal(r.status, 404);
  });
});

// ── processReviewOutput ────────────────────────────────────────────────────────

describe('processReviewOutput', () => {
  before(async () => {
    // Tests that call processReviewOutput directly need an open DB
    // The createTestServer sets one up; we can use isDbOpen to check
    const ts = await createTestServer();
    // No need to store ts — db is now open via the module-level singleton
  });

  after(async () => { await cleanup(); });

  it('creates findings from JSON block in review summary', async () => {
    // Insert a test review with findings in summary
    const { generateId, now } = await import('../server/util.ts');
    const rid = generateId();
    const pid = generateId();

    // Insert a project first so FK constraint passes (if enabled)
    // Use insert directly via db helpers
    run(
      `INSERT INTO projects (id, slug, name, description, notes, created_at) VALUES (?, ?, ?, '', '', ?)`,
      rid + '-proj',
      'test-proj-' + Date.now(),
      'Test',
      now(),
    );

    const projectId = rid + '-proj';
    run(
      `INSERT INTO p10_reviews (id, project_id, base_ref, head_ref, status, post_mode, min_severity, created_at) VALUES (?, ?, 'main', 'feat', 'done', 'draft', 'medium', ?)`,
      rid,
      projectId,
      now(),
    );

    // Set summary with JSON findings
    run(
      `UPDATE p10_reviews SET summary = ? WHERE id = ?`,
      JSON.stringify({ findings: [
        { file: 'src/index.ts', line: 42, severity: 'high', title: 'SQL Injection', body: 'User input is concatenated directly', confidence: 0.9 },
        { file: 'src/auth.ts', line: null, severity: 'medium', title: 'Missing validation', body: 'Input not validated', confidence: 0.7 },
      ] }),
      rid,
    );

    const count = processReviewOutput(rid);
    assert.equal(count, 2, 'should create 2 findings');

    const findings = all('SELECT * FROM p10_findings WHERE review_id = ?', rid);
    assert.equal(findings.length, 2);
    const f0 = findings.find((f) => String(f.file_path) === 'src/index.ts');
    assert.ok(f0, 'should have finding for src/index.ts');
    assert.equal(f0!.severity, 'high');
    assert.equal(f0!.line_number, 42);
    assert.equal(f0!.title, 'SQL Injection');
    assert.equal(f0!.accepted, 0);
  });

  it('deduplicates findings on repeated calls', async () => {
    const { generateId, now } = await import('../server/util.ts');
    const rid = generateId();
    const projectId = generateId();

    run(
      `INSERT INTO projects (id, slug, name, description, notes, created_at) VALUES (?, ?, ?, '', '', ?)`,
      projectId,
      'test-dedup-' + Date.now(),
      'Test Dedup',
      now(),
    );
    run(
      `INSERT INTO p10_reviews (id, project_id, base_ref, head_ref, status, post_mode, min_severity, created_at) VALUES (?, ?, 'main', 'feat', 'done', 'draft', 'medium', ?)`,
      rid,
      projectId,
      now(),
    );
    run(
      `UPDATE p10_reviews SET summary = ? WHERE id = ?`,
      '```json\n[{"file":"a.ts","line":1,"severity":"low","title":"T","body":"B","confidence":0.5}]\n```',
      rid,
    );

    const first = processReviewOutput(rid);
    assert.equal(first, 1);

    // Call again — should find 0 new findings (already in DB)
    const second = processReviewOutput(rid);
    assert.equal(second, 0, 'should not duplicate findings');
  });

  it('parses markdown table findings', async () => {
    const { generateId, now } = await import('../server/util.ts');
    const rid = generateId();
    const projectId = generateId();

    run(
      `INSERT INTO projects (id, slug, name, description, notes, created_at) VALUES (?, ?, ?, '', '', ?)`,
      projectId,
      'test-md-' + Date.now(),
      'Test MD',
      now(),
    );
    run(
      `INSERT INTO p10_reviews (id, project_id, base_ref, head_ref, status, post_mode, min_severity, created_at) VALUES (?, ?, 'main', 'feat', 'done', 'draft', 'medium', ?)`,
      rid,
      projectId,
      now(),
    );
    run(
      `UPDATE p10_reviews SET summary = ? WHERE id = ?`,
      `| filepath | line | severity | title | body |
|----------|------|----------|-------|------|
| app.ts | 10 | critical | XSS | Unsanitized output |
| utils.ts | 5 | low | Style | Minor style issue |`,
      rid,
    );

    const count = processReviewOutput(rid);
    assert.ok(count >= 1, 'should parse at least 1 finding from markdown table');
  });
});

// ── PUT .../findings/:fid ─────────────────────────────────────────────────────

describe('PUT /api/projects/:id/reviews/:rid/findings/:fid', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let reviewId: string;
  let findingId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'Finding Accept Project');

    // Create review
    const rr = await fetchJson(baseUrl, `/api/projects/${projectId}/reviews`, {
      method: 'POST',
      body: { baseRef: 'main', headRef: 'feat/test' },
      cookie,
    });
    reviewId = ((rr.body as Record<string, unknown>).review as Record<string, unknown>).id as string;

    // Insert a finding directly
    const { generateId, now } = await import('../server/util.ts');
    findingId = generateId();
    run(
      `INSERT INTO p10_findings (id, review_id, file_path, line_number, severity, title, body, accepted, created_at)
       VALUES (?, ?, 'src/app.ts', 10, 'high', 'Test Finding', 'Test body', 0, ?)`,
      findingId,
      reviewId,
      now(),
    );
  });

  after(async () => { await cleanup(); });

  it('accepts a finding (accepted=1)', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/reviews/${reviewId}/findings/${findingId}`,
      { method: 'PUT', body: { accepted: 1 }, cookie },
    );
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.ok);
    const finding = body.finding as Record<string, unknown>;
    assert.equal(finding.accepted, 1);
  });

  it('dismisses a finding (accepted=-1)', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/reviews/${reviewId}/findings/${findingId}`,
      { method: 'PUT', body: { accepted: -1 }, cookie },
    );
    assert.equal(r.status, 200);
    const finding = (r.body as Record<string, unknown>).finding as Record<string, unknown>;
    assert.equal(finding.accepted, -1);
  });

  it('resets a finding (accepted=0)', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/reviews/${reviewId}/findings/${findingId}`,
      { method: 'PUT', body: { accepted: 0 }, cookie },
    );
    assert.equal(r.status, 200);
    const finding = (r.body as Record<string, unknown>).finding as Record<string, unknown>;
    assert.equal(finding.accepted, 0);
  });

  it('returns 400 for invalid accepted value', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/reviews/${reviewId}/findings/${findingId}`,
      { method: 'PUT', body: { accepted: 99 }, cookie },
    );
    assert.equal(r.status, 400);
  });

  it('returns 404 for unknown finding', async () => {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/reviews/${reviewId}/findings/nonexistent`,
      { method: 'PUT', body: { accepted: 1 }, cookie },
    );
    assert.equal(r.status, 404);
  });
});
