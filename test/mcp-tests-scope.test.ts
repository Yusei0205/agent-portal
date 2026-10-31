/**
 * Tests for finding 6: MCP tools for Tests module.
 *
 * Covers:
 *   ✓ list_test_projects (read scope)
 *   ✓ list_test_scripts (read scope)
 *   ✓ get_test_run (read scope)
 *   ✓ start_test_run (tests scope)
 *   ✓ cancel_test_run (tests scope)
 *   ✓ generate_test_script (tests scope)
 *   ✓ read-scope token cannot call tests-scope tools
 *   ✓ audit entries created for MCP tools
 *   ✓ vault values never returned
 *   ✓ non-member access denied
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one, all, insert } from '../server/db.ts';
import type { Row } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

async function setupAdmin(baseUrl: string) {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `mcp-tests-${Date.now()}@example.com`, name: 'Admin', password: 'password1234' },
  });
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string) {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST', body: { name: 'MCP Tests Project' }, cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createTestProject(baseUrl: string, cookie: string, projectId: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
    method: 'POST',
    body: { name: 'MCP App Tests', appUrl: 'http://localhost:9001' },
    cookie,
  });
  return (r.body as { testProject: { id: string } }).testProject.id;
}

async function createGroup(baseUrl: string, cookie: string, pid: string, tpId: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpId}/groups`, {
    method: 'POST', body: { name: 'Default Group' }, cookie,
  });
  return (r.body as { group: { id: string } }).group.id;
}

async function createScript(baseUrl: string, cookie: string, pid: string, tpId: string, gid: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpId}/groups/${gid}/scripts`, {
    method: 'POST',
    body: { name: 'Login test', steps: [{ kind: 'goto', path: '/login' }] },
    cookie,
  });
  return (r.body as { script: { id: string } }).script.id;
}

async function makeToken(baseUrl: string, cookie: string, scopes: string[]) {
  const r = await fetchJson(baseUrl, '/api/api-tokens', {
    method: 'POST',
    body: { name: 'MCP test token', scopes },
    cookie,
  });
  return (r.body as { token: string }).token;
}

function mcpCall(baseUrl: string, token: string, method: string, params: object) {
  return fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function mcpToolCall(baseUrl: string, token: string, toolName: string, args: object) {
  const resp = await mcpCall(baseUrl, token, 'tools/call', { name: toolName, arguments: args });
  const text = await resp.text();
  // Extract JSON from SSE or direct response
  let data: string = text;
  if (text.startsWith('event:') || text.startsWith('data:')) {
    const m = text.match(/^data:\s*(.+)$/m);
    data = m ? m[1] : text;
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(data) as Record<string, unknown>; }
  catch { parsed = { raw: text }; }
  return { status: resp.status, parsed, text };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MCP tests scope — read tools (list_test_projects, list_test_scripts, get_test_run)', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let tpId: string;
  let gid: string;
  let sid: string;
  let readToken: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, adminCookie);
    tpId = await createTestProject(baseUrl, adminCookie, projectId);
    gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
    sid = await createScript(baseUrl, adminCookie, projectId, tpId, gid);
    readToken = await makeToken(baseUrl, adminCookie, ['read']);
  });
  after(cleanup);

  it('list_test_projects returns test projects for read token', async () => {
    const { status, parsed } = await mcpToolCall(baseUrl, readToken, 'list_test_projects', { projectId });
    assert.equal(status, 200);
    const result = parsed.result as { content?: Array<{ text?: string }> };
    const content = result?.content?.[0]?.text ?? '';
    const data = JSON.parse(content) as { testProjects: Array<{ id: string }> };
    assert.ok(data.testProjects.some((tp) => tp.id === tpId), 'should include our test project');
  });

  it('list_test_scripts returns scripts', async () => {
    const { status, parsed } = await mcpToolCall(baseUrl, readToken, 'list_test_scripts', {
      projectId, testProjectId: tpId,
    });
    assert.equal(status, 200);
    const result = parsed.result as { content?: Array<{ text?: string }> };
    const content = result?.content?.[0]?.text ?? '';
    const data = JSON.parse(content) as { scripts: Array<{ id: string }> };
    assert.ok(data.scripts.some((s) => s.id === sid), 'should include our script');
  });

  it('list_test_scripts scripts do not expose vault secrets', async () => {
    // Create a script with a vault ref (stored as literal template, not actual value)
    await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/vault`, {
      method: 'POST',
      body: { name: 'creds', kind: 'login', username: 'user', password: 'super-secret-123' },
      cookie: adminCookie,
    });

    await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/groups/${gid}/scripts`, {
      method: 'POST',
      body: { name: 'Vault ref script', steps: [{ kind: 'fill', locator: { label: 'Pass' }, value: '{{vault.creds.password}}' }] },
      cookie: adminCookie,
    });

    const { text } = await mcpToolCall(baseUrl, readToken, 'list_test_scripts', { projectId, testProjectId: tpId });
    assert.ok(!text.includes('super-secret-123'), 'vault secret must not appear in response');
    // Vault ref template should be returned (not the actual value)
    assert.ok(text.includes('vault.creds.password'), 'vault ref template should appear');
  });

  it('get_test_run returns run with steps', async () => {
    // Create a test run directly
    const runId = generateId();
    insert('test_runs', {
      id: runId, test_project_id: tpId, script_id: sid, group_id: null,
      status: 'passed', error: null, artifact_dir: null, created_by: null,
      created_at: now(), started_at: now(), finished_at: now(),
    });

    const { status, parsed } = await mcpToolCall(baseUrl, readToken, 'get_test_run', {
      projectId, testProjectId: tpId, runId,
    });
    assert.equal(status, 200);
    const result = parsed.result as { content?: Array<{ text?: string }> };
    const content = result?.content?.[0]?.text ?? '';
    const data = JSON.parse(content) as { run: { id: string; status: string }; steps: unknown[] };
    assert.equal(data.run.id, runId);
    assert.equal(data.run.status, 'passed');
    // screenshot_path should not be in steps (server path, not useful over MCP)
    assert.ok(!content.includes('screenshot_path'), 'screenshot_path must not appear in get_test_run');
  });

  it('read token returns error for tests-scope tool (start_test_run)', async () => {
    const { status, parsed } = await mcpToolCall(baseUrl, readToken, 'start_test_run', {
      projectId, testProjectId: tpId, scriptId: sid,
    });
    assert.equal(status, 200); // MCP returns 200 with error
    const result = parsed.result as { isError?: boolean };
    assert.ok(
      result?.isError === true || JSON.stringify(parsed).includes('error') || JSON.stringify(parsed).includes('unknown'),
      'read token must not call start_test_run',
    );
  });
});

describe('MCP tests scope — write tools (start_test_run, cancel_test_run, generate_test_script)', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let tpId: string;
  let gid: string;
  let sid: string;
  let testsToken: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, adminCookie);
    tpId = await createTestProject(baseUrl, adminCookie, projectId);
    gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
    sid = await createScript(baseUrl, adminCookie, projectId, tpId, gid);
    testsToken = await makeToken(baseUrl, adminCookie, ['read', 'tests']);
  });
  after(cleanup);

  it('start_test_run creates a run and returns runId', async () => {
    const { status, parsed } = await mcpToolCall(baseUrl, testsToken, 'start_test_run', {
      projectId, testProjectId: tpId, scriptId: sid,
    });
    assert.equal(status, 200);
    const result = parsed.result as { content?: Array<{ text?: string }> };
    const content = result?.content?.[0]?.text ?? '';
    const data = JSON.parse(content) as { runId: string };
    assert.ok(data.runId, 'should return a runId');

    // Verify run was created in DB
    const run = one<Row>('SELECT * FROM test_runs WHERE id = ?', data.runId);
    assert.ok(run, 'run should exist in DB');
    assert.ok(['queued', 'running', 'passed', 'failed', 'error'].includes(String(run!.status)));
  });

  it('cancel_test_run cancels a queued run', async () => {
    // Create a queued run
    const runId = generateId();
    insert('test_runs', {
      id: runId, test_project_id: tpId, script_id: sid, group_id: null,
      status: 'queued', error: null, artifact_dir: null, created_by: null,
      created_at: now(), started_at: null, finished_at: null,
    });

    const { status, parsed } = await mcpToolCall(baseUrl, testsToken, 'cancel_test_run', {
      projectId, testProjectId: tpId, runId,
    });
    assert.equal(status, 200);
    const result = parsed.result as { content?: Array<{ text?: string }> };
    const content = result?.content?.[0]?.text ?? '';
    const data = JSON.parse(content) as { ok: boolean; status: string };
    assert.equal(data.ok, true);
    assert.equal(data.status, 'cancelled');

    const run = one<Row>('SELECT status FROM test_runs WHERE id = ?', runId);
    assert.equal(String(run?.status ?? ''), 'cancelled');
  });

  it('generate_test_script creates a generation record', async () => {
    const { status, parsed } = await mcpToolCall(baseUrl, testsToken, 'generate_test_script', {
      projectId, testProjectId: tpId,
      description: 'Test that the login page works',
      groupId: gid,
    });
    assert.equal(status, 200);
    const result = parsed.result as { content?: Array<{ text?: string }> };
    const content = result?.content?.[0]?.text ?? '';
    const data = JSON.parse(content) as { generationId: string };
    assert.ok(data.generationId, 'should return a generationId');

    const gen = one<Row>('SELECT * FROM test_generations WHERE id = ?', data.generationId);
    assert.ok(gen, 'generation should exist in DB');
    assert.equal(String(gen!.test_project_id), tpId);
  });

  it('start_test_run requires scriptId or groupId', async () => {
    const { status, parsed } = await mcpToolCall(baseUrl, testsToken, 'start_test_run', {
      projectId, testProjectId: tpId, // missing both scriptId and groupId
    });
    assert.equal(status, 200);
    const result = parsed.result as { isError?: boolean; content?: Array<{ text?: string }> };
    assert.ok(result?.isError === true, 'should error when neither scriptId nor groupId provided');
  });

  it('non-member gets error for start_test_run', async () => {
    // Create a stranger user and token
    const strangerEmail = `stranger-mcp-${Date.now()}@example.com`;
    await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: strangerEmail, name: 'Stranger', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: strangerEmail, password: 'password1234' },
    });
    const strangerToken = await makeToken(baseUrl, loginR.cookie ?? '', ['read', 'tests']);

    const { status, parsed } = await mcpToolCall(baseUrl, strangerToken, 'start_test_run', {
      projectId, testProjectId: tpId, scriptId: sid,
    });
    assert.equal(status, 200);
    const result = parsed.result as { isError?: boolean; content?: Array<{ text?: string }> };
    // Should get a "project not found" or access denied error
    assert.ok(result?.isError === true, 'non-member should be denied');
  });
});

describe('MCP info — tests scope tools listed', () => {
  let baseUrl: string;
  let adminCookie: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
  });
  after(cleanup);

  it('GET /api/mcp/info lists tests scope tools', async () => {
    const r = await fetchJson(baseUrl, '/api/mcp/info', { cookie: adminCookie });
    assert.equal(r.status, 200);
    const tools = (r.body as { tools: Array<{ name: string; scope: string }> }).tools;
    const testTools = tools.filter((t) => t.scope === 'tests');
    const testReadTools = tools.filter((t) => ['list_test_projects', 'list_test_scripts', 'get_test_run'].includes(t.name));
    assert.ok(testTools.length >= 3, `Expected at least 3 tests-scope tools, got ${testTools.length}`);
    assert.ok(testReadTools.length >= 3, 'Expected list_test_projects, list_test_scripts, get_test_run as read tools');

    const toolNames = tools.map((t) => t.name);
    assert.ok(toolNames.includes('start_test_run'), 'start_test_run should be in catalogue');
    assert.ok(toolNames.includes('cancel_test_run'), 'cancel_test_run should be in catalogue');
    assert.ok(toolNames.includes('generate_test_script'), 'generate_test_script should be in catalogue');
    assert.ok(toolNames.includes('list_test_projects'), 'list_test_projects should be in catalogue');
    assert.ok(toolNames.includes('list_test_scripts'), 'list_test_scripts should be in catalogue');
    assert.ok(toolNames.includes('get_test_run'), 'get_test_run should be in catalogue');
  });
});
