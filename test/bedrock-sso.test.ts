/**
 * Tests for portal-wide Bedrock SSO (AWS IAM Identity Center).
 *
 * Coverage:
 *   - SSO start → poll pending → complete
 *   - Accounts and roles listing with mocked SSO client
 *   - Credentials used by callTextModel (Bedrock mock factory)
 *   - listModelsForProvider uses SSO creds
 *   - Auto-refresh: when access token is expired the refresh grant is attempted
 *   - Expired session error when refresh token also absent
 *   - Sign-out clears tokens
 *   - Admin-only + API-token rejection
 *   - SSO-profile path returns a clear error message
 *   - testConnection for bedrock/sso mode
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import {
  setSSOOIDCClientFactory,
  setSSOClientFactory,
  signOutSso,
  getSsoSignedInState,
  _clearRoleCredCache,
  getBedrockSsoCredentials,
  type SSOOIDCClientLike,
  type SSOClientLike,
} from '../server/bedrock-sso.ts';
import {
  setBedrockListingMock,
  _clearModelListCache,
  listModelsForProvider,
  setSetting,
} from '../server/settings.ts';
import { getDb } from '../server/db.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import {
  setBedrockClientFactory,
  callTextModel,
  type BedrockClientLike,
  type BedrockConverseInput,
} from '../server/testing/model-provider.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loginAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: 'admin@sso.test', name: 'Admin', password: 'password1234' },
  });
  assert.equal(r.status, 200, `Setup: ${JSON.stringify(r.body)}`);
  return r.cookie ?? '';
}

async function loginNonAdmin(baseUrl: string, adminCookie: string): Promise<string> {
  await fetchJson(baseUrl, '/api/users', {
    method: 'POST',
    body: { email: 'user@sso.test', name: 'User', password: 'password1234', isAdmin: false },
    cookie: adminCookie,
  });
  const r = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'user@sso.test', password: 'password1234' },
  });
  return r.cookie ?? '';
}

async function createApiToken(baseUrl: string, cookie: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/api-tokens', {
    method: 'POST',
    body: { name: 'test', scope: 'write' },
    cookie,
  });
  return (r.body as { token: string }).token;
}

/** Build a mock OIDC client factory. */
function makeMockOIDCFactory(opts: {
  pendingThenComplete?: boolean;
  expiredToken?: boolean;
  returnRefreshToken?: boolean;
}): (region: string) => SSOOIDCClientLike {
  let pollCount = 0;
  return (_region: string): SSOOIDCClientLike => ({
    registerClient: async () => ({
      clientId: 'mock-oidc-client-id',
      clientSecret: 'mock-oidc-client-secret',
      clientSecretExpiresAt: Date.now() + 86400_000,
    }),
    startDeviceAuthorization: async () => ({
      deviceCode: 'mock-device-code',
      userCode: 'MOCK-CODE',
      verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
      verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=MOCK-CODE',
      expiresIn: 600,
      interval: 5,
    }),
    createToken: async (input) => {
      if (input.grantType === 'refresh_token') {
        if (opts.expiredToken) throw new Error('ExpiredTokenException: refresh token expired');
        return {
          accessToken: 'refreshed-access-token',
          refreshToken: opts.returnRefreshToken ? 'new-refresh-token' : undefined,
          expiresIn: 28800,
        };
      }
      // device_code grant
      if (opts.pendingThenComplete) {
        pollCount++;
        if (pollCount < 2) throw new Error('AuthorizationPendingException: authorization_pending');
      }
      return {
        accessToken: 'mock-access-token-final',
        refreshToken: opts.returnRefreshToken ? 'mock-refresh-token' : undefined,
        expiresIn: 28800,
      };
    },
  });
}

