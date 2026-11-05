/**
 * Tests for the Kiro ACP (Agent Client Protocol) engine path.
 *
 * Uses PORTAL_KIRO_FAKE=fake-kiro.mjs with ACP scenarios.
 * ACP mode is the default when PORTAL_KIRO_TEXT_MODE is NOT set and
 * PORTAL_KIRO_FAKE is set.
 *
 * Covers:
 *   - Streaming agent_message_chunk → assistant-text events
 *   - agent_thought_chunk → agent-thought events
 *   - tool_call / tool_call_update → tool-start / tool-end with toolCallId
 *   - plan → plan event with entries
 *   - usage_update → credits recorded in p6_runs.credits (not as dollars in cost_usd)
 *   - browser tool: rawInput URL → browser-navigate, image content → browser-screenshot
 *   - session/request_permission → awaitInput approve → allow_once response
 *   - session/request_permission → awaitInput deny → reject_once response
 *   - Trusted run: auto-allows permission requests without awaitInput
 *   - status {state:'thinking'} emitted at start, status {state:'idle'} at end
 *   - acp-error scenario → non-zero exit → throws clear error
 *   - Fallback to legacy (PORTAL_KIRO_TEXT_MODE=1)
 *   - Playwright MCP headless rewrite: adds --headless --output-dir --isolated
 *   - Browser route returns last screenshot from browser-screenshot events
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTestDb, cleanup } from './fixtures.ts';
import { getDb, one, all } from '../server/db.ts';
import { insert } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { setConfig } from '../server/config.ts';
import type { Config } from '../server/config.ts';
import { runKiro } from '../server/agent/kiro.ts';
import { loadRunPermissions } from '../server/guardrails.ts';
import type { RunContext, AgentRun } from '../server/agent/types.ts';
import { rewritePlaywrightMcpHeadless } from '../server/agent/browser-headless.ts';

// ── Paths ─────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-acp-test-'));
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

  db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
    .run(projectId, 'ACP Test', `acp-test-${Date.now()}`, now());
  db.prepare(
    `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', ?, ?)`,
  ).run(workflowId, projectId, 'ACP test goal', now(), now());
  db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`)
    .run(runId, workflowId, now());

  return { workDir, runId, workflowId, projectId, cfg };
}

async function makeCtx(
  t: TestData,
  overrides: Partial<AgentRun> = {},
): Promise<{
  ctx: RunContext;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  approvalCalls: string[];
}> {
  const permissions = await loadRunPermissions(t.projectId);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const approvalCalls: string[] = [];

  const agentRun: AgentRun = {
    runId: t.runId,
    workflowId: t.workflowId,
    projectId: t.projectId,
    goal: 'ACP test goal',
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
    ...overrides,
  };

  const ctrl = new AbortController();

  const ctx: RunContext = {
    run: agentRun,
    emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
    awaitInput: async (toolName, toolInput) => {
      approvalCalls.push(toolName);
      return { decision: 'allow' as const, remember: false, message: '' };
    },
    allowed: new Set<string>(),
    signal: ctrl.signal,
  };

  return { ctx, events, approvalCalls };
}

// ── Helper ────────────────────────────────────────────────────────────────────

/** Filter events by type */
function pick(events: Array<{ type: string; payload: Record<string, unknown> }>, type: string) {
  return events.filter((e) => e.type === type);
}

// ── ACP streaming ─────────────────────────────────────────────────────────────

describe('Kiro ACP — agent_message_chunk → assistant-text', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'normal';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('emits at least one assistant-text from ACP streaming', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const texts = pick(events, 'assistant-text');
    assert.ok(texts.length >= 1, `Expected ≥1 assistant-text, got ${texts.length}`);
  });

  it('marks ACP text chunks as streamed so the viewer joins them without newlines', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    for (const ev of pick(events, 'assistant-text')) {
      assert.equal(ev.payload.stream, true);
    }
  });

  it('emits status {state:thinking} before first update', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const thinking = events.find((e) => e.type === 'status' && e.payload.state === 'thinking');
    assert.ok(thinking, 'Expected status {state:thinking} event');
  });

  it('emits status {state:idle} at end', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const idle = events.find((e) => e.type === 'status' && e.payload.state === 'idle');
    assert.ok(idle, 'Expected status {state:idle} event at end');
  });

  it('emits run-complete', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    assert.equal(pick(events, 'run-complete').length, 1);
  });
});

