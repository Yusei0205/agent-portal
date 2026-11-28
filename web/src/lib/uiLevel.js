/**
 * Simple / Advanced interface level.
 *
 * Simple shows the core features only. Advanced shows every page and every
 * setting. Hiding never turns a feature off: hidden settings keep their
 * values, and an advanced page opened from a link still works (App shows a
 * bar offering to switch).
 *
 * The choice is per browser (localStorage `portal-ui-level`), default
 * 'simple'. It is mirrored on <html data-ui-level="simple|advanced"> so CSS
 * can hide advanced-only bits too. (Not data-mode: that is the colour mode.)
 */
export const LS_UI_LEVEL = 'portal-ui-level';
export const UI_LEVEL_EVENT = 'portal-ui-level-changed';
export const DEFAULT_UI_LEVEL = 'simple';

/**
 * Route tabs that only show in Advanced mode. Everything else is core.
 * Keep in sync with the `advanced: true` flags in Rail.jsx NAV_SECTIONS.
 */
export const ADVANCED_TABS = new Set([
  'usage',
  'workspaces',
  'tests',
  'tickets',
  'mail',
  'loop-specs',
  'connect',
  'config',
  'users',
  'agentcore',
  'api',
  'feedback',
  'academy',
]);

/** @returns {'simple' | 'advanced'} */
export function getUiLevel() {
  try {
    const v = localStorage.getItem(LS_UI_LEVEL);
    if (v === 'simple' || v === 'advanced') return v;
  } catch { /* storage blocked */ }
  return DEFAULT_UI_LEVEL;
}

/** Reflect the level on <html>. Safe to call before React renders. */
export function applyUiLevel(level = getUiLevel()) {
  try { document.documentElement.setAttribute('data-ui-level', level); } catch { /* no DOM */ }
}

/** @param {'simple' | 'advanced'} level */
export function setUiLevel(level) {
  const val = level === 'advanced' ? 'advanced' : 'simple';
  try { localStorage.setItem(LS_UI_LEVEL, val); } catch { /* not remembered */ }
  applyUiLevel(val);
  document.dispatchEvent(new CustomEvent(UI_LEVEL_EVENT, { detail: { level: val } }));
}

/** True when this route tab is advanced-only. */
export function isAdvancedTab(tab) {
  return ADVANCED_TABS.has(tab);
}