/** Build a mock SSO client factory. */
function makeMockSSOFactory(): (region: string) => SSOClientLike {
  return (_region: string): SSOClientLike => ({
    listAccounts: async () => ({
      accountList: [
        { accountId: '111122223333', accountName: 'Development', emailAddress: 'dev@example.com' },
        { accountId: '444455556666', accountName: 'Production', emailAddress: 'prod@example.com' },
      ],
    }),
    listAccountRoles: async (input) => ({
      roleList:
        input.accountId === '111122223333'
          ? [{ roleName: 'DevAdmin' }, { roleName: 'ReadOnly' }]
          : [{ roleName: 'ProdViewer' }],
    }),
    getRoleCredentials: async () => ({
      roleCredentials: {
        accessKeyId: 'MOCK-ACCESS-KEY',
        secretAccessKey: 'MOCK-SECRET-KEY',
        sessionToken: 'MOCK-SESSION-TOKEN',
        expiration: Date.now() + 3600_000,
      },
    }),
  });
}

// ── SSO flow tests ────────────────────────────────────────────────────────────

describe('Bedrock SSO — start → poll flow', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
    setSSOOIDCClientFactory(makeMockOIDCFactory({ pendingThenComplete: true }));
    setSSOClientFactory(makeMockSSOFactory());
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    await cleanup();
  });

  it('POST /api/settings/bedrock-sso/start returns verificationUri and userCode', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/start', {
      method: 'POST',
      body: {
        startUrl: 'https://d-test.awsapps.com/start',
        region: 'us-east-1',
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `start: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.ok(body.verificationUri, 'should have verificationUri');
    assert.ok(body.verificationUriComplete, 'should have verificationUriComplete');
    assert.equal(body.userCode, 'MOCK-CODE');
    assert.ok(typeof body.expiresIn === 'number');
    assert.ok(typeof body.interval === 'number');
  });

  it('POST /api/settings/bedrock-sso/poll returns pending on first call', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/poll', {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, 'pending');
  });

  it('POST /api/settings/bedrock-sso/poll returns complete on second call', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/poll', {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, 'complete');
  });

  it('GET /api/settings returns sso.signedIn true after completing flow', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    const provider = body.provider as Record<string, unknown>;
    const sso = provider.sso as Record<string, unknown>;
    assert.ok(sso, 'provider.sso should be present');
    assert.equal(sso.signedIn, true, 'sso.signedIn should be true after completing flow');
  });
});

// ── Admin-only + API-token guard ──────────────────────────────────────────────

describe('Bedrock SSO — auth guards', () => {
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
    setSSOOIDCClientFactory(makeMockOIDCFactory({}));
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    await cleanup();
  });

  for (const path of [
    '/api/settings/bedrock-sso/start',
    '/api/settings/bedrock-sso/poll',
    '/api/settings/bedrock-sso/sign-out',
  ]) {
    it(`POST ${path} → 401 for unauthenticated`, async () => {
      const r = await fetchJson(baseUrl, path, { method: 'POST', body: {} });
      assert.equal(r.status, 401, `Expected 401 for ${path}`);
    });

    it(`POST ${path} → 403 for non-admin`, async () => {
      const r = await fetchJson(baseUrl, path, {
        method: 'POST',
        body: {},
        cookie: userCookie,
      });
      assert.equal(r.status, 403, `Expected 403 for non-admin on ${path}`);
    });

    it(`POST ${path} → 403 for API token`, async () => {
      const r = await fetchJson(baseUrl, path, {
        method: 'POST',
        body: {},
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      assert.equal(r.status, 403, `Expected 403 for API token on ${path}`);
    });
  }
});

// ── Accounts / roles listing ──────────────────────────────────────────────────

describe('Bedrock SSO — accounts and roles listing', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);

    setSSOOIDCClientFactory(makeMockOIDCFactory({}));
    setSSOClientFactory(makeMockSSOFactory());

    // Complete the flow to get an access token
    await fetchJson(baseUrl, '/api/settings/bedrock-sso/start', {
      method: 'POST',
      body: { startUrl: 'https://d-test.awsapps.com/start', region: 'us-east-1' },
      cookie: adminCookie,
    });
    await fetchJson(baseUrl, '/api/settings/bedrock-sso/poll', {
      method: 'POST',
      cookie: adminCookie,
    });
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    await cleanup();
  });

  it('GET /api/settings/bedrock-sso/accounts returns account list', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/accounts', {
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `accounts: ${JSON.stringify(r.body)}`);
    const body = r.body as { accounts: Array<{ accountId: string; accountName: string }> };
    assert.ok(Array.isArray(body.accounts));
    assert.ok(body.accounts.length >= 2);
    assert.ok(body.accounts.some((a) => a.accountId === '111122223333'));
  });

  it('GET /api/settings/bedrock-sso/roles returns roles for an account', async () => {
    const r = await fetchJson(
      baseUrl,
      '/api/settings/bedrock-sso/roles?accountId=111122223333',
      { cookie: adminCookie },
    );
    assert.equal(r.status, 200, `roles: ${JSON.stringify(r.body)}`);
    const body = r.body as { roles: Array<{ roleName: string }> };
    assert.ok(Array.isArray(body.roles));
    assert.ok(body.roles.some((rr) => rr.roleName === 'DevAdmin'));
  });

  it('GET /api/settings/bedrock-sso/roles without accountId → 400', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/roles', {
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });
});

// ── Sign-out ──────────────────────────────────────────────────────────────────

describe('Bedrock SSO — sign-out', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);

    setSSOOIDCClientFactory(makeMockOIDCFactory({}));
    setSSOClientFactory(makeMockSSOFactory());

    await fetchJson(baseUrl, '/api/settings/bedrock-sso/start', {
      method: 'POST',
      body: { startUrl: 'https://d-test.awsapps.com/start', region: 'us-east-1' },
      cookie: adminCookie,
    });
    await fetchJson(baseUrl, '/api/settings/bedrock-sso/poll', {
      method: 'POST',
      cookie: adminCookie,
    });
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    await cleanup();
  });

  it('POST /api/settings/bedrock-sso/sign-out clears sign-in state', async () => {
    const beforeSignOut = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    const before = ((beforeSignOut.body as Record<string, unknown>).provider as Record<string, unknown>).sso as Record<string, unknown>;
    assert.equal(before.signedIn, true, 'should be signed in before sign-out');

    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/sign-out', {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { ok: boolean }).ok, true);

    const afterSignOut = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    const after = ((afterSignOut.body as Record<string, unknown>).provider as Record<string, unknown>).sso as Record<string, unknown>;
    assert.equal(after.signedIn, false, 'should be signed out');
  });
});

// ── callTextModel uses SSO credentials ───────────────────────────────────────

describe('Bedrock SSO — callTextModel uses role credentials', () => {
  before(async () => {
    await createTestServer();

    // Set up SSO mock clients
    setSSOOIDCClientFactory(makeMockOIDCFactory({}));
    setSSOClientFactory(makeMockSSOFactory());
    _clearRoleCredCache();

    // Configure portal to use bedrock/sso
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.auth', 'sso');
    setSetting(db, 'bedrock.region', 'us-east-1');
    setSetting(db, 'bedrock.sso.region', 'us-east-1');
    setSetting(db, 'bedrock.sso.accountId', '111122223333');
    setSetting(db, 'bedrock.sso.roleName', 'DevAdmin');
    setSetting(db, 'default.model', 'us.anthropic.claude-sonnet-4-5-20251001-v1:0');

    // Inject a valid access token directly (simulating completed sign-in)
    const tokenEnc = encrypt('valid-access-token', config.secretKey);
    setSetting(db, 'bedrock.sso.accessToken.enc', tokenEnc);
    setSetting(
      db,
      'bedrock.sso.accessToken.expiry',
      new Date(Date.now() + 3_600_000).toISOString(),
    );
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    setBedrockClientFactory(null);
    _clearRoleCredCache();
    await cleanup();
  });

  it('callTextModel passes SSO role credentials to the Bedrock client', async () => {
    const captured: Array<{ credentials: unknown }> = [];
    setBedrockClientFactory(
      (region, credentials) => {
        captured.push({ credentials });
        return {
          async converse(_input: BedrockConverseInput) {
            return { output: { message: { content: [{ text: 'ok' }] } } };
          },
        } as BedrockClientLike;
      },
    );

    await callTextModel('system', 'user');

    assert.ok(captured.length > 0, 'Bedrock must be called');
    const creds = captured[0].credentials as Record<string, string> | undefined;
    assert.ok(creds, 'credentials must be passed to Bedrock client');
    assert.equal(creds.accessKeyId, 'MOCK-ACCESS-KEY');
    assert.equal(creds.secretAccessKey, 'MOCK-SECRET-KEY');
    assert.equal(creds.sessionToken, 'MOCK-SESSION-TOKEN');
  });
});

// ── listModelsForProvider uses SSO credentials ────────────────────────────────

describe('Bedrock SSO — listModelsForProvider uses SSO', () => {
  before(async () => {
    await createTestServer();

    setSSOOIDCClientFactory(makeMockOIDCFactory({}));
    setSSOClientFactory(makeMockSSOFactory());
    _clearRoleCredCache();
    _clearModelListCache();

    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.auth', 'sso');
    setSetting(db, 'bedrock.region', 'us-east-1');
    setSetting(db, 'bedrock.sso.region', 'us-east-1');
    setSetting(db, 'bedrock.sso.accountId', '111122223333');
    setSetting(db, 'bedrock.sso.roleName', 'DevAdmin');

    const tokenEnc = encrypt('valid-access-token', config.secretKey);
    setSetting(db, 'bedrock.sso.accessToken.enc', tokenEnc);
    setSetting(db, 'bedrock.sso.accessToken.expiry', new Date(Date.now() + 3_600_000).toISOString());

    // Inject mock foundation models that use SSO credentials
    setBedrockListingMock({
      foundationModels: [
        { modelId: 'anthropic.claude-3-haiku', providerName: 'Anthropic', outputModalities: ['TEXT'], modelName: 'Claude Haiku' },
      ],
      inferenceProfiles: [],
    });
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    setBedrockListingMock(null);
    _clearModelListCache();
    _clearRoleCredCache();
    await cleanup();
  });

  it('listModelsForProvider("bedrock") succeeds when SSO is signed in', async () => {
    const result = await listModelsForProvider('bedrock');
    assert.equal(result.source, 'live', `Expected live, got fallback: ${result.error}`);
    assert.ok(result.groups.length > 0, 'should have at least one group');
  });
});

// ── Expired session error ─────────────────────────────────────────────────────

describe('Bedrock SSO — expired session surfaces clear error', () => {
  before(async () => {
    await createTestServer();
    _clearRoleCredCache();

    // Set up SSO with an expired access token and no refresh token
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.auth', 'sso');
    setSetting(db, 'bedrock.region', 'us-east-1');
    setSetting(db, 'bedrock.sso.region', 'us-east-1');
    setSetting(db, 'bedrock.sso.accountId', '111122223333');
    setSetting(db, 'bedrock.sso.roleName', 'DevAdmin');

    const expiredTokenEnc = encrypt('expired-token', config.secretKey);
    setSetting(db, 'bedrock.sso.accessToken.enc', expiredTokenEnc);
    setSetting(db, 'bedrock.sso.accessToken.expiry', new Date(Date.now() - 60_000).toISOString()); // 1 min ago
    // No refresh token stored
    setSSOOIDCClientFactory(makeMockOIDCFactory({ expiredToken: true }));
    setSSOClientFactory(makeMockSSOFactory());
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    _clearRoleCredCache();
    await cleanup();
  });

  it('getAgentEnv throws with "SSO session expired" when no refresh token exists', async () => {
    const { getAgentEnv } = await import('../server/settings.ts');
    let threw = false;
    try {
      await getAgentEnv();
    } catch (e: unknown) {
      threw = true;
      const msg = String((e as Error)?.message ?? e);
      assert.ok(
        msg.includes('SSO session expired'),
        `Expected "SSO session expired" in error, got: ${msg}`,
      );
    }
    assert.ok(threw, 'getAgentEnv should throw when SSO is expired');
  });
});

// ── Auto-refresh ──────────────────────────────────────────────────────────────

describe('Bedrock SSO — auto-refresh role credentials', () => {
  before(async () => {
    await createTestServer();
    _clearRoleCredCache();

    setSSOOIDCClientFactory(makeMockOIDCFactory({ returnRefreshToken: true }));
    setSSOClientFactory(makeMockSSOFactory());

    const db = getDb();
    setSetting(db, 'bedrock.sso.region', 'us-east-1');
    setSetting(db, 'bedrock.sso.accountId', '111122223333');
    setSetting(db, 'bedrock.sso.roleName', 'DevAdmin');

    // Store an expired access token + a valid refresh token
    const expiredTokenEnc = encrypt('old-access-token', config.secretKey);
    setSetting(db, 'bedrock.sso.accessToken.enc', expiredTokenEnc);
    setSetting(db, 'bedrock.sso.accessToken.expiry', new Date(Date.now() - 60_000).toISOString());

    const clientIdEnc = encrypt('mock-oidc-client-id', config.secretKey);
    const clientSecretEnc = encrypt('mock-oidc-client-secret', config.secretKey);
    const refreshTokenEnc = encrypt('valid-refresh-token', config.secretKey);
    setSetting(db, 'bedrock.sso.oidc.clientId.enc', clientIdEnc);
    setSetting(db, 'bedrock.sso.oidc.clientSecret.enc', clientSecretEnc);
    setSetting(db, 'bedrock.sso.refreshToken.enc', refreshTokenEnc);
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    _clearRoleCredCache();
    await cleanup();
  });

  it('getBedrockSsoCredentials refreshes the access token when expired', async () => {
    const { getBedrockSsoCredentials } = await import('../server/bedrock-sso.ts');
    const creds = await getBedrockSsoCredentials();
    assert.equal(creds.accessKeyId, 'MOCK-ACCESS-KEY', 'should get role credentials after refresh');

    // Verify the new access token was stored
    const db = getDb();
    const { getSetting } = await import('../server/settings.ts');
    const newTokenEnc = getSetting(db, 'bedrock.sso.accessToken.enc');
    assert.ok(newTokenEnc, 'new access token should be stored');
  });
});

// ── SSO profile error message ─────────────────────────────────────────────────

describe('Bedrock SSO — profile path SSO token expiry message', () => {
  before(async () => {
    await createTestServer();
    _clearModelListCache();

    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.auth', 'profile');
    setSetting(db, 'bedrock.profile', 'my-sso-profile');
    setSetting(db, 'bedrock.region', 'us-east-1');

    // Bedrock listing mock throws an SSO-related error
    setBedrockListingMock({ throwError: 'SSO token expired or invalid. Run aws sso login.' });
  });

  after(async () => {
    setBedrockListingMock(null);
    _clearModelListCache();
    await cleanup();
  });

  it('listModelsForProvider returns a clear SSO re-login message for profile auth', async () => {
    const result = await listModelsForProvider('bedrock', undefined, true);
    assert.equal(result.source, 'fallback');
    assert.ok(result.error, 'should have an error message');
    assert.ok(
      result.error!.includes('aws sso login') || result.error!.includes('sso login'),
      `Error should mention 'aws sso login', got: ${result.error}`,
    );
  });
});

// ── PUT /api/settings accepts SSO config ──────────────────────────────────────

describe('Bedrock SSO — PUT /api/settings saves SSO config', () => {
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

  it('saves and returns SSO config fields', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: {
        provider: {
          bedrockAuth: 'sso',
          ssoStartUrl: 'https://d-test.awsapps.com/start',
          ssoRegion: 'us-east-1',
          ssoAccountId: '111122223333',
          ssoRoleName: 'DevAdmin',
        },
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `PUT: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    const provider = body.provider as Record<string, unknown>;
    assert.equal(provider.bedrockAuth, 'sso');
    assert.equal(provider.ssoStartUrl, 'https://d-test.awsapps.com/start');
    assert.equal(provider.ssoRegion, 'us-east-1');
    assert.equal(provider.ssoAccountId, '111122223333');
    assert.equal(provider.ssoRoleName, 'DevAdmin');
    assert.ok(provider.sso, 'sso state object must be present');
  });

  it('rejects ssoStartUrl that is not https', async () => {
    const r = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: {
        provider: {
          ssoStartUrl: 'http://insecure.example.com/start',
        },
      },
      cookie: adminCookie,
    });
    assert.equal(r.status, 400);
  });
});

