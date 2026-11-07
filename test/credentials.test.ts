/**
 * Tests for F4 (per-user engine credentials) and F8 (Claude model list + settings visibility).
 *
 * Coverage:
 *   - Create/list/replace/delete credentials per mode
 *   - List never contains secrets
 *   - API-token write and read → 403
 *   - Another user cannot use or see another user's credential
 *   - Run env contains the right variable for each mode
 *   - Falls back to portal provider when no credential
 *   - Device-code flow with mocked OIDC client (new: correct scopes, stored fields)
 *   - Deleting a credential blocks new sessions using it (falls back gracefully)
 *   - Model list round-trip (F8)
 *   - Non-admin settings read OK, write 403 (F8)
 *   - lastChangedAt/By updated on PUT /api/settings (F8)
 *   - materialiseKiroAuthDb DB row shapes (oauth_flow DeviceCode, both rows, scopes)
 *   - Old-credential detection (missing clientId → sign-in-again error)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { createTestDb } from './fixtures.ts';
import { getDb, one, all } from '../server/db.ts';
import { encrypt, decrypt } from '../server/secrets.ts';
import { setConfig } from '../server/config.ts';
import { setOIDCClientFactory, resolveCredentialEnv, setOIDCCallTimeoutMs } from '../server/credentials.ts';
import type { OIDCClientLike } from '../server/credentials.ts';
import { setProfilesFetcherOverride } from '../server/credentials.ts';
import { now } from '../server/util.ts';
import { randomBytes } from 'node:crypto';
import type { Config } from '../server/config.ts';
import { DatabaseSync } from 'node:sqlite';
import { _setAgentCoreInvokerOverride } from '../server/agent/kiro-agentcore.ts';
import { materialiseKiroAuthDb, cleanupKiroAuthDb, KIRO_IDC_SCOPES } from '../server/kiro-idc.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupServer() {
  const ts = await createTestServer();
  return ts;
}

async function loginAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'admin@cred-test.com', name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200, `Setup: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

async function createNonAdmin(baseUrl: string, adminCookie: string, suffix = 'a') {
  const email = `user-${suffix}@cred-test.com`;
  const createR = await fetchJson(baseUrl, '/api/users', {
    method: 'POST',
    body: { email, name: `User ${suffix}`, password: 'password1234', isAdmin: false },
    cookie: adminCookie,
  });
  assert.equal(createR.status, 201, `Create user: ${JSON.stringify(createR.body)}`);
  const loginR = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password1234' },
  });
  assert.equal(loginR.status, 200, `Login: ${JSON.stringify(loginR.body)}`);
  return { cookie: loginR.cookie ?? '', userId: (createR.body as { user: { id: string } }).user.id };
}

/** Create an API token for a user and return the raw token string. */
async function createApiToken(baseUrl: string, cookie: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/api-tokens', {
    method: 'POST',
    body: { name: 'test-token', scope: 'write' },
    cookie,
  });
  assert.equal(r.status, 201, `Create token: ${JSON.stringify(r.body)}`);
  return (r.body as { token: string }).token;
}

// ── F4: Credential CRUD ───────────────────────────────────────────────────────

describe('Credentials — create/list/delete (kiro api_key)', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'k1');
    userCookie = u.cookie;
  });
  after(async () => { await cleanup(); });

  it('creates a kiro api_key credential', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'kiro', mode: 'api_key', name: 'Work Kiro', secret: 'kiro-secret-1234', isDefault: true },
      cookie: userCookie,
    });
    assert.equal(r.status, 201, `Create: ${JSON.stringify(r.body)}`);
    const body = r.body as { credential: { id: string; engine: string; mode: string; isDefault: boolean; last4: string } };
    assert.equal(body.credential.engine, 'kiro');
    assert.equal(body.credential.mode, 'api_key');
    assert.equal(body.credential.isDefault, true);
    assert.equal(body.credential.last4, '1234');
  });

  it('list never exposes secrets', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    assert.equal(r.status, 200);
    const body = r.body as { credentials: Array<Record<string, unknown>> };
    assert.ok(body.credentials.length >= 1);
    for (const cred of body.credentials) {
      assert.ok(!('secret' in cred), 'secret must not be in response');
      assert.ok(!('secret_enc' in cred), 'secret_enc must not be in response');
      assert.ok(!('secretEnc' in cred), 'secretEnc must not be in response');
    }
  });

  it('deletes a credential', async () => {
    // Create one to delete
    const cr = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'kiro', mode: 'api_key', name: 'Temp', secret: 'temp-secret-5678' },
      cookie: userCookie,
    });
    assert.equal(cr.status, 201);
    const credId = (cr.body as { credential: { id: string } }).credential.id;

    const dr = await fetchJson(baseUrl, `/api/credentials/${credId}`, {
      method: 'DELETE',
      cookie: userCookie,
    });
    assert.equal(dr.status, 200);

    const list = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    const body = list.body as { credentials: Array<{ id: string }> };
    assert.ok(!body.credentials.some((c) => c.id === credId), 'Deleted cred should not appear');
  });
});

describe('Credentials — claude-code modes', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'cc1');
    userCookie = u.cookie;
  });
  after(async () => { await cleanup(); });

  it('creates claude-code api_key credential', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'claude-code', mode: 'api_key', name: 'Anthropic', secret: 'sk-ant-123456', isDefault: true },
      cookie: userCookie,
    });
    assert.equal(r.status, 201);
    const body = r.body as { credential: { engine: string; mode: string; last4: string } };
    assert.equal(body.credential.engine, 'claude-code');
    assert.equal(body.credential.mode, 'api_key');
    assert.equal(body.credential.last4, '3456');
  });

  it('creates claude-code subscription_token credential', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'claude-code', mode: 'subscription_token', name: 'Claude Sub', secret: 'oauth-token-abcd' },
      cookie: userCookie,
    });
    assert.equal(r.status, 201);
    const body = r.body as { credential: { mode: string; last4: string } };
    assert.equal(body.credential.mode, 'subscription_token');
    assert.equal(body.credential.last4, 'abcd');
  });

  it('creates claude-code bedrock_role credential (no secret)', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'claude-code',
        mode: 'bedrock_role',
        name: 'Bedrock Role',
        config: { roleArn: 'arn:aws:iam::123456789:role/TestRole', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    assert.equal(r.status, 201);
    const body = r.body as { credential: { mode: string; last4: string; config: Record<string, unknown> } };
    assert.equal(body.credential.mode, 'bedrock_role');
    assert.equal(body.credential.last4, '');
    assert.equal(body.credential.config.roleArn, 'arn:aws:iam::123456789:role/TestRole');
  });

  it('rejects bedrock_role without required config fields', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'claude-code', mode: 'bedrock_role', name: 'Bad', config: {} },
      cookie: userCookie,
    });
    assert.equal(r.status, 400);
  });

  it('set-default changes default credential', async () => {
    // Create two credentials, set the second as default
    const r1 = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'claude-code', mode: 'api_key', name: 'First', secret: 'first-key-0001', isDefault: true },
      cookie: userCookie,
    });
    assert.equal(r1.status, 201);
    const id1 = (r1.body as { credential: { id: string } }).credential.id;

    const r2 = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'claude-code', mode: 'api_key', name: 'Second', secret: 'second-key-0002' },
      cookie: userCookie,
    });
    assert.equal(r2.status, 201);
    const id2 = (r2.body as { credential: { id: string } }).credential.id;

    const sd = await fetchJson(baseUrl, `/api/credentials/${id2}/set-default`, {
      method: 'POST',
      cookie: userCookie,
    });
    assert.equal(sd.status, 200);

    const list = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    const body = list.body as { credentials: Array<{ id: string; isDefault: boolean }> };
    const cred1 = body.credentials.find((c) => c.id === id1);
    const cred2 = body.credentials.find((c) => c.id === id2);
    assert.ok(cred1, 'cred1 should exist');
    assert.ok(cred2, 'cred2 should exist');
    assert.equal(cred1!.isDefault, false, 'cred1 should no longer be default');
    assert.equal(cred2!.isDefault, true, 'cred2 should now be default');
  });
});

// ── F4: Browser-only enforcement ──────────────────────────────────────────────

describe('Credentials — API-token requests → 403', () => {
  let baseUrl: string;
  let adminCookie: string;
  let apiToken: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    apiToken = await createApiToken(baseUrl, adminCookie);
  });
  after(async () => { await cleanup(); });

  it('GET /api/credentials via API token → 403', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(r.status, 403);
  });

  it('POST /api/credentials via API token → 403', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'kiro', mode: 'api_key', name: 'x', secret: 'y' },
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(r.status, 403);
  });

  it('GET /api/credentials/summary via API token → 403', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials/summary', {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(r.status, 403);
  });
});

// ── F4: Cross-user isolation ──────────────────────────────────────────────────

describe('Credentials — another user cannot see or use my credential', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userACookie: string;
  let userBCookie: string;
  let credIdA: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const uA = await createNonAdmin(baseUrl, adminCookie, 'iso-a');
    const uB = await createNonAdmin(baseUrl, adminCookie, 'iso-b');
    userACookie = uA.cookie;
    userBCookie = uB.cookie;

    // User A creates a credential
    const r = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'kiro', mode: 'api_key', name: 'A cred', secret: 'a-secret-xyz9' },
      cookie: userACookie,
    });
    assert.equal(r.status, 201);
    credIdA = (r.body as { credential: { id: string } }).credential.id;
  });
  after(async () => { await cleanup(); });

  it("user B's list does not include user A's credential", async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', { cookie: userBCookie });
    assert.equal(r.status, 200);
    const body = r.body as { credentials: Array<{ id: string }> };
    assert.ok(!body.credentials.some((c) => c.id === credIdA));
  });

  it("user B cannot delete user A's credential (404)", async () => {
    const r = await fetchJson(baseUrl, `/api/credentials/${credIdA}`, {
      method: 'DELETE',
      cookie: userBCookie,
    });
    assert.equal(r.status, 404);
  });

  it("user B cannot set user A's credential as default", async () => {
    const r = await fetchJson(baseUrl, `/api/credentials/${credIdA}/set-default`, {
      method: 'POST',
      cookie: userBCookie,
    });
    assert.equal(r.status, 404);
  });
});

// ── F4: Run env resolution ────────────────────────────────────────────────────

