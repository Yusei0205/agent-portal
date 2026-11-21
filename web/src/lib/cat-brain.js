/** The cat's roaming brain: pure functions, tunable constants in one place. */
export const WALK_SPEED_PX_S = 40;
export const SIT_MIN_MS = 3000;
export const SIT_MAX_MS = 8000;
export const WALK_MIN_PX = 60;
export const WALK_MAX_PX = 200;
export const REACTION_GAP_MS = 20000;
export const REACTION_SHOW_MS = 8000;
export const DRAG_THRESHOLD_PX = 6;
const EDGE_PX = 60;

/** Roaming only on wider screens, with motion welcome, no typing and no open dialog. */
export function roamAllowed(env) {
  return env.width >= 601 && !env.reducedMotion && !env.typing && !env.dialogOpen;
}

export function clampX(x, bounds) {
  if (bounds.min > bounds.max) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, x));
}

export function initialBrain(x, nowMs) {
  return { phase: 'sit', x, targetX: x, dir: 1, until: nowMs + SIT_MIN_MS };
}

export function nextBrainStep(s, nowMs, rng, bounds) {
  if (s.phase === 'walk') {
    return { ...s, x: s.targetX, phase: 'sit', until: nowMs + SIT_MIN_MS + rng() * (SIT_MAX_MS - SIT_MIN_MS) };
  }
  let dir;
  if (s.x - bounds.min < EDGE_PX) dir = 1;
  else if (bounds.max - s.x < EDGE_PX) dir = -1;
  else dir = rng() < 0.5 ? -1 : 1;
  const wanted = WALK_MIN_PX + rng() * (WALK_MAX_PX - WALK_MIN_PX);
  const targetX = clampX(s.x + dir * wanted, bounds);
  const distance = Math.abs(targetX - s.x);
  return { phase: 'walk', x: s.x, targetX, dir, until: nowMs + (distance / WALK_SPEED_PX_S) * 1000 };
}
