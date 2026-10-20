/**
 * Models endpoint unit tests.
 *
 * Covered:
 *   1. Failure is never cached — next call after an error succeeds cleanly
 *   2. Success list is cached — repeated calls within TTL return the same data
 *   3. ?refresh=1 bypasses the cache on a successful list
 *   4. clearModelListCache() lets the next call hit the real provider
 *   5. Cache cleared by settings save (provider change)
 *   6. Cache cleared by SSO /select
 *   7. ExpiredToken / 'security token … expired' → friendly user message
 *   8. AccessDeniedException → mentions bedrock:ListInferenceProfiles and bedrock:ListFoundationModels
 *   9. SSO auth + no account/role selected → clear message
 *  10. bedrock-key auth → "type the model ID" message
 *
 * All Bedrock SDK calls are intercepted via setBedrockClientFactory (seam in server/models.ts).
 * No real network calls are made.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, Client, type TestServer } from './client.ts';

// ─── Lazily-resolved server modules ───────────────────────────────────────────

let modelsMod: typeof import('../server/models.ts');
let settingsMod: typeof import('../server/settings.ts');
let ssoMod: typeof import('../server/sso.ts');
let dbMod: typeof import('../server/db.ts');
let secretsMod: typeof import('../server/secrets.ts');

// ─── Server bootstrap ─────────────────────────────────────────────────────────

let srv: TestServer;
let admin: Client;

before(async () => {
  srv = await bootServer();
  admin = new Client(srv.base);

  modelsMod = await import('../server/models.ts');
  settingsMod = await import('../server/settings.ts');
  ssoMod = await import('../server/sso.ts');
  dbMod = await import('../server/db.ts');
  secretsMod = await import('../server/secrets.ts');

  await admin.post('/api/auth/setup', {
    email: 'modelstest@example.com',
    name: 'Models Test Admin',
    password: 'a-very-long-test-password',
  });
});

after(() => srv.close());

// ─── Helpers ──────────────────────────────────────────────────────────────────

type AnyCmd = { constructor: { name: string }; input?: Record<string, unknown> };

function makeBedrockClient(handler: (cmd: AnyCmd) => Promise<any>) {
  return { send: handler } as any;
}

/** Minimal successful Bedrock response: two inference profiles, one foundation model. */
function makeSuccessHandler() {
  return makeBedrockClient(async (cmd: AnyCmd) => {
    const name = cmd.constructor.name;
    if (name === 'ListInferenceProfilesCommand') {
      return {
        inferenceProfileSummaries: [
          {
            inferenceProfileId: 'us.anthropic.claude-haiku-3-5',
            inferenceProfileName: 'Claude Haiku 3.5 US',
          },
          {
            inferenceProfileId: 'us.anthropic.claude-sonnet-4-5',
            inferenceProfileName: 'Claude Sonnet 4.5 US',
          },
        ],
        nextToken: undefined,
      };
    }
    if (name === 'ListFoundationModelsCommand') {
      return {
        modelSummaries: [
          { modelId: 'anthropic.claude-instant-v1', modelName: 'Claude Instant' },
        ],
      };
    }
    throw new Error(`Unexpected Bedrock command: ${name}`);
  });
}

function makeErrorHandler(error: Error) {
  return makeBedrockClient(async (_cmd: AnyCmd) => {
    throw error;
  });
}

/** Switch global settings to bedrock + ambient auth. */
async function useBedrock() {
  await admin.put('/api/settings', {
    provider: { mode: 'bedrock' },
    aws: { region: 'us-east-1', auth: 'ambient' },
  });
}

/** Switch global settings to demo mode. */
async function useDemo() {
  await admin.put('/api/settings', { provider: { mode: 'demo' } });
}