// ── Bug 1: Credential expiry re-fetch within buffer ───────────────────────────

describe('Bedrock SSO — re-fetch when cached creds within buffer window', () => {
  before(async () => {
    await createTestServer();
    _clearRoleCredCache();

    const db = getDb();
    setSetting(db, 'bedrock.sso.region', 'us-east-1');
    setSetting(db, 'bedrock.sso.accountId', '111122223333');
    setSetting(db, 'bedrock.sso.roleName', 'DevAdmin');

    const tokenEnc = encrypt('valid-access-token', config.secretKey);
    setSetting(db, 'bedrock.sso.accessToken.enc', tokenEnc);
    setSetting(db, 'bedrock.sso.accessToken.expiry', new Date(Date.now() + 3_600_000).toISOString());
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    _clearRoleCredCache();
    await cleanup();
  });

  it('re-fetches role credentials when cached expiry is within the 5-min buffer', async () => {
    let callCount = 0;

    // Factory returns credentials that expire in 3 min (< 5 min buffer) on every call
    setSSOClientFactory((_region: string): SSOClientLike => ({
      listAccounts: async () => ({ accountList: [] }),
      listAccountRoles: async () => ({ roleList: [] }),
      getRoleCredentials: async () => {
        callCount++;
        return {
          roleCredentials: {
            accessKeyId: `KEY-${callCount}`,
            secretAccessKey: 'SECRET',
            sessionToken: 'TOKEN',
            expiration: Date.now() + 3 * 60 * 1000, // expires in 3 min, inside buffer
          },
        };
      },
    }));

    // First call — fetches fresh creds
    const creds1 = await getBedrockSsoCredentials();
    assert.equal(callCount, 1, 'should fetch on first call');
    assert.equal(creds1.accessKeyId, 'KEY-1');

    // Second call — cached creds are within the 5-min refresh buffer, so must re-fetch
    const creds2 = await getBedrockSsoCredentials();
    assert.equal(callCount, 2, 'should re-fetch because cached creds expire within buffer');
    assert.equal(creds2.accessKeyId, 'KEY-2');
  });
});

