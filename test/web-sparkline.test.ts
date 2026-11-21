import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { sparkPath, cleanSeries } from '../web/src/lib/sparkline.js';

describe('sparkline', () => {
  it('draws nothing for fewer than two numbers', () => {
    assert.equal(sparkPath([]), null);
    assert.equal(sparkPath([4]), null);
    assert.equal(sparkPath([null, undefined, 3]), null);
    assert.equal(sparkPath(undefined), null);
  });

  it('ignores missing values', () => {
    assert.deepEqual(cleanSeries([1, null, NaN, Infinity, 2, undefined, '3']), [1, 2]);
  });

  it('puts the highest value at the top and the lowest at the bottom', () => {
    const p = sparkPath([0, 10], { width: 100, height: 20, pad: 2 });
    assert.equal(p.line, 'M2 18 L98 2');
    assert.deepEqual(p.last, [98, 2]);
    assert.equal(p.min, 0);
    assert.equal(p.max, 10);
  });

  it('closes the area under the line along the bottom edge', () => {
    const p = sparkPath([1, 2, 3], { width: 100, height: 20, pad: 2 });
    assert.ok(p.area.startsWith(p.line));
    assert.ok(p.area.endsWith('L98 20 L2 20 Z'));
  });

  it('keeps a flat series in the middle', () => {
    const p = sparkPath([5, 5, 5], { width: 100, height: 20, pad: 2 });
    assert.equal(p.line, 'M2 10 L50 10 L98 10');
  });
});
