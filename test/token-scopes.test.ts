/**
 * Token-scope enforcement — table-driven tests.
 *
 * Each sensitive route is called with a read-only token and must return 403.
 * Browser-only routes (credentials, api-tokens, settings writes, terminal) must
 * return 403 even for a full-scope token.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { generateId, now } from '../server/util.ts';

// ── Shared server state ───────────────────────────────────────────────────────

let baseUrl: string;
let adminCookie: string;
let projectId: string;
let workflowId: string;
let testProjectId: string;
let scanId: string;
let reviewId: string;
let scriptId: string;
let groupId: string;

before(async () => {
  const ts = await createTestServer();
  baseUrl = ts.baseUrl;

  // Create admin
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `scopes-${Date.now()}@test.com`, name: 'Admin', password: 'pw12345678', provider: 'demo' },
  });
  adminCookie = r.cookie ?? '';

  // Create project
  const pr = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST', body: { name: 'Scope Test' }, cookie: adminCookie,
  });
  assert.equal(pr.status, 201, `project create failed: ${JSON.stringify(pr.body)}`);
  projectId = ((pr.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
  assert.ok(projectId, 'projectId must be set');

  // Create a workflow so we can test write routes that require :wid
  const wr = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
    method: 'POST', body: { goal: 'test goal', engine: 'demo' }, cookie: adminCookie,
  });
  assert.equal(wr.status, 201, `workflow create failed: ${JSON.stringify(wr.body)}`);
  workflowId = ((wr.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  assert.ok(workflowId, 'workflowId must be set');

  // Create a test project
  const tr = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
    method: 'POST', body: { name: 'Scope Test App', appUrl: 'http://localhost:9099' }, cookie: adminCookie,
  });
  assert.equal(tr.status, 201, `test project create failed: ${JSON.stringify(tr.body)}`);
  testProjectId = (tr.body as { testProject: { id: string } }).testProject.id;
  assert.ok(testProjectId, 'testProjectId must be set');

  // Create a test group and script for run routes
  const gr = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/groups`, {
    method: 'POST', body: { name: 'Group' }, cookie: adminCookie,
  });
  assert.equal(gr.status, 201, `group create failed: ${JSON.stringify(gr.body)}`);
  groupId = ((gr.body as Record<string, unknown>).group as Record<string, unknown>).id as string;
  assert.ok(groupId, 'groupId must be set');

  const sr = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${testProjectId}/groups/${groupId}/scripts`, {
    method: 'POST', body: { name: 'Script', steps: [] }, cookie: adminCookie,
  });
  assert.equal(sr.status, 201, `script create failed: ${JSON.stringify(sr.body)}`);
  scriptId = ((sr.body as Record<string, unknown>).script as Record<string, unknown>).id as string;
  assert.ok(scriptId, 'scriptId must be set');

  // Insert a stub review (direct DB insert)
  reviewId = generateId();
  const ts2 = now();
  const { run: dbRun } = await import('../server/db.ts');
  dbRun(
    `INSERT INTO p10_reviews
       (id, project_id, base_ref, head_ref, status, post_mode, min_severity, created_at,
        jira_context, run_log, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
        llm_requests, retry_count, tool_calls, files_reviewed)
     VALUES (?,?,?,?,'done','draft','medium',?,'{}','[]',0,0,0,0,0,0,0,0)`,
    reviewId, projectId, 'main', 'feature/scope', ts2,
  );

  // Insert a stub repo and scan
  const repoId = generateId();
  dbRun(
    `INSERT INTO repositories (id, project_id, name, url, provider, created_at) VALUES (?,?,?,?,?,?)`,
    repoId, projectId, 'scope-repo', 'https://github.com/a/b', 'github', now(),
  );
  scanId = generateId();
  dbRun(
    `INSERT INTO p10_scans (id, project_id, repo_id, branch, include_paths, exclude_paths, background_doc_ids,
      status, files_total, files_done, tokens_used, cost_usd, input_tokens, output_tokens,
      estimated_files, estimated_bytes, estimated_tokens, estimated_cost_usd, estimated_minutes,
      created_at)
     VALUES (?,?,?,?,?,?,?,?,0,0,0,0,0,0,1,100,100,0.001,0.1,?)`,
    scanId, projectId, repoId, 'main', '[]', '[]', '[]', 'estimate_ready', now(),
  );
});

after(cleanup);

// ── Helper: create a token with given scopes (browser auth) ──────────────────

async function makeToken(scopes: string[]): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/api-tokens', {
    method: 'POST',
    body: { name: `scope-test-${scopes.join(',')}`, scopes },
    cookie: adminCookie,
  });
  return `Bearer ${(r.body as Record<string, unknown>).token as string}`;
}

// ── Table-driven test data ────────────────────────────────────────────────────

interface RouteSpec {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  /** Scope the route requires. 'browser-only' means even full-scope token is refused. */
  requiredScope: 'write' | 'review' | 'merge' | 'tests' | 'browser-only';
}