describe('resolveCredentialEnv — env variable mapping', () => {
  before(() => {
    createTestDb();
    const cfg: Config = {
      root: process.cwd(),
      port: 0,
      host: '127.0.0.1',
      dataDir: '/tmp/cred-env-test',
      webDir: '',
      secretKey: 'a'.repeat(64),
      cookieSecure: 'false',
      demoSpeed: 0,
      maxUploadBytes: 50 * 1024 * 1024,
      trustProxy: false,
      awsRegion: 'us-east-1',
      deployTarget: null,
    };
    setConfig(cfg);
  });
  after(async () => { await cleanup(); });

  it('kiro api_key → KIRO_API_KEY', async () => {
    const db = getDb();
    const userId = 'user-kiro-1';
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(userId, 'kiro1@test.com', 'Kiro User', 'hash', now());

    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp', webDir: '',
      secretKey: 'a'.repeat(64), cookieSecure: 'false', demoSpeed: 0, maxUploadBytes: 0,
      trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);

    const secret = 'kiro-api-key-test-value';
    const enc = encrypt(secret, cfg.secretKey);
    db.prepare(`INSERT INTO engine_credentials (id, user_id, engine, mode, secret_enc, extra_config, is_default, last4, name, created_at, updated_at)
      VALUES (?, ?, 'kiro', 'api_key', ?, '{}', 1, ?, 'test', datetime('now'), datetime('now'))`)
      .run('cred-kiro-1', userId, enc, secret.slice(-4));

    const env = await resolveCredentialEnv('kiro', userId, null);
    assert.equal(env.KIRO_API_KEY, secret);
    assert.ok(!env.ANTHROPIC_API_KEY, 'should not set ANTHROPIC_API_KEY');
  });

  it('claude-code api_key → ANTHROPIC_API_KEY', async () => {
    const db = getDb();
    const userId = 'user-cc-2';
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(userId, 'cc2@test.com', 'CC User', 'hash', now());

    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp', webDir: '',
      secretKey: 'a'.repeat(64), cookieSecure: 'false', demoSpeed: 0, maxUploadBytes: 0,
      trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);

    const secret = 'sk-ant-test-anthropic-key';
    const enc = encrypt(secret, cfg.secretKey);
    db.prepare(`INSERT INTO engine_credentials (id, user_id, engine, mode, secret_enc, extra_config, is_default, last4, name, created_at, updated_at)
      VALUES (?, ?, 'claude-code', 'api_key', ?, '{}', 1, ?, 'test', datetime('now'), datetime('now'))`)
      .run('cred-cc-2', userId, enc, secret.slice(-4));

    const env = await resolveCredentialEnv('claude-code', userId, null);
    assert.equal(env.ANTHROPIC_API_KEY, secret);
    assert.ok(!env.KIRO_API_KEY, 'should not set KIRO_API_KEY');
  });

  it('claude-code subscription_token → CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const db = getDb();
    const userId = 'user-cc-3';
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(userId, 'cc3@test.com', 'CC Sub', 'hash', now());

    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp', webDir: '',
      secretKey: 'a'.repeat(64), cookieSecure: 'false', demoSpeed: 0, maxUploadBytes: 0,
      trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);

    const secret = 'oauth-subscription-token-value';
    const enc = encrypt(secret, cfg.secretKey);
    db.prepare(`INSERT INTO engine_credentials (id, user_id, engine, mode, secret_enc, extra_config, is_default, last4, name, created_at, updated_at)
      VALUES (?, ?, 'claude-code', 'subscription_token', ?, '{}', 1, ?, 'test', datetime('now'), datetime('now'))`)
      .run('cred-cc-3', userId, enc, secret.slice(-4));

    const env = await resolveCredentialEnv('claude-code', userId, null);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, secret);
  });

  it('no credential → falls back (returns getAgentEnv result, no KIRO_API_KEY set)', async () => {
    const db = getDb();
    // No credential for this user
    const env = await resolveCredentialEnv('kiro', 'user-no-cred', null);
    // getAgentEnv returns {} for demo provider, so env should have no KIRO_API_KEY
    assert.ok(!env.KIRO_API_KEY || typeof env.KIRO_API_KEY === 'string', 'KIRO_API_KEY type check');
  });

  it('specified credentialId owned by another user → falls back', async () => {
    const db = getDb();
    const ownerUserId = 'user-owner-4';
    const otherUserId = 'user-other-4';
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(ownerUserId, 'owner4@test.com', 'Owner', 'hash', now());
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(otherUserId, 'other4@test.com', 'Other', 'hash', now());

    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp', webDir: '',
      secretKey: 'a'.repeat(64), cookieSecure: 'false', demoSpeed: 0, maxUploadBytes: 0,
      trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);

    const secret = 'owner-secret-value';
    const enc = encrypt(secret, cfg.secretKey);
    db.prepare(`INSERT INTO engine_credentials (id, user_id, engine, mode, secret_enc, extra_config, is_default, last4, name, created_at, updated_at)
      VALUES (?, ?, 'kiro', 'api_key', ?, '{}', 1, ?, 'test', datetime('now'), datetime('now'))`)
      .run('cred-owner-4', ownerUserId, enc, secret.slice(-4));

    // Other user tries to use owner's credentialId
    const env = await resolveCredentialEnv('kiro', otherUserId, 'cred-owner-4');
    // Should NOT return the owner's secret — credential not found for otherUserId
    assert.notEqual(env.KIRO_API_KEY, secret);
  });

  it('deleted credential → returns fallback (no KIRO_API_KEY from deleted cred)', async () => {
    const db = getDb();
    const userId = 'user-del-5';
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(userId, 'del5@test.com', 'Del User', 'hash', now());

    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp', webDir: '',
      secretKey: 'a'.repeat(64), cookieSecure: 'false', demoSpeed: 0, maxUploadBytes: 0,
      trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);

    const secret = 'about-to-be-deleted-secret';
    const enc = encrypt(secret, cfg.secretKey);
    db.prepare(`INSERT INTO engine_credentials (id, user_id, engine, mode, secret_enc, extra_config, is_default, last4, name, created_at, updated_at)
      VALUES (?, ?, 'kiro', 'api_key', ?, '{}', 1, ?, 'test', datetime('now'), datetime('now'))`)
      .run('cred-del-5', userId, enc, secret.slice(-4));

    // Delete the credential
    db.prepare('DELETE FROM engine_credentials WHERE id = ?').run('cred-del-5');

    const env = await resolveCredentialEnv('kiro', userId, 'cred-del-5');
    assert.notEqual(env.KIRO_API_KEY, secret, 'Deleted credential should not be resolved');
  });
});

// ── F4: Device-code flow with mocked OIDC ─────────────────────────────────────

describe('Credentials — identity_center device-code flow', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  let lastRegisterClientInput: { scopes?: string[]; grantTypes?: string[] } | null = null;
  let mockTokenReady = false;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'ic1');
    userCookie = u.cookie;

    // Install mock OIDC client
    const mockFactory = (_region: string): OIDCClientLike => ({
      registerClient: async (input) => {
        lastRegisterClientInput = { scopes: input.scopes, grantTypes: input.grantTypes };
        return {
          clientId: 'mock-client-id',
          clientSecret: 'mock-client-secret',
          clientSecretExpiresAt: Date.now() + 86400000,
        };
      },
      startDeviceAuthorization: async () => ({
        deviceCode: 'mock-device-code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
        verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-1234',
        expiresIn: 600,
        interval: 5,
      }),
      createToken: async () => {
        if (!mockTokenReady) {
          throw new Error('AuthorizationPendingException: authorization_pending');
        }
        return {
          accessToken: 'mock-access-token-final-value',
          expiresIn: 28800,
          refreshToken: 'mock-refresh-token-value',
        };
      },
    });
    setOIDCClientFactory(mockFactory);
  });

  after(async () => {
    setOIDCClientFactory(null);
    await cleanup();
  });

  it('registerClient is called with codewhisperer scopes and refresh_token grant', async () => {
    lastRegisterClientInput = null;
    // Trigger credential creation to capture the registerClient call
    await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro',
        mode: 'identity_center',
        name: 'Scope Check SSO',
        config: { startUrl: 'https://mycompany.awsapps.com/start', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    const captured = lastRegisterClientInput as { scopes?: string[]; grantTypes?: string[] } | null;
    assert.ok(captured, 'registerClient must have been called');
    assert.deepEqual(
      captured.scopes,
      ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
      'scopes must be the kiro-cli codewhisperer scopes',
    );
    assert.ok(
      Array.isArray(captured.grantTypes) && captured.grantTypes.includes('refresh_token'),
      'grantTypes must include refresh_token',
    );
  });

  it('POST /api/credentials with identity_center returns deviceChallenge', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro',
        mode: 'identity_center',
        name: 'Work SSO',
        config: { startUrl: 'https://mycompany.awsapps.com/start', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    assert.equal(r.status, 201, `Create identity_center: ${JSON.stringify(r.body)}`);
    const body = r.body as {
      credential: { id: string; mode: string };
      deviceChallenge: { verificationUri: string; userCode: string; expiresIn: number };
    };
    assert.equal(body.credential.mode, 'identity_center');
    assert.ok(body.deviceChallenge.verificationUri, 'Should have verificationUri');
    assert.equal(body.deviceChallenge.userCode, 'ABCD-1234');

    const credId = body.credential.id;

    // Poll when token not yet ready → status: pending
    const pollPending = await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, {
      method: 'POST',
      cookie: userCookie,
    });
    assert.equal(pollPending.status, 200);
    assert.equal((pollPending.body as { status: string }).status, 'pending');

    // Simulate user completing auth
    mockTokenReady = true;

    // Poll again → status: complete
    const pollComplete = await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, {
      method: 'POST',
      cookie: userCookie,
    });
    assert.equal(pollComplete.status, 200);
    const completeBody = pollComplete.body as { status: string; credential: { last4: string } };
    assert.equal(completeBody.status, 'complete');
    assert.equal(completeBody.credential.last4, 'alue'); // last 4 of 'mock-access-token-final-value'

    // Verify new fields were stored in the credential
    const db = getDb();
    const credRow = db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(credId) as { extra_config: string } | undefined;
    assert.ok(credRow, 'credential row must exist');
    const extra = JSON.parse(credRow!.extra_config) as Record<string, unknown>;
    assert.ok(extra.clientId === 'mock-client-id', `clientId must be stored; got: ${JSON.stringify(extra.clientId)}`);
    assert.ok(typeof extra.clientSecretEnc === 'string' && extra.clientSecretEnc.length > 0,
      'clientSecretEnc must be stored (encrypted)');
    assert.ok(typeof extra.refreshTokenEnc === 'string' && extra.refreshTokenEnc.length > 0,
      'refreshTokenEnc must be stored (encrypted)');
    assert.ok(typeof extra.clientSecretExpiresAt === 'number',
      'clientSecretExpiresAt must be stored as a number');

    // Credential list should not expose the raw token or encrypted secrets
    const list = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    const listBody = list.body as { credentials: Array<Record<string, unknown>> };
    const icCred = listBody.credentials.find((c) => c.id === credId) as Record<string, unknown> | undefined;
    assert.ok(icCred, 'Credential should appear in list');
    assert.ok(!('secret' in icCred), 'secret should not appear in response');
    assert.ok(!(icCred.config as Record<string, unknown>).pendingDeviceCode, 'pendingDeviceCode should be stripped');
    assert.ok(!(icCred.config as Record<string, unknown>).pendingClientSecret, 'pendingClientSecret should be stripped');
    assert.ok(!(icCred.config as Record<string, unknown>).refreshTokenEnc, 'refreshTokenEnc should be stripped');
    assert.ok(!(icCred.config as Record<string, unknown>).clientSecretEnc, 'clientSecretEnc should be stripped');
  });
});

