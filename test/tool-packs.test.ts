/**
 * Unit tests for server/tool-packs.ts (Task 4).
 *
 * All detection is tested via injected fakes — no real tools or network needed.
 * All server module imports are LAZY (inside before()/test()) so that config.ts
 * is loaded only after DATA_DIR is set by bootServer().
 *
 * Coverage:
 *   - uv: present / missing
 *   - kiro: present / missing
 *   - browser: URL unset / unreachable / reachable
 *   - cache clears between tests
 *   - GET /api/tools route (auth required, returns packs)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import type { CommandRunner, HttpProbe, ToolPack } from '../server/tool-packs.ts';

// Test state (populated in before()).
let getToolPacks: (run?: CommandRunner, probe?: HttpProbe) => Promise<ToolPack[]>;
let clearPackCache: () => void;
let srvClose: () => Promise<void>;
let srvBase = '';
let signedInCookie = '';
let savedBrowserUrl: string | undefined;

before(async () => {
  savedBrowserUrl = process.env.PORTAL_BROWSER_MCP_URL;
  delete process.env.PORTAL_BROWSER_MCP_URL;

  // bootServer() sets DATA_DIR before importing server modules, so config.ts loads with the right value.
  const { bootServer, Client } = await import('./client.ts');
  const srv = await bootServer();
  srvBase = srv.base;
  srvClose = srv.close;

  // Lazy-import tool-packs AFTER bootServer() so config.ts uses the right DATA_DIR.
  const tp = await import('../server/tool-packs.ts');
  getToolPacks = tp.getToolPacks;
  clearPackCache = tp.clearPackCache;

  // Set up an admin user.
  const c = new Client(srvBase);
  await c.post('/api/auth/setup', {
    email: 'toolpacks@example.com',
    name: 'ToolPacks',
    password: 'a-long-password-tp-01',
  });
  signedInCookie = c.cookie;
});

after(async () => {
  await srvClose();
  if (savedBrowserUrl !== undefined) process.env.PORTAL_BROWSER_MCP_URL = savedBrowserUrl;
  else delete process.env.PORTAL_BROWSER_MCP_URL;
});

// ── helpers ────────────────────────────────────────────────────────────────

/** A runner that makes the given command names appear present or absent. */
function makeRunner(present: string[]): CommandRunner {
  return async (cmd) => {
    if (present.some((p) => cmd.endsWith(p))) return { ok: true, output: `${cmd} 1.0.0` };
    return { ok: false, output: 'not found' };
  };
}

/** A probe that returns ok for listed URLs. */
function makeProbe(reachable: string[]): HttpProbe {
  return async (url) => ({ ok: reachable.includes(url) });
}

// ── uv ─────────────────────────────────────────────────────────────────────

test('tool-packs: uv reports available when uvx is present', async () => {
  clearPackCache();
  const packs = await getToolPacks(makeRunner(['uvx']), makeProbe([]));
  const uv = packs.find((p) => p.id === 'uv')!;
  assert.ok(uv, 'uv pack should be present');
  assert.equal(uv.status, 'available');
  assert.match(uv.reason, /uvx found/);
});

test('tool-packs: uv reports missing when uvx is absent', async () => {
  clearPackCache();
  const packs = await getToolPacks(makeRunner([]), makeProbe([]));
  const uv = packs.find((p) => p.id === 'uv')!;
  assert.equal(uv.status, 'missing');
  assert.match(uv.reason, /not found/);
  assert.match(uv.hint, /Settings/);
});

// ── kiro ────────────────────────────────────────────────────────────────────

test('tool-packs: kiro reports available when kiro-cli is present', async () => {
  clearPackCache();
  const packs = await getToolPacks(makeRunner(['kiro-cli']), makeProbe([]));
  const kiro = packs.find((p) => p.id === 'kiro')!;
  assert.ok(kiro, 'kiro pack should be present');
  assert.equal(kiro.status, 'available');
  assert.match(kiro.reason, /kiro-cli found/);
});

test('tool-packs: kiro reports missing when kiro-cli is absent', async () => {
  clearPackCache();
  const packs = await getToolPacks(makeRunner([]), makeProbe([]));
  const kiro = packs.find((p) => p.id === 'kiro')!;
  assert.equal(kiro.status, 'missing');
  assert.match(kiro.reason, /not found/);
  assert.match(kiro.hint, /Settings/);
});

// ── browser ─────────────────────────────────────────────────────────────────

test('tool-packs: browser reports not configured when URL is unset', async () => {
  delete process.env.PORTAL_BROWSER_MCP_URL;
  clearPackCache();
  const packs = await getToolPacks(makeRunner([]), makeProbe([]));
  const browser = packs.find((p) => p.id === 'browser')!;
  assert.equal(browser.status, 'not configured');
  assert.match(browser.reason, /not set/);
  assert.match(browser.hint, /docker compose/);
});

test('tool-packs: browser reports missing when URL is set but unreachable', async () => {
  process.env.PORTAL_BROWSER_MCP_URL = 'http://localhost:59999/mcp';
  clearPackCache();
  const packs = await getToolPacks(makeRunner([]), makeProbe([]));   // probe returns false for all
  const browser = packs.find((p) => p.id === 'browser')!;
  assert.equal(browser.status, 'missing');
  assert.match(browser.reason, /not reachable/);
  assert.match(browser.hint, /docker compose/);
  delete process.env.PORTAL_BROWSER_MCP_URL;
});

test('tool-packs: browser reports available when URL is reachable', async () => {
  const url = 'http://localhost:59998/mcp';
  process.env.PORTAL_BROWSER_MCP_URL = url;
  clearPackCache();
  const packs = await getToolPacks(makeRunner([]), makeProbe([url]));
  const browser = packs.find((p) => p.id === 'browser')!;
  assert.equal(browser.status, 'available');
  assert.match(browser.reason, /reachable/);
  delete process.env.PORTAL_BROWSER_MCP_URL;
});

// ── all three packs present ──────────────────────────────────────────────

test('tool-packs: returns all five packs', async () => {
  clearPackCache();
  const packs = await getToolPacks(makeRunner(['uvx', 'kiro-cli']), makeProbe([]));
  assert.equal(packs.length, 5, 'should return exactly 5 packs');
  assert.deepEqual(packs.map((p) => p.id).sort(), ['browser', 'docs', 'drawio', 'kiro', 'uv']);
});

// ── /api/tools route ────────────────────────────────────────────────────────

test('GET /api/tools returns packs for a signed-in user', async () => {
  clearPackCache();
  const { Client } = await import('./client.ts');

  // Authenticated user should get 200.
  const r = await fetch(`${srvBase}/api/tool-packs`, {
    headers: {
      'x-requested-with': 'agent-portal',
      cookie: signedInCookie,
    },
  });
  const bodyText = await r.text();
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${bodyText}`);
  const body = JSON.parse(bodyText) as { packs: { id: string }[] };
  assert.ok(Array.isArray(body.packs), `packs should be an array, got: ${bodyText}`);
  assert.ok(body.packs.length >= 3, 'should have at least 3 packs');

  // Unauthenticated request should get 401.
  const anon = new Client(srvBase);
  const unauth = await anon.req('GET', '/api/tool-packs');
  assert.equal(unauth.status, 401, 'unauthenticated request should be rejected');
});
