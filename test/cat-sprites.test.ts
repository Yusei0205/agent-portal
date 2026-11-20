/** The cat's pixel sprites: grid shape, palette, frame counts and a few sanity checks that they are drawn cats. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { SPRITES, SPRITE_SIZE, PALETTE_KEYS, sheetRects, frameCount } from '../web/src/lib/cat-sprites.js';

const EXPECTED: Record<string, number> = { walk: 4, idle: 4, wave: 2, celebrate: 4, worried: 2, alert: 2 };
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