const WRITE_ROUTES: RouteSpec[] = [
  // Session CRUD
  { method: 'POST', path: () => `/api/projects/${projectId}/workflows`, body: { goal: 'x', engine: 'demo' }, requiredScope: 'write' },
  { method: 'DELETE', path: () => `/api/projects/${projectId}/workflows/${workflowId}`, requiredScope: 'write' },
  { method: 'POST', path: () => `/api/projects/${projectId}/workflows/${workflowId}/start`, requiredScope: 'write' },
  { method: 'POST', path: () => `/api/projects/${projectId}/workflows/${workflowId}/cancel`, requiredScope: 'write' },
  { method: 'POST', path: () => `/api/projects/${projectId}/workflows/${workflowId}/message`, body: { message: 'hi' }, requiredScope: 'write' },
  { method: 'POST', path: () => `/api/projects/${projectId}/workflows/${workflowId}/delegate`, body: { task: 'child task' }, requiredScope: 'write' },
  { method: 'PATCH', path: () => `/api/projects/${projectId}/workflows/${workflowId}`, body: { title: 'new' }, requiredScope: 'write' },
  // IDE writes
  { method: 'POST', path: () => `/api/workflows/${workflowId}/ide/file`, body: { path: 'test.txt', content: 'x', scope: 'uploads' }, requiredScope: 'write' },
  { method: 'PUT', path: () => `/api/workflows/${workflowId}/ide/file`, body: { path: 'test.txt', content: 'x', scope: 'uploads' }, requiredScope: 'write' },
  { method: 'DELETE', path: () => `/api/workflows/${workflowId}/ide/file?path=test.txt&scope=uploads`, requiredScope: 'write' },
  { method: 'POST', path: () => `/api/workflows/${workflowId}/ide/folder`, body: { path: 'newdir', scope: 'uploads' }, requiredScope: 'write' },
  { method: 'PATCH', path: () => `/api/workflows/${workflowId}/ide/rename`, body: { path: 'test.txt', newPath: 'test2.txt', scope: 'uploads' }, requiredScope: 'write' },
  // User config writes (kiro folder)
  { method: 'PUT', path: () => `/api/user-config/kiro/file`, body: { path: 'test.md', content: '# hi' }, requiredScope: 'write' },
  { method: 'POST', path: () => `/api/user-config/kiro/file`, body: { path: `t-${Date.now()}.md`, content: '# hi' }, requiredScope: 'write' },
] as unknown as RouteSpec[];

const REVIEW_ROUTES: RouteSpec[] = [
  { method: 'POST', path: () => `/api/projects/${projectId}/reviews`, body: { baseRef: 'main', headRef: 'feature/x' }, requiredScope: 'review' },
  { method: 'POST', path: () => `/api/projects/${projectId}/reviews/${reviewId}/post`, body: {}, requiredScope: 'review' },
  { method: 'POST', path: () => `/api/projects/${projectId}/reviews/${reviewId}/rerun`, body: {}, requiredScope: 'review' },
  { method: 'POST', path: () => `/api/projects/${projectId}/scans/${scanId}/confirm`, body: { budgetTokens: 10000 }, requiredScope: 'review' },
  { method: 'POST', path: () => `/api/projects/${projectId}/scans/${scanId}/resume`, body: { budgetTokens: 10000 }, requiredScope: 'review' },
] as unknown as RouteSpec[];

const MERGE_ROUTES: RouteSpec[] = [
  { method: 'POST', path: () => `/api/projects/${projectId}/reviews/${reviewId}/merge`, body: { strategy: 'squash' }, requiredScope: 'merge' },
] as unknown as RouteSpec[];

const TEST_RUN_ROUTES: RouteSpec[] = [
  { method: 'POST', path: () => `/api/projects/${projectId}/tests/${testProjectId}/scripts/${scriptId}/run`, body: {}, requiredScope: 'tests' },
  { method: 'POST', path: () => `/api/projects/${projectId}/tests/${testProjectId}/groups/${groupId}/run`, body: {}, requiredScope: 'tests' },
  { method: 'POST', path: () => `/api/projects/${projectId}/tests/${testProjectId}/generate`, body: { description: 'gen' }, requiredScope: 'tests' },
] as unknown as RouteSpec[];

const BROWSER_ONLY_ROUTES: RouteSpec[] = [
  { method: 'GET', path: () => `/api/credentials`, requiredScope: 'browser-only' },
  { method: 'POST', path: () => `/api/credentials`, body: { engine: 'kiro', mode: 'api_key', name: 'x', secret: 'y' }, requiredScope: 'browser-only' },
  { method: 'GET', path: () => `/api/api-tokens`, requiredScope: 'browser-only' },
  { method: 'POST', path: () => `/api/api-tokens`, body: { name: 'tok', scopes: ['read'] }, requiredScope: 'browser-only' },
  { method: 'PUT', path: () => `/api/user-config/aws/file`, body: { path: 'credentials', content: '[default]' }, requiredScope: 'browser-only' },
] as unknown as RouteSpec[];

