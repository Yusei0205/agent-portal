/**
 * Workspace tests — CRUD for the three default fields and
 * session-creation fallback (workspace defaults → project defaults → built-in).
 *
 * Tests:
 *   Workspace CRUD:
 *     - POST creates workspace; GET returns default_engine/default_agent/default_model
 *     - POST round-trips all three fields
 *     - PUT sets the three fields
 *     - PUT with '' clears each field
 *     - PUT with missing field leaves it unchanged
 *     - Validation: invalid defaultEngine → 400
 *     - Validation: defaultAgent too long → 400
 *     - Validation: invalid defaultModel characters → 400
 *
 *   Session creation defaults:
 *     - Session with workspace picks up default_engine
 *     - Session with workspace picks up default_agent
 *     - Session with workspace picks up default_model
 *     - Explicit engine in request overrides workspace default
 *     - Explicit leadAgent in request overrides workspace default
 *     - Explicit model in request overrides workspace default
 *     - Session without workspace is unaffected (still uses built-in defaults)
 *     - Project-level default_lead_agent fills in when workspace has no default_agent
 *     - Project-level default_model fills in when workspace has no default_model
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { run as dbRun } from '../server/db.ts';

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: {
      email: `ws-admin-${Date.now()}@example.com`,
      name: 'Admin',
      password: 'password1234',
      provider: 'demo',
    },
  });
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string, name: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createWorkspace(
  baseUrl: string,
  cookie: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces`, {
    method: 'POST',
    body,
    cookie,
  });
  assert.equal(r.status, 201, `createWorkspace failed: ${JSON.stringify(r.body)}`);
  return (r.body as Record<string, unknown>).workspace as Record<string, unknown>;
}

// ── Workspace CRUD ─────────────────────────────────────────────────────────────

describe('Workspace default fields — POST and GET', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'WS Defaults CRUD');
  });

  after(async () => { await cleanup(); });

  it('POST without default fields returns empty strings for all three', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, { name: 'NoDefaults' });
    assert.equal(ws.default_engine, '', 'default_engine should be empty');
    assert.equal(ws.default_agent, '', 'default_agent should be empty');
    assert.equal(ws.default_model, '', 'default_model should be empty');
  });

  it('POST round-trips all three default fields', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'WithDefaults',
      defaultEngine: 'kiro',
      defaultAgent: 'my-custom-agent',
      defaultModel: 'us.amazon.nova-pro-v1:0',
    });
    assert.equal(ws.default_engine, 'kiro');
    assert.equal(ws.default_agent, 'my-custom-agent');
    assert.equal(ws.default_model, 'us.amazon.nova-pro-v1:0');
  });

  it('GET /workspaces returns the default fields', async () => {
    await createWorkspace(baseUrl, cookie, projectId, {
      name: 'ListTest',
      defaultEngine: 'claude-code',
      defaultAgent: 'my-agent',
      defaultModel: 'claude-sonnet-4-5',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces`, { cookie });
    assert.equal(r.status, 200);
    const workspaces = (r.body as Record<string, unknown>).workspaces as Array<Record<string, unknown>>;
    const found = workspaces.find((w) => w.name === 'ListTest');
    assert.ok(found, 'workspace should be in list');
    assert.equal(found.default_engine, 'claude-code');
    assert.equal(found.default_agent, 'my-agent');
    assert.equal(found.default_model, 'claude-sonnet-4-5');
  });

  it('POST accepts demo as a valid engine', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'DemoEngine',
      defaultEngine: 'demo',
    });
    assert.equal(ws.default_engine, 'demo');
  });

  it('POST rejects invalid defaultEngine with 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces`, {
      method: 'POST',
      body: { name: 'BadEngine', defaultEngine: 'openai' },
      cookie,
    });
    assert.equal(r.status, 400);
    assert.ok(
      JSON.stringify(r.body).includes('defaultEngine'),
      `error should mention defaultEngine: ${JSON.stringify(r.body)}`,
    );
  });

  it('POST rejects defaultAgent exceeding 200 characters with 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces`, {
      method: 'POST',
      body: { name: 'LongAgent', defaultAgent: 'x'.repeat(201) },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('POST rejects invalid defaultModel characters with 400', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces`, {
      method: 'POST',
      body: { name: 'BadModel', defaultModel: 'invalid model with spaces!' },
      cookie,
    });
    assert.equal(r.status, 400);
    assert.ok(
      JSON.stringify(r.body).includes('defaultModel'),
      `error should mention defaultModel: ${JSON.stringify(r.body)}`,
    );
  });

  it('defaultTrustTools is stored on create and changed on update; off when not given', async () => {
    const mk = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces`, {
      method: 'POST', body: { name: 'Trusting', defaultTrustTools: true }, cookie,
    });
    const ws = (mk.body as { workspace: { id: string; default_trust_tools: number } }).workspace;
    assert.equal(ws.default_trust_tools, 1);
    const off = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces/${ws.id}`, {
      method: 'PUT', body: { defaultTrustTools: false }, cookie,
    });
    assert.equal((off.body as { workspace: { default_trust_tools: number } }).workspace.default_trust_tools, 0);
    const plain = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces`, {
      method: 'POST', body: { name: 'Plain' }, cookie,
    });
    assert.equal((plain.body as { workspace: { default_trust_tools: number } }).workspace.default_trust_tools, 0);
  });
});

describe('Workspace default fields — PUT', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'WS Defaults PUT');
  });

  after(async () => { await cleanup(); });

  it('PUT sets all three default fields', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, { name: 'PutTest' });
    const wsId = ws.id as string;

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces/${wsId}`, {
      method: 'PUT',
      body: { defaultEngine: 'claude-code', defaultAgent: 'specialist', defaultModel: 'claude-3-5-sonnet' },
      cookie,
    });
    assert.equal(r.status, 200, `PUT failed: ${JSON.stringify(r.body)}`);
    const updated = (r.body as Record<string, unknown>).workspace as Record<string, unknown>;
    assert.equal(updated.default_engine, 'claude-code');
    assert.equal(updated.default_agent, 'specialist');
    assert.equal(updated.default_model, 'claude-3-5-sonnet');
  });

  it("PUT with '' clears each field", async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'ClearTest',
      defaultEngine: 'kiro',
      defaultAgent: 'some-agent',
      defaultModel: 'some-model',
    });
    const wsId = ws.id as string;

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces/${wsId}`, {
      method: 'PUT',
      body: { defaultEngine: '', defaultAgent: '', defaultModel: '' },
      cookie,
    });
    assert.equal(r.status, 200, `PUT clear failed: ${JSON.stringify(r.body)}`);
    const updated = (r.body as Record<string, unknown>).workspace as Record<string, unknown>;
    assert.equal(updated.default_engine, '');
    assert.equal(updated.default_agent, '');
    assert.equal(updated.default_model, '');
  });

  it('PUT with missing field leaves it unchanged', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'PartialPut',
      defaultEngine: 'kiro',
      defaultAgent: 'unchanged-agent',
      defaultModel: 'unchanged-model',
    });
    const wsId = ws.id as string;

    // Only update the name — other fields must survive
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces/${wsId}`, {
      method: 'PUT',
      body: { name: 'PartialPut-Renamed' },
      cookie,
    });
    assert.equal(r.status, 200, `partial PUT failed: ${JSON.stringify(r.body)}`);
    const updated = (r.body as Record<string, unknown>).workspace as Record<string, unknown>;
    assert.equal(updated.name, 'PartialPut-Renamed');
    assert.equal(updated.default_engine, 'kiro', 'default_engine should be unchanged');
    assert.equal(updated.default_agent, 'unchanged-agent', 'default_agent should be unchanged');
    assert.equal(updated.default_model, 'unchanged-model', 'default_model should be unchanged');
  });

  it('PUT rejects invalid defaultEngine with 400', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, { name: 'BadEnginePut' });
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces/${ws.id as string}`, {
      method: 'PUT',
      body: { defaultEngine: 'gpt-4' },
      cookie,
    });
    assert.equal(r.status, 400);
  });

  it('PUT rejects invalid defaultModel with 400', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, { name: 'BadModelPut' });
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workspaces/${ws.id as string}`, {
      method: 'PUT',
      body: { defaultModel: 'model with spaces' },
      cookie,
    });
    assert.equal(r.status, 400);
  });
});

// ── Session creation with workspace defaults ───────────────────────────────────

describe('Session creation — workspace default engine', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'WS Engine Default');
  });

  after(async () => { await cleanup(); });

  it('session without engine uses workspace default_engine', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'EngineDefault',
      defaultEngine: 'demo',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.engine, 'demo', 'engine should come from workspace default');
  });

  it('explicit engine in request overrides workspace default_engine', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'EngineOverride',
      defaultEngine: 'kiro',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.engine, 'demo', 'explicit engine should override workspace default');
  });

  it('session without workspace falls back to built-in default (demo)', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal — no workspace' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.engine, 'demo', 'no-workspace session should default to demo');
  });
});

describe('Session creation — workspace default agent', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'WS Agent Default');
  });

  after(async () => { await cleanup(); });

  it('session without leadAgent uses workspace default_agent', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'AgentDefault',
      defaultAgent: 'my-workspace-agent',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.lead_agent, 'my-workspace-agent', 'lead_agent should come from workspace default');
  });

  it('explicit leadAgent in request overrides workspace default_agent', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'AgentOverride',
      defaultAgent: 'workspace-agent',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo', leadAgent: 'explicit-agent' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.lead_agent, 'explicit-agent', 'explicit leadAgent should override workspace default');
  });

  it('project default_lead_agent fills in when workspace has no default_agent', async () => {
    // Set project-level default_lead_agent via DB
    dbRun(
      'UPDATE projects SET default_lead_agent = ? WHERE id = ?',
      'project-level-agent',
      projectId,
    );

    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'ProjectAgentFallback',
      // no defaultAgent
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.lead_agent, 'project-level-agent', 'project default_lead_agent should be used when workspace has none');

    // Clean up project-level default so it does not affect subsequent tests
    dbRun('UPDATE projects SET default_lead_agent = ? WHERE id = ?', '', projectId);
  });

  it('workspace default_agent takes precedence over project default_lead_agent', async () => {
    dbRun(
      'UPDATE projects SET default_lead_agent = ? WHERE id = ?',
      'project-level-agent',
      projectId,
    );

    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'WsOverridesProject',
      defaultAgent: 'workspace-agent',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.lead_agent, 'workspace-agent', 'workspace default_agent should beat project default');

    dbRun('UPDATE projects SET default_lead_agent = ? WHERE id = ?', '', projectId);
  });
});

describe('Session creation — workspace default model', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'WS Model Default');
  });

  after(async () => { await cleanup(); });

  it('session without model uses workspace default_model', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'ModelDefault',
      defaultModel: 'claude-3-5-sonnet',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.model, 'claude-3-5-sonnet', 'model should come from workspace default');
  });

  it('explicit model in request overrides workspace default_model', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'ModelOverride',
      defaultModel: 'claude-3-5-sonnet',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo', model: 'claude-3-haiku' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.model, 'claude-3-haiku', 'explicit model should override workspace default');
  });

  it('project default_model fills in when workspace has no default_model', async () => {
    dbRun(
      'UPDATE projects SET default_model = ? WHERE id = ?',
      'project-default-model',
      projectId,
    );

    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'ProjectModelFallback',
      // no defaultModel
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.model, 'project-default-model', 'project default_model should be used when workspace has none');

    dbRun('UPDATE projects SET default_model = ? WHERE id = ?', '', projectId);
  });

  it('workspace default_model takes precedence over project default_model', async () => {
    dbRun(
      'UPDATE projects SET default_model = ? WHERE id = ?',
      'project-model',
      projectId,
    );

    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'WsModelOverProject',
      defaultModel: 'workspace-model',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.model, 'workspace-model', 'workspace default_model should beat project default');

    dbRun('UPDATE projects SET default_model = ? WHERE id = ?', '', projectId);
  });

  it('session without workspace and no project defaults uses empty model string', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal — no workspace', engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.model, '', 'no workspace/project defaults → model should be empty string');
  });
});

describe('Session creation — workspace agent/model skipped when engine differs', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    cookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, cookie, 'WS Engine Mismatch');
  });

  after(async () => { await cleanup(); });

  it('workspace default_engine=kiro: request engine=demo does NOT get workspace agent/model', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'KiroDefaultsMismatch',
      defaultEngine: 'kiro',
      defaultAgent: 'kiro-agent',
      defaultModel: 'kiro-model',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'demo' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.engine, 'demo', 'engine should be the explicitly requested one');
    assert.equal(wf.lead_agent, null, 'workspace agent should NOT apply when engine differs');
    assert.equal(wf.model, '', 'workspace model should NOT apply when engine differs');
  });

  it('workspace default_engine=kiro: request engine=kiro DOES get workspace agent/model', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'KiroDefaultsMatch',
      defaultEngine: 'kiro',
      defaultAgent: 'kiro-agent',
      defaultModel: 'kiro-model',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'kiro' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.engine, 'kiro');
    assert.equal(wf.lead_agent, 'kiro-agent', 'workspace agent should apply when engine matches');
    assert.equal(wf.model, 'kiro-model', 'workspace model should apply when engine matches');
  });

  it('workspace default_engine=kiro: no engine in request (falls back to kiro) DOES get workspace agent/model', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'KiroDefaultsNoEngine',
      defaultEngine: 'kiro',
      defaultAgent: 'kiro-agent',
      defaultModel: 'kiro-model',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.engine, 'kiro', 'engine should come from workspace default');
    assert.equal(wf.lead_agent, 'kiro-agent', 'workspace agent should apply when engine falls back to workspace default');
    assert.equal(wf.model, 'kiro-model', 'workspace model should apply when engine falls back to workspace default');
  });

  it('workspace with no default_engine: model applies regardless of request engine', async () => {
    const ws = await createWorkspace(baseUrl, cookie, projectId, {
      name: 'NoEngineDefault',
      // no defaultEngine
      defaultModel: 'universal-model',
    });

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST',
      body: { goal: 'test goal', workspaceId: ws.id, engine: 'claude-code' },
      cookie,
    });
    assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.body)}`);
    const wf = (r.body as Record<string, unknown>).workflow as Record<string, unknown>;
    assert.equal(wf.engine, 'claude-code');
    assert.equal(wf.model, 'universal-model', 'workspace model should apply when workspace has no default_engine');
  });
});
