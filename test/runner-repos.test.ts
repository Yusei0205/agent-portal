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
      (e) => msgs.push(e.text),
    );
    assert.deepEqual(done, ['proj']);
    assert.equal(fs.readFileSync(path.join(work, 'repos', 'proj', 'hello.txt'), 'utf8'), 'hi');
    assert.ok(msgs.some((m) => m.startsWith('Could not clone missing')));
    assert.ok(msgs.some((m) => m.includes('repos/proj/')));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

function pathToFileUrl(p: string): string {
  return p;
}
