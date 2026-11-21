/**
 * Question limits for the cat assistant: 8 per minute per person (in memory, sliding window) and 100 per UTC day per person
 * (counted in the settings store, best effort: a store error lets the question through). Old day keys are not cleaned up.
 */

import { getDb } from '../db.ts';
import { getSetting, setSetting } from '../settings.ts';

export const PER_MINUTE = 8;
export const PER_DAY = 100;
const WINDOW_MS = 60_000;

const recent = new Map<string, number[]>();

export function resetLimitsForTest(): void { recent.clear(); }

export async function checkAndCount(userId: string, nowMs: number = Date.now()): Promise<{ ok: true } | { ok: false; reason: 'minute' | 'day' }> {
  const stamps = (recent.get(userId) ?? []).filter((t) => nowMs - t < WINDOW_MS);
  if (stamps.length >= PER_MINUTE) { recent.set(userId, stamps); return { ok: false, reason: 'minute' }; }

  const key = `assistant.count.${userId}.${new Date(nowMs).toISOString().slice(0, 10)}`;
  let count = 0;
  let storeOk = true;
  try {
    const n = Number(getSetting(getDb(), key) ?? '0');
    count = Number.isFinite(n) ? n : 0;
  } catch { storeOk = false; }
  if (storeOk && count >= PER_DAY) { recent.set(userId, stamps); return { ok: false, reason: 'day' }; }

  stamps.push(nowMs);
  recent.set(userId, stamps);
  if (storeOk) {
    try { await setSetting(getDb(), key, String(count + 1)); } catch { /* best effort */ }
  }
  return { ok: true };
}