// ── ACP thought chunks ────────────────────────────────────────────────────────

describe('Kiro ACP — agent_thought_chunk → agent-thought', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-thought';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('emits agent-thought event from agent_thought_chunk', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const thoughts = pick(events, 'agent-thought');
    assert.ok(thoughts.length >= 1, `Expected ≥1 agent-thought, got ${thoughts.length}`);
    assert.ok(String(thoughts[0].payload.text).length > 0, 'agent-thought text must be non-empty');
  });
});

// ── ACP tool calls ────────────────────────────────────────────────────────────

describe('Kiro ACP — tool_call/tool_call_update → tool-start/tool-end', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-tool';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('emits tool-start with toolCallId and toolName', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const starts = pick(events, 'tool-start');
    assert.ok(starts.length >= 1, 'Expected tool-start');
    assert.ok(String(starts[0].payload.toolCallId).length > 0, 'toolCallId must be non-empty');
    assert.ok(String(starts[0].payload.toolName).length > 0, 'toolName must be non-empty');
  });

  it('emits tool-end with toolCallId and status', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const ends = pick(events, 'tool-end');
    assert.ok(ends.length >= 1, 'Expected tool-end');
    assert.ok(String(ends[0].payload.toolCallId).length > 0, 'toolCallId must be non-empty');
    assert.ok(String(ends[0].payload.status).length > 0, 'status must be non-empty');
  });
});

// ── ACP browser tool ──────────────────────────────────────────────────────────

describe('Kiro ACP — browser tool events', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-browser';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('emits browser-navigate with URL from browser tool rawInput', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const navs = pick(events, 'browser-navigate');
    assert.ok(navs.length >= 1, 'Expected browser-navigate event');
    assert.equal(navs[0].payload.url, 'https://example.com');
  });

  it('emits browser-screenshot with base64 from image content', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const shots = pick(events, 'browser-screenshot');
    assert.ok(shots.length >= 1, 'Expected browser-screenshot event');
    assert.ok(String(shots[0].payload.screenshotBase64).length > 0, 'screenshotBase64 must be non-empty');
  });
});

// ── ACP plan ──────────────────────────────────────────────────────────────────

describe('Kiro ACP — plan → plan event', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-plan';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('emits plan event with entries array', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const plans = pick(events, 'plan');
    assert.ok(plans.length >= 1, 'Expected plan event');
    assert.ok(Array.isArray(plans[0].payload.entries), 'plan.entries must be an array');
    const entries = plans[0].payload.entries as Array<{ content: string }>;
    assert.ok(entries.length >= 1, 'Expected ≥1 plan entry');
  });
});

// ── ACP usage / credits ───────────────────────────────────────────────────────

describe('Kiro ACP — usage_update → credits recorded', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-usage';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('stores usage_update credits as credits, not as dollars', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const row = one<{ cost_usd: number; credits: number }>('SELECT cost_usd, credits FROM p6_runs WHERE id = ?', t.runId);
    assert.ok(row, 'p6_runs row must exist');
    assert.ok(Number(row.credits) > 0, `credits should be > 0, got ${row.credits}`);
    assert.equal(Number(row.cost_usd), 0, 'Kiro credits must not be stored as dollars');

    const bu = one<{ cost_usd: number; credits: number }>(
      "SELECT cost_usd, credits FROM budget_usage WHERE workflow_id = ? AND provider = 'kiro'", t.workflowId,
    );
    assert.ok(bu, 'budget_usage row must exist');
    assert.equal(Number(bu.cost_usd), 0, 'Kiro credits must not count towards the dollar budget');
    assert.equal(Number(bu.credits), Number(row.credits));

    const live = events.filter((e) => e.type === 'cost-update');
    assert.ok(live.length > 0, 'a live cost-update event is emitted');
    assert.equal((live.at(-1)!.payload as { unit?: string }).unit, 'credits');
    const done = events.find((e) => e.type === 'run-complete');
    assert.equal((done?.payload as { credits?: number }).credits, Number(row.credits));
  });
});

