/** The repository list sent to AgentCore runners: validation and cloning. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRunnerRepos, cloneRunnerRepos } from '../server/agent/runner-repos.ts';

describe('parseRunnerRepos', () => {
  it('accepts a normal repository with git auth settings', () => {
    const r = parseRunnerRepos([{
      name: 'my-repo', url: 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/my-repo', branch: 'main',
      env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic abc' },
    }]);
    assert.equal(r.ok, true);
  });
  it('accepts the exact settings the portal builds (empty credential.helper first, then the auth header)', () => {
    const r = parseRunnerRepos([{
      name: 'x', url: 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/x',
      env: {
        GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'http.https://git-codecommit.ap-southeast-1.amazonaws.com/.extraHeader', GIT_CONFIG_VALUE_1: 'Authorization: Basic abc',
      },
    }]);
    assert.equal(r.ok, true);
  });
  it('does not allow credential.helper to run a program', () => {
    const r = parseRunnerRepos([{
      name: 'x', url: 'https://example.com/x',
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!sh -c evil' },
    }]);
    assert.equal(r.ok, false);
  });
  it('rejects anything that could run a command or escape the folder', () => {
    const base = { name: 'a', url: 'https://example.com/a.git' };
    for (const bad of [
      { ...base, name: '../evil' },
      { ...base, name: 'a/b' },
      { ...base, url: 'file:///etc' },
      { ...base, url: 'ssh://x/y' },
      { ...base, branch: '--upload-pack=x' },
      { ...base, env: { PATH: '/tmp' } },
      { ...base, env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand', GIT_CONFIG_VALUE_0: 'x' } },
    ]) {
      assert.equal(parseRunnerRepos([bad]).ok, false, JSON.stringify(bad));
    }
  });
  it('limits the number of repositories and rejects duplicates', () => {
    const one = { name: 'a', url: 'https://example.com/a.git' };
    assert.equal(parseRunnerRepos([one, one]).ok, false);
    assert.equal(parseRunnerRepos(Array.from({ length: 11 }, (_, i) => ({ name: `r${i}`, url: 'https://example.com/x' }))).ok, false);
  });
});

describe('cloneRunnerRepos', () => {
  it('clones into repos/<name> and reports what is available', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: src });
    fs.writeFileSync(path.join(src, 'hello.txt'), 'hi');
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'add', '.'], { cwd: src });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: src });
    const work = path.join(tmp, 'work');
    fs.mkdirSync(work);
    const msgs: string[] = [];
    // A local path stands in for the https URL (cloneRunnerRepos itself does not care; parseRunnerRepos does).
    const done = await cloneRunnerRepos(
      [{ name: 'proj', url: pathToFileUrl(src) }, { name: 'missing', url: pathToFileUrl(path.join(tmp, 'nope')) }],
      work,
      (e) => { if (e.type === 'status') msgs.push(e.text); },
    );
    assert.deepEqual(done, ['proj']);
    assert.equal(fs.readFileSync(path.join(work, 'repos', 'proj', 'hello.txt'), 'utf8'), 'hi');
    assert.ok(msgs.some((m) => m.startsWith('Could not clone missing')));
    assert.ok(msgs.some((m) => m.includes('repos/proj/')));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('cloneRunnerRepos with persistent storage', () => {
  it('keeps a repository between runs, updates it, and never discards the changes the agent made', async () => {
    // The runner is Linux; creating folder links needs extra rights on Windows, so skip there when it is not allowed.
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-link-'));
    try {
      fs.mkdirSync(path.join(probe, 'a'));
      fs.symlinkSync(path.join(probe, 'a'), path.join(probe, 'b'), 'dir');
    } catch {
      fs.rmSync(probe, { recursive: true, force: true });
      return;
    }
    fs.rmSync(probe, { recursive: true, force: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-persist-'));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' }).toString();
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(src, 'a.txt'), '1');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'one');
    const persist = path.join(tmp, 'persist');
    fs.mkdirSync(persist);
    const repo = { name: 'proj', url: 'file://' + src.split(path.sep).join('/'), branch: 'main' };

    // Run 1: a fresh microVM clones into the persistent folder.
    const work1 = path.join(tmp, 'work1');
    fs.mkdirSync(work1);
    const m1: string[] = [];
    await cloneRunnerRepos([repo], work1, (e) => { if (e.type === 'status') m1.push(e.text); }, { persistRoot: persist });
    assert.ok(m1.some((m) => m.startsWith('Cloning proj')));
    assert.ok(fs.existsSync(path.join(persist, 'repos', 'proj', 'a.txt')));

    // The source moves on; run 2 (a new work folder, same persistent folder) brings it up to date without cloning.
    fs.writeFileSync(path.join(src, 'b.txt'), '2');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'two');
    const work2 = path.join(tmp, 'work2');
    fs.mkdirSync(work2);
    const m2: string[] = [];
    await cloneRunnerRepos([repo], work2, (e) => { if (e.type === 'status') m2.push(e.text); }, { persistRoot: persist });
    assert.ok(!m2.some((m) => m.startsWith('Cloning')), m2.join(' | '));
    assert.ok(m2.some((m) => m.includes('up to date')), m2.join(' | '));
    assert.ok(fs.existsSync(path.join(persist, 'repos', 'proj', 'b.txt')));

    // The agent edits a file: the next run leaves the repository alone.
    fs.writeFileSync(path.join(persist, 'repos', 'proj', 'a.txt'), 'edited');
    fs.writeFileSync(path.join(src, 'c.txt'), '3');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'three');
    const work3 = path.join(tmp, 'work3');
    fs.mkdirSync(work3);
    const m3: string[] = [];
    await cloneRunnerRepos([repo], work3, (e) => { if (e.type === 'status') m3.push(e.text); }, { persistRoot: persist });
    assert.ok(m3.some((m) => m.includes("already has your session's changes")), m3.join(' | '));
    assert.equal(fs.readFileSync(path.join(persist, 'repos', 'proj', 'a.txt'), 'utf8'), 'edited');
    assert.ok(!fs.existsSync(path.join(persist, 'repos', 'proj', 'c.txt')));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

function pathToFileUrl(p: string): string {
  return p;
}
