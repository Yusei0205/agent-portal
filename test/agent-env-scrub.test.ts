/**
 * Feature D — credential scrubbing for agent shell commands.
 *
 * Tests:
 *   1. scrubEnvForShell: credential vars are removed, safe vars pass through
 *   2. isDeniedVar: exact names and suffix patterns
 *   3. shouldScrubSdkEnv: platform and override behaviour
 *   4. Integration: CLAUDE_CODE_DISABLE_AUTO_MEMORY and MCP_TOOL_TIMEOUT are always set
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scrubEnvForShell, isDeniedVar, shouldScrubSdkEnv } from '../server/agent/env-scrub.ts';

// ── isDeniedVar ───────────────────────────────────────────────────────────────

describe('isDeniedVar — exact credential names', () => {
  const exact = [
    'ANTHROPIC_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'PORTAL_SECRET_KEY',
    'PORTAL_RUN_TOKEN',
    'PORTAL_API_TOKEN',
    'GITHUB_TOKEN',
    'KIRO_API_KEY',
    'OPENAI_API_KEY',
    'LITELLM_API_KEY',
  ];
  for (const name of exact) {
    test(`blocks exact: ${name}`, () => {
      assert.ok(isDeniedVar(name), `expected ${name} to be denied`);
    });
  }
});

describe('isDeniedVar — suffix patterns', () => {
  test('blocks *_SECRET suffix', () => {
    assert.ok(isDeniedVar('MY_APP_SECRET'));
    assert.ok(isDeniedVar('PROJECT_AWS_SECRET'));
    assert.ok(isDeniedVar('SOME_SERVICE_SECRET'));
  });

  test('blocks *_TOKEN suffix', () => {
    assert.ok(isDeniedVar('REFRESH_TOKEN'));
    assert.ok(isDeniedVar('ACCESS_TOKEN'));
    assert.ok(isDeniedVar('DEPLOYMENT_TOKEN'));
  });

  test('blocks *_KEY suffix', () => {
    assert.ok(isDeniedVar('ENCRYPTION_KEY'));
    assert.ok(isDeniedVar('PRIVATE_KEY'));
    assert.ok(isDeniedVar('PROJECT_AWS_SECRET_ACCESS_KEY'));
  });

  test('case-insensitive suffix matching', () => {
    assert.ok(isDeniedVar('my_app_secret'));   // lowercase _secret
    assert.ok(isDeniedVar('My_Api_Key'));       // mixed case _key
    assert.ok(isDeniedVar('ACCESS_token'));     // lowercase _token
  });
});

describe('isDeniedVar — safe names pass through', () => {
  const safe = [
    'PATH',
    'HOME',
    'USER',
    'USERNAME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'NODE_ENV',
    'NODE_PATH',
    'NPM_CONFIG_PREFIX',
    'LANG',
    'LC_ALL',
    'TERM',
    'SHELL',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_PROFILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
    'PROJECT_AWS_REGION',
    'PROJECT_AWS_FILES',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'MCP_TOOL_TIMEOUT',
    'DEBUG',
    'PORTAL_KIRO_FAKE',
  ];
  for (const name of safe) {
    test(`allows: ${name}`, () => {
      assert.equal(isDeniedVar(name), false, `unexpected denial of ${name}`);
    });
  }
});

// ── scrubEnvForShell ──────────────────────────────────────────────────────────

describe('scrubEnvForShell — removes credentials, keeps safe vars', () => {
  test('removes ANTHROPIC_API_KEY', () => {
    const result = scrubEnvForShell({ ANTHROPIC_API_KEY: 'sk-ant-test', PATH: '/usr/bin' });
    assert.equal(result.ANTHROPIC_API_KEY, undefined, 'API key must be removed');
    assert.equal(result.PATH, '/usr/bin', 'PATH must be kept');
  });

  test('removes AWS credential vars', () => {
    const env = {
      AWS_ACCESS_KEY_ID: 'AKIA123',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-token',
      AWS_REGION: 'us-east-1',  // this should be kept
    };
    const result = scrubEnvForShell(env);
    assert.equal(result.AWS_ACCESS_KEY_ID, undefined, 'AWS_ACCESS_KEY_ID removed');
    assert.equal(result.AWS_SECRET_ACCESS_KEY, undefined, 'AWS_SECRET_ACCESS_KEY removed');
    assert.equal(result.AWS_SESSION_TOKEN, undefined, 'AWS_SESSION_TOKEN removed');
    assert.equal(result.AWS_BEARER_TOKEN_BEDROCK, undefined, 'AWS_BEARER_TOKEN_BEDROCK removed');
    assert.equal(result.AWS_REGION, 'us-east-1', 'AWS_REGION kept (not a credential)');
  });

  test('removes portal secrets', () => {
    const result = scrubEnvForShell({
      PORTAL_SECRET_KEY: 'my-secret',
      PORTAL_RUN_TOKEN: 'run-tok',
      PORTAL_KIRO_FAKE: '1',        // safe portal var — kept
    });
    assert.equal(result.PORTAL_SECRET_KEY, undefined);
    assert.equal(result.PORTAL_RUN_TOKEN, undefined);
    assert.equal(result.PORTAL_KIRO_FAKE, '1', 'non-credential portal var kept');
  });

  test('removes *_SECRET, *_TOKEN, *_KEY pattern vars', () => {
    const result = scrubEnvForShell({
      MY_SERVICE_SECRET: 'shhh',
      REFRESH_TOKEN: 'tok',
      ENCRYPTION_KEY: 'key123',
      NODE_ENV: 'production',         // safe
    });
    assert.equal(result.MY_SERVICE_SECRET, undefined);
    assert.equal(result.REFRESH_TOKEN, undefined);
    assert.equal(result.ENCRYPTION_KEY, undefined);
    assert.equal(result.NODE_ENV, 'production', 'NODE_ENV is kept');
  });

  test('skips undefined values', () => {
    const result = scrubEnvForShell({ UNDEFINED_VAR: undefined, HOME: '/home/user' });
    assert.equal('UNDEFINED_VAR' in result, false);
    assert.equal(result.HOME, '/home/user');
  });

  test('PROJECT_AWS_FILES is kept (contains a path, not a secret)', () => {
    const result = scrubEnvForShell({
      PROJECT_AWS_FILES: '/data/run-aws/run-123',
      AWS_SECRET_ACCESS_KEY: 'scrubme',
    });
    assert.equal(result.PROJECT_AWS_FILES, '/data/run-aws/run-123', 'PROJECT_AWS_FILES kept');
    assert.equal(result.AWS_SECRET_ACCESS_KEY, undefined);
  });

  test('on Linux and macOS, scrub function always works regardless of platform', () => {
    // scrubEnvForShell is pure and platform-independent
    const result = scrubEnvForShell({
      ANTHROPIC_API_KEY: 'sk-test',
      HOME: '/home/agent',
      PATH: '/usr/bin:/bin',
    });
    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.HOME, '/home/agent');
    assert.equal(result.PATH, '/usr/bin:/bin');
  });
});

// ── shouldScrubSdkEnv ─────────────────────────────────────────────────────────

describe('shouldScrubSdkEnv — respects PORTAL_AGENT_ENV_SCRUB override', () => {
  let originalEnv: string | undefined;

  before(() => {
    originalEnv = process.env.PORTAL_AGENT_ENV_SCRUB;
  });

  after(() => {
    if (originalEnv === undefined) {
      delete process.env.PORTAL_AGENT_ENV_SCRUB;
    } else {
      process.env.PORTAL_AGENT_ENV_SCRUB = originalEnv;
    }
  });

  test('PORTAL_AGENT_ENV_SCRUB=1 forces on regardless of platform', () => {
    process.env.PORTAL_AGENT_ENV_SCRUB = '1';
    assert.equal(shouldScrubSdkEnv(), true);
  });

  test('PORTAL_AGENT_ENV_SCRUB=0 forces off regardless of platform', () => {
    process.env.PORTAL_AGENT_ENV_SCRUB = '0';
    assert.equal(shouldScrubSdkEnv(), false);
  });

  test('without override: returns true on Windows, false on Linux/macOS', () => {
    delete process.env.PORTAL_AGENT_ENV_SCRUB;
    const result = shouldScrubSdkEnv();
    if (process.platform === 'win32') {
      assert.equal(result, true, 'Windows: scrub is on by default');
    } else {
      assert.equal(result, false, 'Linux/macOS: scrub is off by default (sandbox required)');
    }
  });
});

// ── Settings integration: getAgentEnv sets required env vars ─────────────────

describe('getAgentEnv sets CLAUDE_CODE_DISABLE_AUTO_MEMORY and MCP_TOOL_TIMEOUT', () => {
  before(() => {
    process.env.DEMO_SPEED = '0';
    process.env.PORTAL_SECRET_KEY = 'test-secret-key-for-env-scrub-tests';
    process.env.PORTAL_NO_AUTOSTART = '1';
  });

  after(() => {
    delete process.env.DEMO_SPEED;
    delete process.env.PORTAL_SECRET_KEY;
    delete process.env.PORTAL_NO_AUTOSTART;
  });

  test('auto-memory disabled and MCP timeout set for all provider modes', async () => {
    const { createTestDb, cleanup } = await import('./fixtures.ts');
    const { getAgentEnv } = await import('../server/settings.ts');
    createTestDb();
    try {
      const env = await getAgentEnv();
      assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'auto-memory always disabled');
      assert.ok(env.MCP_TOOL_TIMEOUT, 'MCP timeout should be set');
      const timeoutMs = Number(env.MCP_TOOL_TIMEOUT);
      assert.ok(timeoutMs > 0, 'MCP timeout should be positive');
      assert.equal(timeoutMs, 10 * 60_000, 'default MCP timeout is 10 minutes in ms');
    } finally {
      await cleanup();
    }
  });
});
