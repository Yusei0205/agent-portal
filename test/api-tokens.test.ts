/**
 * Tests for the API Tokens module (P12).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { authenticateApiToken } from '../server/api-tokens.ts';
import type { PortalRequest } from '../server/http.ts';
import { getDb } from '../server/db.ts';
import { now, sha256 } from '../server/util.ts';

let baseUrl: string;
let adminCookie: string;
let userCookie: string;

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  const srv = await createTestServer();
  baseUrl = srv.baseUrl;

  // Create admin
  await fetchJson(baseUrl, '/api/auth/setup', {
    body: { email: 'admin@tokens.com', password: 'adminpassword1', name: 'Admin' },
  });
  const adminLogin = await fetchJson(baseUrl, '/api/auth/login', {
    body: { email: 'admin@tokens.com', password: 'adminpassword1' },
  });
  adminCookie = adminLogin.cookie ?? '';

  // Create a regular user via admin
  await fetchJson(baseUrl, '/api/users', {
    method: 'POST',
    body: { email: 'user@tokens.com', name: 'User', password: 'userpassword1', isAdmin: false },
    cookie: adminCookie,
  });
  const userLogin = await fetchJson(baseUrl, '/api/auth/login', {
    body: { email: 'user@tokens.com', password: 'userpassword1' },
  });
  userCookie = userLogin.cookie ?? '';
});

after(cleanup);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/api-tokens — create token', () => {
  test('creates a token and returns it once', async () => {
    const r = await fetchJson(baseUrl, '/api/api-tokens', {
      body: { name: 'CI pipeline', scope: 'read' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.token, 'should return the raw token');
    assert.ok(String(body.token).startsWith('ap_'), 'token should start with ap_');
    assert.ok(body.info, 'should return info');
    const info = body.info as Record<string, unknown>;
    assert.equal(info.scope, 'read');
    assert.equal(info.active, true);
    assert.ok(!info.token_hash, 'should NOT expose token_hash');
  });

  test('creates a write-scope token', async () => {
    const r = await fetchJson(baseUrl, '/api/api-tokens', {
      body: { name: 'Write token', scope: 'write' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201);
    const body = r.body as Record<string, unknown>;
    const info = body.info as Record<string, unknown>;
    assert.equal(info.scope, 'write');
  });

  test('requires authentication', async () => {
    const r = await fetchJson(baseUrl, '/api/api-tokens', {
      body: { name: 'Unauthenticated', scope: 'read' },
    });
    assert.equal(r.status, 401);
  });

  test('rejects empty name', async () => {
    const r = await fetchJson(baseUrl, '/api/api-tokens', {
      body: { name: '', scope: 'read' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });
});

describe('GET /api/api-tokens — list tokens', () => {
  test('returns token list without secret (hash) fields', async () => {
    // First create a token
    await fetchJson(baseUrl, '/api/api-tokens', {
      body: { name: 'List test token', scope: 'read' },
      cookie: userCookie,
    });

    const r = await fetchJson(baseUrl, '/api/api-tokens', { cookie: userCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.tokens), 'should return tokens array');

    // Verify no hash fields exposed
    const tokens = body.tokens as Array<Record<string, unknown>>;
    for (const t of tokens) {
      assert.ok(!('token_hash' in t), 'should not expose token_hash');
      assert.ok('prefix' in t, 'should expose prefix');
      assert.ok('scope' in t);
      assert.ok('id' in t);
    }
  });

  test('requires authentication', async () => {
    const r = await fetchJson(baseUrl, '/api/api-tokens');
    assert.equal(r.status, 401);
  });
});

describe('DELETE /api/api-tokens/:id — revoke token', () => {
  test('revokes a token', async () => {
    // Create token
    const create = await fetchJson(baseUrl, '/api/api-tokens', {
      body: { name: 'Revoke me', scope: 'read' },
      cookie: adminCookie,
    });
    const info = (create.body as Record<string, unknown>).info as Record<string, unknown>;
    const tokenId = String(info.id);

    // Revoke it
    const del = await fetchJson(baseUrl, `/api/api-tokens/${tokenId}`, {
      method: 'DELETE',
      cookie: adminCookie,
    });
    assert.equal(del.status, 200);

    // List should show it as revoked
    const list = await fetchJson(baseUrl, '/api/api-tokens', { cookie: adminCookie });
    const tokens = (list.body as Record<string, unknown>).tokens as Array<Record<string, unknown>>;
    const found = tokens.find((t) => t.id === tokenId);
    assert.ok(found, 'token should still appear in list');
    assert.equal(found.active, false, 'token should be inactive after revocation');
    assert.ok(found.revoked_at, 'should have revoked_at timestamp');
  });

  test('returns 404 for another user token', async () => {
    // Create token as admin
    const create = await fetchJson(baseUrl, '/api/api-tokens', {
      body: { name: 'Admin token', scope: 'read' },
      cookie: adminCookie,
    });
    const info = (create.body as Record<string, unknown>).info as Record<string, unknown>;
    const tokenId = String(info.id);

    // Try to revoke as user
    const del = await fetchJson(baseUrl, `/api/api-tokens/${tokenId}`, {
      method: 'DELETE',
      cookie: userCookie,
    });
    assert.equal(del.status, 404);
  });
});

describe('authenticateApiToken middleware', () => {
  test('validates a valid token and sets req.user', async () => {
    // Create a real token in the DB
    const db = getDb();
    const token = 'ap_' + 'a'.repeat(32);
    const userId = String(
      (db.prepare("SELECT id FROM users WHERE email = 'admin@tokens.com'").get() as { id: string }).id,
    );

    db.prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, expires_at, created_at)
       VALUES (?, ?, 'test-auth-token', ?, 'ap_aaaaaaaaaa', 'read', ?, ?)`,
    ).run(
      'tk-test-auth-' + Date.now(),
      userId,
      sha256(token),
      new Date(Date.now() + 86_400_000).toISOString(),
      now(),
    );

    const fakeReq = {
      headers: { authorization: `Bearer ${token}` },
      user: null,
    } as unknown as PortalRequest;

    const result = authenticateApiToken(fakeReq);
    assert.ok(result, 'should return true for valid token');
    assert.ok(fakeReq.user, 'should set req.user');
    assert.equal(fakeReq.user!.id, userId);
  });

  test('rejects a revoked token', async () => {
    const db = getDb();
    const token = 'ap_' + 'b'.repeat(32);
    const userId = String(
      (db.prepare("SELECT id FROM users WHERE email = 'admin@tokens.com'").get() as { id: string }).id,
    );

    db.prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, expires_at, revoked_at, created_at)
       VALUES (?, ?, 'revoked-auth-token', ?, 'ap_bbbbbbbbbb', 'read', ?, ?, ?)`,
    ).run(
      'tk-revoked-' + Date.now(),
      userId,
      sha256(token),
      new Date(Date.now() + 86_400_000).toISOString(),
      now(),
      now(),
    );

    const fakeReq = {
      headers: { authorization: `Bearer ${token}` },
      user: null,
    } as unknown as PortalRequest;

    const result = authenticateApiToken(fakeReq);
    assert.equal(result, false, 'should reject revoked token');
    assert.equal(fakeReq.user, null, 'should not set req.user');
  });

  test('rejects an expired token', async () => {
    const db = getDb();
    const token = 'ap_' + 'c'.repeat(32);
    const userId = String(
      (db.prepare("SELECT id FROM users WHERE email = 'admin@tokens.com'").get() as { id: string }).id,
    );

    db.prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, expires_at, created_at)
       VALUES (?, ?, 'expired-auth-token', ?, 'ap_cccccccccc', 'read', ?, ?)`,
    ).run(
      'tk-expired-' + Date.now(),
      userId,
      sha256(token),
      new Date(Date.now() - 86_400_000).toISOString(), // expired yesterday
      now(),
    );

    const fakeReq = {
      headers: { authorization: `Bearer ${token}` },
      user: null,
    } as unknown as PortalRequest;

    const result = authenticateApiToken(fakeReq);
    assert.equal(result, false, 'should reject expired token');
  });

  test('rejects non-bearer auth header', async () => {
    const fakeReq = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
      user: null,
    } as unknown as PortalRequest;

    const result = authenticateApiToken(fakeReq);
    assert.equal(result, false);
    assert.equal(fakeReq.user, null);
  });

  test('rejects missing auth header', async () => {
    const fakeReq = {
      headers: {},
      user: null,
    } as unknown as PortalRequest;

    const result = authenticateApiToken(fakeReq);
    assert.equal(result, false);
  });
});

describe('GET /api/admin/api-tokens — admin list', () => {
  test('admin can list all tokens', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/api-tokens', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.tokens));
  });

  test('regular user cannot access admin endpoint', async () => {
    const r = await fetchJson(baseUrl, '/api/admin/api-tokens', { cookie: userCookie });
    assert.equal(r.status, 403);
  });
});
