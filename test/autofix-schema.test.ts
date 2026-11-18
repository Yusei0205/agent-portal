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
import { openDb, closeDb, isDbOpen, SCHEMA_VERSION, AUTOFIX_CI_GOAL, AUTOFIX_REVIEW_GOAL } from '../server/db.ts';

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

  it('the built-in goal template is upgraded only while it is the unmodified original, and the finding columns are added', () => {
    const upgradeFile = path.join(dir, 'upgrade.db');
    let db = openDb(upgradeFile);
    const goal = () => (db.prepare("SELECT goal_template FROM p10_loop_specs WHERE id = 'builtin-autofix-ci'").get() as { goal_template: string }).goal_template;
    assert.equal(goal(), AUTOFIX_CI_GOAL);
    assert.match(goal(), /\{\{previous_attempt\}\}/);
    // A database seeded by the first version: the original template, and the table without the later columns.
    const original = AUTOFIX_CI_GOAL.replace('Previous attempt (none if this is the first):\n{{previous_attempt}}\n\n', '');
    assert.notEqual(original, AUTOFIX_CI_GOAL);
    db.prepare("UPDATE p10_loop_specs SET goal_template = ? WHERE id = 'builtin-autofix-ci'").run(original);
    db.exec('ALTER TABLE autofix_findings DROP COLUMN previous_attempt; ALTER TABLE autofix_findings DROP COLUMN pr_head_sha; ALTER TABLE autofix_findings DROP COLUMN pr_branch;');
    closeDb();

    db = openDb(upgradeFile);
    assert.equal(goal(), AUTOFIX_CI_GOAL, 'the unmodified original is upgraded');
    const cols = (db.prepare('PRAGMA table_info(autofix_findings)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ['pr_branch', 'pr_head_sha', 'previous_attempt']) assert.ok(cols.includes(c), c);

    // An admin's edit of the built-in goal is kept.
    db.prepare("UPDATE p10_loop_specs SET goal_template = ? WHERE id = 'builtin-autofix-ci'").run('Our own goal for {{kind}}.');
    closeDb();
    db = openDb(upgradeFile);
    assert.equal(goal(), 'Our own goal for {{kind}}.');
    closeDb();
  });

  it('a database with only the CI fixer spec gets builtin-autofix-review; an edited review goal is kept on later opens', () => {
    const f = path.join(dir, 'ci-only.db');
    let db = openDb(f);
    // The state after Task 8-11: the CI fixer seeded, no review fixer.
    db.exec("DELETE FROM p10_loop_specs WHERE id = 'builtin-autofix-review'");
    assert.equal(db.prepare("SELECT id FROM p10_loop_specs WHERE id LIKE 'builtin-autofix-%'").all().length, 1);
    closeDb();

    db = openDb(f);
    const row = db.prepare("SELECT * FROM p10_loop_specs WHERE id = 'builtin-autofix-review'").get() as Record<string, unknown>;
    assert.ok(row);
    assert.equal(row.goal_template, AUTOFIX_REVIEW_GOAL);
    assert.equal(row.is_builtin, 1);
    assert.equal(row.project_id, null);
    assert.deepEqual(JSON.parse(String(row.trigger_config)), { finding_kind: 'review_finding', maxPerHour: 12 });
    assert.equal(db.prepare("SELECT id FROM p10_loop_specs WHERE id = 'builtin-autofix-session'").all().length, 0, 'no unused session spec');
    db.prepare("UPDATE p10_loop_specs SET goal_template = 'ours' WHERE id = 'builtin-autofix-review'").run();
    closeDb();

    db = openDb(f);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM p10_loop_specs WHERE id = 'builtin-autofix-review'").get()!.n, 1);
    assert.equal((db.prepare("SELECT goal_template FROM p10_loop_specs WHERE id = 'builtin-autofix-review'").get() as { goal_template: string }).goal_template, 'ours');
    closeDb();
  });
});