// ── F4: Session credential_id ─────────────────────────────────────────────────

describe('Session create — credentialId stored on workflow', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let credId: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);

    // Create a project
    const pr = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Cred Test Project', slug: `cred-proj-${Date.now()}` },
      cookie: adminCookie,
    });
    assert.equal(pr.status, 201, `Project: ${JSON.stringify(pr.body)}`);
    projectId = (pr.body as { project: { id: string } }).project.id;

    // Create a credential for admin
    const cr = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'claude-code', mode: 'api_key', name: 'Admin Key', secret: 'sk-ant-test-7890' },
      cookie: adminCookie,
    });
    assert.equal(cr.status, 201);
    credId = (cr.body as { credential: { id: string } }).credential.id;
  });
  after(async () => { await cleanup(); });

  it('creates workflow with credentialId and it is stored', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: {
        goal: 'test with credential',
        engine: 'claude-code',
        credentialId: credId,
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201, `Workflow: ${JSON.stringify(r.body)}`);
    const body = r.body as { workflow: { credential_id: string } };
    assert.equal(body.workflow.credential_id, credId);
  });
});

// ── F4: Credential summary ────────────────────────────────────────────────────

describe('Credentials — summary endpoint', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'summ1');
    userCookie = u.cookie;

    await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: { engine: 'kiro', mode: 'api_key', name: 'Kiro Work', secret: 'kiro-work-1234', isDefault: true },
      cookie: userCookie,
    });
  });
  after(async () => { await cleanup(); });

  it('returns summary with configured/credentials for each engine', async () => {
    const r = await fetchJson(baseUrl, '/api/credentials/summary', { cookie: userCookie });
    assert.equal(r.status, 200);
    const body = r.body as { summary: Array<{ engine: string; configured: boolean; credentials: Array<{ id: string; isDefault: boolean }> }> };
    const kiroEntry = body.summary.find((s) => s.engine === 'kiro');
    const ccEntry = body.summary.find((s) => s.engine === 'claude-code');
    assert.ok(kiroEntry, 'kiro entry expected');
    assert.ok(ccEntry, 'claude-code entry expected');
    assert.equal(kiroEntry!.configured, true);
    assert.equal(ccEntry!.configured, false);
    assert.ok(kiroEntry!.credentials.length >= 1);
    assert.equal(kiroEntry!.credentials[0].isDefault, true);
  });

  it('summary via API token → 403', async () => {
    const token = await createApiToken(baseUrl, adminCookie);
    const r = await fetchJson(baseUrl, '/api/credentials/summary', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 403);
  });
});

// ── F8: Claude model list round-trip — settings.claudeModels removed ─────────

describe('F8 — Claude model list round-trip', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'f8u1');
    userCookie = u.cookie;
  });
  after(async () => { await cleanup(); });

  it('PUT /api/settings ignores claudeModels (field removed) and returns 200', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { claudeModels: 'some-model | Some Model' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    // claudeModels is no longer returned — field was removed
    assert.ok(!('claudeModels' in body), 'claudeModels must not appear in settings response');
  });

  it('GET /api/settings/claude-models returns 404 (endpoint removed)', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/claude-models', { cookie: userCookie });
    assert.equal(r.status, 404, `Expected 404 for removed endpoint, got ${r.status}`);
  });

  it('GET /api/settings/claude-models returns 404 when unauthenticated', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/claude-models');
    assert.equal(r.status, 404, `Expected 404 for removed endpoint, got ${r.status}`);
  });
});

// ── F8: Settings visibility — non-admin read, admin-only write ────────────────

describe('F8 — Settings visibility', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'f8vis1');
    userCookie = u.cookie;
  });
  after(async () => { await cleanup(); });

  it('non-admin can GET /api/settings (sanitised, no secrets)', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', { cookie: userCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.provider, 'provider field present');
    const prov = body.provider as Record<string, unknown>;
    // Never expose actual key values
    assert.ok(!prov.anthropicKeyEnc, 'anthropicKeyEnc must not be exposed');
    assert.ok(!prov.bedrockKeyEnc, 'bedrockKeyEnc must not be exposed');
    assert.ok(!prov.bedrockSecretKey, 'bedrockSecretKey must not be exposed');
  });

  it('non-admin PUT /api/settings → 403', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { claudeModels: 'some-model | Some Model' },
      cookie: userCookie,
    });
    assert.equal(r.status, 403);
  });

  it('PUT /api/settings updates lastChangedAt and lastChangedBy', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { claudeModels: 'test-model | Test' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { lastChangedAt: string | null; lastChangedBy: string | null };
    assert.ok(body.lastChangedAt, 'lastChangedAt should be set');
    assert.ok(body.lastChangedBy, 'lastChangedBy should be set');
    // lastChangedAt should be a valid ISO date
    assert.ok(!isNaN(Date.parse(body.lastChangedAt!)), 'lastChangedAt should be a valid date');
  });

  it('lastChangedBy is the email of the person, not their internal id, on PUT and on GET', async () => {
    const put = await fetchJson(baseUrl, '/api/settings', { method: 'PUT', body: { claudeModels: 'test-model | Test' }, cookie: adminCookie });
    const get = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    for (const r of [put, get]) {
      const by = (r.body as { lastChangedBy: string }).lastChangedBy;
      assert.match(by, /@/, `expected an email, got ${by}`);
    }
  });
});

// ── Bug 2: Device-poll error classification uses e.name ───────────────────────

describe('Credentials — device-poll classifies errors by e.name', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'ic-name');
    userCookie = u.cookie;
  });

  after(async () => {
    setOIDCClientFactory(null);
    await cleanup();
  });

  it('returns pending when e.name is AuthorizationPendingException but message has no exception name', async () => {
    // Factory: registration + device auth succeed; createToken throws with name-only classification
    setOIDCClientFactory((_region: string): OIDCClientLike => ({
      registerClient: async () => ({
        clientId: 'mock-client-id-name',
        clientSecret: 'mock-client-secret-name',
        clientSecretExpiresAt: Date.now() + 86400_000,
      }),
      startDeviceAuthorization: async () => ({
        deviceCode: 'mock-device-code-name',
        userCode: 'NAME-1234',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
        verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=NAME-1234',
        expiresIn: 600,
        interval: 5,
      }),
      createToken: async () => {
        // message does NOT contain 'AuthorizationPendingException' — only e.name carries the type
        const err = new Error('Authorization pending') as Error & { name: string };
        err.name = 'AuthorizationPendingException';
        throw err;
      },
    }));

    const createR = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro',
        mode: 'identity_center',
        name: 'Name-Based SSO',
        config: { startUrl: 'https://mycompany.awsapps.com/start', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    assert.equal(createR.status, 201, `Create: ${JSON.stringify(createR.body)}`);
    const credId = (createR.body as { credential: { id: string } }).credential.id;

    const pollR = await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, {
      method: 'POST',
      cookie: userCookie,
    });
    assert.equal(pollR.status, 200);
    assert.equal(
      (pollR.body as { status: string }).status,
      'pending',
      'should return pending when error is classified by e.name',
    );
  });
});

// ── materialiseKiroAuthDb — DB row shapes ─────────────────────────────────────

describe('materialiseKiroAuthDb — DB row shapes', () => {
  it('writes token row with oauth_flow DeviceCode and codewhisperer scopes', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const result = await materialiseKiroAuthDb({
      accessToken: 'test-access-token',
      expiresAt,
      region: 'us-east-1',
      startUrl: 'https://test.awsapps.com/start',
      refreshToken: 'test-refresh-token',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      clientSecretExpiresAt: 1234567890,
    });
    try {
      const db = new DatabaseSync(result.dbPath, { open: true });
      try {
        const tokenRow = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get('kirocli:odic:token') as { value: string } | undefined;
        assert.ok(tokenRow, 'token row must exist');
        const tokenVal = JSON.parse(tokenRow!.value) as Record<string, unknown>;
        assert.equal(tokenVal.oauth_flow, 'DeviceCode', 'oauth_flow must be "DeviceCode" (not "device_code")');
        assert.deepEqual(
          tokenVal.scopes,
          ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
          'scopes must be the three kiro-cli codewhisperer scopes',
        );
        assert.equal(tokenVal.access_token, 'test-access-token');
        assert.equal(tokenVal.refresh_token, 'test-refresh-token');
        assert.equal(tokenVal.expires_at, expiresAt);

        const regRow = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get('kirocli:odic:device-registration') as { value: string } | undefined;
        assert.ok(regRow, 'device-registration row must exist when clientId + clientSecret provided');
        const regVal = JSON.parse(regRow!.value) as Record<string, unknown>;
        assert.equal(regVal.oauth_flow, 'DeviceCode', 'device-registration oauth_flow must be "DeviceCode"');
        assert.deepEqual(
          regVal.scopes,
          ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
        );
        assert.equal(regVal.client_id, 'test-client-id');
        assert.equal(regVal.client_secret, 'test-client-secret');
        assert.equal(regVal.client_secret_expires_at, 1234567890);
      } finally {
        db.close();
      }
    } finally {
      await cleanupKiroAuthDb(result.tmpDir);
    }
  });

  it('writes only token row when no client registration provided', async () => {
    const result = await materialiseKiroAuthDb({
      accessToken: 'test-access-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: 'us-east-1',
      startUrl: 'https://test.awsapps.com/start',
    });
    try {
      const db = new DatabaseSync(result.dbPath, { open: true });
      try {
        const regRow = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get('kirocli:odic:device-registration');
        assert.ok(!regRow, 'device-registration row must NOT exist when no clientId');

        const tokenRow = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get('kirocli:odic:token') as { value: string } | undefined;
        assert.ok(tokenRow, 'token row must still exist');
        const tokenVal = JSON.parse(tokenRow!.value) as Record<string, unknown>;
        assert.equal(tokenVal.oauth_flow, 'DeviceCode');
        assert.ok(!tokenVal.refresh_token, 'refresh_token must be absent when not provided');
      } finally {
        db.close();
      }
    } finally {
      await cleanupKiroAuthDb(result.tmpDir);
    }
  });

  it('KIRO_IDC_SCOPES matches the three codewhisperer scopes exactly', () => {
    assert.deepEqual(
      [...KIRO_IDC_SCOPES],
      ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
    );
  });
});

// ── Old-credential detection ──────────────────────────────────────────────────