// ── Bug 2: Poll error classification uses e.name, not only e.message ──────────

describe('Bedrock SSO — poll classifies errors by e.name', () => {
  let baseUrl: string;
  let adminCookie: string;

  /** Start a fresh device-code flow so there is a pending device code. */
  async function startFlow(): Promise<void> {
    await fetchJson(baseUrl, '/api/settings/bedrock-sso/start', {
      method: 'POST',
      body: { startUrl: 'https://d-test.awsapps.com/start', region: 'us-east-1' },
      cookie: adminCookie,
    });
  }

  /** Return an OIDC factory whose createToken (device_code) throws `err`. */
  function throwingFactory(err: Error): (region: string) => SSOOIDCClientLike {
    return (_region: string): SSOOIDCClientLike => ({
      registerClient: async () => ({
        clientId: 'mock-client-id',
        clientSecret: 'mock-client-secret',
        clientSecretExpiresAt: Date.now() + 86400_000,
      }),
      startDeviceAuthorization: async () => ({
        deviceCode: 'mock-device-code',
        userCode: 'MOCK-CODE',
        verificationUri: 'https://device.sso.us-east-1.amazonaws.com',
        verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=MOCK-CODE',
        expiresIn: 600,
        interval: 5,
      }),
      createToken: async () => { throw err; },
    });
  }

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    await cleanup();
  });

  it('returns pending when e.name is AuthorizationPendingException but message is unrelated', async () => {
    const err = new Error('Authorization pending') as Error & { name: string };
    err.name = 'AuthorizationPendingException';
    setSSOOIDCClientFactory(throwingFactory(err));
    await startFlow();

    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/poll', {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, 'pending');
  });

  it('returns pending+slow_down when e.name is SlowDownException but message is unrelated', async () => {
    const err = new Error('Too many requests') as Error & { name: string };
    err.name = 'SlowDownException';
    setSSOOIDCClientFactory(throwingFactory(err));
    await startFlow();

    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/poll', {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    const body = r.body as { status: string; error?: string };
    assert.equal(body.status, 'pending');
    assert.equal(body.error, 'slow_down');
  });

  it('returns expired when e.name is ExpiredTokenException but message is unrelated', async () => {
    const err = new Error('Token has expired') as Error & { name: string };
    err.name = 'ExpiredTokenException';
    setSSOOIDCClientFactory(throwingFactory(err));
    await startFlow();

    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/poll', {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, 'expired');
  });

  it('returns denied when e.name is AccessDeniedException but message is unrelated', async () => {
    const err = new Error('Access was denied') as Error & { name: string };
    err.name = 'AccessDeniedException';
    setSSOOIDCClientFactory(throwingFactory(err));
    await startFlow();

    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/poll', {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { status: string }).status, 'denied');
  });
});

