/**
 * The cat's pixel art, drawn in code: 16x16 character grids, one per animation frame.
 *   .  transparent   o outline   f fur   b belly   a accent   e eye   k blush
 * The frames are composed by a tiny painter (so a pose is a few lines, not 256 hand-typed characters) and exported as plain string
 * grids; the component renders them as crisp SVG rects coloured from theme tokens. No image files.
 */
export const SPRITE_SIZE = 16;
export const PALETTE_KEYS = { o: 'outline', f: 'fur', b: 'belly', a: 'accent', e: 'eye', k: 'blush' };

function canvas() {
  const g = Array.from({ length: SPRITE_SIZE }, () => Array(SPRITE_SIZE).fill('.'));
  const put = (x, y, c) => { if (x >= 0 && x < SPRITE_SIZE && y >= 0 && y < SPRITE_SIZE && c !== ' ') g[y][x] = c; };
  const row = (x0, y, s) => { for (let i = 0; i < s.length; i++) put(x0 + i, y, s[i]); };
  return { put, row, done: () => g.map((r) => r.join('')) };
}

/** A sitting cat seen from the front; dy lifts it (hops), the options pick the face and the arms. */
function front({ dy = 2, eyes = 'open', ears = 'up', tail = 0, armsR = 0, armsL = 0, extra } = {}) {
  const c = canvas();
  const r = (y, x, s) => c.row(x, y + dy, s);
  if (ears === 'up') {
    c.put(4, dy, 'o'); c.put(11, dy, 'o');
    r(1, 3, 'oao'); r(1, 10, 'oao');
  } else {
    r(1, 3, 'ofo'); r(1, 10, 'ofo'); // drooping ears
  }
  r(2, 3, 'offooooffo');
  const solid = 'offffffffo';
  if (eyes === 'open') { r(3, 3, solid); r(4, 3, 'ofeffffefo'); r(5, 3, 'ofeffffefo'); }
  else if (eyes === 'blink') { r(3, 3, solid); r(4, 3, solid); r(5, 3, 'ofoffffofo'); }
  else if (eyes === 'wide') { r(3, 3, solid); r(4, 3, 'ofeeffeefo'); r(5, 3, 'ofeeffeefo'); }
  else { r(3, 3, 'ofooffoofo'); r(4, 3, 'ofeffffefo'); r(5, 3, 'ofeffffefo'); } // worried: heavy brows over the eyes
  r(6, 3, 'okffaaffko');
  r(7, 4, 'oooooooo');
  r(8, 4, 'ofbbbbfo'); r(9, 3, 'offbbbbffo'); r(10, 3, 'offbbbbffo'); r(11, 3, 'offbbbbffo');
  r(12, 2, 'ooffbbbbffoo'); r(13, 2, 'oooooooooooo');
  const tails = [
    [[14, 12], [14, 11], [14, 10], [15, 9]],
    [[14, 12], [14, 11], [15, 10], [15, 9]],
    [[14, 12], [15, 11], [15, 10], [15, 9]],
  ][tail] ?? [];
  if (!armsR) for (const [x, y] of tails) c.put(x, y + dy, 'o');
  // a raised paw: forearm column with an outline and a paw tip
  const paw = (x, shift) => {
    const y0 = 5 + shift;
    c.put(x, y0 + dy, 'o');
    for (let y = y0 + 1; y <= 8; y++) { c.put(x, y + dy, 'f'); c.put(x + (x > 8 ? 1 : -1), y + dy, 'o'); }
    c.put(x, 9 + dy, 'o');
  };
  if (armsR) paw(13, armsR - 1);
  if (armsL) paw(2, armsL - 1);
  if (extra) extra(c);
  return c.done();
}

