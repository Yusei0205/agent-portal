/**
 * The schema is one clean baseline (spec D-4): a single execution model, no leftover tables, and a database from before
 * the baseline is refused instead of half-upgraded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb, all, one, SCHEMA_VERSION } from '../server/db.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-db-')), 'portal.db');

test('a fresh database has the unified execution tables and none of the old ones', () => {
  openDb(tmp());
  try {
    const tables = all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
    for (const t of ['workflows', 'workflow_events', 'agent_runs', 'agent_run_events', 'inputs', 'loop_run_states']) assert.ok(tables.includes(t), `${t} exists`);
    assert.ok(!tables.includes('runs'), 'no runs table');
    assert.ok(!tables.includes('run_events'), 'no run_events table');
    for (const t of ['diagrams', 'diagram_versions']) assert.ok(tables.includes(t), `${t} exists (appended migration)`);
    const runCols = all<{ name: string }>('PRAGMA table_info(agent_runs)').map((c) => c.name);
    assert.ok(runCols.includes('workflow_id'), 'an agent run names its session');
    const wfCols = all<{ name: string }>('PRAGMA table_info(workflows)').map((c) => c.name);
    assert.ok(wfCols.includes('permission_mode'));
    for (const dead of ['locked_by', 'locked_until', 'heartbeat_at']) assert.ok(!wfCols.includes(dead), `${dead} is gone`);
    assert.equal(one<{ version: number }>('SELECT version FROM schema_version')?.version, SCHEMA_VERSION);
  } finally {
    closeDb();
  }
});

test('opening it again keeps the data and does not re-run the baseline', () => {
  const file = tmp();
  openDb(file);
  closeDb();
  openDb(file);
  try {
    assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM schema_version')?.n, 1);
  } finally {
    closeDb();
  }
});

test('a database made by an older build is refused with a clear reason', () => {
  const file = tmp();
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (37); CREATE TABLE runs (id TEXT PRIMARY KEY);');
  old.close();
  assert.throws(() => openDb(file), /cannot be upgraded/);
});
