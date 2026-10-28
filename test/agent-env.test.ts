/**
 * Unit tests for agentEnv (Task 3):
 *   - HOME is set to the data-volume home directory
 *   - PATH contains /data/tools/bin and /data/home/.local/bin
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dataDir: string;

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-agentenv-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEMO_SPEED = '0';
  process.env.PORTAL_SECRET_KEY = 'test-secret-key-for-agent-env-tests';
  process.env.PORTAL_NO_AUTOSTART = '1';
  process.env.PORTAL_ANTHROPIC_BASE_URL = 'https://llm-gateway.example.com/anthropic';
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.DEMO_SPEED;
  delete process.env.PORTAL_SECRET_KEY;
  delete process.env.PORTAL_NO_AUTOSTART;
  delete process.env.PORTAL_ANTHROPIC_BASE_URL;
});

test('agentEnv: Claude runs keep the model key from their shell; every run gets the memory and tool-time rules', async () => {
  const { openDb, closeDb } = await import('../server/db.ts');
  const { ensureDataDirs } = await import('../server/config.ts');
  const { agentEnv, updateSettings, SECRET_NAMES } = await import('../server/settings.ts');
  const { setSecret } = await import('../server/secrets.ts');
  ensureDataDirs();
  openDb();
  try {
    const demo = await agentEnv(undefined, 'demo');
    assert.equal(demo.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined, 'no model key, nothing to keep back');
    assert.equal(demo.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(demo.MCP_TOOL_TIMEOUT, '600000', 'ten minutes by default');

    await setSecret(SECRET_NAMES.anthropicKey, 'sk-ant-agent-env-test-key');
    updateSettings({ agents: { mcpToolTimeoutMinutes: 3 } });
    const claude = await agentEnv(undefined, 'anthropic');
    assert.equal(claude.ANTHROPIC_API_KEY, 'sk-ant-agent-env-test-key');
    // On by default on Windows only: on Linux and macOS Claude Code ties it to its sandbox (see scrubAgentEnv).
    assert.equal(claude.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, process.platform === 'win32' ? '1' : undefined);
    process.env.PORTAL_AGENT_ENV_SCRUB = '1';
    assert.equal((await agentEnv(undefined, 'anthropic')).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1', 'an operator can turn it on');
    process.env.PORTAL_AGENT_ENV_SCRUB = '0';
    assert.equal((await agentEnv(undefined, 'anthropic')).CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined, 'or off');
    delete process.env.PORTAL_AGENT_ENV_SCRUB;
    assert.equal(claude.MCP_TOOL_TIMEOUT, '180000');
    assert.equal(claude.ANTHROPIC_BASE_URL, 'https://llm-gateway.example.com/anthropic', 'the operator gateway applies');

    for (const bad of [0, 241, 2.5, 'ten']) {
      assert.throws(() => updateSettings({ agents: { mcpToolTimeoutMinutes: bad } }), /whole number of minutes from 1 to 240/);
    }
  } finally {
    closeDb();
  }
});

test('agentEnv: HOME points to the data-volume home directory', async () => {
  const { openDb, closeDb } = await import('../server/db.ts');
  const { ensureDataDirs } = await import('../server/config.ts');
  const { agentEnv } = await import('../server/settings.ts');
  ensureDataDirs();
  openDb();
  try {
    const env = await agentEnv();
    assert.ok('HOME' in env, 'HOME must be present in agentEnv');
    // HOME must be inside the data directory, under the 'home' sub-folder.
    const expected = path.join(dataDir, 'home');
    assert.equal(env.HOME, expected, `HOME should be ${expected}, got ${env.HOME}`);
  } finally {
    closeDb();
  }
});

test('agentEnv: PATH contains both tool directories', async () => {
  const { openDb, closeDb } = await import('../server/db.ts');
  const { ensureDataDirs } = await import('../server/config.ts');
  const { agentEnv } = await import('../server/settings.ts');
  ensureDataDirs();
  openDb();
  try {
    const env = await agentEnv();
    assert.ok('PATH' in env, 'PATH must be present in agentEnv');
    const entries = env.PATH.split(path.delimiter);
    const toolsBin = path.join(dataDir, 'tools', 'bin');
    const localBin = path.join(dataDir, 'home', '.local', 'bin');
    assert.ok(entries.includes(toolsBin), `PATH should contain ${toolsBin}\nGot: ${env.PATH}`);
    assert.ok(entries.includes(localBin), `PATH should contain ${localBin}\nGot: ${env.PATH}`);
    // Both tool directories must appear BEFORE any other path entries.
    const toolIdx = entries.indexOf(toolsBin);
    const localIdx = entries.indexOf(localBin);
    // The first entry should be one of our tool dirs.
    assert.ok(toolIdx === 0 || localIdx === 0, 'one of the tool directories should be the first PATH entry');
  } finally {
    closeDb();
  }
});