// ── ACP permission — approve ──────────────────────────────────────────────────

describe('Kiro ACP — session/request_permission → approve', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-permission';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('calls awaitInput when permission is requested (untrusted run)', async () => {
    const { ctx, events, approvalCalls } = await makeCtx(t, { trusted: false });
    await runKiro(ctx);
    assert.ok(approvalCalls.length >= 1, 'awaitInput should be called for permission request');
  });

  it('emits "Tool executed." text after approve', async () => {
    const { ctx, events } = await makeCtx(t, { trusted: false });
    await runKiro(ctx);
    const texts = pick(events, 'assistant-text').map((e) => String(e.payload.text)).join('');
    assert.ok(texts.includes('Tool executed.'), `Expected "Tool executed." in output; got: "${texts}"`);
  });

  it('auto-approves without calling awaitInput when run is trusted', async () => {
    const { ctx, events, approvalCalls } = await makeCtx(t, { trusted: true });
    await runKiro(ctx);
    assert.equal(approvalCalls.length, 0, 'awaitInput should NOT be called for trusted run');
    const texts = pick(events, 'assistant-text').map((e) => String(e.payload.text)).join('');
    assert.ok(texts.includes('Tool executed.'), `Expected "Tool executed." in output; got: "${texts}"`);
  });
});

// ── ACP permission — deny ─────────────────────────────────────────────────────

describe('Kiro ACP — session/request_permission → deny', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-permission-deny';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('sends reject_once when user denies the permission request', async () => {
    const { ctx, events } = await makeCtx(t, { trusted: false });
    ctx.awaitInput = async () => ({ decision: 'deny' as const, remember: false, message: '' }); // always deny

    await runKiro(ctx);
    const texts = pick(events, 'assistant-text').map((e) => String(e.payload.text)).join('');
    assert.ok(texts.includes('Tool denied.'), `Expected "Tool denied." in output; got: "${texts}"`);
  });
});

// ── ACP error ─────────────────────────────────────────────────────────────────

describe('Kiro ACP — acp-error scenario → throws clear error', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-error';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('throws when kiro-cli acp exits non-zero', async () => {
    const { ctx } = await makeCtx(t);
    let threw = false;
    try {
      await runKiro(ctx);
    } catch (e) {
      threw = true;
      assert.match(String((e as Error).message), /kiro-cli.*exited.*code|kiro-cli/i);
    }
    assert.ok(threw, 'Expected runKiro to throw on non-zero exit');
  });
});

// ── Fallback path ─────────────────────────────────────────────────────────────

describe('Kiro legacy fallback (PORTAL_KIRO_TEXT_MODE=1)', () => {
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

  it('emits assistant-text in legacy text mode', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const texts = pick(events, 'assistant-text');
    assert.ok(texts.length >= 1, `Expected ≥1 assistant-text in legacy mode`);
  });

  it('emits a "live updates unavailable" status message in legacy mode', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const msg = events.find(
      (e) => e.type === 'status' && String(e.payload.text ?? '').toLowerCase().includes('unavailable'),
    );
    assert.ok(msg, 'Expected "unavailable" status message in legacy mode');
  });
});

// ── ACP heartbeat fallback ────────────────────────────────────────────────────

describe('Kiro ACP — heartbeat fires only when no updates arrive', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData();
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-slow';
    process.env.PORTAL_KIRO_HEARTBEAT_MS = '50';
    process.env.PORTAL_FAKE_KIRO_SLOW_MS = '200';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    delete process.env.PORTAL_KIRO_HEARTBEAT_MS;
    delete process.env.PORTAL_FAKE_KIRO_SLOW_MS;
    await cleanup();
  });

  it('emits at least one heartbeat status when run takes longer than heartbeat interval', async () => {
    const { ctx, events } = await makeCtx(t);
    await runKiro(ctx);
    const heartbeats = events.filter(
      (e) => e.type === 'status' && String(e.payload.text ?? '').includes('Kiro is working'),
    );
    assert.ok(heartbeats.length >= 1, `Expected ≥1 heartbeat, got ${heartbeats.length}`);
  });
});

