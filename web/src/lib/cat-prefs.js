/**
 * The cat companion's remembered preferences (browser only): mode, horizontal position as a fraction of the width, and the distance from
 * the bottom. Every storage access is guarded: with storage unavailable or holding garbage the defaults apply.
 */
export const CAT_PREFS_KEY = 'portal.cat.prefs';
export const DEFAULT_CAT_PREFS = { mode: 'roam', x: null, bottom: 16 };
const MODES = ['roam', 'sit', 'hidden'];

function defaultStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** @returns {{ mode: 'roam'|'sit'|'hidden', x: number|null, bottom: number }} */
export function loadCatPrefs(storage) {
  const out = { ...DEFAULT_CAT_PREFS };
  try {
    const store = storage ?? defaultStorage();
    const raw = store?.getItem(CAT_PREFS_KEY);
    if (!raw) return out;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return out;
    if (MODES.includes(p.mode)) out.mode = p.mode;
    if (typeof p.x === 'number' && Number.isFinite(p.x)) out.x = clamp(p.x, 0, 1);
    if (typeof p.bottom === 'number' && Number.isFinite(p.bottom)) out.bottom = clamp(p.bottom, 0, 400);
  } catch {
    return { ...DEFAULT_CAT_PREFS };
  }
  return out;
}

/** Never throws. */
export function saveCatPrefs(prefs, storage) {
  try {
    const store = storage ?? defaultStorage();
    store?.setItem(CAT_PREFS_KEY, JSON.stringify({ mode: prefs.mode, x: prefs.x, bottom: prefs.bottom }));
  } catch { /* storage unavailable: the cat just forgets */ }
}