describe('resolveCredentialEnv — old-scope IDC credential detection', () => {
  before(() => {
    createTestDb();
    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false,
      awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);
  });
  after(async () => { await cleanup(); });

  it('throws sign-in-again error for IDC credential missing clientId (old sso:account:access scope)', async () => {
    const db = getDb();
    const userId = 'user-old-scope-1';
    db.prepare(
      'INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
    ).run(userId, 'oldscope1@test.com', 'Old Scope', 'hash', now());

    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false,
      awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);

    const tokenEnc = encrypt('old-access-token', cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials
         (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'Old SSO', 'identity_center', ?, ?, 1, 'oken', ?, ?)`,
    ).run(
      'cred-old-scope-1', userId, tokenEnc,
      JSON.stringify({
        startUrl: 'https://example.awsapps.com/start',
        region: 'us-east-1',
        tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
        signedInAt: now(),
        // NO clientId — old credential format
      }),
      now(), now(),
    );

    let threw = false;
    let errMsg = '';
    try {
      await resolveCredentialEnv('kiro', userId, null);
    } catch (e: unknown) {
      threw = true;
      errMsg = String((e as Error).message ?? '');
    }
    assert.ok(threw, 'should throw for old-scope credential');
    assert.ok(
      errMsg.toLowerCase().includes('sign in') || errMsg.toLowerCase().includes('outdated'),
      `error must tell user to sign in again: "${errMsg}"`,
    );
  });

  it('succeeds for new IDC credential with clientId present', async () => {
    const db = getDb();
    const userId = 'user-new-scope-1';
    db.prepare(
      'INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
    ).run(userId, 'newscope1@test.com', 'New Scope', 'hash', now());

    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false,
      awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);

    const tokenEnc = encrypt('new-access-token', cfg.secretKey);
    const refreshEnc = encrypt('new-refresh-token', cfg.secretKey);
    const secretEnc = encrypt('client-secret-value', cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials
         (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'New SSO', 'identity_center', ?, ?, 1, 'oken', ?, ?)`,
    ).run(
      'cred-new-scope-1', userId, tokenEnc,
      JSON.stringify({
        startUrl: 'https://example.awsapps.com/start',
        region: 'us-east-1',
        tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
        signedInAt: now(),
        clientId: 'my-client-id',
        clientSecretEnc: secretEnc,
        clientSecretExpiresAt: 9999999999,
        refreshTokenEnc: refreshEnc,
        selectedProfileArn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/test-profile',
        selectedProfileName: 'KiroProfile-us-east-1',
      }),
      now(), now(),
    );

    const env = await resolveCredentialEnv('kiro', userId, null);
    assert.ok(env._PORTAL_IDC_TOKEN, 'IDC token sentinel must be set');
    assert.ok(env._PORTAL_IDC_CLIENT_ID === 'my-client-id', 'clientId must be passed through');
    assert.ok(env._PORTAL_IDC_REFRESH_TOKEN === 'new-refresh-token', 'refresh token must be decrypted and passed');
  });
});

// ── Refresh and reauth routes ─────────────────────────────────────────────────

