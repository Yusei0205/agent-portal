/**
 * Regression test: server startup ordering.
 *
 * Verifies that startServer() works when called against a fresh on-disk
 * database with NO DB opened beforehand — exactly the path taken by
 * `node dist/server.mjs`.
 *
 * Prior to the fix, initSettingsRepository() (step 3b) ran before
 * openDb() (step 4), causing:
 *   Error: Database not opened. Call openDb() first.
 *   at getDb → SqliteSettingsRepository.loadSnapshot → initSettingsRepository
 *
 * The fix moves openDb() to step 4 (before all repository inits), so
 * the database is always open before any repository queries it.
 */

// Prevent background git operations from spawning subprocesses in the test.
process.env.PORTAL_DISABLE_GIT_SYNC = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeDb, isDbOpen } from '../server/db.ts';
import { startServer } from '../server/index.ts';
import { createTestConfig, fetchJson } from './fixtures.ts';
import type http from 'node:http';

describe('Server startup ordering', () => {
  let server: http.Server;
  let baseUrl: string;
  let dataDir: string;

  before(async () => {
    // Simulate a cold start: no DB is opened before startServer() is called.
    // This mirrors exactly what happens when running `node dist/server.mjs`.
    if (isDbOpen()) closeDb();

    const cfg = createTestConfig();
    dataDir = cfg.dataDir;

    // Before the fix this threw:
    //   Error: Database not opened. Call openDb() first.
    server = await startServer({ port: 0, host: '127.0.0.1', config: cfg });

    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server?.closeAllConnections?.();
      server?.close(() => resolve());
    });
    if (isDbOpen()) closeDb();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('GET /api/health returns ok:true after cold start with no pre-opened DB', async () => {
    const r = await fetchJson(baseUrl, '/api/health');
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.db, 'ok');
  });

  it('GET /api/auth/state responds 200 after cold start', async () => {
    const r = await fetchJson(baseUrl, '/api/auth/state');
    assert.equal(r.status, 200);
    const body = r.body as Record<string, unknown>;
    // Fresh on-disk DB has no users — portal should be in first-run (setup) state.
    assert.equal(body.needsSetup, true);
    assert.equal(body.loggedIn, false);
  });
});
