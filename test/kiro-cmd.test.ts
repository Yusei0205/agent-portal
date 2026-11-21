/**
 * Regression tests for server/kiro-cmd.ts — resolveKiroCmd()
 *
 * Guard: on every platform (including win32) the real command must be plain
 * 'kiro-cli', never 'kiro-cli.cmd'.  Spawning 'kiro-cli.cmd' with shell:false
 * throws EINVAL on Windows when only kiro-cli.exe is on PATH, which caused
 * model listing and sign-in checks to report "not installed".
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKiroCmd } from '../server/kiro-cmd.ts';

// ── Real command (PORTAL_KIRO_FAKE unset) ─────────────────────────────────────

describe('resolveKiroCmd — real binary', () => {
  let savedFake: string | undefined;

  before(() => {
    savedFake = process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_KIRO_FAKE;
  });

  after(() => {
    if (savedFake !== undefined) {
      process.env.PORTAL_KIRO_FAKE = savedFake;
    } else {
      delete process.env.PORTAL_KIRO_FAKE;
    }
  });

  it('cmd is exactly "kiro-cli" (regression: never "kiro-cli.cmd")', () => {
    const { cmd } = resolveKiroCmd(['whoami']);
    assert.equal(cmd, 'kiro-cli');
  });

  it('cmd does not end with .cmd regardless of platform', () => {
    const { cmd } = resolveKiroCmd(['whoami']);
    assert.ok(!cmd.endsWith('.cmd'), `expected cmd not to end with .cmd, got: ${cmd}`);
  });

  it('cmd does not end with .exe regardless of platform', () => {
    // Node's CreateProcess / PATH resolution handles the extension automatically
    const { cmd } = resolveKiroCmd(['whoami']);
    assert.ok(!cmd.endsWith('.exe'), `expected plain stem 'kiro-cli', got: ${cmd}`);
  });

  it('fullArgs equals the args passed in', () => {
    const { fullArgs } = resolveKiroCmd(['chat', '--list-models', '--output-format', 'text']);
    assert.deepEqual(fullArgs, ['chat', '--list-models', '--output-format', 'text']);
  });

  it('works for whoami args', () => {
    const { cmd, fullArgs } = resolveKiroCmd(['whoami']);
    assert.equal(cmd, 'kiro-cli');
    assert.deepEqual(fullArgs, ['whoami']);
  });

  it('works for login args', () => {
    const { cmd, fullArgs } = resolveKiroCmd(['login', '--use-device-flow', '--license', 'free']);
    assert.equal(cmd, 'kiro-cli');
    assert.deepEqual(fullArgs, ['login', '--use-device-flow', '--license', 'free']);
  });
});

// ── Fake binary (PORTAL_KIRO_FAKE set) ───────────────────────────────────────

describe('resolveKiroCmd — fake binary (test mode)', () => {
  const FAKE_PATH = '/path/to/fake-kiro.mjs';

  beforeEach(() => {
    process.env.PORTAL_KIRO_FAKE = FAKE_PATH;
  });

  afterEach(() => {
    delete process.env.PORTAL_KIRO_FAKE;
  });

  it('cmd is process.execPath when PORTAL_KIRO_FAKE is set', () => {
    const { cmd } = resolveKiroCmd(['whoami']);
    assert.equal(cmd, process.execPath);
  });

  it('fullArgs starts with fake path', () => {
    const { fullArgs } = resolveKiroCmd(['whoami']);
    assert.equal(fullArgs[0], FAKE_PATH);
    assert.equal(fullArgs[1], 'whoami');
  });

  it('fullArgs contains all original args after the fake path', () => {
    const { fullArgs } = resolveKiroCmd(['chat', '--list-models']);
    assert.deepEqual(fullArgs, [FAKE_PATH, 'chat', '--list-models']);
  });
});