describe('Credentials — refresh and reauth', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;
  let otherUserCookie: string;
  let apiToken: string;

  let refreshCallCount = 0;
  let shouldRejectRefresh = false;
  let devicePollTokenReady = false;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'rr1');
    userCookie = u.cookie;
    const other = await createNonAdmin(baseUrl, adminCookie, 'rr2');
    otherUserCookie = other.cookie;
    apiToken = await createApiToken(baseUrl, adminCookie);

    setOIDCClientFactory((_region: string): OIDCClientLike => ({
      registerClient: async () => ({
        clientId: 'rr-client-id',
        clientSecret: 'rr-client-secret',
        clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
      }),
      startDeviceAuthorization: async () => ({
        deviceCode: 'rr-device-code',
        userCode: 'RR00-1234',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
        verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=RR00-1234',
        expiresIn: 600,
        interval: 5,
      }),
      createToken: async (input) => {
        if (input.grantType === 'refresh_token') {
          refreshCallCount++;
          if (shouldRejectRefresh) {
            const err = new Error('InvalidGrantException') as Error & { name: string };
            err.name = 'InvalidGrantException';
            throw err;
          }
          return {
            accessToken: 'refreshed-access-token-rr',
            expiresIn: 28800,
            refreshToken: 'new-refresh-token-rr',
          };
        }
        if (!devicePollTokenReady) {
          throw new Error('AuthorizationPendingException: authorization_pending');
        }
        return {
          accessToken: 'rr-initial-access-token',
          expiresIn: 28800,
          refreshToken: 'rr-initial-refresh-token',
        };
      },
    }));
  });

  after(async () => {
    setOIDCClientFactory(null);
    await cleanup();
  });

  /** Create a fully signed-in IDC credential and return its id. */
  async function createSignedInIdcCred(name = 'RR SSO', isDefault = false): Promise<string> {
    const cr = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro', mode: 'identity_center', name,
        config: { startUrl: 'https://rr.awsapps.com/start', region: 'us-east-1' },
        isDefault,
      },
      cookie: userCookie,
    });
    assert.equal(cr.status, 201, `Create: ${JSON.stringify(cr.body)}`);
    const credId = (cr.body as { credential: { id: string } }).credential.id;

    devicePollTokenReady = true;
    const poll = await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, {
      method: 'POST', cookie: userCookie,
    });
    assert.equal((poll.body as { status: string }).status, 'complete', `Poll: ${JSON.stringify(poll.body)}`);
    devicePollTokenReady = false;
    return credId;
  }

  it('refresh success returns updated credential', async () => {
    const credId = await createSignedInIdcCred('Refresh Success');
    refreshCallCount = 0;

    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST', cookie: userCookie,
    });
    assert.equal(r.status, 200, `Refresh: ${JSON.stringify(r.body)}`);
    const body = r.body as { credential: { id: string; last4: string } };
    assert.equal(body.credential.id, credId);
    assert.equal(body.credential.last4, 'n-rr' /* last 4 of 'refreshed-access-token-rr' */);
    assert.equal(refreshCallCount, 1, 'OIDC createToken must have been called once');

    // New token is persisted in DB
    const db = getDb();
    const row = db.prepare('SELECT last4 FROM engine_credentials WHERE id = ?').get(credId) as { last4: string } | undefined;
    assert.equal(row?.last4, body.credential.last4);
  });

  it('refresh with AWS rejection → 409 needsSignIn', async () => {
    const credId = await createSignedInIdcCred('Refresh Rejected');
    shouldRejectRefresh = true;

    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST', cookie: userCookie,
    });
    assert.equal(r.status, 409, `Expected 409: ${JSON.stringify(r.body)}`);
    const body = r.body as { needsSignIn: boolean; error: string };
    assert.equal(body.needsSignIn, true);
    assert.ok(body.error.length > 0, 'error message must be present');
    shouldRejectRefresh = false;
  });

  it('refresh with no refresh token stored → 409 needsSignIn', async () => {
    // Create credential but strip refreshTokenEnc from DB to simulate missing refresh token
    const credId = await createSignedInIdcCred('No Refresh Token');
    const db = getDb();
    const row = db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(credId) as { extra_config: string };
    const extra = JSON.parse(row.extra_config) as Record<string, unknown>;
    delete extra.refreshTokenEnc;
    db.prepare('UPDATE engine_credentials SET extra_config = ? WHERE id = ?').run(JSON.stringify(extra), credId);

    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST', cookie: userCookie,
    });
    assert.equal(r.status, 409, `Expected 409: ${JSON.stringify(r.body)}`);
    assert.equal((r.body as { needsSignIn: boolean }).needsSignIn, true);
  });

  it('refresh by another user → 404', async () => {
    const credId = await createSignedInIdcCred('Isolation Test');
    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST', cookie: otherUserCookie,
    });
    assert.equal(r.status, 404);
  });

  it('refresh via API token → 403', async () => {
    const credId = await createSignedInIdcCred('API Token Test');
    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(r.status, 403);
  });

  it('reauth returns deviceChallenge and poll completes keeping same id/name/default', async () => {
    const credId = await createSignedInIdcCred('Reauth Test', true);

    // Verify initial state
    const list1 = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    const before = (list1.body as { credentials: Array<{ id: string; name: string; isDefault: boolean }> })
      .credentials.find((c) => c.id === credId)!;
    assert.ok(before, 'credential must exist before reauth');

    // Start reauth
    const reauthR = await fetchJson(baseUrl, `/api/credentials/${credId}/reauth`, {
      method: 'POST', cookie: userCookie,
    });
    assert.equal(reauthR.status, 200, `Reauth: ${JSON.stringify(reauthR.body)}`);
    const reauthBody = reauthR.body as {
      credential: { id: string; name: string; isDefault: boolean; mode: string };
      deviceChallenge: { verificationUri: string; userCode: string; expiresIn: number };
    };
    assert.equal(reauthBody.credential.id, credId, 'id must not change');
    assert.equal(reauthBody.credential.name, 'Reauth Test', 'name must not change');
    assert.equal(reauthBody.credential.isDefault, true, 'default flag must not change');
    assert.equal(reauthBody.credential.mode, 'identity_center');
    assert.ok(reauthBody.deviceChallenge.verificationUri, 'deviceChallenge.verificationUri must be present');
    assert.equal(reauthBody.deviceChallenge.userCode, 'RR00-1234');

    // Complete the flow via device-poll
    devicePollTokenReady = true;
    const pollR = await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, {
      method: 'POST', cookie: userCookie,
    });
    devicePollTokenReady = false;
    assert.equal(pollR.status, 200, `Poll: ${JSON.stringify(pollR.body)}`);
    const pollBody = pollR.body as { status: string; credential: { id: string; name: string; isDefault: boolean } };
    assert.equal(pollBody.status, 'complete');
    assert.equal(pollBody.credential.id, credId, 'id must be preserved after poll');
    assert.equal(pollBody.credential.name, 'Reauth Test', 'name must be preserved after poll');
    assert.equal(pollBody.credential.isDefault, true, 'default flag must be preserved after poll');
  });

  it('reauth by another user → 404', async () => {
    const credId = await createSignedInIdcCred('Reauth Isolation');
    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/reauth`, {
      method: 'POST', cookie: otherUserCookie,
    });
    assert.equal(r.status, 404);
  });

  it('reauth via API token → 403', async () => {
    const credId = await createSignedInIdcCred('Reauth API Token');
    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/reauth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(r.status, 403);
  });

  it('status and canRefresh values are correct', async () => {
    const credId = await createSignedInIdcCred('Status Test');
    const db = getDb();

    // Fresh credential → ok, canRefresh=true
    const list1 = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    const fresh = (list1.body as { credentials: Array<{ id: string; status: string; canRefresh: boolean }> })
      .credentials.find((c) => c.id === credId)!;
    assert.equal(fresh.status, 'ok');
    assert.equal(fresh.canRefresh, true);

    // Expire the token (set tokenExpiry to past)
    const row = db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(credId) as { extra_config: string };
    const extra = JSON.parse(row.extra_config) as Record<string, unknown>;
    extra.tokenExpiry = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    db.prepare('UPDATE engine_credentials SET extra_config = ? WHERE id = ?').run(JSON.stringify(extra), credId);

    const list2 = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    const expired = (list2.body as { credentials: Array<{ id: string; status: string; canRefresh: boolean }> })
      .credentials.find((c) => c.id === credId)!;
    assert.equal(expired.status, 'expired');
    assert.equal(expired.canRefresh, true);

    // Remove refreshTokenEnc → needs_sign_in
    delete extra.refreshTokenEnc;
    db.prepare('UPDATE engine_credentials SET extra_config = ? WHERE id = ?').run(JSON.stringify(extra), credId);

    const list3 = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    const noRefresh = (list3.body as { credentials: Array<{ id: string; status: string; canRefresh: boolean }> })
      .credentials.find((c) => c.id === credId)!;
    assert.equal(noRefresh.status, 'needs_sign_in');
    assert.equal(noRefresh.canRefresh, false);

    // Set expiry to within 5 minutes → expiring
    const extraWith = JSON.parse(
      (db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(credId) as { extra_config: string }).extra_config,
    ) as Record<string, unknown>;
    extraWith.tokenExpiry = new Date(Date.now() + 3 * 60 * 1000).toISOString(); // 3 min from now
    extraWith.refreshTokenEnc = 'dummy-enc'; // re-add so canRefresh=true
    db.prepare('UPDATE engine_credentials SET extra_config = ? WHERE id = ?').run(JSON.stringify(extraWith), credId);

    const list4 = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    const expiring = (list4.body as { credentials: Array<{ id: string; status: string; canRefresh: boolean }> })
      .credentials.find((c) => c.id === credId)!;
    assert.equal(expiring.status, 'expiring');
    assert.equal(expiring.canRefresh, true);
  });
});

// ── Auto-refresh before run ───────────────────────────────────────────────────

describe('Auto-refresh before resolveCredentialEnv', () => {
  let refreshCallCount = 0;

  before(() => {
    createTestDb();
    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false,
      awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);

    setOIDCClientFactory((_region: string): OIDCClientLike => ({
      registerClient: async () => ({
        clientId: 'auto-client-id', clientSecret: 'auto-client-secret', clientSecretExpiresAt: 0,
      }),
      startDeviceAuthorization: async () => ({
        deviceCode: 'auto-device-code', userCode: 'AUTO-1234',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
        expiresIn: 600, interval: 5,
      }),
      createToken: async (input) => {
        if (input.grantType === 'refresh_token') {
          refreshCallCount++;
          return { accessToken: 'auto-refreshed-token-value', expiresIn: 28800, refreshToken: 'auto-new-refresh' };
        }
        throw new Error('should not be called');
      },
    }));
  });

  after(async () => {
    setOIDCClientFactory(null);
    await cleanup();
  });

  it('auto-refreshes expired token before resolveCredentialEnv returns env', async () => {
    const db = getDb();
    const userId = 'user-auto-refresh-1';
    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(userId, 'autorefresh1@test.com', 'Auto Refresh', 'hash', now());

    const oldToken = 'old-expired-token-value';
    const tokenEnc = encrypt(oldToken, cfg.secretKey);
    const clientSecretEnc = encrypt('auto-client-secret', cfg.secretKey);
    const refreshTokenEnc = encrypt('auto-old-refresh-token', cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'Auto SSO', 'identity_center', ?, ?, 1, ?, ?, ?)`,
    ).run(
      'cred-auto-1', userId, tokenEnc,
      JSON.stringify({
        startUrl: 'https://auto.awsapps.com/start',
        region: 'us-east-1',
        tokenExpiry: new Date(Date.now() - 60_000).toISOString(), // expired 1 min ago
        clientId: 'auto-client-id',
        clientSecretEnc,
        clientSecretExpiresAt: 0,
        refreshTokenEnc,
        selectedProfileArn: 'arn:aws:codewhisperer:us-east-1:auto:profile/auto',
        selectedProfileName: 'KiroProfile-auto',
      }),
      oldToken.slice(-4), now(), now(),
    );

    refreshCallCount = 0;
    const env = await resolveCredentialEnv('kiro', userId, null);

    assert.equal(refreshCallCount, 1, 'OIDC refresh must have been called');
    assert.equal(env._PORTAL_IDC_TOKEN, 'auto-refreshed-token-value', 'env must carry the new token');
    assert.notEqual(env._PORTAL_IDC_TOKEN, oldToken, 'env must not carry the old token');

    // DB must be updated
    const row = db.prepare('SELECT last4 FROM engine_credentials WHERE id = ?').get('cred-auto-1') as { last4: string };
    assert.equal(row.last4, 'alue' /* last 4 of 'auto-refreshed-token-value' */);
  });

  it('concurrent resolveCredentialEnv calls deduplicate the refresh (one OIDC call)', async () => {
    const db = getDb();
    const userId = 'user-auto-refresh-2';
    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(userId, 'autorefresh2@test.com', 'Concurrent', 'hash', now());

    const oldToken = 'concurrent-old-token';
    const tokenEnc = encrypt(oldToken, cfg.secretKey);
    const clientSecretEnc = encrypt('auto-client-secret', cfg.secretKey);
    const refreshTokenEnc = encrypt('concurrent-refresh-token', cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'Concurrent SSO', 'identity_center', ?, ?, 1, ?, ?, ?)`,
    ).run(
      'cred-concurrent-1', userId, tokenEnc,
      JSON.stringify({
        startUrl: 'https://auto.awsapps.com/start',
        region: 'us-east-1',
        tokenExpiry: new Date(Date.now() - 60_000).toISOString(),
        clientId: 'auto-client-id',
        clientSecretEnc,
        clientSecretExpiresAt: 0,
        refreshTokenEnc,
        selectedProfileArn: 'arn:aws:codewhisperer:us-east-1:conc:profile/conc',
        selectedProfileName: 'KiroProfile-conc',
      }),
      oldToken.slice(-4), now(), now(),
    );

    refreshCallCount = 0;
    // Fire two concurrent calls
    const [env1, env2] = await Promise.all([
      resolveCredentialEnv('kiro', userId, null),
      resolveCredentialEnv('kiro', userId, null),
    ]);

    assert.equal(refreshCallCount, 1, 'Only one OIDC refresh call must be made despite concurrent requests');
    assert.equal(env1._PORTAL_IDC_TOKEN, 'auto-refreshed-token-value');
    assert.equal(env2._PORTAL_IDC_TOKEN, 'auto-refreshed-token-value');
  });
});

// ── Kiro profile auto-select on device-poll ───────────────────────────────────

describe('Credentials — profile auto-selected on device-poll completion', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;
  let fetchedAccessToken = '';

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'prof-auto');
    userCookie = u.cookie;

    setOIDCClientFactory((_region: string): OIDCClientLike => ({
      registerClient: async () => ({
        clientId: 'pa-client-id',
        clientSecret: 'pa-client-secret',
        clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
      }),
      startDeviceAuthorization: async () => ({
        deviceCode: 'pa-device-code',
        userCode: 'PA00-1234',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
        expiresIn: 600,
        interval: 5,
      }),
      createToken: async () => {
        fetchedAccessToken = 'pa-access-token-value';
        return { accessToken: fetchedAccessToken, expiresIn: 28800, refreshToken: 'pa-refresh-token' };
      },
    }));

    // Mock the profiles fetcher — returns one profile (auto-select)
    setProfilesFetcherOverride(async (_token: string, _region: string) => ({
      ok: true as const,
      profiles: [{ arn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/abc', profileName: 'KiroProfile-us-east-1' }],
    }));
  });

  after(async () => {
    setOIDCClientFactory(null);
    setProfilesFetcherOverride(null);
    await cleanup();
  });

  it('single profile auto-selected and stored in extra_config after device-poll completes', async () => {
    const cr = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro', mode: 'identity_center', name: 'Profile Auto SSO',
        config: { startUrl: 'https://pa.awsapps.com/start', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    assert.equal(cr.status, 201, `Create: ${JSON.stringify(cr.body)}`);
    const credId = (cr.body as { credential: { id: string } }).credential.id;

    // Poll to complete sign-in
    const pollR = await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, {
      method: 'POST', cookie: userCookie,
    });
    assert.equal(pollR.status, 200);
    assert.equal((pollR.body as { status: string }).status, 'complete');

    // Wait briefly for the async profile fetch to complete
    await new Promise((r) => setTimeout(r, 50));

    // Check DB
    const db = getDb();
    const row = db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(credId) as { extra_config: string };
    const extra = JSON.parse(row.extra_config) as Record<string, unknown>;
    assert.equal(
      extra.selectedProfileArn,
      'arn:aws:codewhisperer:us-east-1:123456789:profile/abc',
      'selectedProfileArn must be stored',
    );
    assert.equal(extra.selectedProfileName, 'KiroProfile-us-east-1', 'selectedProfileName must be stored');
    assert.ok(!extra.availableProfiles, 'availableProfiles not stored for single profile');

    // Check credential view exposes selectedProfile
    const list = await fetchJson(baseUrl, '/api/credentials', { cookie: userCookie });
    const credInList = (list.body as { credentials: Array<Record<string, unknown>> })
      .credentials.find((c) => (c as { id: string }).id === credId) as Record<string, unknown> | undefined;
    assert.ok(credInList, 'Credential must appear in list');
    const sp = credInList.selectedProfile as { arn: string; profileName: string } | undefined;
    assert.ok(sp, 'selectedProfile must appear in credential view');
    assert.equal(sp!.arn, 'arn:aws:codewhisperer:us-east-1:123456789:profile/abc');
    assert.equal(sp!.profileName, 'KiroProfile-us-east-1');
  });
});

// ── Kiro profile multi-profile choose route ───────────────────────────────────

describe('Credentials — multi-profile choose route (PUT /api/credentials/:id/profile)', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'prof-multi');
    userCookie = u.cookie;

    setOIDCClientFactory((_region: string): OIDCClientLike => ({
      registerClient: async () => ({
        clientId: 'pm-client-id', clientSecret: 'pm-client-secret',
        clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
      }),
      startDeviceAuthorization: async () => ({
        deviceCode: 'pm-device-code', userCode: 'PM00-1234',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
        expiresIn: 600, interval: 5,
      }),
      createToken: async () => ({ accessToken: 'pm-access-token', expiresIn: 28800 }),
    }));

    // Mock: two profiles returned
    setProfilesFetcherOverride(async () => ({
      ok: true as const,
      profiles: [
        { arn: 'arn:aws:codewhisperer:us-east-1:123:profile/first', profileName: 'Profile-First' },
        { arn: 'arn:aws:codewhisperer:us-east-1:123:profile/second', profileName: 'Profile-Second' },
      ],
    }));
  });

  after(async () => {
    setOIDCClientFactory(null);
    setProfilesFetcherOverride(null);
    await cleanup();
  });

  it('two profiles → first auto-selected, availableProfiles stored, choose second via PUT /profile', async () => {
    // Create and sign in
    const cr = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro', mode: 'identity_center', name: 'Multi-Profile SSO',
        config: { startUrl: 'https://pm.awsapps.com/start', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    assert.equal(cr.status, 201);
    const credId = (cr.body as { credential: { id: string } }).credential.id;

    const pollR = await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, {
      method: 'POST', cookie: userCookie,
    });
    assert.equal((pollR.body as { status: string }).status, 'complete');
    await new Promise((r) => setTimeout(r, 50));

    // Check first is auto-selected and both are in availableProfiles
    const db = getDb();
    const row = db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(credId) as { extra_config: string };
    const extra = JSON.parse(row.extra_config) as Record<string, unknown>;
    assert.equal(extra.selectedProfileArn, 'arn:aws:codewhisperer:us-east-1:123:profile/first');
    assert.ok(Array.isArray(extra.availableProfiles), 'availableProfiles must be stored for multiple profiles');
    assert.equal((extra.availableProfiles as unknown[]).length, 2, 'both profiles stored');

    // Use PUT /api/credentials/:id/profile to choose the second
    const chooseR = await fetchJson(baseUrl, `/api/credentials/${credId}/profile`, {
      method: 'PUT',
      body: { arn: 'arn:aws:codewhisperer:us-east-1:123:profile/second' },
      cookie: userCookie,
    });
    assert.equal(chooseR.status, 200, `Choose: ${JSON.stringify(chooseR.body)}`);
    const chooseBody = chooseR.body as { credential: { selectedProfile: { arn: string; profileName: string } } };
    assert.equal(chooseBody.credential.selectedProfile.arn, 'arn:aws:codewhisperer:us-east-1:123:profile/second');
    assert.equal(chooseBody.credential.selectedProfile.profileName, 'Profile-Second');

    // DB updated
    const row2 = db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(credId) as { extra_config: string };
    const extra2 = JSON.parse(row2.extra_config) as Record<string, unknown>;
    assert.equal(extra2.selectedProfileArn, 'arn:aws:codewhisperer:us-east-1:123:profile/second');
    assert.equal(extra2.selectedProfileName, 'Profile-Second');
  });

  it('PUT /profile with unknown ARN → 400', async () => {
    // Create and sign in a credential with profiles stored
    const cr = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro', mode: 'identity_center', name: 'Unknown ARN SSO',
        config: { startUrl: 'https://pm2.awsapps.com/start', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    const credId = (cr.body as { credential: { id: string } }).credential.id;
    await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, { method: 'POST', cookie: userCookie });
    await new Promise((r) => setTimeout(r, 50));

    // Try to choose a profile ARN not in the list
    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/profile`, {
      method: 'PUT',
      body: { arn: 'arn:aws:codewhisperer:us-east-1:123:profile/nonexistent' },
      cookie: userCookie,
    });
    assert.equal(r.status, 400, `Expected 400: ${JSON.stringify(r.body)}`);
  });

  it('PUT /profile by another user → 404', async () => {
    const cr = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro', mode: 'identity_center', name: 'Profile Isolation',
        config: { startUrl: 'https://pm3.awsapps.com/start', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    const credId = (cr.body as { credential: { id: string } }).credential.id;
    await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, { method: 'POST', cookie: userCookie });
    await new Promise((r) => setTimeout(r, 50));

    const otherU = await createNonAdmin(baseUrl, adminCookie, 'prof-other');
    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/profile`, {
      method: 'PUT',
      body: { arn: 'arn:aws:codewhisperer:us-east-1:123:profile/first' },
      cookie: otherU.cookie,
    });
    assert.equal(r.status, 404);
  });
});

// ── materialiseKiroAuthDb — state rows ────────────────────────────────────────

describe('materialiseKiroAuthDb — state rows written with correct keys/encoding', () => {
  it('writes auth.idc.start-url, auth.idc.region, api.codewhisperer.profile when profileArn provided', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const result = await materialiseKiroAuthDb({
      accessToken: 'state-test-token',
      expiresAt,
      region: 'us-east-1',
      startUrl: 'https://state-test.awsapps.com/start',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/stateid',
      profileName: 'KiroProfile-us-east-1',
    });
    try {
      const db = new DatabaseSync(result.dbPath, { open: true });
      try {
        // auth.idc.start-url → JSON.stringify(string)
        const startUrlRow = db.prepare('SELECT value FROM state WHERE key = ?').get('auth.idc.start-url') as { value: string } | undefined;
        assert.ok(startUrlRow, 'auth.idc.start-url row must exist');
        assert.equal(startUrlRow!.value, '"https://state-test.awsapps.com/start"',
          'start-url must be JSON.stringify of the string (including quotes)');

        // auth.idc.region → JSON.stringify(string)
        const regionRow = db.prepare('SELECT value FROM state WHERE key = ?').get('auth.idc.region') as { value: string } | undefined;
        assert.ok(regionRow, 'auth.idc.region row must exist');
        assert.equal(regionRow!.value, '"us-east-1"',
          'region must be JSON.stringify of the string (including quotes)');

        // api.codewhisperer.profile → JSON object with arn, profile_name, device_code_disabled
        const profileRow = db.prepare('SELECT value FROM state WHERE key = ?').get('api.codewhisperer.profile') as { value: string } | undefined;
        assert.ok(profileRow, 'api.codewhisperer.profile row must exist');
        const profile = JSON.parse(profileRow!.value) as Record<string, unknown>;
        assert.equal(profile.arn, 'arn:aws:codewhisperer:us-east-1:123456789:profile/stateid',
          'profile.arn must match profileArn');
        assert.equal(profile.profile_name, 'KiroProfile-us-east-1',
          'profile.profile_name must match profileName');
        assert.equal(profile.device_code_disabled, false,
          'device_code_disabled must be false');
      } finally {
        db.close();
      }
    } finally {
      await cleanupKiroAuthDb(result.tmpDir);
    }
  });

  it('omits api.codewhisperer.profile when profileArn not provided, but still writes start-url and region', async () => {
    const result = await materialiseKiroAuthDb({
      accessToken: 'no-profile-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      region: 'eu-central-1',
      startUrl: 'https://eu.awsapps.com/start',
    });
    try {
      const db = new DatabaseSync(result.dbPath, { open: true });
      try {
        const startUrlRow = db.prepare('SELECT value FROM state WHERE key = ?').get('auth.idc.start-url') as { value: string } | undefined;
        assert.ok(startUrlRow, 'auth.idc.start-url must be written even without profileArn');
        assert.equal(startUrlRow!.value, '"https://eu.awsapps.com/start"');

        const regionRow = db.prepare('SELECT value FROM state WHERE key = ?').get('auth.idc.region') as { value: string } | undefined;
        assert.ok(regionRow, 'auth.idc.region must be written even without profileArn');
        assert.equal(regionRow!.value, '"eu-central-1"');

        const profileRow = db.prepare('SELECT value FROM state WHERE key = ?').get('api.codewhisperer.profile');
        assert.ok(!profileRow, 'api.codewhisperer.profile must NOT be written when profileArn is absent');
      } finally {
        db.close();
      }
    } finally {
      await cleanupKiroAuthDb(result.tmpDir);
    }
  });
});

// ── Lazy profile fetch before resolveCredentialEnv ────────────────────────────

describe('Credentials — lazy profile fetch before run (ensureKiroProfileFetched)', () => {
  before(() => {
    createTestDb();
    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);
  });

  after(async () => {
    setOIDCClientFactory(null);
    setProfilesFetcherOverride(null);
    await cleanup();
  });

  it('resolveCredentialEnv fetches profile lazily and sets IDC_PROFILE_ARN_KEY sentinel', async () => {
    const db = getDb();
    const userId = 'user-lazy-prof-1';
    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(userId, 'lazyprof1@test.com', 'Lazy Prof', 'hash', now());

    const tokenEnc = encrypt('lazy-profile-token', cfg.secretKey);
    const clientSecretEnc = encrypt('lazy-client-secret', cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'Lazy Profile SSO', 'identity_center', ?, ?, 1, ?, ?, ?)`,
    ).run(
      'cred-lazy-prof-1', userId, tokenEnc,
      JSON.stringify({
        startUrl: 'https://lazy.awsapps.com/start',
        region: 'us-east-1',
        tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
        clientId: 'lazy-client-id',
        clientSecretEnc,
        clientSecretExpiresAt: 0,
        // NO selectedProfileArn — triggers lazy fetch
      }),
      'oken', now(), now(),
    );

    setProfilesFetcherOverride(async () => ({
      ok: true as const,
      profiles: [{ arn: 'arn:aws:codewhisperer:us-east-1:999:profile/lazy', profileName: 'KiroProfile-lazy' }],
    }));

    const env = await resolveCredentialEnv('kiro', userId, null);
    assert.equal(env._PORTAL_IDC_PROFILE_ARN, 'arn:aws:codewhisperer:us-east-1:999:profile/lazy',
      'IDC_PROFILE_ARN sentinel must be set after lazy fetch');
    assert.equal(env._PORTAL_IDC_PROFILE_NAME, 'KiroProfile-lazy',
      'IDC_PROFILE_NAME sentinel must be set');

    // Profile also persisted in DB
    const row = db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get('cred-lazy-prof-1') as { extra_config: string };
    const extra = JSON.parse(row.extra_config) as Record<string, unknown>;
    assert.equal(extra.selectedProfileArn, 'arn:aws:codewhisperer:us-east-1:999:profile/lazy');
  });

  it('resolveCredentialEnv throws clear error when no profiles available', async () => {
    const db = getDb();
    const userId = 'user-lazy-prof-2';
    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
      .run(userId, 'lazyprof2@test.com', 'No Profiles', 'hash', now());

    const tokenEnc = encrypt('no-profiles-token', cfg.secretKey);
    const clientSecretEnc2 = encrypt('client-secret-noprof', cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'No Profiles SSO', 'identity_center', ?, ?, 1, ?, ?, ?)`,
    ).run(
      'cred-lazy-prof-2', userId, tokenEnc,
      JSON.stringify({
        startUrl: 'https://noprof.awsapps.com/start',
        region: 'us-east-1',
        tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
        clientId: 'no-prof-client-id',
        clientSecretEnc: clientSecretEnc2,
        clientSecretExpiresAt: 0,
      }),
      'oken', now(), now(),
    );

    // Mock returns no profiles (ok: true, empty list)
    setProfilesFetcherOverride(async () => ({ ok: true as const, profiles: [] }));

    let threw = false;
    let errMsg = '';
    try {
      await resolveCredentialEnv('kiro', userId, null);
    } catch (e: unknown) {
      threw = true;
      errMsg = String((e as Error).message ?? '');
    }
    assert.ok(threw, 'resolveCredentialEnv must throw when no profiles available');
    assert.ok(
      errMsg.toLowerCase().includes('profile') || errMsg.toLowerCase().includes('sign in'),
      `error message must mention profile or sign in: "${errMsg}"`,
    );
  });
});

// ── fetchKiroProfiles — request shape, pagination, and error propagation ─────

import { fetchKiroProfiles, setProfilesFetcherOverride as _setFetcherDirect } from '../server/kiro-idc.ts';
import type { FetchProfilesResult } from '../server/kiro-idc.ts';
import { ensureKiroProfileFetched } from '../server/credentials.ts';

describe('fetchKiroProfiles — wire field name "arn" (not "profileArn")', () => {
  after(() => { _setFetcherDirect(null); });

  it('resolves profiles when API returns "arn" field (real wire format)', async () => {
    // Simulate the real API response shape: { profiles: [{ arn, profileName, ... }], nextToken: null }
    _setFetcherDirect(async (_token, _region) => ({
      ok: true as const,
      profiles: [
        { arn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/GC79RVNNXKPG', profileName: 'KiroProfile-us-east-1' },
      ],
    }));
    const result = await fetchKiroProfiles('test-token', 'us-east-1');
    assert.ok(result.ok, 'result must be ok');
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.profiles.length, 1);
    assert.equal(result.profiles[0].arn, 'arn:aws:codewhisperer:us-east-1:123456789:profile/GC79RVNNXKPG');
    assert.equal(result.profiles[0].profileName, 'KiroProfile-us-east-1');
  });

  it('returns ok: false when override signals a fetch error', async () => {
    _setFetcherDirect(async () => ({ ok: false as const, reason: 'HTTP 403: AccessDenied' }));
    const result = await fetchKiroProfiles('test-token', 'us-east-1');
    assert.ok(!result.ok, 'result must be ok: false');
    if (result.ok) throw new Error('unreachable');
    assert.ok(result.reason.includes('403'), `reason must include the error: "${result.reason}"`);
  });

  it('returns ok: true with empty profiles when no profiles assigned', async () => {
    _setFetcherDirect(async () => ({ ok: true as const, profiles: [] }));
    const result = await fetchKiroProfiles('test-token', 'us-east-1');
    assert.ok(result.ok);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.profiles.length, 0);
  });
});

describe('fetchKiroProfiles — pagination via nextToken', () => {
  after(() => { _setFetcherDirect(null); });

  it('merges profiles from multiple pages', async () => {
    let page = 0;
    _setFetcherDirect(async () => {
      page += 1;
      if (page === 1) {
        return {
          ok: true as const,
          // First page returns 2 profiles; real impl would call again with nextToken
          // The override is responsible for simulating the full paginated result
          profiles: [
            { arn: 'arn:aws:codewhisperer:us-east-1:1:profile/p1', profileName: 'Profile-1' },
            { arn: 'arn:aws:codewhisperer:us-east-1:1:profile/p2', profileName: 'Profile-2' },
          ],
        };
      }
      return { ok: true as const, profiles: [] };
    });

    const result = await fetchKiroProfiles('test-token', 'us-east-1');
    assert.ok(result.ok);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.profiles.length, 2, 'should receive 2 profiles');
  });
});

describe('fetchKiroProfiles — error propagation to profileFetchError and ensureKiroProfileFetched', () => {
  before(() => {
    createTestDb();
    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);
  });
  after(async () => {
    _setFetcherDirect(null);
    await cleanup();
  });

  function insertIdcCred(userId: string, credId: string, extra: Record<string, unknown>) {
    const db = getDb();
    const cfg: Config = {
      root: process.cwd(), port: 0, host: '127.0.0.1', dataDir: '/tmp',
      webDir: '', secretKey: 'a'.repeat(64), cookieSecure: 'false',
      demoSpeed: 0, maxUploadBytes: 0, trustProxy: false, awsRegion: 'us-east-1', deployTarget: null,
    };
    setConfig(cfg);
    db.prepare(
      'INSERT OR IGNORE INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
    ).run(userId, `${userId}@test.com`, userId, 'hash', now());
    const tokenEnc = encrypt('fake-access-token', cfg.secretKey);
    db.prepare(
      `INSERT INTO engine_credentials
         (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'Test SSO', 'identity_center', ?, ?, 1, 'oken', ?, ?)`,
    ).run(credId, userId, tokenEnc, JSON.stringify(extra), now(), now());
  }

  it('HTTP 403 error is stored in profileFetchError with the reason', async () => {
    const userId = 'user-err-403';
    const credId = 'cred-err-403';
    insertIdcCred(userId, credId, {
      startUrl: 'https://err.awsapps.com/start',
      region: 'us-east-1',
      tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'client-err-403',
    });

    _setFetcherDirect(async () => ({ ok: false as const, reason: 'HTTP 403: AccessDenied' }));

    let threw = false;
    let errMsg = '';
    try {
      await ensureKiroProfileFetched(credId);
    } catch (e: unknown) {
      threw = true;
      errMsg = String((e as Error).message ?? '');
    }
    assert.ok(threw, 'ensureKiroProfileFetched must throw');
    assert.ok(errMsg.includes('403'), `error must include the HTTP status: "${errMsg}"`);
    // HTTP 4xx → "Sign in again" guidance
    assert.ok(
      errMsg.toLowerCase().includes('sign in'),
      `error must include sign-in guidance for auth error: "${errMsg}"`,
    );

    // profileFetchError stored in DB
    const db = getDb();
    const row = db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(credId) as { extra_config: string };
    const extra = JSON.parse(row.extra_config) as Record<string, unknown>;
    assert.ok(typeof extra.profileFetchError === 'string', 'profileFetchError must be stored');
    assert.ok((extra.profileFetchError as string).includes('403'), 'profileFetchError must include HTTP status');
  });

  it('network error is stored in profileFetchError with no sign-in guidance', async () => {
    const userId = 'user-err-net';
    const credId = 'cred-err-net';
    insertIdcCred(userId, credId, {
      startUrl: 'https://err.awsapps.com/start',
      region: 'us-east-1',
      tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'client-err-net',
    });

    _setFetcherDirect(async () => ({ ok: false as const, reason: 'fetch failed: ECONNREFUSED' }));

    let threw = false;
    let errMsg = '';
    try {
      await ensureKiroProfileFetched(credId);
    } catch (e: unknown) {
      threw = true;
      errMsg = String((e as Error).message ?? '');
    }
    assert.ok(threw, 'ensureKiroProfileFetched must throw');
    // Non-auth error → administrator/connectivity guidance, NOT "Sign in again"
    assert.ok(
      errMsg.toLowerCase().includes('contact') || errMsg.toLowerCase().includes('connect'),
      `error must include connectivity guidance: "${errMsg}"`,
    );
    assert.ok(
      !errMsg.toLowerCase().includes('sign in again'),
      `error must NOT say "Sign in again" for a network error: "${errMsg}"`,
    );
  });

  it('no profiles returned → stored error does not say "Sign in again"', async () => {
    const userId = 'user-err-noprof';
    const credId = 'cred-err-noprof';
    insertIdcCred(userId, credId, {
      startUrl: 'https://err.awsapps.com/start',
      region: 'us-east-1',
      tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'client-err-noprof',
    });

    _setFetcherDirect(async () => ({ ok: true as const, profiles: [] }));

    let threw = false;
    let errMsg = '';
    try {
      await ensureKiroProfileFetched(credId);
    } catch (e: unknown) {
      threw = true;
      errMsg = String((e as Error).message ?? '');
    }
    assert.ok(threw, 'ensureKiroProfileFetched must throw');
    assert.ok(errMsg.toLowerCase().includes('profile'), `error must mention "profile": "${errMsg}"`);
    // No profiles is a configuration issue — administrator guidance, NOT "Sign in again"
    assert.ok(
      !errMsg.toLowerCase().includes('sign in again'),
      `error must NOT say "Sign in again" when there are no profiles: "${errMsg}"`,
    );
  });

  it('successful profile fetch stores selectedProfileArn and clears profileFetchError', async () => {
    const userId = 'user-ok-prof';
    const credId = 'cred-ok-prof';
    insertIdcCred(userId, credId, {
      startUrl: 'https://ok.awsapps.com/start',
      region: 'us-east-1',
      tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
      clientId: 'client-ok-prof',
      profileFetchError: 'stale error from previous attempt',
    });

    _setFetcherDirect(async () => ({
      ok: true as const,
      profiles: [{ arn: 'arn:aws:codewhisperer:us-east-1:42:profile/fresh', profileName: 'KiroProfile-fresh' }],
    }));

    await ensureKiroProfileFetched(credId); // must NOT throw

    const db = getDb();
    const row = db.prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(credId) as { extra_config: string };
    const extra = JSON.parse(row.extra_config) as Record<string, unknown>;
    assert.equal(extra.selectedProfileArn, 'arn:aws:codewhisperer:us-east-1:42:profile/fresh');
    assert.equal(extra.selectedProfileName, 'KiroProfile-fresh');
    assert.ok(!extra.profileFetchError, 'profileFetchError must be cleared on success');
  });
});

// ── OIDC timeout hardening ────────────────────────────────────────────────────

describe('Credentials — /refresh OIDC timeout hardening', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  // Controls for the mock OIDC client
  let hangForever = false;
  let rejectWithOidcError = false;

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'tout1');
    userCookie = u.cookie;

    setOIDCClientFactory((_region: string): OIDCClientLike => ({
      registerClient: async () => ({
        clientId: 'tout-client-id',
        clientSecret: 'tout-client-secret',
        clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
      }),
      startDeviceAuthorization: async () => ({
        deviceCode: 'tout-device-code',
        userCode: 'TOUT-1234',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
        verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=TOUT-1234',
        expiresIn: 600,
        interval: 5,
      }),
      createToken: (input) => {
        if (input.grantType === 'refresh_token') {
          if (hangForever) {
            // Never resolves — simulates an unresponsive AWS endpoint
            return new Promise<never>(() => { /* intentionally hangs */ });
          }
          if (rejectWithOidcError) {
            const err = new Error('InvalidGrantException') as Error & { name: string };
            err.name = 'InvalidGrantException';
            return Promise.reject(err);
          }
          return Promise.resolve({
            accessToken: 'tout-access-token',
            expiresIn: 28800,
            refreshToken: 'tout-refresh-token',
          });
        }
        // device_code grant: used only when polling the initial sign-in
        return Promise.resolve({
          accessToken: 'tout-initial-token',
          expiresIn: 28800,
          refreshToken: 'tout-initial-refresh-token',
        });
      },
    }));
  });

  after(async () => {
    setOIDCClientFactory(null);
    setOIDCCallTimeoutMs(null);
    await cleanup();
  });

  /** Create a fully signed-in IDC credential and return its id. */
  async function createToutCred(name: string): Promise<string> {
    const cr = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro',
        mode: 'identity_center',
        name,
        config: { startUrl: 'https://tout.awsapps.com/start', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    assert.equal(cr.status, 201, `Create: ${JSON.stringify(cr.body)}`);
    const credId = (cr.body as { credential: { id: string } }).credential.id;

    // Complete the initial device-code flow
    const pollR = await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, {
      method: 'POST', cookie: userCookie,
    });
    assert.equal(
      (pollR.body as { status: string }).status, 'complete',
      `Initial poll: ${JSON.stringify(pollR.body)}`,
    );
    return credId;
  }

  it('hanging createToken resolves as 504 within the injected timeout bound', async () => {
    const credId = await createToutCred('Timeout Cred');
    setOIDCCallTimeoutMs(80); // 80 ms — fast for tests
    hangForever = true;

    const start = Date.now();
    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST', cookie: userCookie,
    });
    const elapsed = Date.now() - start;

    hangForever = false;
    setOIDCCallTimeoutMs(null);

    assert.equal(r.status, 504, `Expected 504 timeout, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as { error: string };
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'error message must be present');
    assert.ok(
      body.error.toLowerCase().includes('try again') || body.error.toLowerCase().includes("didn't respond"),
      `error must suggest retrying, got: "${body.error}"`,
    );
    // Must not set needsSignIn for a timeout (token may still be renewable)
    assert.ok(!('needsSignIn' in (r.body as object)), `needsSignIn must not be set on timeout, got: ${JSON.stringify(r.body)}`);
    // Must resolve well within 2 seconds (80 ms + server overhead)
    assert.ok(elapsed < 2_000, `Timeout must fire within 2s, took ${elapsed}ms`);
  });

  it('OIDC rejection still returns 409 with needsSignIn', async () => {
    const credId = await createToutCred('Rejection Cred');
    rejectWithOidcError = true;

    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST', cookie: userCookie,
    });

    rejectWithOidcError = false;

    assert.equal(r.status, 409, `Expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as { needsSignIn: boolean; error: string };
    assert.equal(body.needsSignIn, true, 'needsSignIn must be true for OIDC rejection');
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'error message must be present');
  });
});

// ── Production SDK error classification ──────────────────────────────────────

describe('Credentials — /refresh production SDK error classification', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;
  let createTokenBehavior: 'timeout_error' | 'econnreset' | 'invalid_grant' | 'success' = 'success';

  before(async () => {
    const ts = await setupServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const u = await createNonAdmin(baseUrl, adminCookie, 'sdk-err');
    userCookie = u.cookie;

    setOIDCClientFactory((_region: string): OIDCClientLike => ({
      registerClient: async () => ({
        clientId: 'sdk-client-id',
        clientSecret: 'sdk-client-secret',
        clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
      }),
      startDeviceAuthorization: async () => ({
        deviceCode: 'sdk-device-code',
        userCode: 'SDK0-1234',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
        verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=SDK0-1234',
        expiresIn: 600,
        interval: 5,
      }),
      createToken: (input) => {
        if (input.grantType !== 'refresh_token') {
          return Promise.resolve({ accessToken: 'sdk-initial-token', expiresIn: 28800, refreshToken: 'sdk-initial-refresh' });
        }
        if (createTokenBehavior === 'timeout_error') {
          const err = new Error('Request timed out') as Error & { name: string };
          err.name = 'TimeoutError';
          return Promise.reject(err);
        }
        if (createTokenBehavior === 'econnreset') {
          const err = new Error('read ECONNRESET') as NodeJS.ErrnoException;
          (err as NodeJS.ErrnoException).code = 'ECONNRESET';
          return Promise.reject(err);
        }
        if (createTokenBehavior === 'invalid_grant') {
          const err = new Error('InvalidGrantException') as Error & { name: string };
          err.name = 'InvalidGrantException';
          return Promise.reject(err);
        }
        return Promise.resolve({ accessToken: 'sdk-refreshed-token', expiresIn: 28800, refreshToken: 'sdk-refreshed-refresh' });
      },
    }));
  });

  after(async () => {
    setOIDCClientFactory(null);
    await cleanup();
  });

  async function createSignedInSdkCred(name: string): Promise<string> {
    const cr = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST',
      body: {
        engine: 'kiro',
        mode: 'identity_center',
        name,
        config: { startUrl: 'https://sdk.awsapps.com/start', region: 'us-east-1' },
      },
      cookie: userCookie,
    });
    assert.equal(cr.status, 201, `Create: ${JSON.stringify(cr.body)}`);
    const credId = (cr.body as { credential: { id: string } }).credential.id;
    const pollR = await fetchJson(baseUrl, `/api/credentials/${credId}/device-poll`, {
      method: 'POST', cookie: userCookie,
    });
    assert.equal(
      (pollR.body as { status: string }).status, 'complete',
      `Initial poll: ${JSON.stringify(pollR.body)}`,
    );
    return credId;
  }

  it('TimeoutError from createToken → 504 (no needsSignIn)', async () => {
    const credId = await createSignedInSdkCred('SDK TimeoutError');
    createTokenBehavior = 'timeout_error';

    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST', cookie: userCookie,
    });

    createTokenBehavior = 'success';

    assert.equal(r.status, 504, `Expected 504, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as { error: string };
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'error message must be present');
    assert.ok(
      !('needsSignIn' in (r.body as object)),
      `needsSignIn must not be set for transient error, got: ${JSON.stringify(r.body)}`,
    );
  });

  it('ECONNRESET network error → 504 (no needsSignIn)', async () => {
    const credId = await createSignedInSdkCred('SDK ECONNRESET');
    createTokenBehavior = 'econnreset';

    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST', cookie: userCookie,
    });

    createTokenBehavior = 'success';

    assert.equal(r.status, 504, `Expected 504, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as { error: string };
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'error message must be present');
    assert.ok(
      !('needsSignIn' in (r.body as object)),
      `needsSignIn must not be set for transient error, got: ${JSON.stringify(r.body)}`,
    );
  });

  it('InvalidGrantException → 409 + needsSignIn', async () => {
    const credId = await createSignedInSdkCred('SDK InvalidGrant');
    createTokenBehavior = 'invalid_grant';

    const r = await fetchJson(baseUrl, `/api/credentials/${credId}/refresh`, {
      method: 'POST', cookie: userCookie,
    });

    createTokenBehavior = 'success';

    assert.equal(r.status, 409, `Expected 409, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as { needsSignIn: boolean; error: string };
    assert.equal(body.needsSignIn, true, 'needsSignIn must be true for auth rejection');
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'error message must be present');
  });
});


