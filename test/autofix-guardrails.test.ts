import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDiff } from '../server/autofix/guardrails.ts';
import { DEFAULT_POLICY } from '../server/autofix/policy.ts';

const p = DEFAULT_POLICY;
const f = (path: string, added = 1, removed = 0) => ({ path, added, removed });

test('a change to .github/workflows/ci.yml is not ok', () => {
  const r = checkDiff([f('.github/workflows/ci.yml')], p, 'tests');
  assert.equal(r.ok, false);
  assert.match(r.violations[0], /\.github\/workflows\/ci\.yml/);
});
test("package-lock.json is a violation for kind 'tests'", () => {
  assert.equal(checkDiff([f('package-lock.json')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('web/package-lock.json')], p, 'tests').ok, false);
});
test("lockfiles are allowed for kind 'deps'", () => {
  assert.equal(checkDiff([f('package-lock.json'), f('web/package-lock.json')], p, 'deps').ok, true);
});
test("deps does not unlock other protected paths", () => {
  assert.equal(checkDiff([f('.env')], p, 'deps').ok, false);
});
test('dotfiles and nested paths match', () => {
  assert.equal(checkDiff([f('.env')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('a/b/.env.local')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('certs/server.pem')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('infra/x/y.tf')], p, 'tests').ok, false);
});
test('backslashes and leading ./ are normalised', () => {
  assert.equal(checkDiff([f('.github\\workflows\\ci.yml')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('./package-lock.json')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('.\\src\\a.ts')], p, 'tests').ok, true);
});
test('ordinary files are ok', () => {
  assert.deepEqual(checkDiff([f('src/a.ts'), f('test/a.test.ts')], p, 'tests'), { ok: true, large: false, violations: [] });
});
test('11 files sets large but stays ok', () => {
  const files = Array.from({ length: 11 }, (_, i) => f(`src/f${i}.ts`));
  const r = checkDiff(files, p, 'tests');
  assert.equal(r.large, true); assert.equal(r.ok, true);
});
test('10 files is not large', () => {
  assert.equal(checkDiff(Array.from({ length: 10 }, (_, i) => f(`src/f${i}.ts`)), p, 'tests').large, false);
});
test('301 changed lines sets large; 300 does not', () => {
  assert.equal(checkDiff([f('src/a.ts', 200, 101)], p, 'tests').large, true);
  assert.equal(checkDiff([f('src/a.ts', 200, 100)], p, 'tests').large, false);
});
test('an empty diff is ok and not large', () => {
  assert.deepEqual(checkDiff([], p, 'tests'), { ok: true, large: false, violations: [] });
});
test('deps exemption covers only the lockfile globs', () => {
  assert.equal(checkDiff([f('infra/package-lock.json')], p, 'deps').ok, false);
  assert.equal(checkDiff([f('.github/workflows/package-lock.json')], p, 'deps').ok, false);
  // dot-directories: `**` in matchesGlob does not cross them, the suffix fallback does
  assert.equal(checkDiff([f('.hidden/a/.env')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('.hidden/package-lock.json')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('.hidden/package-lock.json')], p, 'deps').ok, true);
  assert.equal(checkDiff([f('package-lock.json'), f('web/package-lock.json')], p, 'deps').ok, true);
});
test('yarn.lock matches no default glob: not blocked, not specially exempted', () => {
  assert.equal(checkDiff([f('yarn.lock')], p, 'tests').ok, true);
  const strict = { ...p, protected_paths: [...p.protected_paths, 'yarn.lock'] };
  assert.equal(checkDiff([f('yarn.lock')], strict, 'deps').ok, false);
});
test('matching is case-insensitive', () => {
  assert.equal(checkDiff([f('.GitHub/Workflows/x.yml')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('Infra/a.tf')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('a/B.PEM')], p, 'tests').ok, false);
});
test('leading slash and doubled slashes are normalised', () => {
  assert.equal(checkDiff([f('/.github/workflows/ci.yml')], p, 'tests').ok, false);
  assert.equal(checkDiff([f('.github//workflows//ci.yml')], p, 'tests').ok, false);
});

// ── Round 2 of the Task 9 review: one matcher with the runner, control characters, dotfiles ──

import { deniedBy, globToRegExp } from '../server/agent/runner-finalize.ts';

test('a newline inside a path does not hide it from any default protected glob', () => {
  for (const path of ['.github/workflows/a b\nc.yml', 'a\nb/.env', 'x\ny/key.pem', 'a\nb/package-lock.json', 'infra/x\ny']) {
    const r = checkDiff([f(path)], p, 'tests');
    assert.equal(r.ok, false, JSON.stringify(path));
  }
});
test('dotfiles and dot-directories under a protected directory match', () => {
  for (const path of ['infra/.tf', 'infra/.main\n.tf', '.github/workflows/.ci.yml', '.github/workflows/.ci\n.yml', 'infra/.a/.b']) {
    const r = checkDiff([f(path)], p, 'tests');
    assert.equal(r.ok, false, JSON.stringify(path));
    assert.ok(r.violations.some((v) => /protected path/.test(v)), JSON.stringify(path));
  }
});
test('a path with a control character is a violation even when no glob matches it', () => {
  for (const path of ['src/a\nb.ts', 'src/a\rb.ts', 'src/a\tb.ts', 'src/a\x7fb.ts', 'src/\x01.ts']) {
    const r = checkDiff([f(path)], p, 'tests');
    assert.equal(r.ok, false, JSON.stringify(path));
    assert.ok(r.violations.some((v) => /control character/.test(v)), JSON.stringify(path));
  }
  assert.equal(checkDiff([f('src/é ü.ts')], p, 'tests').ok, true, 'unicode and spaces are fine');
});
test('the server and the runner judge every path the same way (one matcher)', () => {
  const res = p.protected_paths.map(globToRegExp);
  for (const path of [
    '.github/workflows/ci.yml', '.github/workflows/.ci.yml', '.github/ci.yml', 'infra/.tf', 'infra/.a/.b', 'src/infra/x', '.env', 'a/.env.x',
    'a/env', 'k.pem', 'a/.b/c.PEM', 'package-lock.json', '.x/package-lock.json', 'src/a.ts', 'README.md', 'x\ny/key.pem', 'infra/x\ny',
  ]) {
    const server = !checkDiff([f(path)], { ...p, protected_paths: p.protected_paths }, 'tests').violations.every((v) => !/protected path/.test(v));
    assert.equal(server, deniedBy(path, res, p.protected_paths) !== null, JSON.stringify(path));
  }
});
test('the matcher stays fast on a pathological path (no suffix expansion)', () => {
  const deep = 'a/'.repeat(20000) + 'package-lock.json';
  const t0 = Date.now();
  assert.equal(checkDiff([f(deep)], p, 'tests').ok, false);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});
