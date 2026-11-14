/**
 * Tests for Kiro CLI portal-wide settings routes.
 *
 * Coverage:
 *   - kiro status parsing: signed in (builder-id / identity-center), signed out, not installed
 *   - Login URL parsing: combined URL shape, separate URL + code shape
 *   - Single-login lock (409 when a login is already in progress)
 *   - Cancel login
 *   - Logout
 *   - Admin-only + API-token rejection
 *   - testConnection for kiro mode reflects real status
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { setSetting } from '../server/settings.ts';
import { getDb } from '../server/db.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAKE_KIRO = path.resolve('test/fake-kiro.mjs');

async function loginAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'admin@kiro.test', name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200, `Setup: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

async function loginNonAdmin(baseUrl: string, adminCookie: string): Promise<string> {
  await fetchJson(baseUrl, '/api/users', {
    method: 'POST',
    body: { email: 'user@kiro.test', name: 'User', password: 'password1234', isAdmin: false },
    cookie: adminCookie,
  });
  const r = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'user@kiro.test', password: 'password1234' },
  });
  return r.cookie ?? '';
}

async function createApiToken(baseUrl: string, cookie: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/api-tokens', {
    method: 'POST',
    body: { name: 'tok', scope: 'write' },
    cookie,
  });
  return (r.body as { token: string }).token;
}

// ── parseWhoamiOutput unit tests (via /api/settings/kiro/status route) ────────

describe('Kiro status — whoami parsing via HTTP', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('not-installed → installed: false, signedIn: false', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'not-installed';
    const r = await fetchJson(baseUrl, '/api/settings/kiro/status', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { installed: boolean; signedIn: boolean };
    assert.equal(body.installed, false);
    assert.equal(body.signedIn, false);
  });

  it('signed-out → installed: true, signedIn: false', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'signed-out';
    const r = await fetchJson(baseUrl, '/api/settings/kiro/status', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { installed: boolean; signedIn: boolean };
    assert.equal(body.installed, true);
    assert.equal(body.signedIn, false);
  });

  it('builder-id → installed: true, signedIn: true, method: builder-id', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'builder-id';
    const r = await fetchJson(baseUrl, '/api/settings/kiro/status', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { installed: boolean; signedIn: boolean; method: string; email: string | null };
    assert.equal(body.installed, true);
    assert.equal(body.signedIn, true);
    assert.equal(body.method, 'builder-id');
    assert.equal(body.email, 'user@example.com');
  });

  it('identity-center → installed: true, signedIn: true, method: identity-center, startUrl set', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'identity-center';
    const r = await fetchJson(baseUrl, '/api/settings/kiro/status', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as {
      installed: boolean; signedIn: boolean; method: string;
      startUrl: string | null; email: string | null; profile: string | null;
    };
    assert.equal(body.installed, true);
    assert.equal(body.signedIn, true);
    assert.equal(body.method, 'identity-center');
    assert.ok(body.startUrl?.includes('awsapps.com'), `startUrl should include awsapps.com, got: ${body.startUrl}`);
    assert.equal(body.email, 'admin@example.com');
    assert.equal(body.profile, 'CorpSSO');
  });
});

// ── Login flow tests ──────────────────────────────────────────────────────────

describe('Kiro login — combined URL shape', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'login-url';
  });

  after(async () => {
    // Cancel any pending login before cleanup
    await fetchJson(baseUrl, '/api/settings/kiro/login/cancel', {
      method: 'POST',
      cookie: adminCookie,
    });
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('POST /api/settings/kiro/login returns verificationUri and userCode', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/login', {
      method: 'POST',
      body: { method: 'builder-id' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `login: ${JSON.stringify(r.body)}`);
    const body = r.body as { verificationUri: string; userCode: string };
    assert.ok(body.verificationUri, 'should have verificationUri');
    assert.equal(body.userCode, 'ABCD-1234');
  });

  it('GET /api/settings/kiro/login returns pending while process is running', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/login', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { status: string };
    assert.equal(body.status, 'pending');
  });

  it('POST /api/settings/kiro/login while pending → 409', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/login', {
      method: 'POST',
      body: { method: 'builder-id' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 409, `Expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

describe('Kiro login — separate URL shape', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'login-url-separate';
  });

  after(async () => {
    await fetchJson(baseUrl, '/api/settings/kiro/login/cancel', {
      method: 'POST',
      cookie: adminCookie,
    });
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('POST /api/settings/kiro/login parses separate URL + code shape', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/login', {
      method: 'POST',
      body: { method: 'builder-id' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `login separate: ${JSON.stringify(r.body)}`);
    const body = r.body as { verificationUri: string; userCode: string };
    assert.ok(body.verificationUri.includes('device.sso'), `verificationUri: ${body.verificationUri}`);
    assert.equal(body.userCode, 'WXYZ-5678');
  });
});

describe('Kiro login — complete (process exits 0)', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'login-complete';
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('GET /api/settings/kiro/login returns complete after process exits 0', async () => {
    await fetchJson(baseUrl, '/api/settings/kiro/login', {
      method: 'POST',
      body: { method: 'builder-id' },
      cookie: adminCookie,
    });
    // Wait a moment for the process to exit
    await new Promise((r) => setTimeout(r, 300));
    const r = await fetchJson(baseUrl, '/api/settings/kiro/login', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { status: string };
    // Process exits 0 → status should be 'complete'
    assert.equal(body.status, 'complete');
  });
});

describe('Kiro login — cancel', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'login-url';
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('POST /api/settings/kiro/login/cancel stops the login and resets to idle', async () => {
    // Start a login
    const startR = await fetchJson(baseUrl, '/api/settings/kiro/login', {
      method: 'POST',
      body: { method: 'builder-id' },
      cookie: adminCookie,
    });
    assert.equal(startR.status, 200, `start: ${JSON.stringify(startR.body)}`);

    // Cancel
    const cancelR = await fetchJson(baseUrl, '/api/settings/kiro/login/cancel', {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(cancelR.status, 200);
    assert.equal((cancelR.body as { ok: boolean }).ok, true);

    // Status is now idle
    const statusR = await fetchJson(baseUrl, '/api/settings/kiro/login', { cookie: adminCookie });
    assert.equal(statusR.status, 200);
    assert.equal((statusR.body as { status: string }).status, 'idle');
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

describe('Kiro logout', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'normal';
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('POST /api/settings/kiro/logout returns ok', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/logout', {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);
  });
});

// ── Auth guards ───────────────────────────────────────────────────────────────

describe('Kiro settings — auth guards', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;
  let apiToken: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    userCookie = await loginNonAdmin(baseUrl, adminCookie);
    apiToken = await createApiToken(baseUrl, adminCookie);
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'normal';
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  const postRoutes = [
    '/api/settings/kiro/login',
    '/api/settings/kiro/login/cancel',
    '/api/settings/kiro/logout',
  ];

  for (const p of postRoutes) {
    it(`POST ${p} → 401 unauthenticated`, async () => {
      const r = await fetchJson(baseUrl, p, { method: 'POST', body: {} });
      assert.equal(r.status, 401);
    });
    it(`POST ${p} → 403 non-admin`, async () => {
      const r = await fetchJson(baseUrl, p, { method: 'POST', body: {}, cookie: userCookie });
      assert.equal(r.status, 403);
    });
    it(`POST ${p} → 403 API token`, async () => {
      const r = await fetchJson(baseUrl, p, {
        method: 'POST',
        body: {},
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      assert.equal(r.status, 403);
    });
  }

  it('GET /api/settings/kiro/status → 403 for non-admin', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/status', { cookie: userCookie });
    assert.equal(r.status, 403);
  });

  it('GET /api/settings/kiro/status → 403 for API token', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/status', {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(r.status, 403);
  });
});

// ── testConnection for kiro mode ──────────────────────────────────────────────

describe('testConnection — kiro mode reflects real status', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);

    const db = getDb();
    setSetting(db, 'provider.mode', 'kiro');
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('Test connection ok when kiro is signed in', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'builder-id';

    const r = await fetchJson(baseUrl, '/api/settings/test', {
      method: 'POST',
      body: { modeOverride: 'kiro' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean };
    assert.equal(body.ok, true, `Expected ok: true, got: ${JSON.stringify(r.body)}`);
  });

  it('Test connection fails with clear error when kiro is not signed in', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'signed-out';

    const r = await fetchJson(baseUrl, '/api/settings/test', {
      method: 'POST',
      body: { modeOverride: 'kiro' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; error?: string };
    assert.equal(body.ok, false, 'Expected ok: false for signed-out kiro');
    assert.ok(
      body.error?.includes('not signed in') || body.error?.includes('sign in'),
      `Expected 'not signed in' in error, got: ${body.error}`,
    );
  });

  it('Test connection fails with clear error when kiro is not installed', async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'not-installed';

    const r = await fetchJson(baseUrl, '/api/settings/test', {
      method: 'POST',
      body: { modeOverride: 'kiro' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { ok: boolean; error?: string };
    assert.equal(body.ok, false, 'Expected ok: false for not-installed kiro');
    assert.ok(
      body.error?.includes('not installed') || body.error?.includes('PATH'),
      `Expected 'not installed' in error, got: ${body.error}`,
    );
  });
});

// ── login with identity-center method ────────────────────────────────────────

describe('Kiro login — identity-center method validation', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'login-url';
  });

  after(async () => {
    await fetchJson(baseUrl, '/api/settings/kiro/login/cancel', {
      method: 'POST',
      cookie: adminCookie,
    });
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('identity-center login without startUrl → 400', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/login', {
      method: 'POST',
      body: { method: 'identity-center' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('identity-center login without region → 400', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/login', {
      method: 'POST',
      body: { method: 'identity-center', startUrl: 'https://d-test.awsapps.com/start' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('identity-center login with valid params returns verificationUri and userCode', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/kiro/login', {
      method: 'POST',
      body: {
        method: 'identity-center',
        startUrl: 'https://d-test.awsapps.com/start',
        region: 'us-east-1',
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `identity-center login: ${JSON.stringify(r.body)}`);
    const body = r.body as { verificationUri: string; userCode: string };
    assert.ok(body.verificationUri);
    assert.equal(body.userCode, 'ABCD-1234');
  });
});