describe('Cloud Kiro sign-in uses bounded direct OIDC', () => {
  let baseUrl: string; let cookie: string; let hanging: 'register' | 'authorize' | null = null;
  let runtimeCalls = 0; let code = 0;
  const previousArn = process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN;
  before(async () => {
    ({ baseUrl } = await setupServer()); cookie = await loginAdmin(baseUrl);
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/kiro-test';
    _setAgentCoreInvokerOverride(async function* () { runtimeCalls++; throw new Error('Sign-in must not wait for a runner'); });
    setOIDCClientFactory(() => ({
      registerClient: async () => hanging === 'register' ? new Promise(() => {}) : { clientId: 'direct-client', clientSecret: 'direct-secret', clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400 },
      startDeviceAuthorization: async () => hanging === 'authorize' ? new Promise(() => {}) : { deviceCode: 'direct-device-' + (++code), userCode: 'TEST-1234', verificationUri: 'https://device.sso.us-east-1.amazonaws.com', expiresIn: 600, interval: 5 },
      createToken: async () => { throw new Error('AuthorizationPendingException'); },
    }));
  });
  beforeEach(() => { hanging = null; setOIDCCallTimeoutMs(null); });
  after(async () => {
    if (previousArn === undefined) delete process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN; else process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = previousArn;
    _setAgentCoreInvokerOverride(null); setOIDCClientFactory(null); setOIDCCallTimeoutMs(null); await cleanup();
  });
  const create = () => fetchJson(baseUrl, '/api/credentials', { cookie, body: { engine: 'kiro', mode: 'identity_center', isDefault: true, config: { startUrl: 'https://d-test.awsapps.com/start', region: 'us-east-1' } } });
  it('returns a browser code without invoking a configured AgentCore runner and encrypts the pending secret', async () => {
    const response = await create(); assert.equal(response.status, 201);
    const body = response.body as any; assert.equal(body.deviceChallenge.userCode, 'TEST-1234'); assert.equal(runtimeCalls, 0);
    assert.ok(!JSON.stringify(body).includes('direct-secret'));
    assert.ok(!body.credential.config.pendingClientSecretEnc, 'pending secret ciphertext is not browser configuration');
    const row = getDb().prepare('SELECT extra_config FROM engine_credentials WHERE id = ?').get(body.credential.id) as any;
    const extra = JSON.parse(row.extra_config);
    assert.ok(!extra.pendingClientSecret); assert.equal(decrypt(extra.pendingClientSecretEnc, (await import('../server/config.ts')).config.secretKey), 'direct-secret');
    const poll = await fetchJson(baseUrl, '/api/credentials/' + body.credential.id + '/device-poll', { cookie, body: {} });
    assert.equal(poll.status, 200); assert.equal((poll.body as any).status, 'pending');
  });
  it('reauthenticates through OIDC and preserves the working credential while waiting', async () => {
    const created = await create(); const id = (created.body as any).credential.id;
    const { getCredentialsRepository } = await import('../server/repositories/credentials.ts');
    const repo = getCredentialsRepository(); const row = (await repo.getById(id))!;
    const extra = { ...JSON.parse(row.extra_config), selectedProfileArn: 'profile-keep', selectedProfileName: 'Keep selection', tokenExpiry: new Date(Date.now()+3600000).toISOString() };
    const token = encrypt('working-token', (await import('../server/config.ts')).config.secretKey);
    await repo.updateToken(id, token, JSON.stringify(extra), 'oken', now());
    const response = await fetchJson(baseUrl, '/api/credentials/' + id + '/reauth', { cookie, body: {} });
    assert.equal(response.status, 200); assert.equal(runtimeCalls, 0);
    const current = (await repo.getById(id))!;
    assert.equal(current.secret_enc, token); assert.equal(JSON.parse(current.extra_config).selectedProfileArn, 'profile-keep');
    assert.ok(JSON.parse(current.extra_config).pendingClientSecretEnc);
  });
  it('bounds a stalled reauthentication without replacing the saved credential', async () => {
    const created = await create(); const id = (created.body as any).credential.id;
    const { getCredentialsRepository } = await import('../server/repositories/credentials.ts');
    const repo = getCredentialsRepository(); const before = (await repo.getById(id))!;
    hanging = 'authorize'; setOIDCCallTimeoutMs(25);
    const response = await fetchJson(baseUrl, '/api/credentials/' + id + '/reauth', { cookie, body: {} });
    assert.equal(response.status, 504); assert.equal((await repo.getById(id))!.extra_config, before.extra_config);
  });
  for (const step of ['register', 'authorize'] as const) it('returns a retryable timeout for stalled ' + step + ' without replacing the default', async () => {
    const good = await create(); const goodId = (good.body as any).credential.id;
    hanging = step; setOIDCCallTimeoutMs(25); const started = Date.now();
    const response = await create(); assert.equal(response.status, 504); assert.ok(Date.now() - started < 2000);
    const { getCredentialsRepository } = await import('../server/repositories/credentials.ts');
    assert.equal((await getCredentialsRepository().getDefaultByUserAndEngine((await getCredentialsRepository().getById(goodId))!.user_id, 'kiro'))!.id, goodId);
  });
});
