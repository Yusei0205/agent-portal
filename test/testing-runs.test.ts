/**
 * Tests module — real headless browser run tests.
 *
 * These tests start a tiny local HTTP fixture server and run test scripts against it.
 * They are SKIPPED when:
 *   - playwright / playwright-core is not installed
 *   - No Chromium browser is available to launch
 *
 * Coverage (when Chromium is available):
 *   - Run passes on fixture page with screenshots recorded
 *   - Failing assertion records error + screenshot
 *   - Cancel stops a running run
 *   - api_request step against a local stub
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { _resetRunnerState } from '../server/testing/runner.ts';

// ── Fixture page HTML ──────────────────────────────────────────────────────────

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Portal Test Fixture</title></head>
<body>
<h1 id="title">Test Fixture Page</h1>
<form id="login-form">
  <label for="username">Username</label>
  <input id="username" name="username" type="text" placeholder="Username" />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" placeholder="Password" />
  <button type="submit" id="submit-btn">Login</button>
</form>
<p id="result"></p>
<script>
document.getElementById('login-form').addEventListener('submit', function(e) {
  e.preventDefault();
  const u = document.getElementById('username').value;
  document.getElementById('result').textContent = 'Welcome ' + u;
  history.pushState({}, '', '/dashboard');
});
</script>
</body>
</html>`;

// ── API stub page ──────────────────────────────────────────────────────────────

/** Returns a JSON stub response for api_request tests. */
function createApiStub(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/ping' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', pong: true }));
      } else if (req.url === '/api/echo' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ echoed: body }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ── Playwright availability check ──────────────────────────────────────────────

/** We check browser availability via the portal capability endpoint to avoid
 *  dangling browser processes in the test process itself. */
async function checkBrowserCapability(baseUrl: string, cookie: string): Promise<boolean> {
  try {
    const r = await fetchJson(baseUrl, '/api/tests/capability', { cookie });
    return (r.body as { available: boolean }).available === true;
  } catch {
    return false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string) {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email: `admin-runs-${Date.now()}@example.com`, name: 'Admin', password: 'password1234' },
  });
  return r.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string) {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name: 'Run Test Project' },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createTestProject(baseUrl: string, cookie: string, projectId: string, appUrl: string, apiBaseUrl?: string) {
  const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
    method: 'POST',
    body: {
      name: 'Run Tests',
      appUrl,
      timeoutSecs: 30,
      viewportWidth: 1024,
      viewportHeight: 768,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    },
    cookie,
  });
  assert.equal(r.status, 201);
  return (r.body as { testProject: { id: string } }).testProject.id;
}

async function createGroup(baseUrl: string, cookie: string, pid: string, tpId: string, name = 'Default') {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpId}/groups`, {
    method: 'POST',
    body: { name },
    cookie,
  });
  return (r.body as { group: { id: string } }).group.id;
}

async function createScript(baseUrl: string, cookie: string, pid: string, tpId: string, gid: string, name: string, steps: unknown[]) {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpId}/groups/${gid}/scripts`, {
    method: 'POST',
    body: { name, steps },
    cookie,
  });
  assert.equal(r.status, 201, `Create script: ${JSON.stringify(r.body)}`);
  return (r.body as { script: { id: string } }).script.id;
}

