/**
 * What a person did to an imported API survives reading the document again.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { carryOverPaths } from '../server/api-sim/import-drafts.ts';
import type { ApiSpec } from '../server/api-sim/types.ts';

const HEAD = ['NO.', 'FIELD NAME', '(M)andatory or (O)ptional or Conditional or Echo', 'Data Type', 'Data Length', 'FIELD NAME DESCRIPTION', 'REMARKS'];
const sheet = (extra: string[][] = []) => [
  ['1. Request'], ['API Name', 'UpdateFlash'], ['Method', 'POST'], ['Authentication', 'None'], HEAD,
  ['1', 'applicationNumber', 'M', 'String', '20', 'Application number'], ...extra,
  ['2. Response'], ['API Name', 'UpdateFlash'], HEAD, ['1', 'id', 'M', 'String', '-', 'Request id'],
];
async function workbook(rows: string[][]): Promise<string> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('UpdateFlash');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

const spec = (path: string, flagged: boolean): ApiSpec => ({
  openapi: '3.0.3', info: { title: 'T', version: '1' },
  paths: { [path]: { post: { operationId: 'doIt', responses: {}, ...(flagged ? { 'x-flags': [{ code: 'MISSING_PATH', severity: 'warning' as const, message: 'x' }] } : {}) } } },
});

describe('carrying a typed-in path over', () => {
  test('the new draft takes the earlier path and loses the "path needed" flag', () => {
    const next = spec('/doIt', true);
    carryOverPaths(spec('/real/path', false), next);
    assert.deepEqual(Object.keys(next.paths), ['/real/path']);
    assert.equal(next.paths['/real/path'].post!['x-flags'], undefined);
  });

  test('a path the new document does give is left alone, and so is a different method', () => {
    const given = spec('/from/document', false);
    carryOverPaths(spec('/old', false), given);
    assert.deepEqual(Object.keys(given.paths), ['/from/document']);
    const other = spec('/doIt', true);
    const before = spec('/real', false);
    (before.paths['/real'] as Record<string, unknown>).put = before.paths['/real'].post;
    delete before.paths['/real'].post;
    carryOverPaths(before, other);
    assert.deepEqual(Object.keys(other.paths), ['/doIt']);
  });

  test('it never overwrites a path that is already used by that method', () => {
    const next = spec('/doIt', true);
    next.paths['/real'] = { post: { operationId: 'other', responses: {} } };
    carryOverPaths(spec('/real', false), next);
    assert.deepEqual(Object.keys(next.paths).sort(), ['/doIt', '/real']);
  });
});

describe('reading the same workbook again', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  before(async () => {
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@reimp.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@reimp.test', password: 'adminpassword1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'R' }, cookie })).body as { project: { id: string } }).project.id;
  });
  after(cleanup);

  test('the path entered by hand is still there in version 2, so it can be approved straight away', async () => {
    const m = (p: string) => `/api/projects/${pid}/sim${p}`;
    const first = await fetchJson(baseUrl, m('/import'), { body: { kind: 'xlsx', contentBase64: await workbook(sheet()) }, cookie });
    const id = (first.body as { created: Array<{ id: string }> }).created[0].id;
    assert.equal((await fetchJson(baseUrl, m(`/apis/${id}/versions/1/path`), { method: 'PUT', body: { path: '/flash/update' }, cookie })).status, 200);

    const again = await fetchJson(baseUrl, m('/import'), { body: { kind: 'xlsx', contentBase64: await workbook(sheet([['2', 'action', 'M', 'String', '20', 'Action']])) }, cookie });
    const c = (again.body as { created: Array<{ id: string; version: number }> }).created[0];
    assert.deepEqual([c.id, c.version], [id, 2]);

    const v2 = (await fetchJson(baseUrl, m(`/apis/${id}?version=2`), { cookie })).body as { spec: ApiSpec; flags: Array<{ code: string }> };
    assert.deepEqual(Object.keys(v2.spec.paths), ['/flash/update']);
    assert.ok(!v2.flags.some((f) => f.code === 'MISSING_PATH'));
    assert.equal((await fetchJson(baseUrl, m(`/apis/${id}/versions/2/approve`), { body: {}, cookie })).status, 200);
    const diff = (await fetchJson(baseUrl, m(`/apis/${id}/diff?from=1&to=2`), { cookie })).body as { changes: Array<{ details: string[] }> };
    assert.match(diff.changes[0].details.join('\n'), /field "action" added/);
    assert.ok(!diff.changes[0].details.some((d) => /URL path changed/.test(d)));
  });
});
