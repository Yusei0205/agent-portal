/**
 * Unit tests for web/src/lib/vaultFolders.js — buildFolderList helper.
 *
 * Run:
 *   npm run test:affected -- --module vault
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain-JS module without types
import { buildFolderList } from '../web/src/lib/vaultFolders.js';

describe('buildFolderList', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(buildFolderList([]), []);
  });

  it('returns empty array when all folder values are null', () => {
    assert.deepEqual(buildFolderList([{ folder: null }, { folder: null }]), []);
  });

  it('returns empty array when all folder values are empty strings', () => {
    assert.deepEqual(buildFolderList([{ folder: '' }]), []);
  });

  it('includes ancestor paths for a deeply nested folder', () => {
    const files = [{ folder: 'a/b/c' }];
    assert.deepEqual(buildFolderList(files), ['a', 'a/b', 'a/b/c']);
  });

  it('deduplicates paths across files', () => {
    const files = [{ folder: 'a/b' }, { folder: 'a/b' }, { folder: 'a/b/c' }];
    assert.deepEqual(buildFolderList(files), ['a', 'a/b', 'a/b/c']);
  });

  it('sorts results alphabetically', () => {
    const files = [{ folder: 'z/y' }, { folder: 'a/b' }, { folder: 'a' }];
    assert.deepEqual(buildFolderList(files), ['a', 'a/b', 'z', 'z/y']);
  });

  it('handles mixed null and non-null folders', () => {
    const files = [
      { folder: null },
      { folder: 'docs' },
      { folder: 'docs/api' },
    ];
    assert.deepEqual(buildFolderList(files), ['docs', 'docs/api']);
  });

  it('handles single-level folders', () => {
    const files = [{ folder: 'images' }, { folder: 'docs' }];
    assert.deepEqual(buildFolderList(files), ['docs', 'images']);
  });

  it('handles files with undefined folder property', () => {
    const files = [{ folder: undefined }, { folder: 'reports' }];
    // @ts-expect-error testing undefined
    assert.deepEqual(buildFolderList(files), ['reports']);
  });

  it('normalizes paths with trailing slashes', () => {
    // split('/').filter(Boolean) removes empty segments from trailing slashes
    const files = [{ folder: 'a/b/' }];
    assert.deepEqual(buildFolderList(files), ['a', 'a/b']);
  });
});
