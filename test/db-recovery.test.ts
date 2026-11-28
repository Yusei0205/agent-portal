/**
 * DB startup recovery tests — must run in isolation (no shared server).
 *
 * Fix B: openDb flips p6_workflows/p6_runs in 'running'/'pending' to 'failed'
 * on every startup, so server crashes never leave jobs stuck permanently.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb, closeDb, isDbOpen } from '../server/db.ts';
import type { Row } from '../server/db.ts';
import { generateId, now } from '../server/util.ts';

let tmpDir: string;
let tmpDbPath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-recov-'));
  tmpDbPath = path.join(tmpDir, 'recov.db');
  // Bootstrap the DB with all migrations (no rows yet — recovery is a no-op).
  openDb(tmpDbPath);
  closeDb();
});

after(() => {
  if (isDbOpen()) closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── helpers ────────────────────────────────────────────────────────────────────

function seedRunning(): { wfId: string; runId: string } {
  const db = openDb(tmpDbPath);

  const userId = generateId();
  db.prepare(
    'INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?,?,?,?,0,0,?)',
  ).run(userId, `u-${userId}@t.com`, 'U', 'x', now());

  const wfId = generateId();
  const ts = now();
  db.prepare(
    `INSERT INTO p6_workflows
       (id, project_id, goal, title, status, engine, trust_tools, lead_agent, workspace_id,
        output_files_enabled, repo_ids, iteration_count, max_iterations, kind, credential_id,
        parent_id, created_by, created_at, updated_at, stop_reason, work_dir)
     VALUES (?,NULL,'t','t','done','demo',0,NULL,NULL,0,'[]',0,10,NULL,NULL,NULL,?,?,?,'',NULL)`,
  ).run(wfId, userId, ts, ts);

  const runId = generateId();
  db.prepare(
    `INSERT INTO p6_runs
       (id, workflow_id, status, started_at, finished_at, cost_usd, input_tokens, output_tokens, model, created_at)
     VALUES (?,?,'pending',?,NULL,0,0,0,'demo',?)`,
  ).run(runId, wfId, ts, ts);

  // Simulate crash: flip to running with no finished_at
  db.prepare("UPDATE p6_workflows SET status = 'running' WHERE id = ?").run(wfId);
  db.prepare("UPDATE p6_runs SET status = 'running', finished_at = NULL WHERE id = ?").run(runId);

  closeDb(); // server crash
  return { wfId, runId };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('Fix B — openDb startup recovery', () => {
  it('p6_workflows in status=running → failed on restart', () => {
    const { wfId } = seedRunning();

    // Reopen (triggers recovery)
    const db = openDb(tmpDbPath);
    const wf = db.prepare('SELECT status FROM p6_workflows WHERE id = ?').get(wfId) as Row | undefined;
    assert.equal(String(wf?.status ?? ''), 'failed',
      'running workflow must be flipped to failed on re-open');
    closeDb();
  });

  it('p6_runs in status=running, finished_at NULL → failed on restart', () => {
    const { runId } = seedRunning();

    const db = openDb(tmpDbPath);
    const run = db.prepare('SELECT status, finished_at FROM p6_runs WHERE id = ?').get(runId) as Row | undefined;
    assert.equal(String(run?.status ?? ''), 'failed',
      'running run must be flipped to failed on re-open');
    assert.ok(run?.finished_at, 'finished_at must be populated by recovery');
    closeDb();
  });

  it('terminal-status rows (done, paused, failed) are unaffected by recovery', () => {
    const db = openDb(tmpDbPath);

    const userId = generateId();
    db.prepare(
      'INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?,?,?,?,0,0,?)',
    ).run(userId, `u-term-${userId}@t.com`, 'U', 'x', now());

    const ts = now();
    const ids: Record<string, string> = {};
    for (const st of ['done', 'paused', 'failed'] as const) {
      const id = generateId();
      ids[st] = id;
      db.prepare(
        `INSERT INTO p6_workflows
           (id, project_id, goal, title, status, engine, trust_tools, lead_agent, workspace_id,
            output_files_enabled, repo_ids, iteration_count, max_iterations, kind, credential_id,
            parent_id, created_by, created_at, updated_at, stop_reason, work_dir)
         VALUES (?,NULL,'t','t',?,'demo',0,NULL,NULL,0,'[]',0,10,NULL,NULL,NULL,?,?,?,'',NULL)`,
      ).run(id, st, userId, ts, ts);
    }

    closeDb();
    const db2 = openDb(tmpDbPath);

    for (const [st, id] of Object.entries(ids)) {
      const row = db2.prepare('SELECT status FROM p6_workflows WHERE id = ?').get(id) as Row | undefined;
      assert.equal(String(row?.status ?? ''), st,
        `${st} workflow must remain ${st} after recovery`);
    }
    closeDb();
  });

  it('recovery is idempotent — reopening again does not change already-failed rows', () => {
    const { wfId } = seedRunning();

    // First restart: flips to failed
    openDb(tmpDbPath);
    closeDb();

    // Second restart: must not change anything
    const db = openDb(tmpDbPath);
    const wf = db.prepare('SELECT status FROM p6_workflows WHERE id = ?').get(wfId) as Row | undefined;
    assert.equal(String(wf?.status ?? ''), 'failed',
      'already-failed row must still be failed after second restart');
    closeDb();
  });
});
