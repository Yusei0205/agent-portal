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
