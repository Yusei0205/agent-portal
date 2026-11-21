import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { idleMs, absoluteMs, sessionExpiry, nextExpiry } from '../server/session-policy.ts';

const env = {} as NodeJS.ProcessEnv;
const t0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('session policy', () => {
  it('defaults to 1 hour idle and 7 days absolute', () => {
    assert.equal(idleMs(env), 3_600_000);
    assert.equal(absoluteMs(env), 7 * 86_400_000);
  });
  it('reads the limits from the environment and ignores nonsense', () => {
    assert.equal(idleMs({ PORTAL_SESSION_IDLE_MINUTES: '15' } as NodeJS.ProcessEnv), 900_000);
    assert.equal(idleMs({ PORTAL_SESSION_IDLE_MINUTES: 'abc' } as NodeJS.ProcessEnv), 3_600_000);
    assert.equal(absoluteMs({ PORTAL_SESSION_MAX_DAYS: '-1' } as NodeJS.ProcessEnv), 7 * 86_400_000);
  });
  it('a new session ends one idle period after sign-in', () => {
    assert.equal(sessionExpiry(iso(t0), t0, env), iso(t0 + 3_600_000));
  });
  it('activity slides the end out but never past sign-in + 7 days', () => {
    assert.equal(sessionExpiry(iso(t0), t0 + 86_400_000, env), iso(t0 + 86_400_000 + 3_600_000));
    const nearEnd = t0 + 7 * 86_400_000 - 600_000;
    assert.equal(sessionExpiry(iso(t0), nearEnd, env), iso(t0 + 7 * 86_400_000));
  });
  it('writes only when the stored end is more than 5 minutes off', () => {
    const exp = iso(t0 + 3_600_000);
    assert.equal(nextExpiry(iso(t0), exp, t0 + 60_000, env), null);
    assert.equal(nextExpiry(iso(t0), exp, t0 + 6 * 60_000, env), iso(t0 + 6 * 60_000 + 3_600_000));
  });
  it('shortens an old 14-day session to the idle window on first use', () => {
    const old = iso(t0 + 14 * 86_400_000);
    assert.equal(nextExpiry(iso(t0), old, t0 + 1000, env), iso(t0 + 1000 + 3_600_000));
  });
});
