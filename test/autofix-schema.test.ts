/**
 * Auto-fix schema on upgrade: a database from before the auto-fix branch (migrations 1..54 applied and recorded, no auto-fix table
 * or seeded spec) gets the autofix_findings table and the builtin-autofix-ci spec when it is opened with the current code.
 * Migration ids are array positions, so the auto-fix steps must not take a position an existing database already recorded.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb, closeDb, isDbOpen, SCHEMA_VERSION } from '../server/db.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-afschema-'));
const file = path.join(dir, 'pre-branch.db');

after(() => {
  if (isDbOpen()) closeDb();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('auto-fix schema on an existing database', () => {
  it('the auto-fix steps take no migration position (the pre-branch database recorded 54)', () => {
    assert.equal(SCHEMA_VERSION, 54);
  });

  it('a pre-branch database gets the autofix_findings table and the builtin-autofix-ci spec', () => {
    let db = openDb(file);
    // The state before the auto-fix branch: every earlier migration applied and recorded as ids 1..54, nothing of auto-fix.
    db.exec("DROP TABLE IF EXISTS autofix_findings; DELETE FROM p10_loop_specs WHERE id = 'builtin-autofix-ci'; DELETE FROM schema_migrations WHERE id > 54;");
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n, 54);
    closeDb();

    db = openDb(file);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'autofix_findings'").all().length, 1);
    assert.equal(db.prepare("SELECT id FROM p10_loop_specs WHERE id = 'builtin-autofix-ci'").all().length, 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'autofix_findings_fp'").all().length, 1);
    // The steps after the literal list kept their ids.
    assert.ok((db.prepare('PRAGMA table_info(p6_runs)').all() as Array<{ name: string }>).some((c) => c.name === 'heartbeat_at'));
    closeDb();

    // Opening again changes nothing (the steps are idempotent).
    db = openDb(file);
    assert.equal(db.prepare("SELECT id FROM p10_loop_specs WHERE id = 'builtin-autofix-ci'").all().length, 1);
    closeDb();
  });
});
