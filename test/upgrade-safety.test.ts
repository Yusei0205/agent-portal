/**
 * Stage 6 — Upgrade safety test
 *
 * Creates a temp DATA_DIR with the old-schema (v24) DB,
 * starts the new server against it, and confirms:
 *  - Migrations apply without error
 *  - Old admin can log in
 *  - Old project, sessions, and runs still load
 *  - New tables exist (loop_specs, audit_log, invitations)
 *  - New columns exist on old rows (workflows.locked_by, users.google_sub)
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { Client } from './client.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OLD_DB = path.resolve(__dirname, '../../agent-portal-old/test-data/portal.db');

describe('upgrade safety', () => {
  let base: string;
  let server: Server;
  let dataDir: string;
  let admin: Client;
  const oldDbExists = fs.existsSync(OLD_DB);

  before(async () => {
    if (!oldDbExists) {
      console.warn(`  [skip] Old DB not found at ${OLD_DB}`);
      return;
    }

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-upgrade-'));
    fs.copyFileSync(OLD_DB, path.join(dataDir, 'portal.db'));

    // Set env vars BEFORE importing the server
    process.env.DATA_DIR = dataDir;
    process.env.DEMO_SPEED = '0';
    process.env.PORTAL_NO_AUTOSTART = '1';
    process.env.PORTAL_SECRET_KEY = 'upgrade-test-key-aabbccdd1122334455667788aabbccdd';

    const { startServer } = await import('../server/index.ts');
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;

    admin = new Client(base);
    await admin.post('/api/auth/login', { email: 'admin@old.test', password: 'upgrade-test-pass' });
  });

  after(() =>
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  );

  test('old admin can log in after migration', async () => {
    if (!oldDbExists) return;
    const r = await admin.req('GET', '/api/auth/me');
    assert.equal(r.status, 200, 'old admin can authenticate after migration');
    assert.equal(r.data.user.email, 'admin@old.test');
  });

  test('old project is still listed', async () => {
    if (!oldDbExists) return;
    const r = await admin.get('/api/projects');
    assert.ok(
      r.projects.some((p: { id: string }) => p.id === 'p_old_001'),
      'old project still exists after migrations',
    );
  });

  test('old sessions (workflows) load from the list', async () => {
    if (!oldDbExists) return;
    const r = await admin.get('/api/projects/p_old_001/workflows');
    assert.ok(r.workflows.some((w: { id: string }) => w.id === 'w_old_001'), 'done session still accessible');
    assert.ok(r.workflows.some((w: { id: string }) => w.id === 'w_old_002'), 'paused session still accessible');
  });

  test('old session detail loads correctly', async () => {
    if (!oldDbExists) return;
    const r = await admin.get('/api/workflows/w_old_001');
    assert.equal(r.workflow.id, 'w_old_001');
    assert.equal(r.workflow.status, 'done');
    assert.equal(r.workflow.title, 'Old session');
  });

  test('new migration tables exist (loop_specs, audit_log, invitations)', async () => {
    if (!oldDbExists) return;
    const { one } = await import('../server/db.ts');
    assert.ok(typeof one('SELECT COUNT(*) as n FROM loop_specs')?.n === 'number', 'loop_specs table exists');
    assert.ok(typeof one('SELECT COUNT(*) as n FROM audit_log')?.n === 'number', 'audit_log table exists');
    assert.ok(typeof one('SELECT COUNT(*) as n FROM invitations')?.n === 'number', 'invitations table exists');
    assert.ok(typeof one('SELECT COUNT(*) as n FROM teams')?.n === 'number', 'teams table exists');
    assert.ok(typeof one('SELECT COUNT(*) as n FROM loop_run_states')?.n === 'number', 'loop_run_states table exists');
  });

  test('new columns exist on old rows (workflows.locked_by, users.google_sub)', async () => {
    if (!oldDbExists) return;
    const { one } = await import('../server/db.ts');
    const w = one('SELECT locked_by, locked_until, heartbeat_at, loop_spec_id FROM workflows WHERE id = ?', 'w_old_001');
    assert.ok(w, 'old workflow accessible with new columns');
    assert.equal(w!.locked_by, null, 'locked_by is NULL for existing sessions');
    const u = one('SELECT google_sub, monthly_budget_usd FROM users WHERE id = ?', 'u_admin_old');
    assert.ok(u, 'old user accessible with new columns');
    assert.equal(u!.google_sub, null, 'google_sub is NULL for existing users');
    assert.equal(u!.monthly_budget_usd, null, 'monthly_budget_usd is NULL for existing users');
  });

  test('old run still accessible', async () => {
    if (!oldDbExists) return;
    // The run was created with kind='session'; fetch with kind=session
    const r = await admin.get('/api/projects/p_old_001/runs?kind=session');
    assert.ok(r.runs.some((run: { id: string }) => run.id === 'r_old_001'), 'old run is still accessible with kind=session');
  });

  test('project settings loads without error', async () => {
    if (!oldDbExists) return;
    const r = await admin.req('GET', '/api/projects/p_old_001');
    assert.equal(r.status, 200, 'project detail loads without error');
  });

  test('new APIs work on migrated DB (readiness, loop-specs list)', async () => {
    if (!oldDbExists) return;
    const r = await admin.get('/api/projects/p_old_001/readiness');
    assert.ok(Array.isArray(r.items), 'readiness API works on migrated DB');
    const r2 = await admin.get('/api/projects/p_old_001/loop-specs');
    assert.ok(Array.isArray(r2.specs), 'loop-specs list works on migrated DB');
  });
});