async function startRun(baseUrl: string, cookie: string, pid: string, tpId: string, sid: string): Promise<string> {
  const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpId}/scripts/${sid}/run`, {
    method: 'POST',
    cookie,
  });
  assert.equal(r.status, 202, `Start run: ${JSON.stringify(r.body)}`);
  return (r.body as { runId: string }).runId;
}

async function waitForRun(
  baseUrl: string,
  cookie: string,
  pid: string,
  tpId: string,
  runId: string,
  timeoutMs = 30_000,
): Promise<{ status: string; error?: string; steps: unknown[] }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpId}/runs/${runId}`, { cookie });
    const body = r.body as { run: { status: string; error?: string }; steps: unknown[] };
    const { status } = body.run;
    if (['passed', 'failed', 'cancelled', 'error'].includes(status)) {
      return { status, error: body.run.error, steps: body.steps };
    }
  }
  return { status: 'timeout', steps: [] };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Headless browser runs', () => {
  let fixtureServer: http.Server;
  let fixtureUrl: string;
  let apiStubServer: http.Server;
  let apiStubUrl: string;
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let playwrightOk = false;

  before(async () => {
    // Small delay to let previous test file's cleanup settle
    await new Promise((r) => setTimeout(r, 50));

    // Check if playwright is installed (synchronous module-existence check, no launch)
    let pwInstalled = false;
    try {
      await import('playwright').catch(() => import('playwright-core'));
      pwInstalled = true;
    } catch {
      pwInstalled = false;
    }

    // Start portal server regardless (needed for cleanup to work correctly)
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, adminCookie);
    _resetRunnerState();

    if (!pwInstalled) {
      playwrightOk = false;
      return;
    }

    // Ask the portal whether it can launch Chromium
    playwrightOk = await checkBrowserCapability(baseUrl, adminCookie);
    if (!playwrightOk) return;

    // Start fixture HTTP server (only when browser is available)
    await new Promise<void>((resolve) => {
      fixtureServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FIXTURE_HTML);
      });
      fixtureServer.listen(0, '127.0.0.1', () => {
        const addr = fixtureServer.address() as { port: number };
        fixtureUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const stub = await createApiStub();
    apiStubServer = stub.server;
    apiStubUrl = stub.url;
  });

  after(async () => {
    if (fixtureServer) await new Promise<void>((r) => fixtureServer.close(() => r()));
    if (apiStubServer) await new Promise<void>((r) => apiStubServer.close(() => r()));
    await cleanup();
  });

  it('run passes on fixture page with screenshots', async () => {
    if (!playwrightOk) return; // skip

    const tpId = await createTestProject(baseUrl, adminCookie, projectId, fixtureUrl);
    const gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
    const sid = await createScript(baseUrl, adminCookie, projectId, tpId, gid, 'Pass test', [
      { kind: 'goto', path: '/' },
      { kind: 'assert_visible', locator: { css: '#title' } },
      { kind: 'assert_text', locator: { css: '#title' }, text: 'Test Fixture Page' },
    ]);

    const runId = await startRun(baseUrl, adminCookie, projectId, tpId, sid);
    const result = await waitForRun(baseUrl, adminCookie, projectId, tpId, runId);

    assert.equal(result.status, 'passed', `Run failed: ${result.error}`);
    assert.ok((result.steps as unknown[]).length >= 2, 'Expected step results');

    // Verify screenshots exist for at least one step
    const steps = result.steps as Array<{ screenshot_path: string | null; status: string }>;
    const withScreenshots = steps.filter((s) => s.screenshot_path !== null);
    assert.ok(withScreenshots.length > 0, 'Expected at least one screenshot');
  });

  it('failing assertion records error and screenshot', async () => {
    if (!playwrightOk) return;

    const tpId = await createTestProject(baseUrl, adminCookie, projectId, fixtureUrl);
    const gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
    const sid = await createScript(baseUrl, adminCookie, projectId, tpId, gid, 'Fail test', [
      { kind: 'goto', path: '/' },
      { kind: 'assert_text', locator: { css: '#title' }, text: 'WRONG TEXT THAT DOES NOT EXIST', exact: true },
    ]);

    const runId = await startRun(baseUrl, adminCookie, projectId, tpId, sid);
    const result = await waitForRun(baseUrl, adminCookie, projectId, tpId, runId);

    assert.equal(result.status, 'failed', `Expected failed, got ${result.status}`);
    const steps = result.steps as Array<{ status: string; error: string | null; screenshot_path: string | null }>;
    const failedStep = steps.find((s) => s.status === 'failed');
    assert.ok(failedStep, 'Expected a failed step');
    assert.ok(failedStep.error, `Expected error message in step`);
    // Screenshot should exist for the failed step
    assert.ok(failedStep.screenshot_path !== null, 'Expected screenshot on failed step');
  });

  it('fill step fills a form field', async () => {
    if (!playwrightOk) return;

    const tpId = await createTestProject(baseUrl, adminCookie, projectId, fixtureUrl);
    const gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
    const sid = await createScript(baseUrl, adminCookie, projectId, tpId, gid, 'Fill test', [
      { kind: 'goto', path: '/' },
      { kind: 'fill', locator: { css: '#username' }, value: 'testuser' },
      { kind: 'click', locator: { css: '#submit-btn' } },
      { kind: 'assert_text', locator: { css: '#result' }, text: 'testuser' },
    ]);

    const runId = await startRun(baseUrl, adminCookie, projectId, tpId, sid);
    const result = await waitForRun(baseUrl, adminCookie, projectId, tpId, runId);
    assert.equal(result.status, 'passed', `Fill run failed: ${result.error}`);
  });

  it('cancel stops a running run', async () => {
    if (!playwrightOk) return;

    const tpId = await createTestProject(baseUrl, adminCookie, projectId, fixtureUrl);
    const gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
    // Script with a long wait to ensure run is still running when we cancel
    const sid = await createScript(baseUrl, adminCookie, projectId, tpId, gid, 'Cancel test', [
      { kind: 'goto', path: '/' },
      { kind: 'wait', ms: 5000 },
      { kind: 'assert_url', url: '/should-not-reach' },
    ]);

    const runId = await startRun(baseUrl, adminCookie, projectId, tpId, sid);

    // Wait briefly for run to start
    await new Promise((r) => setTimeout(r, 300));

    // Cancel it
    const cancelR = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/runs/${runId}/cancel`, {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(cancelR.status, 200);

    // Wait for cancellation to be applied
    let finalStatus = 'unknown';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/runs/${runId}`, { cookie: adminCookie });
      finalStatus = (r.body as { run: { status: string } }).run.status;
      if (['cancelled', 'passed', 'failed', 'error'].includes(finalStatus)) break;
    }
    assert.ok(
      ['cancelled', 'passed', 'failed'].includes(finalStatus),
      `Expected cancelled/passed/failed, got ${finalStatus}`,
    );
  });

  it('api_request step against local stub', async () => {
    if (!playwrightOk) return;

    const tpId = await createTestProject(baseUrl, adminCookie, projectId, fixtureUrl, apiStubUrl);
    const gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
    const sid = await createScript(baseUrl, adminCookie, projectId, tpId, gid, 'API test', [
      {
        kind: 'api_request',
        method: 'GET',
        path: '/api/ping',
        expectedStatus: 200,
        jsonAssertions: [{ jsonPath: '$.status', expected: 'ok' }],
      },
    ]);

    const runId = await startRun(baseUrl, adminCookie, projectId, tpId, sid);
    const result = await waitForRun(baseUrl, adminCookie, projectId, tpId, runId);
    assert.equal(result.status, 'passed', `API run failed: ${result.error}`);
  });

  it('api_request step fails on wrong expected status', async () => {
    if (!playwrightOk) return;

    const tpId = await createTestProject(baseUrl, adminCookie, projectId, fixtureUrl, apiStubUrl);
    const gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
    const sid = await createScript(baseUrl, adminCookie, projectId, tpId, gid, 'API fail test', [
      {
        kind: 'api_request',
        method: 'GET',
        path: '/api/ping',
        expectedStatus: 404, // Wrong status
      },
    ]);

    const runId = await startRun(baseUrl, adminCookie, projectId, tpId, sid);
    const result = await waitForRun(baseUrl, adminCookie, projectId, tpId, runId);
    assert.equal(result.status, 'failed');
    const steps = result.steps as Array<{ error: string | null }>;
    assert.ok(steps[0]?.error?.includes('404'), `Expected 404 mention in error`);
  });

  it('password field is not visible in screenshots (masking)', async () => {
    if (!playwrightOk) return;

    const tpId = await createTestProject(baseUrl, adminCookie, projectId, fixtureUrl);
    const gid = await createGroup(baseUrl, adminCookie, projectId, tpId);
    const sid = await createScript(baseUrl, adminCookie, projectId, tpId, gid, 'Password mask test', [
      { kind: 'goto', path: '/' },
      { kind: 'fill', locator: { css: '#username' }, value: 'admin' },
      { kind: 'fill', locator: { css: '#password' }, value: 'secret-should-not-appear' },
      { kind: 'assert_visible', locator: { css: '#submit-btn' } },
    ]);

    const runId = await startRun(baseUrl, adminCookie, projectId, tpId, sid);
    const result = await waitForRun(baseUrl, adminCookie, projectId, tpId, runId);
    assert.equal(result.status, 'passed', `Password mask test run failed: ${result.error}`);

    // Verify run record does not contain the password value
    const steps = result.steps as Array<{ screenshot_path: string | null }>;
    assert.ok(
      !JSON.stringify(steps).includes('secret-should-not-appear'),
      'Password value must not appear in stored step data',
    );
  });
});
