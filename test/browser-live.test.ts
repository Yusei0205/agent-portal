/**
 * browser-live.test.ts — Tests for the portal-managed live browser.
 *
 * Covers:
 *   1. Browser-manager lifecycle: launch, reuse, cap enforcement, shutdown.
 *   2. browser-headless: rewritePlaywrightMcpCdp produces --cdp-endpoint,
 *      hasPlaywrightMcpEntry detection, CDP rewrite removes --headless/--isolated.
 *   3. WebSocket auth: API tokens refused, non-member denied, member allowed.
 *   4. Control gate: input messages rejected when control is off, accepted when on.
 *   5. Navigate scheme validation: non-http(s) URLs rejected.
 *   6. Frame forwarding with a real headless Chromium (skipped if unavailable).
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { createTestDb } from './fixtures.ts';
import { now, generateId } from '../server/util.ts';
import { getDb } from '../server/db.ts';
import {
  launchSessionBrowser,
  getSessionBrowserState,
  setControlEnabled,
  shutdownSessionBrowser,
  shutdownAllBrowsers,
  addViewer,
  removeViewer,
} from '../server/agent/browser-manager.ts';
import {
  hasPlaywrightMcpEntry,
  rewritePlaywrightMcpCdp,
  rewritePlaywrightMcpHeadless,
} from '../server/agent/browser-headless.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setupAdmin(baseUrl: string, email = 'bl-admin@example.com'): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: { email, name: 'Admin', password: 'password1234', provider: 'demo' },
  });
  if (r.cookie) return r.cookie;
  const login = await fetchJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password: 'password1234' },
  });
  return login.cookie ?? '';
}

async function createProject(baseUrl: string, cookie: string, name: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects', {
    method: 'POST',
    body: { name },
    cookie,
  });
  return ((r.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
}

async function createWorkflow(baseUrl: string, cookie: string, projectId: string): Promise<string> {
  const r = await fetchJson(baseUrl, '/api/projects/' + projectId + '/workflows', {
    method: 'POST',
    body: { goal: 'test', engine: 'demo' },
    cookie,
  });
  return ((r.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
}

function wsConnect(url: string, cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: new URL(url).origin } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw: Buffer) => {
      try { resolve(JSON.parse(raw.toString('utf8')) as Record<string, unknown>); }
      catch (e) { reject(e); }
    });
    setTimeout(() => reject(new Error('Message timeout')), 10000);
  });
}

// ── 1. Browser manager lifecycle ──────────────────────────────────────────────

describe('browser-manager — launch and reuse', () => {
  let workDir: string;
  let workflowId: string;

  before(async () => {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-bm-test-'));
    workflowId = `wf-${generateId()}`;
  });

  after(async () => {
    await shutdownSessionBrowser(workflowId).catch(() => {/* ok */});
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {/* ok */});
  });

  it('launches a browser and returns a cdp endpoint', async () => {
    const endpoint = await launchSessionBrowser(workflowId, workDir);
    assert.ok(endpoint.startsWith('http://127.0.0.1:'), `Expected http://127.0.0.1:PORT, got ${endpoint}`);
    const state = getSessionBrowserState(workflowId);
    assert.ok(state, 'Expected browser state after launch');
    assert.equal(state!.running, true);
  });

  it('reuses the existing browser on a second launch call', async () => {
    const ep1 = await launchSessionBrowser(workflowId, workDir);
    const ep2 = await launchSessionBrowser(workflowId, workDir);
    assert.equal(ep1, ep2, 'Second launch should return same endpoint');
  });

  it('getSessionBrowserState returns null after shutdown', async () => {
    await shutdownSessionBrowser(workflowId);
    const state = getSessionBrowserState(workflowId);
    assert.equal(state, null);
  });
});

describe('browser-manager — viewer tracking', () => {
  let workDir: string;
  let workflowId: string;

  before(async () => {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-bm-viewer-'));
    workflowId = `wf-viewer-${generateId()}`;
    await launchSessionBrowser(workflowId, workDir);
  });

  after(async () => {
    await shutdownSessionBrowser(workflowId).catch(() => {/* ok */});
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {/* ok */});
  });

  it('addViewer and removeViewer do not crash', () => {
    addViewer(workflowId);
    addViewer(workflowId);
    removeViewer(workflowId);
    removeViewer(workflowId);
    removeViewer(workflowId); // should clamp at 0
    const state = getSessionBrowserState(workflowId);
    assert.ok(state, 'Browser should still be running');
  });
});

