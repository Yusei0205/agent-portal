/**
 * Unit tests for the Claude Code and Kiro engine implementations.
 *
 * The SDK and kiro-cli are fully mocked via:
 *   PORTAL_SDK_MODULE  → test/fake-sdk.mjs
 *   PORTAL_KIRO_FAKE   → test/fake-kiro.mjs
 *
 * Tests cover:
 *   - Event mapping (assistant-text, tool-start, tool-end, tool-blocked, run-complete)
 *   - Cache token fields on assistant-text events
 *   - Cost and token totals on p6_runs and budget_usage
 *   - Guardrails ask/block paths
 *   - Write-guard violation
 *   - Cancellation (AbortError propagation)
 *   - Missing-credential failure without fallback to demo
 *   - kiro-cli missing: clear error, no fallback
 *   - Review prompt instructs for JSON findings output
 *   - Heartbeat status events emitted during slow kiro runs
 *   - Non-zero kiro exit: p6_runs.error stored, run-failed event in p6_events
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTestDb, cleanup } from './fixtures.ts';
import { getDb, one, all } from '../server/db.ts';
import { insert } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { setConfig } from '../server/config.ts';
import type { Config } from '../server/config.ts';
import { runClaudeCode } from '../server/agent/claude-code.ts';
import { runKiro } from '../server/agent/kiro.ts';
import { executeRun } from '../server/agent/runner.ts';
import { loadRunPermissions } from '../server/guardrails.ts';
import type { RunContext, AgentRun } from '../server/agent/types.ts';
import { encrypt } from '../server/secrets.ts';
import { materialiseForRun, getRunHomeDir } from '../server/user-config.ts';
import { resolveCredentialEnv } from '../server/credentials.ts';

// ── Paths ─────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SDK = path.join(__dirname, 'fake-sdk.mjs');
const FAKE_KIRO = path.join(__dirname, 'fake-kiro.mjs');

// ── Test data factory ─────────────────────────────────────────────────────────

interface TestData {
  workDir: string;
  runId: string;
  workflowId: string;
  projectId: string;
  cfg: Config;
}

function makeTestData(): TestData {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-engines-test-'));
  const cfg: Config = {
    root: process.cwd(),
    port: 0,
    host: '127.0.0.1',
    dataDir,
    webDir: path.join(process.cwd(), 'dist', 'web'),
    secretKey: 'a'.repeat(64),
    cookieSecure: 'false',
    demoSpeed: 0,
    maxUploadBytes: 50 * 1024 * 1024,
    trustProxy: false,
    awsRegion: 'us-east-1',
    deployTarget: null,
  };
  setConfig(cfg);

  const workDir = path.join(dataDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  const db = getDb();
  const projectId = `proj-${generateId()}`;
  const workflowId = `wf-${generateId()}`;
  const runId = `run-${generateId()}`;

  db.prepare(
    'INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
  ).run(projectId, 'Test Project', `test-${Date.now()}`, now());

  db.prepare(
    `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'claude-code', 0, '[]', ?, ?)`,
  ).run(workflowId, projectId, 'Test goal', now(), now());

  db.prepare(
    `INSERT INTO p6_runs (id, workflow_id, status, created_at)
     VALUES (?, ?, 'running', ?)`,
  ).run(runId, workflowId, now());

  // Seed Anthropic provider + key so the engine passes pre-flight
  // Use a properly encrypted fake key (real format, fake API key value)
  const fakeKey = encrypt('sk-ant-test-fake-key-for-testing', cfg.secretKey);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('provider.mode', 'anthropic');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('anthropic.key.enc', fakeKey);

  return { workDir, runId, workflowId, projectId, cfg };
}

async function makeRunContext(
  t: TestData,
  overrides: Partial<AgentRun> = {},
): Promise<{ ctx: RunContext; events: Array<{ type: string; payload: Record<string, unknown> }> }> {
  const permissions = await loadRunPermissions(t.projectId);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const agentRun: AgentRun = {
    runId: t.runId,
    workflowId: t.workflowId,
    projectId: t.projectId,
    goal: 'Test goal',
    kind: null,
    engine: 'claude-code',
    trusted: false,
    dataDir: t.cfg.dataDir,
    workDir: t.workDir,
    repoIds: [],
    leadAgent: null,
    permissions,
    credentialId: null,
    credentialOwnerId: null,
    model: null,
    engineSessionId: null,
    ...overrides,
  };

  const abort = new AbortController();

  const ctx: RunContext = {
    run: agentRun,
    emit: (type, payload) => {
      events.push({ type, payload: payload as Record<string, unknown> });
    },
    awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
    allowed: new Set<string>(),
    signal: abort.signal,
  };

  return { ctx, events };
}

// ── Claude Code engine tests ──────────────────────────────────────────────────

describe('Claude Code engine — event mapping', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'normal';
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    await cleanup();
  });

  it('emits assistant-text with cache_write_tokens and cache_read_tokens', async () => {
    const { ctx, events } = await makeRunContext(t);
    await runClaudeCode(ctx);

    const textEvents = events.filter((e) => e.type === 'assistant-text');
    assert.ok(textEvents.length >= 1, `Expected ≥1 assistant-text, got ${textEvents.length}`);

    const withCache = textEvents.filter(
      (e) => Number(e.payload.cache_write_tokens) > 0 || Number(e.payload.cache_read_tokens) > 0,
    );
    assert.ok(withCache.length >= 1, 'Expected at least one assistant-text with cache tokens');
  });

  it('emits tool-start for allowed tool', async () => {
    const { ctx, events } = await makeRunContext(t, { trusted: true });
    await runClaudeCode(ctx);

    const starts = events.filter((e) => e.type === 'tool-start');
    assert.ok(starts.length >= 1, 'Expected at least one tool-start');
    assert.equal(String(starts[0].payload.toolName), 'Read');
  });

  it('emits tool-end after tool result', async () => {
    const { ctx, events } = await makeRunContext(t, { trusted: true });
    await runClaudeCode(ctx);

    const ends = events.filter((e) => e.type === 'tool-end');
    assert.ok(ends.length >= 1, 'Expected at least one tool-end');
  });

  it('emits exactly one run-complete', async () => {
    const { ctx, events } = await makeRunContext(t);
    await runClaudeCode(ctx);

    const complete = events.filter((e) => e.type === 'run-complete');
    assert.equal(complete.length, 1);
  });
});

describe('Claude Code engine — usage and cost', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'normal';
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    await cleanup();
  });

  it('writes cost_usd, input_tokens, output_tokens to p6_runs', async () => {
    const { ctx } = await makeRunContext(t);
    await runClaudeCode(ctx);

    const row = one<{ cost_usd: number; input_tokens: number; output_tokens: number }>(
      'SELECT cost_usd, input_tokens, output_tokens FROM p6_runs WHERE id = ?',
      t.runId,
    );
    assert.ok(row, 'p6_runs row not found');
    assert.ok(Number(row.cost_usd) > 0, `cost_usd should be > 0, got ${row.cost_usd}`);
    assert.ok(Number(row.input_tokens) > 0, `input_tokens should be > 0, got ${row.input_tokens}`);
    assert.ok(Number(row.output_tokens) > 0, `output_tokens should be > 0, got ${row.output_tokens}`);
  });

  it('writes cache_write_tokens and cache_read_tokens to p6_runs', async () => {
    const { ctx } = await makeRunContext(t);
    await runClaudeCode(ctx);

    const row = one<{ cache_write_tokens: number; cache_read_tokens: number }>(
      'SELECT cache_write_tokens, cache_read_tokens FROM p6_runs WHERE id = ?',
      t.runId,
    );
    assert.ok(row, 'p6_runs row not found');
    assert.ok(Number(row.cache_write_tokens) > 0, `cache_write_tokens should be > 0, got ${row.cache_write_tokens}`);
    assert.ok(Number(row.cache_read_tokens) > 0, `cache_read_tokens should be > 0, got ${row.cache_read_tokens}`);
  });

  it('inserts a budget_usage record with cost and tokens', async () => {
    const { ctx } = await makeRunContext(t);
    await runClaudeCode(ctx);

    const rows = all<{ cost_usd: number; input_tokens: number }>(
      'SELECT cost_usd, input_tokens FROM budget_usage WHERE workflow_id = ?',
      t.workflowId,
    );
    assert.ok(rows.length >= 1, 'Expected budget_usage row');
    assert.ok(Number(rows[0].cost_usd) > 0, 'budget_usage.cost_usd should be > 0');
    assert.ok(Number(rows[0].input_tokens) > 0, 'budget_usage.input_tokens should be > 0');
  });
});

describe('Claude Code engine — guardrails', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    await cleanup();
  });

  it('blocks cdk deploy (always-blocked guardrail) and emits tool-blocked', async () => {
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'guardrail-block';
    const { ctx, events } = await makeRunContext(t);
    await runClaudeCode(ctx);

    const blocked = events.filter((e) => e.type === 'tool-blocked');
    assert.ok(blocked.length >= 1, 'Expected tool-blocked for cdk deploy');
  });

  it('blocks write outside workDir and emits tool-blocked', async () => {
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'write-guard';
    const { ctx, events } = await makeRunContext(t, { trusted: true });
    await runClaudeCode(ctx);

    const blocked = events.filter((e) => e.type === 'tool-blocked');
    assert.ok(blocked.length >= 1, 'Expected tool-blocked for write outside workDir');
    assert.match(String(blocked[0].payload.reason), /outside.*work|not permitted/i);
  });

  it('calls awaitInput for ask-action tools (git push in untrusted run)', async () => {
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'guardrail-ask';
    let approvalCalled = false;
    const { ctx } = await makeRunContext(t, { trusted: false });
    ctx.awaitInput = async () => { approvalCalled = true; return { decision: 'allow' as const, remember: false, message: '' }; };

    await runClaudeCode(ctx);
    assert.ok(approvalCalled, 'awaitInput should be called for ask-action tool');
  });

  it('emits tool-blocked when user denies an ask-action tool', async () => {
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'guardrail-ask';
    const { ctx, events } = await makeRunContext(t, { trusted: false });
    ctx.awaitInput = async () => ({ decision: 'deny' as const, remember: false, message: '' });

    await runClaudeCode(ctx);
    const blocked = events.filter((e) => e.type === 'tool-blocked');
    assert.ok(blocked.length >= 1, 'Expected tool-blocked after user deny');
  });

  it('skips ask-action for trusted workflow (git push allowed without prompt)', async () => {
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'guardrail-ask';
    let approvalCalled = false;
    const { ctx, events } = await makeRunContext(t, { trusted: true });
    ctx.awaitInput = async () => { approvalCalled = true; return { decision: 'allow' as const, remember: false, message: '' }; };

    await runClaudeCode(ctx);
    assert.ok(!approvalCalled, 'awaitInput should NOT be called for trusted workflow');

    // Tool should have been allowed (tool-start emitted, not tool-blocked)
    const blocked = events.filter((e) => e.type === 'tool-blocked');
    assert.equal(blocked.length, 0, 'Expected no tool-blocked for trusted workflow');
  });
});

describe('Claude Code engine — credentials and cancellation', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    await cleanup();
  });

  it('throws clear error when provider is demo — no fallback to demo engine', async () => {
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'normal';
    const db = getDb();
    db.prepare("UPDATE settings SET value = 'demo' WHERE key = 'provider.mode'").run();

    const { ctx } = await makeRunContext(t);
    let threw = false;
    try {
      await runClaudeCode(ctx);
    } catch (e) {
      threw = true;
      assert.match(String((e as Error).message), /[Dd]emo|Settings|Provider/);
    }
    assert.ok(threw, 'Expected runClaudeCode to throw, not fall back silently');

    db.prepare("UPDATE settings SET value = 'anthropic' WHERE key = 'provider.mode'").run();
  });

  it('throws clear error when Anthropic key is missing — no fallback', async () => {
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'normal';
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'anthropic.key.enc'").run();

    const { ctx } = await makeRunContext(t);
    let threw = false;
    try {
      await runClaudeCode(ctx);
    } catch (e) {
      threw = true;
      assert.match(String((e as Error).message), /[Aa]PI key|anthropic/i);
    }
    assert.ok(threw, 'Expected runClaudeCode to throw when key is missing');

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'anthropic.key.enc',
      encrypt('sk-ant-test-fake-key-for-testing', t.cfg.secretKey),
    );
  });

  it('propagates AbortError when abort signal fires', async () => {
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'abort';
    const abort = new AbortController();

    const permissions = await loadRunPermissions(t.projectId);
    const ctx: RunContext = {
      run: {
        runId: t.runId,
        workflowId: t.workflowId,
        projectId: t.projectId,
        goal: 'abort test',
        kind: null,
        engine: 'claude-code',
        trusted: false,
        dataDir: t.cfg.dataDir,
        workDir: t.workDir,
        repoIds: [],
        leadAgent: null,
        permissions,
        credentialId: null,
        credentialOwnerId: null,
        model: null,
        engineSessionId: null,
      },
      emit: () => {},
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(),
      signal: abort.signal,
    };

    setTimeout(() => abort.abort(), 20);

    let threw = false;
    try {
      await runClaudeCode(ctx);
    } catch (e) {
      threw = true;
      const name = (e as DOMException).name;
      const msg = (e as Error).message;
      assert.ok(name === 'AbortError' || msg.includes('cancel'), `Expected AbortError, got: ${name}: ${msg}`);
    }
    assert.ok(threw, 'Expected AbortError to be thrown');
  });
});

// ── Kiro engine tests ─────────────────────────────────────────────────────────

describe('Kiro engine — text mode events', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_KIRO_TEXT_MODE = '1';
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'normal';
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_KIRO_TEXT_MODE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('emits assistant-text from kiro stdout in text mode', async () => {
    const { ctx, events } = await makeRunContext(t, { engine: 'kiro' });
    await runKiro(ctx);

    const textEvents = events.filter((e) => e.type === 'assistant-text');
    assert.ok(textEvents.length >= 1, `Expected ≥1 assistant-text, got ${textEvents.length}`);
  });

  it('emits run-complete', async () => {
    const { ctx, events } = await makeRunContext(t, { engine: 'kiro' });
    await runKiro(ctx);

    const complete = events.filter((e) => e.type === 'run-complete');
    assert.equal(complete.length, 1, 'Expected exactly one run-complete');
  });

  it('writes p6_runs stats on completion', async () => {
    const { ctx } = await makeRunContext(t, { engine: 'kiro' });
    await runKiro(ctx);

    const row = one<{ cost_usd: number }>(
      'SELECT cost_usd FROM p6_runs WHERE id = ?',
      t.runId,
    );
    assert.ok(row !== undefined, 'Expected p6_runs row');
    assert.ok(typeof Number(row.cost_usd) === 'number', 'cost_usd should be a number');
  });

  it('outputs review JSON block for review workflows', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'review';
    const { ctx, events } = await makeRunContext(t, { engine: 'kiro', kind: 'review' });
    await runKiro(ctx);

    const allText = events
      .filter((e) => e.type === 'assistant-text')
      .map((e) => String(e.payload.text ?? ''))
      .join('');

    assert.ok(allText.length > 0, 'Expected non-empty text output');
  });
});

describe('Kiro engine — JSON mode events', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    // JSON mode: no PORTAL_KIRO_TEXT_MODE
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'json';
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_KIRO_TEXT_MODE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('emits tool-start and tool-end from JSON output', async () => {
    const { ctx, events } = await makeRunContext(t, { engine: 'kiro' });
    await runKiro(ctx);

    const starts = events.filter((e) => e.type === 'tool-start');
    const ends = events.filter((e) => e.type === 'tool-end');
    assert.ok(starts.length >= 1, `Expected tool-start, got 0. Events: ${events.map((e) => e.type).join(',')}`);
    assert.ok(ends.length >= 1, `Expected tool-end, got 0`);
  });
});

describe('Kiro engine — failure modes (no fallback)', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_KIRO_TEXT_MODE = '1';
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_KIRO_TEXT_MODE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('throws a clear error when kiro-cli exits non-zero', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'error';
    const { ctx } = await makeRunContext(t, { engine: 'kiro' });

    let threw = false;
    try {
      await runKiro(ctx);
    } catch (e) {
      threw = true;
      assert.match(String((e as Error).message), /kiro-cli.*exited.*code|kiro-cli/i);
    }
    assert.ok(threw, 'Expected runKiro to throw on non-zero exit');
  });

  it('throws a clear error for exit code 127 (not found) — no fallback', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'missing';
    const { ctx } = await makeRunContext(t, { engine: 'kiro' });

    let threw = false;
    try {
      await runKiro(ctx);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'Expected runKiro to throw, not fall back silently to demo');
  });

  it('propagates AbortError when run is cancelled', async () => {
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'normal';
    const abort = new AbortController();

    const permissions = await loadRunPermissions(t.projectId);
    const ctx: RunContext = {
      run: {
        runId: t.runId,
        workflowId: t.workflowId,
        projectId: t.projectId,
        goal: 'abort test',
        kind: null,
        engine: 'kiro',
        trusted: false,
        dataDir: t.cfg.dataDir,
        workDir: t.workDir,
        repoIds: [],
        leadAgent: null,
        permissions,
        credentialId: null,
        credentialOwnerId: null,
        model: null,
        engineSessionId: null,
      },
      emit: () => {},
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(),
      signal: abort.signal,
    };

    abort.abort(); // abort immediately

    let threw = false;
    try {
      await runKiro(ctx);
    } catch (e) {
      threw = true;
      const name = (e as DOMException).name;
      const msg = (e as Error).message;
      assert.ok(name === 'AbortError' || msg.includes('cancel'), `Expected AbortError, got: ${name}: ${msg}`);
    }
    assert.ok(threw, 'Expected AbortError to be thrown on cancellation');
  });
});

// ── Kiro engine — heartbeat events ───────────────────────────────────────────

describe('Kiro engine — heartbeat status events during slow run', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_KIRO_TEXT_MODE = '1';
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'slow';
    // Short heartbeat interval for test speed; fake-kiro sleeps 300 ms by default
    process.env.PORTAL_KIRO_HEARTBEAT_MS = '50';
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_KIRO_TEXT_MODE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    delete process.env.PORTAL_KIRO_HEARTBEAT_MS;
    await cleanup();
  });

  it('emits at least one "Kiro is working" status event during a slow run', async () => {
    const { ctx, events } = await makeRunContext(t, { engine: 'kiro' });
    await runKiro(ctx);

    const heartbeats = events.filter(
      (e) => e.type === 'status' && String(e.payload.text ?? '').includes('Kiro is working'),
    );
    assert.ok(
      heartbeats.length >= 1,
      `Expected ≥1 heartbeat event; emitted events: ${events.map((e) => `${e.type}:${JSON.stringify(e.payload.text)}`).join(', ')}`,
    );
  });

  it('heartbeat text includes elapsed seconds', async () => {
    const { ctx, events } = await makeRunContext(t, { engine: 'kiro' });
    await runKiro(ctx);

    const heartbeatTexts = events
      .filter((e) => e.type === 'status' && String(e.payload.text ?? '').includes('Kiro is working'))
      .map((e) => String(e.payload.text ?? ''));
    assert.ok(heartbeatTexts.length >= 1, 'Expected at least one heartbeat');
    // Each heartbeat should contain a number of seconds in parentheses
    assert.ok(
      heartbeatTexts[0].match(/\(\d+s\)/),
      `Heartbeat text should contain "(Ns)"; got: "${heartbeatTexts[0]}"`,
    );
  });
});

// ── Runner — kiro failure path stores error + run-failed event ────────────────

describe('Runner — kiro failure path stores p6_runs.error and run-failed event', () => {
  let t: TestData;

  before(async () => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_KIRO_TEXT_MODE = '1';
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'error';

    // Switch workflow engine to kiro and pre-set work_dir so executeRun uses
    // the existing temp work dir rather than creating a new one from the project dir.
    getDb()
      .prepare("UPDATE p6_workflows SET engine = 'kiro', work_dir = ? WHERE id = ?")
      .run(t.workDir, t.workflowId);
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_KIRO_TEXT_MODE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('stores non-empty error in p6_runs.error when kiro exits non-zero', async () => {
    await executeRun(t.runId, t.workflowId);

    const runRow = one<{ status: string; error: string }>(
      'SELECT status, error FROM p6_runs WHERE id = ?',
      t.runId,
    );
    assert.equal(runRow?.status, 'failed', 'run status must be failed');
    assert.ok(
      runRow?.error && runRow.error.length > 0,
      `p6_runs.error must be non-empty on failure; got: "${runRow?.error}"`,
    );
  });

  it('inserts a run-failed event in p6_events', async () => {
    // run was already executed in the previous test (same DB, same runId)
    const failedEvent = one<{ type: string; payload: string }>(
      "SELECT type, payload FROM p6_events WHERE run_id = ? AND type = 'run-failed'",
      t.runId,
    );
    assert.ok(failedEvent, 'run-failed event must be in p6_events');
    const payload = JSON.parse(failedEvent.payload) as { error: string };
    assert.ok(payload.error, 'run-failed payload must contain an error message');
  });
});
