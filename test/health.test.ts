/**
 * Health endpoint tests.
 *
 * Tests:
 *   - /api/health returns ok:true
 *   - /api/ready returns ok:true when all checks pass
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

describe('Health routes', () => {
  let baseUrl: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
  });

  after(async () => {
    await cleanup();
  });

  it('GET /api/health returns ok:true', async () => {
    const r = await fetchJson(baseUrl, '/api/health');
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.db, 'ok');
  });

  it('GET /api/ready returns ok:true when all checks pass', async () => {
    const r = await fetchJson(baseUrl, '/api/ready');
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, true);
    const checks = body.checks as Record<string, string>;
    assert.ok(checks, 'Expected checks object');
    assert.equal(checks.db, 'ok');
    assert.equal(checks.dataDir, 'ok');
  });
});
