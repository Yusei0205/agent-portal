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
import {
  slugify, branchNameFor, isProtectedBranch, detectChanges, pushBranch, classifyPushError, parseChangedPaths, repoChangeOf, MAX_REPORTED_PATHS,
  compileGlob, deniedBy, ProtectedPathError, _setBeforePushHookForTest,
} from '../server/agent/runner-finalize.ts';
import { validateFinalizeRequest } from '../server/agent/runner-finalize-run.ts';

/** The default protected paths of the auto-fix policy (server/autofix/policy.ts REQUIRED_PROTECTED_PATHS). */
const DEFAULT_DENY = ['.github/workflows/**', 'infra/**', '**/.env*', '**/*.pem', 'package-lock.json', '**/package-lock.json'];

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

describe('classifyPushError', () => {
  it('recognises a refused push as a permission problem', () => {
    for (const t of [
      'remote: Permission to org/repo.git denied to user.',
      'fatal: unable to access https://github.com/o/r.git/: The requested URL returned error: 403',
      'remote: HTTP 401 Unauthorized',
      'fatal: Authentication failed for https://x/y.git',
      'fatal: could not read Username for https://github.com: terminal prompts disabled',
      'User: arn:aws:iam::1:user/x is not authorized to perform: codecommit:GitPush',
    ]) assert.equal(classifyPushError(t), 'no-permission', t);
  });
  it('recognises missing saved files', () => {
    assert.equal(classifyPushError("The session's saved files could not be restored, so nothing was pushed."), 'no-workspace');
    assert.equal(classifyPushError('repos/ is missing'), 'no-workspace');
  });
  it('keeps everything else as a plain failure, and does not read digits inside words as a status', () => {
    assert.equal(classifyPushError('error: failed to push some refs (non-fast-forward)'), 'failed');
    assert.equal(classifyPushError('object 14031a2b is corrupt'), 'failed');
  });
});

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
    assert.deepEqual(await detectChanges(work, 'main'), { commits: 0, files: 0, paths: [] });
  });
  it('counts uncommitted changes (modified and untracked)', async () => {
    const { work } = makeRepo();
    fs.writeFileSync(path.join(work, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    assert.deepEqual(await detectChanges(work, 'main'), {
      commits: 0, files: 2, paths: [{ path: 'a.txt', added: 1, removed: 1 }, { path: 'b.txt', added: 1, removed: 0 }],
    });
  });
  it('counts commits ahead and the files they touch', async () => {
    const { work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'b');
    fs.writeFileSync(path.join(work, 'c.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'c');
    assert.deepEqual(await detectChanges(work, 'main'), {
      commits: 2, files: 2, paths: [{ path: 'b.txt', added: 1, removed: 0 }, { path: 'c.txt', added: 1, removed: 0 }],
    });
  });
  it('counts both, without counting a file twice', async () => {
    const { work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'b');
    fs.writeFileSync(path.join(work, 'b.txt'), 'again\n');
    fs.writeFileSync(path.join(work, 'd.txt'), 'x\n');
    assert.deepEqual(await detectChanges(work, 'main'), {
      commits: 1, files: 2, paths: [{ path: 'b.txt', added: 1, removed: 0 }, { path: 'd.txt', added: 1, removed: 0 }],
    });
  });
  it('reports a rename as the old path removed and the new one added, a deletion, nested paths and a binary file', async () => {
    const { work } = makeRepo();
    fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(work, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'ci');
    git(work, 'push', 'origin', 'main');
    git(work, 'mv', '.github/workflows/ci.yml', 'ci.yml');
    fs.rmSync(path.join(work, 'a.txt'));
    fs.writeFileSync(path.join(work, 'img.bin'), Buffer.from([0, 1, 2, 3]));
    const got = await detectChanges(work, 'main');
    const byPath = Object.fromEntries((got.paths ?? []).map((p) => [p.path, [p.added, p.removed]]));
    assert.deepEqual(byPath, { '.github/workflows/ci.yml': [0, 2], 'a.txt': [0, 1], 'ci.yml': [2, 0], 'img.bin': [0, 0] });
  });
  it('cuts the path list at MAX_REPORTED_PATHS', async () => {
    const { work } = makeRepo();
    for (let i = 0; i < MAX_REPORTED_PATHS + 5; i++) fs.writeFileSync(path.join(work, `f${i}.txt`), 'x\n');
    const got = await detectChanges(work, 'main');
    assert.equal(got.files, MAX_REPORTED_PATHS + 5);
    assert.equal(got.paths?.length, MAX_REPORTED_PATHS);
  });
});

describe('detectChanges does not trust the session\'s own base ref', () => {
  function hideWorkflowCommit(): { remote: string; work: string } {
    const r = makeRepo();
    fs.mkdirSync(path.join(r.work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(r.work, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    git(r.work, 'add', '-A');
    git(r.work, 'commit', '-m', 'sneaky');
    fs.writeFileSync(path.join(r.work, 'a.txt'), 'trivial\n');
    return r;
  }
  it('origin/main moved onto HEAD by the agent: the committed workflow change is still reported', async () => {
    const { work } = hideWorkflowCommit();
    git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const got = await detectChanges(work, 'main');
    assert.ok(got.paths?.some((p) => p.path === '.github/workflows/ci.yml'), JSON.stringify(got));
  });
  it('origin/main deleted: still reported', async () => {
    const { work } = hideWorkflowCommit();
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
    const got = await detectChanges(work, 'main');
    assert.ok(got.paths?.some((p) => p.path === '.github/workflows/ci.yml'), JSON.stringify(got));
  });
  it('a base the remote does not have: paths unknown (never a fallback to HEAD)', async () => {
    const { work } = hideWorkflowCommit();
    const got = await detectChanges(work, 'never-fetched');
    assert.equal(got.paths, undefined);
  });
  it('a remote that cannot be reached: paths unknown', async () => {
    const { work } = hideWorkflowCommit();
    git(work, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
    assert.equal((await detectChanges(work, 'main')).paths, undefined);
  });
});

describe('compileGlob / deniedBy', () => {
  it('agrees with path.matchesGlob on the default protected paths, and is case-insensitive and dot-directory aware', () => {
    const samples = [
      '.github/workflows/ci.yml', '.github/workflows/sub/x.yaml', '.github/ci.yml', 'github/workflows/ci.yml', 'infra/main.tf', 'infra/a/b.tf',
      'src/infra/x.tf', '.env', '.env.local', 'app/.env', 'app/.envrc', 'app/env', 'key.pem', 'a/b/c.pem', 'a.pem.txt', 'package-lock.json',
      'web/package-lock.json', 'web/package-lock.json.bak', 'src/cart.ts', 'README.md',
    ];
    const res = DEFAULT_DENY.map(compileGlob);
    for (const p of samples) {
      const ours = deniedBy(p, res, DEFAULT_DENY) !== null;
      const node = DEFAULT_DENY.some((g) => path.posix.matchesGlob(p, g));
      assert.equal(ours, node, p);
    }
    for (const p of ['.GitHub/Workflows/CI.yml', 'INFRA/x.tf', 'certs/Key.PEM', 'App/.ENV', 'Package-Lock.JSON', './infra/x', '/infra/x', 'x\\.env']) {
      assert.ok(deniedBy(p, res, DEFAULT_DENY), p);
    }
    assert.ok(deniedBy('.hidden/dir/package-lock.json', res, DEFAULT_DENY), 'dot-directories are crossed by **');
    assert.equal(deniedBy('src/a.ts', [compileGlob('src/?.ts')], ['src/?.ts']), 'src/?.ts');
    assert.equal(deniedBy('src/ab.ts', [compileGlob('src/?.ts')], ['src/?.ts']), null);
    assert.equal(deniedBy('a+b(c).ts', [compileGlob('a+b(c).ts')], ['x']), 'x', 'regex characters are literal');
  });
});

describe('pushBranch with denyPaths', () => {
  const opts = { base: 'main', protectedPatterns: ['main'], defaultBranch: 'main', message: 'fix', env: {}, denyPaths: DEFAULT_DENY };

  it('refuses each default protected path shape and its case variants; nothing reaches the remote', async () => {
    const files = [
      '.github/workflows/ci.yml', 'infra/main.tf', '.env', 'app/.env.local', 'certs/key.pem', 'package-lock.json', 'web/package-lock.json',
      '.GitHub/Workflows/CI.yml', 'INFRA/Main.tf', 'App/.ENV', 'certs/KEY.PEM', 'Package-Lock.json',
    ];
    for (const f of files) {
      const { remote, work } = makeRepo();
      fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      fs.writeFileSync(path.join(work, f), 'x\n');
      await assert.rejects(pushBranch({ ...opts, repoDir: work, branch: 'autofix/tests-1' }),
        (e: unknown) => e instanceof ProtectedPathError && e.code === 'protected-path' && e.message.includes(f), f);
      assert.equal(execFileSync('git', ['ls-remote', remote, 'refs/heads/autofix/tests-1'], { encoding: 'utf8' }).trim(), '', f);
    }
  });

  it("the reviewer's repro: a committed workflow hidden by moving origin/main is refused", async () => {
    const { remote, work } = makeRepo();
    fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(work, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'sneaky');
    git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    fs.writeFileSync(path.join(work, 'a.txt'), 'trivial\n');
    await assert.rejects(pushBranch({ ...opts, repoDir: work, branch: 'autofix/tests-2' }), /"\.github\/workflows\/ci\.yml" is a protected path/);
    assert.equal(execFileSync('git', ['ls-remote', remote, 'refs/heads/autofix/tests-2'], { encoding: 'utf8' }).trim(), '');
  });

  it('refuses when the base cannot be fetched, and pushes an allowed change', async () => {
    const a = makeRepo();
    fs.writeFileSync(path.join(a.work, 'b.txt'), 'x\n');
    await assert.rejects(pushBranch({ ...opts, base: 'gone', repoDir: a.work, branch: 'autofix/tests-3' }), /could not be fetched/);
    const b = makeRepo();
    fs.mkdirSync(path.join(b.work, 'src'));
    fs.writeFileSync(path.join(b.work, 'src', 'cart.ts'), 'x\n');
    const { sha } = await pushBranch({ ...opts, repoDir: b.work, branch: 'autofix/tests-4' });
    assert.equal(git(b.remote, 'rev-parse', 'refs/heads/autofix/tests-4'), sha);
  });

  it('validateFinalizeRequest carries denyPaths and rejects a malformed list', () => {
    const req = { mode: 'finalize', repo: 'shop', base: 'main', branch: 'autofix/x-1', message: 'm' };
    const ok = validateFinalizeRequest({ ...req, denyPaths: DEFAULT_DENY });
    assert.ok(ok.ok && ok.request.denyPaths?.length === DEFAULT_DENY.length);
    assert.equal(validateFinalizeRequest({ ...req, denyPaths: 'x' }).ok, false);
    assert.equal(validateFinalizeRequest({ ...req, denyPaths: [''] }).ok, false);
    const none = validateFinalizeRequest(req);
    assert.ok(none.ok && none.request.denyPaths === undefined);
  });
});

describe('round 2: newline and dotfile paths, tags and intermediate commits', () => {
  const opts = { base: 'main', protectedPatterns: ['main'], defaultBranch: 'main', message: 'fix', env: {}, denyPaths: DEFAULT_DENY };
  const lsRemote = (remote: string, ref: string) => execFileSync('git', ['ls-remote', remote, ref], { encoding: 'utf8' }).trim();

  it('the matcher matches across newlines and dot names for each default glob', () => {
    const res = DEFAULT_DENY.map(compileGlob);
    for (const p of ['.github/workflows/a b\nc.yml', 'a\nb/.env', 'x\ny/key.pem', 'a\nb/package-lock.json', 'infra/x\ny',
      'infra/.tf', 'infra/.main\n.tf', '.github/workflows/.ci.yml', '.github/workflows/.ci\n.yml', 'infra/.a/.b']) {
      assert.ok(deniedBy(p, res, DEFAULT_DENY), JSON.stringify(p));
    }
  });

  for (const f of ['.github/workflows/a b\nc.yml', 'a\nb/.env', 'x\ny/key.pem', 'a\nb/package-lock.json', 'infra/x\ny',
    'infra/.tf', 'infra/.main\n.tf', '.github/workflows/.ci.yml', '.github/workflows/.ci\n.yml', 'infra/.a/.b', 'src/a\nb.ts']) {
    it(`refuses to push ${JSON.stringify(f)}`, async () => {
      const { remote, work } = makeRepo();
      fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      fs.writeFileSync(path.join(work, f), 'evil\n');
      await assert.rejects(pushBranch({ ...opts, repoDir: work, branch: 'autofix/nl-1' }),
        (e: unknown) => e instanceof ProtectedPathError && e.message.includes(JSON.stringify(f)), JSON.stringify(f));
      assert.equal(lsRemote(remote, 'refs/heads/autofix/nl-1'), '');
    });
  }

  function addWorkflowThenRevert(work: string, tag: boolean): void {
    fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(work, '.github', 'workflows', 'evil.yml'), 'on: push\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'evil');
    if (tag) git(work, 'tag', '-a', 'v9', '-m', 't');
    git(work, 'revert', '--no-edit', 'HEAD');
    fs.writeFileSync(path.join(work, 'a.txt'), 'trivial\n');
  }

  it('a protected file added then reverted in an intermediate commit is refused', async () => {
    const { remote, work } = makeRepo();
    addWorkflowThenRevert(work, false);
    await assert.rejects(pushBranch({ ...opts, repoDir: work, branch: 'autofix/rv-1' }), /\.github\/workflows\/evil\.yml.*intermediate commit/);
    assert.equal(lsRemote(remote, 'refs/heads/autofix/rv-1'), '');
  });

  it('push.followTags with a tag on a reverted intermediate commit: refused by the scan, and the tag never rides along', async () => {
    const a = makeRepo();
    addWorkflowThenRevert(a.work, true);
    git(a.work, 'config', 'push.followTags', 'true');
    await assert.rejects(pushBranch({ ...opts, repoDir: a.work, branch: 'autofix/tg-1' }), /intermediate commit/);
    assert.equal(lsRemote(a.remote, 'refs/tags/v9'), '');
    // Without the scan (no denyPaths) the branch is pushed, but the tag still is not.
    const b = makeRepo();
    addWorkflowThenRevert(b.work, true);
    git(b.work, 'config', 'push.followTags', 'true');
    await pushBranch({ ...opts, denyPaths: undefined, repoDir: b.work, branch: 'autofix/tg-2' });
    assert.notEqual(lsRemote(b.remote, 'refs/heads/autofix/tg-2'), '');
    assert.equal(lsRemote(b.remote, 'refs/tags/v9'), '');
  });

  it('pushes only the branch even when a tag or another ref shares its name or remote.origin.push adds a refspec', async () => {
    const { remote, work } = makeRepo();
    git(work, 'checkout', '-q', '-b', 'evilb');
    fs.writeFileSync(path.join(work, 'evil.txt'), 'x\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'evil');
    git(work, 'tag', 'autofix/sh-1');
    git(work, 'checkout', '-q', 'main');
    git(work, 'config', '--add', 'remote.origin.push', 'refs/heads/evilb:refs/heads/evilb');
    fs.writeFileSync(path.join(work, 'b.txt'), 'ok\n');
    await pushBranch({ ...opts, repoDir: work, branch: 'autofix/sh-1' });
    assert.equal(lsRemote(remote, 'refs/heads/evilb'), '');
    assert.equal(lsRemote(remote, 'refs/tags/autofix/sh-1'), '');
    assert.equal(git(remote, 'ls-tree', '-r', '--name-only', 'refs/heads/autofix/sh-1').split('\n').sort().join(','), 'a.txt,b.txt');
  });

  it('refuses when there are too many commits to scan', async () => {
    const { work } = makeRepo();
    for (let i = 0; i < 201; i++) git(work, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
    await assert.rejects(pushBranch({ ...opts, repoDir: work, branch: 'autofix/many-1' }), /too many commits/);
  });
});

describe('round 3: replace objects, merge resolutions, check-then-push, unsupported patterns', () => {
  const opts = { base: 'main', protectedPatterns: ['main'], defaultBranch: 'main', message: 'fix', env: {}, denyPaths: DEFAULT_DENY };
  const lsTree = (remote: string, ref: string) => git(remote, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean).sort();

  it('a commit hidden behind `git replace` is checked as it really is (refused)', async () => {
    const { remote, work } = makeRepo();
    git(work, 'checkout', '-q', '-b', 'autofix/rp-1');
    fs.writeFileSync(path.join(work, 'b.txt'), 'x');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'clean');
    const clean = git(work, 'rev-parse', 'HEAD');
    git(work, 'reset', '-q', '--hard', 'HEAD~1');
    fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(work, '.github', 'workflows', 'evil.yml'), 'on: push\n');
    fs.writeFileSync(path.join(work, 'b.txt'), 'x');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'evil');
    const evil = git(work, 'rev-parse', 'HEAD');
    git(work, 'replace', evil, clean);
    git(work, 'reset', '-q', '--hard');
    await assert.rejects(pushBranch({ ...opts, repoDir: work, branch: 'autofix/rp-1' }), /evil\.yml/);
    assert.equal(execFileSync('git', ['ls-remote', remote, 'refs/heads/autofix/rp-1'], { encoding: 'utf8' }).trim(), '');
  });

  it('a protected file added in one merge resolution and removed in the next is refused', async () => {
    const { remote, work } = makeRepo();
    const side = (n: string) => { git(work, 'checkout', '-q', '-b', n, 'main'); fs.writeFileSync(path.join(work, `${n}.txt`), n); git(work, 'add', '-A'); git(work, 'commit', '-qm', n); };
    side('s1'); side('s2');
    git(work, 'checkout', '-q', '-b', 'autofix/mg-1', 'main');
    git(work, 'merge', '-q', '--no-ff', '--no-commit', 's1');
    fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(work, '.github', 'workflows', 'evil.yml'), 'on: push\n');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'M1');
    git(work, 'merge', '-q', '--no-ff', '--no-commit', 's2');
    git(work, 'rm', '-qr', '.github'); git(work, 'commit', '-qm', 'M2');
    await assert.rejects(pushBranch({ ...opts, repoDir: work, branch: 'autofix/mg-1' }), /evil\.yml.*intermediate commit/);
    assert.equal(execFileSync('git', ['ls-remote', remote, 'refs/heads/autofix/mg-1'], { encoding: 'utf8' }).trim(), '');
  });

  it('pushes exactly the commit that was checked, even when the branch ref moves between check and push', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'ok\n');
    let evil = '';
    _setBeforePushHookForTest(async (repoDir, branch) => {
      // The agent, in the same machine, moves the branch to a commit with a workflow after the check.
      fs.mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, '.github', 'workflows', 'evil.yml'), 'on: push\n');
      git(repoDir, 'add', '-A'); git(repoDir, 'commit', '-qm', 'late');
      evil = git(repoDir, 'rev-parse', 'HEAD');
      git(repoDir, 'update-ref', `refs/heads/${branch}`, evil);
    });
    try {
      const { sha } = await pushBranch({ ...opts, repoDir: work, branch: 'autofix/tt-1' });
      assert.notEqual(sha, evil);
      assert.equal(git(remote, 'rev-parse', 'refs/heads/autofix/tt-1'), sha);
      assert.deepEqual(lsTree(remote, 'refs/heads/autofix/tt-1'), ['a.txt', 'b.txt']);
    } finally { _setBeforePushHookForTest(null); }
  });

  it('refuses to push when a deny pattern is unsupported or too complex (fail closed)', async () => {
    for (const bad of ['**/*.{key,pem}', 'secrets/[ab]/**', '*a*a*a*a*a*a*b']) {
      const { work } = makeRepo();
      fs.writeFileSync(path.join(work, 'b.txt'), 'ok\n');
      await assert.rejects(pushBranch({ ...opts, denyPaths: [...DEFAULT_DENY, bad], repoDir: work, branch: 'autofix/up-1' }), /unsupported protected pattern/, bad);
    }
  });
});

