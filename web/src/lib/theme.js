// Theme management. Keeps in sync with web/theme-init.js.
const THEMES = /** @type {const} */ (['dark', 'light', 'system']);
const LS_KEY = 'portal-color-theme';

/**
 * @returns {'dark' | 'light' | 'system'}
 */
export function getTheme() {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    // private mode
  }
  return 'system';
}

/**
 * Store and apply the chosen theme.
 * @param {'dark' | 'light' | 'system'} theme
 */
export function setTheme(theme) {
  const val = THEMES.includes(theme) ? theme : 'system';
  try {
    localStorage.setItem(LS_KEY, val);
  } catch {
    // private mode — still apply
  }
  _apply(val);
}

/**
 * Apply the saved theme on page load (call once from main.jsx before React renders).
 */
export function applyTheme() {
  _apply(getTheme());
}

/** @param {'dark' | 'light' | 'system'} theme */
function _apply(theme) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else if (theme === 'light') {
    root.setAttribute('data-theme', 'light');
  } else {
    // 'system' — remove the attribute so the @media query takes effect
    root.removeAttribute('data-theme');
  }
}
