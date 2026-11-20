/**
 * The cat's pixel art, drawn in code: 16x16 character grids, one per animation frame.
 *   .  transparent   o outline   f fur (white)   b belly (shaded white)   a accent (sparkles, marks)   e eye   k blush (cheeks)
 *   r pink (ears, nose)   p orange patch   n brown patch   c collar   g tag (gold)
 * The cat is a calico: white fur with an orange patch on the left of the face and body and a brown patch on the right; patches only
 * ever replace fur or belly pixels, so the outline, eyes and face stay readable. The frames are composed by a tiny painter (so a pose is a few lines, not 256 hand-typed characters) and exported as plain string
 * grids; the component renders them as crisp SVG rects coloured from theme tokens. No image files.
 */
export const SPRITE_SIZE = 16;
export const PALETTE_KEYS = {
  o: 'outline', f: 'fur', b: 'belly', a: 'accent', e: 'eye', k: 'blush', r: 'pink', p: 'orange', n: 'brown', c: 'collar', g: 'tag',
};

function canvas() {
  const g = Array.from({ length: SPRITE_SIZE }, () => Array(SPRITE_SIZE).fill('.'));
  const put = (x, y, c) => { if (x >= 0 && x < SPRITE_SIZE && y >= 0 && y < SPRITE_SIZE && c !== ' ') g[y][x] = c; };
  const row = (x0, y, s) => { for (let i = 0; i < s.length; i++) put(x0 + i, y, s[i]); };
  // Colours a pixel only where there is white fur or belly (the calico patches), never over an outline, an eye or the background.
  const tint = (pts, ch) => { for (const [x, y] of pts) if (g[y]?.[x] === 'f' || g[y]?.[x] === 'b') g[y][x] = ch; };
  return { put, row, tint, done: () => g.map((r) => r.join('')) };
}

/** A sitting cat seen from the front; dy lifts it (hops), the options pick the face and the arms. */
function front({ dy = 2, eyes = 'open', ears = 'up', tail = 0, armsR = 0, armsL = 0, extra } = {}) {
  const c = canvas();
  const r = (y, x, s) => c.row(x, y + dy, s);
  if (ears === 'up') {
    c.put(4, dy, 'o'); c.put(11, dy, 'o');
    r(1, 3, 'oro'); r(1, 10, 'oro');
  } else {
    r(1, 3, 'ofo'); r(1, 10, 'ofo'); // drooping ears
  }
  r(2, 3, 'offooooffo');
  const solid = 'offffffffo';
  if (eyes === 'open') { r(3, 3, solid); r(4, 3, 'ofeffffefo'); r(5, 3, 'ofeffffefo'); }
  else if (eyes === 'blink') { r(3, 3, solid); r(4, 3, solid); r(5, 3, 'ofoffffofo'); }
  else if (eyes === 'wide') { r(3, 3, solid); r(4, 3, 'ofeeffeefo'); r(5, 3, 'ofeeffeefo'); }
  else { r(3, 3, 'ofooffoofo'); r(4, 3, 'ofeffffefo'); r(5, 3, 'ofeffffefo'); } // worried: heavy brows over the eyes
  r(6, 3, 'okffrrffko');
  r(7, 4, 'occcccco'); // the collar
  r(8, 4, 'ofbbbbfo'); r(9, 3, 'offbbbbffo'); r(10, 3, 'offbbbbffo'); r(11, 3, 'offbbbbffo');
  r(12, 2, 'ooffbbbbffoo'); r(13, 2, 'oooooooooooo');
  const tails = [
    [[14, 12], [14, 11], [14, 10], [15, 9]],
    [[14, 12], [14, 11], [15, 10], [15, 9]],
    [[14, 12], [15, 11], [15, 10], [15, 9]],
  ][tail] ?? [];
  if (!armsR) for (const [x, y] of tails) c.put(x, y + dy, 'p');
  // calico patches: orange on the left of the face and body, brown on the right, white between
  const at = (pts) => pts.map(([x, y]) => [x, y + dy]);
  c.tint(at([[4, 1], [4, 2], [5, 2], [4, 3], [5, 3], [6, 3], [4, 4], [5, 8], [4, 9], [5, 9], [4, 10], [4, 11], [4, 12]]), 'p');
  c.tint(at([[11, 1], [10, 2], [11, 2], [9, 3], [10, 3], [11, 3], [11, 4], [11, 5], [10, 9], [11, 9], [11, 10], [10, 11], [11, 11], [10, 12], [11, 12]]), 'n');
  c.put(7, 8 + dy, 'g'); c.put(8, 8 + dy, 'g'); // the gold tag under the collar
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
  r(3, 9, 'oro oro');
  r(4, 9, 'offfffo');
  r(5, 9, 'offfeeo');
  r(6, 9, 'offfkfr');
  r(7, 10, 'oooooo');
  r(7, 3, 'oooooo');
  r(8, 2, 'offffffffo');
  r(9, 2, 'offfbbbbfo');
  r(10, 2, 'offbbbbbfo');
  r(11, 3, 'oooooooo');
  for (const [x, lift] of legs) {
    for (let y = 11; y <= 14 - lift; y++) c.put(x, y + dy, 'o');
  }
  for (const [x, y] of tail) c.put(x, y + dy, 'p');
  const at = (pts) => pts.map(([x, y]) => [x, y + dy]);
  c.tint(at([[10, 4], [11, 4], [10, 5], [3, 8], [4, 8], [5, 8], [3, 9], [4, 9], [4, 10]]), 'p');
  c.tint(at([[13, 4], [14, 4], [7, 8], [8, 8], [9, 8], [8, 9], [9, 9]]), 'n');
  for (const x of [10, 11, 12]) c.put(x, 7 + dy, 'c'); // the collar under the chin
  c.put(12, 8 + dy, 'g'); // the gold tag
  if (step) step(c);
  return c.done();
}

