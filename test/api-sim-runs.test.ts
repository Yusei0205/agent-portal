/**
 * Running generated API cases against the simulation and a (stand-in) live API, and comparing the two.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { judgeResponse } from '../server/api-sim/api-runner.ts';
import { getSimulationRepository } from '../server/repositories/simulation.ts';
import type { Schema } from '../server/api-sim/types.ts';

const schema: Schema = { type: 'object', required: ['id', 'code'], properties: { id: { type: 'string' }, code: { type: 'string' } } };
const http400 = { kind: 'http' } as const;
const code00 = { kind: 'code', field: 'code', successValue: '00' } as const;

describe('judgeResponse', () => {
  const j = (o: Partial<Parameters<typeof judgeResponse>[0]>) => judgeResponse({ target: 'simulation', expected: 200, actual: 200, body: { id: 'a', code: '00' }, errorStyle: http400, schema, ...o });

  test('simulation is exact', () => {
    assert.equal(j({}).ok, true);
    assert.equal(j({ expected: 400, actual: 400, body: {} }).ok, true);
    assert.equal(j({ expected: 400, actual: 422, body: {} }).ok, false);
  });
  test('a successful body is checked against the response fields', () => {
    const r = j({ body: { id: 5 } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not match the specification/);
    assert.equal(j({ body: 'text' }).ok, false);
  });
  test('live: any 4xx is a rejection when errors are HTTP statuses', () => {
    assert.equal(j({ target: 'live', expected: 400, actual: 422, body: {} }).ok, true);
    const accepted = j({ target: 'live', expected: 400, actual: 200, body: { id: 'a', code: '00' } });
    assert.equal(accepted.ok, false);
    assert.match(accepted.reason, /accepted a request that should be rejected/);
  });
  test('live: with an error code, HTTP 200 plus a failure code counts as a rejection', () => {
    assert.equal(j({ target: 'live', expected: 400, actual: 200, body: { code: '99' }, errorStyle: code00 }).ok, true);
    assert.equal(j({ target: 'live', expected: 400, actual: 200, body: { code: '00' }, errorStyle: code00 }).ok, false);
    const ok = j({ target: 'live', expected: 200, actual: 200, body: { id: 'a', code: '99' }, errorStyle: code00 });
    assert.equal(ok.ok, false);
    assert.match(ok.reason, /reported an error/);
  });
  test('live: no token may be refused with 401 or 403', () => {
    assert.equal(j({ target: 'live', expected: 401, actual: 403, body: {} }).ok, true);
    assert.equal(j({ target: 'live', expected: 401, actual: 200, body: {} }).ok, false);
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────

const HEAD = ['NO.', 'FIELD NAME', '(M)andatory or (O)ptional or Conditional or Echo', 'Data Type', 'Data Length', 'FIELD NAME DESCRIPTION', 'REMARKS'];
const SHEET = [
  ['1. Request'], ['API Name', 'UpdateFlash'], ['Method', 'POST'], ['Authentication', 'Yes'],
  HEAD, ['1', 'Bearer', 'M', 'String', 'No limit', 'Token'],
  ['Content-Type', 'application/json'],
  HEAD,
  ['1', 'applicationNumber', 'M', 'String', '20', 'Application number'],
  ['2', 'action', 'M', 'String', '20', 'Action', 'Valid Values:\n141 - Submit\n142 - Reject'],
  ['2. Response'], ['API Name', 'UpdateFlash'], HEAD,
  ['1', 'id', 'M', 'String', '-', 'Request id'], ['2', 'code', 'M', 'String', '10', 'Response code'],
];

async function workbookBase64(): Promise<string> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('UpdateFlash');
  for (const r of SHEET) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

/** The client's "real" API: it validates required fields but forgets to check the allowed values, and it reports errors in a code. */
function startLiveApi(): Promise<{ url: string; close: () => Promise<void>; seenAuth: string[] }> {
  const seenAuth: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seenAuth.push(String(req.headers.authorization ?? ''));
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== 'Bearer live-secret') { send(401, { error: 'no' }); return; }
      let b: Record<string, unknown> = {};
      try { b = JSON.parse(raw || '{}'); } catch { send(200, { id: 'x', code: '99' }); return; }
      if (typeof b.applicationNumber !== 'string' || typeof b.action !== 'string' || b.applicationNumber.length > 20) { send(200, { id: 'x', code: '99' }); return; }
      send(200, { id: 'abc', code: '00' }); // note: any action value is accepted
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seenAuth,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