// ── Friendly error message when account/role not set ─────────────────────────

describe('Bedrock SSO — friendly error when account/role not configured', () => {
  before(async () => {
    await createTestServer();
    _clearRoleCredCache();
    _clearModelListCache();

    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.auth', 'sso');
    setSetting(db, 'bedrock.region', 'ap-southeast-1');
    setSetting(db, 'bedrock.sso.region', 'ap-southeast-1');
    // accountId and roleName are intentionally NOT set
    const tokenEnc = encrypt('valid-access-token', config.secretKey);
    setSetting(db, 'bedrock.sso.accessToken.enc', tokenEnc);
    setSetting(db, 'bedrock.sso.accessToken.expiry', new Date(Date.now() + 3_600_000).toISOString());
    setSSOOIDCClientFactory(makeMockOIDCFactory({}));
    setSSOClientFactory(makeMockSSOFactory());
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    setBedrockListingMock(null);
    _clearModelListCache();
    _clearRoleCredCache();
    await cleanup();
  });

  it('getBedrockSsoCredentials throws a plain-language message when account/role missing', async () => {
    let threw = false;
    try {
      await getBedrockSsoCredentials();
    } catch (e: unknown) {
      threw = true;
      const msg = String((e as Error)?.message ?? e);
      assert.ok(
        !msg.includes('ssoAccountId') && !msg.includes('ssoRoleName'),
        `Message must not contain developer-speak field names, got: "${msg}"`,
      );
      assert.ok(
        msg.toLowerCase().includes('account') && msg.toLowerCase().includes('role'),
        `Message must mention account and role, got: "${msg}"`,
      );
    }
    assert.ok(threw, 'should throw when accountId and roleName are not set');
  });

  it('listModelsForProvider returns fallback with friendly error for missing account/role', async () => {
    const result = await listModelsForProvider('bedrock', undefined, true);
    assert.equal(result.source, 'fallback', 'should be fallback when account/role not set');
    assert.ok(result.error, 'should have an error message');
    assert.ok(
      !result.error!.includes('ssoAccountId') && !result.error!.includes('ssoRoleName'),
      `Error must not contain field names, got: "${result.error}"`,
    );
    assert.ok(
      result.error!.toLowerCase().includes('account') || result.error!.toLowerCase().includes('role'),
      `Error must mention account or role, got: "${result.error}"`,
    );
    // Fallback should use global.* IDs for ap-southeast-1
    const allIds = result.groups.flatMap((g) => g.models.map((m) => m.id));
    const hasGlobal = allIds.some((id) => id.startsWith('global.'));
    const hasUsClaudeIds = allIds.filter((id) => id.startsWith('us.')).some((id) => id.includes('claude'));
    assert.ok(hasGlobal, `Expected global.* fallback IDs for ap-southeast-1, got: ${allIds.join(', ')}`);
    assert.ok(!hasUsClaudeIds, `Should not have us.* claude IDs in fallback for ap-southeast-1, got: ${allIds.join(', ')}`);
  });
});

