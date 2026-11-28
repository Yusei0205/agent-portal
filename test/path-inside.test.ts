import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isInside, isInsideOrSame } from '../server/storage-path.ts';

describe('folder containment', () => {
  const root = path.resolve('/srv/work');
  it('accepts paths inside the folder', () => {
    assert.equal(isInside(root, path.join(root, 'a', 'b.txt')), true);
    assert.equal(isInsideOrSame(root, path.join(root, 'a')), true);
  });
  it('treats the folder itself as inside only for isInsideOrSame', () => {
    assert.equal(isInside(root, root), false);
    assert.equal(isInsideOrSame(root, root), true);
  });
  it('rejects a sibling whose name starts with the folder name', () => {
    const sibling = path.resolve('/srv/work-evil/secret.txt');
    assert.equal(isInside(root, sibling), false);
    assert.equal(isInsideOrSame(root, sibling), false);
    // the old startsWith check accepted it
    assert.equal(sibling.startsWith(root), true);
  });
  it('rejects traversal out of the folder', () => {
    assert.equal(isInsideOrSame(root, path.resolve(root, '..', 'other')), false);
    assert.equal(isInsideOrSame(root, path.resolve(root, 'a', '..', '..', 'x')), false);
  });
});
