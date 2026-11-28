/**
 * Kiro CLI provider tests for the shared model-provider helper.
 *
 * Coverage:
 *   - callTextModel routes through kiro-cli when provider.mode === 'kiro' and no
 *     personal claude-code credential provides ANTHROPIC_API_KEY / CLAUDE_CODE_USE_BEDROCK.
 *   - --model flag is forwarded from settings.defaultModel (skipped when 'auto' or empty).
 *   - --trust-all-tools is NOT passed (only --trust-tools= for no tool execution).
 *   - Large prompts (>100 KB) arrive at kiro-cli intact via stdin.
 *   - System prompt and user message are combined and sent together.
 *   - Not-signed-in stderr → clear error mentioning "Sign in".
 *   - Token-expired stderr → clear error mentioning "expired".
 *   - Provider precedence: kiro mode + personal Anthropic api_key credential → Anthropic wins.
 *   - Error message for remaining no-provider case mentions Kiro CLI.
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer, cleanup } from './fixtures.ts';
import { callTextModel, setBedrockClientFactory } from '../server/testing/model-provider.ts';
import { setSetting } from '../server/settings.ts';
import { getDb, insert, run as dbRun } from '../server/db.ts';
import { encrypt } from '../server/secrets.ts';
import { config } from '../server/config.ts';
import { generateId, now } from '../server/util.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_KIRO = path.join(__dirname, 'fake-kiro.mjs');

// ── Helpers ────────────────────────────────────────────────────────────────────

function setKiroMode(model = 'claude-sonnet-5.5'): void {
  const db = getDb();
  setSetting(db, 'provider.mode', 'kiro');
  if (model) setSetting(db, 'default.model', model);
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('Kiro CLI provider — callTextModel', () => {
  before(async () => {
    await createTestServer();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    setBedrockClientFactory(null);
    await cleanup();
  });

  afterEach(() => {
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    try { setSetting(getDb(), 'provider.mode', 'demo'); } catch { /* DB may be closed */ }
    try { setSetting(getDb(), 'default.model', ''); } catch { /* ok */ }
    setBedrockClientFactory(null);
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it('routes to kiro-cli when provider mode is kiro', async () => {
    setKiroMode('claude-sonnet-5.5');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-ok';

    const result = await callTextModel('You are a test assistant.', 'Generate a goto step.');

    assert.ok(result.length > 0, 'Should return non-empty response');
    assert.ok(result.includes('[{"kind":"goto"'), `Expected JSON response, got: ${result.slice(0, 100)}`);
  });

  it('passes --model to kiro-cli from defaultModel setting', async () => {
    setKiroMode('claude-haiku-4.5');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-ok';

    const result = await callTextModel('system', 'user');

    assert.ok(result.includes('model=claude-haiku-4.5'), `Expected model=claude-haiku-4.5 in: ${result}`);
  });

  it('does not pass --model when defaultModel is "auto"', async () => {
    setKiroMode('auto');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-ok';

    const result = await callTextModel('system', 'user');

    assert.ok(result.includes('model=none'), `Expected model=none when defaultModel=auto, got: ${result}`);
  });

  it('does not pass --model when defaultModel is empty', async () => {
    setSetting(getDb(), 'provider.mode', 'kiro');
    setSetting(getDb(), 'default.model', '');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-ok';

    const result = await callTextModel('system', 'user');

    assert.ok(result.includes('model=none'), `Expected model=none when defaultModel is empty, got: ${result}`);
  });

  it('does NOT pass --trust-all-tools (fake exits non-zero if it does)', async () => {
    setKiroMode('claude-sonnet-5.5');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-ok';

    // fake-kiro.mjs kiro-model-ok scenario exits with code 1 if --trust-all-tools is present
    await assert.doesNotReject(
      () => callTextModel('system', 'user'),
      'kiro-cli call should succeed (--trust-all-tools not passed)',
    );
  });

  // ── Large prompt via stdin ──────────────────────────────────────────────────

  it('delivers large prompt (>100 KB) to kiro-cli intact via stdin', async () => {
    setKiroMode('claude-sonnet-5.5');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-ok';

    // 110 KB user message — well above the Windows 32 K CLI arg limit
    const largeUserMessage = 'x'.repeat(110_000);
    const result = await callTextModel('Be concise.', largeUserMessage);

    const match = result.match(/prompt_length=(\d+)/);
    assert.ok(match, `Response should contain prompt_length, got: ${result.slice(0, 200)}`);
    const promptLen = Number(match[1]);
    // Combined prompt = systemPrompt + "\n\n" + userMessage. The user part alone is 110_000 chars.
    assert.ok(
      promptLen > 100_000,
      `Prompt should arrive with >100K chars, got prompt_length=${promptLen}`,
    );
  });

  it('combines system prompt and user message in stdin', async () => {
    setKiroMode('claude-sonnet-5.5');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-ok';

    const systemPrompt = 'System: you are helpful';
    const userMessage = 'User: say hi';
    const result = await callTextModel(systemPrompt, userMessage);

    // prompt_length should reflect both parts combined (at least sys + "\n\n" + user)
    const match = result.match(/prompt_length=(\d+)/);
    assert.ok(match, 'Should have prompt_length');
    const len = Number(match[1]);
    const minExpected = systemPrompt.length + userMessage.length;
    assert.ok(len >= minExpected, `prompt_length=${len} should be >= ${minExpected}`);
  });

  // ── Image note ──────────────────────────────────────────────────────────────

  it('appends image note to prompt when images are provided', async () => {
    setKiroMode('claude-sonnet-5.5');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-ok';

    // The note adds text to the prompt — prompt_length should be longer than without images
    const baseResult = await callTextModel('system', 'user');
    const baseLen = Number((baseResult.match(/prompt_length=(\d+)/) ?? ['', '0'])[1]);

    const imageResult = await callTextModel('system', 'user', {
      images: [{ data: Buffer.alloc(100), mimeType: 'image/png', filename: 'shot.png' }],
    });
    const imageLen = Number((imageResult.match(/prompt_length=(\d+)/) ?? ['', '0'])[1]);

    assert.ok(imageLen > baseLen, `Prompt with image note (${imageLen}) should be longer than without (${baseLen})`);
  });

  // ── Error mapping ───────────────────────────────────────────────────────────

  it('maps "Not signed in" stderr to a clear sign-in error', async () => {
    setKiroMode('claude-sonnet-5.5');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-not-signed-in';

    await assert.rejects(
      () => callTextModel('system', 'user'),
      (err: Error) => {
        assert.ok(
          err.message.includes('not signed in') || err.message.toLowerCase().includes('sign in'),
          `Expected sign-in error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('maps token-expired stderr to a clear expiry error', async () => {
    setKiroMode('claude-sonnet-5.5');
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-token-expired';

    await assert.rejects(
      () => callTextModel('system', 'user'),
      (err: Error) => {
        assert.ok(
          err.message.toLowerCase().includes('expired'),
          `Expected expiry error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  // ── Provider precedence ─────────────────────────────────────────────────────

  it('kiro mode + personal Anthropic api_key credential → Anthropic wins, kiro-cli NOT called', async () => {
    setSetting(getDb(), 'provider.mode', 'kiro');
    setSetting(getDb(), 'default.model', 'claude-sonnet-5.5');
    // kiro-model-ok scenario: if kiro-cli were called it would succeed,
    // but we want to verify Anthropic is used instead
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'kiro-model-ok';

    // Create user with a personal Anthropic api_key credential
    const userId = generateId();
    const ts = now();
    insert('users', {
      id: userId,
      email: `kiro-prio-${Date.now()}@test.com`,
      name: 'Kiro Priority Test',
      password_hash: 'x',
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
      secret_enc: encrypt('sk-ant-fake-key-for-test', config.secretKey),
      extra_config: '{}',
      is_default: 1,
      last4: '-key',
      created_at: ts,
      updated_at: ts,
      updated_by: userId,
    });

    let anthropicHit = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('anthropic.com')) {
        anthropicHit = true;
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'anthropic answer' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return origFetch(url, init);
    };

    try {
      const result = await callTextModel('system', 'user', { createdBy: userId });
      assert.equal(result, 'anthropic answer', 'Should return Anthropic response');
      assert.equal(anthropicHit, true, 'Anthropic must be called');
    } finally {
      globalThis.fetch = origFetch;
      dbRun('DELETE FROM engine_credentials WHERE id = ?', credId);
      dbRun('DELETE FROM users WHERE id = ?', userId);
    }
  });

  // ── No-provider error message includes Kiro CLI ─────────────────────────────

  it('no-provider error message mentions Kiro CLI', async () => {
    // Leave provider in demo mode (default in afterEach)
    await assert.rejects(
      () => callTextModel('system', 'user'),
      (err: Error) => {
        assert.ok(
          err.message.toLowerCase().includes('kiro'),
          `Error message should mention Kiro, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('last-resort error message mentions Kiro CLI', async () => {
    // Anthropic mode with no key set → falls to "no provider" error
    setSetting(getDb(), 'provider.mode', 'anthropic');
    // no anthropic.key.enc set
    setSetting(getDb(), 'model.sonnet', 'claude-sonnet-5.5');

    await assert.rejects(
      () => callTextModel('system', 'user'),
      (err: Error) => {
        assert.ok(
          err.message.toLowerCase().includes('kiro'),
          `Error message should mention Kiro, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