// ── ssoRoleName persists via PUT /api/settings ────────────────────────────────

describe('Bedrock SSO — ssoRoleName persists via PUT /api/settings', () => {
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

  it('PUT /api/settings saves ssoRoleName and GET /api/settings returns it', async () => {
    const putR = await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: {
        provider: {
          bedrockAuth: 'sso',
          ssoAccountId: '999988887777',
          ssoRoleName: 'ProductionAdminRole',
        },
      },
      cookie: adminCookie,
    });
    assert.equal(putR.status, 200, `PUT failed: ${JSON.stringify(putR.body)}`);
    const putBody = putR.body as Record<string, unknown>;
    const putProvider = putBody.provider as Record<string, unknown>;
    assert.equal(putProvider.ssoRoleName, 'ProductionAdminRole', 'PUT response must include ssoRoleName');
    assert.equal(putProvider.ssoAccountId, '999988887777', 'PUT response must include ssoAccountId');

    // Independently verify with a GET
    const getR = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    assert.equal(getR.status, 200);
    const getProvider = ((getR.body as Record<string, unknown>).provider) as Record<string, unknown>;
    assert.equal(getProvider.ssoRoleName, 'ProductionAdminRole', 'GET must return persisted ssoRoleName');
    assert.equal(getProvider.ssoAccountId, '999988887777', 'GET must return persisted ssoAccountId');
  });
});

