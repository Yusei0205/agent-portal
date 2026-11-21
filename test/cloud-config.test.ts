/**
 * Cloud configuration tests.
 *
 * Tests:
 *   - config.trustProxy is true when DEPLOY_TARGET=cloud
 *   - config.cookieSecure is 'true' when DEPLOY_TARGET=cloud
 *   - resolveSecretKey returns env var value when PORTAL_SECRET_KEY is set
 *   - resolveSecretKey falls back to generated file when no env var
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { loadConfig } from '../server/config.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
}

// Save and restore env vars around each test
let savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]): void {
  for (const k of keys) {
    savedEnv[k] = process.env[k];
  }
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  savedEnv = {};
}

// ── trustProxy ────────────────────────────────────────────────────────────────

describe('config.trustProxy', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    saveEnv('DEPLOY_TARGET', 'TRUST_PROXY', 'DATA_DIR', 'PORTAL_SECRET_KEY');
    process.env.DATA_DIR = tmpDir;
    process.env.PORTAL_SECRET_KEY = 'test-key-for-config-tests-32bytes!';
  });

  afterEach(() => {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('is false when DEPLOY_TARGET is not set', async () => {
    delete process.env.DEPLOY_TARGET;
    delete process.env.TRUST_PROXY;
    const cfg = await loadConfig();
    assert.equal(cfg.trustProxy, false);
  });

  it('is true when DEPLOY_TARGET=cloud', async () => {
    process.env.DEPLOY_TARGET = 'cloud';
    delete process.env.TRUST_PROXY;
    const cfg = await loadConfig();
    assert.equal(cfg.trustProxy, true);
  });

  it('is true when TRUST_PROXY=1 regardless of DEPLOY_TARGET', async () => {
    delete process.env.DEPLOY_TARGET;
    process.env.TRUST_PROXY = '1';
    const cfg = await loadConfig();
    assert.equal(cfg.trustProxy, true);
  });
});

// ── cookieSecure ──────────────────────────────────────────────────────────────

describe('config.cookieSecure', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    saveEnv('DEPLOY_TARGET', 'COOKIE_SECURE', 'DATA_DIR', 'PORTAL_SECRET_KEY');
    process.env.DATA_DIR = tmpDir;
    process.env.PORTAL_SECRET_KEY = 'test-key-for-config-tests-32bytes!';
  });

  afterEach(() => {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("defaults to 'auto' when DEPLOY_TARGET is not set", async () => {
    delete process.env.DEPLOY_TARGET;
    delete process.env.COOKIE_SECURE;
    const cfg = await loadConfig();
    assert.equal(cfg.cookieSecure, 'auto');
  });

  it("is 'true' when DEPLOY_TARGET=cloud", async () => {
    process.env.DEPLOY_TARGET = 'cloud';
    delete process.env.COOKIE_SECURE;
    const cfg = await loadConfig();
    assert.equal(cfg.cookieSecure, 'true');
  });

  it('COOKIE_SECURE env var overrides DEPLOY_TARGET=cloud', async () => {
    process.env.DEPLOY_TARGET = 'cloud';
    process.env.COOKIE_SECURE = 'false';
    const cfg = await loadConfig();
    assert.equal(cfg.cookieSecure, 'false');
  });
});

// ── deployTarget ─────────────────────────────────────────────────────────────

describe('config.deployTarget', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    saveEnv('DEPLOY_TARGET', 'DATA_DIR', 'PORTAL_SECRET_KEY');
    process.env.DATA_DIR = tmpDir;
    process.env.PORTAL_SECRET_KEY = 'test-key-for-config-tests-32bytes!';
  });

  afterEach(() => {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('is null when DEPLOY_TARGET is not set', async () => {
    delete process.env.DEPLOY_TARGET;
    const cfg = await loadConfig();
    assert.equal(cfg.deployTarget, null);
  });

  it('is cloud when DEPLOY_TARGET=cloud', async () => {
    process.env.DEPLOY_TARGET = 'cloud';
    const cfg = await loadConfig();
    assert.equal(cfg.deployTarget, 'cloud');
  });
});

// ── resolveSecretKey (via loadConfig) ─────────────────────────────────────────

describe('resolveSecretKey', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    saveEnv('PORTAL_SECRET_KEY', 'SECRET_KEY_ARN', 'PORTAL_SECRET_KEY_SSM_PATH', 'DATA_DIR', 'DEPLOY_TARGET');
    process.env.DATA_DIR = tmpDir;
    delete process.env.DEPLOY_TARGET;
  });

  afterEach(() => {
    restoreEnv();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns env var value when PORTAL_SECRET_KEY is set', async () => {
    const key = 'my-test-secret-key-from-env-var!';
    process.env.PORTAL_SECRET_KEY = key;
    delete process.env.SECRET_KEY_ARN;
    delete process.env.PORTAL_SECRET_KEY_SSM_PATH;
    const cfg = await loadConfig();
    assert.equal(cfg.secretKey, key);
  });

  it('falls back to auto-generated file when no env var is set', async () => {
    delete process.env.PORTAL_SECRET_KEY;
    delete process.env.SECRET_KEY_ARN;
    delete process.env.PORTAL_SECRET_KEY_SSM_PATH;

    const cfg = await loadConfig();

    // Should have generated a key
    assert.ok(cfg.secretKey, 'secretKey should not be empty');
    assert.equal(cfg.secretKey.length, 64, 'Generated key should be 32 bytes (64 hex chars)');

    // master.key file should exist
    const keyFile = path.join(tmpDir, 'master.key');
    assert.ok(fs.existsSync(keyFile), 'master.key file should be created');
    const fileContents = fs.readFileSync(keyFile, 'utf8').trim();
    assert.equal(fileContents, cfg.secretKey);
  });

  it('reads existing master.key file if no env var is set', async () => {
    delete process.env.PORTAL_SECRET_KEY;
    delete process.env.SECRET_KEY_ARN;
    delete process.env.PORTAL_SECRET_KEY_SSM_PATH;

    const existingKey = 'existing-master-key-from-file-hex';
    const keyFile = path.join(tmpDir, 'master.key');
    fs.writeFileSync(keyFile, existingKey, { mode: 0o600 });

    const cfg = await loadConfig();
    assert.equal(cfg.secretKey, existingKey);
  });

  it('maxUploadBytes defaults to 50 MB', async () => {
    process.env.PORTAL_SECRET_KEY = 'any-key';
    const cfg = await loadConfig();
    assert.equal(cfg.maxUploadBytes, 50 * 1024 * 1024);
  });
});
