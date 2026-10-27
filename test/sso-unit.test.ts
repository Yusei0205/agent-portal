/**
 * SSO unit / integration tests covering gaps not exercised by sso.test.ts.
 *
 * Covered here:
 *   1. Region-dropdown data in Settings.jsx (AWS_REGIONS constant, RegionSelect logic)
 *   2. Device-flow poller states: authorization_pending, slow_down (interval growth),
 *      expired_token, success (tokens stored encrypted in DB)
 *   3. awsEnv() / agentEnv() with auth=sso + provider=bedrock
 *   4. Role-credentials caching until ~5 min before expiry, then re-fetch
 *   5. Refresh-token path; clear error when expired with no refresh token
 *   6. ListAccounts / ListAccountRoles pagination via the HTTP API
 *
 * All AWS SDK calls are intercepted via the injectable client factory seams added to
 * server/sso.ts.  No real network calls are made.
 *
 * Design note: server modules are imported dynamically inside before() so that
 * bootServer() can set DATA_DIR *before* server/config.ts is evaluated.
 *
 * Run as part of: npm test   (node --test test/*.test.ts)
 */

import { test, before, after, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';

// ─── AWS SDK command name helpers ─────────────────────────────────────────────
// The injectable factories return objects with a `send(cmd)` method.

type AnyCmd = { constructor: { name: string } };

function makeOidcClient(handler: (cmd: AnyCmd) => Promise<any>) {
  return { send: handler } as any;
}

function makeSsoClient(handler: (cmd: AnyCmd) => Promise<any>) {
  return { send: handler } as any;
}

// ─── Lazily-resolved server modules ───────────────────────────────────────────
// Loaded after bootServer() in before(), so DATA_DIR is set before config.ts runs.

let ssoMod: typeof import('../server/sso.ts');
let settingsMod: typeof import('../server/settings.ts');
let dbMod: typeof import('../server/db.ts');
let secretsMod: typeof import('../server/secrets.ts');

// ─── Server bootstrap ─────────────────────────────────────────────────────────

let srv: TestServer;
let admin: Client;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);

  // Load server modules now that DATA_DIR + DB are initialised
  ssoMod = await import('../server/sso.ts');
  settingsMod = await import('../server/settings.ts');
  dbMod = await import('../server/db.ts');
  secretsMod = await import('../server/secrets.ts');

  await admin.post('/api/auth/setup', {
    email: 'ssounit@example.com',
    name: 'SSO Unit Admin',
    password: 'a-very-long-test-password',
  });
  // Switch to bedrock + SSO auth for most tests
  await admin.put('/api/settings', {
    provider: { mode: 'bedrock' },
    aws: { region: 'ap-southeast-1', auth: 'sso', ssoRegion: 'us-east-1' },
  });
});

after(() => srv.close());

// ─── Helper: write raw SSO tokens directly into the DB ───────────────────────

function putStoredTokens(tokens: {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}): void {
  dbMod.run(
    "INSERT INTO settings (key, value) VALUES ('sso_tokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    secretsMod.encrypt(JSON.stringify(tokens)),
  );
}

