import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup } from './fixtures.ts';
import { checkAndCount, resetLimitsForTest, PER_MINUTE, PER_DAY } from '../server/assistant/limits.ts';
import * as settings from '../server/settings.ts';
import { getDb } from '../server/db.ts';

const T0 = Date.UTC(2026, 10, 21, 8, 0, 0);

describe('assistant limits', () => {
  before(async () => { await createTestServer(); });
  after(() => cleanup());
  beforeEach(() => { resetLimitsForTest(); getDb().prepare("DELETE FROM settings WHERE key LIKE 'assistant.count.%'").run(); });

  it('allows 8 a minute and refuses the 9th', async () => {
    assert.equal(PER_MINUTE, 8);
    for (let i = 0; i < 8; i++) assert.deepEqual(await checkAndCount('u1', T0 + i * 100), { ok: true });
    assert.deepEqual(await checkAndCount('u1', T0 + 900), { ok: false, reason: 'minute' });
  });
  it('allows one more after 61 seconds', async () => {
    for (let i = 0; i < 8; i++) await checkAndCount('u1', T0);
    assert.deepEqual(await checkAndCount('u1', T0 + 61_000), { ok: true });
  });
  it('a refused call is not counted for the day', async () => {
    for (let i = 0; i < 8; i++) await checkAndCount('u1', T0);
    await checkAndCount('u1', T0 + 1);
    assert.equal(settings.getSetting(getDb(), 'assistant.count.u1.2026-11-21'), '8');
  });
  it('refuses the 101st call of a day', async () => {
    assert.equal(PER_DAY, 100);
    for (let i = 0; i < 100; i++) assert.deepEqual(await checkAndCount('u1', T0 + i * 61_000), { ok: true }, `call ${i + 1}`);
    assert.deepEqual(await checkAndCount('u1', T0 + 100 * 61_000), { ok: false, reason: 'day' });
  });
  it('the day counter restarts on the next UTC day', async () => {
    for (let i = 0; i < 100; i++) await checkAndCount('u1', T0 + i * 61_000);
    assert.deepEqual(await checkAndCount('u1', Date.UTC(2026, 10, 22, 0, 0, 1)), { ok: true });
  });
  it('two people do not share counts', async () => {
    for (let i = 0; i < 8; i++) await checkAndCount('u1', T0);
    assert.deepEqual(await checkAndCount('u1', T0), { ok: false, reason: 'minute' });
    assert.deepEqual(await checkAndCount('u2', T0), { ok: true });
  });
  it('a throwing settings store still allows the call', async () => {
    const orig = getDb().prepare;
    const db = getDb();
    db.prepare = (() => { throw new Error('store down'); }) as typeof db.prepare;
    try {
      assert.deepEqual(await checkAndCount('u3', T0), { ok: true });
    } finally { db.prepare = orig; }
  });
});
