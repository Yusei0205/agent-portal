import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { diffSpecs } from '../server/api-sim/spec-diff.ts';
import { inferSchema, looksLikePostman, postmanToSpecs } from '../server/api-sim/postman.ts';
import { handleMockRequest } from '../server/api-sim/mock-engine.ts';
import type { ApiSpec } from '../server/api-sim/types.ts';

const base = (over: Record<string, unknown> = {}): ApiSpec => ({
  openapi: '3.0.3', info: { title: 'T', version: '1' },
  paths: {
    '/a': {
      post: {
        operationId: 'doA',
        security: [{ b: [] }],
        parameters: [{ name: 'X-Id', in: 'header', required: true }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['n'], properties: { n: { type: 'string', maxLength: 10 }, k: { type: 'string', enum: ['A', 'B'] } } } } } },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } },
        ...over,
      },
    },
  },
});

describe('spec diff', () => {
  test('identical specs have no changes', () => {
    assert.deepEqual(diffSpecs(base(), base()), { changes: [], count: 0 });
  });

  test('reports a moved path, a new field, a type, requiredness, allowed values, length and the login need', () => {
    const after = base();
    const op = after.paths['/a'].post!;
    const schema = op.requestBody!.content['application/json'].schema;
    schema.properties!.extra = { type: 'integer' };
    schema.properties!.n = { type: 'number', maxLength: 20 };
    schema.required = ['n', 'k'];
    schema.properties!.k = { type: 'string', enum: ['A', 'B', 'C'] };
    delete op.security;
    op.parameters!.push({ name: 'X-New', in: 'header', required: true });
    after.paths['/b'] = { post: op };
    delete after.paths['/a'];
    const d = diffSpecs(base(), after);
    assert.equal(d.changes.length, 1);
    assert.equal(d.changes[0].kind, 'changed');
    const text = d.changes[0].details.join('\n');
    assert.match(text, /URL path changed from \/a to \/b/);
    assert.match(text, /field "extra" added \(integer\)/);
    assert.match(text, /"n" changed type from string to number/);
    assert.match(text, /"k" is now required/);
    assert.match(text, /allowed values of "k" changed \(A,B → A,B,C\)/);
    assert.match(text, /length limit of "n" changed \(10 → 20\)/);
    assert.match(text, /no longer needs a login token/);
    assert.match(text, /header "X-New" added \(required\)/);
    assert.equal(d.count, d.changes[0].details.length);
  });

  test('added and removed operations', () => {
    const after = base();
    after.paths['/c'] = { get: { operationId: 'doC', responses: {} } };
    const before = base();
    before.paths['/gone'] = { get: { operationId: 'gone', responses: {} } };
    const d = diffSpecs(before, after);
    assert.deepEqual(d.changes.map((c) => `${c.kind}:${c.operationId}`).sort(), ['added:doC', 'removed:gone']);
  });

  test('response field changes are reported separately from the request', () => {
    const after = base();
    after.paths['/a'].post!.responses['200'].content!['application/json'].schema.properties!.code = { type: 'string' };
    const d = diffSpecs(base(), after);
    assert.match(d.changes[0].details[0], /^Response: field "code" added/);
  });
});

const COLLECTION = {
  info: { name: 'Pets API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer' },
  item: [
    {
      name: 'Pets',
      item: [
        { name: 'List pets', request: { method: 'GET', url: { raw: '{{baseUrl}}/pets?limit=10', path: ['pets'], query: [{ key: 'limit', value: '10' }] }, header: [{ key: 'X-Trace', value: '1' }] }, response: [{ code: 200, name: 'ok', body: '{"items":[{"id":1,"name":"Rex"}],"total":1}' }] },
        { name: 'Create pet', request: { method: 'POST', url: '{{baseUrl}}/pets', header: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: '{"name":"Rex","age":3}' } }, response: [{ code: 201, body: '{"id":1}' }] },
        { name: 'Get pet', request: { method: 'GET', url: { path: ['pets', ':id'] } } },
      ],
    },
    { name: 'Health', request: { method: 'GET', url: '{{baseUrl}}/health' } },
  ],
};