/** A walking cat seen from the side, facing right; legs picked per frame. */
function side({ legs, tail, step }) {
  const c = canvas();
  const dy = 1;
  const r = (y, x, s) => c.row(x, y + dy, s);
  c.put(10, 2 + dy, 'o'); c.put(14, 2 + dy, 'o');
  r(3, 9, 'oao oao');
  r(4, 9, 'offfffo');
  r(5, 9, 'offfefo');
  r(6, 9, 'offfkfa');
  r(7, 10, 'oooooo');
  r(7, 3, 'oooooo');
  r(8, 2, 'offffffffo');
  r(9, 2, 'offfbbbbfo');
  r(10, 2, 'offbbbbbfo');
  r(11, 3, 'oooooooo');
  for (const [x, lift] of legs) {
    for (let y = 11; y <= 14 - lift; y++) c.put(x, y + dy, 'o');
  }
  for (const [x, y] of tail) c.put(x, y + dy, 'o');
  if (step) step(c);
  return c.done();
}

const sparkle = (pts) => (c) => { for (const [x, y] of pts) c.put(x, y, 'a'); };
const bang = (c) => { for (const y of [1, 2, 3]) c.put(14, y, 'a'); c.put(14, 5, 'a'); };
const drop = (y) => (c) => { c.put(14, y, 'a'); c.put(14, y + 1, 'a'); };

export const SPRITES = {
  walk: {
    fps: 8, loop: true,
    frames: [
      side({ legs: [[3, 1], [5, 0], [8, 0], [10, 1]], tail: [[1, 8], [0, 7], [0, 6]] }),
      side({ legs: [[4, 0], [6, 0], [9, 0], [10, 0]], tail: [[1, 8], [0, 8], [0, 7]] }),
      side({ legs: [[3, 0], [5, 1], [8, 1], [10, 0]], tail: [[1, 8], [0, 8], [0, 9]] }),
      side({ legs: [[2, 0], [5, 0], [7, 0], [11, 0]], tail: [[1, 8], [0, 7], [0, 8]] }),
    ],
  },
  idle: {
    fps: 2.5, loop: true,
    frames: [
      front({ tail: 0 }),
      front({ tail: 0, eyes: 'blink' }),
      front({ tail: 1 }),
      front({ tail: 2 }),
    ],
  },
  wave: {
    fps: 5, loop: true,
    frames: [front({ armsR: 1, tail: 0 }), front({ armsR: 2, tail: 1 })],
  },
  celebrate: {
    fps: 5, loop: false,
    frames: [
      front({ dy: 2, armsR: 1, armsL: 1, extra: sparkle([[0, 6], [15, 5]]) }),
      front({ dy: 1, armsR: 1, armsL: 1, extra: sparkle([[0, 3], [15, 2], [1, 8]]) }),
      front({ dy: 0, armsR: 1, armsL: 1, extra: sparkle([[1, 1], [14, 1], [0, 5], [15, 6]]) }),
      front({ dy: 1, armsR: 1, armsL: 1, extra: sparkle([[0, 2], [15, 4], [14, 9]]) }),
    ],
  },
  worried: {
    fps: 2, loop: true,
    frames: [
      front({ eyes: 'worried', ears: 'flat', extra: drop(5) }),
      front({ eyes: 'worried', ears: 'flat', tail: 1, extra: drop(7) }),
    ],
  },
  alert: {
    fps: 4, loop: true,
    frames: [
      front({ eyes: 'wide', dy: 2, extra: bang }),
      front({ eyes: 'wide', dy: 1, tail: 2, extra: bang }),
    ],
  },
};

export function frameCount(name) {
  return SPRITES[name].frames.length;
}

/** One entry per non-transparent pixel: its place in the frame, the frame index and the palette role. */
export function sheetRects(name) {
  const out = [];
  SPRITES[name].frames.forEach((frame, f) => {
    frame.forEach((line, y) => {
      for (let x = 0; x < line.length; x++) {
        const key = PALETTE_KEYS[line[x]];
        if (key) out.push({ x, y, frame: f, key });
      }
    });
  });
  return out;
}
