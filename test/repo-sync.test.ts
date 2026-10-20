import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo } from './fixtures.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-'));
process.env.DATA_DIR = path.join(root, 'data');

const { git, gitErrorSummary, gitProgress } = await import('../server/git.ts');
const { pruneStaleRefs } = await import('../server/repos.ts');

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

let bare: string;
let clone: string;

before(() => {
  bare = makeRepo(root);
  const sha = g(bare, 'rev-parse', 'main');
  // Two branches whose names differ only in case, both packed (as CodeCommit clones end up).
  g(bare, 'update-ref', 'refs/heads/fix/RLP-2212', sha);
  g(bare, 'pack-refs', '--all');
  g(bare, 'update-ref', 'refs/heads/fix/rlp-2212', sha);
  g(bare, 'pack-refs', '--all');
  clone = path.join(root, 'clone');
  execFileSync('git', ['clone', '-q', bare, clone]);
  // Upstream deletes both and adds a new branch.
  g(bare, 'update-ref', '-d', 'refs/heads/fix/RLP-2212');
  g(bare, 'update-ref', '-d', 'refs/heads/fix/rlp-2212');
  g(bare, 'update-ref', 'refs/heads/feature/new', sha);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const localRefs = () => g(clone, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin').split('\n');

test('gitErrorSummary prefers error lines over fetch --prune noise', () => {
  const stderr = [
    "error: could not delete references: cannot lock ref 'refs/remotes/origin/fix/rlp-2212': File exists.",
    'Another git process seems to be running in this repository',
    'From codecommit://repo',
    ...Array.from({ length: 50 }, (_, i) => ` - [deleted]             (none)     -> origin/old-${i}`),
  ].join('\n');
  const msg = gitErrorSummary(stderr, 'exit code 1');
  assert.match(msg, /cannot lock ref/);
  assert.doesNotMatch(msg, /\[deleted\]/);
  assert.equal(gitErrorSummary('', 'exit code 1'), 'exit code 1');
  assert.equal(gitErrorSummary('line a\nline b', 'x'), 'line a\nline b');
});

test('fetch --prune fails on case-insensitive file systems (repro)', { skip: !['win32', 'darwin'].includes(process.platform) && 'case-sensitive file system' }, async () => {
  await assert.rejects(
    gitProgress(['fetch', '--progress', '--prune', 'origin'], { cwd: clone }, () => undefined),
    /cannot lock ref|could not delete references/,
  );
});

test('pruneStaleRefs removes stale case-colliding refs so fetch --prune succeeds', async () => {
  const removed = await pruneStaleRefs(clone, {});
  assert.ok(removed >= 1);
  assert.ok(!localRefs().some((r) => /fix\/rlp-2212/i.test(r)), 'stale refs are gone');
  assert.ok(localRefs().includes('refs/remotes/origin/main'), 'live branches are kept');
  await gitProgress(['fetch', '--progress', '--prune', 'origin'], { cwd: clone }, () => undefined);
  assert.ok(localRefs().includes('refs/remotes/origin/feature/new'), 'new branch fetched');
  assert.equal((await git(['rev-parse', 'origin/main'], { cwd: clone })).stdout.trim(), g(bare, 'rev-parse', 'main'));
});
