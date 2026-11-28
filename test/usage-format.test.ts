/**
 * Kiro credits are shown as credits, never as dollars (web/src/lib/util.js),
 * and the M48 migration moves Kiro numbers that were stored as dollars into the credits column.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain JS module without type declarations
import { formatCost, formatCredits, formatUsage } from '../web/src/lib/util.js';

describe('formatCredits', () => {
  it('shows credits without a dollar sign', () => {
    assert.equal(formatCredits(1.25), '1.25 credits');
    assert.equal(formatCredits(2), '2 credits');
    assert.equal(formatCredits(1), '1 credit');
    assert.equal(formatCredits(0), '0 credits');
    assert.equal(formatCredits(0.004), '<0.01 credits');
    assert.equal(formatCredits(null), '');
    assert.ok(!formatCredits(3.5).includes('$'));
  });
});

describe('formatUsage', () => {
  it('shows dollars, credits, or both', () => {
    assert.equal(formatUsage(0.5, 0), formatCost(0.5));
    assert.equal(formatUsage(0, 3.5), '3.5 credits');
    assert.equal(formatUsage(0.5, 3.5), `${formatCost(0.5)} + 3.5 credits`);
    assert.equal(formatUsage(0, 0), '—');
    assert.equal(formatUsage(null, null, ''), '');
  });
});

describe('M48 migration: Kiro credits out of cost_usd', () => {
  it('moves Kiro runs and budget rows to credits and leaves other engines alone', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { openDb } = await import('../server/db.ts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm48-'));
    const file = path.join(dir, 'portal.db');
    try {
      // A database as it was before M48: Kiro credits stored in cost_usd.
      let db = openDb(file);
      db.exec(`
        INSERT INTO p6_workflows (id, goal, engine, status, created_at, updated_at) VALUES
          ('wk', 'g', 'kiro', 'done', '2026-01-01', '2026-01-01'),
          ('wc', 'g', 'claude-code', 'done', '2026-01-01', '2026-01-01');
        INSERT INTO p6_runs (id, workflow_id, status, cost_usd, created_at) VALUES
          ('rk', 'wk', 'done', 2.5, '2026-01-01'),
          ('rc', 'wc', 'done', 0.75, '2026-01-01');
        INSERT INTO budget_usage (cost_usd, provider, model) VALUES (2.5, 'kiro', 'm'), (0.75, 'claude-code', 'm');
        DELETE FROM schema_migrations WHERE id = 47; -- M48_KIRO_CREDITS (M24 was skipped)
      `);
      db.close();

      db = openDb(file); // runs M48
      const runs = db.prepare('SELECT id, cost_usd, credits FROM p6_runs ORDER BY id').all() as Array<Record<string, number | string>>;
      assert.deepEqual(runs.map((r) => [r.id, r.cost_usd, r.credits]), [['rc', 0.75, 0], ['rk', 0, 2.5]]);
      const bu = db.prepare('SELECT provider, cost_usd, credits FROM budget_usage ORDER BY provider').all() as Array<Record<string, number | string>>;
      assert.deepEqual(bu.map((r) => [r.provider, r.cost_usd, r.credits]), [['claude-code', 0.75, 0], ['kiro', 0, 2.5]]);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
