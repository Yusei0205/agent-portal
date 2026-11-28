/**
 * The nine lives ring: the portal's core drawn as a small pixel four-leaf clover inside nine pixel "lives". Pure helpers for AiCore.jsx.
 */

export const LIVES = 9;

const CLOVER = [
  '.11.1.2.22.',
  '11111.22222',
  '11111.22222',
  '.1111.2222.',
  '..111.222..',
  '...........',
  '..333.444..',
  '.3333.4444.',
  '33333.44444',
  '33333.44444',
  '.33.3.4.44.',
];
const CENTRE = [[5, 4], [4, 5], [5, 5], [6, 5], [5, 6]];

/** The clover's pixels in an 11x11 grid: leaves l1 (top-left), l2 (top-right), l3 (bottom-left), l4 (bottom-right) and the gold centre. */
export const CLOVER_PIXELS = [
  ...CLOVER.flatMap((row, y) => [...row].flatMap((ch, x) => (ch === '.' ? [] : [{ x, y, part: `l${ch}` }]))),
  ...CENTRE.map(([x, y]) => ({ x, y, part: 'centre' })),
];

/**
 * What each of the nine lives shows: 'off', 'on' (lit), 'bad' (a failure) or 'walk' (the idle highlight that moves round the ring).
 * Running lights one life per running agent (at most nine); without a count it lights three.
 */
export function lifeDots(state, active) {
  const dots = Array(LIVES).fill('off');
  if (state === 'success') return dots.fill('on');
  if (state === 'failed') { dots[2] = 'bad'; return dots; }
  if (state === 'running') {
    const n = Number.isFinite(active) && active >= 1 ? Math.min(LIVES, Math.floor(active)) : 3;
    return dots.map((_, i) => (i < n ? 'on' : 'off'));
  }
  dots[0] = 'walk';
  return dots;
}

/** The core's accessible name. */
export function coreLabel(state, active) {
  if (state === 'running') {
    if (Number.isFinite(active) && active >= 1) {
      const n = Math.floor(active);
      return `AI core: ${n} agent${n === 1 ? '' : 's'} running`;
    }
    return 'AI core: agents are running';
  }
  if (state === 'success') return 'AI core: the last run succeeded';
  if (state === 'failed') return 'AI core: a run failed';
  return 'AI core: idle';
}
