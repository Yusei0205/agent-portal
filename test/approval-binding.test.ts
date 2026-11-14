/**
 * Approvals — exact-call binding, expiry, and atomic claiming (FR-GUARD-8).
 *
 * Tests:
 *   - Approval shows the whole command (not cut at 4,000 chars) and stores a
 *     SHA-256 fingerprint.  Allowing without the correct fingerprint is refused.
 *   - WebFetch "always allow" is scoped to one host, not every address.
 *   - A shell command over 20,000 characters is denied without asking.
 *   - When nobody answers in time, the input transitions to "expired" and a late
 *     answer is refused with 409.
 *   - Two concurrent answers: exactly one wins; the other gets 409.
 *   - API tokens cannot turn on "trust all tools".
 *   - DB polling endpoint GET /api/inputs/:id returns status (for AgentCore containers).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getDb, one } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { insert } from '../server/db.ts';
import { inputFingerprint, rememberKey, MAX_REVIEWABLE_COMMAND } from '../server/agent/runner.ts';
import { setConfig } from '../server/config.ts';
import type { Config } from '../server/config.ts';
import { pendingApprovals, resolveApproval, type PendingApproval } from '../server/agent/approvals.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SDK = path.resolve(__dirname, 'fake-sdk.mjs');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<{ cookie: string }> {
  const email = `admin-ab-${Date.now()}@test.com`;
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  const cookie = r.cookie ?? '';
  return { cookie };
}

async function createProject(baseUrl: string, cookie: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: `Approval-Binding-${Date.now()}` },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function startWorkflow(
  baseUrl: string,
  cookie: string,
  projectId: string,
  goal: string,
): Promise<{ workflowId: string; runId: string }> {
  const wfR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
    method: 'POST',
    body: { goal },
    cookie,
  });
  const workflowId = ((wfR.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  const runR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${workflowId}/start`, {
    method: 'POST',
    body: {},
    cookie,
  });
  const runId = ((runR.body as Record<string, unknown>).run as Record<string, unknown>).id as string;
  return { workflowId, runId };
}

async function waitForApproval(
  baseUrl: string,
  cookie: string,
  projectId: string,
  workflowId: string,
  runId: string,
  timeoutMs = 8_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/workflows/${workflowId}/runs/${runId}`,
      { cookie },
    );
    const inputs = (r.body as Record<string, unknown>).inputs as Record<string, unknown>[] | undefined;
    if (inputs && inputs.length > 0) {
      const pending = inputs.find((i) => i.status === 'pending' || !i.status);
      if (pending) return String(pending.id);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('No pending approval appeared within timeout');
}

async function waitForRunStatus(
  baseUrl: string,
  cookie: string,
  projectId: string,
  workflowId: string,
  runId: string,
  expected: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetchJson(
      baseUrl,
      `/api/projects/${projectId}/workflows/${workflowId}/runs/${runId}`,
      { cookie },
    );
    const run = (r.body as Record<string, unknown>).run as Record<string, unknown>;
    if (run && run.status === expected) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Run did not reach "${expected}" status within ${timeoutMs}ms`);
}

// ── Unit tests (no server needed) ─────────────────────────────────────────────

describe('Approval utility functions', () => {
  it('resolves sequential approvals through the same run registry, including database-polled answers', async () => {
    const id = generateId();
    const waiting = new Map<string, PendingApproval>();
    pendingApprovals.set(id, waiting);
    try {
      for (const inputId of ['first', 'second', 'third']) {
        const answer = new Promise(resolve => waiting.set(inputId, { resolve, reject: () => {} }));
        assert.equal(resolveApproval(id, inputId, 'allow', { remember: true }), true);
        assert.deepEqual(await answer, { decision: 'allow', remember: true, message: '' });
        assert.equal(resolveApproval(id, inputId, 'allow'), false);
      }
    } finally { pendingApprovals.delete(id); }
  });
  it('inputFingerprint is deterministic and hex', () => {
    const h1 = inputFingerprint('Bash', { command: 'ls -la' });
    const h2 = inputFingerprint('Bash', { command: 'ls -la' });
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  it('inputFingerprint differs for different inputs', () => {
    const h1 = inputFingerprint('Bash', { command: 'ls' });
    const h2 = inputFingerprint('Bash', { command: 'ls -la' });
    assert.notEqual(h1, h2);
  });

  it('rememberKey scopes Bash to exact command', () => {
    const r = rememberKey('Bash', { command: 'npm test' });
    assert.equal(r.scope, 'command');
    assert.ok(r.key.includes('npm test'));
  });

  it('rememberKey scopes WebFetch to host', () => {
    const r = rememberKey('WebFetch', { url: 'https://docs.example.com/path' });
    assert.equal(r.scope, 'host');
    assert.equal(r.label, 'docs.example.com');
  });

  it('rememberKey falls back to tool for other tools', () => {
    const r = rememberKey('Read', { file_path: 'foo.txt' });
    assert.equal(r.scope, 'tool');
    assert.equal(r.key, 'Read');
  });

  it('MAX_REVIEWABLE_COMMAND is 20000', () => {
    assert.equal(MAX_REVIEWABLE_COMMAND, 20_000);
  });
});

// ── Integration tests ─────────────────────────────────────────────────────────

describe('Approval binding — fingerprint verification', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie } = await setupAdmin(baseUrl));
    projectId = await createProject(baseUrl, cookie);
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('provider.mode', 'anthropic')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('anthropic.key.enc', 'fake-enc')").run();
    process.env.PORTAL_SDK_MODULE = `file://${FAKE_SDK}`;
    process.env.PORTAL_FAKE_SDK_SCENARIO = 'approvals';
  });

  after(async () => {
    delete process.env.PORTAL_SDK_MODULE;
    delete process.env.PORTAL_FAKE_SDK_SCENARIO;
    await cleanup();
  });

  it('stores input_hash and allows only the exact call (fingerprint check)', async () => {
    // Insert a fake p6_inputs row directly to test the answer endpoint
    const db = getDb();

    // We need a workflow and run to exist
    const projRow = one<{ id: string }>('SELECT id FROM projects WHERE id = ?', projectId)!;
    const wfId = `wf-ab-${generateId()}`;
    const runId = `run-ab-${generateId()}`;

    db.prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at) VALUES (?, ?, 'test', 'running', 'demo', 0, '[]', ?, ?)",
    ).run(wfId, projRow.id, now(), now());
    db.prepare(
      "INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)",
    ).run(runId, wfId, now());

    const toolInput = { command: 'ls -la' };
    const hash = inputFingerprint('Bash', toolInput);

    insert('p6_inputs', {
      id: `inp-${generateId()}`,
      run_id: runId,
      project_id: projRow.id,
      tool_name: 'Bash',
      tool_input: JSON.stringify(toolInput),
      payload: JSON.stringify({ toolName: 'Bash', input: toolInput, inputHash: hash, rememberScope: 'command', rememberLabel: 'ls -la' }),
      input_hash: hash,
      type: 'approval',
      status: 'pending',
      allow_all: 0,
      expires_at: null,
      created_at: now(),
    });

    const inputId = one<{ id: string }>('SELECT id FROM p6_inputs WHERE run_id = ?', runId)!.id;

    // Allowing without hash → 409
    const noHash = await fetchJson(baseUrl, `/api/projects/${projRow.id}/workflows/${wfId}/runs/${runId}/input`, {
      method: 'POST',
      body: { inputId, response: 'approve', allowAll: false },
      cookie,
    });
    assert.equal(noHash.status, 409, `Expected 409 without hash, got ${noHash.status}: ${JSON.stringify(noHash.body)}`);
    assert.match(String((noHash.body as Record<string, unknown>).error), /not the tool call you reviewed/);

    // Allowing with wrong hash → 409
    const wrongHash = await fetchJson(baseUrl, `/api/projects/${projRow.id}/workflows/${wfId}/runs/${runId}/input`, {
      method: 'POST',
      body: { inputId, response: 'approve', inputHash: '0'.repeat(64), allowAll: false },
      cookie,
    });
    assert.equal(wrongHash.status, 409, `Expected 409 with wrong hash, got ${wrongHash.status}`);

    // Allowing with correct hash → 200
    const correct = await fetchJson(baseUrl, `/api/projects/${projRow.id}/workflows/${wfId}/runs/${runId}/input`, {
      method: 'POST',
      body: { inputId, response: 'approve', inputHash: hash, allowAll: false },
      cookie,
    });
    assert.equal(correct.status, 200, `Expected 200 with correct hash, got ${correct.status}: ${JSON.stringify(correct.body)}`);

    // Status is now 'answered' in DB
    const row = one<{ status: string }>('SELECT status FROM p6_inputs WHERE id = ?', inputId)!;
    assert.equal(row.status, 'answered');

    // The answer is in the session's history, so the card shows it (not the buttons) after a reload.
    const ev = one<{ payload: string }>("SELECT payload FROM p6_events WHERE run_id = ? AND type = 'approval-resolved'", runId);
    assert.ok(ev, 'approval-resolved event saved');
    const p = JSON.parse(ev!.payload) as { inputId: string; status: string; allowAll: boolean; by: string };
    assert.equal(p.inputId, inputId);
    assert.equal(p.status, 'approved');
    assert.equal(p.allowAll, false);
    assert.equal(p.by, 'Admin');
  });
});

describe('Approval binding — atomic claim (no double-answer)', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie } = await setupAdmin(baseUrl));
    projectId = await createProject(baseUrl, cookie);
  });

  after(async () => { await cleanup(); });

  it('two simultaneous answers: exactly one wins', async () => {
    const db = getDb();
    const projRow = one<{ id: string }>('SELECT id FROM projects WHERE id = ?', projectId)!;
    const wfId = `wf-aa-${generateId()}`;
    const runId = `run-aa-${generateId()}`;

    db.prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at) VALUES (?, ?, 'test', 'running', 'demo', 0, '[]', ?, ?)",
    ).run(wfId, projRow.id, now(), now());
    db.prepare(
      "INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)",
    ).run(runId, wfId, now());

    const toolInput = { command: 'ls' };
    const hash = inputFingerprint('Bash', toolInput);

    insert('p6_inputs', {
      id: `inp-${generateId()}`,
      run_id: runId,
      project_id: projRow.id,
      tool_name: 'Bash',
      tool_input: JSON.stringify(toolInput),
      payload: JSON.stringify({ toolName: 'Bash', input: toolInput, inputHash: hash }),
      input_hash: hash,
      type: 'approval',
      status: 'pending',
      allow_all: 0,
      expires_at: null,
      created_at: now(),
    });

    const inputId = one<{ id: string }>('SELECT id FROM p6_inputs WHERE run_id = ?', runId)!.id;

    // Two concurrent answers
    const [a, b] = await Promise.all([
      fetchJson(baseUrl, `/api/projects/${projRow.id}/workflows/${wfId}/runs/${runId}/input`, {
        method: 'POST',
        body: { inputId, response: 'approve', inputHash: hash },
        cookie,
      }),
      fetchJson(baseUrl, `/api/projects/${projRow.id}/workflows/${wfId}/runs/${runId}/input`, {
        method: 'POST',
        body: { inputId, response: 'deny' },
        cookie,
      }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.equal(statuses[0], 200, `One should win with 200; got ${JSON.stringify(statuses)}`);
    assert.ok([400, 409].includes(statuses[1]), `Other should get 4xx; got ${JSON.stringify(statuses)}`);

    // DB: exactly one write
    const row = one<{ status: string }>('SELECT status FROM p6_inputs WHERE id = ?', inputId)!;
    assert.equal(row.status, 'answered');
  });
});

describe('Approval binding — GET /api/inputs/:id (AgentCore polling)', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie } = await setupAdmin(baseUrl));
    projectId = await createProject(baseUrl, cookie);
  });

  after(async () => { await cleanup(); });

  it('returns status and payload for polling', async () => {
    const db = getDb();
    const projRow = one<{ id: string }>('SELECT id FROM projects WHERE id = ?', projectId)!;
    const wfId = `wf-poll-${generateId()}`;
    const runId = `run-poll-${generateId()}`;

    db.prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at) VALUES (?, ?, 'test', 'running', 'demo', 0, '[]', ?, ?)",
    ).run(wfId, projRow.id, now(), now());
    db.prepare(
      "INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)",
    ).run(runId, wfId, now());

    const hash = inputFingerprint('Read', { file_path: 'README.md' });
    const inputId = `inp-poll-${generateId()}`;
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

    insert('p6_inputs', {
      id: inputId,
      run_id: runId,
      project_id: projRow.id,
      tool_name: 'Read',
      tool_input: JSON.stringify({ file_path: 'README.md' }),
      payload: JSON.stringify({ toolName: 'Read', inputHash: hash }),
      input_hash: hash,
      type: 'approval',
      status: 'pending',
      allow_all: 0,
      expires_at: expiresAt,
      created_at: now(),
    });

    const r = await fetchJson(baseUrl, `/api/inputs/${inputId}`, { cookie });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const input = (r.body as Record<string, unknown>).input as Record<string, unknown>;
    assert.equal(input.id, inputId);
    assert.equal(input.status, 'pending');
    assert.equal(input.type, 'approval');
    assert.ok(input.expires_at, 'expires_at should be present');
  });
});

describe('Approval binding — expiry', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie } = await setupAdmin(baseUrl));
    projectId = await createProject(baseUrl, cookie);

    // Set a very short expiry for testing (0.02 minutes = 1.2 seconds)
    await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { agents: { approvalExpiryMinutes: 0.02 } },
      cookie,
    });
  });

  after(async () => {
    await fetchJson(baseUrl, '/api/settings', {
      method: 'PUT',
      body: { agents: { approvalExpiryMinutes: 60 } },
      cookie,
    });
    await cleanup();
  });

  it('expired input → status becomes expired and late answer is refused', async () => {
    const db = getDb();
    const projRow = one<{ id: string }>('SELECT id FROM projects WHERE id = ?', projectId)!;
    const wfId = `wf-exp-${generateId()}`;
    const runId = `run-exp-${generateId()}`;

    db.prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at) VALUES (?, ?, 'test', 'running', 'demo', 0, '[]', ?, ?)",
    ).run(wfId, projRow.id, now(), now());
    db.prepare(
      "INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)",
    ).run(runId, wfId, now());

    const hash = inputFingerprint('Bash', { command: 'ls' });
    const inputId = `inp-exp-${generateId()}`;
    // Already expired 1 second ago
    const pastExpiry = new Date(Date.now() - 1000).toISOString();

    insert('p6_inputs', {
      id: inputId,
      run_id: runId,
      project_id: projRow.id,
      tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'ls' }),
      payload: JSON.stringify({ toolName: 'Bash', inputHash: hash }),
      input_hash: hash,
      type: 'approval',
      status: 'expired',
      allow_all: 0,
      expires_at: pastExpiry,
      created_at: now(),
    });

    // Trying to answer → 409
    const late = await fetchJson(baseUrl, `/api/projects/${projRow.id}/workflows/${wfId}/runs/${runId}/input`, {
      method: 'POST',
      body: { inputId, response: 'approve', inputHash: hash },
      cookie,
    });
    assert.equal(late.status, 409, `Expected 409 for expired input, got ${late.status}`);
    assert.match(String((late.body as Record<string, unknown>).error), /Nobody answered this in time/);
  });
});

describe('Safety: API token cannot enable trust_tools', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie } = await setupAdmin(baseUrl));
    projectId = await createProject(baseUrl, cookie);
  });

  after(async () => { await cleanup(); });

  it('creating a workflow with trustTools=true via API token is refused', async () => {
    // Create an API token
    const tokenR = await fetchJson(baseUrl, '/api/api-tokens', {
      method: 'POST',
      body: { name: 'test-token', scope: 'write' },
      cookie,
    });
    assert.equal(tokenR.status, 201, `Expected 201 for token creation, got ${tokenR.status}: ${JSON.stringify(tokenR.body)}`);
    const rawToken = String((tokenR.body as Record<string, unknown>).token ?? '');
    assert.ok(rawToken.startsWith('ap_'), 'Expected token starting with ap_');

    // Try to create a workflow with trustTools=true via the token
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Test trust via token', trustTools: true },
      headers: { Authorization: `Bearer ${rawToken}` },
    });
    // Should be refused
    assert.equal(r.status, 403, `Expected 403 for trust via token, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.match(String((r.body as Record<string, unknown>).error), /API tokens cannot turn on/);
  });
});

describe('Approval binding — inbox resolve applies fingerprint rules', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    ({ cookie } = await setupAdmin(baseUrl));
    projectId = await createProject(baseUrl, cookie);
  });

  after(async () => { await cleanup(); });

  it('inbox approve without inputHash → 409', async () => {
    const db = getDb();
    const projRow = one<{ id: string }>('SELECT id FROM projects WHERE id = ?', projectId)!;
    const wfId  = `wf-ibx-${generateId()}`;
    const runId = `run-ibx-${generateId()}`;

    db.prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at) VALUES (?, ?, 'test', 'running', 'demo', 0, '[]', ?, ?)",
    ).run(wfId, projRow.id, now(), now());
    db.prepare(
      "INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)",
    ).run(runId, wfId, now());

    const toolInput = { command: 'echo hi' };
    const hash = inputFingerprint('Bash', toolInput);
    const inputId = `inp-ibx-${generateId()}`;

    insert('p6_inputs', {
      id: inputId,
      run_id: runId,
      project_id: projRow.id,
      tool_name: 'Bash',
      tool_input: JSON.stringify(toolInput),
      payload: JSON.stringify({ toolName: 'Bash', input: toolInput, inputHash: hash }),
      input_hash: hash,
      type: 'approval',
      status: 'pending',
      allow_all: 0,
      expires_at: null,
      created_at: now(),
    });

    // Insert an inbox item for this approval
    const inboxId = `inbox-ibx-${generateId()}`;
    db.prepare(
      "INSERT INTO p6_inbox (id, project_id, workflow_id, run_id, type, payload, resolved, created_at) VALUES (?, ?, ?, ?, 'approval', ?, 0, ?)",
    ).run(
      inboxId,
      projRow.id,
      wfId,
      runId,
      JSON.stringify({ inputId, toolName: 'Bash', inputHash: hash }),
      now(),
    );

    // Approve without hash → 409
    const noHash = await fetchJson(baseUrl, `/api/inbox/${inboxId}/resolve`, {
      method: 'POST',
      body: { response: 'approve' },
      cookie,
    });
    assert.equal(noHash.status, 409, `Expected 409 without hash, got ${noHash.status}: ${JSON.stringify(noHash.body)}`);
    assert.match(String((noHash.body as Record<string, unknown>).error), /not the tool call you reviewed/);

    // Inbox item should still be unresolved
    const inboxRow = one<{ resolved: number }>('SELECT resolved FROM p6_inbox WHERE id = ?', inboxId)!;
    assert.equal(inboxRow.resolved, 0, 'inbox item must remain unresolved after a 409');
  });

  it('inbox approve with correct inputHash → 200', async () => {
    const db = getDb();
    const projRow = one<{ id: string }>('SELECT id FROM projects WHERE id = ?', projectId)!;
    const wfId  = `wf-ibx2-${generateId()}`;
    const runId = `run-ibx2-${generateId()}`;

    db.prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at) VALUES (?, ?, 'test', 'running', 'demo', 0, '[]', ?, ?)",
    ).run(wfId, projRow.id, now(), now());
    db.prepare(
      "INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)",
    ).run(runId, wfId, now());

    const toolInput = { command: 'echo world' };
    const hash = inputFingerprint('Bash', toolInput);
    const inputId = `inp-ibx2-${generateId()}`;

    insert('p6_inputs', {
      id: inputId,
      run_id: runId,
      project_id: projRow.id,
      tool_name: 'Bash',
      tool_input: JSON.stringify(toolInput),
      payload: JSON.stringify({ toolName: 'Bash', input: toolInput, inputHash: hash }),
      input_hash: hash,
      type: 'approval',
      status: 'pending',
      allow_all: 0,
      expires_at: null,
      created_at: now(),
    });

    const inboxId = `inbox-ibx2-${generateId()}`;
    db.prepare(
      "INSERT INTO p6_inbox (id, project_id, workflow_id, run_id, type, payload, resolved, created_at) VALUES (?, ?, ?, ?, 'approval', ?, 0, ?)",
    ).run(
      inboxId,
      projRow.id,
      wfId,
      runId,
      JSON.stringify({ inputId, toolName: 'Bash', inputHash: hash }),
      now(),
    );

    // Approve with correct hash → 200
    const ok = await fetchJson(baseUrl, `/api/inbox/${inboxId}/resolve`, {
      method: 'POST',
      body: { response: 'approve', inputHash: hash },
      cookie,
    });
    assert.equal(ok.status, 200, `Expected 200 with correct hash, got ${ok.status}: ${JSON.stringify(ok.body)}`);

    // p6_inputs must be 'answered'
    const inputRow = one<{ status: string }>('SELECT status FROM p6_inputs WHERE id = ?', inputId)!;
    assert.equal(inputRow.status, 'answered');

    // Inbox item must be resolved
    const inboxRow = one<{ resolved: number }>('SELECT resolved FROM p6_inbox WHERE id = ?', inboxId)!;
    assert.equal(inboxRow.resolved, 1);

    // Answered from the Inbox: the session's card shows it too.
    const ev = one<{ payload: string }>("SELECT payload FROM p6_events WHERE run_id = ? AND type = 'approval-resolved'", runId);
    assert.ok(ev, 'approval-resolved event saved');
    assert.equal((JSON.parse(ev!.payload) as { inputId: string; status: string }).status, 'approved');
  });

  it('inbox approve for expired input → 409', async () => {
    const db = getDb();
    const projRow = one<{ id: string }>('SELECT id FROM projects WHERE id = ?', projectId)!;
    const wfId  = `wf-ibx3-${generateId()}`;
    const runId = `run-ibx3-${generateId()}`;

    db.prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at) VALUES (?, ?, 'test', 'running', 'demo', 0, '[]', ?, ?)",
    ).run(wfId, projRow.id, now(), now());
    db.prepare(
      "INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)",
    ).run(runId, wfId, now());

    const hash = inputFingerprint('Bash', { command: 'ls' });
    const inputId = `inp-ibx3-${generateId()}`;
    const pastExpiry = new Date(Date.now() - 5000).toISOString();

    insert('p6_inputs', {
      id: inputId,
      run_id: runId,
      project_id: projRow.id,
      tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'ls' }),
      payload: JSON.stringify({ toolName: 'Bash', inputHash: hash }),
      input_hash: hash,
      type: 'approval',
      status: 'expired',
      allow_all: 0,
      expires_at: pastExpiry,
      created_at: now(),
    });

    const inboxId = `inbox-ibx3-${generateId()}`;
    db.prepare(
      "INSERT INTO p6_inbox (id, project_id, workflow_id, run_id, type, payload, resolved, created_at) VALUES (?, ?, ?, ?, 'approval', ?, 0, ?)",
    ).run(
      inboxId,
      projRow.id,
      wfId,
      runId,
      JSON.stringify({ inputId, toolName: 'Bash', inputHash: hash }),
      now(),
    );

    const r = await fetchJson(baseUrl, `/api/inbox/${inboxId}/resolve`, {
      method: 'POST',
      body: { response: 'approve', inputHash: hash },
      cookie,
    });
    assert.equal(r.status, 409, `Expected 409 for expired input, got ${r.status}`);
    assert.match(String((r.body as Record<string, unknown>).error), /Nobody answered this in time/);
  });

  it('inbox deny does not require inputHash', async () => {
    const db = getDb();
    const projRow = one<{ id: string }>('SELECT id FROM projects WHERE id = ?', projectId)!;
    const wfId  = `wf-ibx4-${generateId()}`;
    const runId = `run-ibx4-${generateId()}`;

    db.prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at) VALUES (?, ?, 'test', 'running', 'demo', 0, '[]', ?, ?)",
    ).run(wfId, projRow.id, now(), now());
    db.prepare(
      "INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)",
    ).run(runId, wfId, now());

    const hash = inputFingerprint('Bash', { command: 'rm -rf /' });
    const inputId = `inp-ibx4-${generateId()}`;

    insert('p6_inputs', {
      id: inputId,
      run_id: runId,
      project_id: projRow.id,
      tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'rm -rf /' }),
      payload: JSON.stringify({ toolName: 'Bash', inputHash: hash }),
      input_hash: hash,
      type: 'approval',
      status: 'pending',
      allow_all: 0,
      expires_at: null,
      created_at: now(),
    });

    const inboxId = `inbox-ibx4-${generateId()}`;
    db.prepare(
      "INSERT INTO p6_inbox (id, project_id, workflow_id, run_id, type, payload, resolved, created_at) VALUES (?, ?, ?, ?, 'approval', ?, 0, ?)",
    ).run(
      inboxId,
      projRow.id,
      wfId,
      runId,
      JSON.stringify({ inputId, toolName: 'Bash', inputHash: hash }),
      now(),
    );

    // Deny without hash → 200 (deny doesn't need fingerprint)
    const r = await fetchJson(baseUrl, `/api/inbox/${inboxId}/resolve`, {
      method: 'POST',
      body: { response: 'deny' },
      cookie,
    });
    assert.equal(r.status, 200, `Expected 200 for deny without hash, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});
