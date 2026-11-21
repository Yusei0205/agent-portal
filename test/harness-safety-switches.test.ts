/**
 * Safety switches ported from the harness work (Phase 1, PRs 1.2 and 1.3):
 *   - only the person who started a session can turn on "trust all tools" for it;
 *   - an API token can neither turn it on nor approve a tool call (it may still decline one).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, cleanup, createTestServer, fetchJson } from './fixtures.ts';
import { getDb, one, insert } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';
import { inputFingerprint } from '../server/agent/runner.ts';

describe('safety switches', () => {
  let baseUrl: string;
  let cookie: string;
  let projectId: string;
  let token: string;
  let wfId: string;
  let adminId: string;

  before(async () => {
    createTestDb();
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: `admin-ss-${Date.now()}@test.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: `Switches-${Date.now()}` }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const t = await fetchJson(baseUrl, '/api/api-tokens', { method: 'POST', body: { name: 'ss', scope: 'write' }, cookie });
    token = String((t.body as Record<string, unknown>).token ?? '');
    adminId = one<{ id: string }>("SELECT id FROM users WHERE is_admin = 1 LIMIT 1")!.id;
    wfId = `wf-ss-${generateId()}`;
    getDb().prepare(
      "INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_by, created_at, updated_at) VALUES (?, ?, 'test', 'running', 'demo', 0, '[]', ?, ?, ?)",
    ).run(wfId, projectId, adminId, now(), now());
  });

  after(async () => { await cleanup(); });

  it('an API token cannot turn on trust all tools for an existing session', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}`, {
      method: 'PATCH', body: { trustTools: true }, headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 403);
    assert.match(String((r.body as Record<string, unknown>).error), /API tokens cannot turn on/);
  });

  it('someone other than the creator cannot turn trust on, but can turn it off', async () => {
    const other = generateId();
    insert('users', { id: other, email: `other-ss-${Date.now()}@test.com`, name: 'Other', password_hash: 'x', is_admin: 0, disabled: 0, created_at: now() });
    getDb().prepare('UPDATE p6_workflows SET created_by = ? WHERE id = ?').run(other, wfId);
    const on = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}`, { method: 'PATCH', body: { trustTools: true }, cookie });
    assert.equal(on.status, 403);
    assert.match(String((on.body as Record<string, unknown>).error), /Only the person who started/);

    getDb().prepare('UPDATE p6_workflows SET trust_tools = 1 WHERE id = ?').run(wfId);
    const off = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}`, { method: 'PATCH', body: { trustTools: false }, cookie });
    assert.equal(off.status, 200);
  });

  it('the creator can turn trust on', async () => {
    const me = adminId;
    getDb().prepare('UPDATE p6_workflows SET created_by = ?, trust_tools = 0 WHERE id = ?').run(me, wfId);
    const on = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}`, { method: 'PATCH', body: { trustTools: true }, cookie });
    assert.equal(on.status, 200);
  });

  it('an API token cannot approve a tool call but can decline it', async () => {
    const runId = `run-ss-${generateId()}`;
    getDb().prepare("INSERT INTO p6_runs (id, workflow_id, status, created_at) VALUES (?, ?, 'running', ?)").run(runId, wfId, now());
    const toolInput = { command: 'echo hi' };
    const hash = inputFingerprint('Bash', toolInput);
    const mk = (): string => {
      const id = `inp-ss-${generateId()}`;
      insert('p6_inputs', {
        id, run_id: runId, project_id: projectId, tool_name: 'Bash', tool_input: JSON.stringify(toolInput),
        payload: JSON.stringify({ toolName: 'Bash', input: toolInput, inputHash: hash }), input_hash: hash,
        type: 'approval', status: 'pending', allow_all: 0, expires_at: null, created_at: now(),
      });
      return id;
    };
    const url = `/api/projects/${projectId}/workflows/${wfId}/runs/${runId}/input`;
    const approve = await fetchJson(baseUrl, url, { method: 'POST', body: { inputId: mk(), response: 'approve', inputHash: hash }, headers: { Authorization: `Bearer ${token}` } });
    assert.equal(approve.status, 403);
    assert.match(String((approve.body as Record<string, unknown>).error), /cannot approve tool calls/);
    const deny = await fetchJson(baseUrl, url, { method: 'POST', body: { inputId: mk(), response: 'deny' }, headers: { Authorization: `Bearer ${token}` } });
    assert.equal(deny.status, 200);
  });
});