describe('Postman import', () => {
  test('recognises a collection', () => {
    assert.equal(looksLikePostman(COLLECTION), true);
    assert.equal(looksLikePostman({ openapi: '3.0.0' }), false);
    assert.equal(looksLikePostman(null), false);
  });

  test('a folder becomes one API; loose requests become one named after the collection', () => {
    const { drafts, errors } = postmanToSpecs(COLLECTION);
    assert.deepEqual(errors, []);
    assert.deepEqual(drafts.map((d) => d.name), ['Pets API', 'Pets']);
    const pets = drafts[1].spec;
    assert.deepEqual(Object.keys(pets.paths).sort(), ['/pets', '/pets/{id}']);
    assert.ok(pets.paths['/pets'].get && pets.paths['/pets'].post);
    assert.ok(pets.components?.securitySchemes);
  });

  test('types are inferred from the examples; nothing is marked required; each inference is flagged', () => {
    const create = postmanToSpecs(COLLECTION).drafts[1].spec.paths['/pets'].post!;
    const schema = create.requestBody!.content['application/json'].schema;
    assert.equal(schema.properties!.age.type, 'integer');
    assert.equal(schema.required, undefined);
    assert.ok(create['x-flags']!.some((f) => f.code === 'SCHEMA_INFERRED'));
    const get = postmanToSpecs(COLLECTION).drafts[1].spec.paths['/pets/{id}'].get!;
    assert.ok(get['x-flags']!.some((f) => f.code === 'NO_RESPONSE_EXAMPLE'));
    assert.deepEqual(postmanToSpecs(COLLECTION).drafts[1].spec.paths['/pets'].get!.parameters!.map((p) => `${p.in}:${p.name}`).sort(), ['header:X-Trace', 'query:limit']);
  });

  test('the imported spec answers with the saved example', () => {
    const spec = postmanToSpecs(COLLECTION).drafts[1].spec;
    const r = handleMockRequest(spec, [], { method: 'POST', path: '/pets', headers: { authorization: 'x' }, body: { name: 'Rex', age: 3 } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { id: 1 });
    assert.equal(handleMockRequest(spec, [], { method: 'POST', path: '/pets', headers: { authorization: 'x' }, body: { name: 5 } }).status, 400);
  });

  test('inferSchema handles lists, nulls and depth', () => {
    assert.deepEqual(inferSchema([]), { type: 'array', items: { type: 'string' } });
    assert.equal(inferSchema(null).type, 'string');
    assert.equal(inferSchema({ a: { b: [1.5] } }).properties!.a.properties!.b.items!.type, 'number');
  });

  test('not a collection, or nothing to import', () => {
    assert.match(postmanToSpecs({ foo: 1 }).errors[0], /does not look like/);
    assert.match(postmanToSpecs({ info: { name: 'x' }, item: [] }).errors[0], /no requests/);
  });
});

describe('import and diff routes', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let aid: string;
  const m = (p: string) => `/api/projects/${pid}/sim${p}`;

  before(async () => {
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@diff.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@diff.test', password: 'adminpassword1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'D' }, cookie })).body as { project: { id: string } }).project.id;
  });
  after(cleanup);

  test('a Postman collection imports as drafts, and a bad one is refused', async () => {
    const r = await fetchJson(baseUrl, m('/import'), { body: { kind: 'postman', collection: COLLECTION }, cookie });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const created = (r.body as { created: Array<{ id: string; name: string }> }).created;
    assert.deepEqual(created.map((c) => c.name), ['Pets API', 'Pets']);
    aid = created[1].id;
    assert.equal((await fetchJson(baseUrl, m('/import'), { body: { kind: 'postman', collection: { nope: 1 } }, cookie })).status, 400);
  });

  test('importing a changed collection again makes version 2, and the diff says what changed', async () => {
    const changed = structuredClone(COLLECTION) as typeof COLLECTION;
    (changed.item[0].item![1].request as { body: { raw: string } }).body.raw = '{"name":"Rex","age":3,"color":"brown"}';
    const r = await fetchJson(baseUrl, m('/import'), { body: { kind: 'postman', collection: changed }, cookie });
    const second = (r.body as { created: Array<{ id: string; version: number; isNew: boolean }> }).created[1];
    assert.equal(second.id, aid);
    assert.equal(second.version, 2);
    assert.equal(second.isNew, false);

    const d = await fetchJson(baseUrl, m(`/apis/${aid}/diff`), { cookie });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const body = d.body as { from: number; to: number; count: number; changes: Array<{ label: string; details: string[] }> };
    assert.deepEqual([body.from, body.to], [1, 2]);
    assert.equal(body.count, 1);
    assert.match(body.changes[0].details[0], /field "color" added \(string\)/);

    const same = await fetchJson(baseUrl, m(`/apis/${aid}/diff?from=2&to=2`), { cookie });
    assert.equal((same.body as { count: number }).count, 0);
    assert.equal((await fetchJson(baseUrl, m(`/apis/${aid}/diff?from=9&to=2`), { cookie })).status, 404);
  });
});
