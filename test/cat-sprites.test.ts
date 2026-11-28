/** The cat's pixel sprites: grid shape, palette, frame counts and a few sanity checks that they are drawn cats. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { SPRITES, SPRITE_SIZE, PALETTE_KEYS, sheetRects, frameCount } from '../web/src/lib/cat-sprites.js';

const EXPECTED: Record<string, number> = { walk: 4, idle: 4, wave: 2, celebrate: 4, worried: 2, alert: 2, working: 4 };
const names = Object.keys(EXPECTED);
const count = (frame: string[], ch?: string) => frame.join('').split('').filter((c) => (ch ? c === ch : c !== '.')).length;

describe('cat sprites', () => {
  it('has every animation with the right number of frames', () => {
    assert.deepEqual(Object.keys(SPRITES).sort(), [...names].sort());
    for (const n of names) {
      assert.equal(SPRITES[n].frames.length, EXPECTED[n], n);
      assert.equal(frameCount(n), EXPECTED[n]);
      assert.ok(SPRITES[n].fps > 0);
      assert.equal(typeof SPRITES[n].loop, 'boolean');
    }
  });
  it('draws 16 rows of 16 characters from the palette only', () => {
    assert.equal(SPRITE_SIZE, 16);
    const allowed = new Set(['.', ...Object.keys(PALETTE_KEYS)]);
    for (const n of names) for (const frame of SPRITES[n].frames as string[][]) {
      assert.equal(frame.length, 16, n);
      for (const line of frame) {
        assert.equal(line.length, 16, `${n}: ${line}`);
        for (const ch of line) assert.ok(allowed.has(ch), `${n}: unexpected ${ch}`);
      }
    }
  });
  it('never leaves an empty frame', () => {
    for (const n of names) for (const frame of SPRITES[n].frames as string[][]) assert.ok(count(frame) >= 40, n);
  });
  it('is a calico: white fur with orange and brown patches, pink ears, a collar and a clover charm', () => {
    assert.deepEqual(Object.values(PALETTE_KEYS).sort(),
      ['accent', 'belly', 'blush', 'brown', 'clover', 'collar', 'eye', 'fur', 'orange', 'outline', 'pink', 'tag']);
    for (const n of ['idle', 'wave', 'celebrate', 'alert', 'worried'] as const) {
      const f0 = (SPRITES[n].frames as string[][])[0];
      for (const ch of ['p', 'n', 'c', 'l', 'f']) assert.ok(count(f0, ch) >= 2, `${n} has ${ch}`);
      assert.ok(count(f0, 'f') + count(f0, 'b') >= 0.8 * (count(f0, 'p') + count(f0, 'n')), `${n}: cream and grey still show about as much as the patches`);
    }
    const walk = (SPRITES.walk.frames as string[][])[0];
    for (const ch of ['p', 'n', 'c', 'g', 'l', 'r']) assert.ok(count(walk, ch) >= 1, `walk has ${ch}`);
  });
  it('matches the owner\'s cat: brown on the left half, orange on the right, a cream blaze, no mixing', () => {
    for (const n of ['idle', 'wave', 'celebrate', 'alert', 'worried', 'working'] as const) {
      for (const frame of SPRITES[n].frames as string[][]) {
        const at = (x: number, y: number) => frame[y][x];
        const collarRow = frame.findIndex((l) => l.includes('c'));
        const rows = frame.slice(0, collarRow).map((l, y) => ({ l, y }));
        assert.ok(rows.length > 0);
        let brown = 0, orange = 0;
        for (const { l } of rows) for (let x = 0; x < 16; x++) {
          if (l[x] === 'n') { brown++; assert.ok(x <= 7, `${n}: brown at x=${x} on the right`); }
          if (l[x] === 'p') { orange++; assert.ok(x >= 8, `${n}: orange at x=${x} on the left`); }
        }
        assert.ok(brown >= 3 && orange >= 3, `${n}: both head halves are patched`);
        // the cream blaze: the centre columns of the face are fur between the eyes
        const eyeRow = frame.findIndex((l) => l.includes('e'));
        if (eyeRow < 0) continue; // a blink
        assert.equal(at(7, eyeRow), 'f'); assert.equal(at(8, eyeRow), 'f');
        assert.equal(at(7, eyeRow - 1), 'f'); assert.equal(at(8, eyeRow - 1), 'f');
      }
    }
  });
  it('wears a green plus-shaped clover with a gold centre under the collar', () => {
    for (const n of ['idle', 'wave', 'celebrate', 'alert', 'worried'] as const) {
      for (const frame of SPRITES[n].frames as string[][]) {
        assert.ok(count(frame, 'l') >= 3, `${n}: clover leaves`);
        const cy = frame.findIndex((l) => l.includes('g'));
        assert.ok(cy > 0, `${n}: gold centre`);
        const cx = frame[cy].indexOf('g');
        assert.equal(frame[cy][cx - 1], 'l'); assert.equal(frame[cy][cx + 1], 'l');
        assert.equal(frame[cy - 1][cx], 'l'); assert.equal(frame[cy + 1][cx], 'l');
        assert.ok(frame[cy - 2].includes('c'), `${n}: collar sits above the clover`);
      }
    }
    const walk = (SPRITES.walk.frames as string[][])[0];
    assert.ok(count(walk, 'l') >= 3 && count(walk, 'g') === 1);
  });
  it('the face keeps two eyes and pink ears with the patches on', () => {
    const f0 = (SPRITES.idle.frames as string[][])[0];
    assert.equal(count(f0, 'e'), 4); // two eyes, two pixels tall
    assert.ok(count(f0, 'r') >= 4); // two ear insides, two nose pixels
  });
  it('working shows the laptop and typing dots that change from frame to frame', () => {
    const frames = SPRITES.working.frames as string[][];
    assert.equal(SPRITES.working.loop, true);
    assert.equal(new Set(frames.map((f) => f.join('|'))).size, 4);
    for (const f of frames) assert.ok(count(f, 'a') >= 15, 'laptop lid is painted in the accent');
    assert.ok(count(frames[2], 'a') > count(frames[0], 'a'), 'dots count up');
  });
  it('walk frames differ (a cycle, not a still)', () => {
    const distinct = new Set((SPRITES.walk.frames as string[][]).map((f) => f.join('|')));
    assert.ok(distinct.size >= 3);
  });
  it('sheetRects lists every painted pixel once', () => {
    const rects = sheetRects('idle');
    const total = (SPRITES.idle.frames as string[][]).reduce((s, f) => s + count(f), 0);
    assert.equal(rects.length, total);
    for (const r of rects) {
      assert.ok(r.frame < frameCount('idle'));
      assert.ok(r.x >= 0 && r.x <= 15 && r.y >= 0 && r.y <= 15);
      assert.ok(Object.values(PALETTE_KEYS).includes(r.key));
    }
  });
  it('idle blinks (frame 1 shows fewer eye pixels) and otherwise stays close to frame 0', () => {
    const f = SPRITES.idle.frames as string[][];
    assert.ok(count(f[1], 'e') < count(f[0], 'e'));
    let diff = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (f[0][y][x] !== f[1][y][x]) diff++;
    assert.ok(diff <= 6);
  });
});