describe('API runs and the mock-versus-live comparison', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let tpid: string;
  let apiId: string;
  let csId: string;
  let live: Awaited<ReturnType<typeof startLiveApi>>;
  const t = () => `/api/projects/${pid}/tests/${tpid}`;

  before(async () => {
    live = await startLiveApi();
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@runs.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@runs.test', password: 'adminpassword1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'Runs' }, cookie })).body as { project: { id: string } }).project.id;
    tpid = ((await fetchJson(baseUrl, `/api/projects/${pid}/tests`, { body: { name: 'T', appUrl: 'https://app.example' }, cookie })).body as { testProject: { id: string } }).testProject.id;
    const imp = await fetchJson(baseUrl, `/api/projects/${pid}/sim/import`, { body: { kind: 'xlsx', contentBase64: await workbookBase64(), paths: { UpdateFlash: '/flash/update' } }, cookie });
    apiId = (imp.body as { created: Array<{ id: string }> }).created[0].id;
    await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis/${apiId}/versions/1/approve`, { body: {}, cookie });
    const gen = await fetchJson(baseUrl, `${t()}/case-sets/from-api`, { body: { source: { kind: 'sim', apiIds: [apiId] } }, cookie });
    csId = (gen.body as { caseSet: { id: string } }).caseSet.id;
  });

  after(async () => { await cleanup(); await live.close(); });

  test('the target settings are validated and saved', async () => {
    assert.equal((await fetchJson(baseUrl, `${t()}/api-target`, { method: 'PUT', body: { errorStyle: { kind: 'code', field: 'bad field', successValue: '00' } }, cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, `${t()}/api-target`, { method: 'PUT', body: { apiIds: ['nope'] }, cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, `${t()}/api-target`, { method: 'PUT', body: { liveHeaders: { 'bad name': 'x' } }, cookie })).status, 400);
    // a credential typed in as plain text is refused: it has to come from the vault
    const plain = await fetchJson(baseUrl, `${t()}/api-target`, { method: 'PUT', body: { liveHeaders: { Authorization: 'Bearer live-secret' } }, cookie });
    assert.equal(plain.status, 400);
    assert.match(String((plain.body as { error: string }).error), /Vault/);
    const vault = await fetchJson(baseUrl, `${t()}/vault`, { body: { name: 'live-token', kind: 'secret', value: 'Bearer live-secret' }, cookie });
    assert.equal(vault.status, 201, JSON.stringify(vault.body));
    const ok = await fetchJson(baseUrl, `${t()}/api-target`, {
      method: 'PUT', cookie,
      body: { apiIds: [apiId], target: 'simulation', errorStyle: { kind: 'code', field: 'code', successValue: '00' }, liveHeaders: { Authorization: '{{vault.live-token.value}}' } },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const got = (await fetchJson(baseUrl, `${t()}/api-target`, { cookie })).body as { target: { errorStyle: { kind: string }; liveHeaders: Record<string, string> } };
    assert.equal(got.target.errorStyle.kind, 'code');
    assert.equal(got.target.liveHeaders.Authorization, '{{vault.live-token.value}}');
  });

  test('against the simulation every generated case passes, and the sheet is updated', async () => {
    const r = await fetchJson(baseUrl, `${t()}/case-sets/${csId}/api-runs`, { body: {}, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { target: string; summary: { total: number; pass: number; fail: number; skipped: number }; results: Array<{ outcome: string; reason: string; scenario: string }> };
    assert.equal(b.target, 'simulation');
    assert.equal(b.summary.fail, 0, JSON.stringify(b.results.filter((x) => x.outcome === 'fail')));
    assert.equal(b.summary.pass + b.summary.skipped, b.summary.total);
    assert.ok(b.summary.pass >= 8);
    const sheet = (await fetchJson(baseUrl, `${t()}/case-sets/${csId}`, { cookie })).body as { cases: Array<{ status: string; remarks: string; scenario: string }> };
    assert.equal(sheet.cases[0].status, 'Pass');
    assert.match(sheet.cases[0].remarks, /^Run \[Simulation\] Pass/);
  });

  test('a rule that breaks the specification makes the case fail with a reason', async () => {
    await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis/${apiId}/rules/bad`, {
      method: 'PUT', cookie,
      body: { operationId: 'updateFlash', name: 'bad shape', response: { status: 200, body: { id: 5 } } },
    });
    const r = await fetchJson(baseUrl, `${t()}/case-sets/${csId}/api-runs`, { body: { target: 'simulation' }, cookie });
    const b = r.body as { summary: { fail: number }; results: Array<{ outcome: string; reason: string }> };
    assert.ok(b.summary.fail >= 1);
    assert.ok(b.results.some((x) => x.outcome === 'fail' && /does not match the specification/.test(x.reason)));
    await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis/${apiId}/rules/bad`, { method: 'DELETE', cookie });
  });

  test('live: refuses to run without an address, then runs against the stand-in API with the live credential', async () => {
    const none = await fetchJson(baseUrl, `${t()}/case-sets/${csId}/api-runs`, { body: { target: 'live' }, cookie });
    assert.equal((none.body as { summary: { pass: number; skipped: number; total: number } }).summary.skipped, (none.body as { summary: { total: number } }).summary.total);

    await getSimulationRepository().updateApi(pid, apiId, { live_base_url: live.url });
    const r = await fetchJson(baseUrl, `${t()}/case-sets/${csId}/api-runs`, { body: { target: 'live' }, cookie });
    const b = r.body as { summary: { pass: number; fail: number }; results: Array<{ outcome: string; scenario: string; reason: string }> };
    assert.ok(b.summary.pass >= 6, JSON.stringify(b.results.filter((x) => x.outcome !== 'pass')));
    // The portal's own placeholder token was replaced by the live credential; the no-token case sent none.
    assert.ok(live.seenAuth.includes('Bearer live-secret'));
    assert.ok(!live.seenAuth.includes('Bearer test-token'));
    const failures = b.results.filter((x) => x.outcome === 'fail');
    assert.ok(failures.every((f) => /not allowed/.test(f.scenario)), JSON.stringify(failures));
  });

  test('compare: the stand-in API that forgets to check allowed values is a contract mismatch', async () => {
    const r = await fetchJson(baseUrl, `${t()}/case-sets/${csId}/api-compare`, { body: {}, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { summary: { total: number; match: number; mismatch: number; bothFail: number }; rows: Array<{ verdict: string; scenario: string; live: { reason: string } }> };
    assert.equal(b.summary.mismatch, 1);
    const mismatch = b.rows.find((x) => x.verdict === 'mismatch')!;
    assert.match(mismatch.scenario, /not allowed/);
    assert.match(mismatch.live.reason, /accepted a request that should be rejected/);
    assert.ok(b.summary.match >= 6);
    const sheet = (await fetchJson(baseUrl, `${t()}/case-sets/${csId}`, { cookie })).body as { cases: Array<{ status: string; remarks: string; scenario: string }> };
    const row = sheet.cases.find((c) => /not allowed/.test(c.scenario))!;
    assert.equal(row.status, 'Fail');
    assert.match(row.remarks, /^Run \[Compare\] Simulation: pass; Live: fail/);
  });

  test('a person outside the project cannot run or change the target', async () => {
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: 'o@runs.test', name: 'O', password: 'outsiderpass1', isAdmin: false }, cookie });
    const other = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'o@runs.test', password: 'outsiderpass1' } })).cookie ?? '';
    assert.equal((await fetchJson(baseUrl, `${t()}/case-sets/${csId}/api-runs`, { body: {}, cookie: other })).status, 404);
    assert.equal((await fetchJson(baseUrl, `${t()}/api-target`, { method: 'PUT', body: {}, cookie: other })).status, 404);
  });
});