function clearStoredTokens(): void {
  dbMod.run("DELETE FROM settings WHERE key = 'sso_tokens'");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Region-dropdown data (Settings.jsx — AWS_REGIONS constant & RegionSelect)
// ─────────────────────────────────────────────────────────────────────────────

describe('Settings RegionSelect (pages/settings/regions.jsx)', () => {
  // We read the source file and extract the AWS_REGIONS constant without
  // executing any browser code. This is a structural test that verifies the
  // data contract the UI relies on.

  let src: string;

  before(() => {
    // Resolve path portably on Windows and POSIX
    const url = new URL('../web/src/pages/settings/regions.jsx', import.meta.url);
    const filePath = fileURLToPath(url);
    src = fs.readFileSync(filePath, 'utf8');
  });

  test('AWS_REGIONS contains ap-southeast-1 (Singapore)', () => {
    assert.ok(
      src.includes("'ap-southeast-1'"),
      'AWS_REGIONS must include ap-southeast-1 (Singapore)',
    );
  });

  test('AWS_REGIONS contains ap-southeast-5 (Malaysia)', () => {
    assert.ok(
      src.includes("'ap-southeast-5'"),
      'AWS_REGIONS must include ap-southeast-5 (Malaysia)',
    );
  });

  test('RegionSelect component renders a <select> not an <input>', () => {
    // Extract just the RegionSelect function body
    const startIdx = src.indexOf('function RegionSelect(');
    const endIdx = src.indexOf('\nfunction ', startIdx + 1);
    const fn = src.slice(startIdx, endIdx);
    assert.ok(fn.includes('<select'), 'RegionSelect must render a <select>');
    assert.ok(!fn.includes('<input'), 'RegionSelect must not render an <input>');
  });

  test('RegionSelect handles custom (unlisted) region values gracefully', () => {
    const startIdx = src.indexOf('function RegionSelect(');
    const endIdx = src.indexOf('\nfunction ', startIdx + 1);
    const fn = src.slice(startIdx, endIdx);
    // The component should detect values not in the canonical list and show them
    assert.ok(
      fn.includes('showCustom') || fn.includes('knownCodes'),
      'RegionSelect must guard against unlisted custom values',
    );
    assert.ok(fn.includes('custom'), 'RegionSelect must label an unlisted region as custom');
  });

  test('AwsSection uses RegionSelect for the Region field (not a bare <input>)', () => {
    const full = fs.readFileSync(fileURLToPath(new URL('../web/src/pages/settings/Providers.jsx', import.meta.url)), 'utf8');
    const startIdx = full.indexOf('function AwsSection(');
    const endIdx = full.indexOf('\nfunction ', startIdx + 1);
    const fn = full.slice(startIdx, endIdx < 0 ? undefined : endIdx);
    assert.ok(fn.includes('RegionSelect'), 'AwsSection must use RegionSelect for the Region field');
  });

  test('SsoFlow uses RegionSelect for the SSO region field (not a bare <input>)', () => {
    const full = fs.readFileSync(fileURLToPath(new URL('../web/src/pages/settings/SsoFlow.jsx', import.meta.url)), 'utf8');
    const startIdx = full.indexOf('function SsoFlow(');
    const endIdx = full.indexOf('\nfunction ', startIdx + 1);
    const fn = full.slice(startIdx, endIdx < 0 ? undefined : endIdx);
    assert.ok(fn.includes('RegionSelect'), 'SsoFlow must use RegionSelect for the SSO region field');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Device-flow poller states
// ─────────────────────────────────────────────────────────────────────────────

describe('Device-flow poller', () => {
  // The poller fires at `(interval || 5) * 1000` ms.
  // Passing interval=0.001 gives 1 ms between polls, making the tests fast.
  const FAST_INTERVAL = 0.001;

  function makeDeviceAuthResponse(interval = FAST_INTERVAL) {
    return {
      deviceCode: 'test-device-code',
      userCode: 'UNIT-TEST',
      verificationUri: 'https://device.sso.us-east-1.amazonaws.com/',
      verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=UNIT-TEST',
      expiresIn: 60,
      interval,
    };
  }

  function makeRegisterClientResponse() {
    return {
      clientId: 'unit-client-id',
      clientSecret: 'unit-client-secret',
      clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400 * 90,
    };
  }

  async function startFlow(): Promise<void> {
    clearStoredTokens();
    ssoMod.resetSsoState();
    const r = await admin.req('POST', '/api/sso/start', {
      startUrl: 'https://test.awsapps.com/start',
      ssoRegion: 'us-east-1',
    });
    assert.equal(r.status, 200, `sso/start failed: ${JSON.stringify(r.data)}`);
  }

  test('authorization_pending keeps state as pending and retries', async () => {
    let calls = 0;
    ssoMod.setOidcClientFactory((_region: string) =>
      makeOidcClient(async (cmd: AnyCmd) => {
        const name = cmd.constructor.name;
        if (name === 'RegisterClientCommand') return makeRegisterClientResponse();
        if (name === 'StartDeviceAuthorizationCommand') return makeDeviceAuthResponse();
        if (name === 'CreateTokenCommand') {
          calls++;
          if (calls < 3) {
            throw Object.assign(new Error('authorization_pending'), {
              name: 'AuthorizationPendingException',
            });
          }
          return { accessToken: 'tok-pending-test', expiresIn: 3600 };
        }
        throw new Error(`Unexpected OIDC command: ${name}`);
      }),
    );

    await startFlow();

    const status = await waitFor(
      async () => {
        const r = await admin.req('GET', '/api/sso/status');
        if (r.data.state === 'authorised') return r.data;
        return null;
      },
      'state === authorised',
      5000,
    );
    assert.equal(status.state, 'authorised');
    assert.ok(calls >= 3, `expected at least 3 CreateToken calls, got ${calls}`);

    await admin.req('DELETE', '/api/sso/session');
    ssoMod.resetSsoState();
  });

  test('slow_down increases the polling interval and eventually succeeds', async () => {
    let calls = 0;
    ssoMod.setOidcClientFactory((_region: string) =>
      makeOidcClient(async (cmd: AnyCmd) => {
        const name = cmd.constructor.name;
        if (name === 'RegisterClientCommand') return makeRegisterClientResponse();
        if (name === 'StartDeviceAuthorizationCommand') return makeDeviceAuthResponse();
        if (name === 'CreateTokenCommand') {
          calls++;
          if (calls === 1) {
            // First call: SlowDown — currentInterval jumps to 5001 ms
            throw Object.assign(new Error('slow_down'), { name: 'SlowDownException' });
          }
          return { accessToken: 'tok-slowdown-test', expiresIn: 3600 };
        }
        throw new Error(`Unexpected OIDC command: ${name}`);
      }),
    );

    clearStoredTokens();
    ssoMod.resetSsoState();
    const r = await admin.req('POST', '/api/sso/start', {
      startUrl: 'https://test.awsapps.com/start',
      ssoRegion: 'us-east-1',
    });
    assert.equal(r.status, 200);

    // After slow_down the interval jumps by 5000 ms; allow up to 8 s
    const status = await waitFor(
      async () => {
        const s = await admin.req('GET', '/api/sso/status');
        if (s.data.state === 'authorised') return s.data;
        return null;
      },
      'authorised after slow_down',
      8000,
    );
    assert.equal(status.state, 'authorised');
    assert.ok(calls >= 2, `expected at least 2 CreateToken calls, got ${calls}`);

    await admin.req('DELETE', '/api/sso/session');
    ssoMod.resetSsoState();
  });

  test('expired_token transitions state to expired with descriptive error', async () => {
    ssoMod.setOidcClientFactory((_region: string) =>
      makeOidcClient(async (cmd: AnyCmd) => {
        const name = cmd.constructor.name;
        if (name === 'RegisterClientCommand') return makeRegisterClientResponse();
        if (name === 'StartDeviceAuthorizationCommand') return makeDeviceAuthResponse();
        if (name === 'CreateTokenCommand') {
          throw Object.assign(new Error('expired_token'), { name: 'ExpiredTokenException' });
        }
        throw new Error(`Unexpected OIDC command: ${name}`);
      }),
    );

    clearStoredTokens();
    ssoMod.resetSsoState();
    const r = await admin.req('POST', '/api/sso/start', {
      startUrl: 'https://test.awsapps.com/start',
      ssoRegion: 'us-east-1',
    });
    assert.equal(r.status, 200);

    const status = await waitFor(
      async () => {
        const s = await admin.req('GET', '/api/sso/status');
        if (s.data.state === 'expired') return s.data;
        return null;
      },
      'state === expired',
      5000,
    );
    assert.equal(status.state, 'expired');
    assert.ok(status.error, 'expired state must include an error message');
    assert.match(status.error, /expired|start again/i);
  });

  test('success: access token stored encrypted in DB, ssoStatus shows signedIn', async () => {
    const expectedToken = 'access-token-encrypted-test-' + Date.now();
    ssoMod.setOidcClientFactory((_region: string) =>
      makeOidcClient(async (cmd: AnyCmd) => {
        const name = cmd.constructor.name;
        if (name === 'RegisterClientCommand') return makeRegisterClientResponse();
        if (name === 'StartDeviceAuthorizationCommand') return makeDeviceAuthResponse();
        if (name === 'CreateTokenCommand') {
          return {
            accessToken: expectedToken,
            refreshToken: 'refresh-tok-' + Date.now(),
            expiresIn: 28800,
          };
        }
        throw new Error(`Unexpected OIDC command: ${name}`);
      }),
    );

    clearStoredTokens();
    ssoMod.resetSsoState();
    const r = await admin.req('POST', '/api/sso/start', {
      startUrl: 'https://test.awsapps.com/start',
      ssoRegion: 'us-east-1',
    });
    assert.equal(r.status, 200);

    await waitFor(
      async () => {
        const s = await admin.req('GET', '/api/sso/status');
        if (s.data.state === 'authorised') return s.data;
        return null;
      },
      'authorised',
      5000,
    );

    // Token must be encrypted in DB, not plaintext
    const row = dbMod.one<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'sso_tokens'",
    );
    assert.ok(row, 'sso_tokens row must exist after successful authorisation');
    assert.ok(!row.value.includes(expectedToken), 'access token must NOT be stored in plaintext');
    assert.ok(row.value.startsWith('v1:'), 'stored value must use v1: AES-GCM encryption prefix');

    // ssoStatus() must reflect signedIn = true
    const st = ssoMod.ssoStatus();
    assert.equal(st.signedIn, true, 'ssoStatus().signedIn must be true after successful auth');

    await admin.req('DELETE', '/api/sso/session');
    ssoMod.resetSsoState();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. awsEnv() / agentEnv() with auth=sso + provider=bedrock
// ─────────────────────────────────────────────────────────────────────────────

describe('awsEnv() / agentEnv() with SSO credentials', () => {
  before(async () => {
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: {
        region: 'ap-southeast-1',
        auth: 'sso',
        ssoRegion: 'us-east-1',
        ssoAccountId: '123456789012',
        ssoRoleName: 'ReadOnlyAccess',
      },
    });
  });

  after(() => {
    clearStoredTokens();
    ssoMod.resetSsoState();
  });

  test('awsEnv() with auth=sso returns AWS_ACCESS_KEY_ID, SECRET, SESSION_TOKEN', async () => {
    putStoredTokens({
      accessToken: 'mock-access-tok',
      refreshToken: null,
      expiresAt: Date.now() + 3600_000,
    });
    ssoMod.resetSsoState();

    ssoMod.setSsoClientFactory((_region: string) =>
      makeSsoClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'GetRoleCredentialsCommand') {
          return {
            roleCredentials: {
              accessKeyId: 'SSO_KEY_ID',
              secretAccessKey: 'SSO_SECRET',
              sessionToken: 'SSO_SESSION',
              expiration: Date.now() + 3600_000,
            },
          };
        }
        throw new Error(`Unexpected SSO command: ${cmd.constructor.name}`);
      }),
    );

    const env = await settingsMod.awsEnv();
    assert.equal(env.AWS_ACCESS_KEY_ID, 'SSO_KEY_ID');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'SSO_SECRET');
    assert.equal(env.AWS_SESSION_TOKEN, 'SSO_SESSION');
    assert.equal(env.AWS_REGION, 'ap-southeast-1');
  });

  test('agentEnv() with provider=bedrock + auth=sso sets CLAUDE_CODE_USE_BEDROCK=1', async () => {
    putStoredTokens({
      accessToken: 'agent-env-tok',
      refreshToken: null,
      expiresAt: Date.now() + 3600_000,
    });
    ssoMod.resetSsoState();

    ssoMod.setSsoClientFactory((_region: string) =>
      makeSsoClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'GetRoleCredentialsCommand') {
          return {
            roleCredentials: {
              accessKeyId: 'AGENT_KEY',
              secretAccessKey: 'AGENT_SECRET',
              sessionToken: 'AGENT_SESSION',
              expiration: Date.now() + 3600_000,
            },
          };
        }
        throw new Error(`Unexpected SSO command: ${cmd.constructor.name}`);
      }),
    );

    const env = await settingsMod.agentEnv();
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1', 'CLAUDE_CODE_USE_BEDROCK must be 1 for bedrock+sso');
    assert.equal(env.AWS_ACCESS_KEY_ID, 'AGENT_KEY');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'AGENT_SECRET');
    assert.equal(env.AWS_SESSION_TOKEN, 'AGENT_SESSION');
  });

  test('agentEnv() strips PORTAL_ vars from the process environment', async () => {
    putStoredTokens({
      accessToken: 'strip-test-tok',
      refreshToken: null,
      expiresAt: Date.now() + 3600_000,
    });
    ssoMod.resetSsoState();

    ssoMod.setSsoClientFactory((_region: string) =>
      makeSsoClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'GetRoleCredentialsCommand') {
          return {
            roleCredentials: {
              accessKeyId: 'STRIP_KEY',
              secretAccessKey: 'STRIP_SECRET',
              sessionToken: 'STRIP_SESSION',
              expiration: Date.now() + 3600_000,
            },
          };
        }
        throw new Error(`Unexpected SSO command: ${cmd.constructor.name}`);
      }),
    );

    const env = await settingsMod.agentEnv();
    const portalVars = Object.keys(env).filter((k) => k.startsWith('PORTAL_'));
    assert.equal(portalVars.length, 0, `PORTAL_ vars must be stripped; found: ${portalVars.join(', ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Role-credentials cached in memory until ~5 min before expiry, then re-fetched
// ─────────────────────────────────────────────────────────────────────────────

describe('Role-credential caching', () => {
  before(async () => {
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: {
        region: 'ap-southeast-1',
        auth: 'sso',
        ssoRegion: 'us-east-1',
        ssoAccountId: '123456789012',
        ssoRoleName: 'ReadOnlyAccess',
      },
    });
  });

  after(() => {
    clearStoredTokens();
    ssoMod.resetSsoState();
  });

  test('successive ssoCredentials() calls within cache window hit the cache', async () => {
    putStoredTokens({
      accessToken: 'cache-test-tok',
      refreshToken: null,
      expiresAt: Date.now() + 3600_000,
    });
    ssoMod.resetSsoState();

    let getRoleCalls = 0;
    ssoMod.setSsoClientFactory((_region: string) =>
      makeSsoClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'GetRoleCredentialsCommand') {
          getRoleCalls++;
          return {
            roleCredentials: {
              accessKeyId: `KEY_CALL_${getRoleCalls}`,
              secretAccessKey: 'SECRET',
              sessionToken: 'SESSION',
              expiration: Date.now() + 3600_000, // fresh — well within cache window
            },
          };
        }
        throw new Error(`Unexpected SSO command: ${cmd.constructor.name}`);
      }),
    );

    const c1 = await ssoMod.ssoCredentials();
    const c2 = await ssoMod.ssoCredentials();
    const c3 = await ssoMod.ssoCredentials();

    assert.equal(getRoleCalls, 1, 'GetRoleCredentials must be called only once when cache is fresh');
    assert.equal(c1.AWS_ACCESS_KEY_ID, c2.AWS_ACCESS_KEY_ID);
    assert.equal(c2.AWS_ACCESS_KEY_ID, c3.AWS_ACCESS_KEY_ID);
  });

  test('ssoCredentials() re-fetches when cached creds are within 5 min of expiry', async () => {
    putStoredTokens({
      accessToken: 'stale-cache-tok',
      refreshToken: null,
      expiresAt: Date.now() + 3600_000,
    });
    ssoMod.resetSsoState();

    let getRoleCalls = 0;
    ssoMod.setSsoClientFactory((_region: string) =>
      makeSsoClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'GetRoleCredentialsCommand') {
          getRoleCalls++;
          return {
            roleCredentials: {
              accessKeyId: `STALE_KEY_${getRoleCalls}`,
              secretAccessKey: 'SECRET',
              sessionToken: 'SESSION',
              // First expiry inside the 5-min buffer → triggers re-fetch on next call
              expiration: getRoleCalls === 1
                ? Date.now() + 200_000  // ~3.3 min — inside the 5-min buffer
                : Date.now() + 3600_000,
            },
          };
        }
        throw new Error(`Unexpected SSO command: ${cmd.constructor.name}`);
      }),
    );

    const c1 = await ssoMod.ssoCredentials(); // caches near-expired creds
    const c2 = await ssoMod.ssoCredentials(); // must re-fetch because cache expires soon

    assert.equal(getRoleCalls, 2, 'GetRoleCredentials must be called twice when first result is near expiry');
    assert.equal(c1.AWS_ACCESS_KEY_ID, 'STALE_KEY_1');
    assert.equal(c2.AWS_ACCESS_KEY_ID, 'STALE_KEY_2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Refresh-token path + clear error when expired with no refresh token
// ─────────────────────────────────────────────────────────────────────────────

describe('Access-token refresh', () => {
  before(async () => {
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: {
        region: 'ap-southeast-1',
        auth: 'sso',
        ssoRegion: 'us-east-1',
        ssoAccountId: '123456789012',
        ssoRoleName: 'ReadOnlyAccess',
      },
    });
  });

  after(() => {
    clearStoredTokens();
    ssoMod.resetSsoState();
  });

  test('ssoCredentials() uses refresh_token grant when access token is near expiry', async () => {
    // Near-expired access token WITH a refresh token
    putStoredTokens({
      accessToken: 'near-expired-access-tok',
      refreshToken: 'valid-refresh-tok',
      expiresAt: Date.now() + 200_000, // ~3 min — within the 5-min refresh buffer
    });
    ssoMod.resetSsoState();

    let createTokenGrantType = '';
    ssoMod.setOidcClientFactory((_region: string) =>
      makeOidcClient(async (cmd: AnyCmd) => {
        const name = cmd.constructor.name;
        if (name === 'RegisterClientCommand') {
          return {
            clientId: 'refresh-client-id',
            clientSecret: 'refresh-client-secret',
            clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400 * 90,
          };
        }
        if (name === 'CreateTokenCommand') {
          // Capture the grant type to verify it is refresh_token
          createTokenGrantType = (cmd as any).grantType ?? (cmd as any).input?.grantType ?? '';
          return {
            accessToken: 'fresh-access-tok-after-refresh',
            refreshToken: 'rotated-refresh-tok',
            expiresIn: 28800,
          };
        }
        throw new Error(`Unexpected OIDC command: ${name}`);
      }),
    );

    ssoMod.setSsoClientFactory((_region: string) =>
      makeSsoClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'GetRoleCredentialsCommand') {
          return {
            roleCredentials: {
              accessKeyId: 'POST_REFRESH_KEY',
              secretAccessKey: 'POST_REFRESH_SECRET',
              sessionToken: 'POST_REFRESH_SESSION',
              expiration: Date.now() + 3600_000,
            },
          };
        }
        throw new Error(`Unexpected SSO command: ${cmd.constructor.name}`);
      }),
    );

    const creds = await ssoMod.ssoCredentials();
    assert.equal(creds.AWS_ACCESS_KEY_ID, 'POST_REFRESH_KEY', 'must use creds obtained after token refresh');
    assert.equal(createTokenGrantType, 'refresh_token', 'refresh must use grant_type=refresh_token');
  });

  test('ssoCredentials() throws a clear "sign in again" error with no refresh token', async () => {
    // Near-expired access token with NO refresh token
    putStoredTokens({
      accessToken: 'expired-access-tok',
      refreshToken: null,
      expiresAt: Date.now() + 200_000,
    });
    ssoMod.resetSsoState();

    // OIDC factory should never be called (no refresh token)
    ssoMod.setOidcClientFactory((_region: string) =>
      makeOidcClient(async (_cmd: AnyCmd) => {
        throw new Error('CreateToken should not be called when refreshToken is null');
      }),
    );

    await assert.rejects(
      () => ssoMod.ssoCredentials(),
      (err: any) => {
        assert.ok(
          err.message?.toLowerCase().includes('expired') ||
            err.message?.toLowerCase().includes('sign in'),
          `Expected session-expired error message, got: "${err.message}"`,
        );
        return true;
      },
    );
  });

  test('GET /api/sso/accounts returns 400 with helpful message when session expired', async () => {
    putStoredTokens({
      accessToken: 'expired-for-accounts',
      refreshToken: null,
      expiresAt: Date.now() + 200_000,
    });
    ssoMod.resetSsoState();

    ssoMod.setOidcClientFactory((_region: string) =>
      makeOidcClient(async (_cmd: AnyCmd) => {
        throw new Error('should not call CreateToken');
      }),
    );

    const r = await admin.req('GET', '/api/sso/accounts');
    assert.equal(r.status, 400);
    assert.ok(
      r.data.error?.toLowerCase().includes('expired') ||
        r.data.error?.toLowerCase().includes('sign in'),
      `Expected session-expired error, got: "${r.data.error}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ListAccounts / ListAccountRoles pagination
// ─────────────────────────────────────────────────────────────────────────────

describe('ListAccounts and ListAccountRoles pagination', () => {
  before(async () => {
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: {
        region: 'ap-southeast-1',
        auth: 'sso',
        ssoRegion: 'us-east-1',
        ssoAccountId: '123456789012',
        ssoRoleName: 'ReadOnlyAccess',
      },
    });
    putStoredTokens({
      accessToken: 'pagination-tok',
      refreshToken: null,
      expiresAt: Date.now() + 3600_000,
    });
    ssoMod.resetSsoState();
  });

  after(() => {
    clearStoredTokens();
    ssoMod.resetSsoState();
  });

  test('GET /api/sso/accounts follows nextToken across pages and returns all accounts', async () => {
    ssoMod.setSsoClientFactory((_region: string) =>
      makeSsoClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name !== 'ListAccountsCommand') {
          throw new Error(`Unexpected SSO command: ${cmd.constructor.name}`);
        }
        // The AWS SDK passes input through cmd.input in newer versions;
        // the command object itself may also have the property directly.
        const c = cmd as any;
        const nt: string | undefined = c.nextToken ?? c.input?.nextToken;
        if (!nt) {
          return {
            accountList: [
              { accountId: '111111111111', accountName: 'Dev', emailAddress: 'dev@example.com' },
              { accountId: '222222222222', accountName: 'Staging', emailAddress: 'staging@example.com' },
            ],
            nextToken: 'page-2-token',
          };
        }
        return {
          accountList: [
            { accountId: '333333333333', accountName: 'Prod', emailAddress: 'prod@example.com' },
          ],
          nextToken: undefined,
        };
      }),
    );

    const r = await admin.req('GET', '/api/sso/accounts');
    assert.equal(r.status, 200, `accounts request failed: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.accounts.length, 3, 'should return all 3 accounts across 2 pages');
    const ids: string[] = r.data.accounts.map((a: any) => a.accountId);
    assert.ok(ids.includes('111111111111'), 'page 1 account 1 must be present');
    assert.ok(ids.includes('222222222222'), 'page 1 account 2 must be present');
    assert.ok(ids.includes('333333333333'), 'page 2 account must be present');
  });

  test('GET /api/sso/roles follows nextToken across pages and returns all roles', async () => {
    ssoMod.setSsoClientFactory((_region: string) =>
      makeSsoClient(async (cmd: AnyCmd) => {
        if (cmd.constructor.name !== 'ListAccountRolesCommand') {
          throw new Error(`Unexpected SSO command: ${cmd.constructor.name}`);
        }
        const c = cmd as any;
        const nt: string | undefined = c.nextToken ?? c.input?.nextToken;
        if (!nt) {
          return {
            roleList: [
              { roleName: 'ReadOnlyAccess', accountId: '123456789012' },
              { roleName: 'PowerUserAccess', accountId: '123456789012' },
            ],
            nextToken: 'roles-page-2',
          };
        }
        return {
          roleList: [{ roleName: 'AdministratorAccess', accountId: '123456789012' }],
          nextToken: undefined,
        };
      }),
    );

    const r = await admin.req('GET', '/api/sso/roles?accountId=123456789012');
    assert.equal(r.status, 200, `roles request failed: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.roles.length, 3, 'should return all 3 roles across 2 pages');
    const names: string[] = r.data.roles.map((ro: any) => ro.roleName);
    assert.ok(names.includes('ReadOnlyAccess'), 'page 1 role 1 must be present');
    assert.ok(names.includes('PowerUserAccess'), 'page 1 role 2 must be present');
    assert.ok(names.includes('AdministratorAccess'), 'page 2 role must be present');
  });
});
