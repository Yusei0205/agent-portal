import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexLimits, parseClaudeUsage, parseKiroUsage } from '../server/engine-limits.ts';

describe('parseCodexLimits', () => {
  it('reads the 5-hour and weekly windows and the plan', () => {
    const out = parseCodexLimits({
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
        credits: { hasCredits: true, unlimited: false, balance: '12.5' },
        rateLimitReachedType: null,
      },
    });
    assert.equal(out.available, true);
    assert.equal(out.plan, 'plus');
    assert.deepEqual(out.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt]), [
      ['hourly', '5-hour', 42, 1_800_000_000],
      ['weekly', 'Weekly', 10, 1_800_500_000],
    ]);
    assert.equal(out.credits?.remaining, 12.5);
    assert.equal(out.note, null);
  });

  it('prefers the codex entry of rateLimitsByLimitId and flags a reached limit', () => {
    const out = parseCodexLimits({
      rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 100, windowDurationMins: 300 }, rateLimitReachedType: 'rate_limit_reached' } },
    });
    assert.equal(out.windows[0].usedPercent, 100);
    assert.match(out.note ?? '', /limit has been reached/);
  });

  it('answers unavailable when nothing is reported', () => {
    assert.equal(parseCodexLimits({}).available, false);
    assert.equal(parseCodexLimits(null).available, false);
  });
});

describe('parseClaudeUsage', () => {
  it('reads the 5-hour and 7-day utilisation', () => {
    const out = parseClaudeUsage({
      five_hour: { utilization: 37.5, resets_at: '2026-11-13T10:00:00Z' },
      seven_day: { utilization: 12, resets_at: '2026-11-18T00:00:00Z' },
      seven_day_opus: null,
    });
    assert.equal(out.available, true);
    assert.deepEqual(out.windows.map((w) => [w.id, w.usedPercent]), [['hourly', 37.5], ['weekly', 12]]);
    assert.equal(out.windows[0].resetsAt, Math.floor(Date.parse('2026-11-13T10:00:00Z') / 1000));
  });

  it('clamps out-of-range values and reports unavailable without windows', () => {
    assert.equal(parseClaudeUsage({ five_hour: { utilization: 140 } }).windows[0].usedPercent, 100);
    assert.equal(parseClaudeUsage({ unrelated: true }).available, false);
  });
});

describe('parseKiroUsage', () => {
  it('computes remaining credits from usage and limit', () => {
    const out = parseKiroUsage({
      subscriptionInfo: { subscriptionTitle: 'KIRO PRO' },
      usageBreakdownList: [{ resourceType: 'CREDIT', currentUsageWithPrecision: 187.25, usageLimitWithPrecision: 1000, nextDateReset: 1_800_000_000 }],
    });
    assert.equal(out.available, true);
    assert.equal(out.plan, 'KIRO PRO');
    assert.deepEqual(out.credits, { unit: 'credits', used: 187.25, limit: 1000, remaining: 812.75, resetsAt: 1_800_000_000 });
    assert.equal(out.windows[0].id, 'monthly');
    assert.equal(Math.round(out.windows[0].usedPercent), 19);
  });

  it('never goes below zero credits remaining and tolerates an empty answer', () => {
    assert.equal(parseKiroUsage({ usageBreakdownList: [{ currentUsage: 1200, usageLimit: 1000 }] }).credits?.remaining, 0);
    assert.equal(parseKiroUsage({}).available, false);
  });
});
