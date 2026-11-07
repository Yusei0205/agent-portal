/**
 * Pull requests from Kiro runs, runner side: the `finalizeCheck` flag of a kiro-run payload, and the shared
 * reportRepoChanges / runFinalize (server/agent/runner-finalize-run.ts) on the folder layout the Kiro runner uses
 * (repos/ in a warm work folder, or in the persistent folder). Real temporary git repositories and a local bare remote.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validatePayload } from '../kiro-runner/src/validate.ts';
import { reportRepoChanges, runFinalize, validateFinalizeRequest } from '../server/agent/runner-finalize-run.ts';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

const run = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'kiro-run', runId: 'run-1', prompt: 'hello',
  token: { accessToken: 'a', expiresAt: '2030-01-01T00:00:00Z', region: 'us-east-1', startUrl: 'https://d-1.awsapps.com/start' },
  ...extra,
});

describe('kiro-run payload: finalizeCheck', () => {
  it('keeps true, drops false and absent, rejects anything else', () => {
    const get = (extra: Record<string, unknown>) => {
      const v = validatePayload(run(extra));
      assert.ok(v.ok, JSON.stringify(v));
      return (v.payload as { finalizeCheck?: boolean }).finalizeCheck;
    };
    assert.equal(get({ finalizeCheck: true }), true);
    assert.equal(get({ finalizeCheck: false }), undefined);
    assert.equal(get({}), undefined);
    for (const bad of ['yes', 1, null]) {
      const v = validatePayload(run({ finalizeCheck: bad }));
      assert.ok(!v.ok && /finalizeCheck/.test(v.error), JSON.stringify(v));
    }
  });
});

describe('Kiro runner: changes and finalize on its folder layout', () => {
  let root: string;
  let remote: string;
  let workDir: string;
  let persist: string;
  const events: Record<string, unknown>[] = [];
  const emit = (e: Record<string, unknown>): void => { events.push(e); };

  function cloneInto(parent: string, name: string): string {
    const dir = path.join(parent, 'repos', name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['clone', remote, dir], { stdio: 'ignore' });
    return dir;
  }

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-finalize-'));
    remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
    const seed = path.join(root, 'seed');
    execFileSync('git', ['clone', remote, seed], { stdio: 'ignore' });
    git(seed, 'checkout', '-b', 'main');
    fs.writeFileSync(path.join(seed, 'README.md'), 'hello\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'init');
    git(seed, 'push', 'origin', 'main');
    workDir = path.join(root, 'kiro-work');
    persist = path.join(root, 'persist');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(persist, { recursive: true });
  });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const spec = (name: string) => [{ name, url: 'https://example.invalid/r.git', branch: 'main' }];

  it('reportRepoChanges emits one repo-changes for an edited repository and nothing for a clean one', async () => {
    const edited = cloneInto(workDir, 'edited');
    cloneInto(workDir, 'clean');
    fs.appendFileSync(path.join(edited, 'README.md'), 'changed\n');
    events.length = 0;
    await reportRepoChanges([...spec('edited'), ...spec('clean')], workDir, emit);
    assert.deepEqual(events, [{ type: 'repo-changes', repo: 'edited', base: 'main', commits: 0, files: 1 }]);
  });

  it('runFinalize pushes a new branch from the warm work folder; main does not move', async () => {
    const mainBefore = git(root, '--git-dir', remote, 'rev-parse', 'main');
    events.length = 0;
    await runFinalize({
      repo: 'edited', base: 'main', branch: 'portal/RLP-12-fix-login', message: 'RLP-12: Fix login redirect',
      protectedBranches: ['main', 'release/*'], defaultBranch: 'main',
      identity: { name: 'Agent Portal', email: 'agent-portal@users.noreply.invalid' },
    }, { workDir, persist }, emit);
    const pushed = events.filter((e) => e.type === 'repo-pushed');
    assert.equal(pushed.length, 1, JSON.stringify(events));
    assert.equal(pushed[0].error, undefined, String(pushed[0].error));
    assert.match(String(pushed[0].sha), /^[0-9a-f]{40}$/);
    assert.equal(git(root, '--git-dir', remote, 'rev-parse', 'portal/RLP-12-fix-login'), pushed[0].sha);
    assert.equal(git(root, '--git-dir', remote, 'rev-parse', 'main'), mainBefore);
  });

  it('runFinalize finds the repository in the persistent folder when there is no warm work folder', async () => {
    const dir = cloneInto(persist, 'stashed');
    fs.appendFileSync(path.join(dir, 'README.md'), 'more\n');
    events.length = 0;
    await runFinalize({
      repo: 'stashed', base: 'main', branch: 'portal/stashed-change', message: 'Stashed change', protectedBranches: ['main'], defaultBranch: 'main',
    }, { workDir: null, persist }, emit);
    const pushed = events.filter((e) => e.type === 'repo-pushed');
    assert.equal(pushed.length, 1, JSON.stringify(events));
    assert.match(String(pushed[0].sha), /^[0-9a-f]{40}$/, JSON.stringify(pushed[0]));
  });

  it('runFinalize refuses a protected branch and reports a missing workspace', async () => {
    events.length = 0;
    await runFinalize({ repo: 'clean', base: 'main', branch: 'main', message: 'x', protectedBranches: ['main'], defaultBranch: 'main' }, { workDir, persist }, emit);
    assert.ok(events.some((e) => e.type === 'repo-pushed' && e.error), JSON.stringify(events));
    events.length = 0;
    await runFinalize({ repo: 'gone', base: 'main', branch: 'portal/x', message: 'x', protectedBranches: [] }, { workDir: null, persist: null }, emit);
    const gone = events.find((e) => e.type === 'repo-pushed');
    assert.equal(gone?.errorCode, 'no-workspace', JSON.stringify(events));
    assert.ok(!git(root, '--git-dir', remote, 'branch', '--list', 'main').includes('portal'), 'nothing extra on main');
  });

  it('validateFinalizeRequest is the one the Claude runner uses', () => {
    assert.equal(validateFinalizeRequest({ mode: 'finalize', repo: '../x', base: 'main', branch: 'b', message: 'm' }).ok, false);
    assert.equal(validateFinalizeRequest({ mode: 'finalize', repo: 'web', base: 'main', branch: 'b', message: 'm' }).ok, true);
  });
});
