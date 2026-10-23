// Look and feel: "hud" (futuristic, animated) or "standard" (the quiet workbench), and the effects level.
// The attributes are first set by web/theme-init.js before paint; this module changes and remembers them.
const THEMES = ['hud', 'standard'];
const FX = ['full', 'reduced'];

function read(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export const getTheme = () => read('portal-theme', THEMES, 'hud');
// Reduced is the default: the full effects (live blur, moving grid and scan line) cost a lot of GPU on many PCs.
export const getFx = () => read('portal-fx', FX, 'reduced');

// Pause all animation while the tab is in the background.
if (typeof document !== 'undefined') {
  const mark = () => (document.hidden ? document.documentElement.setAttribute('data-hidden', '') : document.documentElement.removeAttribute('data-hidden'));
  document.addEventListener('visibilitychange', mark);
  mark();
}

function apply() {
  document.documentElement.setAttribute('data-theme', getTheme());
  document.documentElement.setAttribute('data-fx', getFx());
  window.dispatchEvent(new Event('portal-look'));
}

export function setTheme(v) {
  try {
    localStorage.setItem('portal-theme', THEMES.includes(v) ? v : 'hud');
  } catch {
    /* not remembered, still applied below */
  }
  document.documentElement.setAttribute('data-theme', THEMES.includes(v) ? v : 'hud');
  apply();
}

export function setFx(v) {
  try {
    localStorage.setItem('portal-fx', FX.includes(v) ? v : 'full');
  } catch {
    /* not remembered, still applied below */
  }
  document.documentElement.setAttribute('data-fx', FX.includes(v) ? v : 'full');
  apply();
}

/**
 * Pointer light: panels get --mx / --my (the pointer position inside them) so the HUD theme can
 * draw a soft glow that follows the mouse. One passive listener, throttled to animation frames.
 */
export function initPointerGlow() {
  let frame = 0;
  let last = null;
  const run = () => {
    frame = 0;
    if (!last) return;
    const el = last.target instanceof Element ? last.target.closest('.panel, .composer, .tree, .run-item, .rail-link, .btn') : null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${last.clientX - r.left}px`);
    el.style.setProperty('--my', `${last.clientY - r.top}px`);
  };
  const onMove = (e) => {
    if (document.documentElement.getAttribute('data-theme') !== 'hud' || document.documentElement.getAttribute('data-fx') === 'reduced') return;
    last = e;
    if (!frame) frame = requestAnimationFrame(run);
  };
  document.addEventListener('pointermove', onMove, { passive: true });
  return () => document.removeEventListener('pointermove', onMove);
}
