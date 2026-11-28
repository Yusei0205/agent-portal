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
  compileGlob, deniedBy, ProtectedPathError, FinalizeError, gitProcessEnv, SAFE_GIT_CONFIG,
} from '../server/agent/runner-finalize.ts';

/** Tests only: the runner reads this global hook (no export in the runner module); it runs after the checks and before the push. */
const BEFORE_PUSH = Symbol.for('agent-portal.test.beforePush');
function _setBeforePushHookForTest(fn: ((repoDir: string, branch: string) => Promise<void>) | null): void {
  if (fn) (globalThis as Record<symbol, unknown>)[BEFORE_PUSH] = fn; else delete (globalThis as Record<symbol, unknown>)[BEFORE_PUSH];
}
import { validateFinalizeRequest } from '../server/agent/runner-finalize-run.ts';

/** The default protected paths of the auto-fix policy (server/autofix/policy.ts REQUIRED_PROTECTED_PATHS). */
const DEFAULT_DENY = ['.github/workflows/**', 'infra/**', '**/.env*', '**/*.pem', 'package-lock.json', '**/package-lock.json'];

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}
/** The base tip the portal reads from the host and sends as `baseSha` (main of the bare remote; '' when it has none). */
function tip(remote: string): string {
  try { return git(remote, 'rev-parse', 'refs/heads/main'); } catch { return ''; }
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
    const { remote, work } = makeRepo();
    assert.deepEqual(await detectChanges(work, 'main', { remoteUrl: remote }), { commits: 0, files: 0, paths: [] });
  });
  it('counts uncommitted changes (modified and untracked)', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    assert.deepEqual(await detectChanges(work, 'main', { remoteUrl: remote }), {
      commits: 0, files: 2, paths: [{ path: 'a.txt', added: 1, removed: 1 }, { path: 'b.txt', added: 1, removed: 0 }],
    });
  });
  it('counts commits ahead and the files they touch', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'b');
    fs.writeFileSync(path.join(work, 'c.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'c');
    assert.deepEqual(await detectChanges(work, 'main', { remoteUrl: remote }), {
      commits: 2, files: 2, paths: [{ path: 'b.txt', added: 1, removed: 0 }, { path: 'c.txt', added: 1, removed: 0 }],
    });
  });
  it('counts both, without counting a file twice', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'new\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'b');
    fs.writeFileSync(path.join(work, 'b.txt'), 'again\n');
    fs.writeFileSync(path.join(work, 'd.txt'), 'x\n');
    assert.deepEqual(await detectChanges(work, 'main', { remoteUrl: remote }), {
      commits: 1, files: 2, paths: [{ path: 'b.txt', added: 1, removed: 0 }, { path: 'd.txt', added: 1, removed: 0 }],
    });
  });
  it('reports a rename as the old path removed and the new one added, a deletion, nested paths and a binary file', async () => {
    const { remote, work } = makeRepo();
    fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(work, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'ci');
    git(work, 'push', 'origin', 'main');
    git(work, 'mv', '.github/workflows/ci.yml', 'ci.yml');
    fs.rmSync(path.join(work, 'a.txt'));
    fs.writeFileSync(path.join(work, 'img.bin'), Buffer.from([0, 1, 2, 3]));
    const got = await detectChanges(work, 'main', { remoteUrl: remote });
    const byPath = Object.fromEntries((got.paths ?? []).map((p) => [p.path, [p.added, p.removed]]));
    assert.deepEqual(byPath, { '.github/workflows/ci.yml': [0, 2], 'a.txt': [0, 1], 'ci.yml': [2, 0], 'img.bin': [0, 0] });
  });
  it('cuts the path list at MAX_REPORTED_PATHS', async () => {
    const { remote, work } = makeRepo();
    for (let i = 0; i < MAX_REPORTED_PATHS + 5; i++) fs.writeFileSync(path.join(work, `f${i}.txt`), 'x\n');
    const got = await detectChanges(work, 'main', { remoteUrl: remote });
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
    const { remote, work } = hideWorkflowCommit();
    git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const got = await detectChanges(work, 'main', { remoteUrl: remote });
    assert.ok(got.paths?.some((p) => p.path === '.github/workflows/ci.yml'), JSON.stringify(got));
  });
  it('origin/main deleted: still reported', async () => {
    const { remote, work } = hideWorkflowCommit();
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
    const got = await detectChanges(work, 'main', { remoteUrl: remote });
    assert.ok(got.paths?.some((p) => p.path === '.github/workflows/ci.yml'), JSON.stringify(got));
  });
  it('a base the remote does not have: paths unknown (never a fallback to HEAD)', async () => {
    const { remote, work } = hideWorkflowCommit();
    const got = await detectChanges(work, 'never-fetched', { remoteUrl: remote });
    assert.equal(got.paths, undefined);
  });
  it('a remote that cannot be reached: paths unknown', async () => {
    const { remote, work } = hideWorkflowCommit();
    assert.equal((await detectChanges(work, 'main', { remoteUrl: path.join(root, 'missing.git') })).paths, undefined);
    assert.ok(remote);
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
      await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/tests-1' }),
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
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/tests-2' }), /"\.github\/workflows\/ci\.yml" is a protected path/);
    assert.equal(execFileSync('git', ['ls-remote', remote, 'refs/heads/autofix/tests-2'], { encoding: 'utf8' }).trim(), '');
  });

  it('refuses when the base cannot be fetched, and pushes an allowed change', async () => {
    const a = makeRepo();
    fs.writeFileSync(path.join(a.work, 'b.txt'), 'x\n');
    await assert.rejects(pushBranch({ ...opts, base: 'gone', repoDir: a.work, remoteUrl: a.remote, baseSha: tip(a.remote), branch: 'autofix/tests-3' }), /could not be fetched/);
    const b = makeRepo();
    fs.mkdirSync(path.join(b.work, 'src'));
    fs.writeFileSync(path.join(b.work, 'src', 'cart.ts'), 'x\n');
    const { sha } = await pushBranch({ ...opts, repoDir: b.work, remoteUrl: b.remote, baseSha: tip(b.remote), branch: 'autofix/tests-4' });
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
      await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/nl-1' }),
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
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/rv-1' }), /\.github\/workflows\/evil\.yml.*intermediate commit/);
    assert.equal(lsRemote(remote, 'refs/heads/autofix/rv-1'), '');
  });

  it('push.followTags with a tag on a reverted intermediate commit: refused by the scan, and the tag never rides along', async () => {
    const a = makeRepo();
    addWorkflowThenRevert(a.work, true);
    git(a.work, 'config', 'push.followTags', 'true');
    await assert.rejects(pushBranch({ ...opts, repoDir: a.work, remoteUrl: a.remote, baseSha: tip(a.remote), branch: 'autofix/tg-1' }), /intermediate commit/);
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
    await pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/sh-1' });
    assert.equal(lsRemote(remote, 'refs/heads/evilb'), '');
    assert.equal(lsRemote(remote, 'refs/tags/autofix/sh-1'), '');
    assert.equal(git(remote, 'ls-tree', '-r', '--name-only', 'refs/heads/autofix/sh-1').split('\n').sort().join(','), 'a.txt,b.txt');
  });

  it('refuses when there are too many commits to scan', async () => {
    const { remote, work } = makeRepo();
    for (let i = 0; i < 201; i++) git(work, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/many-1' }), /too many commits/);
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
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/rp-1' }), /evil\.yml/);
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
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/mg-1' }), /evil\.yml.*intermediate commit/);
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
      const { sha } = await pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/tt-1' });
      assert.notEqual(sha, evil);
      assert.equal(git(remote, 'rev-parse', 'refs/heads/autofix/tt-1'), sha);
      assert.deepEqual(lsTree(remote, 'refs/heads/autofix/tt-1'), ['a.txt', 'b.txt']);
    } finally { _setBeforePushHookForTest(null); }
  });

  it('refuses to push when a deny pattern is unsupported or too complex (fail closed)', async () => {
    for (const bad of ['**/*.{key,pem}', 'secrets/[ab]/**', '*a*a*a*a*a*a*b']) {
      const { remote, work } = makeRepo();
      fs.writeFileSync(path.join(work, 'b.txt'), 'ok\n');
      await assert.rejects(pushBranch({ ...opts, denyPaths: [...DEFAULT_DENY, bad], repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/up-1' }), /unsupported protected pattern/, bad);
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

describe('round 4: the check and the push run in a runner-private repository', () => {
  const opts = { base: 'main', protectedPatterns: ['main'], defaultBranch: 'main', message: 'fix', env: {}, denyPaths: DEFAULT_DENY };
  const lsRemote = (remote: string, ref: string) => execFileSync('git', ['ls-remote', remote, ref], { encoding: 'utf8' }).trim();
  const lsTree = (remote: string, ref: string) => git(remote, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean).sort();
  const workflow = (work: string, name = 'evil.yml') => {
    fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(work, '.github', 'workflows', name), `on: push\n# ${name}\n`);
  };
  const commitEvil = (work: string) => {
    git(work, 'checkout', '-q', '-b', 'autofix/x-1');
    workflow(work);
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'evil');
  };
  /** A hook script that leaves a marker file when it runs and, for reference-transaction, moves the private base ref onto the branch. */
  function refTxHook(work: string, dir: string, marker: string): void {
    fs.mkdirSync(path.join(work, dir), { recursive: true });
    fs.writeFileSync(path.join(work, dir, 'reference-transaction'), `#!/bin/sh
echo ran >> ${JSON.stringify(marker)}
[ "$1" = committed ] || exit 0
[ -n "$IN_HOOK" ] && exit 0
if grep -q refs/portal/base; then IN_HOOK=1 git update-ref refs/portal/base refs/heads/autofix/x-1; fi
exit 0
`, { mode: 0o755 });
  }

  it('D1: a .git/hooks/reference-transaction hook never runs and cannot hide a workflow (refused, remote untouched)', async () => {
    const { remote, work } = makeRepo();
    const marker = path.join(work, '..', 'd1.marker');
    commitEvil(work);
    refTxHook(work, '.git/hooks', marker);
    fs.rmSync(marker, { force: true });
    await detectChanges(work, 'main', { remoteUrl: remote });
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/x-1' }), /evil\.yml/);
    assert.equal(lsRemote(remote, 'refs/heads/autofix/x-1'), '');
    assert.equal(fs.existsSync(marker), false, 'the hook ran inside a runner git call');
  });

  it('D2: core.hooksPath pointing at an agent hook is ignored (refused, hook never runs)', async () => {
    const { remote, work } = makeRepo();
    const marker = path.join(work, '..', 'd2.marker');
    commitEvil(work);
    refTxHook(work, 'myhooks', marker);
    git(work, 'config', 'core.hooksPath', 'myhooks');
    fs.rmSync(marker, { force: true });
    await detectChanges(work, 'main', { remoteUrl: remote });
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/x-1' }), /evil\.yml/);
    assert.equal(lsRemote(remote, 'refs/heads/autofix/x-1'), '');
    assert.equal(fs.existsSync(marker), false);
  });

  it('E1: url.<fake>.insteadOf + pushInsteadOf in .git/config cannot redirect the base fetch (refused)', async () => {
    const { remote, work } = makeRepo();
    commitEvil(work);
    const fake = path.join(work, '..', 'fake.git');
    execFileSync('git', ['init', '-q', '--bare', fake]);
    git(work, 'push', '-q', fake, 'HEAD:refs/heads/main');
    git(work, 'config', `url.${fake}.insteadOf`, remote);
    git(work, 'config', `url.${remote}.pushInsteadOf`, remote);
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/x-1' }), /evil\.yml/);
    assert.equal(lsRemote(remote, 'refs/heads/autofix/x-1'), '');
  });

  it('E2: remote.origin.url = fake, pushurl = real is not read: the base comes from the request URL (refused)', async () => {
    const { remote, work } = makeRepo();
    commitEvil(work);
    const fake = path.join(work, '..', 'fake2.git');
    execFileSync('git', ['init', '-q', '--bare', fake]);
    git(work, 'push', '-q', fake, 'HEAD:refs/heads/main');
    git(work, 'config', 'remote.origin.url', fake);
    git(work, 'config', 'remote.origin.pushurl', remote);
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/x-1' }), /evil\.yml/);
    assert.equal(lsRemote(remote, 'refs/heads/autofix/x-1'), '');
  });

  it('F1: core.fsmonitor and a clean filter in the agent repo never run in the runner (change report and push)', async () => {
    const { remote, work } = makeRepo();
    const marker = path.join(work, '..', 'f1.marker');
    const script = path.join(work, '..', 'f1.sh');
    fs.writeFileSync(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat\n`, { mode: 0o755 });
    git(work, 'config', 'core.fsmonitor', script);
    git(work, 'config', 'filter.evil.clean', script);
    git(work, 'config', 'filter.evil.smudge', script);
    git(work, 'config', 'filter.evil.process', script);
    fs.writeFileSync(path.join(work, 'b.txt'), 'ok\n');
    fs.rmSync(marker, { force: true });
    await detectChanges(work, 'main', { remoteUrl: remote });
    assert.equal(fs.existsSync(marker), false, 'fsmonitor ran in the change report');
    // The filter attribute is committed only now, so the change report above did not see it; the push must not run it either.
    fs.writeFileSync(path.join(work, '.gitattributes'), '* filter=evil\n');
    const { sha } = await pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/f1-1' });
    assert.equal(git(remote, 'rev-parse', 'refs/heads/autofix/f1-1'), sha);
    assert.equal(fs.existsSync(marker), false, 'fsmonitor or a filter ran in the push');
  });

  it('6c: a workflow the base deleted since the fork, carried by a branch from an old base commit, is refused with "rebase"', async () => {
    const { remote, work } = makeRepo();
    workflow(work, 'old-deploy.yml');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'old wf');
    const old = git(work, 'rev-parse', 'HEAD');
    git(work, 'rm', '-rq', '.github'); git(work, 'commit', '-qm', 'remove wf'); git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'autofix/x-1', old);
    fs.writeFileSync(path.join(work, 'fix.txt'), 'fix\n');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'fix');
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/x-1' }),
      (e: unknown) => e instanceof ProtectedPathError && /old-deploy\.yml/.test(e.message) && /rebase/i.test(e.message));
    assert.equal(lsRemote(remote, 'refs/heads/autofix/x-1'), '');
  });

  it('a fix on top of the current base (which changed a workflow) still pushes', async () => {
    const { remote, work } = makeRepo();
    workflow(work, 'ci.yml');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'base ci'); git(work, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(work, 'fix.txt'), 'fix\n');
    const { sha } = await pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/ok-1' });
    assert.equal(git(remote, 'rev-parse', 'refs/heads/autofix/ok-1'), sha);
  });

  it('the push goes to the request URL, never to the remote in .git/config, and leaves the agent repo as it was', async () => {
    const { remote, work } = makeRepo();
    const decoy = path.join(work, '..', 'decoy.git');
    execFileSync('git', ['init', '-q', '--bare', decoy]);
    git(work, 'remote', 'set-url', 'origin', decoy);
    fs.mkdirSync(path.join(work, 'src'));
    fs.writeFileSync(path.join(work, 'src', 'cart.ts'), 'x\n');
    fs.mkdirSync(path.join(work, 'graphify-out'));
    fs.writeFileSync(path.join(work, 'graphify-out', 'g.json'), '{}');
    fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), 'graphify-out/\n');
    const head = git(work, 'rev-parse', 'HEAD');
    const { sha } = await pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/url-1' });
    assert.equal(git(remote, 'rev-parse', 'refs/heads/autofix/url-1'), sha);
    assert.deepEqual(lsTree(remote, 'refs/heads/autofix/url-1'), ['a.txt', 'src/cart.ts'], 'committed the change; the excluded folder stayed out');
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'refs/heads/autofix/url-1'), 'fix');
    assert.equal(lsRemote(decoy, 'refs/heads/autofix/url-1'), '');
    assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'the agent repo is not committed to');
  });

  it('reuses the agent commit when nothing is left uncommitted', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'x\n');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'agent commit');
    const head = git(work, 'rev-parse', 'HEAD');
    const { sha } = await pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/re-1' });
    assert.equal(sha, head);
  });

  it('a request with denyPaths but no remote URL is refused (fail closed)', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, 'b.txt'), 'x\n');
    await assert.rejects(pushBranch({ ...opts, repoDir: work, branch: 'autofix/nourl-1' }), (e: unknown) => e instanceof ProtectedPathError && /remote URL/.test(e.message));
    assert.equal(lsRemote(remote, 'refs/heads/autofix/nourl-1'), '');
  });

  it('a shallow agent repository whose history cannot be checked is refused', async () => {
    const { remote, work } = makeRepo();
    for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(work, `s${i}.txt`), 'x'); git(work, 'add', '-A'); git(work, 'commit', '-qm', `s${i}`); }
    fs.writeFileSync(path.join(work, '.git', 'shallow'), git(work, 'rev-parse', 'HEAD~1') + '\n');
    await assert.rejects(pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/sh-9' }), ProtectedPathError);
    assert.equal(lsRemote(remote, 'refs/heads/autofix/sh-9'), '');
  });

  it('the git environment is an allowlist: GIT_TRACE and GIT_SSH_COMMAND in the runner env never reach git', async () => {
    const env = gitProcessEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: x', GIT_DIR: '/x', GIT_TOKEN: 't' });
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.extraheader');
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    for (const k of ['GIT_DIR', 'GIT_TOKEN']) assert.equal(env[k], undefined, k);
    for (const c of ['core.hooksPath=/dev/null', 'core.fsmonitor=false']) assert.ok(SAFE_GIT_CONFIG.includes(c), c);
    const { remote, work } = makeRepo();
    const trace = path.join(work, '..', 'trace.log');
    const baseSha = tip(remote); // read before the variables are set (the test's own git calls would honour them)
    const saved = { t: process.env.GIT_TRACE, s: process.env.GIT_SSH_COMMAND, e: process.env.GIT_EXTERNAL_DIFF };
    process.env.GIT_TRACE = trace;
    process.env.GIT_SSH_COMMAND = `touch ${trace}`;
    process.env.GIT_EXTERNAL_DIFF = `touch ${trace}`;
    try {
      assert.equal(gitProcessEnv({}).GIT_SSH_COMMAND, undefined);
      fs.writeFileSync(path.join(work, 'b.txt'), 'x\n');
      await detectChanges(work, 'main', { remoteUrl: remote });
      await pushBranch({ ...opts, repoDir: work, remoteUrl: remote, baseSha, branch: 'autofix/env-1' });
    } finally {
      for (const [k, v] of [['GIT_TRACE', saved.t], ['GIT_SSH_COMMAND', saved.s], ['GIT_EXTERNAL_DIFF', saved.e]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    assert.equal(fs.existsSync(trace), false, 'a variable from the runner env reached git');
    assert.notEqual(lsRemote(remote, 'refs/heads/autofix/env-1'), '');
  });

  it('an ordinary (not auto-fix) push runs git as before the hardening: it reads the global git config', async () => {
    // Runner images may route or authenticate git through the global config; the end-to-end engine test redirects its fake host this way.
    const { remote, work } = makeRepo();
    const fakeUrl = 'https://git.example.test/ordinary.git';
    execFileSync('git', ['remote', 'set-url', 'origin', fakeUrl], { cwd: work });
    const globalCfg = path.join(work, '..', 'global.gitconfig');
    fs.writeFileSync(globalCfg, `[url "${remote.replace(/\\/g, '/')}"]\n\tinsteadOf = ${fakeUrl}\n`);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    try {
      fs.writeFileSync(path.join(work, 'c.txt'), 'x\n');
      await pushBranch({ ...opts, denyPaths: undefined, remoteUrl: undefined, baseSha: undefined, repoDir: work, branch: 'portal/global-cfg' });
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
    }
    assert.notEqual(lsRemote(remote, 'refs/heads/portal/global-cfg'), '');
  });

  it('validateFinalizeRequest carries an https remoteUrl and rejects anything else', () => {
    const req = { mode: 'finalize', repo: 'shop', base: 'main', branch: 'autofix/x-1', message: 'm' };
    const ok = validateFinalizeRequest({ ...req, remoteUrl: 'https://github.com/acme/shop' });
    assert.ok(ok.ok && ok.request.remoteUrl === 'https://github.com/acme/shop');
    for (const bad of ['http://github.com/a/b', 'git@github.com:a/b', 'ext::sh -c x', 'https://x/a b', 'https://x/a\nb', '', 5, 'https://' + 'a'.repeat(2100)]) {
      assert.equal(validateFinalizeRequest({ ...req, remoteUrl: bad }).ok, false, JSON.stringify(bad));
    }
  });
});

describe('round 4: isProtectedBranch uses the linear matcher', () => {
  it('a pathological pattern on a 48-character name is fast, and the defaults behave as before', () => {
    const name = 'autofix/' + 'a'.repeat(40);
    const t = performance.now();
    for (const k of [6, 8, 10, 12]) assert.equal(isProtectedBranch(name, ['*a'.repeat(k) + '*b']), false);
    assert.ok(performance.now() - t < 200, `took ${performance.now() - t} ms`);
    const defaults = ['main', 'master', 'develop', 'release/*'];
    assert.equal(isProtectedBranch('release/1.2/hotfix', defaults), true);
    assert.equal(isProtectedBranch('Release/1.2', defaults), false, 'case-sensitive as before');
    assert.equal(isProtectedBranch('release?x', ['release?x']), true);
    assert.equal(isProtectedBranch('releaseYx', ['release?x']), false, '? is literal in branch patterns, as before');
    assert.equal(isProtectedBranch('a/b/c', ['a*c']), true, '* crosses / in branch patterns, as before');
  });
});

describe('round 5: no credentials or agent configuration in the runner git calls; pinned base; symlinked protected directories', () => {
  const opts = { base: 'main', protectedPatterns: ['main'], defaultBranch: 'main', message: 'fix', denyPaths: DEFAULT_DENY };
  const lsRemote = (remote: string, ref: string) => execFileSync('git', ['ls-remote', remote, ref], { encoding: 'utf8' }).trim();
  const AUTH = {
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_1: 'Authorization: Basic U0VDUkVULVRPS0VO',
  };
  /** The reviewer's leak.mts: a clean filter from .git/config + .git/info/attributes that writes its environment to a file. */
  function plantLeakFilter(work: string): string {
    const leak = path.join(work, '..', `leak-${++seq}.env`);
    git(work, 'config', 'filter.evil.clean', `sh -c 'env > ${leak}; cat'`);
    git(work, 'config', 'filter.evil.smudge', `sh -c 'env > ${leak}; cat'`);
    git(work, 'config', 'diff.evil.textconv', `sh -c 'env > ${leak}; cat'`);
    fs.writeFileSync(path.join(work, '.git', 'info', 'attributes'), '* filter=evil diff=evil\n');
    return leak;
  }
  const PRIVATE = Symbol.for('agent-portal.test.privateRepo');
  function setPrivateRepoHook(fn: ((gitDir: string, stage: string) => void) | null): void {
    if (fn) (globalThis as Record<symbol, unknown>)[PRIVATE] = fn; else delete (globalThis as Record<symbol, unknown>)[PRIVATE];
  }

  it('N1: the change report runs no agent filter and hands no credential to anything; it still sees the change', async () => {
    const { remote, work } = makeRepo();
    const leak = plantLeakFilter(work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'b\n');
    fs.writeFileSync(path.join(work, 'new.txt'), 'n\n');
    const got = await detectChanges(work, 'main', { remoteUrl: remote, env: AUTH });
    assert.equal(fs.existsSync(leak), false, 'a filter ran in the change report');
    assert.deepEqual(got, { commits: 0, files: 2, paths: [{ path: 'a.txt', added: 1, removed: 1 }, { path: 'new.txt', added: 1, removed: 0 }] });
  });

  it('N1: reportRepoChanges (checked: an auto-fix run) runs no agent filter either', async () => {
    const workDir = path.join(root, `rr${++seq}`);
    const remote = path.join(workDir, 'remote.git');
    const w = path.join(workDir, 'repos', 'app');
    fs.mkdirSync(path.dirname(w), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '-q', remote, w]);
    fs.writeFileSync(path.join(w, 'a.txt'), 'a\n'); git(w, 'add', '-A'); git(w, 'commit', '-qm', 'i'); git(w, 'push', '-q', 'origin', 'main');
    const leak = plantLeakFilter(w);
    fs.writeFileSync(path.join(w, 'a.txt'), 'b\n');
    const URL_HOOK = Symbol.for('agent-portal.test.remoteUrl');
    (globalThis as Record<symbol, unknown>)[URL_HOOK] = () => remote;
    const events: Record<string, unknown>[] = [];
    try {
      const { reportRepoChanges } = await import('../server/agent/runner-finalize-run.ts');
      await reportRepoChanges([{ name: 'app', url: 'https://github.com/o/r', branch: 'main', env: AUTH }], workDir, (e) => events.push(e), { checked: true });
    } finally { delete (globalThis as Record<symbol, unknown>)[URL_HOOK]; }
    assert.equal(fs.existsSync(leak), false, 'a filter ran in reportRepoChanges');
    assert.equal(events.length, 1, JSON.stringify(events));
    assert.deepEqual(events[0].paths, [{ path: 'a.txt', added: 1, removed: 1 }]);
  });

  it('the change report never uses the remote in .git/config: without a URL from the run the paths are unknown', async () => {
    const { work } = makeRepo();
    fs.writeFileSync(path.join(work, 'a.txt'), 'b\n');
    const got = await detectChanges(work, 'main');
    assert.equal(got.paths, undefined);
    assert.equal(got.files, 1);
  });

  it('N1: the auto-fix push runs no agent filter and no credential reaches one', async () => {
    const { remote, work } = makeRepo();
    const leak = plantLeakFilter(work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'b\n');
    const { sha } = await pushBranch({ ...opts, env: AUTH, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/lk-1' });
    assert.equal(git(remote, 'rev-parse', 'refs/heads/autofix/lk-1'), sha);
    assert.equal(fs.existsSync(leak), false, 'a filter ran in the push');
  });

  it('N3: a base tip other than the one the portal read is refused (a planted insteadOf or a fake base cannot pass)', async () => {
    const { remote, work } = makeRepo();
    git(work, 'checkout', '-q', '-b', 'autofix/x-1');
    fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(work, '.github', 'workflows', 'evil.yml'), 'on: push\n');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'evil');
    const fake = path.join(work, '..', 'fake.git');
    execFileSync('git', ['init', '-q', '--bare', fake]);
    git(work, 'push', '-q', fake, 'HEAD:refs/heads/main');
    const real = tip(remote);
    // The race the reviewer won: a watcher appends url.<fake>.insteadOf=<real> to the private repository's config.
    setPrivateRepoHook((gitDir, stage) => {
      if (stage === 'created') fs.appendFileSync(path.join(gitDir, 'config'), `[url "${fake}"]\n\tinsteadOf = ${remote}\n`);
    });
    try {
      await assert.rejects(pushBranch({ ...opts, env: {}, repoDir: work, remoteUrl: remote, baseSha: real, branch: 'autofix/x-1' }), ProtectedPathError);
    } finally { setPrivateRepoHook(null); }
    assert.equal(lsRemote(remote, 'refs/heads/autofix/x-1'), '');
    // Without any tampering, a baseSha that is not the fetched tip is refused too, and a missing one is refused.
    fs.writeFileSync(path.join(work, 'b.txt'), 'x\n');
    git(work, 'checkout', '-q', 'main');
    await assert.rejects(pushBranch({ ...opts, env: {}, repoDir: work, remoteUrl: remote, baseSha: 'f'.repeat(40), branch: 'autofix/bs-1' }), /base branch .*moved|not the commit/i);
    await assert.rejects(pushBranch({ ...opts, env: {}, repoDir: work, remoteUrl: remote, branch: 'autofix/bs-2' }), /base commit/i);
    assert.equal(lsRemote(remote, 'refs/heads/autofix/bs-1'), '');
  });

  it('N3: a private repository whose configuration changed under the runner is refused', async () => {
    for (const stage of ['created', 'fetched']) {
      const { remote, work } = makeRepo();
      fs.writeFileSync(path.join(work, 'b.txt'), 'x\n');
      setPrivateRepoHook((gitDir, at) => { if (at === stage) fs.appendFileSync(path.join(gitDir, 'config'), '[core]\n\tfoo = bar\n'); });
      try {
        await assert.rejects(pushBranch({ ...opts, env: {}, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/cf-1' }),
          (e: unknown) => e instanceof ProtectedPathError && /private repository was changed/.test(e.message), stage);
      } finally { setPrivateRepoHook(null); }
      assert.equal(lsRemote(remote, 'refs/heads/autofix/cf-1'), '');
    }
  });

  for (const [label, prep] of [
    ['S1 infra as a symlink to tf/', (w: string) => { fs.mkdirSync(path.join(w, 'tf')); fs.writeFileSync(path.join(w, 'tf/main.tf'), 'x\n'); fs.symlinkSync('tf', path.join(w, 'infra')); }],
    ['S2 .github/workflows as a symlink to ../ci', (w: string) => { fs.mkdirSync(path.join(w, 'ci')); fs.writeFileSync(path.join(w, 'ci/evil.yml'), 'on: push\n'); fs.mkdirSync(path.join(w, '.github')); fs.symlinkSync('../ci', path.join(w, '.github/workflows')); }],
    ['S2b .github as a symlink to gh/', (w: string) => { fs.mkdirSync(path.join(w, 'gh/workflows'), { recursive: true }); fs.writeFileSync(path.join(w, 'gh/workflows/evil.yml'), 'on: push\n'); fs.symlinkSync('gh', path.join(w, '.github')); }],
    ['S3 .env as a symlink to a file', (w: string) => { fs.writeFileSync(path.join(w, 'vals'), 'X=1\n'); fs.symlinkSync('vals', path.join(w, '.env')); }],
  ] as Array<[string, (w: string) => void]>) {
    it(`N5: ${label} is refused`, async () => {
      const { remote, work } = makeRepo();
      prep(work);
      await assert.rejects(pushBranch({ ...opts, env: {}, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/sl-1' }), ProtectedPathError, label);
      assert.equal(lsRemote(remote, 'refs/heads/autofix/sl-1'), '');
    });
  }

  it('a failure while preparing the push carries the generic failed code, whatever git printed', async () => {
    const { remote, work } = makeRepo();
    fs.writeFileSync(path.join(work, '.git', 'HEAD'), 'ref: refs/heads/no-such-branch\n');
    await assert.rejects(pushBranch({ ...opts, env: {}, repoDir: work, remoteUrl: remote, baseSha: tip(remote), branch: 'autofix/gf-1' }),
      (e: unknown) => e instanceof FinalizeError && e.code === 'failed');
  });

  it('proxy and CA settings of the runner image reach git; credentials-looking variables of the process do not', () => {
    const saved = { p: process.env.HTTPS_PROXY, c: process.env.SSL_CERT_FILE, n: process.env.NO_PROXY };
    process.env.HTTPS_PROXY = 'http://proxy:3128'; process.env.SSL_CERT_FILE = '/etc/ca.pem'; process.env.NO_PROXY = 'localhost';
    try {
      const env = gitProcessEnv({});
      assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
      assert.equal(env.SSL_CERT_FILE, '/etc/ca.pem');
      assert.equal(env.NO_PROXY, 'localhost');
    } finally {
      for (const [k, v] of [['HTTPS_PROXY', saved.p], ['SSL_CERT_FILE', saved.c], ['NO_PROXY', saved.n]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('validateFinalizeRequest carries a baseSha and rejects a malformed one', () => {
    const req = { mode: 'finalize', repo: 'shop', base: 'main', branch: 'autofix/x-1', message: 'm' };
    const ok = validateFinalizeRequest({ ...req, baseSha: 'a'.repeat(40) });
    assert.ok(ok.ok && ok.request.baseSha === 'a'.repeat(40));
    for (const bad of ['x', 'A'.repeat(40), 'a'.repeat(39), 5, '']) assert.equal(validateFinalizeRequest({ ...req, baseSha: bad }).ok, false, String(bad));
  });
});

describe('the ordinary change report (no checkedReport): as before the auto-fix work', () => {
  const AUTH = {
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_1: 'Authorization: Basic U0VDUkVULVRPS0VO',
  };
  const REPORT_GIT = Symbol.for('agent-portal.test.reportGit');
  const URL_HOOK = Symbol.for('agent-portal.test.remoteUrl');

  /** A work folder with repos/app cloned from a bare remote with one commit on main (`depth`: a shallow clone). */
  function setup(opts: { depth?: number } = {}): { workDir: string; remote: string; w: string } {
    const workDir = path.join(root, `ord${++seq}`);
    const remote = path.join(workDir, 'remote.git');
    const seed = path.join(workDir, 'seed');
    const w = path.join(workDir, 'repos', 'app');
    fs.mkdirSync(path.dirname(w), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '-q', remote, seed]);
    git(seed, 'checkout', '-q', '-b', 'main');
    for (const n of [1, 2, 3]) { fs.writeFileSync(path.join(seed, 'a.txt'), `${n}\n`); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', `c${n}`); }
    git(seed, 'push', '-q', 'origin', 'main');
    execFileSync('git', ['clone', '-q', ...(opts.depth ? ['--depth', String(opts.depth), `file://${remote}`] : [remote]), w]);
    return { workDir, remote, w };
  }
  async function report(workDir: string, repo: Record<string, unknown>): Promise<{ events: Record<string, unknown>[]; calls: Array<{ args: string[]; env: Record<string, string | undefined> }>; urlAsked: number }> {
    const events: Record<string, unknown>[] = [];
    const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
    let urlAsked = 0;
    (globalThis as Record<symbol, unknown>)[REPORT_GIT] = (args: string[], env: Record<string, string | undefined>) => calls.push({ args, env });
    (globalThis as Record<symbol, unknown>)[URL_HOOK] = (u: string) => { urlAsked++; return u; };
    try {
      const { reportRepoChanges } = await import('../server/agent/runner-finalize-run.ts');
      await reportRepoChanges([{ name: 'app', url: 'https://github.com/o/r', env: AUTH, ...repo }], workDir, (e) => events.push(e));
    } finally {
      delete (globalThis as Record<symbol, unknown>)[REPORT_GIT];
      delete (globalThis as Record<symbol, unknown>)[URL_HOOK];
    }
    return { events, calls, urlAsked };
  }
  const authFree = (env: Record<string, string | undefined>) => !Object.values(env).some((v) => typeof v === 'string' && v.includes('Authorization'));

  it('reports the old event (no paths), makes no fetch and hands no credential to git', async () => {
    const { workDir, w } = setup();
    fs.writeFileSync(path.join(w, 'a.txt'), 'changed\n');
    fs.writeFileSync(path.join(w, 'new.txt'), 'n\n');
    git(w, 'add', 'new.txt'); git(w, 'commit', '-qm', 'local');
    fs.writeFileSync(path.join(w, 'untracked.txt'), 'u\n');
    const { events, calls, urlAsked } = await report(workDir, { branch: 'main' });
    assert.deepEqual(events, [{ type: 'repo-changes', repo: 'app', base: 'main', commits: 1, files: 3 }]);
    assert.equal(urlAsked, 0, 'the run URL is never used (no fetch)');
    assert.deepEqual(calls.map((c) => c.args[0]), ['status', 'rev-list', 'diff']);
    assert.ok(calls.every((c) => !c.args.includes('fetch')));
    assert.ok(calls.every((c) => authFree(c.env)), 'no auth header in any git environment');
    assert.ok(calls.every((c) => Object.entries(c.env).some(([k, v]) => /^GIT_CONFIG_KEY_/.test(k) && v === 'safe.directory')));
  });

  it('works in a shallow clone (the old output, not "unchanged")', async () => {
    const { workDir, w } = setup({ depth: 1 });
    fs.writeFileSync(path.join(w, 'b.txt'), 'b\n');
    git(w, 'add', 'b.txt'); git(w, 'commit', '-qm', 'local');
    const { events } = await report(workDir, { branch: 'main' });
    assert.deepEqual(events, [{ type: 'repo-changes', repo: 'app', base: 'main', commits: 1, files: 1 }]);
  });

  it('a clean repository reports nothing', async () => {
    const { workDir } = setup();
    assert.deepEqual((await report(workDir, { branch: 'main' })).events, []);
  });

  it('without a branch, symbolic-ref reads the base with only safe.directory in its environment (no auth header)', async () => {
    const { workDir, w } = setup();
    fs.writeFileSync(path.join(w, 'a.txt'), 'x\n');
    const { events, calls } = await report(workDir, {});
    const sym = calls.find((c) => c.args[0] === 'symbolic-ref');
    assert.ok(sym, JSON.stringify(calls.map((c) => c.args)));
    assert.ok(authFree(sym.env));
    assert.ok(!Object.values(sym.env).some((v) => /GIT_CONFIG_VALUE/.test(String(v))));
    assert.deepEqual(Object.keys(sym.env).filter((k) => /^GIT_CONFIG_VALUE_/.test(k)), ['GIT_CONFIG_VALUE_0']);
    assert.deepEqual(events, [{ type: 'repo-changes', repo: 'app', base: 'main', commits: 0, files: 1 }]);
  });

  it('the checked report never calls symbolic-ref: without a branch it reports nothing', async () => {
    const { workDir, w } = setup();
    fs.writeFileSync(path.join(w, 'a.txt'), 'x\n');
    const events: Record<string, unknown>[] = [];
    const calls: string[][] = [];
    (globalThis as Record<symbol, unknown>)[REPORT_GIT] = (args: string[]) => calls.push(args);
    try {
      const { reportRepoChanges } = await import('../server/agent/runner-finalize-run.ts');
      await reportRepoChanges([{ name: 'app', url: 'https://github.com/o/r', env: AUTH }], workDir, (e) => events.push(e), { checked: true });
    } finally { delete (globalThis as Record<symbol, unknown>)[REPORT_GIT]; }
    assert.deepEqual(calls, []);
    assert.deepEqual(events, []);
  });
});