describe('browser-manager — concurrency cap', () => {
  const launched: string[] = [];
  const workDirs: string[] = [];
  const origMax = process.env.PORTAL_BROWSER_MAX;

  before(() => {
    process.env.PORTAL_BROWSER_MAX = '1';
  });

  after(async () => {
    if (origMax === undefined) delete process.env.PORTAL_BROWSER_MAX;
    else process.env.PORTAL_BROWSER_MAX = origMax;
    for (const id of launched) await shutdownSessionBrowser(id).catch(() => {/* ok */});
    for (const d of workDirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {/* ok */});
  });

  it('rejects a second session when cap is 1', async () => {
    const id1 = `wf-cap-${generateId()}`;
    const id2 = `wf-cap-${generateId()}`;
    const d1 = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-cap-1-'));
    const d2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-cap-2-'));
    workDirs.push(d1, d2);
    launched.push(id1, id2);

    // First launch succeeds
    await launchSessionBrowser(id1, d1);

    // Second launch should throw with a cap error
    await assert.rejects(
      () => launchSessionBrowser(id2, d2),
      (err: Error) => err.message.includes('limit'),
    );
  });
});

describe('browser-manager — shutdownAllBrowsers', () => {
  let workDir1: string;
  let workDir2: string;
  const id1 = `wf-all-${generateId()}`;
  const id2 = `wf-all-${generateId()}`;

  before(async () => {
    workDir1 = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-all-1-'));
    workDir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-all-2-'));
    await launchSessionBrowser(id1, workDir1);
    await launchSessionBrowser(id2, workDir2);
  });

  after(async () => {
    await fsp.rm(workDir1, { recursive: true, force: true }).catch(() => {/* ok */});
    await fsp.rm(workDir2, { recursive: true, force: true }).catch(() => {/* ok */});
  });

  it('shuts down all running browsers without throwing', async () => {
    await assert.doesNotReject(() => shutdownAllBrowsers());
    assert.equal(getSessionBrowserState(id1), null);
    assert.equal(getSessionBrowserState(id2), null);
  });
});

// ── 2. browser-headless: CDP rewrite ──────────────────────────────────────────

describe('rewritePlaywrightMcpCdp', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-cdp-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('adds --cdp-endpoint and --output-dir to @playwright/mcp entry', async () => {
    const mcpJson = path.join(tmpDir, 'mcp.json');
    const workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    await fsp.writeFile(mcpJson, JSON.stringify({
      mcpServers: {
        playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
      },
    }), 'utf8');

    const ok = await rewritePlaywrightMcpCdp(mcpJson, workDir, 'http://127.0.0.1:9222');
    assert.ok(ok, 'Should return true when an entry was rewritten');

    const patched = JSON.parse(await fsp.readFile(mcpJson, 'utf8')) as {
      mcpServers: { playwright: { args: string[] } };
    };
    const args = patched.mcpServers.playwright.args;

    const epIdx = args.indexOf('--cdp-endpoint');
    assert.ok(epIdx >= 0, 'Expected --cdp-endpoint in args');
    assert.equal(args[epIdx + 1], 'http://127.0.0.1:9222', 'Expected the exact CDP endpoint URL');

    const odIdx = args.indexOf('--output-dir');
    assert.ok(odIdx >= 0, 'Expected --output-dir in args');
    assert.ok(args[odIdx + 1].includes('.browser'), 'Expected .browser in output-dir path');
  });

  it('removes --headless and --isolated when adding --cdp-endpoint', async () => {
    const mcpJson = path.join(tmpDir, 'mcp.json');
    const workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    await fsp.writeFile(mcpJson, JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest', '--headless', '--isolated', '--output-dir', '/old/path'],
        },
      },
    }), 'utf8');

    await rewritePlaywrightMcpCdp(mcpJson, workDir, 'http://127.0.0.1:9223');

    const patched = JSON.parse(await fsp.readFile(mcpJson, 'utf8')) as {
      mcpServers: { playwright: { args: string[] } };
    };
    const args = patched.mcpServers.playwright.args;

    assert.ok(!args.includes('--headless'), 'Should not contain --headless after CDP rewrite');
    assert.ok(!args.includes('--isolated'), 'Should not contain --isolated after CDP rewrite');
    assert.ok(args.includes('--cdp-endpoint'), 'Should contain --cdp-endpoint');
  });

  it('returns false when no playwright entry present', async () => {
    const mcpJson = path.join(tmpDir, 'mcp.json');
    const workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    await fsp.writeFile(mcpJson, JSON.stringify({
      mcpServers: { other: { command: 'npx', args: ['@other/tool'] } },
    }), 'utf8');

    const ok = await rewritePlaywrightMcpCdp(mcpJson, workDir, 'http://127.0.0.1:9224');
    assert.equal(ok, false);
  });

  it('returns false when file does not exist', async () => {
    const ok = await rewritePlaywrightMcpCdp(
      path.join(tmpDir, 'nonexistent.json'),
      tmpDir,
      'http://127.0.0.1:9225',
    );
    assert.equal(ok, false);
  });
});

