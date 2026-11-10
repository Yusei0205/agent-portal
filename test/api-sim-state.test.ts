/**
 * Stateful mocks, the call log, and the stored (encrypted) login for the live API.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { applyToSnapshot, fill, requestView, runStore, storeProblem } from '../server/api-sim/rule-store.ts';
import { redact } from '../server/api-sim/call-log.ts';
import { handleMockRequest } from '../server/api-sim/mock-engine.ts';
import { _allowPrivateAddressesForTests } from '../server/api-sim/call.ts';
import { getSimulationRepository } from '../server/repositories/simulation.ts';
import { McpHttpClient } from '../server/agent/runner-mcp.ts';
import type { ApiSpec, MockRule, Operation, RuleStore } from '../server/api-sim/types.ts';

const view = (over: Partial<{ method: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; params: Record<string, string> }> = {}) =>
  requestView({ method: over.method ?? 'POST', path: '/x', query: over.query, headers: over.headers, body: over.body }, over.params ?? {});

describe('the store rules', () => {
  const store = (s: Partial<RuleStore> & Pick<RuleStore, 'action'>): RuleStore => ({ collection: 'apps', ...s });

  test('save keeps the record under the key from the request, and says whether it was new', () => {
    const v = view({ body: { Application: { ApplicationNo: 'A1', Status: 'New' } } });
    const r = runStore(store({ action: 'save', key: 'body.Application.ApplicationNo', from: 'body.Application' }), { status: 201, body: { Application: '{{record}}', key: '{{key}}' } }, v, {});
    assert.equal(r.status, 201);
    assert.deepEqual(r.changes, [{ collection: 'apps', key: 'A1', record: { ApplicationNo: 'A1', Status: 'New' } }]);
    assert.deepEqual(r.body, { Application: { ApplicationNo: 'A1', Status: 'New' }, key: 'A1' });
    assert.equal(r.note, 'created');
    assert.equal(runStore(store({ action: 'save', key: 'body.Application.ApplicationNo', from: 'body.Application' }), undefined, v, { apps: { A1: {} } }).note, 'updated');
  });

  test('save with no key in the request makes one; nothing to save is a 400', () => {
    const r = runStore(store({ action: 'save' }), undefined, view({ body: { a: 1 } }), {});
    assert.equal(r.changes.length, 1);
    assert.ok(r.changes[0].key.length >= 4);
    assert.equal(runStore(store({ action: 'save' }), undefined, view({ body: 'text' }), {}).status, 400);
    assert.equal(runStore(store({ action: 'save', from: 'body.nope' }), undefined, view({ body: {} }), {}).status, 400);
  });

  test('find answers with the record, or with the configured not-found answer', () => {
    const data = { apps: { A1: { ApplicationNo: 'A1', Title: 'T' } } };
    const found = runStore(store({ action: 'find', key: 'query.ApplicationNo' }), { status: 200, body: { StatusCode: 200, Application: '{{record}}', title: '{{record.Title}}' } }, view({ query: { ApplicationNo: 'A1' } }), data);
    assert.deepEqual(found.body, { StatusCode: 200, Application: { ApplicationNo: 'A1', Title: 'T' }, title: 'T' });
    const miss = runStore(store({ action: 'find', key: 'query.ApplicationNo', notFound: { status: 404, body: { StatusCode: 404, Message: 'No {{request.query.ApplicationNo}}' } } }), undefined, view({ query: { ApplicationNo: 'ZZ' } }), data);
    assert.equal(miss.status, 404);
    assert.deepEqual(miss.body, { StatusCode: 404, Message: 'No ZZ' });
    assert.equal(runStore(store({ action: 'find', key: 'query.ApplicationNo' }), undefined, view({ query: {} }), data).status, 404); // no key at all
  });

  test('remove deletes and reports; a missing one is not found; list answers with every record', () => {
    const data = { apps: { A1: { n: 1 }, A2: { n: 2 } } };
    const rm = runStore(store({ action: 'remove', key: 'path.id' }), undefined, view({ params: { id: 'A1' } }), data);
    assert.deepEqual(rm.changes, [{ collection: 'apps', key: 'A1', record: null }]);
    assert.equal(runStore(store({ action: 'remove', key: 'path.id' }), undefined, view({ params: { id: 'nope' } }), data).status, 404);
    const list = runStore(store({ action: 'list' }), { status: 200, body: { items: '{{records}}' } }, view(), data);
    assert.deepEqual(list.body, { items: [{ n: 1 }, { n: 2 }] });
    assert.deepEqual(runStore(store({ action: 'list' }), undefined, view(), {}).body, []);
  });

  test('tokens: whole values keep their type, embedded ones become text, unknown ones are left alone', () => {
    const ctx = { view: view({ body: { n: 5, o: { a: 'x' } } }), record: { id: 7 }, key: 'K' };
    assert.deepEqual(fill({ a: '{{request.body.n}}', b: 'n={{request.body.n}}', c: '{{request.body.o}}', d: '{{nope.x}}', e: ['{{key}}'] }, ctx), { a: 5, b: 'n=5', c: { a: 'x' }, d: '{{nope.x}}', e: ['K'] });
  });

  test('the settings are checked', () => {
    assert.equal(storeProblem({ action: 'find', collection: 'apps', key: 'query.id' }), null);
    assert.equal(storeProblem({ action: 'save', collection: 'apps' }), null);
    assert.equal(storeProblem({ action: 'list', collection: 'apps' }), null);
    assert.match(storeProblem({ action: 'drop', collection: 'apps' })!, /action/);
    assert.match(storeProblem({ action: 'find', collection: 'bad name!', key: 'query.id' })!, /collection/);
    assert.match(storeProblem({ action: 'find', collection: 'apps' })!, /key/);
    assert.match(storeProblem({ action: 'find', collection: 'apps', key: 'cookie.x' })!, /key/);
    assert.match(storeProblem({ action: 'find', collection: 'apps', key: 'query.id', notFound: { status: 9 } })!, /notFound/);
  });

  test('changes can be applied to a snapshot, so one case of a test run sees what an earlier one saved', () => {
    const data: Record<string, Record<string, unknown>> = {};
    applyToSnapshot(data, [{ collection: 'a', key: '1', record: { x: 1 } }, { collection: 'a', key: '2', record: { x: 2 } }]);
    applyToSnapshot(data, [{ collection: 'a', key: '1', record: null }]);
    assert.deepEqual(data, { a: { '2': { x: 2 } } });
  });
});

// ── An RPC-style API like the one in the Word document ────────────────────────

const OK = (props: Record<string, unknown> = {}): Operation['responses'] => ({ '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { StatusCode: { type: 'integer' }, Message: { type: 'string' }, ...props } } } } } } as Operation['responses']);
const APPS: ApiSpec = {
  openapi: '3.0.3', info: { title: 'Applications', version: '1' },
  paths: {
    '/application/update_application': { put: { operationId: 'updateApplication', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { Application: { type: 'object', properties: { ApplicationNo: { type: 'string' }, Status: { type: 'string' } } } } } } } }, responses: OK() } },
    '/application/get_application': { get: { operationId: 'getApplication', parameters: [{ name: 'ApplicationNo', in: 'query', required: true, schema: { type: 'string' } }], responses: OK({ Application: { type: 'object' } }) } },
    '/application/remove/{no}': { delete: { operationId: 'removeApplication', responses: OK() } },
  },
};

const rule = (over: Partial<MockRule>): MockRule => ({ id: 'r', name: 'r', operationId: 'x', ...over });

describe('the engine with remembered records', () => {
  const rules: MockRule[] = [
    rule({ id: 'save', operationId: 'updateApplication', store: { action: 'save', collection: 'apps', key: 'body.Application.ApplicationNo', from: 'body.Application' }, response: { status: 200, body: { StatusCode: 200, Message: 'saved' } } }),
    rule({ id: 'get', operationId: 'getApplication', store: { action: 'find', collection: 'apps', key: 'query.ApplicationNo', notFound: { status: 404, body: { StatusCode: 404, Message: 'Record not found' } } }, response: { status: 200, body: { StatusCode: 200, Application: '{{record}}' } } }),
    rule({ id: 'rm', operationId: 'removeApplication', store: { action: 'remove', collection: 'apps', key: 'path.no' } }),
  ];

  test('save, find, update, remove, one call at a time on a snapshot', () => {
    const data: Record<string, Record<string, unknown>> = {};
    const call = (method: string, path: string, over: { query?: Record<string, string>; body?: unknown } = {}) => {
      const r = handleMockRequest(APPS, rules, { method, path, ...over }, { data });
      if (r.changes) applyToSnapshot(data, r.changes);
      return r;
    };
    assert.equal(call('GET', '/application/get_application', { query: { ApplicationNo: 'A1' } }).status, 404);
    assert.equal(call('PUT', '/application/update_application', { body: { Application: { ApplicationNo: 'A1', Status: 'New' } } }).status, 200);
    assert.deepEqual(call('GET', '/application/get_application', { query: { ApplicationNo: 'A1' } }).body, { StatusCode: 200, Application: { ApplicationNo: 'A1', Status: 'New' } });
    call('PUT', '/application/update_application', { body: { Application: { ApplicationNo: 'A1', Status: 'Processed' } } });
    assert.equal(((call('GET', '/application/get_application', { query: { ApplicationNo: 'A1' } }).body as { Application: { Status: string } }).Application.Status), 'Processed');
    assert.equal(call('DELETE', '/application/remove/A1').status, 200); // the key comes from the {no} in the path
    assert.equal(call('GET', '/application/get_application', { query: { ApplicationNo: 'A1' } }).status, 404);
  });

  test('without a snapshot nothing is remembered and a find is a not-found, not an error', () => {
    assert.equal(handleMockRequest(APPS, rules, { method: 'GET', path: '/application/get_application', query: { ApplicationNo: 'A1' } }).status, 404);
  });
});

// ── End to end ────────────────────────────────────────────────────────────────

function startLiveApi(): Promise<{ url: string; close: () => Promise<void>; seen: Array<{ auth: string; extra: string }> }> {
  const seen: Array<{ auth: string; extra: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ auth: String(req.headers.authorization ?? ''), extra: String(req.headers['x-extra'] ?? '') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ StatusCode: 200, Message: 'from the real API' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

describe('stateful mocks, the call log and the live login, end to end', () => {
  let baseUrl: string;
  let cookie: string;
  let outsider: string;
  let token: string;
  let pid: string;
  let apiId: string;
  let live: Awaited<ReturnType<typeof startLiveApi>>;
  const m = (p: string) => `/api/projects/${pid}/sim/apis/${apiId}${p}`;
  const call = (method: string, rest: string, body?: unknown, headers: Record<string, string> = {}) => fetchJson(baseUrl, `/api/sim/${pid}/${apiId}/call${rest}`, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } });

  before(async () => {
    live = await startLiveApi();
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@state.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@state.test', password: 'adminpassword1' } })).cookie ?? '';
    await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email: 'o@state.test', name: 'O', password: 'outsiderpass1', isAdmin: false }, cookie });
    outsider = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'o@state.test', password: 'outsiderpass1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'S' }, cookie })).body as { project: { id: string } }).project.id;
    token = ((await fetchJson(baseUrl, '/api/api-tokens', { body: { name: 't', scope: 'write' }, cookie })).body as { token: string }).token;
    const imp = await fetchJson(baseUrl, `/api/projects/${pid}/sim/import`, { body: { kind: 'openapi', spec: APPS }, cookie });
    apiId = (imp.body as { created: Array<{ id: string }> }).created[0].id;
    await fetchJson(baseUrl, m('/versions/1/approve'), { body: {}, cookie });
    for (const [id, body] of [['save', rules()[0]], ['get', rules()[1]], ['rm', rules()[2]]] as const) {
      const { id: _i, ...payload } = body;
      const r = await fetchJson(baseUrl, m(`/rules/${id}`), { method: 'PUT', body: payload, cookie });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  });
  after(async () => { await cleanup(); await live.close(); });

  function rules(): MockRule[] {
    return [
      rule({ id: 'save', name: 'save', operationId: 'updateApplication', store: { action: 'save', collection: 'apps', key: 'body.Application.ApplicationNo', from: 'body.Application' }, response: { status: 200, body: { StatusCode: 200, Message: 'saved' } } }),
      rule({ id: 'get', name: 'get', operationId: 'getApplication', store: { action: 'find', collection: 'apps', key: 'query.ApplicationNo', notFound: { status: 404, body: { StatusCode: 404, Message: 'Record not found' } } }, response: { status: 200, body: { StatusCode: 200, Application: '{{record}}' } } }),
      rule({ id: 'rm', name: 'remove', operationId: 'removeApplication', store: { action: 'remove', collection: 'apps', key: 'path.no' } }),
    ];
  }

  test('a rule with bad store settings is refused', async () => {
    const r = await fetchJson(baseUrl, m('/rules/bad'), { method: 'PUT', body: { operationId: 'getApplication', name: 'x', store: { action: 'find', collection: 'a b' } }, cookie });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error: string }).error), /collection/);
  });

  test('create, find, update and remove through the hosted address', async () => {
    assert.equal((await call('GET', '/application/get_application?ApplicationNo=A1')).status, 404);
    assert.equal((await call('PUT', '/application/update_application', { Application: { ApplicationNo: 'A1', Status: 'New' } })).status, 200);
    const got = await call('GET', '/application/get_application?ApplicationNo=A1');
    assert.deepEqual(got.body, { StatusCode: 200, Application: { ApplicationNo: 'A1', Status: 'New' } });
    await call('PUT', '/application/update_application', { Application: { ApplicationNo: 'A1', Status: 'Processed' } });
    assert.equal(((await call('GET', '/application/get_application?ApplicationNo=A1')).body as { Application: { Status: string } }).Application.Status, 'Processed');
    assert.equal((await call('DELETE', '/application/remove/A1')).status, 200);
    assert.equal((await call('GET', '/application/get_application?ApplicationNo=A1')).status, 404);
  });

  test('Try it reads the remembered records but never changes them', async () => {
    const tryIt = (method: string, path: string, body?: unknown) => fetchJson(baseUrl, m('/try'), { body: { method, path, body }, cookie });
    await tryIt('PUT', '/application/update_application', { Application: { ApplicationNo: 'T1', Status: 'x' } });
    assert.equal((await call('GET', '/application/get_application?ApplicationNo=T1')).status, 404);
  });

  test('records can be seeded, listed, found by a rule, and cleared; a bad seed is refused', async () => {
    assert.equal((await fetchJson(baseUrl, m('/data/apps'), { method: 'PUT', body: { keyField: 'ApplicationNo', records: [{ ApplicationNo: 'S1', Title: 'Seed one' }, { ApplicationNo: 'S2', Title: 'Seed two' }] }, cookie })).status, 200);
    assert.deepEqual(((await fetchJson(baseUrl, m('/data'), { cookie })).body as { collections: unknown[] }).collections, [{ name: 'apps', count: 2 }]);
    const one = (await fetchJson(baseUrl, m('/data/apps'), { cookie })).body as { total: number; records: Array<{ key: string }> };
    assert.deepEqual([one.total, one.records.map((r) => r.key)], [2, ['S1', 'S2']]);
    assert.equal(((await call('GET', '/application/get_application?ApplicationNo=S2')).body as { Application: { Title: string } }).Application.Title, 'Seed two');

    const put = (body: unknown) => fetchJson(baseUrl, m('/data/apps'), { method: 'PUT', body, cookie });
    assert.equal((await put({ keyField: 'ApplicationNo', records: [{ a: 1 }] })).status, 400);
    assert.equal((await put({ keyField: 'ApplicationNo', records: [{ ApplicationNo: 'D' }, { ApplicationNo: 'D' }] })).status, 400);
    assert.equal((await put({ records: ['text'] })).status, 400);
    assert.equal((await fetchJson(baseUrl, m('/data/bad name'), { method: 'PUT', body: { records: [] }, cookie })).status, 400);
    assert.equal(((await fetchJson(baseUrl, m('/data'), { cookie })).body as { collections: Array<{ count: number }> }).collections[0].count, 2); // nothing changed

    assert.equal((await fetchJson(baseUrl, m('/data/apps'), { method: 'DELETE', cookie })).status, 200);
    assert.deepEqual(((await fetchJson(baseUrl, m('/data'), { cookie })).body as { collections: unknown[] }).collections, []);
  });

  test('a test run on a stateful API remembers within the run only, and keeps nothing', async () => {
    const tpid = ((await fetchJson(baseUrl, `/api/projects/${pid}/tests`, { body: { name: 'T', appUrl: 'https://app.example' }, cookie })).body as { testProject: { id: string } }).testProject.id;
    const gen = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/from-api`, { body: { source: { kind: 'sim', apiIds: [apiId] } }, cookie });
    const cs = (gen.body as { caseSet: { id: string } }).caseSet.id;
    const run = await fetchJson(baseUrl, `/api/projects/${pid}/tests/${tpid}/case-sets/${cs}/api-runs`, { body: { target: 'simulation' }, cookie });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.deepEqual(((await fetchJson(baseUrl, m('/data'), { cookie })).body as { collections: unknown[] }).collections, []);
  });

  test('every call is in the log, with how it was answered and no bodies by default', async () => {
    await fetchJson(baseUrl, m('/calls'), { method: 'DELETE', cookie });
    await call('PUT', '/application/update_application', { Application: { ApplicationNo: 'L1', Status: 'x' } });
    await call('GET', '/application/get_application?ApplicationNo=L1&secretish=1');
    await call('GET', '/application/get_application'); // missing required query: 400
    const log = (await fetchJson(baseUrl, m('/calls'), { cookie })).body as { logBodies: boolean; calls: Array<{ via: string; method: string; path: string; status: number; mode: string; source: string; ruleId: string | null; request: string | null; response: string | null; ms: number }> };
    assert.equal(log.logBodies, false);
    assert.deepEqual(log.calls.map((c) => `${c.method} ${c.path} ${c.status} ${c.source}`), [
      'GET /application/get_application 400 invalid',
      'GET /application/get_application 200 rule',
      'PUT /application/update_application 200 rule',
    ]);
    assert.ok(log.calls.every((c) => c.via === 'rest' && c.mode === 'mock' && c.request === null && c.response === null && c.ms >= 0));
    assert.equal(log.calls[1].ruleId, 'get');
    assert.equal(JSON.stringify(log).includes('secretish'), false); // the query string is not kept
  });

  test('with bodies on, they are kept cut short and with anything secret-looking hidden; headers never', async () => {
    assert.equal((await fetchJson(baseUrl, m(''), { method: 'PUT', body: { logBodies: true }, cookie })).status, 200);
    await call('PUT', '/application/update_application', { Application: { ApplicationNo: 'B1', Status: 'x', password: 'hunter2', apiToken: 'tok-123' } }, { 'X-Sim-Authorization': 'Bearer client-secret' });
    const top = ((await fetchJson(baseUrl, m('/calls?limit=1'), { cookie })).body as { calls: Array<{ request: string; response: string }> }).calls[0];
    assert.match(top.request, /"ApplicationNo":"B1"/);
    assert.match(top.request, /"password":"\*\*\*"/);
    assert.match(top.request, /"apiToken":"\*\*\*"/);
    assert.equal(/hunter2|tok-123|client-secret/.test(JSON.stringify(top)), false);
    assert.match(top.response, /saved/);
    assert.ok(((redact({ a: 'x'.repeat(400) }) as { a: string }).a.length) <= 301, 'a long value was not cut short');
    assert.deepEqual(redact({ nested: [{ client_secret: 's', ok: 1 }] }), { nested: [{ client_secret: '***', ok: 1 }] });
  });

  test('the log keeps only the newest few hundred, can be cleared, and belongs to the project', async () => {
    const repo = getSimulationRepository();
    await repo.clearCalls(apiId);
    for (let i = 0; i < 320; i++) {
      await repo.appendCall({ id: `c${String(i).padStart(4, '0')}`, api_id: apiId, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), via: 'rest', method: 'GET', path: '/x', status: 200, mode: 'mock', source: 'generated', rule_id: null, warnings: 0, ms: 1, request_text: null, response_text: null });
    }
    const all = await repo.listCalls(apiId, 1000);
    assert.equal(all.length, 300);
    assert.equal(all[0].id, 'c0319');
    assert.equal((await fetchJson(baseUrl, m('/calls'), { cookie: outsider })).status, 404);
    assert.equal((await fetchJson(baseUrl, m('/calls'), { method: 'DELETE', cookie: outsider })).status, 404);
    assert.equal((await fetchJson(baseUrl, m('/calls'), { method: 'DELETE', cookie })).status, 200);
    assert.deepEqual(await repo.listCalls(apiId, 10), []);
  });

  test('calls made through the MCP tools are logged too, as MCP', async () => {
    const mcp = new McpHttpClient(`${baseUrl}/api/sim-mcp/${pid}`, { Authorization: `Bearer ${token}` });
    const out = await mcp.callTool('getApplication', { query: { ApplicationNo: 'B1' } }) as { content: Array<{ text: string }> };
    assert.match(out.content[0].text, /^HTTP 200/);
    const top = ((await fetchJson(baseUrl, m('/calls?limit=1'), { cookie })).body as { calls: Array<{ via: string; path: string }> }).calls[0];
    assert.deepEqual([top.via, top.path], ['mcp', '/application/get_application']);
  });

  test('the login for the live API is stored encrypted, shown by name only, and used when the caller sends none', async () => {
    const put = (body: unknown) => fetchJson(baseUrl, m(''), { method: 'PUT', body, cookie });
    assert.equal((await put({ liveHeaders: [{ name: 'bad name', value: 'x' }] })).status, 400);
    assert.equal((await put({ liveHeaders: [{ name: 'Host', value: 'x' }] })).status, 400);
    assert.equal((await put({ liveHeaders: [{ name: 'X-A', value: 'line\nbreak' }] })).status, 400);
    assert.equal((await put({ liveHeaders: Array.from({ length: 6 }, (_, i) => ({ name: `X-${i}`, value: 'v' })) })).status, 400);
    assert.equal((await put({ liveHeaders: [{ name: 'X-Empty', value: '' }] })).status, 400); // nothing stored under that name yet

    const ok = await put({ liveHeaders: [{ name: 'Authorization', value: 'Bearer live-s3cret' }, { name: 'X-Extra', value: 'one' }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((ok.body as { api: { liveHeaderNames: string[] } }).api.liveHeaderNames, ['Authorization', 'X-Extra']);
    for (const url of [m(''), `/api/projects/${pid}/sim/apis`]) assert.equal(JSON.stringify((await fetchJson(baseUrl, url, { cookie })).body).includes('live-s3cret'), false);
    const stored = (await getSimulationRepository().getApi(pid, apiId))!.live_headers_enc!;
    assert.ok(stored && !stored.includes('live-s3cret') && !stored.includes('Authorization'));

    await getSimulationRepository().updateApi(pid, apiId, { mode: 'live', live_base_url: live.url });
    // the stand-in live API is on 127.0.0.1, which the hosted address refuses unless a test allows it
    assert.equal((await call('GET', '/application/get_application?ApplicationNo=Z')).status, 502);
    _allowPrivateAddressesForTests(true);
    assert.equal((await call('GET', '/application/get_application?ApplicationNo=Z')).status, 200);
    assert.deepEqual(live.seen.at(-1), { auth: 'Bearer live-s3cret', extra: 'one' });
    // the caller's own login wins for the header it names; the other stored header is still sent
    await call('GET', '/application/get_application?ApplicationNo=Z', undefined, { 'X-Sim-Authorization': 'Bearer caller-own' });
    assert.deepEqual(live.seen.at(-1), { auth: 'Bearer caller-own', extra: 'one' });
    assert.ok(live.seen.every((s) => !s.auth.includes(token)), 'the portal token reached the live API');

    // an empty value keeps what is stored; a name left out is removed
    await put({ liveHeaders: [{ name: 'Authorization', value: '' }] });
    assert.deepEqual(((await fetchJson(baseUrl, m(''), { cookie })).body as { api: { liveHeaderNames: string[] } }).api.liveHeaderNames, ['Authorization']);
    await call('GET', '/application/get_application?ApplicationNo=Z');
    assert.deepEqual(live.seen.at(-1), { auth: 'Bearer live-s3cret', extra: '' });
    await put({ liveHeaders: [] });
    assert.deepEqual(((await fetchJson(baseUrl, m(''), { cookie })).body as { api: { liveHeaderNames: string[] } }).api.liveHeaderNames, []);
    _allowPrivateAddressesForTests(false);
    await getSimulationRepository().updateApi(pid, apiId, { mode: 'mock' });
  });

  test('deleting the API removes its remembered records and its call log', async () => {
    const repo = getSimulationRepository();
    await repo.applyChanges(apiId, [{ collection: 'k', key: '1', record: { a: 1 } }]);
    await repo.appendCall({ id: 'z1', api_id: apiId, at: new Date().toISOString(), via: 'rest', method: 'GET', path: '/x', status: 200, mode: 'mock', source: 'generated', rule_id: null, warnings: 0, ms: 1, request_text: null, response_text: null });
    assert.equal((await fetchJson(baseUrl, m(''), { method: 'DELETE', cookie })).status, 200);
    assert.deepEqual(await repo.loadRecords(apiId), {});
    assert.deepEqual(await repo.listCalls(apiId, 10), []);
  });
});