// ── Playwright MCP headless rewrite ───────────────────────────────────────────

describe('rewritePlaywrightMcpHeadless', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-browser-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('adds --headless, --output-dir and --isolated to @playwright/mcp entry', async () => {
    const mcpJson = path.join(tmpDir, 'mcp.json');
    const workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    await fsp.writeFile(mcpJson, JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest'],
        },
      },
    }), 'utf8');

    await rewritePlaywrightMcpHeadless(mcpJson, workDir);

    const patched = JSON.parse(await fsp.readFile(mcpJson, 'utf8')) as {
      mcpServers: { playwright: { args: string[] } };
    };
    const args = patched.mcpServers.playwright.args;

    assert.ok(args.includes('--headless'), 'Expected --headless in args');
    assert.ok(args.includes('--isolated'), 'Expected --isolated in args');
    const odIdx = args.indexOf('--output-dir');
    assert.ok(odIdx >= 0, 'Expected --output-dir in args');
    assert.ok(args[odIdx + 1].includes('.browser'), 'Expected .browser in output-dir value');
  });

  it('does not modify entries that are already headless', async () => {
    const mcpJson = path.join(tmpDir, 'mcp.json');
    const workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    const original = {
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest', '--headless'],
        },
      },
    };
    await fsp.writeFile(mcpJson, JSON.stringify(original), 'utf8');

    await rewritePlaywrightMcpHeadless(mcpJson, workDir);

    // File should not change (headless already present)
    const content = await fsp.readFile(mcpJson, 'utf8');
    // The content will be the same JSON (not re-serialized) since we return early
    const parsed = JSON.parse(content) as typeof original;
    assert.deepEqual(parsed.mcpServers.playwright.args, ['@playwright/mcp@latest', '--headless']);
  });

  it('does not modify non-playwright MCP entries', async () => {
    const mcpJson = path.join(tmpDir, 'mcp.json');
    const workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    const original = {
      mcpServers: {
        someOtherTool: {
          command: 'npx',
          args: ['@some/other-mcp@latest'],
        },
      },
    };
    await fsp.writeFile(mcpJson, JSON.stringify(original), 'utf8');

    await rewritePlaywrightMcpHeadless(mcpJson, workDir);

    const content = await fsp.readFile(mcpJson, 'utf8');
    assert.deepEqual(JSON.parse(content), original);
  });

  it('does nothing when mcp.json does not exist', async () => {
    const mcpJson = path.join(tmpDir, 'nonexistent-mcp.json');
    const workDir = path.join(tmpDir, 'work');
    // Should not throw
    await assert.doesNotReject(() => rewritePlaywrightMcpHeadless(mcpJson, workDir));
  });

  it('does nothing when mcp.json contains invalid JSON', async () => {
    const mcpJson = path.join(tmpDir, 'mcp.json');
    const workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    await fsp.writeFile(mcpJson, '{ invalid json }', 'utf8');
    // Should not throw
    await assert.doesNotReject(() => rewritePlaywrightMcpHeadless(mcpJson, workDir));
    // Original content preserved
    const after = await fsp.readFile(mcpJson, 'utf8');
    assert.equal(after, '{ invalid json }');
  });

  it('user source config is never touched — only the materialised copy', async () => {
    // The rewrite function only takes a path (the materialised copy), and the
    // caller is responsible for passing the right path. This test verifies it
    // only modifies the file passed in, not any other path.
    const mcpJson = path.join(tmpDir, 'mcp.json');
    const otherJson = path.join(tmpDir, 'other.json');
    const workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    await fsp.writeFile(mcpJson, JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } },
    }), 'utf8');
    await fsp.writeFile(otherJson, '{"untouched":true}', 'utf8');

    await rewritePlaywrightMcpHeadless(mcpJson, workDir);

    // Only mcpJson was modified; otherJson unchanged
    const other = await fsp.readFile(otherJson, 'utf8');
    assert.equal(other, '{"untouched":true}');
  });
});
