/**
 * Finalize helpers (server/agent/runner-finalize.ts): change detection, branch names, protected branches and the
 * guarded push. Real temporary git repositories and a local bare remote; no network.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { slugify, branchNameFor, isProtectedBranch, detectChanges, pushBranch } from '../server/agent/runner-finalize.ts';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

let root: string;
let seq = 0;
/** A bare remote plus a clone of it with one commit on main pushed. */
function makeRepo(): { remote: string; work: string } {
  const dir = path.join(root, `r${++seq}`);
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, work], { stdio: 'ignore' });
  git(work, 'checkout', '-b', 'main');
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'init');
  git(work, 'push', 'origin', 'main');
  git(work, 'fetch', 'origin');
  return { remote, work };
}

before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('slugify', () => {
  it('lowercases, replaces runs of other characters with one dash and trims dashes', () => {
    assert.equal(slugify('Fix the Login Bug!'), 'fix-the-login-bug');
    assert.equal(slugify('  --Hello___World--  '), 'hello-world');
    assert.equal(slugify('a/b\\c..d'), 'a-b-c-d');
  });
  it('cuts at the maximum without leaving a trailing dash', () => {
    const s = slugify('word '.repeat(30), 40);
    assert.ok(s.length <= 40);
    assert.ok(!s.endsWith('-') && !s.startsWith('-'));
    assert.equal(slugify('abcdef ghij', 7), 'abcdef');
  });
  it('returns an empty string when nothing usable is left', () => {
    assert.equal(slugify('!!!'), '');
    assert.equal(slugify('日本語'), '');
  });
});

describe('branchNameFor', () => {
  it('uses the ticket key and slug', () => {
    assert.equal(branchNameFor({ ticketKey: 'ABC-12', title: 'Fix the login bug' }), 'portal/ABC-12-fix-the-login-bug');
  });
  it('works without a ticket', () => {
    assert.equal(branchNameFor({ title: 'Fix the login bug' }), 'portal/fix-the-login-bug');
    assert.equal(branchNameFor({ ticketKey: null, title: 'Fix' }), 'portal/fix');
  });
  it('appends -2, -3 on a clash', () => {
    assert.equal(branchNameFor({ title: 'Fix', taken: ['portal/fix'] }), 'portal/fix-2');
    assert.equal(branchNameFor({ title: 'Fix', taken: ['portal/fix', 'portal/fix-2'] }), 'portal/fix-3');
  });
  it('falls back to a fixed word for an empty title and always passes the branch check', () => {
    const n = branchNameFor({ ticketKey: 'X-1', title: '!!!' });
    assert.match(n, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/);
    assert.ok(!n.includes('..'));
    assert.match(branchNameFor({ title: '' }), /^portal\/[a-z0-9-]+$/);
  });
  it('cleans an odd ticket key', () => {
    assert.match(branchNameFor({ ticketKey: 'A B/../C', title: 'x' }), /^portal\/[A-Za-z0-9-]+-x$/);
  });
});

describe('isProtectedBranch', () => {
  it('matches exact names', () => {
    assert.equal(isProtectedBranch('main', ['main', 'develop']), true);
    assert.equal(isProtectedBranch('develop', ['main', 'develop']), true);
    assert.equal(isProtectedBranch('feature', ['main', 'develop']), false);
  });
  it('matches * patterns', () => {
    assert.equal(isProtectedBranch('release/1.2', ['release/*']), true);
    assert.equal(isProtectedBranch('release/1.2/hotfix', ['release/*']), true);
    assert.equal(isProtectedBranch('release', ['release/*']), false);
  });
  it('does not match a name that only starts like a pattern', () => {
    assert.equal(isProtectedBranch('releases/1', ['release/*']), false);
    assert.equal(isProtectedBranch('release-notes', ['release/*']), false);
    assert.equal(isProtectedBranch('mainline', ['main']), false);
    assert.equal(isProtectedBranch('xmain', ['main']), false);
  });
  it('treats regex characters in a pattern literally', () => {
    assert.equal(isProtectedBranch('releaseX1', ['release.1']), false);
    assert.equal(isProtectedBranch('release.1', ['release.1']), true);
  });
  it('always protects the default branch', () => {
    assert.equal(isProtectedBranch('trunk', [], 'trunk'), true);
    assert.equal(isProtectedBranch('trunk', [], null), false);
  });
  it('ignores empty patterns', () => {
    assert.equal(isProtectedBranch('x', ['', '  ']), false);
  });
});

