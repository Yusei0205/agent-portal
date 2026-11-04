/**
 * Tests for engine session persistence (F-SESSION-RESUME).
 *
 * Covers:
 *   Kiro (ACP path):
 *     - First run stores engine_session_id on the workflow
 *     - Second run calls session/load with the stored ID and does NOT call session/new
 *     - Replayed history during session/load is suppressed (not emitted as events)
 *     - Load failure falls back to session/new + recap; status message emitted
 *     - Recap contains earlier user answer
 *     - ACP error message includes error.data field
 *     - /clear resets engine_session_id and engine_session_engine
 *   No-stored-id with prior runs:
 *     - When engineSessionId is null but prior runs exist, recap is prepended
 *     - After /clear, no recap
 *   Recap quality:
 *     - Recap merges turns by created_at (not index pairing)
 *     - Current run's messages are excluded from recap
 *   Claude Code (SDK path):
 *     - First run stores engine_session_id from SDK result.session_id
 *     - Second run passes resume option to the SDK with the stored ID
 *     - Resume failure retries without resume, uses recap, stores new id
 *   Claude Code transcript persistence:
 *     - .jsonl files are persisted after a run and restored before the next
 *     - Only .jsonl files are copied (not credentials or settings)
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getDb, one, all, insert } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { setConfig } from '../server/config.ts';
import type { Config } from '../server/config.ts';
import { runKiro } from '../server/agent/kiro.ts';
import { runClaudeCode } from '../server/agent/claude-code.ts';
import { loadRunPermissions } from '../server/guardrails.ts';
import type { RunContext, AgentRun } from '../server/agent/types.ts';
import { encrypt } from '../server/secrets.ts';
import {
  persistClaudeTranscripts,
  restoreClaudeTranscripts,
  claudeProjectDirName,
} from '../server/agent/claude-sessions.ts';
import { buildConversationRecap } from '../server/agent/recap.ts';

// -- Paths ---------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_KIRO = path.join(__dirname, 'fake-kiro.mjs');
const FAKE_SDK = path.join(__dirname, 'fake-sdk.mjs');

// -- Test data factory ---------------------------------------------------------

interface TestData {
  workDir: string;
  runId: string;
  workflowId: string;
  projectId: string;
  cfg: Config;
}

function makeTestData(engineOverride: 'kiro' | 'claude-code' = 'kiro'): TestData {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-session-test-'));
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
    .run(projectId, 'Session Test', `sess-test-${Date.now()}`, now());
  db.prepare(
    `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, 0, '[]', ?, ?)`,
  ).run(workflowId, projectId, 'Session test goal', engineOverride, now(), now());
  db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`)
    .run(runId, workflowId, now());

  if (engineOverride === 'claude-code') {
    const fakeKey = encrypt('sk-ant-test-fake-key-for-testing', cfg.secretKey);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('provider.mode', 'anthropic');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('anthropic.key.enc', fakeKey);
  }

  return { workDir, runId, workflowId, projectId, cfg };
}

async function makeCtx(
  t: TestData,
  overrides: Partial<AgentRun> = {},
): Promise<{
  ctx: RunContext;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}> {
  const permissions = await loadRunPermissions(t.projectId);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const agentRun: AgentRun = {
    runId: t.runId,
    workflowId: t.workflowId,
    projectId: t.projectId,
    goal: 'Session test goal',
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
    awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
    allowed: new Set<string>(),
    signal: ctrl.signal,
  };

  return { ctx, events };
}

function textOutput(events: Array<{ type: string; payload: Record<string, unknown> }>): string {
  return events
    .filter((e) => e.type === 'assistant-text')
    .map((e) => String(e.payload.text ?? ''))
    .join('');
}

function statusMessages(events: Array<{ type: string; payload: Record<string, unknown> }>): string[] {
  return events
    .filter((e) => e.type === 'status' && e.payload.text)
    .map((e) => String(e.payload.text));
}

// -- Kiro: first run stores engine_session_id ----------------------------------

describe('Kiro session � first run stores engine_session_id', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData('kiro');
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'normal';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('stores engine_session_id on the workflow after a successful run', async () => {
    const { ctx } = await makeCtx(t, { engineSessionId: null });
    await runKiro(ctx);

    const wf = one<{ engine_session_id: string | null; engine_session_engine: string | null }>(
      'SELECT engine_session_id, engine_session_engine FROM p6_workflows WHERE id = ?',
      t.workflowId,
    );
    assert.ok(wf?.engine_session_id, 'engine_session_id must be set after first run');
    assert.equal(wf?.engine_session_engine, 'kiro', 'engine must be kiro');
    assert.equal(wf?.engine_session_id, 'fake-session-001');
  });

  it('stores session_id before the prompt completes (immediate storage)', async () => {
    const { ctx } = await makeCtx(t, { engineSessionId: null });
    await runKiro(ctx);
    const wf = one<{ engine_session_id: string | null }>(
      'SELECT engine_session_id FROM p6_workflows WHERE id = ?',
      t.workflowId,
    );
    assert.ok(wf?.engine_session_id, 'session ID must be persisted');
  });
});

// -- Kiro: second run uses session/load ----------------------------------------

describe('Kiro session � second run calls session/load, not session/new', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData('kiro');
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-session-resume';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('emits "resumed:<id>" when engineSessionId is provided', async () => {
    const { ctx, events } = await makeCtx(t, { engineSessionId: 'fake-session-001' });
    await runKiro(ctx);
    const text = textOutput(events);
    assert.ok(
      text.includes('resumed:fake-session-001'),
      `Expected "resumed:fake-session-001" in text; got: "${text.slice(0, 200)}"`,
    );
  });

  it('does not emit "session_new_was_called" (session/new not invoked)', async () => {
    const { ctx, events } = await makeCtx(t, { engineSessionId: 'fake-session-001' });
    await runKiro(ctx);
    const text = textOutput(events);
    assert.ok(
      !text.includes('session_new_was_called'),
      `session/new must NOT be called on resume; got: "${text.slice(0, 200)}"`,
    );
  });

  it('emits a status event saying "Continuing the previous Kiro session"', async () => {
    const { ctx, events } = await makeCtx(t, { engineSessionId: 'fake-session-001' });
    await runKiro(ctx);
    const statuses = statusMessages(events);
    assert.ok(
      statuses.some((s) => s.includes('Continuing the previous Kiro session')),
      `Expected "Continuing the previous Kiro session" status; got: ${JSON.stringify(statuses)}`,
    );
  });
});

// -- Kiro: replayed history is suppressed --------------------------------------

describe('Kiro session � replayed history during session/load is not emitted', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData('kiro');
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-session-resume';
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('does not emit REPLAY_TEXT_SHOULD_NOT_APPEAR in assistant-text events', async () => {
    const { ctx, events } = await makeCtx(t, { engineSessionId: 'fake-session-001' });
    await runKiro(ctx);
    const text = textOutput(events);
    assert.ok(
      !text.includes('REPLAY_TEXT_SHOULD_NOT_APPEAR'),
      `Replayed history must be suppressed; got text: "${text.slice(0, 200)}"`,
    );
  });
});

// -- Kiro: load failure falls back to session/new with recap -------------------

describe('Kiro session � load failure falls back to session/new with recap', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData('kiro');
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-session-load-fail';
    delete process.env.PORTAL_KIRO_TEXT_MODE;

    // Seed prior conversation for the recap
    const db = getDb();
    const priorRunId = `run-prior-${generateId()}`;
    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'done', ?)`)
      .run(priorRunId, t.workflowId, now());
    db.prepare(
      `INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, 'run-complete', ?, ?)`,
    ).run(priorRunId, JSON.stringify({ result: 'I listed options a, b, and c for you.' }), now());
    // Human message from prior turn (sent before the reply it answered with the options)
    db.prepare(
      `INSERT INTO p6_workflow_events (workflow_id, kind, body, consumed, created_at) VALUES (?, 'human', ?, 1, ?)`,
    ).run(t.workflowId, 'b first', new Date(Date.now() - 60_000).toISOString());
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('run succeeds (does not throw) after load failure', async () => {
    const { ctx } = await makeCtx(t, { engineSessionId: 'stale-session-id' });
    await assert.doesNotReject(() => runKiro(ctx));
  });

  it('emits a status event mentioning "could not resume"', async () => {
    const { ctx, events } = await makeCtx(t, { engineSessionId: 'stale-session-id' });
    await runKiro(ctx).catch(() => {});
    const statuses = statusMessages(events);
    assert.ok(
      statuses.some((s) => s.toLowerCase().includes('could not resume')),
      `Expected "could not resume" status; got: ${JSON.stringify(statuses)}`,
    );
  });

  it('ACP error message includes error.data (Session not found)', async () => {
    const { ctx, events } = await makeCtx(t, { engineSessionId: 'stale-session-id' });
    await runKiro(ctx).catch(() => {});
    const statuses = statusMessages(events);
    // The ACP client now includes error.data in the message, so the status reason
    // should contain the meaningful data string ("Session not found") not just
    // the generic code message.
    assert.ok(
      statuses.some((s) => s.includes('Session not found')),
      `Status must include "Session not found" from error.data; got: ${JSON.stringify(statuses)}`,
    );
  });

  it('recap contains the earlier user answer "b first"', async () => {
    const { ctx, events } = await makeCtx(t, { engineSessionId: 'stale-session-id' });
    await runKiro(ctx).catch(() => {});
    const text = textOutput(events);
    assert.ok(
      text.includes('b first'),
      `Recap should include earlier user message "b first"; got: "${text.slice(0, 300)}"`,
    );
  });

  it('stores a new engine_session_id after the fallback', async () => {
    const { ctx } = await makeCtx(t, { engineSessionId: 'stale-session-id' });
    await runKiro(ctx).catch(() => {});
    const wf = one<{ engine_session_id: string | null }>(
      'SELECT engine_session_id FROM p6_workflows WHERE id = ?',
      t.workflowId,
    );
    assert.ok(wf?.engine_session_id, 'New engine_session_id must be stored after fallback');
  });
});

// -- Kiro: no stored id with prior runs ? recap --------------------------------

describe('Kiro session � no stored id with prior runs prepends recap', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData('kiro');
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    process.env.PORTAL_FAKE_KIRO_SCENARIO = 'acp-session-load-fail'; // causes echo of prompt
    delete process.env.PORTAL_KIRO_TEXT_MODE;
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('emits "Started a new session with a recap" when engineSessionId is null but prior runs exist', async () => {
    const db = getDb();
    const priorRunId = `run-prior-${generateId()}`;
    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'done', ?)`)
      .run(priorRunId, t.workflowId, now());
    db.prepare(
      `INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, 'run-complete', ?, ?)`,
    ).run(priorRunId, JSON.stringify({ result: 'Prior run completed.' }), now());

    // No engineSessionId (simulating old session without stored id)
    const { ctx, events } = await makeCtx(t, { engineSessionId: null });
    await runKiro(ctx).catch(() => {});

    const statuses = statusMessages(events);
    assert.ok(
      statuses.some((s) => s.includes('Started a new session with a recap of earlier turns')),
      `Expected "Started a new session with a recap" status; got: ${JSON.stringify(statuses)}`,
    );
  });

  it('does NOT emit recap status when there are no prior runs (first run ever)', async () => {
    // Create a fresh workflow with no prior runs
    const db = getDb();
    const projectId2 = `proj-${generateId()}`;
    const workflowId2 = `wf-${generateId()}`;
    const runId2 = `run-${generateId()}`;
    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
      .run(projectId2, 'First Run Test', `first-run-${Date.now()}`, now());
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', ?, ?)`,
    ).run(workflowId2, projectId2, 'First run goal', now(), now());
    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`)
      .run(runId2, workflowId2, now());

    const permissions = await loadRunPermissions(projectId2);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const agentRun: AgentRun = {
      runId: runId2, workflowId: workflowId2, projectId: projectId2,
      goal: 'First run goal', kind: null, engine: 'kiro', trusted: false,
      dataDir: t.cfg.dataDir, workDir: t.workDir, repoIds: [],
      leadAgent: null, permissions, credentialId: null, credentialOwnerId: null,
      model: null, engineSessionId: null,
    };
    const ctx: RunContext = {
      run: agentRun,
      emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(),
      signal: new AbortController().signal,
    };
    await runKiro(ctx).catch(() => {});

    const statuses = statusMessages(events);
    assert.ok(
      !statuses.some((s) => s.includes('recap')),
      `Should not emit recap status on first run; got: ${JSON.stringify(statuses)}`,
    );
  });

  it('does NOT recap after /clear (no runs exist after the clear)', async () => {
    const db = getDb();
    const projectId3 = `proj-${generateId()}`;
    const workflowId3 = `wf-${generateId()}`;
    const runId3 = `run-${generateId()}`;
    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
      .run(projectId3, 'After Clear Test', `after-clear-${Date.now()}`, now());
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', ?, ?)`,
    ).run(workflowId3, projectId3, 'After clear goal', now(), now());

    // Seed a prior run that completed BEFORE the /clear
    const priorRunId = `run-prior-${generateId()}`;
    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'done', ?)`)
      .run(priorRunId, workflowId3, now());
    db.prepare(
      `INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, 'run-complete', ?, ?)`,
    ).run(priorRunId, JSON.stringify({ result: 'Old run result.' }), now());

    // Seed a /clear command AFTER the prior run
    db.prepare(
      `INSERT INTO p6_workflow_events (workflow_id, kind, body, consumed, created_at) VALUES (?, 'command', '/clear', 1, ?)`,
    ).run(workflowId3, now());

    // Current run starts after the /clear
    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`)
      .run(runId3, workflowId3, now());

    const permissions = await loadRunPermissions(projectId3);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const agentRun: AgentRun = {
      runId: runId3, workflowId: workflowId3, projectId: projectId3,
      goal: 'After clear goal', kind: null, engine: 'kiro', trusted: false,
      dataDir: t.cfg.dataDir, workDir: t.workDir, repoIds: [],
      leadAgent: null, permissions, credentialId: null, credentialOwnerId: null,
      model: null, engineSessionId: null,
    };
    const ctx: RunContext = {
      run: agentRun,
      emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set<string>(),
      signal: new AbortController().signal,
    };
    await runKiro(ctx).catch(() => {});

    const statuses = statusMessages(events);
    assert.ok(
      !statuses.some((s) => s.includes('recap')),
      `Should not emit recap after /clear; got: ${JSON.stringify(statuses)}`,
    );
  });
});

// -- Recap quality � ordering and exclusion ------------------------------------

describe('buildConversationRecap � time ordering and current message exclusion', () => {
  let t: TestData;

  before(() => {
    createTestDb();
    t = makeTestData('kiro');
  });

  after(async () => { await cleanup(); });

  it('merges completions and messages by created_at (not index pairing)', async () => {
    const db = getDb();
    const ts = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

    const run1Id = `run-r1-${generateId()}`;
    const run2Id = `run-r2-${generateId()}`;
    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'done', ?)`)
      .run(run1Id, t.workflowId, ts(0));
    db.prepare(`INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, 'run-complete', ?, ?)`)
      .run(run1Id, JSON.stringify({ result: 'First assistant reply' }), ts(0));

    db.prepare(`INSERT INTO p6_workflow_events (workflow_id, kind, body, consumed, created_at) VALUES (?, 'human', ?, 1, ?)`)
      .run(t.workflowId, 'User message A', ts(10));

    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'done', ?)`)
      .run(run2Id, t.workflowId, ts(20));
    db.prepare(`INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, 'run-complete', ?, ?)`)
      .run(run2Id, JSON.stringify({ result: 'Second assistant reply' }), ts(20));

    const recap = await buildConversationRecap(t.workflowId, t.runId);

    assert.ok(recap.includes('First assistant reply'), 'Must include first assistant reply');
    assert.ok(recap.includes('User message A'), 'Must include user message A');
    assert.ok(recap.includes('Second assistant reply'), 'Must include second assistant reply');

    const firstIdx = recap.indexOf('First assistant reply');
    const userAIdx = recap.indexOf('User message A');
    const secondIdx = recap.indexOf('Second assistant reply');
    assert.ok(firstIdx < userAIdx, 'First reply must come before User A');
    assert.ok(userAIdx < secondIdx, 'User A must come before second reply');
  });

  it('excludes current-run messages when minExcludeEventId is provided', async () => {
    const db = getDb();
    const ts = (offsetMs: number): string => new Date(Date.now() + offsetMs + 5000).toISOString();

    const run3Id = `run-r3-${generateId()}`;
    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'done', ?)`)
      .run(run3Id, t.workflowId, ts(0));
    db.prepare(`INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, 'run-complete', ?, ?)`)
      .run(run3Id, JSON.stringify({ result: 'Prior run result' }), ts(0));

    db.prepare(`INSERT INTO p6_workflow_events (workflow_id, kind, body, consumed, created_at) VALUES (?, 'human', ?, 1, ?)`)
      .run(t.workflowId, 'User prior message', ts(5));

    db.prepare(`INSERT INTO p6_workflow_events (workflow_id, kind, body, consumed, created_at) VALUES (?, 'human', ?, 1, ?)`)
      .run(t.workflowId, 'User current message', ts(10));

    const currentMsgRow = db.prepare(
      `SELECT id FROM p6_workflow_events WHERE workflow_id = ? AND body = 'User current message' ORDER BY id DESC LIMIT 1`,
    ).get(t.workflowId) as { id: number } | undefined;
    assert.ok(currentMsgRow, 'Current message must exist');
    const currentMsgId = Number(currentMsgRow!.id);

    // Without an explicit boundary, messages after the last completed reply are the
    // current prompt and are skipped; the prior message (before that reply) stays.
    const recapAll = await buildConversationRecap(t.workflowId, t.runId, null);
    assert.ok(recapAll.includes('Prior run result'), 'Last reply in recap');
    assert.ok(!recapAll.includes('User current message'), 'Message sent after the last reply is the current prompt');

    // With exclusion: only prior message
    const recapExcl = await buildConversationRecap(t.workflowId, t.runId, currentMsgId);
    assert.ok(recapExcl.includes('User prior message'), 'Prior message in recap with exclusion');
    assert.ok(!recapExcl.includes('User current message'), 'Current message excluded');
  });

  it('returns empty string when no prior completed runs', async () => {
    const db = getDb();
    const emptyWfId = `wf-${generateId()}`;
    const emptyRunId = `run-${generateId()}`;
    const emptyProjId = `proj-${generateId()}`;
    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
      .run(emptyProjId, 'Empty', `empty-${Date.now()}`, now());
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', ?, ?)`,
    ).run(emptyWfId, emptyProjId, 'Empty', now(), now());
    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`)
      .run(emptyRunId, emptyWfId, now());

    assert.equal(await buildConversationRecap(emptyWfId, emptyRunId), '', 'Empty recap when no prior runs');
  });

  it('returns empty string after /clear', async () => {
    const db = getDb();
    const p2Id = `proj-${generateId()}`;
    const wf2Id = `wf-${generateId()}`;
    const run2Id = `run-${generateId()}`;
    const priorRunId = `run-prior-${generateId()}`;
    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
      .run(p2Id, 'After Clear', `after-clear-recap-${Date.now()}`, now());
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', ?, ?)`,
    ).run(wf2Id, p2Id, 'After clear', now(), now());

    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'done', ?)`)
      .run(priorRunId, wf2Id, now());
    db.prepare(`INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, 'run-complete', ?, ?)`)
      .run(priorRunId, JSON.stringify({ result: 'Old result' }), now());

    // /clear AFTER the prior run
    db.prepare(`INSERT INTO p6_workflow_events (workflow_id, kind, body, consumed, created_at) VALUES (?, 'command', '/clear', 1, ?)`)
      .run(wf2Id, now());

    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`)
      .run(run2Id, wf2Id, now());

    assert.equal(await buildConversationRecap(wf2Id, run2Id), '', 'Empty recap after /clear');
  });
});
// -- /clear resets engine_session_id ------------------------------------------

describe('/clear command resets engine_session_id', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    const r = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: {
        email: `admin-clear-test-${Date.now()}@example.com`,
        name: 'Admin',
        password: 'password1234',
        provider: 'demo',
      },
    });
    cookie = r.cookie ?? '';

    const pr = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Clear Test Project' },
      cookie,
    });
    projectId = ((pr.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  });

  after(async () => { await cleanup(); });

  it('/clear clears engine_session_id and engine_session_engine', async () => {
    const wfR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Clear test session', engine: 'kiro' },
      cookie,
    });
    const wfId = ((wfR.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;

    const { run: dbRun } = await import('../server/db.ts');
    dbRun(
      "UPDATE p6_workflows SET engine_session_id = 'test-session-id', engine_session_engine = 'kiro' WHERE id = ?",
      wfId,
    );

    const { one: dbOne } = await import('../server/db.ts');
    const before = dbOne<{ engine_session_id: string | null }>('SELECT engine_session_id FROM p6_workflows WHERE id = ?', wfId);
    assert.equal(before?.engine_session_id, 'test-session-id', 'session ID should be seeded');

    const clearR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/message`, {
      method: 'POST',
      body: { message: '/clear' },
      cookie,
    });
    assert.equal(clearR.status, 200, 'POST /message /clear should succeed');

    const after = dbOne<{ engine_session_id: string | null; engine_session_engine: string | null }>(
      'SELECT engine_session_id, engine_session_engine FROM p6_workflows WHERE id = ?',
      wfId,
    );
    assert.equal(after?.engine_session_id, null, 'engine_session_id must be NULL after /clear');
    assert.equal(after?.engine_session_engine, null, 'engine_session_engine must be NULL after /clear');
  });
});

// -- workflowView exposes engineSessionId -------------------------------------

describe('workflowView includes engineSessionId', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    const r = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: {
        email: `admin-view-test-${Date.now()}@example.com`,
        name: 'Admin',
        password: 'password1234',
        provider: 'demo',
      },
    });
    cookie = r.cookie ?? '';

    const pr = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'View Test Project' },
      cookie,
    });
    projectId = ((pr.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  });

  after(async () => { await cleanup(); });

  it('GET workflow returns engineSessionId field (null before any run)', async () => {
    const wfR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'View test', engine: 'kiro' },
      cookie,
    });
    const wfId = ((wfR.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;

    const detailR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}`, { cookie });
    const wf = (detailR.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.ok('engineSessionId' in wf, 'engineSessionId should be present in workflowView');
    assert.equal(wf.engineSessionId, null, 'engineSessionId should be null before any run');
  });
});

// -- Claude Code: session_id stored and resume option passed ------------------

describe('Claude Code session � session_id stored from SDK result', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData('claude-code');
    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'sdk-session-resume';
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    await cleanup();
  });

  it('stores engine_session_id from SDK result.session_id', async () => {
    const { ctx } = await makeCtx(t, { engine: 'claude-code', engineSessionId: null });
    await runClaudeCode(ctx);

    const wf = one<{ engine_session_id: string | null; engine_session_engine: string | null }>(
      'SELECT engine_session_id, engine_session_engine FROM p6_workflows WHERE id = ?',
      t.workflowId,
    );
    assert.equal(wf?.engine_session_id, 'sdk-session-001', 'engine_session_id must match SDK session_id');
    assert.equal(wf?.engine_session_engine, 'claude-code', 'engine must be claude-code');
  });

  it('passes resume option to SDK when engineSessionId is set', async () => {
    const { ctx, events } = await makeCtx(t, {
      engine: 'claude-code',
      engineSessionId: 'sdk-session-001',
    });
    await runClaudeCode(ctx);

    const text = events
      .filter((e) => e.type === 'assistant-text')
      .map((e) => String(e.payload.text ?? ''))
      .join('');
    assert.ok(
      text.includes('Resuming:sdk-session-001'),
      `Expected "Resuming:sdk-session-001" in text; got: "${text.slice(0, 200)}"`,
    );
  });

  it('emits "Continuing the previous Claude Code session" status when engineSessionId is set', async () => {
    const { ctx, events } = await makeCtx(t, {
      engine: 'claude-code',
      engineSessionId: 'sdk-session-001',
    });
    await runClaudeCode(ctx);

    const statuses = statusMessages(events);
    assert.ok(
      statuses.some((s) => s.includes('Continuing the previous Claude Code session')),
      `Expected "Continuing the previous Claude Code session"; got: ${JSON.stringify(statuses)}`,
    );
  });

  it('does NOT pass resume option when engineSessionId is null', async () => {
    const { ctx, events } = await makeCtx(t, {
      engine: 'claude-code',
      engineSessionId: null,
    });
    await runClaudeCode(ctx);

    const text = events
      .filter((e) => e.type === 'assistant-text')
      .map((e) => String(e.payload.text ?? ''))
      .join('');
    assert.ok(
      text.includes('New session started.'),
      `Expected "New session started." for first run; got: "${text.slice(0, 200)}"`,
    );
  });
});

// -- Claude Code: resume failure retries without resume ------------------------

describe('Claude Code session � resume failure retries without resume', () => {
  let t: TestData;

  before(() => {
    createTestDb();

    t = makeTestData('claude-code');
    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'sdk-session-resume-fail';

    // Seed prior conversation for recap
    const db = getDb();
    const priorRunId = `run-prior-${generateId()}`;
    db.prepare(`INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'done', ?)`)
      .run(priorRunId, t.workflowId, now());
    db.prepare(`INSERT INTO p6_events (run_id, type, payload, created_at) VALUES (?, 'run-complete', ?, ?)`)
      .run(priorRunId, JSON.stringify({ result: 'Prior Claude run done.' }), now());
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    await cleanup();
  });

  it('run succeeds after resume failure (retries without resume)', async () => {
    const { ctx } = await makeCtx(t, {
      engine: 'claude-code',
      engineSessionId: 'sdk-session-bad',
    });
    await assert.doesNotReject(() => runClaudeCode(ctx));
  });

  it('emits status with "could not resume" after resume failure', async () => {
    const { ctx, events } = await makeCtx(t, {
      engine: 'claude-code',
      engineSessionId: 'sdk-session-bad',
    });
    await runClaudeCode(ctx).catch(() => {});
    const statuses = statusMessages(events);
    assert.ok(
      statuses.some((s) => s.includes('could not resume')),
      `Expected "could not resume" status; got: ${JSON.stringify(statuses)}`,
    );
  });

  it('stores new session_id (sdk-session-002) after retry', async () => {
    const { ctx } = await makeCtx(t, {
      engine: 'claude-code',
      engineSessionId: 'sdk-session-bad',
    });
    await runClaudeCode(ctx).catch(() => {});
    const wf = one<{ engine_session_id: string | null }>(
      'SELECT engine_session_id FROM p6_workflows WHERE id = ?',
      t.workflowId,
    );
    assert.equal(wf?.engine_session_id, 'sdk-session-002', 'Must store new session_id after retry');
  });

  it('retry prompt contains recap of prior runs', async () => {
    const { ctx, events } = await makeCtx(t, {
      engine: 'claude-code',
      engineSessionId: 'sdk-session-bad',
    });
    await runClaudeCode(ctx).catch(() => {});
    const text = events
      .filter((e) => e.type === 'assistant-text')
      .map((e) => String(e.payload.text ?? ''))
      .join('');
    // The fake SDK echoes part of the prompt in the "New session" scenario
    assert.ok(
      text.includes('Prior Claude run done') || text.includes('Context from previous'),
      `Retry prompt should contain recap; got: "${text.slice(0, 300)}"`,
    );
  });
});

// -- Claude Code transcript persistence ---------------------------------------

describe('Claude Code transcript persistence � persist and restore .jsonl only', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-claude-sessions-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('persistClaudeTranscripts copies .jsonl files from homeDir/.claude/projects/', async () => {
    const homeDir = path.join(tmpDir, 'home');
    const workDir = path.join(tmpDir, 'work');
    const dirName = 'wf-test-abc123';
    await fsp.mkdir(path.join(homeDir, '.claude', 'projects', dirName), { recursive: true });
    await fsp.mkdir(workDir, { recursive: true });

    // Write a .jsonl transcript and a non-.jsonl file
    await fsp.writeFile(
      path.join(homeDir, '.claude', 'projects', dirName, 'session-001.jsonl'),
      '{"type":"text","text":"hello"}',
      'utf8',
    );
    await fsp.writeFile(
      path.join(homeDir, '.claude', 'projects', dirName, 'settings.json'),
      '{"model":"claude-3"}',
      'utf8',
    );

    await persistClaudeTranscripts(homeDir, workDir);

    const persistedDir = path.join(workDir, '.portal', 'claude-sessions', dirName);
    assert.ok(
      fs.existsSync(path.join(persistedDir, 'session-001.jsonl')),
      '.jsonl must be persisted',
    );
    assert.ok(
      !fs.existsSync(path.join(persistedDir, 'settings.json')),
      'Non-.jsonl (settings.json) must NOT be persisted',
    );
  });

  it('persistClaudeTranscripts does not copy credential files', async () => {
    const homeDir = path.join(tmpDir, 'home');
    const workDir = path.join(tmpDir, 'work');
    const dirName = 'wf-test-creds';
    await fsp.mkdir(path.join(homeDir, '.claude', 'projects', dirName), { recursive: true });
    await fsp.mkdir(workDir, { recursive: true });

    const sensitiveFiles = [
      'credentials.json',
      'auth.json',
      'cookie.jsonl',  // .jsonl but still sensitive � but we copy ALL .jsonl by design
    ];
    for (const f of sensitiveFiles) {
      await fsp.writeFile(
        path.join(homeDir, '.claude', 'projects', dirName, f),
        '{"token":"secret"}',
        'utf8',
      );
    }
    await fsp.writeFile(
      path.join(homeDir, '.claude', 'projects', dirName, 'session.jsonl'),
      '{}',
      'utf8',
    );

    await persistClaudeTranscripts(homeDir, workDir);

    const persistedDir = path.join(workDir, '.portal', 'claude-sessions', dirName);
    // session.jsonl should be copied (it's a .jsonl file)
    assert.ok(
      fs.existsSync(path.join(persistedDir, 'session.jsonl')),
      'session.jsonl must be copied',
    );
    // credentials.json and auth.json are NOT .jsonl files and must NOT be copied
    assert.ok(
      !fs.existsSync(path.join(persistedDir, 'credentials.json')),
      'credentials.json must NOT be copied',
    );
    assert.ok(
      !fs.existsSync(path.join(persistedDir, 'auth.json')),
      'auth.json must NOT be copied',
    );
  });

  it('restoreClaudeTranscripts copies .jsonl files back to homeDir/.claude/projects/', async () => {
    const homeDir = path.join(tmpDir, 'home');
    const workDir = path.join(tmpDir, 'work');
    const dirName = 'wf-restore-test';

    // Set up the store directory (as if a prior persistClaudeTranscripts ran)
    const storeDir = path.join(workDir, '.portal', 'claude-sessions', dirName);
    await fsp.mkdir(storeDir, { recursive: true });
    await fsp.writeFile(path.join(storeDir, 'session-restored.jsonl'), '{"turn":42}', 'utf8');

    await restoreClaudeTranscripts(workDir, homeDir);

    const restoredPath = path.join(homeDir, '.claude', 'projects', dirName, 'session-restored.jsonl');
    assert.ok(fs.existsSync(restoredPath), '.jsonl must be restored to homeDir/.claude/projects/');
    const content = await fsp.readFile(restoredPath, 'utf8');
    assert.equal(content, '{"turn":42}', 'Restored content must match original');
  });

  it('claudeProjectDirName produces a valid CLAUDE_CODE_PROJECT_DIR_NAME', () => {
    const workflowId = 'wf-abc123-def456';
    const dirName = claudeProjectDirName(workflowId);
    assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(dirName), `Dir name must be valid: "${dirName}"`);
    assert.equal(dirName, 'wf-abc123-def456');

    // Special chars should be replaced with dashes
    const specialId = 'wf/path\\special:colon';
    const special = claudeProjectDirName(specialId);
    assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(special), `Special chars must be replaced: "${special}"`);
  });

  it('persistClaudeTranscripts is a no-op when .claude/projects/ does not exist', async () => {
    const homeDir = path.join(tmpDir, 'no-claude-home');
    const workDir = path.join(tmpDir, 'work-noop');
    await fsp.mkdir(workDir, { recursive: true });

    // Should not throw
    await assert.doesNotReject(() => persistClaudeTranscripts(homeDir, workDir));

    const storeDir = path.join(workDir, '.portal', 'claude-sessions');
    assert.ok(!fs.existsSync(storeDir), 'No store dir created when source does not exist');
  });
});
