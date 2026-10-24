import { useEffect, useState } from 'react';

// ─── Formatters ───────────────────────────────────────────────────────────────

export function fmtCredits(n) {
  if (n === null || n === undefined || n === 0) return null;
  return `${Number(n).toFixed(2)} credits`;
}

export function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function pctDelta(now, prev) {
  if (prev === null || prev === undefined || prev === 0) return null;
  return ((now - prev) / Math.abs(prev)) * 100;
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = (e) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
