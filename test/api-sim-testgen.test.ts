/**
 * Test cases generated from an API specification: the rules (unit) and the route in the Tests module (end to end).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { generateApiCases } from '../server/api-sim/test-cases.ts';
import { handleMockRequest } from '../server/api-sim/mock-engine.ts';
import { validateValue } from '../server/api-sim/schema.ts';
import type { ApiSpec } from '../server/api-sim/types.ts';

const SPEC: ApiSpec = {
  openapi: '3.0.3',
  info: { title: 'Flash', version: '1' },
  paths: {
    '/flash/update': {
      post: {
        operationId: 'updateFlash',
        summary: 'UpdateFlash',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'X-Source-Id', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['applicationNumber', 'action'],
                properties: {
                  applicationNumber: { type: 'string', maxLength: 20 },
                  action: { type: 'string', enum: ['141', '142'] },
                  comment: { type: 'object', properties: { comments: { type: 'string', 'x-conditional': 'Mandatory when action = 142' } } },
                  items: { type: 'array', items: { type: 'object', required: ['qty'], properties: { qty: { type: 'integer' } } } },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string' } } } } } } },
      },
    },
  },
};

describe('case rules', () => {
  const { cases, assumptions } = generateApiCases(SPEC, { baseUrl: 'https://client.example' });
  const byKind = (k: string) => cases.filter((c) => c.kind === k);

  test('one valid case first, with a body that passes the specification', () => {
    assert.equal(cases[0].kind, 'valid');
    assert.equal(cases[0].step!.expectedStatus, 200);
    assert.equal(cases[0].request.url, 'https://client.example/flash/update');
    const schema = SPEC.paths['/flash/update'].post!.requestBody!.content['application/json'].schema;
    assert.equal(validateValue(cases[0].step!.body, schema).errors.length, 0);
  });

  test('covers authentication, headers, required fields, types, enums and lengths', () => {
    assert.equal(byKind('no_token').length, 1);
    assert.equal(byKind('no_token')[0].step!.headers.Authorization, undefined);
    assert.equal(byKind('no_token')[0].step!.expectedStatus, 401);
    assert.equal(byKind('missing_header')[0].step!.headers['X-Source-Id'], undefined);
    assert.deepEqual(byKind('missing_required').map((c) => c.scenario).sort(), [
      'Required field "action" missing', 'Required field "applicationNumber" missing', 'Required field "items[].qty" missing',
    ]);
    assert.equal(byKind('wrong_type').length, 6); // applicationNumber, action, comment, comment.comments, items, items[].qty
    assert.equal(byKind('invalid_enum').length, 1);
    assert.match(byKind('invalid_enum')[0].expectedResult, /141, 142/);
    const long = byKind('too_long')[0].step!.body as { applicationNumber: string };
    assert.equal(long.applicationNumber.length, 21);
  });

  test('a rule stated only in words becomes a manual case with no runnable step', () => {
    const c = byKind('conditional')[0];
    assert.equal(c.step, null);
    assert.equal(c.response, null);
    assert.match(c.scenario, /comment\.comments/);
    assert.match(c.expectedResult, /action = 142/);
    assert.match(c.remarks, /Not run automatically/);
  });

  test('numbered per operation and stating what it assumes', () => {
    assert.equal(cases[0].testId, 'TC-1.1.1');
    assert.equal(new Set(cases.map((c) => c.testId)).size, cases.length);
    assert.ok(assumptions.some((a) => /HTTP 400/.test(a)));
    assert.ok(assumptions.some((a) => /response fields are not compared/.test(a)));
  });

  test('every runnable case gets the status it expects from the mock engine', () => {
    for (const c of cases.filter((x) => x.step)) {
      const s = c.step!;
      const r = handleMockRequest(SPEC, [], { method: s.method, path: s.path, headers: s.headers, body: s.body });
      assert.equal(r.status, s.expectedStatus, `${c.testId} ${c.scenario}: expected ${s.expectedStatus}, engine said ${r.status}`);
    }
  });

  test('the per-operation cap keeps the first cases and says what was left out', () => {
    const g = generateApiCases(SPEC, { maxPerOperation: 5 });
    assert.equal(g.cases.length, 5);
    assert.equal(g.cases[0].kind, 'valid');
    assert.ok(g.assumptions.some((a) => /further cases were left out/.test(a)));
  });

  test('a missing path is called out', () => {
    const spec = structuredClone(SPEC);
    spec.paths['/flash/update'].post!['x-flags'] = [{ code: 'MISSING_PATH', severity: 'warning', message: 'x' }];
    assert.ok(generateApiCases(spec).assumptions.some((a) => /placeholder/.test(a)));
  });
});

// ── Route ─────────────────────────────────────────────────────────────────────

const HEAD = ['NO.', 'FIELD NAME', '(M)andatory or (O)ptional or Conditional or Echo', 'Data Type', 'Data Length', 'FIELD NAME DESCRIPTION', 'REMARKS'];
const SHEET = [
  ['1. Request'], ['API Name', 'UpdateFlash'], ['Method', 'POST'], ['Authentication', 'Yes'],
  HEAD, ['1', 'Bearer', 'M', 'String', 'No limit', 'Token'],
  ['Content-Type', 'application/json'],
  HEAD,
  ['1', 'applicationNumber', 'M', 'String', '20', 'Application number'],
  ['2', 'action', 'M', 'String', '20', 'Action', 'Valid Values:\n141 - Submit\n142 - Reject'],
  ['3', 'comments', 'CM', 'String', '2000', 'Comments', 'Mandatory when action = 142'],
  ['2. Response'], ['API Name', 'UpdateFlash'], HEAD,
  ['1', 'id', 'M', 'String', '-', 'Request id'], ['2', 'code', 'M', 'String', '10', 'Response code'],
];

async function workbookBase64(): Promise<string> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Cover').addRow(['spec']);
  const ws = wb.addWorksheet('UpdateFlash');
  for (const r of SHEET) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

describe('POST case-sets/from-api', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let tpid: string;
  let token: string;
  let apiId: string;
  const testsPath = () => `/api/projects/${pid}/tests/${tpid}`;

  before(async () => {
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@testgen.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@testgen.test', password: 'adminpassword1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'TG' }, cookie })).body as { project: { id: string } }).project.id;
    const tp = await fetchJson(baseUrl, `/api/projects/${pid}/tests`, { body: { name: 'API tests', appUrl: 'https://app.example' }, cookie });
    tpid = (tp.body as { testProject: { id: string } }).testProject.id;
    token = ((await fetchJson(baseUrl, '/api/api-tokens', { body: { name: 't', scope: 'write' }, cookie })).body as { token: string }).token;
    // an API in the simulation, with a path and approved
    const imp = await fetchJson(baseUrl, `/api/projects/${pid}/sim/import`, { body: { kind: 'xlsx', contentBase64: await workbookBase64() }, cookie });
    apiId = (imp.body as { created: Array<{ id: string }> }).created[0].id;
    await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis/${apiId}/versions/1/path`, { method: 'PUT', body: { path: '/flash/update' }, cookie });
    await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis/${apiId}/versions/1/approve`, { body: {}, cookie });
  });

  after(cleanup);

  test('from an API already in the simulation: a case set, plus runnable scripts when asked', async () => {
    const r = await fetchJson(baseUrl, `${testsPath()}/case-sets/from-api`, { body: { source: { kind: 'sim', apiIds: [apiId] }, createScript: true }, cookie });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = r.body as { caseSet: { id: string; caseCount: number }; scripts: Array<{ id: string; steps: number }>; manualCases: number; assumptions: string[] };
    assert.ok(b.caseSet.caseCount >= 8);
    assert.equal(b.manualCases, 1);
    assert.equal(b.scripts.length, 1);
    assert.equal(b.scripts[0].steps, b.caseSet.caseCount - b.manualCases);

    const got = await fetchJson(baseUrl, `${testsPath()}/case-sets/${b.caseSet.id}`, { cookie });
    const set = got.body as { caseSet: { status: string }; cases: Array<{ testId: string; request: { method: string; url: string }; response: { status: number } | null; category: string }> };
    assert.equal(set.caseSet.status, 'done');
    assert.equal(set.cases[0].testId, 'TC-1.1.1');
    assert.equal(set.cases[0].request.method, 'POST');
    assert.equal(set.cases[0].request.url, '/flash/update');
    assert.equal(set.cases[0].response!.status, 200);
  });

  test('the generated script passes against the simulation it was generated from', async () => {
    const r = await fetchJson(baseUrl, `${testsPath()}/case-sets/from-api`, { body: { source: { kind: 'sim', apiIds: [apiId] }, createScript: true }, cookie });
    const scriptId = (r.body as { scripts: Array<{ id: string }> }).scripts[0].id;
    const script = await fetchJson(baseUrl, `${testsPath()}/scripts/${scriptId}`, { cookie });
    const steps = ((script.body as { script: { steps: unknown } }).script.steps) as Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown; expectedStatus: number }>;
    assert.ok(steps.length >= 8);
    const failures: string[] = [];
    for (const s of steps) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      for (const [k, v] of Object.entries(s.headers)) headers[k.toLowerCase() === 'authorization' ? 'X-Sim-Authorization' : k] = v;
      const res = await fetch(`${baseUrl}/api/sim/${pid}/${apiId}/call${s.path}`, { method: s.method, headers, body: s.body !== undefined ? JSON.stringify(s.body) : undefined });
      if (res.status !== s.expectedStatus) failures.push(`${s.method} ${s.path} expected ${s.expectedStatus} got ${res.status}`);
    }
    assert.deepEqual(failures, []);
  });

  test('importing the spec is optional and does not touch the simulation: a workbook used only for the cases', async () => {
    const before = ((await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis`, { cookie })).body as { apis: unknown[] }).apis.length;
    const r = await fetchJson(baseUrl, `${testsPath()}/case-sets/from-api`, {
      body: { name: 'From file', source: { kind: 'xlsx', contentBase64: await workbookBase64(), paths: { UpdateFlash: '/client/flash' } }, baseUrl: 'https://client.example' }, cookie,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = r.body as { caseSet: { id: string; name: string }; scripts: unknown[] };
    assert.equal(b.caseSet.name, 'From file');
    assert.deepEqual(b.scripts, []);
    const set = (await fetchJson(baseUrl, `${testsPath()}/case-sets/${b.caseSet.id}`, { cookie })).body as { cases: Array<{ request: { url: string } }> };
    assert.equal(set.cases[0].request.url, 'https://client.example/client/flash');
    const after = ((await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis`, { cookie })).body as { apis: unknown[] }).apis.length;
    assert.equal(after, before);
  });

  test('an OpenAPI document works too', async () => {
    const spec = { openapi: '3.0.1', info: { title: 'Pets' }, paths: { '/pets': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { '201': { description: 'created' } } } } } };
    const r = await fetchJson(baseUrl, `${testsPath()}/case-sets/from-api`, { body: { source: { kind: 'openapi', spec } }, cookie });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok((r.body as { caseSet: { caseCount: number } }).caseSet.caseCount >= 3);
  });

  test('bad input is refused clearly', async () => {
    const post = (body: unknown) => fetchJson(baseUrl, `${testsPath()}/case-sets/from-api`, { body, cookie });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ source: { kind: 'nope' } })).status, 400);
    assert.equal((await post({ source: { kind: 'sim', apiIds: [] } })).status, 400);
    assert.equal((await post({ source: { kind: 'sim', apiIds: ['missing'] } })).status, 400);
    assert.equal((await post({ source: { kind: 'xlsx', contentBase64: Buffer.from('x').toString('base64') } })).status, 400);
    assert.equal((await post({ source: { kind: 'openapi', spec: { swagger: '2.0' } } })).status, 400);
    assert.equal((await post({ source: { kind: 'sim', apiIds: [apiId] }, baseUrl: 'ftp://x' })).status, 400);
  });
});

// ── Path and query parameters ─────────────────────────────────────────────────

describe('operations with path and query parameters', () => {
  const GETSPEC: ApiSpec = {
    openapi: '3.0.3', info: { title: 'Lookup', version: '1' },
    paths: {
      '/pets/{id}': {
        get: {
          operationId: 'getPet',
          parameters: [
            { name: 'ApplicationNo', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } },
          ],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } } },
        },
      },
    },
  };

  test('the valid request carries the required query parameter and a value for {id}; each required parameter gets a missing case', () => {
    const { cases } = generateApiCases(GETSPEC);
    const valid = cases.find((c) => c.kind === 'valid')!;
    assert.equal(valid.step!.path, '/pets/sample-id?ApplicationNo=sample-ApplicationNo');
    assert.equal(valid.request.url, '/pets/sample-id?ApplicationNo=sample-ApplicationNo');
    const missing = cases.filter((c) => c.kind === 'missing_query');
    assert.deepEqual(missing.map((c) => c.scenario), ['Required query parameter "ApplicationNo" missing']);
    assert.equal(missing[0].step!.path, '/pets/sample-id');
    assert.equal(missing[0].step!.expectedStatus, 400);
  });

  test('every case gets the status it expects from the engine, query string included', () => {
    for (const c of generateApiCases(GETSPEC).cases.filter((x) => x.step)) {
      const u = new URL(c.step!.path, 'http://x.invalid');
      const r = handleMockRequest(GETSPEC, [], { method: c.step!.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: c.step!.headers });
      assert.equal(r.status, c.step!.expectedStatus, `${c.scenario}: ${r.status}`);
    }
  });

  test('and through the real runner: the generated cases pass on the simulation', async () => {
    const { baseUrl, cookie } = await (async () => {
      const b = (await createTestServer()).baseUrl;
      await fetchJson(b, '/api/auth/setup', { body: { email: 'a@query.test', password: 'adminpassword1', name: 'A' } });
      return { baseUrl: b, cookie: (await fetchJson(b, '/api/auth/login', { body: { email: 'a@query.test', password: 'adminpassword1' } })).cookie ?? '' };
    })();
    const pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'Q' }, cookie })).body as { project: { id: string } }).project.id;
    const tpid = ((await fetchJson(baseUrl, `/api/projects/${pid}/tests`, { body: { name: 'T', appUrl: 'https://app.example' }, cookie })).body as { testProject: { id: string } }).testProject.id;
    const imp = await fetchJson(baseUrl, `/api/projects/${pid}/sim/import`, { body: { kind: 'openapi', spec: GETSPEC }, cookie });
    const apiId = (imp.body as { created: Array<{ id: string }> }).created[0].id;
    await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis/${apiId}/versions/1/approve`, { body: {}, cookie });
    const gen = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/from-api`, { body: { source: { kind: 'sim', apiIds: [apiId] } }, cookie });
    const csId = (gen.body as { caseSet: { id: string } }).caseSet.id;
    const run = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${csId}/api-runs`, { body: { target: 'simulation' }, cookie });
    const b = run.body as { summary: { pass: number; fail: number }; results: Array<{ outcome: string; scenario: string; reason: string }> };
    assert.equal(b.summary.fail, 0, JSON.stringify(b.results.filter((r) => r.outcome === 'fail')));
    assert.equal(b.summary.pass, 2);
    await cleanup();
  });
});