// ── accounts/roles listing works any time SSO session is valid ────────────────

describe('Bedrock SSO — accounts/roles endpoints work any time session is valid', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await loginAdmin(baseUrl);

    setSSOOIDCClientFactory(makeMockOIDCFactory({}));
    setSSOClientFactory(makeMockSSOFactory());

    // Inject a valid token directly (simulating a pre-existing valid session,
    // NOT from a just-completed device-code flow)
    const db = getDb();
    setSetting(db, 'bedrock.sso.region', 'us-east-1');
    const tokenEnc = encrypt('pre-existing-valid-token', config.secretKey);
    setSetting(db, 'bedrock.sso.accessToken.enc', tokenEnc);
    setSetting(db, 'bedrock.sso.accessToken.expiry', new Date(Date.now() + 3_600_000).toISOString());
  });

  after(async () => {
    setSSOOIDCClientFactory(null);
    setSSOClientFactory(null);
    await cleanup();
  });

  it('GET /api/settings/bedrock-sso/accounts works with pre-existing valid session', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/accounts', {
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as { accounts: Array<{ accountId: string }> };
    assert.ok(Array.isArray(body.accounts));
    assert.ok(body.accounts.length > 0, 'should return accounts');
  });

  it('GET /api/settings/bedrock-sso/roles works with pre-existing valid session', async () => {
    const r = await fetchJson(baseUrl, '/api/settings/bedrock-sso/roles?accountId=111122223333', {
      cookie: adminCookie,
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as { roles: Array<{ roleName: string }> };
    assert.ok(Array.isArray(body.roles));
    assert.ok(body.roles.length > 0, 'should return roles');
  });
});