describe('detectChanges', () => {
  it('reports nothing for a clean repository', async () => {
    const { work } = makeRepo();
    assert.deepEqual(await detectChanges(work, 'main'), { commits: 0, files: 0 });
  });
  it('counts uncommitted changes (modified and untracked)', async () => {
    const { work } = makeRepo();
    fs.writeFileSync(path.join(work, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    assert.deepEqual(await detectChanges(work, 'main'), { commits: 0, files: 2 });
  });
  it('counts commits ahead and the files they touch', async () => {
    const { work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'b');
    fs.writeFileSync(path.join(work, 'c.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'c');
    assert.deepEqual(await detectChanges(work, 'main'), { commits: 2, files: 2 });
  });
  it('counts both, without counting a file twice', async () => {
    const { work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'b');
    fs.writeFileSync(path.join(work, 'b.txt'), 'again\n');
    fs.writeFileSync(path.join(work, 'd.txt'), 'x\n');
    assert.deepEqual(await detectChanges(work, 'main'), { commits: 1, files: 2 });
  });
});

describe('pushBranch', () => {
  const base = { base: 'main', protectedPatterns: ['main', 'master', 'develop', 'release/*'], defaultBranch: 'main', message: 'ABC-1: fix it', env: {} };

  it('pushes a new branch and the remote has it', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    const { sha } = await pushBranch({ ...base, repoDir: work, branch: 'portal/abc-1-fix' });
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/portal/abc-1-fix'), sha);
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'refs/heads/portal/abc-1-fix'), 'ABC-1: fix it');
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), git(work, 'rev-parse', 'origin/main'));
  });

  it('uses the given identity, else a neutral one', async () => {
    const a = makeRepo();
    fs.writeFileSync(path.join(a.work, 'b.txt'), 'x\n');
    await pushBranch({ ...base, repoDir: a.work, branch: 'portal/one', identity: { name: 'Bot Person', email: 'bot@example.com' } });
    assert.equal(git(a.remote, 'log', '-1', '--format=%an <%ae>', 'refs/heads/portal/one'), 'Bot Person <bot@example.com>');
    const b = makeRepo();
    fs.writeFileSync(path.join(b.work, 'b.txt'), 'x\n');
    await pushBranch({ ...base, repoDir: b.work, branch: 'portal/two' });
    assert.match(git(b.remote, 'log', '-1', '--format=%an', 'refs/heads/portal/two'), /Agent Portal/);
  });

  it('reuses existing commits when nothing is left to stage', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'already committed');
    const { sha } = await pushBranch({ ...base, repoDir: work, branch: 'portal/reuse' });
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'refs/heads/portal/reuse'), 'already committed');
    assert.equal(git(remote, 'rev-parse', 'refs/heads/portal/reuse'), sha);
    assert.equal(git(remote, 'rev-list', '--count', 'refs/heads/portal/reuse'), '2');
  });

  it('refuses the default branch and listed branches before touching git', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    await assert.rejects(pushBranch({ ...base, repoDir: work, branch: 'main' }), /protected/i);
    await assert.rejects(pushBranch({ ...base, repoDir: work, branch: 'trunk', defaultBranch: 'trunk' }), /protected/i);
    assert.equal(git(work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(remote, 'rev-list', '--count', 'refs/heads/main'), '1');
  });

  it('refuses a name matching a pattern', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    await assert.rejects(pushBranch({ ...base, repoDir: work, branch: 'release/9.9' }), /protected/i);
    await assert.rejects(pushBranch({ ...base, repoDir: work, branch: 'portal/x', protectedPatterns: ['portal/*'] }), /protected/i);
    assert.equal(git(remote, 'branch', '--list').includes('release'), false);
  });

  it('refuses invalid branch names', async () => {
    const { work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    for (const branch of ['a..b', '-x', '', 'has space', 'x;rm', '--force', 'a'.repeat(201), '.hidden']) {
      await assert.rejects(pushBranch({ ...base, repoDir: work, branch }), /branch name/i, `should refuse ${JSON.stringify(branch)}`);
    }
  });

  it('leaves excluded paths out of the commit', async () => {
    const { remote, work } = makeRepo();
    fs.mkdirSync(path.join(work, '.claude'));
    fs.writeFileSync(path.join(work, '.claude', 'settings.json'), '{}');
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    await pushBranch({ ...base, repoDir: work, branch: 'portal/ex', excludePaths: ['.claude'] });
    const files = git(remote, 'ls-tree', '-r', '--name-only', 'refs/heads/portal/ex').split('\n');
    assert.ok(files.includes('b.txt'));
    assert.ok(!files.some((f) => f.startsWith('.claude')));
  });

  it('rejects a failing push with no credentials in the message', async () => {
    const { remote, work } = makeRepo();
    git(work, 'remote', 'set-url', 'origin', 'https://user:s3cretpass@127.0.0.1:1/none.git');
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    await assert.rejects(pushBranch({ ...base, repoDir: work, branch: 'portal/fail' }), (e: Error) => {
      assert.ok(e.message.length > 0);
      assert.ok(!e.message.includes('s3cretpass'), e.message);
      assert.ok(!e.message.includes('user:'), e.message);
      return true;
    });
    // and a plain missing remote
    git(work, 'remote', 'set-url', 'origin', remote);
    fs.rmSync(remote, { recursive: true, force: true });
    await assert.rejects(pushBranch({ ...base, repoDir: work, branch: 'portal/fail2' }), (e: Error) => !/s3cret/.test(e.message));
  });

  it('redacts env values from the message', async () => {
    const { work } = makeRepo();
    git(work, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/tok-ABCDEF123456.git');
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    await assert.rejects(pushBranch({ ...base, repoDir: work, branch: 'portal/fail3', env: { GIT_TOKEN: 'tok-ABCDEF123456' } }), (e: Error) => !e.message.includes('tok-ABCDEF123456'));
  });
});
