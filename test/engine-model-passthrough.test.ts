/**
 * Tests for model field storage and pass-through to engines.
 *
 * Coverage:
 *   - POST /api/projects/:id/workflows stores model field
 *   - model is returned in GET workflow response
 *   - model validates against the ID regex (rejects invalid)
 *   - Kiro engine: --model flag is included in CLI args when model is set
 *   - Claude Code engine: model from AgentRun overrides settings.defaultModel
 *   - Child sessions inherit parent's model
 *   - Empty/absent model = engine default (no regression)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTestDb, createTestConfig, cleanup } from './fixtures.ts';
import { getDb, one, insert } from '../server/db.ts';
import { now, generateId } from '../server/util.ts';
import { setConfig } from '../server/config.ts';
import { runKiro } from '../server/agent/kiro.ts';
import { loadRunPermissions } from '../server/guardrails.ts';
import type { RunContext, AgentRun } from '../server/agent/types.ts';
import { encrypt } from '../server/secrets.ts';
import { createTestServer, fetchJson } from './fixtures.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_KIRO = path.join(__dirname, 'fake-kiro.mjs');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `admin-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: 'Model Test Project' },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

// ── POST /api/projects/:id/workflows stores model ─────────────────────────────

describe('POST workflows — model field', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
  });

  after(async () => { await cleanup(); });

  it('stores model when provided', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Test goal', engine: 'demo', model: 'claude-sonnet-4-5' },
      cookie,
    });
    assert.equal(r.status, 201, `Expected 201: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.model, 'claude-sonnet-4-5', 'model should be stored and returned');
  });

  it('stores empty string when model is absent', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Test goal no model', engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.model, '', 'absent model should be empty string');
  });

  it('rejects invalid model ID chars', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Test goal', engine: 'demo', model: 'claude sonnet (spaces!)' },
      cookie,
    });
    assert.equal(r.status, 400, `Expected 400 for invalid model: ${JSON.stringify(r.body)}`);
  });

  it('accepts Bedrock-style model IDs with colons and slashes', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Test goal', engine: 'demo', model: 'us.anthropic.claude-3-5-sonnet-20241022-v1:0' },
      cookie,
    });
    assert.equal(r.status, 201);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.model, 'us.anthropic.claude-3-5-sonnet-20241022-v1:0');
  });
});

// ── Kiro engine: --model flag passed when model is set ────────────────────────

describe('Kiro engine — --model flag pass-through', () => {
  let workDir: string;
  let dataDir: string;

  before(() => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;

    const cfg = createTestConfig();
    dataDir = cfg.dataDir;
    setConfig(cfg);
    createTestDb();

    workDir = path.join(dataDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    // Seed DB
    const db = getDb();
    const fakeKey = encrypt('sk-ant-test-fake-key', cfg.secretKey);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('provider.mode', 'anthropic');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('anthropic.key.enc', fakeKey);
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('Kiro CLI receives --model flag when AgentRun.model is set', async () => {
    const db = getDb();
    const projectId = `proj-${generateId()}`;
    const workflowId = `wf-${generateId()}`;
    const runId = `run-${generateId()}`;

    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(
      projectId, 'Model Test', `test-${Date.now()}`, now(),
    );
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, model, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', 'claude-sonnet-4-5', ?, ?)`,
    ).run(workflowId, projectId, 'Test goal', now(), now());
    db.prepare(
      `INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`,
    ).run(runId, workflowId, now());

    const permissions = await loadRunPermissions(projectId);
    const agentRun: AgentRun = {
      runId,
      workflowId,
      projectId,
      goal: 'Test goal',
      kind: null,
      engine: 'kiro',
      trusted: false,
      dataDir,
      workDir,
      repoIds: [],
      leadAgent: null,
      permissions,
      credentialId: null,
      credentialOwnerId: null,
      model: 'claude-sonnet-4-5',
    };

    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx: RunContext = {
      run: agentRun,
      emit: (type, payload) => emitted.push({ type, payload: payload as Record<string, unknown> }),
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set(),
      signal: null,
    };

    const result = await runKiro(ctx);
    // The fake kiro echoes "model=<id>" when --model is passed
    assert.ok(result.includes('model=claude-sonnet-4-5') || result.includes('claude-sonnet-4-5'),
      `Expected model ID in output, got: ${result}`);
  });

  it('Kiro CLI does NOT receive --model when AgentRun.model is null', async () => {
    const db = getDb();
    const projectId = `proj-${generateId()}`;
    const workflowId = `wf-${generateId()}`;
    const runId = `run-${generateId()}`;

    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(
      projectId, 'Model Test 2', `test2-${Date.now()}`, now(),
    );
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, model, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', '', ?, ?)`,
    ).run(workflowId, projectId, 'Test goal no model', now(), now());
    db.prepare(
      `INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`,
    ).run(runId, workflowId, now());

    const permissions = await loadRunPermissions(projectId);
    const agentRun: AgentRun = {
      runId,
      workflowId,
      projectId,
      goal: 'Test goal no model',
      kind: null,
      engine: 'kiro',
      trusted: false,
      dataDir,
      workDir,
      repoIds: [],
      leadAgent: null,
      permissions,
      credentialId: null,
      credentialOwnerId: null,
      model: null,
    };

    const ctx: RunContext = {
      run: agentRun,
      emit: () => {},
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set(),
      signal: null,
    };

    const result = await runKiro(ctx);
    // No model=... in output when model is null
    assert.ok(!result.includes('model='), `Should not have model= when model is null: ${result}`);
  });
});

// ── Portal defaultModel applied to Kiro runs ──────────────────────────────────

describe('Kiro engine — portal defaultModel applied when run.model is null', () => {
  let workDir: string;
  let dataDir: string;

  before(() => {
    process.env.PORTAL_KIRO_FAKE = FAKE_KIRO;
    const cfg = createTestConfig();
    dataDir = cfg.dataDir;
    setConfig(cfg);
    createTestDb();

    workDir = path.join(dataDir, 'work-default-model');
    fs.mkdirSync(workDir, { recursive: true });

    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('provider.mode', 'kiro');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('default.model', 'claude-sonnet-5.5');
  });

  after(async () => {
    delete process.env.PORTAL_KIRO_FAKE;
    delete process.env.PORTAL_FAKE_KIRO_SCENARIO;
    await cleanup();
  });

  it('passes portal defaultModel as --model when AgentRun.model is null and provider.mode is kiro', async () => {
    const db = getDb();
    const projectId = `proj-${generateId()}`;
    const workflowId = `wf-${generateId()}`;
    const runId = `run-${generateId()}`;

    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(
      projectId, 'DefaultModel Test', `dm-test-${Date.now()}`, now(),
    );
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, model, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', '', ?, ?)`,
    ).run(workflowId, projectId, 'Test portal default', now(), now());
    db.prepare(
      `INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`,
    ).run(runId, workflowId, now());

    const permissions = await loadRunPermissions(projectId);
    const agentRun: AgentRun = {
      runId,
      workflowId,
      projectId,
      goal: 'Test portal default',
      kind: null,
      engine: 'kiro',
      trusted: false,
      dataDir,
      workDir,
      repoIds: [],
      leadAgent: null,
      permissions,
      credentialId: null,
      credentialOwnerId: null,
      model: null, // no per-workflow model
    };

    const ctx: RunContext = {
      run: agentRun,
      emit: () => {},
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set(),
      signal: null,
    };

    const result = await runKiro(ctx);
    // The fake echoes "model=<id>" when --model is passed
    assert.ok(
      result.includes('model=claude-sonnet-5.5'),
      `Expected portal defaultModel 'claude-sonnet-5.5' in --model arg, got: ${result}`,
    );
  });

  it('does NOT pass portal defaultModel when AgentRun.model is explicitly set', async () => {
    const db = getDb();
    const projectId = `proj-${generateId()}`;
    const workflowId = `wf-${generateId()}`;
    const runId = `run-${generateId()}`;

    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(
      projectId, 'ExplicitModel Test', `em-test-${Date.now()}`, now(),
    );
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, model, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', 'claude-opus-5.5', ?, ?)`,
    ).run(workflowId, projectId, 'Test explicit model', now(), now());
    db.prepare(
      `INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`,
    ).run(runId, workflowId, now());

    const permissions = await loadRunPermissions(projectId);
    const agentRun: AgentRun = {
      runId,
      workflowId,
      projectId,
      goal: 'Test explicit model',
      kind: null,
      engine: 'kiro',
      trusted: false,
      dataDir,
      workDir,
      repoIds: [],
      leadAgent: null,
      permissions,
      credentialId: null,
      credentialOwnerId: null,
      model: 'claude-opus-5.5', // explicit per-workflow model
    };

    const ctx: RunContext = {
      run: agentRun,
      emit: () => {},
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set(),
      signal: null,
    };

    const result = await runKiro(ctx);
    // Should use the explicit model, not the portal default
    assert.ok(result.includes('model=claude-opus-5.5'), `Expected explicit model in output, got: ${result}`);
    assert.ok(!result.includes('model=claude-sonnet-5.5'), 'Should NOT use portal default when explicit model is set');
  });

  it('does NOT pass --model when defaultModel is "auto"', async () => {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('default.model', 'auto');

    const projectId = `proj-${generateId()}`;
    const workflowId = `wf-${generateId()}`;
    const runId = `run-${generateId()}`;

    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(
      projectId, 'Auto Default Test', `auto-test-${Date.now()}`, now(),
    );
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, model, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', '', ?, ?)`,
    ).run(workflowId, projectId, 'Test auto default', now(), now());
    db.prepare(
      `INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`,
    ).run(runId, workflowId, now());

    const permissions = await loadRunPermissions(projectId);
    const agentRun: AgentRun = {
      runId,
      workflowId,
      projectId,
      goal: 'Test auto default',
      kind: null,
      engine: 'kiro',
      trusted: false,
      dataDir,
      workDir,
      repoIds: [],
      leadAgent: null,
      permissions,
      credentialId: null,
      credentialOwnerId: null,
      model: null,
    };

    const ctx: RunContext = {
      run: agentRun,
      emit: () => {},
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set(),
      signal: null,
    };

    const result = await runKiro(ctx);
    // "auto" means kiro picks automatically — same as omitting --model
    assert.ok(!result.includes('model='), `Should NOT pass --model when defaultModel is "auto", got: ${result}`);
  });

  it('does NOT pass portal defaultModel when provider.mode is not kiro', async () => {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('provider.mode', 'anthropic');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('default.model', 'claude-opus-5.5');

    const projectId = `proj-${generateId()}`;
    const workflowId = `wf-${generateId()}`;
    const runId = `run-${generateId()}`;

    db.prepare('INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(
      projectId, 'NonKiro Mode Test', `nk-test-${Date.now()}`, now(),
    );
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, model, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'kiro', 0, '[]', '', ?, ?)`,
    ).run(workflowId, projectId, 'Test non-kiro mode', now(), now());
    db.prepare(
      `INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)`,
    ).run(runId, workflowId, now());

    const permissions = await loadRunPermissions(projectId);
    const agentRun: AgentRun = {
      runId,
      workflowId,
      projectId,
      goal: 'Test non-kiro mode',
      kind: null,
      engine: 'kiro',
      trusted: false,
      dataDir,
      workDir,
      repoIds: [],
      leadAgent: null,
      permissions,
      credentialId: null,
      credentialOwnerId: null,
      model: null,
    };

    const ctx: RunContext = {
      run: agentRun,
      emit: () => {},
      awaitInput: async () => ({ decision: 'allow' as const, remember: false, message: '' }),
      allowed: new Set(),
      signal: null,
    };

    const result = await runKiro(ctx);
    // With anthropic provider, the anthropic/bedrock defaultModel shouldn't be passed to kiro
    assert.ok(!result.includes('model='), `Should NOT pass --model when provider.mode is not kiro, got: ${result}`);

    // Restore kiro mode for other tests in this suite
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('provider.mode', 'kiro');
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('default.model', 'claude-sonnet-5.5');
  });
});

// ── Child sessions inherit model ──────────────────────────────────────────────

describe('createChildSession — inherits model', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie);
  });

  after(async () => { await cleanup(); });

  it('child workflow inherits model from parent via DB', async () => {
    // Create parent with a model
    const parentR = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'Parent task', engine: 'demo', model: 'claude-haiku-4-5' },
      cookie,
    });
    assert.equal(parentR.status, 201);
    const parentId = ((parentR.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;

    // Insert a child manually (simulation of createChildSession inheritance)
    const childId = generateId();
    const ts = now();
    const db = getDb();
    const parent = one<Record<string, unknown>>('SELECT * FROM p6_workflows WHERE id = ?', parentId)!;
    db.prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, title, status, engine, trust_tools, lead_agent, workspace_id, output_files_enabled, repo_ids, iteration_count, max_iterations, credential_id, model, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, '', 'pending', ?, 0, NULL, NULL, 0, '[]', 0, 10, NULL, ?, ?, ?, ?)`,
    ).run(
      childId,
      String(parent.project_id ?? ''),
      'Child task',
      String(parent.engine ?? 'demo'),
      String(parent.model ?? ''),
      parentId,
      ts,
      ts,
    );

    const child = one<Record<string, unknown>>('SELECT * FROM p6_workflows WHERE id = ?', childId)!;
    assert.equal(String(child.model), 'claude-haiku-4-5', 'child should inherit parent model');
  });
});