const sparkle = (pts) => (c) => { for (const [x, y] of pts) c.put(x, y, 'a'); };
const bang = (c) => { for (const y of [1, 2, 3]) c.put(14, y, 'a'); c.put(14, 5, 'a'); };
/** The cat at a tiny laptop (seen from behind the lid), typing with alternating paws, with dots counting up beside its head. */
const typing = (dots, paw) => (c) => {
  c.row(4, 10, 'oooooooo'); c.row(4, 11, 'oaaaaaao'); c.row(4, 12, 'oaaabaao'); c.row(4, 13, 'oaaaaaao');
  c.row(3, 14, 'oooooooooo');
  c.put(paw ? 11 : 4, 14, 'f'); c.put(paw ? 4 : 11, 14, 'o'); // the paw that is down is on the keys
  for (let i = 0; i < dots; i++) c.put(13 + i, 3 - (i === 1 ? 1 : 0), 'a');
};
const drop = (y) => (c) => { c.put(14, y, 'a'); c.put(14, y + 1, 'a'); };

export const SPRITES = {
  walk: {
    fps: 8, loop: true,
    frames: [
      side({ legs: [[3, 1], [5, 0], [8, 0], [10, 1]], tail: [[1, 8], [1, 7], [1, 6], [1, 5], [2, 4]] }),
      side({ legs: [[4, 0], [6, 0], [9, 0], [10, 0]], tail: [[1, 8], [1, 7], [1, 6], [2, 5], [2, 4]] }),
      side({ legs: [[3, 0], [5, 1], [8, 1], [10, 0]], tail: [[1, 8], [0, 7], [0, 6], [0, 5], [1, 4]] }),
      side({ legs: [[2, 0], [5, 0], [7, 0], [11, 0]], tail: [[1, 8], [1, 7], [1, 6], [2, 5], [2, 4]] }),
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
  working: {
    fps: 4, loop: true,
    frames: [
      front({ dy: 2, eyes: 'open', tail: 0, extra: typing(1, 0) }),
      front({ dy: 2, eyes: 'open', tail: 1, extra: typing(2, 1) }),
      front({ dy: 2, eyes: 'blink', tail: 1, extra: typing(3, 0) }),
      front({ dy: 2, eyes: 'open', tail: 2, extra: typing(0, 1) }),
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