function resolvePath(spec: { path: string | (() => string) }): string {
  return typeof spec.path === 'function' ? (spec.path as () => string)() : spec.path;
}

// ── Tests: read-only token gets 403 on write routes ──────────────────────────

describe('token-scopes — read-only token refused on write routes', () => {
  it('read-only token → 403 on all session write routes', async () => {
    const auth = await makeToken(['read']);
    for (const spec of WRITE_ROUTES) {
      const r = await fetchJson(baseUrl, resolvePath(spec), {
        method: spec.method,
        headers: { Authorization: auth },
        body: spec.body,
      });
      assert.equal(r.status, 403, `${spec.method} ${resolvePath(spec)} should return 403 with read-only token, got ${r.status}`);
    }
  });

  it('read-only token → 403 on all review/scan routes', async () => {
    const auth = await makeToken(['read']);
    for (const spec of REVIEW_ROUTES) {
      const r = await fetchJson(baseUrl, resolvePath(spec), {
        method: spec.method,
        headers: { Authorization: auth },
        body: spec.body,
      });
      assert.equal(r.status, 403, `${spec.method} ${resolvePath(spec)} should return 403 with read-only token, got ${r.status}`);
    }
  });

  it('read-only token → 403 on merge route', async () => {
    const auth = await makeToken(['read']);
    for (const spec of MERGE_ROUTES) {
      const r = await fetchJson(baseUrl, resolvePath(spec), {
        method: spec.method,
        headers: { Authorization: auth },
        body: spec.body,
      });
      assert.equal(r.status, 403, `${spec.method} ${resolvePath(spec)} should return 403 with read-only token`);
    }
  });

  it('review-scope token → still 403 on merge route (needs merge scope)', async () => {
    const auth = await makeToken(['read', 'review']);
    for (const spec of MERGE_ROUTES) {
      const r = await fetchJson(baseUrl, resolvePath(spec), {
        method: spec.method,
        headers: { Authorization: auth },
        body: spec.body,
      });
      assert.equal(r.status, 403, `${spec.method} ${resolvePath(spec)} should return 403 with review scope`);
    }
  });

  it('read-only token → 403 on test run routes', async () => {
    const auth = await makeToken(['read']);
    for (const spec of TEST_RUN_ROUTES) {
      const r = await fetchJson(baseUrl, resolvePath(spec), {
        method: spec.method,
        headers: { Authorization: auth },
        body: spec.body,
      });
      assert.equal(r.status, 403, `${spec.method} ${resolvePath(spec)} should return 403 with read-only token, got ${r.status}`);
    }
  });

  it('write-scope token → still 403 on test run routes (needs tests scope)', async () => {
    const auth = await makeToken(['read', 'write']);
    for (const spec of TEST_RUN_ROUTES) {
      const r = await fetchJson(baseUrl, resolvePath(spec), {
        method: spec.method,
        headers: { Authorization: auth },
        body: spec.body,
      });
      assert.equal(r.status, 403, `${spec.method} ${resolvePath(spec)} should return 403 with write scope`);
    }
  });

  it('tests-scope token → not 403 on test run routes', async () => {
    const auth = await makeToken(['read', 'tests']);
    // Just test the script run route (will get 404/429 for other reasons but not 403)
    for (const spec of TEST_RUN_ROUTES) {
      const r = await fetchJson(baseUrl, resolvePath(spec), {
        method: spec.method,
        headers: { Authorization: auth },
        body: spec.body,
      });
      assert.notEqual(r.status, 403, `${spec.method} ${resolvePath(spec)} must not be 403 with tests scope`);
    }
  });
});

// ── Tests: browser-only routes refuse any Bearer token ───────────────────────

describe('token-scopes — browser-only routes refuse all API tokens', () => {
  it('full-scope token → 403 on browser-only routes', async () => {
    const auth = await makeToken(['read', 'write', 'review', 'merge', 'tests']);
    for (const spec of BROWSER_ONLY_ROUTES) {
      const r = await fetchJson(baseUrl, resolvePath(spec), {
        method: spec.method,
        headers: { Authorization: auth },
        body: spec.body,
      });
      assert.equal(r.status, 403, `${spec.method} ${resolvePath(spec)} should return 403 even with full-scope token, got ${r.status}`);
    }
  });

  it('browser session can access browser-only routes', async () => {
    const r = await fetchJson(baseUrl, `/api/api-tokens`, { cookie: adminCookie });
    assert.equal(r.status, 200, 'browser session must access /api/api-tokens');
  });
});
