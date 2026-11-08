/**
 * Tests for GET /api/engines/:engine/models
 *
 * Coverage:
 *   - 401 when unauthenticated
 *   - 400 for unknown engine
 *   - Non-admin user CAN access (not admin-only)
 *   - Credential owned by another user returns 404-style error
 *   - Kiro IDC credential with PORTAL_KIRO_FAKE: returns models from fake CLI
 *   - Kiro credential with expired token scenario: returns 200 with error string
 *   - Claude Code subscription_token returns static list with source:'static'
 *   - Claude Code api_key credential fetches Anthropic models (mocked fetch)
 *   - Missing credentialId falls back to portal provider
 *   - runsAs.kind = 'credential' when credentialId given, 'portal' otherwise
 *   - Cache: second call returns cached; ?refresh=1 bypasses
 *   - /api/settings/claude-models is gone (404)
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { getDb } from '../server/db.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import { insert } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { _clearEngineModelCache } from '../server/models.ts';
import { _clearIdcHookCheckCache } from '../server/kiro-idc-check.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_KIRO = path.join(__dirname, 'fake-kiro.mjs');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loginAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `admin-${Date.now()}@test.com`, name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200, `Setup: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

async function createUser(baseUrl: string, adminCookie: string, email: string): Promise<string> {
  await fetchJson(baseUrl, '/api/users', {
    method: 'POST',
    body: { email, name: 'User', password: 'password1234', isAdmin: false },
    cookie: adminCookie,
  });
  const r = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password1234' },
  });
  return r.cookie ?? '';
}

function createKiroCredential(userId: string, mode: 'api_key' | 'identity_center', opts: {
  secret?: string;
  region?: string;
  tokenExpiry?: string;
} = {}): string {
  const id = generateId();
  const db = getDb();
  const secretEnc = opts.secret ? encrypt(opts.secret, config.secretKey) : null;
  const extra = JSON.stringify(mode === 'identity_center'
    ? {
        region: opts.region ?? 'us-east-1',
        tokenExpiry: opts.tokenExpiry ?? new Date(Date.now() + 28_800_000).toISOString(),
        clientId: 'test-idc-client-id',
        clientSecretExpiresAt: 9999999999,
        selectedProfileArn: 'arn:aws:codewhisperer:us-east-1:123456789:profile/test-profile',
        selectedProfileName: 'KiroProfile-us-east-1',
      }
    : {});
  db.prepare(
    `INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
     VALUES (?, ?, 'kiro', 'Test Kiro Cred', ?, ?, ?, 1, '1234', ?, ?)`,
  ).run(id, userId, mode, secretEnc, extra, now(), now());
  return id;
}

function createClaudeCodeCredential(userId: string, mode: 'api_key' | 'subscription_token' | 'bedrock_role', opts: {
  secret?: string;
  config?: Record<string, string>;
} = {}): string {
  const id = generateId();
  const db = getDb();
  const secretEnc = opts.secret ? encrypt(opts.secret, config.secretKey) : null;
  const extra = JSON.stringify(opts.config ?? {});
  db.prepare(
    `INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
     VALUES (?, ?, 'claude-code', 'Test CC Cred', ?, ?, ?, 1, '5678', ?, ?)`,
  ).run(id, userId, mode, secretEnc, extra, now(), now());
  return id;
}

function getUserId(email: string): string {
  const row = getDb().prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
  assert.ok(row, `User ${email} not found`);
  return row!.id;
}

// ── Auth guard ─────────────────────────────────────────────────────────────────

describe('GET /api/engines/:engine/models — auth guard', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => { await cleanup(); _clearEngineModelCache(); });

  it('returns 401 when not authenticated', async () => {
    const r = await fetchJson(baseUrl, '/api/engines/kiro/models');
    assert.equal(r.status, 401);
  });

  it('returns 400 for unknown engine', async () => {
    const r = await fetchJson(baseUrl, '/api/engines/openai/models', { cookie: adminCookie });
    assert.equal(r.status, 400);
  });
});

// ── Non-admin can access ──────────────────────────────────────────────────────

describe('GET /api/engines/:engine/models — non-admin access', () => {
  let baseUrl: string;
  let userCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const adminCookie = await loginAdmin(baseUrl);
    const email = `user-${Date.now()}@test.com`;
    userCookie = await createUser(baseUrl, adminCookie, email);
  });

  after(async () => { await cleanup(); _clearEngineModelCache(); });

  it('non-admin user gets 200 (not admin-only)', async () => {
    const r = await fetchJson(baseUrl, '/api/engines/kiro/models', { cookie: userCookie });
    assert.equal(r.status, 200, `Expected 200: ${JSON.stringify(r.body)}`);
  });
});

// ── Credential ownership guard ────────────────────────────────────────────────

describe('GET /api/engines/:engine/models — credential ownership', () => {
  let baseUrl: string;
  let adminCookie: string;
  let userCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    const email = `other-${Date.now()}@test.com`;
    userCookie = await createUser(baseUrl, adminCookie, email);
  });

  after(async () => { await cleanup(); _clearEngineModelCache(); });

  it('returns error when credentialId belongs to another user', async () => {
    // Create a credential for the admin
    const adminEmail = getDb().prepare('SELECT email FROM users WHERE is_admin = 1').get() as { email: string };
    const adminId = getUserId(adminEmail.email);
    const credId = createKiroCredential(adminId, 'api_key', { secret: 'fake-key' });

    // User tries to use admin's credential
    const r = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}`, { cookie: userCookie });
    assert.equal(r.status, 200);
    const body = r.body as { error?: string; models: unknown[] };
    assert.ok(body.error, 'should return an error message');
    assert.ok(body.error!.toLowerCase().includes('not found') || body.error!.toLowerCase().includes('belong'), `error: ${body.error}`);
    assert.deepEqual(body.models, []);
  });
});

// ── /api/settings/claude-models removed ──────────────────────────────────────

describe('GET /api/settings/claude-models — removed', () => {
  let baseUrl: string;
  let cookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await loginAdmin(baseUrl);
  });

  after(async () => { await cleanup(); });

  it('returns 404 — endpoint has been removed', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/claude-models', { cookie });
    assert.equal(r.status, 404, `Expected 404 (removed), got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ── Kiro credential: IDC with fake CLI ───────────────────────────────────────

describe('GET /api/engines/kiro/models — IDC credential with fake CLI', () => {
  let baseUrl: string;
  let cookie: string;
  let userId: string;

  before(async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await loginAdmin(baseUrl);
    const adminEmail = getDb().prepare('SELECT email FROM users WHERE is_admin = 1').get() as { email: string };
    userId = getUserId(adminEmail.email);
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
    _clearEngineModelCache();
  });

  afterEach(() => {
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    _clearEngineModelCache();
  });

  it('returns models from fake CLI for IDC credential (default scenario)', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-ok';
    const credId = createKiroCredential(userId, 'identity_center', {
      secret: 'fake-idc-token',
      region: 'us-east-1',
    });

    const r = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as { models: Array<{ id: string; label: string; default?: boolean }>; source: string; runsAs: { kind: string; label: string } };
    assert.equal(body.source, 'kiro-cli', `source should be kiro-cli, got: ${body.source}`);
    assert.ok(body.models.length >= 1, 'should have at least one model');
    // The fake now outputs the real text-table format: 'auto' is the default starred entry
    assert.ok(body.models.some((m) => m.id === 'auto'), 'should include the auto model');
    // 'auto' should be flagged as the default
    const autoModel = body.models.find((m) => m.id === 'auto');
    assert.ok(autoModel?.default === true, 'auto model should have default:true');
    // Labels should follow the "<id> — <description> (<Nx> credits)" format
    assert.ok(autoModel?.label.includes('—'), 'label should include em-dash separator');
    assert.ok(autoModel?.label.includes('credits'), 'label should include credit info');
    assert.equal(body.runsAs.kind, 'credential');
  });

  it('returns error string (not 500) when IDC token is expired', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-error';
    const credId = createKiroCredential(userId, 'identity_center', {
      secret: 'expired-idc-token',
      region: 'us-east-1',
    });

    const r = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200, `should be 200 not 500: ${JSON.stringify(r.body)}`);
    const body = r.body as { models: unknown[]; error?: string };
    assert.deepEqual(body.models, []);
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'should have error string');
  });

  it('returns models for Kiro api_key credential', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-ok';
    const credId = createKiroCredential(userId, 'api_key', { secret: 'fake-api-key-1234' });

    const r = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as { models: Array<{ id: string }>; source: string };
    assert.equal(body.source, 'kiro-cli');
    assert.ok(body.models.length >= 1);
  });

  it('on the cloud portal a Kiro api_key credential says API keys are not supported, not "kiro-cli is not installed"', async () => {
    const previous = process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN;
    process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/kiro-test';
    try {
      _clearEngineModelCache();
      const credId = createKiroCredential(userId, 'api_key', { secret: 'fake-api-key-cloud' });
      const r = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}&refresh=1`, { cookie });
      assert.equal(r.status, 200);
      const body = r.body as { models: unknown[]; error?: string };
      assert.deepEqual(body.models, []);
      assert.match(body.error ?? '', /API keys are not supported on the cloud portal/);
      assert.match(body.error ?? '', /Identity Center/);
      assert.doesNotMatch(body.error ?? '', /not installed/);
    } finally {
      if (previous === undefined) delete process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN; else process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN = previous;
    }
  });

  it('caches result so second call does not re-invoke fake CLI', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-ok';
    _clearEngineModelCache();

    const credId = createKiroCredential(userId, 'api_key', { secret: 'fake-key-cache' });

    const r1 = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}`, { cookie });
    assert.equal(r1.status, 200);

    const r2 = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}`, { cookie });
    assert.equal(r2.status, 200);
    assert.deepEqual(r1.body, r2.body, 'cached responses should be equal');
  });

  it('?refresh=1 bypasses cache', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-ok';
    const credId = createKiroCredential(userId, 'api_key', { secret: 'fake-key-refresh' });

    const r1 = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}`, { cookie });
    assert.equal(r1.status, 200);

    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-empty';
    const r2 = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r2.status, 200);
    const body2 = r2.body as { models: unknown[] };
    assert.deepEqual(body2.models, [], '?refresh=1 must re-run and return empty list');
  });
});

// ── Claude Code: subscription_token → static list ────────────────────────────

describe('GET /api/engines/claude-code/models — subscription_token credential', () => {
  let baseUrl: string;
  let cookie: string;
  let userId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await loginAdmin(baseUrl);
    const adminEmail = getDb().prepare('SELECT email FROM users WHERE is_admin = 1').get() as { email: string };
    userId = getUserId(adminEmail.email);
  });

  after(async () => { await cleanup(); _clearEngineModelCache(); });

  it('returns static list with source:"static" for subscription_token', async () => {
    const credId = createClaudeCodeCredential(userId, 'subscription_token', { secret: 'sub-token-fake' });

    const r = await fetchJson(baseUrl, `/api/engines/claude-code/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as { models: Array<{ id: string }>; source: string; runsAs: { kind: string } };
    assert.equal(body.source, 'static');
    assert.ok(body.models.length >= 3, 'static list should have ≥3 models');
    assert.ok(body.models.some((m) => m.id.includes('sonnet')), 'should include a sonnet model');
    assert.ok(body.models.some((m) => m.id.includes('opus')), 'should include an opus model');
    assert.equal(body.runsAs.kind, 'credential');
    // The newest models a Pro plan runs come first; Fable needs usage credits on Pro, so it is not offered.
    const ids = body.models.map((m) => m.id);
    assert.deepEqual(ids.slice(0, 3), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    assert.ok(ids.includes('claude-opus-4-6') && ids.includes('claude-sonnet-4-5'), ids.join(', '));
    assert.ok(!ids.some((id) => id.includes('fable')), 'no Fable model');
    assert.ok(ids.every((id) => /^claude-[a-z]+-\d+(-\d+)?$/.test(id)), 'Anthropic IDs only, no Bedrock names');
    assert.equal(new Set(ids).size, ids.length, 'no model twice');
  });
});

// ── Claude Code: api_key credential → Anthropic live listing ─────────────────

describe('GET /api/engines/claude-code/models — api_key credential (mocked fetch)', () => {
  let baseUrl: string;
  let cookie: string;
  let userId: string;
  let origFetch: typeof globalThis.fetch;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await loginAdmin(baseUrl);
    const adminEmail = getDb().prepare('SELECT email FROM users WHERE is_admin = 1').get() as { email: string };
    userId = getUserId(adminEmail.email);
    origFetch = globalThis.fetch;
  });

  after(async () => {
    globalThis.fetch = origFetch;
    await cleanup();
    _clearEngineModelCache();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    _clearEngineModelCache();
  });

  it('returns Anthropic models with source:"anthropic" for api_key credential', async () => {
    globalThis.fetch = async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).includes('anthropic.com/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' },
              { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', type: 'model' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return origFetch(url, _init);
    };

    const credId = createClaudeCodeCredential(userId, 'api_key', { secret: 'sk-ant-fake-key' });
    const r = await fetchJson(baseUrl, `/api/engines/claude-code/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as { models: Array<{ id: string }>; source: string; runsAs: { kind: string } };
    assert.equal(body.source, 'anthropic');
    assert.ok(body.models.length >= 2);
    assert.ok(body.models.some((m) => m.id === 'claude-sonnet-4-5'));
    assert.equal(body.runsAs.kind, 'credential');
  });

  it('returns error string (not 500) when Anthropic API fails', async () => {
    globalThis.fetch = async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).includes('anthropic.com')) {
        return new Response(
          JSON.stringify({ error: { message: 'authentication_error' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      return origFetch(url, _init);
    };

    const credId = createClaudeCodeCredential(userId, 'api_key', { secret: 'sk-ant-invalid' });
    const r = await fetchJson(baseUrl, `/api/engines/claude-code/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200, `should be 200 not 500: ${JSON.stringify(r.body)}`);
    const body = r.body as { models: unknown[]; error?: string };
    assert.deepEqual(body.models, []);
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
  });
});

// ── runsAs falls back to portal when no credential ───────────────────────────

describe('GET /api/engines/:engine/models — portal fallback', () => {
  let baseUrl: string;
  let cookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await loginAdmin(baseUrl);
  });

  after(async () => { await cleanup(); _clearEngineModelCache(); });

  it('runsAs.kind is "portal" when no credentialId given and user has no default', async () => {
    const r = await fetchJson(baseUrl, '/api/engines/kiro/models?refresh=1', { cookie });
    assert.equal(r.status, 200);
    const body = r.body as { runsAs: { kind: string; label: string } };
    assert.equal(body.runsAs.kind, 'portal');
    assert.ok(body.runsAs.label.length > 0);
  });
});

// ── idcIsolation driven by hook check ────────────────────────────────────────

describe('GET /api/engines/kiro/models — idcIsolation driven by hook check', () => {
  let baseUrl: string;
  let cookie: string;
  let userId: string;

  before(async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    _clearIdcHookCheckCache();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await loginAdmin(baseUrl);
    const adminEmail = getDb().prepare('SELECT email FROM users WHERE is_admin = 1').get() as { email: string };
    userId = getUserId(adminEmail.email);
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    delete process.env.PORTAL_FAKE_KIRO_VERSION;
    _clearIdcHookCheckCache();
    await cleanup();
    _clearEngineModelCache();
  });

  afterEach(() => {
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    delete process.env.PORTAL_FAKE_KIRO_VERSION;
    _clearIdcHookCheckCache();
    _clearEngineModelCache();
  });

  it('idcIsolation.supported is true when hook is honoured', async () => {
    // Default fake whoami: when KIRO_TEST_DB_PATH is set → "Not signed in" → hook honoured
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-ok';
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.37.0-idc-test-ok';
    const credId = createKiroCredential(userId, 'identity_center', {
      secret: 'fake-idc-token',
      region: 'us-east-1',
    });
    const r = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as { idcIsolation?: { supported: boolean; method: string }; models: unknown[]; error?: string };
    assert.ok(body.idcIsolation, `idcIsolation must be present for identity_center credential: ${JSON.stringify(body)}`);
    assert.ok(body.idcIsolation!.supported === true, `idcIsolation.supported must be true: ${JSON.stringify(body.idcIsolation)}`);
    assert.equal(body.idcIsolation!.method, 'kiro-test-db');
  });

  it('idcIsolation.supported is false and error is returned when hook is ignored', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'idc-hook-ignored';
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.36.0-idc-test-ignored';
    const credId = createKiroCredential(userId, 'identity_center', {
      secret: 'fake-idc-token',
      region: 'us-east-1',
    });
    const r = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200, `should be 200 not 500: ${JSON.stringify(r.body)}`);
    const body = r.body as { idcIsolation?: { supported: boolean; method: string }; models: unknown[]; error?: string };
    assert.ok(body.idcIsolation, `idcIsolation must be present: ${JSON.stringify(body)}`);
    assert.ok(body.idcIsolation!.supported === false, `idcIsolation.supported must be false: ${JSON.stringify(body.idcIsolation)}`);
    assert.equal(body.idcIsolation!.method, 'none');
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'must have an error message');
    assert.ok(
      body.error!.toLowerCase().includes('api key') || body.error!.toLowerCase().includes('api_key'),
      `error must suggest using an API key: "${body.error}"`,
    );
    assert.deepEqual(body.models, [], 'models must be empty when hook is not honoured');
  });

  it('api_key credential does not include idcIsolation', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-ok';
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.37.0-idc-test-apikey';
    const credId = createKiroCredential(userId, 'api_key', { secret: 'fake-api-key' });
    const r = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200);
    const body = r.body as { idcIsolation?: unknown; models: unknown[] };
    assert.ok(!body.idcIsolation, `api_key credential must NOT have idcIsolation: ${JSON.stringify(body.idcIsolation)}`);
  });
});

// ── IDC token write-back during model listing ────────────────────────────────

describe('GET /api/engines/kiro/models — IDC token write-back when kiro-cli refreshes token', () => {
  let baseUrl: string;
  let cookie: string;
  let userId: string;

  before(async () => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    _clearIdcHookCheckCache();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await loginAdmin(baseUrl);
    const adminEmail = getDb().prepare('SELECT email FROM users WHERE is_admin = 1').get() as { email: string };
    userId = getUserId(adminEmail.email);
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    delete process.env.PORTAL_FAKE_KIRO_VERSION;
    _clearIdcHookCheckCache();
    await cleanup();
    _clearEngineModelCache();
  });

  it('credential is updated when kiro-cli writes a new access_token during model listing', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'list-models-writeback';
    process.env.PORTAL_FAKE_KIRO_VERSION = '2.37.0-writeback-list';

    const credId = createKiroCredential(userId, 'identity_center', {
      secret: 'original-idc-token-for-list',
      region: 'us-east-1',
    });

    const r = await fetchJson(baseUrl, `/api/engines/kiro/models?credentialId=${credId}&refresh=1`, { cookie });
    assert.equal(r.status, 200, `should be 200: ${JSON.stringify(r.body)}`);
    const body = r.body as { models: unknown[]; source: string };
    assert.equal(body.source, 'kiro-cli');
    assert.ok(body.models.length > 0, 'should have models');

    // Verify the credential was updated with the token kiro-cli wrote to the temp DB
    const { decrypt: dec } = await import('../server/secrets.ts');
    const { config: cfg } = await import('../server/config.ts');
    const row = getDb().prepare(
      'SELECT secret_enc FROM engine_credentials WHERE id = ?',
    ).get(credId) as { secret_enc: string } | undefined;
    assert.ok(row, 'credential row must exist');
    const newToken = dec(row!.secret_enc, cfg.secretKey);
    assert.equal(newToken, 'refreshed-access-token-by-kiro-list',
      'credential must be updated with the refreshed token from the temp DB');
  });
});
