/**
 * Tests for the Insights API (P12).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { now } from '../server/util.ts';

let baseUrl: string;
let adminCookie: string;

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  const srv = await createTestServer();
  baseUrl = srv.baseUrl;

  // Create admin user
  await fetchJson(baseUrl, '/api/auth/setup', {
    body: { email: 'admin@test.com', password: 'adminpassword1', name: 'Admin' },
  });

  const login = await fetchJson(baseUrl, '/api/auth/login', {
    body: { email: 'admin@test.com', password: 'adminpassword1' },
  });
  adminCookie = login.cookie ?? '';
});

after(cleanup);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/insights', () => {
  test('returns correct shape with zeros on empty DB', async () => {
    const r = await fetchJson(baseUrl, '/api/insights', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;

    assert.ok('totalCost' in body, 'should have totalCost');
    assert.ok('totalRuns' in body, 'should have totalRuns');
    assert.ok('totalTokens' in body, 'should have totalTokens');
    assert.ok('failureRate' in body, 'should have failureRate');
    assert.ok('avgRunDuration' in body, 'should have avgRunDuration');
    assert.ok('dailyCosts' in body, 'should have dailyCosts');
    assert.ok('costByProject' in body, 'should have costByProject');
    assert.ok('costByUser' in body, 'should have costByUser');
    assert.ok('runsByStatus' in body, 'should have runsByStatus');

    assert.equal(body.totalCost, 0);
    assert.equal(body.totalRuns, 0);
    assert.equal(body.totalTokens, 0);
    assert.equal(body.failureRate, 0);
    assert.equal(body.avgRunDuration, 0);
    assert.ok(Array.isArray(body.dailyCosts));
    assert.equal((body.dailyCosts as unknown[]).length, 30, 'should have 30 daily buckets');
  });

  test('GET /api/insights?period=7d returns correct shape', async () => {
    const r = await fetchJson(baseUrl, '/api/insights?period=7d', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok('totalCost' in body);
    assert.ok(Array.isArray(body.dailyCosts));
  });

  test('GET /api/insights?period=today returns correct shape', async () => {
    const r = await fetchJson(baseUrl, '/api/insights?period=today', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok('totalCost' in body);
  });

  test('rejects unknown period', async () => {
    const r = await fetchJson(baseUrl, '/api/insights?period=bad', { cookie: adminCookie });
    assert.equal(r.status, 400);
  });

  test('requires authentication', async () => {
    const r = await fetchJson(baseUrl, '/api/insights');
    assert.equal(r.status, 401);
  });

  test('budget_usage rows aggregate correctly into totalCost', async () => {
    const db = getDb();

    // Create a project to attach budget_usage rows to
    const projectId = 'test-proj-insights-' + Date.now();
    db.prepare(`
      INSERT INTO projects (id, name, slug, created_at)
      VALUES (?, 'Test Project', ?, ?)
    `).run(projectId, `test-${Date.now()}`, now());

    // Insert budget_usage rows
    db.prepare(`
      INSERT INTO budget_usage (project_id, cost_usd, input_tokens, output_tokens, created_at)
      VALUES (?, 1.50, 1000, 500, ?)
    `).run(projectId, now());
    db.prepare(`
      INSERT INTO budget_usage (project_id, cost_usd, input_tokens, output_tokens, created_at)
      VALUES (?, 2.25, 2000, 1000, ?)
    `).run(projectId, now());

    const r = await fetchJson(baseUrl, '/api/insights', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    // Total cost should be >= 3.75 (may be more if other tests inserted data)
    assert.ok(Number(body.totalCost) >= 3.75, `Expected totalCost >= 3.75 but got ${body.totalCost}`);
    assert.ok(Number(body.totalTokens) >= 4500, `Expected totalTokens >= 4500`);
  });

  test('GET /api/projects/:id/insights returns project-scoped data', async () => {
    const db = getDb();
    const projectId = 'proj-insights-scope-' + Date.now();
    db.prepare(`
      INSERT INTO projects (id, name, slug, created_at)
      VALUES (?, 'Scoped Project', ?, ?)
    `).run(projectId, `scoped-${Date.now()}`, now());

    db.prepare(`
      INSERT INTO budget_usage (project_id, cost_usd, input_tokens, output_tokens, created_at)
      VALUES (?, 0.99, 100, 50, ?)
    `).run(projectId, now());

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/insights`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Number(body.totalCost) >= 0.99);
  });
});