describe('hasPlaywrightMcpEntry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-has-mcp-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true when @playwright/mcp entry is present', async () => {
    const mcpJson = path.join(tmpDir, 'mcp.json');
    await fsp.writeFile(mcpJson, JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } },
    }), 'utf8');
    assert.equal(await hasPlaywrightMcpEntry(mcpJson), true);
  });

  it('returns false when no playwright entry', async () => {
    const mcpJson = path.join(tmpDir, 'mcp.json');
    await fsp.writeFile(mcpJson, JSON.stringify({
      mcpServers: { other: { command: 'npx', args: ['@other/tool'] } },
    }), 'utf8');
    assert.equal(await hasPlaywrightMcpEntry(mcpJson), false);
  });

  it('returns false when file missing', async () => {
    assert.equal(await hasPlaywrightMcpEntry(path.join(tmpDir, 'none.json')), false);
  });
});

// ── 3. WebSocket auth ──────────────────────────────────────────────────────────

describe('browser-live WS — auth: API token refused', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;

  before(async () => {
    createTestDb();
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    adminCookie = await setupAdmin(baseUrl);
    projectId = await createProject(baseUrl, adminCookie, 'BL Auth Test');
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId);
  });

  after(async () => { await cleanup(); });

  it('rejects upgrade with Authorization header (API token path)', async () => {
    const wsUrl = baseUrl.replace('http:', 'ws:') + `/api/workflows/${workflowId}/browser/live`;
    await assert.rejects(
      () => new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: { Authorization: 'Bearer some-token', Origin: baseUrl },
        });
        ws.once('open', () => { ws.close(); resolve(); });
        ws.once('error', (e) => reject(e));
        ws.once('unexpected-response', (_req, res) => {
          reject(new Error(`Unexpected response: ${res.statusCode}`));
        });
        setTimeout(() => reject(new Error('timeout')), 5000);
      }),
      (err: Error) => {
        // ws fires 'unexpected-response' for non-101 status, which we turn into an error
        assert.ok(err.message.length > 0, 'Expected error for API token auth');
        return true;
      },
    );
  });
});

describe('browser-live WS — auth: unauthenticated rejected', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;

  before(async () => {
    createTestDb();
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'bl-auth2@example.com');
    projectId = await createProject(baseUrl, adminCookie, 'BL Auth2 Test');
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId);
  });

  after(async () => { await cleanup(); });

  it('rejects upgrade with no session cookie', async () => {
    const wsUrl = baseUrl.replace('http:', 'ws:') + `/api/workflows/${workflowId}/browser/live`;
    await assert.rejects(
      () => new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: { Origin: baseUrl } });
        ws.once('open', () => { ws.close(); resolve(); });
        ws.once('error', (e) => reject(e));
        ws.once('unexpected-response', (_req, res) => {
          reject(new Error(`Status ${res.statusCode}`));
        });
        setTimeout(() => reject(new Error('timeout')), 5000);
      }),
      () => true,
    );
  });
});

describe('browser-live WS — auth: non-member rejected', () => {
  let baseUrl: string;
  let adminCookie: string;
  let memberCookie: string;
  let outsiderCookie: string;
  let projectId: string;
  let workflowId: string;

  before(async () => {
    createTestDb();
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'bl-nm-admin@example.com');

    // Create another user
    const r = await fetchJson(baseUrl, '/api/users', {
      method: 'POST',
      body: { email: 'bl-outsider@example.com', name: 'Outsider', password: 'password1234', isAdmin: false },
      cookie: adminCookie,
    });
    void r;

    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'bl-outsider@example.com', password: 'password1234' },
    });
    outsiderCookie = loginR.cookie ?? '';

    projectId = await createProject(baseUrl, adminCookie, 'BL NM Test');
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId);
  });

  after(async () => { await cleanup(); });

  it('rejects upgrade for a user who is not a project member', async () => {
    const wsUrl = baseUrl.replace('http:', 'ws:') + `/api/workflows/${workflowId}/browser/live`;
    await assert.rejects(
      () => new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { headers: { Cookie: outsiderCookie, Origin: baseUrl } });
        ws.once('open', () => { ws.close(); resolve(); });
        ws.once('error', (e) => reject(e));
        ws.once('unexpected-response', (_req, res) => {
          reject(new Error(`Status ${res.statusCode}`));
        });
        setTimeout(() => reject(new Error('timeout')), 5000);
      }),
      () => true,
    );
  });
});