function putStoredSsoTokens(): void {
  const payload = JSON.stringify({
    accessToken: 'mock-sso-access-token',
    refreshToken: null,
    expiresAt: Date.now() + 3600_000,
  });
  dbMod.run(
    "INSERT INTO settings (key, value) VALUES ('sso_tokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    secretsMod.encrypt(payload),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Failure is never cached — next call after an error succeeds
// ─────────────────────────────────────────────────────────────────────────────

describe('Cache: failure is never served from cache', () => {
  before(async () => {
    await useBedrock();
    modelsMod.clearModelListCache();
  });

  test('a failed call does not cache the error; the next call that succeeds returns models', async () => {
    // First call: throw an ExpiredToken error
    modelsMod.setBedrockClientFactory((_region: string, _creds: any) =>
      makeErrorHandler(
        Object.assign(new Error('The security token included in the request is expired'), {
          name: 'ExpiredTokenException',
        }),
      ),
    );

    const r1 = await admin.req('GET', '/api/models');
    assert.equal(r1.status, 200, 'errors are non-fatal for /api/models');
    assert.ok(r1.data.error, 'error field must be present on failure');
    assert.equal(r1.data.models.length, 0, 'no models when call fails');

    // Second call with a success handler — must NOT return the cached error
    modelsMod.setBedrockClientFactory((_region: string, _creds: any) => makeSuccessHandler());

    const r2 = await admin.req('GET', '/api/models');
    assert.equal(r2.status, 200);
    assert.equal(r2.data.error, '', 'error must be empty after successful call');
    assert.ok(r2.data.models.length > 0, 'successful call must return models');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Success list is cached — repeated calls within TTL return same data
// ─────────────────────────────────────────────────────────────────────────────

describe('Cache: success list is cached', () => {
  before(async () => {
    await useBedrock();
    modelsMod.clearModelListCache();
  });

  test('repeated calls within the TTL hit the cache (factory called only once)', async () => {
    let calls = 0;
    modelsMod.setBedrockClientFactory((_region: string, _creds: any) => {
      calls++;
      return makeSuccessHandler();
    });

    // First call — populates cache
    const r1 = await admin.req('GET', '/api/models');
    assert.equal(r1.status, 200);
    assert.equal(r1.data.error, '');
    assert.ok(r1.data.models.length > 0);

    const callsAfterFirst = calls;

    // Second and third calls — must use cache
    const r2 = await admin.req('GET', '/api/models');
    const r3 = await admin.req('GET', '/api/models');

    assert.equal(r2.data.models.length, r1.data.models.length, 'cached result must be identical');
    assert.equal(r3.data.models.length, r1.data.models.length);
    // The factory is called per BedrockClient construction; two commands are sent per real call.
    // We just assert no extra factory calls happened after the first.
    assert.equal(calls, callsAfterFirst, 'Bedrock factory must not be called again while cache is fresh');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ?refresh=1 bypasses the cache
// ─────────────────────────────────────────────────────────────────────────────

describe('Cache: ?refresh=1 bypasses the cache', () => {
  before(async () => {
    await useBedrock();
    modelsMod.clearModelListCache();
  });

  test('GET /api/models?refresh=1 always calls the provider even when cache is warm', async () => {
    let calls = 0;
    modelsMod.setBedrockClientFactory((_region: string, _creds: any) => {
      calls++;
      return makeSuccessHandler();
    });

    // Warm the cache
    await admin.req('GET', '/api/models');
    const afterWarm = calls;

    // Normal call — should use cache
    await admin.req('GET', '/api/models');
    assert.equal(calls, afterWarm, 'normal call should use cache');

    // ?refresh=1 — must bypass cache
    const r = await admin.req('GET', '/api/models?refresh=1');
    assert.equal(r.status, 200);
    assert.ok(calls > afterWarm, '?refresh=1 must call the Bedrock provider again');
    assert.equal(r.data.error, '');
    assert.ok(r.data.models.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. clearModelListCache() lets the next call hit the real provider
// ─────────────────────────────────────────────────────────────────────────────

describe('clearModelListCache() evicts the cache', () => {
  before(async () => {
    await useBedrock();
    modelsMod.clearModelListCache();
  });

  test('after clearModelListCache() the next normal call re-fetches from the provider', async () => {
    let calls = 0;
    modelsMod.setBedrockClientFactory((_region: string, _creds: any) => {
      calls++;
      return makeSuccessHandler();
    });

    // Warm the cache
    await admin.req('GET', '/api/models');
    const afterWarm = calls;

    // Clear the cache
    modelsMod.clearModelListCache();

    // Next normal call must re-fetch
    await admin.req('GET', '/api/models');
    assert.ok(calls > afterWarm, 'clearModelListCache() must force re-fetch on next call');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cache cleared by settings save (provider change)
// ─────────────────────────────────────────────────────────────────────────────

describe('Cache cleared by PUT /api/settings', () => {
  before(async () => {
    await useBedrock();
    modelsMod.clearModelListCache();
  });

  test('saving provider settings evicts the model-list cache', async () => {
    let calls = 0;
    modelsMod.setBedrockClientFactory((_region: string, _creds: any) => {
      calls++;
      return makeSuccessHandler();
    });

    // Warm the cache
    await admin.req('GET', '/api/models');
    const afterWarm = calls;

    // Saving provider settings must clear the cache
    await admin.put('/api/settings', { provider: { mode: 'bedrock', models: { sonnet: '', haiku: '', opus: '' } } });

    // Next call must re-fetch
    await admin.req('GET', '/api/models');
    assert.ok(calls > afterWarm, 'PUT /api/settings (provider) must evict model list cache');
  });

  test('saving aws settings evicts the model-list cache', async () => {
    let calls = 0;
    modelsMod.setBedrockClientFactory((_region: string, _creds: any) => {
      calls++;
      return makeSuccessHandler();
    });

    modelsMod.clearModelListCache();
    await admin.req('GET', '/api/models');
    const afterWarm = calls;

    await admin.put('/api/settings', { aws: { region: 'us-east-1', auth: 'ambient' } });

    await admin.req('GET', '/api/models');
    assert.ok(calls > afterWarm, 'PUT /api/settings (aws) must evict model list cache');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cache cleared by SSO /select
// ─────────────────────────────────────────────────────────────────────────────

describe('Cache cleared by POST /api/sso/select', () => {
  before(async () => {
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: { region: 'us-east-1', auth: 'sso', ssoRegion: 'us-east-1', ssoAccountId: '111111111111', ssoRoleName: 'ReadOnlyAccess' },
    });
    putStoredSsoTokens();
    ssoMod.resetSsoState();
    modelsMod.clearModelListCache();
  });

  after(() => {
    dbMod.run("DELETE FROM settings WHERE key = 'sso_tokens'");
    ssoMod.resetSsoState();
  });

  test('POST /api/sso/select clears the model-list cache', async () => {
    let calls = 0;

    // SSO factory: return creds so awsEnv() works
    ssoMod.setSsoClientFactory((_region: string) => ({
      send: async (cmd: AnyCmd) => {
        if (cmd.constructor.name === 'GetRoleCredentialsCommand') {
          return {
            roleCredentials: {
              accessKeyId: 'SSO_KEY',
              secretAccessKey: 'SSO_SECRET',
              sessionToken: 'SSO_SESSION',
              expiration: Date.now() + 3600_000,
            },
          };
        }
        throw new Error(`Unexpected SSO cmd: ${cmd.constructor.name}`);
      },
    }) as any);

    modelsMod.setBedrockClientFactory((_region: string, _creds: any) => {
      calls++;
      return makeSuccessHandler();
    });

    // Warm the cache
    await admin.req('GET', '/api/models');
    const afterWarm = calls;

    // Selecting a new account/role must evict the cache
    await admin.post('/api/sso/select', { accountId: '222222222222', roleName: 'PowerUserAccess' });

    // Re-fetch must go to the provider
    await admin.req('GET', '/api/models');
    assert.ok(calls > afterWarm, 'POST /api/sso/select must evict model list cache');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. ExpiredToken / 'security token … expired' → friendly user message
// ─────────────────────────────────────────────────────────────────────────────

describe('Error mapping: expired token', () => {
  before(async () => {
    await useBedrock();
    modelsMod.clearModelListCache();
  });

  for (const [label, err] of [
    [
      'ExpiredTokenException by code',
      Object.assign(new Error('The security token included in the request is expired'), {
        name: 'ExpiredTokenException',
      }),
    ],
    [
      'ExpiredToken by code',
      Object.assign(new Error('Token expired'), { name: 'ExpiredToken' }),
    ],
    [
      'message contains "security token"',
      new Error('The security token included in the request is expired'),
    ],
  ] as [string, Error][]) {
    test(`${label} → friendly "session has expired" message`, async () => {
      modelsMod.clearModelListCache();
      modelsMod.setBedrockClientFactory((_region: string, _creds: any) =>
        makeErrorHandler(err),
      );
      const r = await admin.req('GET', '/api/models');
      assert.equal(r.status, 200, '/api/models must not return 5xx for auth errors');
      assert.ok(r.data.error, 'error must be non-empty');
      assert.match(
        r.data.error,
        /session has expired|sign in again/i,
        `error must mention session expiry; got: "${r.data.error}"`,
      );
      // Must not expose raw AWS message
      assert.ok(
        !r.data.error.toLowerCase().includes('security token included in'),
        'raw AWS error text must not appear in user-facing message',
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. AccessDeniedException → mentions missing permissions
// ─────────────────────────────────────────────────────────────────────────────

describe('Error mapping: access denied', () => {
  before(async () => {
    await useBedrock();
    modelsMod.clearModelListCache();
  });

  for (const [label, err] of [
    [
      'AccessDeniedException by code',
      Object.assign(new Error('User is not authorized to perform bedrock:ListInferenceProfiles'), {
        name: 'AccessDeniedException',
      }),
    ],
    [
      'AccessDenied by code',
      Object.assign(new Error('Access denied'), { name: 'AccessDenied' }),
    ],
  ] as [string, Error][]) {
    test(`${label} → mentions bedrock:ListInferenceProfiles and bedrock:ListFoundationModels`, async () => {
      modelsMod.clearModelListCache();
      modelsMod.setBedrockClientFactory((_region: string, _creds: any) =>
        makeErrorHandler(err),
      );
      const r = await admin.req('GET', '/api/models');
      assert.equal(r.status, 200);
      assert.ok(r.data.error, 'error must be non-empty');
      assert.match(
        r.data.error,
        /ListInferenceProfiles/,
        `error must mention ListInferenceProfiles; got: "${r.data.error}"`,
      );
      assert.match(
        r.data.error,
        /ListFoundationModels/,
        `error must mention ListFoundationModels; got: "${r.data.error}"`,
      );
      assert.match(
        r.data.error,
        /model id|type.*id|paste/i,
        `error must tell user they can type a model ID; got: "${r.data.error}"`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. SSO auth + no account/role selected → clear message
// ─────────────────────────────────────────────────────────────────────────────

describe('Error mapping: SSO with no account/role selected', () => {
  before(async () => {
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      // SSO auth but no accountId/roleName
      aws: { region: 'us-east-1', auth: 'sso', ssoRegion: 'us-east-1' },
    });
    dbMod.run("DELETE FROM settings WHERE key = 'sso_tokens'");
    ssoMod.resetSsoState();
    modelsMod.clearModelListCache();
  });

  after(async () => {
    await useBedrock(); // restore ambient auth
  });

  test('SSO without account/role returns a message asking the user to select first', async () => {
    const r = await admin.req('GET', '/api/models');
    assert.equal(r.status, 200, '/api/models must not return 5xx when SSO is not configured');
    assert.ok(r.data.error, 'error must be non-empty');
    // Should explain why and what to do — either the friendly message or the underlying one
    assert.ok(
      r.data.error.toLowerCase().includes('account') || r.data.error.toLowerCase().includes('role') || r.data.error.toLowerCase().includes('sign in'),
      `error must mention account/role/sign-in; got: "${r.data.error}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. bedrock-key auth → "type the model ID" message
// ─────────────────────────────────────────────────────────────────────────────

describe('Error mapping: bedrock-key auth', () => {
  before(async () => {
    await admin.put('/api/settings', {
      provider: { mode: 'bedrock' },
      aws: { region: 'us-east-1', auth: 'bedrock-key' },
    });
    modelsMod.clearModelListCache();
  });

  after(async () => {
    await useBedrock(); // restore ambient auth
  });

  test('bedrock-key auth returns a message telling the user to type the model ID', async () => {
    const r = await admin.req('GET', '/api/models');
    assert.equal(r.status, 200);
    assert.ok(r.data.error, 'error must be non-empty for bedrock-key');
    assert.match(
      r.data.error,
      /model id|type.*id/i,
      `error must tell user to type a model ID; got: "${r.data.error}"`,
    );
  });
});
