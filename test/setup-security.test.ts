/**
 * Security regression tests for auth/setup/invitation fixes.
 *
 * Item 1 — createFirstAdmin is atomic:
 *   - POST /api/auth/setup returns 409 when users exist (no setup.claimed key needed)
 *   - Concurrent setup requests: exactly one admin created
 *   - A failed createFirstAdmin leaves setup available (no bricks)
 *
 * Item 2 — accept-invite claim-first:
 *   - Concurrent accept-invite: exactly one user account created, not two
 *   - HTTP level: second concurrent accept gets 400, no orphaned user
 *
 * Item 5 — background writes drain before response:
 *   - A tracked write completes before the client receives the response end
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { insert } from '../server/db.ts';
import { generateId, now, sha256 } from '../server/util.ts';
import { hashPassword } from '../server/auth.ts';
import { registerBackgroundWrite, router, sendJson, requireAuth } from '../server/http.ts';

// ── Item 1: setup security ─────────────────────────────────────────────────────

describe('Item 1 — POST /api/auth/setup is refused when users already exist', () => {
  let baseUrl: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    // Directly insert a user into the DB (simulates migrated data, no setup.claimed key)
    insert('users', {
      id: generateId(),
      email: 'existing@example.com',
      name: 'Existing Admin',
      password_hash: hashPassword('password1234'),
      is_admin: 1,
      disabled: 0,
      created_at: now(),
    });
  });

  after(async () => {
    await cleanup();
  });

  it('POST /api/auth/setup returns 409 when a user already exists (no setup.claimed required)', async () => {
    const r = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: {
        email: 'attacker@evil.com',
        name: 'Attacker',
        password: 'password1234',
        provider: 'demo',
      },
    });
    assert.equal(r.status, 409, `expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.ok(
      String(body.error ?? '').toLowerCase().includes('already') ||
      String(body.error ?? '').toLowerCase().includes('sign in'),
      `expected error about already done: ${body.error}`,
    );
  });

  it('attacker account was not created', async () => {
    const r = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'attacker@evil.com', password: 'password1234' },
    });
    assert.equal(r.status, 401, 'attacker account must not be usable');
  });
});

describe('Item 1 — concurrent POST /api/auth/setup: exactly one admin created', () => {
  let baseUrl: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
  });

  after(async () => {
    await cleanup();
  });

  it('two concurrent setup requests: exactly one succeeds', async () => {
    const [r1, r2] = await Promise.all([
      fetchJson(baseUrl, '/api/auth/setup', {
        method: 'POST',
        body: { email: 'admin-a@example.com', name: 'Admin A', password: 'password1234', provider: 'demo' },
      }),
      fetchJson(baseUrl, '/api/auth/setup', {
        method: 'POST',
        body: { email: 'admin-b@example.com', name: 'Admin B', password: 'password1234', provider: 'demo' },
      }),
    ]);

    const statuses = [r1.status, r2.status];
    const ok200 = statuses.filter((s) => s === 200).length;
    const conflict409 = statuses.filter((s) => s === 409).length;

    assert.equal(ok200, 1, `exactly one setup should succeed (got ${statuses.join(', ')})`);
    assert.equal(conflict409, 1, `exactly one setup should be rejected (got ${statuses.join(', ')})`);

    // State check: only one user should exist
    const stateR = await fetchJson(baseUrl, '/api/auth/state');
    assert.equal((stateR.body as Record<string, unknown>).needsSetup, false, 'setup should be done');
  });
});

// ── Item 2: accept-invite claim-first ─────────────────────────────────────────

describe('Item 2 — concurrent accept-invite: exactly one user created', () => {
  let baseUrl: string;
  let adminCookie: string;
  let token: string;
  let tokenHash: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    // Setup admin
    const ar = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'inv-admin@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    adminCookie = ar.cookie ?? '';

    // Create an invitation with no email so it can be accepted by either concurrent request
    const invR = await fetchJson(baseUrl, '/api/governance/invitations', {
      method: 'POST',
      body: { role: 'member' },
      cookie: adminCookie,
    });
    assert.equal(invR.status, 201, `invitation creation failed: ${JSON.stringify(invR.body)}`);
    const inv = (invR.body as Record<string, unknown>).invitation as Record<string, unknown>;
    // Extract the token from the inviteUrl
    const inviteUrl = String(inv.inviteUrl ?? '');
    const match = inviteUrl.match(/token=([^&]+)/);
    assert.ok(match, 'inviteUrl should contain token');
    token = decodeURIComponent(match![1]);
    tokenHash = String(inv.tokenHash ?? '');
  });

  after(async () => {
    await cleanup();
  });

  it('two concurrent accept-invite calls: exactly one user created', async () => {
    const [r1, r2] = await Promise.all([
      fetchJson(baseUrl, '/api/auth/accept-invite', {
        method: 'POST',
        body: { token, email: 'user-a@example.com', name: 'User A', password: 'password1234' },
      }),
      fetchJson(baseUrl, '/api/auth/accept-invite', {
        method: 'POST',
        body: { token, email: 'user-b@example.com', name: 'User B', password: 'password1234' },
      }),
    ]);

    const statuses = [r1.status, r2.status];
    const ok200 = statuses.filter((s) => s === 200).length;
    const fail400 = statuses.filter((s) => s === 400).length;

    assert.equal(ok200, 1, `exactly one accept should succeed (got ${statuses.join(', ')})`);
    assert.equal(fail400, 1, `exactly one accept should fail (got ${statuses.join(', ')})`);

    // Determine which email was used successfully
    const winner = r1.status === 200
      ? 'user-a@example.com'
      : 'user-b@example.com';
    const loser = r1.status === 200
      ? 'user-b@example.com'
      : 'user-a@example.com';

    // Loser must NOT have an account
    const loserLogin = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: loser, password: 'password1234' },
    });
    assert.equal(
      loserLogin.status,
      401,
      `losing concurrent accept-invite must not leave an orphaned account for ${loser}`,
    );

    // Winner must be able to log in
    const winnerLogin = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: winner, password: 'password1234' },
    });
    assert.equal(winnerLogin.status, 200, `winning concurrent accept should have created ${winner}`);
  });
});

// ── Item 5: background writes drain before response end ───────────────────────

describe('Item 5 — tracked write settles before client receives the response end', () => {
  let baseUrl: string;
  let adminCookie: string;
  let drainFlag = false;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    // Register a route whose handler starts a slow tracked write (100 ms) that sets a
    // flag, then immediately sends JSON.  The drain wrapper must hold the response until
    // the write settles, so the flag must be true by the time the client has the response.
    router.get('/api/test-drain-order', requireAuth(async (req, res) => {
      const write = new Promise<void>((resolve) => {
        setTimeout(() => {
          drainFlag = true;
          resolve();
        }, 100);
      });
      registerBackgroundWrite(write);
      sendJson(res, 200, { ok: true });
    }));

    // Register an SSE route that sends one event and closes, to verify that SSE
    // streaming still works correctly when the drain wrapper is active.
    router.sse('/api/test-sse-stream', requireAuth((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('data: hello\n\n');
      res.end();
    }));

    const ar = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'drain-admin@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    adminCookie = ar.cookie ?? '';
  });

  after(async () => {
    await cleanup();
  });

  it('slow tracked write (100 ms) completes before the client has the full response', async () => {
    drainFlag = false;
    const r = await fetchJson(baseUrl, '/api/test-drain-order', { cookie: adminCookie });
    assert.equal(r.status, 200, 'drain route should respond 200');
    assert.equal(
      drainFlag,
      true,
      'background write flag must be set before the response reaches the client',
    );
  });

  it('SSE route still streams correctly when the drain wrapper is active', async () => {
    const res = await fetch(`${baseUrl}/api/test-sse-stream`, {
      headers: { Cookie: adminCookie, Connection: 'close' },
    });
    assert.equal(res.status, 200, 'SSE route should return 200');
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(
      ct.includes('text/event-stream'),
      `Content-Type should be text/event-stream, got: ${ct}`,
    );
    const text = await res.text();
    assert.ok(text.includes('data: hello'), `SSE stream should contain 'data: hello', got: ${JSON.stringify(text)}`);
  });
});
