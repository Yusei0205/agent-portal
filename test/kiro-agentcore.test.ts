/**
 * Unit tests for the AgentCore execution path for Kiro.
 *
 * Uses a fake AgentCore invoker via _setAgentCoreInvokerOverride so no real
 * AWS calls are made.
 *
 * Covers:
 *   - Event mapping: text → assistant-text (stream:true)
 *   - Event mapping: thought → agent-thought
 *   - Event mapping: tool → tool-start + tool-end
 *   - Event mapping: status → status { text }
 *   - AgentCore error event → throws HttpError
 *   - Cancel via AbortSignal → throws AbortError
 *   - Timeout (PORTAL_RUN_TIMEOUT_MS) → throws 504
 *   - Token write-back: normal case (tokenRefreshed=true)
 *   - Token write-back: concurrent case (another run saved a newer token → skip)
 *   - Token write-back: no-op when tokenRefreshed=false
 *   - Login flow: verification event surfaced, result event stores credential
 *   - Login flow: pollAgentCoreLogin returns 'complete' with token
 *   - Login flow: failed run → pollAgentCoreLogin returns 'failed'
 *   - pollAgentCoreLogin: 'unknown' when no pending entry
 *   - saveRefreshedTokenConditional: only writes when ciphertext matches
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTestDb, cleanup } from './fixtures.ts';
import { getDb, one, insert } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { setConfig } from '../server/config.ts';
import type { Config } from '../server/config.ts';
import { encrypt, decrypt } from '../server/secrets.ts';
import { loadRunPermissions } from '../server/guardrails.ts';
import type { RunContext, AgentRun } from '../server/agent/types.ts';
import {
  _setAgentCoreInvokerOverride,
  _setRepoChangesHooks,
  runKiroViaAgentCore,
  saveRefreshedTokenConditional,
  startAgentCoreLogin,
  pollAgentCoreLogin,
  _agentCoreLoginState,
} from '../server/agent/kiro-agentcore.ts';
import type { AgentCoreSSEEvent, AgentCoreLoginResultEvent, KiroTokenPayload } from '../server/agent/kiro-agentcore.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECRET_KEY = 'a'.repeat(64);

function makeConfig(): Config {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-agentcore-test-'));
  return {
    root: process.cwd(),
    port: 0,
    host: '127.0.0.1',
    dataDir,
    webDir: path.join(process.cwd(), 'dist', 'web'),
    secretKey: SECRET_KEY,
    cookieSecure: 'false',
    demoSpeed: 0,
    maxUploadBytes: 50 * 1024 * 1024,
    trustProxy: false,
    awsRegion: 'ap-southeast-1',
    deployTarget: null,
  };
}

function makeTestData(cfg: Config) {
  const workDir = path.join(cfg.dataDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  const db = getDb();
  const projectId = `proj-${generateId()}`;
  const workflowId = `wf-${generateId()}`;
  const runId = `run-${generateId()}`;

  db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
    .run(projectId, 'AC Test', `ac-${projectId.slice(0, 8)}`, now());
  db.prepare(
    `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', ?, ?)`,
  ).run(workflowId, projectId, 'AgentCore test', now(), now());
  db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`)
    .run(runId, workflowId, now());

  return { workDir, runId, workflowId, projectId };
}

async function makeCtx(
  runId: string,
  workflowId: string,
  projectId: string,
  workDir: string,
  cfg: Config,
  overrides: Partial<AgentRun> = {},
): Promise<{
  ctx: RunContext;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}> {
  const permissions = await loadRunPermissions(projectId);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const agentRun: AgentRun = {
    runId,
    workflowId,
    projectId,
    goal: 'test goal',
    kind: null,
    engine: 'kiro',
    trusted: false,
    dataDir: cfg.dataDir,
    workDir,
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
    awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
    allowed: new Set<string>(),
    signal: ctrl.signal,
  };

  return { ctx, events };
}

function pick(events: Array<{ type: string; payload: Record<string, unknown> }>, type: string) {
  return events.filter((e) => e.type === type);
}

const FAKE_ARN = 'arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/test-runtime';

const SAMPLE_TOKEN: KiroTokenPayload = {
  accessToken: 'access-token-value',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  region: 'us-east-1',
  startUrl: 'https://d-123.awsapps.com/start',
  refreshToken: 'refresh-token-value',
  clientId: 'client-id-123',
  clientSecret: 'client-secret-456',
};

// ── Event mapping tests ───────────────────────────────────────────────────────

describe('AgentCore — text event → assistant-text', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('maps text events to assistant-text with stream:true', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'text', text: 'Hello, ' } as AgentCoreSSEEvent;
      yield { type: 'text', text: 'world!' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx, events } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);

    await runKiroViaAgentCore(ctx, {
      runtimeArn: FAKE_ARN,
      runId: td.runId,
      prompt: 'test prompt',
      token: SAMPLE_TOKEN,
      credentialId: null,
      expectedCiphertext: null,
    });

    const texts = pick(events, 'assistant-text');
    assert.ok(texts.length >= 2, `Expected ≥2 assistant-text events, got ${texts.length}`);
    assert.equal(texts[0].payload.stream, true, 'stream flag must be true');
    assert.equal(texts[0].payload.text, 'Hello, ');
    assert.equal(texts[1].payload.text, 'world!');
  });

  it('emits status {state:thinking} at start and {state:idle} at end', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'text', text: 'ok' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx, events } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);
    await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });

    const thinking = events.find((e) => e.type === 'status' && e.payload.state === 'thinking');
    const idle = events.find((e) => e.type === 'status' && e.payload.state === 'idle');
    assert.ok(thinking, 'Expected status{state:thinking}');
    assert.ok(idle, 'Expected status{state:idle}');
  });
});

describe('AgentCore — thought event → agent-thought', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('maps thought events to agent-thought', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'thought', text: 'thinking about it' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx, events } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);
    await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });

    const thoughts = pick(events, 'agent-thought');
    assert.ok(thoughts.length >= 1, 'Expected agent-thought event');
    assert.equal(thoughts[0].payload.text, 'thinking about it');
  });
});

describe('AgentCore — tool event → tool-start + tool-end', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('maps tool events to tool-start and tool-end', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'tool', name: 'read_file' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx, events } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);
    await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });

    const starts = pick(events, 'tool-start');
    const ends = pick(events, 'tool-end');
    assert.ok(starts.length >= 1, 'Expected tool-start');
    assert.ok(ends.length >= 1, 'Expected tool-end');
    assert.equal(starts[0].payload.toolName, 'read_file');
    assert.equal(ends[0].payload.toolName, 'read_file');
    assert.equal(starts[0].payload.status, 'in_progress');
    assert.equal(ends[0].payload.status, 'completed');
  });
});

describe('AgentCore — sub-agent events → the session\'s agents graph', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('passes Kiro\'s sub-agent events on as run events, keeping only the known fields', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'subagent-started', id: 's-1', name: 'explorer', description: 'Run the explorer' } as AgentCoreSSEEvent;
      yield { type: 'subagent-finished', id: 's-1', name: 'explorer', summary: 'Found 3 files.', status: 'completed', durationMs: 4000, secret: 'dropped' } as unknown as AgentCoreSSEEvent;
      yield { type: 'subagent-failed', id: 's-2', name: 'x'.repeat(200), summary: 'y'.repeat(5000) } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx, events } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);
    await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });

    const started = pick(events, 'subagent-started');
    const finished = pick(events, 'subagent-finished');
    const failed = pick(events, 'subagent-failed');
    assert.deepEqual(started[0].payload, { id: 's-1', name: 'explorer', description: 'Run the explorer' });
    assert.deepEqual(finished[0].payload, { id: 's-1', name: 'explorer', summary: 'Found 3 files.', status: 'completed', durationMs: 4000 });
    assert.equal(String(failed[0].payload.name).length, 64, 'a long name is cut');
    assert.equal(String(failed[0].payload.summary).length, 1000, 'a long result is cut');
  });
});

describe('AgentCore — a sub-agent\'s own messages and tool calls', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('shows them as that agent\'s, keeps them out of the main answer, and drops a sub-agent\'s private thoughts', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'text', text: 'Looking into it. ' } as AgentCoreSSEEvent;
      yield { type: 'text', text: 'sub-agent says hi', agentId: 's-1', agent: 'explorer' } as AgentCoreSSEEvent;
      yield { type: 'tool', name: 'fs_read', agentId: 's-1', agent: 'explorer' } as AgentCoreSSEEvent;
      yield { type: 'thought', text: 'private reasoning', agentId: 's-1', agent: 'explorer' } as AgentCoreSSEEvent;
      yield { type: 'thought', text: 'main reasoning' } as AgentCoreSSEEvent;
      yield { type: 'text', text: 'All done.' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx, events } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);
    const { textParts } = await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });
    const summary = textParts.join('');

    const texts = pick(events, 'assistant-text');
    const sub = texts.find((e) => e.payload.agentId === 's-1')!;
    assert.equal(sub.payload.text, 'sub-agent says hi');
    assert.equal(sub.payload.agent, 'explorer');
    assert.ok(texts.filter((e) => !e.payload.agentId).every((e) => !String(e.payload.text).includes('sub-agent')), 'the main agent\'s text has none of the sub-agent\'s');
    assert.ok(!summary.includes('sub-agent says hi'), 'the sub-agent\'s message is not part of the main answer');
    assert.match(summary, /Looking into it\./);
    assert.match(summary, /All done\./);

    const tool = pick(events, 'tool-start').find((e) => e.payload.agentId === 's-1')!;
    assert.equal(tool.payload.toolName, 'fs_read');
    assert.equal(tool.payload.agent, 'explorer');
    assert.equal(pick(events, 'tool-end').find((e) => e.payload.agentId === 's-1')!.payload.toolName, 'fs_read');

    const thoughts = pick(events, 'agent-thought').map((e) => String(e.payload.text));
    assert.deepEqual(thoughts, ['main reasoning']);
  });
});

describe('AgentCore — browser events → the Browser tab', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('turns browser events from the runner into browser-navigate and browser-screenshot', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'browser-navigate', url: 'https://example.com/' } as AgentCoreSSEEvent;
      yield { type: 'browser-screenshot', screenshotBase64: 'AAAA', url: 'https://example.com/' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx, events } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);
    await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });

    assert.equal(pick(events, 'browser-navigate')[0].payload.url, 'https://example.com/');
    const shot = pick(events, 'browser-screenshot')[0];
    assert.equal(shot.payload.screenshotBase64, 'AAAA');
    assert.equal(shot.payload.url, 'https://example.com/');
  });
});

describe('AgentCore — status event forwarding', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('forwards status text events', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'status', text: 'kiro-cli ACP starting…' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx, events } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);
    await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });

    const statusTexts = events.filter(
      (e) => e.type === 'status' && typeof e.payload.text === 'string' && (e.payload.text as string).includes('ACP starting'),
    );
    assert.ok(statusTexts.length >= 1, 'Expected forwarded status text event');
  });
});

// ── Error event ───────────────────────────────────────────────────────────────

describe('AgentCore — error event → throws', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('throws when AgentCore emits an error event', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'error', message: 'kiro-cli not found in container' } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);

    let threw = false;
    try {
      await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });
    } catch (e) {
      threw = true;
      assert.match(String((e as Error).message), /AgentCore kiro-run error/i);
    }
    assert.ok(threw, 'Expected runKiroViaAgentCore to throw on error event');
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────────

describe('AgentCore — cancel via AbortSignal', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('throws AbortError when signal is aborted before run ends', async () => {
    const ctrl = new AbortController();

    _setAgentCoreInvokerOverride(async function* (_, __, ___, signal?: AbortSignal) {
      yield { type: 'text', text: 'partial output' } as AgentCoreSSEEvent;
      // Abort mid-stream
      ctrl.abort();
      // Yield a few more events to check they are ignored
      yield { type: 'text', text: 'should not appear' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const permissions = await loadRunPermissions(td.projectId);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const agentRun: AgentRun = {
      runId: td.runId, workflowId: td.workflowId, projectId: td.projectId,
      goal: 'cancel test', kind: null, engine: 'kiro', trusted: false,
      dataDir: cfg.dataDir, workDir: td.workDir, repoIds: [], leadAgent: null,
      permissions, credentialId: null, credentialOwnerId: null, model: null,
      engineSessionId: null,
    };
    const ctx: RunContext = {
      run: agentRun,
      emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(),
      signal: ctrl.signal,
    };

    let threw = false;
    try {
      await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });
    } catch (e) {
      threw = true;
      assert.equal((e as DOMException).name, 'AbortError');
    }
    assert.ok(threw, 'Expected AbortError when signal is aborted');
  });
});

// ── Timeout ───────────────────────────────────────────────────────────────────

describe('AgentCore — run timeout', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
    process.env.PORTAL_RUN_TIMEOUT_MS = '50'; // 50 ms timeout for the test
  });

  after(async () => {
    delete process.env.PORTAL_RUN_TIMEOUT_MS;
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  it('throws 504 when the run exceeds PORTAL_RUN_TIMEOUT_MS', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      // Never yields — simulates a hung run
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 2000, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const td = makeTestData(cfg);
    const { ctx } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);

    let threw = false;
    try {
      await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null });
    } catch (e) {
      threw = true;
      const err = e as { status?: number; message?: string };
      // Should throw either a 504 HttpError or the AbortError from the timeout
      assert.ok(
        err.status === 504 || (e instanceof DOMException) || /timed?\s*out/i.test(String(err.message ?? '')),
        `Expected timeout error, got: ${err.message}`,
      );
    }
    assert.ok(threw, 'Expected timeout error');
  });
});

// ── Token write-back ──────────────────────────────────────────────────────────

describe('AgentCore — token write-back after run', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  function createIdcCredential(): string {
    const credId = `cred-${generateId()}`;
    const userId = `user-${generateId()}`;
    // engine_credentials has a foreign key to users
    getDb().prepare(
      `INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, 'x', 0, 0, ?)`,
    ).run(userId, `test-${userId}@example.com`, 'Test User', now());
    const initialToken = 'initial-access-token-abc123';
    const tokenEnc = encrypt(initialToken, SECRET_KEY);
    const extra = JSON.stringify({
      startUrl: 'https://d-test.awsapps.com/start',
      region: 'us-east-1',
      tokenExpiry: new Date(Date.now() + 3_600_000).toISOString(),
    });
    getDb().prepare(
      `INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'test cred', 'identity_center', ?, ?, 0, ?, ?, ?)`,
    ).run(credId, userId, tokenEnc, extra, initialToken.slice(-4), now(), now());
    return credId;
  }

  it('writes back a refreshed token when ciphertext matches', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'text', text: 'done' } as AgentCoreSSEEvent;
      yield {
        type: 'result',
        runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50,
        tokenRefreshed: true,
        refreshedToken: {
          accessToken: 'new-access-token-xyz',
          expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
          refreshToken: 'new-refresh-token',
        },
      } as AgentCoreSSEEvent;
    });

    const credId = createIdcCredential();
    const storedBefore = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;

    const td = makeTestData(cfg);
    const { ctx } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg, { credentialId: credId });

    await runKiroViaAgentCore(ctx, {
      runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x',
      token: SAMPLE_TOKEN,
      credentialId: credId,
      expectedCiphertext: storedBefore.secret_enc,
    });

    const storedAfter = one<{ secret_enc: string; extra_config: string }>(
      'SELECT secret_enc, extra_config FROM engine_credentials WHERE id = ?', credId,
    )!;

    const newToken = decrypt(storedAfter.secret_enc, SECRET_KEY);
    assert.equal(newToken, 'new-access-token-xyz', 'Token should be updated');
    const newExtra = JSON.parse(storedAfter.extra_config) as Record<string, unknown>;
    assert.ok(newExtra.tokenExpiry, 'tokenExpiry should be updated');
    assert.ok(newExtra.refreshTokenEnc, 'refreshTokenEnc should be stored');
  });

  it('skips token write-back when another run already saved a newer token (concurrent case)', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield {
        type: 'result',
        runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50,
        tokenRefreshed: true,
        refreshedToken: {
          accessToken: 'late-token-should-not-win',
          expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        },
      } as AgentCoreSSEEvent;
    });

    const credId = createIdcCredential();
    const storedBefore = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;

    // Simulate another run writing a newer token first
    const concurrentToken = 'concurrent-newer-token';
    const concurrentEnc = encrypt(concurrentToken, SECRET_KEY);
    getDb().prepare('UPDATE engine_credentials SET secret_enc = ? WHERE id = ?')
      .run(concurrentEnc, credId);

    const td = makeTestData(cfg);
    // This run uses the OLD ciphertext as expectedCiphertext
    await saveRefreshedTokenConditional(
      credId,
      'late-token-should-not-win',
      new Date(Date.now() + 7_200_000).toISOString(),
      undefined,
      storedBefore.secret_enc, // old ciphertext — should not match after concurrent update
    );

    // The concurrent token should still be there
    const stored = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;
    const actual = decrypt(stored.secret_enc, SECRET_KEY);
    assert.equal(actual, concurrentToken, 'Concurrent token should be preserved');
  });

  it('does not write back when tokenRefreshed=false', async () => {
    _setAgentCoreInvokerOverride(async function* () {
      yield { type: 'text', text: 'no refresh' } as AgentCoreSSEEvent;
      yield { type: 'result', runId: 'r1', exitCode: 0, durationMs: 100, coldStartMs: 50, tokenRefreshed: false } as AgentCoreSSEEvent;
    });

    const credId = createIdcCredential();
    const storedBefore = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;

    const td = makeTestData(cfg);
    const { ctx } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg, { credentialId: credId });

    await runKiroViaAgentCore(ctx, {
      runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'x',
      token: SAMPLE_TOKEN,
      credentialId: credId,
      expectedCiphertext: storedBefore.secret_enc,
    });

    const storedAfter = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;
    assert.equal(storedAfter.secret_enc, storedBefore.secret_enc, 'secret_enc should not change when tokenRefreshed=false');
  });
});

// ── Login flow ────────────────────────────────────────────────────────────────

describe('AgentCore — login flow', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    _setAgentCoreInvokerOverride(null);
    await cleanup();
  });

  afterEach(() => {
    _agentCoreLoginState.clear();
  });

  it('returns verification challenge from startAgentCoreLogin', async () => {
    const credId = `cred-${generateId()}`;

    _setAgentCoreInvokerOverride(async function* () {
      yield {
        type: 'verification',
        verificationUri: 'https://d-test.awsapps.com/start/#/device?user_code=TEST-1234',
        userCode: 'TEST-1234',
      } as unknown as AgentCoreSSEEvent;
      // Simulate login completing
      yield {
        type: 'result',
        success: true,
        tokenSizeBytes: 100,
        durationMs: 500,
        coldStartMs: 200,
        exitCode: 0,
        tokenPayload: {
          access_token: 'login-access-token',
          expires_at: new Date(Date.now() + 28_800_000).toISOString(),
          refresh_token: 'login-refresh-token',
          region: 'us-east-1',
          start_url: 'https://d-test.awsapps.com/start',
        },
      } as unknown as AgentCoreSSEEvent;
    });

    const challenge = await startAgentCoreLogin(
      FAKE_ARN,
      credId,
      'https://d-test.awsapps.com/start',
      'us-east-1',
    );

    assert.equal(challenge.verificationUri, 'https://d-test.awsapps.com/start/#/device?user_code=TEST-1234');
    assert.equal(challenge.userCode, 'TEST-1234');
    assert.ok(challenge.expiresIn > 0, 'expiresIn must be positive');
  });

  it('pollAgentCoreLogin returns complete with token after login succeeds', async () => {
    const credId = `cred-${generateId()}`;
    const tokenPayload = {
      access_token: 'poll-access-token',
      expires_at: new Date(Date.now() + 28_800_000).toISOString(),
      refresh_token: 'poll-refresh-token',
      region: 'us-east-1',
      start_url: 'https://d-poll.awsapps.com/start',
    };

    _setAgentCoreInvokerOverride(async function* () {
      yield {
        type: 'verification',
        verificationUri: 'https://example.com/device',
        userCode: 'POLL-5678',
      } as unknown as AgentCoreSSEEvent;
      yield {
        type: 'result',
        success: true,
        tokenSizeBytes: 100,
        durationMs: 500,
        coldStartMs: 200,
        exitCode: 0,
        tokenPayload,
      } as unknown as AgentCoreSSEEvent;
    });

    await startAgentCoreLogin(FAKE_ARN, credId, 'https://d-poll.awsapps.com/start', 'us-east-1');

    // Wait for the background login to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const result = pollAgentCoreLogin(credId);
    assert.equal(result.status, 'complete', `Expected complete, got ${result.status}`);
    assert.ok(result.tokenPayload, 'Expected tokenPayload');
    assert.equal(result.tokenPayload!.access_token, 'poll-access-token');
  });

  it('pollAgentCoreLogin returns failed when login error occurs', async () => {
    const credId = `cred-${generateId()}`;

    _setAgentCoreInvokerOverride(async function* () {
      yield {
        type: 'verification',
        verificationUri: 'https://example.com/device',
        userCode: 'FAIL-9999',
      } as unknown as AgentCoreSSEEvent;
      yield {
        type: 'result',
        success: false,
        tokenSizeBytes: 0,
        durationMs: 500,
        coldStartMs: 200,
        exitCode: 1,
      } as unknown as AgentCoreSSEEvent;
    });

    await startAgentCoreLogin(FAKE_ARN, credId, 'https://d-fail.awsapps.com/start', 'us-east-1');

    // Wait for the background login to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const result = pollAgentCoreLogin(credId);
    assert.equal(result.status, 'failed', `Expected failed, got ${result.status}`);
  });

  it('pollAgentCoreLogin returns unknown when no pending entry', () => {
    const result = pollAgentCoreLogin('no-such-credential-id');
    assert.equal(result.status, 'unknown');
  });
});

// ── saveRefreshedTokenConditional unit tests ───────────────────────────────────

describe('saveRefreshedTokenConditional — conditional write', () => {
  let cfg: Config;

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  after(async () => {
    await cleanup();
  });

  function createCred(token: string): string {
    const credId = `cred-${generateId()}`;
    const userId = `user-${generateId()}`;
    // engine_credentials has a foreign key to users
    getDb().prepare(
      `INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, 'x', 0, 0, ?)`,
    ).run(userId, `test-${userId}@example.com`, 'Test User', now());
    const tokenEnc = encrypt(token, SECRET_KEY);
    const extra = JSON.stringify({ startUrl: 'https://x.awsapps.com/start', region: 'us-east-1', tokenExpiry: new Date(Date.now() + 3600 * 1000).toISOString() });
    getDb().prepare(
      `INSERT INTO engine_credentials (id, user_id, engine, name, mode, secret_enc, extra_config, is_default, last4, created_at, updated_at)
       VALUES (?, ?, 'kiro', 'c', 'identity_center', ?, ?, 0, ?, ?, ?)`,
    ).run(credId, userId, tokenEnc, extra, token.slice(-4), now(), now());
    return credId;
  }

  it('writes new token when expected ciphertext matches', async () => {
    const credId = createCred('old-token');
    const stored = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;

    await saveRefreshedTokenConditional(credId, 'new-token', new Date(Date.now() + 7200 * 1000).toISOString(), undefined, stored.secret_enc);

    const after = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;
    const actual = decrypt(after.secret_enc, SECRET_KEY);
    assert.equal(actual, 'new-token');
  });

  it('skips write when expected ciphertext does not match (concurrent write)', async () => {
    const credId = createCred('original-token');
    const storedBefore = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;

    // Another run writes a newer token
    const newerEnc = encrypt('concurrent-token', SECRET_KEY);
    getDb().prepare('UPDATE engine_credentials SET secret_enc = ? WHERE id = ?').run(newerEnc, credId);

    // This run tries to write with the stale expected ciphertext
    await saveRefreshedTokenConditional(credId, 'late-token', new Date(Date.now() + 7200 * 1000).toISOString(), undefined, storedBefore.secret_enc);

    const after = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;
    const actual = decrypt(after.secret_enc, SECRET_KEY);
    assert.equal(actual, 'concurrent-token', 'concurrent-token should win');
  });

  it('writes refresh token into extra_config.refreshTokenEnc', async () => {
    const credId = createCred('base-token');
    const stored = one<{ secret_enc: string }>('SELECT secret_enc FROM engine_credentials WHERE id = ?', credId)!;

    await saveRefreshedTokenConditional(
      credId, 'refreshed-access', new Date(Date.now() + 7200 * 1000).toISOString(),
      'new-refresh-token', stored.secret_enc,
    );

    const after = one<{ extra_config: string }>('SELECT extra_config FROM engine_credentials WHERE id = ?', credId)!;
    const extra = JSON.parse(after.extra_config) as Record<string, unknown>;
    assert.ok(extra.refreshTokenEnc, 'refreshTokenEnc should be stored');
    const rt = decrypt(String(extra.refreshTokenEnc), SECRET_KEY);
    assert.equal(rt, 'new-refresh-token');
  });
});

describe('deviceUrlWithCode', () => {
  it('puts the code in the Identity Center device link so it works when already signed in', async () => {
    const { deviceUrlWithCode } = await import('../server/agent/kiro-agentcore.ts');
    assert.equal(
      deviceUrlWithCode('https://d-906665ee1d.awsapps.com/start', 'HMMX-MJRW'),
      'https://d-906665ee1d.awsapps.com/start/#/device?user_code=HMMX-MJRW',
    );
    assert.equal(deviceUrlWithCode('https://d-1.awsapps.com/start/', 'AB-CD'), 'https://d-1.awsapps.com/start/#/device?user_code=AB-CD');
    const full = 'https://d-1.awsapps.com/start/#/device?user_code=AB-CD';
    assert.equal(deviceUrlWithCode(full, 'AB-CD'), full);
  });
});

// ── Pull requests: finalizeCheck out, repo-changes in ────────────────────────

describe('AgentCore — pull requests from Kiro runs', () => {
  let cfg: Config;
  const REPOS = [{ name: 'web', url: 'https://example.invalid/web.git' }];

  before(() => {
    createTestDb();
    cfg = makeConfig();
    setConfig(cfg);
  });

  afterEach(() => {
    _setRepoChangesHooks(null);
    _setAgentCoreInvokerOverride(null);
  });

  after(async () => { await cleanup(); });

  async function runWith(events: AgentCoreSSEEvent[], flag: boolean, handle: (ctx: unknown, changes: unknown) => Promise<void>) {
    const sent: Array<Record<string, unknown>> = [];
    _setAgentCoreInvokerOverride(async function* (_arn, _sid, payload) {
      sent.push(payload);
      for (const e of events) yield e;
    });
    _setRepoChangesHooks({ flag: async () => flag, handle: handle as never });
    const td = makeTestData(cfg);
    const { ctx } = await makeCtx(td.runId, td.workflowId, td.projectId, td.workDir, cfg);
    await runKiroViaAgentCore(ctx, { runtimeArn: FAKE_ARN, runId: td.runId, prompt: 'p', token: SAMPLE_TOKEN, credentialId: null, expectedCiphertext: null, repos: REPOS });
    return { sent, td };
  }

  const done: AgentCoreSSEEvent = { type: 'result', runId: 'r1', exitCode: 0, durationMs: 1, coldStartMs: 1, tokenRefreshed: false };

  it('sends finalizeCheck only when the portal asks for it', async () => {
    const calls: unknown[] = [];
    const on = await runWith([done], true, async (c) => { calls.push(c); });
    assert.equal(on.sent[0].finalizeCheck, true);
    const off = await runWith([done], false, async (c) => { calls.push(c); });
    assert.equal('finalizeCheck' in off.sent[0], false);
    assert.equal(calls.length, 0, 'no changes reported, nothing handled');
  });

  it('hands the runner\'s repo-changes events to handleRepoChanges with engine kiro', async () => {
    let got: { ctx: Record<string, unknown>; changes: unknown } | null = null;
    const { td } = await runWith([
      { type: 'repo-changes', repo: 'web', base: 'main', commits: 2, files: 5 },
      done,
    ], true, async (ctx, changes) => { got = { ctx: ctx as Record<string, unknown>, changes }; });
    assert.ok(got);
    const g = got as { ctx: Record<string, unknown>; changes: unknown };
    assert.deepEqual(g.changes, [{ repo: 'web', base: 'main', commits: 2, files: 5 }]);
    assert.equal(g.ctx.engine, 'kiro');
    assert.equal(g.ctx.workflowId, td.workflowId);
    assert.equal(g.ctx.projectId, td.projectId);
    assert.equal(g.ctx.runId, td.runId);
  });

  it('a failing handleRepoChanges does not fail the run', async () => {
    await assert.doesNotReject(runWith([{ type: 'repo-changes', repo: 'web', base: 'main', commits: 0, files: 1 }, done], true, async () => { throw new Error('boom'); }));
  });

  it('does not hand over changes when the run fails', async () => {
    let called = false;
    await assert.rejects(runWith([{ type: 'repo-changes', repo: 'web', base: 'main', commits: 0, files: 1 }, { type: 'error', message: 'bad' }], true, async () => { called = true; }));
    assert.equal(called, false);
  });
});
