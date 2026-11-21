/**
 * Bedrock provider tests for the shared model-provider helper (Task 2).
 *
 * Coverage:
 *   - callTextModel picks Bedrock when portal provider is bedrock
 *   - callTextModel picks Anthropic when user has api_key credential (user cred > portal)
 *   - Bedrock Converse request has correct shape (modelId, system, messages, inferenceConfig)
 *   - callTextModel throws a clear error when provider.mode === 'demo'
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup } from './fixtures.ts';
import {
  setBedrockClientFactory,
  setKiroRunnerOverride,
  pickTextEngine,
  textPromptLimit,
  KIRO_RUNNER_MAX_PROMPT,
  callTextModel,
  type BedrockClientLike,
  type BedrockConverseInput,
} from '../server/testing/model-provider.ts';
import { setSetting } from '../server/settings.ts';
import { getDb, insert, run as dbRun } from '../server/db.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import { generateId, now } from '../server/util.ts';

// ── Mock helpers ───────────────────────────────────────────────────────────────

function makeMockBedrockFactory(
  captured: Array<{ region: string; credentials: unknown; input: BedrockConverseInput }>,
  responseText = 'mock response',
): (region: string, credentials?: unknown) => BedrockClientLike {
  return (region, credentials) => ({
    async converse(input: BedrockConverseInput) {
      captured.push({ region, credentials, input });
      return { output: { message: { content: [{ text: responseText }] } } };
    },
  });
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('Bedrock provider — callTextModel', () => {
  before(async () => {
    // createTestServer opens the in-memory DB and sets config — no HTTP needed for these tests
    await createTestServer();
  });

  after(async () => {
    setBedrockClientFactory(null);
    await cleanup();
  });

  afterEach(() => {
    // Restore default provider mode so tests don't bleed into each other
    try { setSetting(getDb(), 'provider.mode', 'demo'); } catch { /* DB may be closed */ }
    setBedrockClientFactory(null);
  });

  it('throws a clear error when provider mode is demo', async () => {
    // Default test DB has no provider.mode setting; fallback = 'demo'
    await assert.rejects(
      () => callTextModel('system', 'user'),
      (err: Error) => {
        assert.ok(
          err.message.includes('No AI provider configured'),
          `unexpected message: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('calls Bedrock when portal provider is bedrock', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.region', 'us-west-2');
    setSetting(db, 'bedrock.auth', 'ambient');
    // Configure a model ID so callTextModel doesn't throw
    setSetting(db, 'model.sonnet', 'anthropic.claude-3-5-sonnet-20241022-v1:0');

    const captured: Array<{ region: string; credentials: unknown; input: BedrockConverseInput }> = [];
    setBedrockClientFactory(makeMockBedrockFactory(captured, 'bedrock result'));

    const result = await callTextModel('You are a test assistant.', 'Say hello.', { maxTokens: 512 });

    assert.equal(result, 'bedrock result', 'should return text from mock Bedrock response');
    assert.ok(captured.length > 0, 'Bedrock factory should have been invoked');
  });

  it('Bedrock request has correct shape', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.region', 'ap-southeast-1');
    setSetting(db, 'bedrock.auth', 'ambient');
    // Configure an inference-profile model ID — should be passed as-is, never prefixed
    setSetting(db, 'model.sonnet', 'us.anthropic.claude-3-5-sonnet-20241022-v1:0');

    const captured: Array<{ region: string; credentials: unknown; input: BedrockConverseInput }> = [];
    setBedrockClientFactory(makeMockBedrockFactory(captured));

    await callTextModel('System instruction here.', 'User turn here.', { maxTokens: 256 });

    assert.ok(captured.length > 0, 'should have one Bedrock call');
    const { region, input } = captured[0];

    assert.equal(region, 'ap-southeast-1', 'region should match portal settings');
    assert.ok(input.modelId, 'modelId must be present');
    // The model ID must be passed as-is — do NOT prefix with 'anthropic.' so that
    // inference-profile IDs (us.anthropic.*, global.anthropic.*) work correctly.
    assert.equal(
      input.modelId,
      'us.anthropic.claude-3-5-sonnet-20241022-v1:0',
      `modelId must be passed as configured (no rewriting), got "${input.modelId}"`,
    );
    assert.ok(Array.isArray(input.system) && input.system.length === 1, 'system should be a single-item array');
    assert.ok(
      input.system![0].text.includes('System instruction here'),
      'system text should contain the system prompt',
    );
    assert.ok(Array.isArray(input.messages) && input.messages.length === 1, 'messages should have one item');
    assert.equal(input.messages[0].role, 'user', 'message role should be user');
    assert.ok(
      (input.messages[0].content[0] as { text?: string }).text?.includes('User turn here'),
      'user message content should match input',
    );
    assert.equal(input.inferenceConfig?.maxTokens, 256, 'inferenceConfig.maxTokens should be passed through');
  });

  it('Bedrock credentials from portal keys auth are forwarded to the factory', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.region', 'eu-west-1');
    setSetting(db, 'bedrock.auth', 'keys');
    setSetting(db, 'bedrock.access_key_id', 'AKIA_PORTAL_KEY');
    setSetting(db, 'bedrock.secret_key.enc', encrypt('portal-secret-key', config.secretKey));
    setSetting(db, 'model.sonnet', 'anthropic.claude-3-5-sonnet-20241022-v1:0');

    const captured: Array<{ region: string; credentials: unknown; input: BedrockConverseInput }> = [];
    setBedrockClientFactory(makeMockBedrockFactory(captured));

    await callTextModel('system', 'user');

    assert.ok(captured.length > 0, 'factory should have been called');
    const creds = captured[0].credentials as { accessKeyId?: string } | undefined;
    assert.ok(creds?.accessKeyId === 'AKIA_PORTAL_KEY', `expected accessKeyId 'AKIA_PORTAL_KEY', got '${creds?.accessKeyId}'`);
  });

  it('uses the chosen credential and model even when the portal provider is not set (demo)', async () => {
    const db = getDb();
    setSetting(db, 'provider.mode', 'demo');
    const userId = generateId();
    const ts = now();
    insert('users', { id: userId, email: `choice-${Date.now()}@test.com`, name: 'Choice', password_hash: 'x', is_admin: 0, disabled: 0, created_at: ts });
    const mk = (name: string, isDefault: number): string => {
      const id = generateId();
      insert('engine_credentials', {
        id, user_id: userId, engine: 'claude-code', name, mode: 'api_key', secret_enc: encrypt(`sk-ant-${name}`, config.secretKey),
        extra_config: '{}', is_default: isDefault, last4: name.slice(-4), created_at: ts, updated_at: ts, updated_by: userId,
      });
      return id;
    };
    const defaultCred = mk('default-key', 1);
    const chosenCred = mk('chosen-key', 0);

    const seen: { key: string; model: string }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('anthropic.com')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({ key: headers['x-api-key'] ?? '', model: body.model ?? '' });
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return origFetch(url, init);
    };
    try {
      // The person's default credential is enough: no "No AI provider configured" although the portal has none.
      setSetting(db, 'model.sonnet', 'claude-sonnet-portal');
      assert.equal(await callTextModel('s', 'u', { createdBy: userId }), 'ok');
      // A chosen credential and model win over the default ones.
      assert.equal(await callTextModel('s', 'u', { createdBy: userId, credentialId: chosenCred, model: 'claude-chosen-model' }), 'ok');
    } finally {
      globalThis.fetch = origFetch;
      dbRun('DELETE FROM engine_credentials WHERE user_id = ?', userId);
      dbRun('DELETE FROM users WHERE id = ?', userId);
    }
    assert.equal(seen.length, 2);
    assert.equal(seen[0].key, 'sk-ant-default-key');
    assert.equal(seen[1].key, 'sk-ant-chosen-key');
    assert.equal(seen[1].model, 'claude-chosen-model');
    void defaultCred;
  });

  it('a person with only a Kiro credential is served by the Kiro runner, and an explicit Claude choice still wins', async () => {
    setSetting(getDb(), 'provider.mode', 'demo');
    const userId = generateId();
    const ts = now();
    insert('users', { id: userId, email: `kiro-only-${Date.now()}@test.com`, name: 'Kiro only', password_hash: 'x', is_admin: 0, disabled: 0, created_at: ts });
    const cred = (engine: string, name: string): string => {
      const id = generateId();
      insert('engine_credentials', {
        id, user_id: userId, engine, name, mode: engine === 'kiro' ? 'identity_center' : 'api_key', secret_enc: encrypt('x', config.secretKey),
        extra_config: '{}', is_default: 0, last4: 'abcd', created_at: ts, updated_at: ts, updated_by: userId,
      });
      return id;
    };
    const kiroCred = cred('kiro', 'my kiro');
    const calls: { prompt: string; credentialId: string | null }[] = [];
    setKiroRunnerOverride(async (prompt, _u, credentialId) => { calls.push({ prompt, credentialId }); return 'kiro says hi'; });
    try {
      assert.equal(await pickTextEngine(userId, null), 'kiro');
      assert.equal(await pickTextEngine(userId, kiroCred), 'kiro');
      assert.equal(await pickTextEngine(null, null), null);
      const text = await callTextModel('Be brief.', 'Say hi.', { createdBy: userId });
      assert.equal(text, 'kiro says hi');
      assert.match(calls[0].prompt, /Be brief\.[\s\S]*Say hi\.[\s\S]*requested output only/);
      assert.equal(await callTextModel('s', 'u', { createdBy: userId, credentialId: kiroCred }), 'kiro says hi');
      assert.equal(calls[1].credentialId, kiroCred);
      // Once the person has a Claude credential too, theirs is the default engine (unless they choose the Kiro one).
      const claudeCred = cred('claude-code', 'my claude');
      assert.equal(await pickTextEngine(userId, null), 'claude-code');
      assert.equal(await pickTextEngine(userId, kiroCred), 'kiro');
      assert.equal(await pickTextEngine(userId, claudeCred), 'claude-code');
      // Someone else's credential id is not usable.
      assert.equal(await pickTextEngine(generateId(), kiroCred), null);
    } finally {
      setKiroRunnerOverride(null);
      dbRun('DELETE FROM engine_credentials WHERE user_id = ?', userId);
      dbRun('DELETE FROM users WHERE id = ?', userId);
    }
  });

  it('the Kiro runner takes 100,000 characters: the limit is known, and a longer prompt is refused with a clear message', async () => {
    setSetting(getDb(), 'provider.mode', 'demo');
    const userId = generateId();
    const ts = now();
    insert('users', { id: userId, email: `kiro-limit-${Date.now()}@test.com`, name: 'Kiro limit', password_hash: 'x', is_admin: 0, disabled: 0, created_at: ts });
    const cred = (engine: string): string => {
      const id = generateId();
      insert('engine_credentials', {
        id, user_id: userId, engine, name: `my ${engine}`, mode: engine === 'kiro' ? 'identity_center' : 'api_key', secret_enc: encrypt('x', config.secretKey),
        extra_config: '{}', is_default: 0, last4: 'abcd', created_at: ts, updated_at: ts, updated_by: userId,
      });
      return id;
    };
    const kiroCred = cred('kiro');
    const sent: number[] = [];
    setKiroRunnerOverride(async (prompt) => { sent.push(prompt.length); return 'ok'; });
    try {
      assert.equal(KIRO_RUNNER_MAX_PROMPT, 100_000);
      assert.equal(await textPromptLimit(userId, null), 99_400, 'system and user text may take what is left after the reply instructions');
      assert.equal(await textPromptLimit(null, null), null, 'no person, no Kiro');
      assert.equal(await textPromptLimit(userId, cred('claude-code')), null, 'a Claude sign-in takes longer text');
      assert.equal(await textPromptLimit(userId, kiroCred), 99_400);

      // Text that fits within the limit reaches the runner; text over it never does.
      assert.equal(await callTextModel('s', 'x'.repeat(99_000), { createdBy: userId, credentialId: kiroCred }), 'ok');
      await assert.rejects(
        callTextModel('s', 'x'.repeat(100_001), { createdBy: userId, credentialId: kiroCred }),
        /Kiro accepts at most 100,000.*shorter document/,
      );
      assert.equal(sent.length, 1, 'only the first reached the runner');
    } finally {
      setKiroRunnerOverride(null);
      dbRun('DELETE FROM engine_credentials WHERE user_id = ?', userId);
      dbRun('DELETE FROM users WHERE id = ?', userId);
    }
  });

  it('user api_key credential takes precedence over portal bedrock', async () => {
    const db = getDb();

    // Set portal to bedrock mode
    setSetting(db, 'provider.mode', 'bedrock');
    setSetting(db, 'bedrock.region', 'us-east-1');
    setSetting(db, 'bedrock.auth', 'ambient');
    setSetting(db, 'model.sonnet', 'anthropic.claude-3-sonnet-20240229-v1:0');

    // Create a user with an Anthropic api_key credential
    const userId = generateId();
    const ts = now();
    insert('users', {
      id: userId,
      email: `bedrock-prio-${Date.now()}@test.com`,
      name: 'Priority Test User',
      password_hash: 'not-used',
      is_admin: 0,
      disabled: 0,
      created_at: ts,
    });
    const credId = generateId();
    insert('engine_credentials', {
      id: credId,
      user_id: userId,
      engine: 'claude-code',
      name: 'My Anthropic Key',
      mode: 'api_key',
      secret_enc: encrypt('sk-ant-fake-key', config.secretKey),
      extra_config: '{}',
      is_default: 1,
      last4: '-key',
      created_at: ts,
      updated_at: ts,
      updated_by: userId,
    });

    const bedrockCalls: BedrockConverseInput[] = [];
    setBedrockClientFactory((_region) => ({
      async converse(input: BedrockConverseInput) {
        bedrockCalls.push(input);
        return { output: { message: { content: [{ text: 'should not reach' }] } } };
      },
    }));

    // Mock fetch so the Anthropic call succeeds without a real key
    let anthropicHit = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('anthropic.com')) {
        anthropicHit = true;
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'anthropic text' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return origFetch(url, init);
    };

    try {
      const result = await callTextModel('system', 'user', { createdBy: userId });
      assert.equal(result, 'anthropic text', 'should use Anthropic when user has api_key credential');
    } finally {
      globalThis.fetch = origFetch;
      dbRun('DELETE FROM engine_credentials WHERE id = ?', credId);
      dbRun('DELETE FROM users WHERE id = ?', userId);
    }

    assert.equal(bedrockCalls.length, 0, 'Bedrock must NOT be called when user has api_key credential');
    assert.equal(anthropicHit, true, 'Anthropic API must be called for user with api_key credential');
  });
});
