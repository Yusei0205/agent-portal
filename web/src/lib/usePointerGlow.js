import { useEffect } from 'react';

const SURFACES = '.panel, .card, .stat-card, .kpi-card, .project-card, .artifact-card, .run-outputs-card, [data-glow-surface], [class$="-card"], [class*="-card "], [class$="-panel"], [class*="-panel "]';
const EXCLUDED = 'pre, table, .cm-editor, .xterm, .ide-workspace';

/** One delegated listener per page; pointer position never enters React state. */
export function usePointerGlow(ref, pageKey) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const fine = matchMedia('(hover: hover) and (pointer: fine)');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let active = null;
    let frame = null;
    let point = null;
    const clear = () => {
      cancelAnimationFrame(frame);
      frame = null;
      active?.removeAttribute('data-pointer-glow');
      active = null;
    };
    const move = (event) => {
      const settings = document.documentElement.dataset;
      if (!fine.matches || reduced.matches || settings.fxGlow === 'false' || ['none', 'reduced'].includes(settings.fxMotion) || root.querySelector('.db-root:not(.db-anim)')) { clear(); return; }
      const target = event.target.closest?.(SURFACES);
      if (!target || !root.contains(target) || event.target.closest(EXCLUDED)) { clear(); return; }
      if (target !== active) { clear(); active = target; active.setAttribute('data-pointer-glow', 'true'); }
      point = { x: event.clientX, y: event.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!active || !point) return;
        const rect = active.getBoundingClientRect();
        active.style.setProperty('--pointer-x', `${point.x - rect.left}px`);
        active.style.setProperty('--pointer-y', `${point.y - rect.top}px`);
      });
    };
    root.addEventListener('pointermove', move, { passive: true });
    root.addEventListener('pointerleave', clear);
    reduced.addEventListener('change', clear);
    fine.addEventListener('change', clear);
    document.addEventListener('portal-theme-changed', clear);
    document.addEventListener('visibilitychange', clear);
    return () => { clear(); root.removeEventListener('pointermove', move); root.removeEventListener('pointerleave', clear); reduced.removeEventListener('change', clear); fine.removeEventListener('change', clear); document.removeEventListener('portal-theme-changed', clear); document.removeEventListener('visibilitychange', clear); };
  }, [ref, pageKey]);
}
