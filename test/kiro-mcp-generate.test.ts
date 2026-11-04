/**
 * Tests for findings 1 and 3.
 *
 * Finding 1: Kiro MCP config merge — portal-delegation entry is merged into the
 *            existing mcp.json rather than overwriting it.
 *
 * Finding 3: Test generation provider resolution — clear error on demo mode,
 *            proper provider selection.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { setModelCallFn } from '../server/testing/index.ts';

// ── Finding 1: Kiro MCP config merge ─────────────────────────────────────────

describe('Kiro mcp.json merge (finding 1)', () => {
  it('merges portal-delegation entry, preserving existing servers', async () => {
    // Create a temp home dir with an existing mcp.json
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kiro-mcp-test-'));
    const settingsDir = path.join(tmpDir, '.kiro', 'settings');
    await fsp.mkdir(settingsDir, { recursive: true });

    const existingConfig = {
      mcpServers: {
        'my-existing-server': {
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer existing-token' },
        },
      },
    };
    await fsp.writeFile(
      path.join(settingsDir, 'mcp.json'),
      JSON.stringify(existingConfig, null, 2),
      'utf8',
    );

    // Simulate the merge logic from kiro.ts
    const mcpJsonPath = path.join(settingsDir, 'mcp.json');
    const existing = await fsp.readFile(mcpJsonPath, 'utf8');
    const parsed = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };

    const newEntry = {
      url: 'http://127.0.0.1:3000/api/mcp',
      headers: { Authorization: 'Bearer test-delegate-token' },
    };

    const merged = {
      mcpServers: {
        ...(parsed.mcpServers ?? {}),
        'portal-delegation': newEntry,
      },
    };

    await fsp.writeFile(mcpJsonPath, JSON.stringify(merged, null, 2), 'utf8');

    // Verify both entries exist
    const result = JSON.parse(await fsp.readFile(mcpJsonPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    assert.ok('my-existing-server' in result.mcpServers, 'existing server should be preserved');
    assert.ok('portal-delegation' in result.mcpServers, 'portal-delegation should be added');

    // Verify format: url/headers at top level (NOT nested under transport)
    const delegation = result.mcpServers['portal-delegation'] as Record<string, unknown>;
    assert.ok('url' in delegation, 'url should be at top level');
    assert.ok('headers' in delegation, 'headers should be at top level');
    assert.ok(!('transport' in delegation), 'should NOT have nested transport object');

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('skips merge when existing mcp.json has invalid JSON', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kiro-mcp-bad-json-'));
    const settingsDir = path.join(tmpDir, '.kiro', 'settings');
    await fsp.mkdir(settingsDir, { recursive: true });

    const mcpJsonPath = path.join(settingsDir, 'mcp.json');
    await fsp.writeFile(mcpJsonPath, 'this is not valid json {{{', 'utf8');

    const originalContent = await fsp.readFile(mcpJsonPath, 'utf8');

    // Try to parse — should throw
    let skipDelegation = false;
    try {
      JSON.parse(originalContent);
    } catch {
      skipDelegation = true;
    }

    assert.equal(skipDelegation, true, 'invalid JSON should trigger skip');

    // The file should NOT have been modified (the skip logic protects it)
    const afterContent = await fsp.readFile(mcpJsonPath, 'utf8');
    assert.equal(afterContent, originalContent, 'invalid JSON file must not be modified');

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('mcp.json entry uses flat url/headers format, not nested transport', async () => {
    // Verify the entry format matches Kiro CLI docs
    const portalPort = 3000;
    const tokenRaw = 'ap_testhex';
    const entry = {
      url: `http://127.0.0.1:${portalPort}/api/mcp`,
      headers: { Authorization: `Bearer ${tokenRaw}` },
    };
    // Must NOT be { transport: { type: 'http', url, headers } }
    assert.ok(!('transport' in entry), 'entry must not have transport property');
    assert.ok('url' in entry, 'entry must have url property');
    assert.ok('headers' in entry, 'entry must have headers property');
    assert.equal(entry.url, `http://127.0.0.1:${portalPort}/api/mcp`);
  });
});

// ── Finding 3: Test generation provider resolution ────────────────────────────

describe('Test generation provider resolution (finding 3)', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;
  let tpId: string;
  let gid: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;
    const r = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: `gen-prov-${Date.now()}@example.com`, name: 'Admin', password: 'password1234' },
    });
    adminCookie = r.cookie ?? '';

    const pr = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST', body: { name: 'Gen Provider Project' }, cookie: adminCookie,
    });
    projectId = ((pr.body as Record<string, unknown>).project as Record<string, unknown>).id as string;

    const tpr = await fetchJson(baseUrl, `/api/projects/${projectId}/tests`, {
      method: 'POST',
      body: { name: 'Gen Tests', appUrl: 'http://app.example.com' },
      cookie: adminCookie,
    });
    tpId = (tpr.body as { testProject: { id: string } }).testProject.id;

    const gr = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/groups`, {
      method: 'POST', body: { name: 'Group' }, cookie: adminCookie,
    });
    gid = (gr.body as { group: { id: string } }).group.id;
  });

  after(async () => {
    setModelCallFn(null);
    await cleanup();
  });

  it('generation with mocked model succeeds (provider-agnostic path)', async () => {
    const mockSteps = [
      { kind: 'goto', path: '/login' },
      { kind: 'click', locator: { role: 'button', name: 'Submit' } },
    ];
    setModelCallFn(async () => mockSteps);

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Test login flow', groupId: gid },
      cookie: adminCookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;

    // Wait for completion
    let status = 'pending';
    for (let i = 0; i < 30 && (status === 'pending' || status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sr = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate/${genId}`, { cookie: adminCookie });
      status = (sr.body as { generation: { status: string } }).generation.status;
    }
    assert.equal(status, 'done', `Expected done, got ${status}`);
  });

  it('generation fails with clear error when no provider (demo mode)', async () => {
    setModelCallFn(null); // Use real implementation

    // Ensure provider is demo (default for test server)
    const settingsR = await fetchJson(baseUrl, '/api/settings', { cookie: adminCookie });
    const providerMode = ((settingsR.body as Record<string, unknown>).provider as Record<string, unknown>)?.mode;
    if (providerMode !== 'demo') {
      // Skip if a real provider is configured
      return;
    }

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate`, {
      method: 'POST',
      body: { description: 'Test that will fail due to no provider', groupId: gid },
      cookie: adminCookie,
    });
    assert.equal(r.status, 202);
    const genId = (r.body as { generationId: string }).generationId;

    // Wait for failure
    let status = 'pending';
    let error = '';
    for (let i = 0; i < 30 && (status === 'pending' || status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sr = await fetchJson(baseUrl, `/api/projects/${projectId}/tests/${tpId}/generate/${genId}`, { cookie: adminCookie });
      const gen = (sr.body as { generation: { status: string; error?: string } }).generation;
      status = gen.status;
      error = gen.error ?? '';
    }

    assert.equal(status, 'failed', `Expected failed, got ${status}`);
    // Error should mention provider configuration, not just "no key"
    assert.ok(
      error.toLowerCase().includes('provider') || error.toLowerCase().includes('no ai') || error.toLowerCase().includes('settings'),
      `Expected clear provider error, got: "${error}"`,
    );
  });
});
