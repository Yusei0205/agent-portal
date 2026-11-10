/**
 * Settings module tests (P5).
 *
 * Tests:
 *   - GET /api/settings returns provider mode without exposing the API key
 *   - PUT /api/settings saves provider mode (admin only)
 *   - GET /api/settings/packs returns all 6 packs
 *   - POST /api/settings/packs/uv/install returns 200 (route responds correctly)
 *   - resolveModel('sonnet', db) returns default when no override
 *   - resolveModel('sonnet', db) returns override when custom value set
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, createTestDb, cleanup, fetchJson } from './fixtures.ts';
import { getSetting, setSetting, getSettings } from '../server/settings.ts';
import { resolveModel, MODEL_DEFAULTS } from '../server/models.ts';
import { setBedrockClientFactory, callTextModel, type BedrockClientLike, type BedrockConverseInput } from '../server/testing/model-provider.ts';
import { config } from '../server/config.ts';
import { getDb } from '../server/db.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loginAdmin(baseUrl: string): Promise<string> {
  // Create admin via setup
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'admin@test.com', name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200, `Setup failed: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('Settings routes', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => {
    await cleanup();
  });

  it('GET /api/settings returns provider mode without exposing the API key', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    const provider = body.provider as Record<string, unknown>;
    assert.ok(provider, 'Expected provider in response');
    assert.equal(provider.mode, 'demo', 'Default mode should be demo');
    // anthropicKey should not expose actual value
    assert.ok(
      !provider.anthropicKey || provider.anthropicKey === '' || provider.anthropicKey === '***',
      'anthropicKey should not expose raw value',
    );
  });

  it('GET /api/settings returns 401 when not authenticated', async () => {
    const r = await fetchJson(baseUrl, '/api/settings');
    assert.equal(r.status, 401);
  });

  it('PUT /api/settings saves provider mode (admin only)', async () => {
    // Switch mode to anthropic
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { provider: { mode: 'anthropic' } },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `PUT failed: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    const provider = body.provider as Record<string, unknown>;
    assert.equal(provider.mode, 'anthropic');

    // Switch back to demo
    const r2 = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { provider: { mode: 'demo' } },
      cookie: adminCookie,
    });
    assert.equal(r2.status, 200);
  });

  it('PUT /api/settings returns 403 for non-admin users', async () => {
    // Test this in an isolated fashion using the main test server
    // Create a non-admin user on the current server
    const createR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'nonAdmin@test.com', name: 'Non Admin', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201, `Create user failed: ${JSON.stringify(createR.body)}`);
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'nonAdmin@test.com', password: 'password1234' },
    });
    const userCk = loginR.cookie ?? '';
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { provider: { mode: 'demo' } },
      cookie: userCk,
    });
    assert.equal(r.status, 403);
  });

  it('PUT /api/settings rejects unknown provider mode', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { provider: { mode: 'unknown-mode' } },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });

  it('POST /api/settings/test returns ok for demo mode', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/test', {
      method: 'POST',
      body: { modeOverride: 'demo' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, true);
  });
});

describe('Tool packs routes', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => {
    await cleanup();
  });

  it('GET /api/settings/packs returns all 6 packs', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/packs', { cookie: adminCookie });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const body = r.body as { packs: Array<{ id: string }> };
    assert.ok(Array.isArray(body.packs), 'Expected packs array');
    assert.equal(body.packs.length, 6, `Expected 6 packs, got ${body.packs.length}`);

    const packIds = body.packs.map((p) => p.id);
    for (const expected of ['uv', 'kiro', 'browser', 'drawio', 'docs', 'headroom']) {
      assert.ok(packIds.includes(expected), `Missing pack: ${expected}`);
    }
  });

  it('GET /api/settings/packs returns 401 when not authenticated', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/packs');
    assert.equal(r.status, 401);
  });

  it('POST /api/settings/packs/uv/install returns 200 (route responds correctly)', async () => {
    // The route should respond even if uv is not installed (the install may fail in the background)
    const r = await fetchJson(baseUrl, '/api/settings/packs/uv/install', {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    // Should return 200 (started) or 409 (already in progress)
    assert.ok(
      r.status === 200 || r.status === 409,
      `Expected 200 or 409, got ${r.status}: ${JSON.stringify(r.body)}`,
    );
  });

  it('POST /api/settings/packs/docs/install returns 400 (docs pack is not installable)', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/packs/docs/install', {
      method: 'POST',
      body: {},
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, `Expected 400 for non-installable pack, got ${r.status}`);
  });

  it('POST /api/settings/packs/uv/install returns 403 for non-admin', async () => {
    // Create a non-admin user on the current server
    const createR = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'nonAdmin2@test.com', name: 'Non Admin 2', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201, `Create user failed: ${JSON.stringify(createR.body)}`);
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'nonAdmin2@test.com', password: 'password1234' },
    });
    const userCk = loginR.cookie ?? '';
    const r = await fetchJson(baseUrl, '/api/settings/packs/uv/install', {
      method: 'POST',
      body: {},
      cookie: userCk,
    });
    assert.equal(r.status, 403, `Expected 403 for non-admin, got ${r.status}`);
  });
});

describe('resolveModel', () => {
  it('returns the default when no override is set', () => {
    const db = createTestDb();
    const result = resolveModel('sonnet', db);
    assert.equal(result, MODEL_DEFAULTS.sonnet);
  });

  it('returns the override when a custom model ID is set', () => {
    const db = createTestDb();
    setSetting(db, 'model.sonnet', 'my-custom-sonnet-model');
    const result = resolveModel('sonnet', db);
    assert.equal(result, 'my-custom-sonnet-model');
  });

  it('returns the default for haiku when no override', () => {
    const db = createTestDb();
    const result = resolveModel('haiku', db);
    assert.equal(result, MODEL_DEFAULTS.haiku);
  });

  it('returns the default for opus when no override', () => {
    const db = createTestDb();
    const result = resolveModel('opus', db);
    assert.equal(result, MODEL_DEFAULTS.opus);
  });

  it('returns override for haiku when set', () => {
    const db = createTestDb();
    setSetting(db, 'model.haiku', 'custom-haiku-v9');
    const result = resolveModel('haiku', db);
    assert.equal(result, 'custom-haiku-v9');
  });

  it('getSetting returns null for missing key', () => {
    const db = createTestDb();
    assert.equal(getSetting(db, 'nonexistent.key'), null);
  });

  it('setSetting and getSetting round-trip', () => {
    const db = createTestDb();
    setSetting(db, 'test.key', 'test-value');
    assert.equal(getSetting(db, 'test.key'), 'test-value');
  });
});

describe('Governance user routes', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => {
    await cleanup();
  });

  it('GET /api/governance/users returns user list for admin', async () => {
    const r = await fetchJson(baseUrl, '/api/governance/users', { cookie: adminCookie });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const body = r.body as { users: Array<{ email: string }> };
    assert.ok(Array.isArray(body.users));
    assert.ok(body.users.some((u) => u.email === 'admin@test.com'));
  });

  it('POST /api/governance/invitations creates an invite', async () => {
    const r = await fetchJson(baseUrl, '/api/governance/invitations', {
      method: 'POST',
      body: { email: 'new@test.com', role: 'member' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as { invitation: { email: string; role: string; inviteUrl: string } };
    assert.equal(body.invitation.email, 'new@test.com');
    assert.equal(body.invitation.role, 'member');
    assert.ok(body.invitation.inviteUrl.includes('accept-invite'));
  });

  it('GET /api/governance/invitations lists pending invites', async () => {
    const r = await fetchJson(baseUrl, '/api/governance/invitations', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { invitations: unknown[] };
    assert.ok(Array.isArray(body.invitations));
  });

  it('POST /api/auth/accept-invite accepts a valid invitation', async () => {
    // Create an invitation first
    const invR = await fetchJson(baseUrl, '/api/governance/invitations', {
      method: 'POST',
      body: { email: 'invited@test.com', role: 'member' },
      cookie: adminCookie,
    });
    const inv = (invR.body as { invitation: { inviteUrl: string } }).invitation;

    // Extract token from URL
    const url = new URL(inv.inviteUrl.replace('#/', '?hash='));
    const token = new URLSearchParams(inv.inviteUrl.split('?')[1]).get('token') ?? '';

    const acceptR = await fetchJson(baseUrl, '/api/auth/accept-invite', {
      method: 'POST',
      body: { token, name: 'Invited User', password: 'password1234' },
    });
    assert.equal(acceptR.status, 200, `Accept invite failed: ${JSON.stringify(acceptR.body)}`);
    const body = acceptR.body as { ok: boolean };
    assert.equal(body.ok, true);
  });
});

describe('defaultModel — settings round-trip', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => {
    await cleanup();
  });

  it('GET /api/settings includes defaultModel field (empty by default)', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.ok('defaultModel' in body, 'response must include defaultModel');
    assert.equal(typeof body.defaultModel, 'string', 'defaultModel must be a string');
  });

  it('PUT defaultModel saves value and GET returns it', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { defaultModel: 'us.anthropic.claude-sonnet-4-5-20251001-v1:0' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.defaultModel, 'us.anthropic.claude-sonnet-4-5-20251001-v1:0');

    const r2 = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    assert.equal((r2.body as Record<string, unknown>).defaultModel, 'us.anthropic.claude-sonnet-4-5-20251001-v1:0');
  });

  it('PUT defaultModel empty string clears override', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { defaultModel: '' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as Record<string, unknown>).defaultModel, '');
  });

  it('PUT defaultModel rejects invalid model ID (control chars)', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { defaultModel: 'bad\x00model' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });

  it('PUT defaultModel rejects overly long model ID', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { defaultModel: 'a'.repeat(201) },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });

  it('PUT defaultModel rejects "kiro-default" placeholder with 400', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { defaultModel: 'kiro-default' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, `Expected 400 for kiro-default, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.ok(
      typeof body.error === 'string' && body.error.toLowerCase().includes('placeholder'),
      `error message must mention "placeholder", got: ${body.error}`,
    );
  });

  it('PUT defaultModel rejects "demo-model" placeholder with 400', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { defaultModel: 'demo-model' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400, `Expected 400 for demo-model, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.ok(
      typeof body.error === 'string' && body.error.toLowerCase().includes('placeholder'),
      `error message must mention "placeholder", got: ${body.error}`,
    );
  });
});

describe('defaultModel — backward compatibility with model.sonnet', () => {
  it('getSettings() defaultModel mirrors model.sonnet when default.model is not set', () => {
    const db = createTestDb();
    setSetting(db, 'model.sonnet', 'legacy-sonnet-model');
    const s = getSettings(db);
    assert.equal(s.defaultModel, 'legacy-sonnet-model', 'defaultModel must fall back to model.sonnet');
  });

  it('getSettings() defaultModel uses default.model when both keys are set', () => {
    const db = createTestDb();
    setSetting(db, 'model.sonnet', 'legacy-sonnet-model');
    setSetting(db, 'default.model', 'new-default-model');
    const s = getSettings(db);
    assert.equal(s.defaultModel, 'new-default-model', 'default.model must take priority over model.sonnet');
  });

  it('getSettings() defaultModel is empty when neither key is set', () => {
    const db = createTestDb();
    const s = getSettings(db);
    assert.equal(s.defaultModel, '', 'defaultModel must be empty when no model is configured');
  });
});

describe('callTextModel uses defaultModel', () => {
  function makeMockFactory(captured: BedrockConverseInput[]): (r: string) => BedrockClientLike {
    return (_region) => ({
      async converse(input: BedrockConverseInput) {
        captured.push(input);
        return { output: { message: { content: [{ text: 'ok' }] } } };
      },
    });
  }

  before(async () => {
    await createTestServer();
  });

  after(async () => {
    setBedrockClientFactory(null);
    await cleanup();
  });

  it('callTextModel uses default.model setting when explicitly set', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.auth', 'ambient');
    setSetting(db, 'default.model', 'explicit-default-model');
    try { setSetting(db, 'model.sonnet', ''); } catch { /* ignore */ }

    const captured: BedrockConverseInput[] = [];
    setBedrockClientFactory(makeMockFactory(captured));

    await callTextModel('system', 'user');
    assert.ok(captured.length > 0, 'Bedrock must be called');
    assert.equal(captured[0].modelId, 'explicit-default-model');
  });

  it('callTextModel falls back to model.sonnet via defaultModel when default.model not set', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.auth', 'ambient');
    setSetting(db, 'model.sonnet', 'legacy-sonnet-id');
    try { setSetting(db, 'default.model', ''); } catch { /* ignore */ }

    const captured: BedrockConverseInput[] = [];
    setBedrockClientFactory(makeMockFactory(captured));

    await callTextModel('system', 'user');
    assert.ok(captured.length > 0, 'Bedrock must be called');
    assert.equal(captured[0].modelId, 'legacy-sonnet-id', 'must fall back to model.sonnet via defaultModel');
  });
});
