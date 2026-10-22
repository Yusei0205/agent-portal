/**
 * Every api.get/post/put/patch/del call in web/src must hit a route the server registers, with the same method.
 * (A UI call to a missing route shows up as "Not found" only when someone clicks it.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('every API call in the web UI matches a server route', () => {
  const routes: { m: string; re: RegExp }[] = [];
  for (const f of walk('server').filter((f) => f.endsWith('.ts'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\b(get|post|put|patch|del)\(\s*'(\/[^']+)'/g)) {
      routes.push({ m: m[1], re: new RegExp('^' + m[2].replace(/:[A-Za-z]+/g, '[^/]+') + '$') });
    }
  }
  assert.ok(routes.length > 100, 'server routes were found');
  const missing: string[] = [];
  for (const f of walk(path.join('web', 'src')).filter((f) => /\.(jsx?|tsx?)$/.test(f))) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/api\.(get|post|put|patch|del)\(\s*([`'"])(\/api[^`'"]*)\2/g)) {
      const url = m[3].replace(/\$\{[^}]*\}/g, 'X').split('?')[0];
      // A whole path segment built at runtime (e.g. /api/workflows/${id}/${action}) cannot be checked here.
      if (/\/X$/.test(url) && /\$\{[^}]*\}$/.test(m[3].split('?')[0]) && m[3].split('${').length > 2) continue;
      if (!routes.some((r) => r.m === m[1] && r.re.test(url))) missing.push(`${f}:${s.slice(0, m.index).split('\n').length} ${m[1].toUpperCase()} ${m[3]}`);
    }
  }
  assert.deepEqual(missing, [], `UI calls with no matching server route:\n${missing.join('\n')}`);
});
