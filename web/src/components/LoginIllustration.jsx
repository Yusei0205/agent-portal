import { SPRITES, SPRITE_SIZE, PALETTE_KEYS } from '../lib/cat-sprites.js';

// A pixel four-leaf clover, drawn like the cat: T leaf, y gold centre, s stem.
const CLOVER = [
  '.TT...TT.',
  'TTTT.TTTT',
  'TTTTTTTTT',
  '.TTT.TTT.',
  '....y....',
  '.TTT.TTT.',
  'TTTTTTTTT',
  'TTTT.TTTT',
  '.TT...TT.',
  '......s..',
  '.......s.',
  '.......s.',
];
const CLOVER_KEYS = { T: 'clover', y: 'tag', s: 'clover' };
const CLOVER_X = SPRITE_SIZE - 1;
const CLOVER_Y = 3;
const W = CLOVER_X + 9 + 1;

/** Merges horizontal runs of one colour so neighbouring pixels leave no seams. */
function runs(grids) {
  const out = [];
  for (const { rows, ox, oy, keys } of grids) {
    rows.forEach((line, y) => {
      let prev = null;
      for (let x = 0; x < line.length; x++) {
        const key = keys[line[x]];
        if (!key) { prev = null; continue; }
        if (prev && prev.key === key) prev.w += 1;
        else { prev = { key, x: x + ox, y: y + oy, w: 1 }; out.push(prev); }
      }
    });
  }
  return out;
}

const RECTS = runs([
  { rows: SPRITES.idle.frames[0], ox: 0, oy: 0, keys: PALETTE_KEYS },
  { rows: CLOVER, ox: CLOVER_X, oy: CLOVER_Y, keys: CLOVER_KEYS },
]);

/** Decorative sitting cat next to a larger four-leaf clover, shown above the sign-in form. Static: no animation. */
export function LoginIllustration() {
  return (
    <div className="login-illustration cat-sprite" aria-hidden="true" data-testid="login-illustration">
      <svg viewBox={`0 0 ${W} ${SPRITE_SIZE}`} shapeRendering="crispEdges" focusable="false">
        {RECTS.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height="1" style={{ fill: `var(--cat-${r.key})` }} />
        ))}
      </svg>
    </div>
  );
}
