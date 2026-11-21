/**
 * API simulation: repository + routes + the hosted simulated API, end to end against a real test server.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

const HEAD = ['NO.', 'FIELD NAME', '(M)andatory or (O)ptional or Conditional or Echo', 'Data Type', 'Data Length', 'FIELD NAME DESCRIPTION', 'REMARKS'];

function sheetRows(actionLength: string): string[][] {
  return [
    ['1. Request'],
    ['API Name', 'UpdateFlash'],
    ['Method', 'POST'],
    ['Authentication', 'Yes'],
    HEAD,
    ['1', 'Bearer', 'M', 'String', 'No limit', 'Token from login'],
    [],
    ['Content-Type', 'application/json'],
    HEAD,
    ['1', 'applicationNumber', 'M', 'String', '20', 'Application number'],
    ['2', 'action', 'M', 'String', actionLength, 'Action'],
    ['3', 'comments', 'CM', 'String', '2000', 'Comments', 'Mandatory when action = 142'],
    ['2. Response'],
    ['API Name', 'UpdateFlash'],
    HEAD,
    ['1', 'id', 'M', 'String', '-', 'Request id'],
    ['2', 'code', 'M', 'String', '10', 'Response code'],
  ];
}

async function workbookBase64(actionLength = '20'): Promise<string> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Cover Page').addRow(['Client API spec']);
  const ws = wb.addWorksheet('UpdateFlash');
  for (const r of sheetRows(actionLength)) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

let baseUrl: string;
let cookie: string;
let outsiderCookie: string;
let token: string;
let projectId: string;
let apiId: string;

const mgmt = (p: string) => `/api/projects/${projectId}/sim${p}`;
const call = (rest: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  fetchJson(baseUrl, `/api/sim/${projectId}/${apiId}/call${rest}`, {
    method: init.method ?? 'POST',
    body: init.body,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });

const GOOD = { applicationNumber: 'A1', action: '141' };
const CLIENT = { 'X-Sim-Authorization': 'Bearer client-jwt' };

before(async () => {
  baseUrl = (await createTestServer()).baseUrl;
  await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@sim.test', password: 'adminpassword1', name: 'Admin' } });
  cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@sim.test', password: 'adminpassword1' } })).cookie ?? '';
  await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: 'out@sim.test', name: 'Out', password: 'outsiderpass1', isAdmin: false }, cookie });
  outsiderCookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'out@sim.test', password: 'outsiderpass1' } })).cookie ?? '';
  const p = await fetchJson(baseUrl, '/api/projects', { body: { name: 'Sim project' }, cookie });
  projectId = ((p.body as { project: { id: string } }).project).id;
  const t = await fetchJson(baseUrl, '/api/api-tokens', { body: { name: 'sim', scope: 'write' }, cookie });
  token = (t.body as { token: string }).token;
});

after(cleanup);

describe('import and review', () => {
  test('imports an Excel workbook: one API per API sheet, cover page skipped', async () => {
    const r = await fetchJson(baseUrl, mgmt('/import'), { body: { kind: 'xlsx', contentBase64: await workbookBase64() }, cookie });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = r.body as { created: Array<{ id: string; name: string; version: number; isNew: boolean }>; skippedSheets: string[] };
    assert.equal(b.created.length, 1);
    assert.equal(b.created[0].name, 'UpdateFlash');
    assert.equal(b.created[0].version, 1);
    assert.deepEqual(b.skippedSheets, ['Cover Page']);
    apiId = b.created[0].id;
  });

  test('rejects a file that is not a workbook, and a workbook with no API sheets', async () => {
    const junk = await fetchJson(baseUrl, mgmt('/import'), { body: { kind: 'xlsx', contentBase64: Buffer.from('nope').toString('base64') }, cookie });
    assert.equal(junk.status, 400);
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Just notes').addRow(['hello']);
    const none = await fetchJson(baseUrl, mgmt('/import'), { body: { kind: 'xlsx', contentBase64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') }, cookie });
    assert.equal(none.status, 400);
    assert.match(String((none.body as { error: string }).error), /No API sheets/);
  });

  test('the list shows the draft with its missing-path warning', async () => {
    const r = await fetchJson(baseUrl, mgmt('/apis'), { cookie });
    const api = (r.body as { apis: Array<{ id: string; approvedVersion: number; flags: { missingPath: boolean; warnings: number } }> }).apis[0];
    assert.equal(api.id, apiId);
    assert.equal(api.approvedVersion, 0);
    assert.equal(api.flags.missingPath, true);
    assert.ok(api.flags.warnings >= 2, 'expected the missing path and the conditional rule');
  });

  test('a person outside the project cannot see or change it', async () => {
    assert.equal((await fetchJson(baseUrl, mgmt('/apis'), { cookie: outsiderCookie })).status, 404);
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { method: 'DELETE', cookie: outsiderCookie })).status, 404);
  });

  test('imports an OpenAPI document too, and refuses a malformed one', async () => {
    const ok = await fetchJson(baseUrl, mgmt('/import'), {
      body: { kind: 'openapi', spec: { openapi: '3.0.1', info: { title: 'Pets' }, paths: { '/pets': { get: { responses: { '200': { description: 'ok' } } } } } } }, cookie,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const bad = await fetchJson(baseUrl, mgmt('/import'), { body: { kind: 'openapi', spec: { swagger: '2.0' } }, cookie });
    assert.equal(bad.status, 400);
    const petId = (ok.body as { created: Array<{ id: string }> }).created[0].id;
    await fetchJson(baseUrl, mgmt(`/apis/${petId}`), { method: 'DELETE', cookie });
  });
});

describe('approval and the hosted API', () => {
  test('the simulated API refuses to answer until a version is approved', async () => {
    const r = await call('/flash/update', { body: GOOD, headers: CLIENT });
    assert.equal(r.status, 409);
    assert.equal((r.body as { error: string }).error, 'API_NOT_APPROVED');
  });

  test('approval is refused while the URL path is missing; then a path is entered and it works', async () => {
    const early = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/versions/1/approve`), { body: {}, cookie });
    assert.equal(early.status, 409);
    const badPath = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/versions/1/path`), { method: 'PUT', body: { path: 'no-slash' }, cookie });
    assert.equal(badPath.status, 400);
    const set = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/versions/1/path`), { method: 'PUT', body: { path: '/flash/update' }, cookie });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const approve = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/versions/1/approve`), { body: {}, cookie });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    // an approved version is frozen
    const again = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/versions/1/path`), { method: 'PUT', body: { path: '/other' }, cookie });
    assert.equal(again.status, 409);
  });

  test('a valid call is answered from the response schema, with the conditional-rule warning counted', async () => {
    const r = await call('/flash/update', { body: GOOD, headers: CLIENT });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers.get('x-mock-source'), 'generated');
    assert.equal(r.headers.get('x-mock-warnings'), '1');
    assert.equal(typeof (r.body as { code: string }).code, 'string');
  });

  test('only an API token may call it: a browser session is refused', async () => {
    const r = await fetchJson(baseUrl, `/api/sim/${projectId}/${apiId}/call/flash/update`, { body: GOOD, cookie, headers: CLIENT });
    assert.equal(r.status, 401);
  });

  test('the client credential is required where the spec says so (X-Sim-Authorization)', async () => {
    const r = await call('/flash/update', { body: GOOD });
    assert.equal(r.status, 401);
    assert.equal((r.body as { error: string }).error, 'UNAUTHENTICATED');
  });

  test('a body that breaks the spec gets 400 with the field list', async () => {
    const r = await call('/flash/update', { body: { action: 7 }, headers: CLIENT });
    assert.equal(r.status, 400);
    const errs = (r.body as { errors: Array<{ path: string }> }).errors.map((e) => e.path);
    assert.ok(errs.includes('body.applicationNumber'));
    assert.ok(errs.includes('body.action'));
  });

  test('BLOCKED: a route that is not in the spec gets 501, not a guess', async () => {
    const r = await call('/flash/unknown', { body: GOOD, headers: CLIENT });
    assert.equal(r.status, 501);
    assert.equal((r.body as { error: string }).error, 'NO_MOCK_RULE');
  });

  test('the Try-it route runs the engine without a token or a delay', async () => {
    const r = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/try`), { body: { method: 'POST', path: '/flash/update', headers: { Authorization: 'x' }, body: GOOD }, cookie });
    assert.equal(r.status, 200);
    assert.equal((r.body as { result: { status: number } }).result.status, 200);
  });
});

describe('rules', () => {
  test('a rule is validated, stored, and chosen by request body', async () => {
    const bad = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/rules/reject`), { method: 'PUT', body: { operationId: 'nope', name: 'x', failure: 'timeout' }, cookie });
    assert.equal(bad.status, 400);
    const none = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/rules/reject`), { method: 'PUT', body: { operationId: 'updateFlash', name: 'empty' }, cookie });
    assert.equal(none.status, 400);
    const ok = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/rules/reject`), {
      method: 'PUT', cookie,
      body: { operationId: 'updateFlash', name: 'reject 142', when: { body: { action: '142' } }, response: { status: 422, body: { id: 'r1', code: '99' } } },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const hit = await call('/flash/update', { body: { ...GOOD, action: '142' }, headers: CLIENT });
    assert.equal(hit.status, 422);
    assert.equal(hit.headers.get('x-mock-source'), 'rule');
    assert.deepEqual(hit.body, { id: 'r1', code: '99' });
    const miss = await call('/flash/update', { body: GOOD, headers: CLIENT });
    assert.equal(miss.status, 200);
  });

  test('a scripted failure is returned', async () => {
    await fetchJson(baseUrl, mgmt(`/apis/${apiId}/rules/boom`), {
      method: 'PUT', cookie, body: { operationId: 'updateFlash', name: 'server error', when: { body: { action: '500' } }, failure: 'server_error' },
    });
    const r = await call('/flash/update', { body: { ...GOOD, action: '500' }, headers: CLIENT });
    assert.equal(r.status, 500);
  });
});

describe('a changed spec', () => {
  test('re-importing makes a new draft version of the same API', async () => {
    const r = await fetchJson(baseUrl, mgmt('/import'), { body: { kind: 'xlsx', contentBase64: await workbookBase64('30'), paths: { UpdateFlash: '/flash/update' } }, cookie });
    const c = (r.body as { created: Array<{ id: string; version: number; isNew: boolean }> }).created[0];
    assert.equal(c.id, apiId);
    assert.equal(c.version, 2);
    assert.equal(c.isNew, false);
    // the approved version 1 keeps answering while version 2 is a draft
    assert.equal((await call('/flash/update', { body: GOOD, headers: CLIENT })).status, 200);
  });

  test('approving the changed version blocks the rules that no longer fit until they are confirmed', async () => {
    const approve = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/versions/2/approve`), { body: {}, cookie });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal((approve.body as { rulesNeedingReview: number }).rulesNeedingReview, 2);
    const blocked = await call('/flash/update', { body: { ...GOOD, action: '142' }, headers: CLIENT });
    assert.equal(blocked.status, 501);
    assert.equal((blocked.body as { error: string }).error, 'MOCK_RULE_NEEDS_REVIEW');
  });

  test('saving the rule again confirms it', async () => {
    const r = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/rules/reject`), {
      method: 'PUT', cookie,
      body: { operationId: 'updateFlash', name: 'reject 142', when: { body: { action: '142' } }, response: { status: 422, body: { id: 'r1', code: '99' } } },
    });
    assert.equal(r.status, 200);
    assert.equal((await call('/flash/update', { body: { ...GOOD, action: '142' }, headers: CLIENT })).status, 422);
  });
});

describe('modes', () => {
  test('live needs a base URL, and the URL must be https', async () => {
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { method: 'PUT', body: { mode: 'live' }, cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { method: 'PUT', body: { liveBaseUrl: 'http://client.example' }, cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { method: 'PUT', body: { mode: 'bogus' }, cookie })).status, 400);
  });

  test('live calls to a private address are refused by the SSRF guard', async () => {
    const set = await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { method: 'PUT', body: { mode: 'live', liveBaseUrl: 'https://127.0.0.1:9' }, cookie });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const r = await call('/flash/update', { body: GOOD, headers: CLIENT });
    assert.equal(r.status, 502);
    assert.match(String((r.body as { message: string }).message), /SSRF/);
    await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { method: 'PUT', body: { mode: 'mock' }, cookie });
  });

  test('requireExplicitRule blocks an operation answered only from the schema', async () => {
    await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { method: 'PUT', body: { requireExplicitRule: true }, cookie });
    const r = await call('/flash/update', { body: GOOD, headers: CLIENT });
    assert.equal(r.status, 501);
    await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { method: 'PUT', body: { requireExplicitRule: false }, cookie });
  });
});

describe('cleanup', () => {
  test('deleting the API removes its versions and rules', async () => {
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { method: 'DELETE', cookie })).status, 200);
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { cookie })).status, 404);
    const { getSimulationRepository } = await import('../server/repositories/simulation.ts');
    assert.deepEqual(await getSimulationRepository().listRules(apiId), []);
    assert.deepEqual(await getSimulationRepository().listVersions(apiId), []);
  });
});
