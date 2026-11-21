import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectWorkspace } from '../server/agent/runner-inspect.ts';

function setup(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-'));
  const repo = path.join(root, 'repos', 'demo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  g('add', '.'); g('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\n');
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
  return root;
}

test('tree lists repos and hides .git', async () => {
  const root = setup();
  const top = await inspectWorkspace([root], { op: 'tree' });
  assert.ok(top.ok);
  assert.deepEqual((top.data.entries as Array<{ name: string }>).map((e) => e.name), ['repos']);
  const repo = await inspectWorkspace([root], { op: 'tree', path: 'repos/demo' });
  assert.ok(repo.ok);
  const names = (repo.data.entries as Array<{ name: string }>).map((e) => e.name);
  assert.ok(names.includes('src') && names.includes('new.txt') && !names.includes('.git'));
});

test('file reads text, flags binary, refuses escapes', async () => {
  const root = setup();
  const t = await inspectWorkspace([root], { op: 'file', path: 'repos/demo/src/a.ts' });
  assert.ok(t.ok && t.data.type === 'text' && String(t.data.content).includes('a = 2'));
  const b = await inspectWorkspace([root], { op: 'file', path: 'repos/demo/bin.dat' });
  assert.ok(b.ok && b.data.type === 'binary');
  for (const bad of ['../etc/passwd', '/etc/passwd', 'repos/../../x']) {
    const r = await inspectWorkspace([root], { op: 'file', path: bad });
    assert.equal(r.ok, false);
  }
});

test('git status and diff', async () => {
  const root = setup();
  const s = await inspectWorkspace([root], { op: 'git-status' });
  assert.ok(s.ok);
  const repos = s.data.repos as Array<{ name: string; files: Array<{ path: string; status: string }> }>;
  assert.equal(repos[0].name, 'demo');
  const by = Object.fromEntries(repos[0].files.map((f) => [f.path, f.status]));
  assert.equal(by['src/a.ts'], 'M');
  assert.equal(by['new.txt'], '?');
  const d = await inspectWorkspace([root], { op: 'git-diff', repo: 'demo', path: 'src/a.ts' });
  assert.ok(d.ok && String(d.data.diff).includes('+export const a = 2;'));
  const bad = await inspectWorkspace([root], { op: 'git-diff', repo: 'demo', path: '../x' });
  assert.equal(bad.ok, false);
});
