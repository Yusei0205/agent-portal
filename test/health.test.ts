/**
 * Tests for GET /api/health
 *
 * Covers:
 *   - 200 with { ok, version, db } when DB is fine and server is not draining
 *   - 503 while the server is draining
 *   - accessible with no session cookie (unauthenticated)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, type TestServer } from './client.ts';

let srv: TestServer;
let anon: Client;   // no cookie — unauthenticated caller
let admin: Client;  // signed-in admin

before(async () => {
  srv = await bootServer();
  anon = new Client(srv.base);
  admin = new Client(srv.base);
  // Create the admin account so drain-mode tests can call the admin API.
  await admin.post('/api/auth/setup', { email: 'health-admin@example.com', name: 'HealthAdmin', password: 'a-long-password-health' });
});

after(async () => {
  await srv.close();
});

test('health: returns 200 with ok, version and db when server is healthy', async () => {
  const r = await anon.req('GET', '/api/health');
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.equal(r.data.ok, true);
  // version is intentionally omitted from the unauthenticated response (security: reduces information exposure).
  assert.equal(r.data.version, undefined, 'unauthenticated health must not include version');
  assert.equal(r.data.db, 'ok');
});

test('health: returns 503 while the server is draining', async () => {
  // Enable drain via the admin API.
  await admin.post('/api/admin/drain', { enable: true });

  try {
    const r = await anon.req('GET', '/api/health');
    assert.equal(r.status, 503, `expected 503 while draining, got ${r.status}`);
    assert.equal(r.data.ok, false);
    assert.equal(r.data.reason, 'draining');
  } finally {
    // Always restore drain mode so other tests in this process aren't affected.
    await admin.post('/api/admin/drain', { enable: false });
  }
});

test('health: accessible without a session cookie', async () => {
  const fresh = new Client(srv.base);
  assert.equal(fresh.cookie, '', 'no cookie set');
  const r = await fresh.req('GET', '/api/health');
  assert.equal(r.status, 200, `health should be reachable without auth, got ${r.status}`);
  assert.equal(r.data.ok, true);
});
