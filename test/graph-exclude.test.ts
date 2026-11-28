/**
 * The exclude list of a code graph: which folders and files are left out of a clone before graphify runs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseExcludes, isExcluded, pruneExcluded, topFolders, EXCLUDE_LIMITS } from '../server/agent/runner-graph-build.ts';

describe('parseExcludes', () => {
  it('trims, turns \\ into /, drops blanks, comments and duplicates', () => {
    const r = parseExcludes(['  node_modules/ ', 'src\\legacy\\', '', '# a note', 'node_modules/', '*.min.js']);
    assert.deepEqual(r, { ok: true, patterns: ['node_modules/', 'src/legacy/', '*.min.js'] });
  });
  it('accepts nothing at all', () => {
    assert.deepEqual(parseExcludes(undefined), { ok: true, patterns: [] });
    assert.deepEqual(parseExcludes([]), { ok: true, patterns: [] });
  });
  it('refuses a pattern that goes up a folder, one that would leave out everything, and a bad list', () => {
    assert.equal(parseExcludes(['../x']).ok, false);
    assert.equal(parseExcludes(['a/../b']).ok, false);
    for (const all of ['*', '**', '/', '.', './', '**/*']) assert.equal(parseExcludes([all]).ok, false, `"${all}" leaves out everything`);
    assert.equal(parseExcludes('node_modules').ok, false);
    assert.equal(parseExcludes([1]).ok, false);
    assert.equal(parseExcludes(['x'.repeat(EXCLUDE_LIMITS.length + 1)]).ok, false);
    assert.equal(parseExcludes(Array.from({ length: EXCLUDE_LIMITS.patterns + 1 }, (_, i) => `d${i}/`)).ok, false);
    assert.equal(parseExcludes(['a\u0000b']).ok, false);
  });
});

describe('isExcluded', () => {
  it('a name without a slash matches at any depth; a trailing slash means a folder only', () => {
    assert.equal(isExcluded('node_modules', true, ['node_modules/']), true);
    assert.equal(isExcluded('packages/a/node_modules', true, ['node_modules/']), true);
    assert.equal(isExcluded('node_modules', false, ['node_modules/']), false, 'a file called node_modules is not a folder');
    assert.equal(isExcluded('node_modules', false, ['node_modules']), true, 'without the slash both match');
    assert.equal(isExcluded('src/node_modules_old', true, ['node_modules/']), false);
  });
  it('a pattern with a slash is from the repository root', () => {
    assert.equal(isExcluded('src/legacy', true, ['src/legacy/']), true);
    assert.equal(isExcluded('app/src/legacy', true, ['src/legacy/']), false);
    assert.equal(isExcluded('app/src/legacy', true, ['**/src/legacy/']), true);
    assert.equal(isExcluded('src/legacy', true, ['/src/legacy/']), true);
  });
  it('* stays inside one folder, ** crosses folders, ? is one character', () => {
    assert.equal(isExcluded('lib/app.min.js', false, ['*.min.js']), true);
    assert.equal(isExcluded('lib/app.js', false, ['*.min.js']), false);
    assert.equal(isExcluded('docs/a/b.md', false, ['docs/*.md']), false);
    assert.equal(isExcluded('docs/b.md', false, ['docs/*.md']), true);
    assert.equal(isExcluded('docs/a/b.md', false, ['docs/**/*.md']), true);
    assert.equal(isExcluded('docs/b.md', false, ['docs/**/*.md']), true, '** also matches no folder at all');
    assert.equal(isExcluded('v1', true, ['v?/']), true);
    assert.equal(isExcluded('v10', true, ['v?/']), false);
  });
  it('treats characters that mean something in a regular expression as plain text', () => {
    assert.equal(isExcluded('a.b', false, ['a.b']), true);
    assert.equal(isExcluded('axb', false, ['a.b']), false);
    assert.equal(isExcluded('c++', false, ['c++']), true);
    assert.equal(isExcluded('f(1)', false, ['f(1)']), true);
  });
});

describe('pruneExcluded', () => {
  let tmp: string;
  const put = (rel: string, body = 'x'): void => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exclude-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('deletes what matches, counts it, and leaves the rest and .git alone', () => {
    put('src/app.ts');
    put('src/legacy/old.ts');
    put('node_modules/x/index.js');
    put('packages/a/node_modules/y/index.js');
    put('public/app.min.js');
    put('public/app.js');
    put('.git/config');
    put('.git/node_modules/keep');
    const removed = pruneExcluded(tmp, ['node_modules/', 'src/legacy/', '*.min.js']);
    assert.deepEqual(removed, { dirs: 3, files: 1 });
    assert.equal(fs.existsSync(path.join(tmp, 'src/app.ts')), true);
    assert.equal(fs.existsSync(path.join(tmp, 'public/app.js')), true);
    assert.equal(fs.existsSync(path.join(tmp, 'src/legacy')), false);
    assert.equal(fs.existsSync(path.join(tmp, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(tmp, 'packages/a/node_modules')), false);
    assert.equal(fs.existsSync(path.join(tmp, 'public/app.min.js')), false);
    assert.equal(fs.existsSync(path.join(tmp, '.git/config')), true);
    assert.equal(fs.existsSync(path.join(tmp, '.git/node_modules/keep')), true, 'never reaches into .git');
  });
  it('does nothing without patterns', () => {
    put('keep/me.ts');
    assert.deepEqual(pruneExcluded(tmp, []), { dirs: 0, files: 0 });
    assert.equal(fs.existsSync(path.join(tmp, 'keep/me.ts')), true);
  });
});

describe('topFolders', () => {
  it('counts the items per folder, two levels deep, largest first', () => {
    const nodes = [
      ...Array.from({ length: 5 }, () => ({ source_file: 'vendor/lib/a.js' })),
      ...Array.from({ length: 3 }, () => ({ source_file: 'vendor/lib/deep/b.js' })),
      ...Array.from({ length: 2 }, () => ({ source_file: 'src/app/c.ts' })),
      { source_file: 'top.ts' },
      { label: 'no file' },
    ];
    assert.deepEqual(topFolders({ nodes }), [{ path: 'vendor/lib', nodes: 8 }, { path: 'src/app', nodes: 2 }]);
    assert.deepEqual(topFolders({ nodes }, 1), [{ path: 'vendor', nodes: 8 }, { path: 'src', nodes: 2 }]);
    assert.deepEqual(topFolders(null), []);
  });
});