describe('parseChangedPaths / repoChangeOf (portal side)', () => {
  it('keeps a well-formed list and leaves paths out when it is missing or malformed (an older runner: unknown)', () => {
    const ok = [{ path: 'a.ts', added: 1, removed: 2 }];
    assert.deepEqual(parseChangedPaths(ok), ok);
    for (const bad of [undefined, null, 'a.ts', [{ path: '', added: 1, removed: 0 }], [{ path: 'a', added: -1, removed: 0 }], [{ path: 'a', added: 'x', removed: 0 }], [null]]) {
      assert.equal(parseChangedPaths(bad), undefined, JSON.stringify(bad));
    }
    assert.equal(parseChangedPaths(Array.from({ length: 5000 }, () => ({ path: 'a', added: 0, removed: 0 })))?.length, MAX_REPORTED_PATHS);
    assert.deepEqual(repoChangeOf({ repo: 'web', base: 'main', commits: '2', files: 5 }), { repo: 'web', base: 'main', commits: 2, files: 5 });
    assert.deepEqual(repoChangeOf({ repo: 'web', base: 'main', commits: 1, files: 1, paths: ok }), { repo: 'web', base: 'main', commits: 1, files: 1, paths: ok });
  });
});

describe('branchNameFor with an auto-fix stem', () => {
  it('uses the stem and the same clash rule', () => {
    assert.equal(branchNameFor({ title: 'x', stem: 'autofix/tests-abcdef01' }), 'autofix/tests-abcdef01');
    assert.equal(branchNameFor({ title: 'x', stem: 'autofix/tests-abcdef01', taken: ['autofix/tests-abcdef01'] }), 'autofix/tests-abcdef01-2');
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