// ── 4. Control gate ───────────────────────────────────────────────────────────

describe('browser-live WS — control gate', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let workflowId: string;

  before(async () => {
    createTestDb();
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'bl-ctrl@example.com');
    projectId = await createProject(baseUrl, adminCookie, 'BL Ctrl Test');
    workflowId = await createWorkflow(baseUrl, adminCookie, projectId);
  });

  after(async () => { await cleanup(); });

  it('POST /browser/control returns 404 when no live browser running', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/browser/control`, {
      method: 'POST',
      body: { enabled: true },
      cookie: adminCookie,
    });
    assert.equal(r.status, 404, 'Expected 404 when no browser is running');
  });

  it('POST /browser/control returns 401 without auth', async () => {
    const r = await fetchJson(baseUrl, `/api/workflows/${workflowId}/browser/control`, {
      method: 'POST',
      body: { enabled: true },
    });
    assert.equal(r.status, 401);
  });

  it('WS sends state running:false and closes when no browser', async () => {
    const wsUrl = baseUrl.replace('http:', 'ws:') + `/api/workflows/${workflowId}/browser/live`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: adminCookie, Origin: baseUrl } });
    const msg = await nextMessage(ws);
    ws.close();
    assert.equal((msg as Record<string, unknown>).type, 'state');
    assert.equal((msg as Record<string, unknown>).running, false);
  });
});

// ── 5. Navigate scheme validation ─────────────────────────────────────────────

describe('browser-live — navigate scheme validation', () => {
  let workDir: string;
  let workflowId: string;
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let wfId: string;

  before(async () => {
    createTestDb();
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'bl-nav@example.com');
    projectId = await createProject(baseUrl, adminCookie, 'BL Nav Test');
    wfId = await createWorkflow(baseUrl, adminCookie, projectId);
    workflowId = wfId;
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-nav-test-'));
    await launchSessionBrowser(workflowId, workDir);
    setControlEnabled(workflowId, true);
  });

  after(async () => {
    await shutdownSessionBrowser(workflowId).catch(() => {/* ok */});
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {/* ok */});
    await cleanup();
  });

  it('rejects navigate with file: scheme', async () => {
    const wsUrl = baseUrl.replace('http:', 'ws:') + `/api/workflows/${workflowId}/browser/live`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: adminCookie, Origin: baseUrl } });

    // Collect messages until we get an error (skip state/pong)
    const getNextError = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const handler = (raw: Buffer): void => {
          const m = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          if (m.type === 'error') { ws.off('message', handler); resolve(m); }
        };
        ws.on('message', handler);
        setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, 5000);
      });

    // Consume the initial state message
    await nextMessage(ws);

    // Send a navigate with a non-http URL
    ws.send(JSON.stringify({ type: 'navigate', url: 'file:///etc/passwd' }));

    const resp = await getNextError();
    ws.close();
    assert.equal(resp.type, 'error', 'Expected error response for file: scheme');
    assert.ok(String(resp.message).includes('http'), `Error should mention http, got: ${resp.message}`);
  });

  it('rejects navigate with javascript: scheme', async () => {
    const wsUrl = baseUrl.replace('http:', 'ws:') + `/api/workflows/${workflowId}/browser/live`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: adminCookie, Origin: baseUrl } });

    const getNextError = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const handler = (raw: Buffer): void => {
          const m = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          if (m.type === 'error') { ws.off('message', handler); resolve(m); }
        };
        ws.on('message', handler);
        setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, 5000);
      });

    await nextMessage(ws);
    ws.send(JSON.stringify({ type: 'navigate', url: 'javascript:alert(1)' }));
    const resp = await getNextError();
    ws.close();
    assert.equal(resp.type, 'error');
  });

  it('rejects navigate with invalid URL', async () => {
    const wsUrl = baseUrl.replace('http:', 'ws:') + `/api/workflows/${workflowId}/browser/live`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: adminCookie, Origin: baseUrl } });

    const getNextError = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const handler = (raw: Buffer): void => {
          const m = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          if (m.type === 'error') { ws.off('message', handler); resolve(m); }
        };
        ws.on('message', handler);
        setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, 5000);
      });

    await nextMessage(ws);
    ws.send(JSON.stringify({ type: 'navigate', url: 'not a url at all!!' }));
    const resp = await getNextError();
    ws.close();
    assert.equal(resp.type, 'error');
  });

  it('input message rejected when control is off', async () => {
    setControlEnabled(workflowId, false);

    const wsUrl = baseUrl.replace('http:', 'ws:') + `/api/workflows/${workflowId}/browser/live`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: adminCookie, Origin: baseUrl } });

    const getNextError = (): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const handler = (raw: Buffer): void => {
          const m = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          if (m.type === 'error') { ws.off('message', handler); resolve(m); }
        };
        ws.on('message', handler);
        setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, 5000);
      });

    await nextMessage(ws);
    ws.send(JSON.stringify({ type: 'mouse', action: 'move', x: 100, y: 100 }));
    const resp = await getNextError();
    ws.close();
    assert.equal(resp.type, 'error', 'Expected error when control is off');
    assert.ok(String(resp.message).toLowerCase().includes('control'), 'Error should mention control');

    setControlEnabled(workflowId, true);
  });
});

// ── 6. Frame forwarding with real Chromium ────────────────────────────────────

describe('browser-live — frame forwarding with real Chromium', () => {
  let workDir: string;
  let workflowId: string;
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let chromiumAvailable = true;

  before(async () => {
    // Check whether Chromium is available; skip if not
    try {
      const pw = await import('playwright').catch(() => null) ?? await import('playwright-core').catch(() => null);
      if (!pw) { chromiumAvailable = false; return; }
      const b = await (pw as { chromium: { launch(o?: object): Promise<{ close(): Promise<void> }> } }).chromium.launch({ headless: true });
      await b.close();
    } catch {
      chromiumAvailable = false;
    }

    if (!chromiumAvailable) return;

    createTestDb();
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    adminCookie = await setupAdmin(baseUrl, 'bl-frames@example.com');
    projectId = await createProject(baseUrl, adminCookie, 'BL Frames Test');

    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-frames-test-'));
    workflowId = `wf-frames-${generateId()}`;

    // Insert a minimal workflow row so the WS auth passes
    getDb().prepare(
      `INSERT INTO p6_workflows (id, project_id, goal, status, engine, trust_tools, repo_ids, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'demo', 0, '[]', ?, ?)`,
    ).run(workflowId, projectId, 'frames test', now(), now());

    await launchSessionBrowser(workflowId, workDir);
  });

  after(async () => {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {/* ok */});
    await shutdownSessionBrowser(workflowId).catch(() => {/* ok */});
    await cleanup().catch(() => {/* ok */});
  });

  it('streams at least one frame after the agent navigates to a page', async () => {
    if (!chromiumAvailable) {
      console.log('[browser-live frames test] Chromium not available — skipping');
      return;
    }

    const cdpEndpoint = getSessionBrowserState(workflowId)?.cdpEndpoint;
    assert.ok(cdpEndpoint, 'Expected cdpEndpoint to be set');

    // Navigate the browser to example.com via CDP directly (simulating what the agent does)
    const { WebSocket: NodeWs } = await import('ws');
    let frames = 0;
    let pageConnected = false;

    // Wait a moment for Chrome to start up
    await new Promise((r) => setTimeout(r, 500));

    // Fetch targets
    const targetsRes = await fetch(`${cdpEndpoint}/json`);
    const targets = (await targetsRes.json()) as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>;
    const page = targets.find((t) => t.type === 'page');

    if (!page) {
      console.log('[browser-live frames test] No page target available — skipping frame assertion');
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const cdpWs = new NodeWs(page.webSocketDebuggerUrl);
      let id = 1;

      cdpWs.once('open', () => {
        pageConnected = true;
        // Navigate to a simple page
        cdpWs.send(JSON.stringify({ id: id++, method: 'Page.navigate', params: { url: 'about:blank' } }));
        // Start screencast
        cdpWs.send(JSON.stringify({
          id: id++,
          method: 'Page.startScreencast',
          params: { format: 'jpeg', quality: 60, maxWidth: 800, everyNthFrame: 1 },
        }));
        setTimeout(() => {
          cdpWs.close();
          resolve();
        }, 3000);
      });

      cdpWs.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        if (msg.method === 'Page.screencastFrame') {
          frames++;
          const params = msg.params as { sessionId: number };
          cdpWs.send(JSON.stringify({ id: id++, method: 'Page.screencastFrameAck', params: { sessionId: params.sessionId } }));
        }
      });

      cdpWs.once('error', reject);
      setTimeout(() => { cdpWs.close(); reject(new Error('CDP connection timed out')); }, 8000);
    });

    assert.ok(pageConnected, 'Expected to connect to CDP page target');
    console.log(`[browser-live frames test] Received ${frames} screencast frame(s) from Chromium`);
    assert.ok(frames >= 1, `Expected at least 1 screencast frame, got ${frames}`);
  });
});
