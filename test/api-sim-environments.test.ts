/**
 * Environments of a simulated API (dev, UAT, prod): reading Postman, OpenAPI and .env files, {{variables}}, secrets kept
 * away from the browser, and the active environment becoming the live address and login.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import {
  buildEnvironments, environmentsFromBaseUrls, mergeEnvironments, parseEnvironmentFile, publicEnvironments, readEnvironments,
  recordFields, resolveEnvironment, storeEnvironments, substitute,
} from '../server/api-sim/environments.ts';
import { readLiveHeaders } from '../server/api-sim/live-credentials.ts';
import { getSimulationRepository } from '../server/repositories/simulation.ts';
import { setConfig } from '../server/config.ts';
import { createTestConfig } from './fixtures.ts';

const postmanEnv = (name: string, values: Array<Record<string, unknown>>) => JSON.stringify({ name, values, _postman_variable_scope: 'environment' });

describe('reading files', () => {
  test('a Postman environment: enabled variables only, secrets by type or name, the base URL found by name', () => {
    const r = parseEnvironmentFile('uat.postman_environment.json', postmanEnv('UAT', [
      { key: 'baseUrl', value: 'https://uat.client.example/api', enabled: true },
      { key: 'clientSecret', value: 's3cr3t', enabled: true },
      { key: 'apiToken', value: 'abc', type: 'secret', enabled: true },
      { key: 'old', value: 'x', enabled: false },
      { key: 'region', value: 'sg' },
    ]));
    assert.equal(r.environments.length, 1);
    const e = r.environments[0];
    assert.equal(e.name, 'UAT');
    assert.equal(e.baseUrl, '{{baseUrl}}');
    assert.deepEqual(e.variables.map((v) => [v.key, v.secret]), [['baseUrl', false], ['clientSecret', true], ['apiToken', true], ['region', false]]);
  });

  test('a Postman environment without a name takes it from the file name', () => {
    const r = parseEnvironmentFile('prod.postman_environment.json', JSON.stringify({ values: [{ key: 'host', value: 'https://p.example' }] }));
    assert.equal(r.environments[0].name, 'prod');
    assert.equal(r.environments[0].baseUrl, '{{host}}');
  });

  test('a Postman collection: its variables become one environment', () => {
    const r = parseEnvironmentFile('EPO.postman_collection.json', JSON.stringify({ info: { name: 'EPO' }, item: [], variable: [{ key: 'base_url', value: 'https://ops.example/3.2' }, { key: 'version', value: '3.2' }] }));
    assert.equal(r.environments[0].name, 'EPO');
    assert.equal(r.environments[0].baseUrl, '{{base_url}}');
    assert.equal(parseEnvironmentFile('c.json', JSON.stringify({ info: { name: 'x' }, item: [] })).environments.length, 0);
  });

  test('an OpenAPI file: one environment per server, {variables} become {{variables}} with their defaults', () => {
    const r = parseEnvironmentFile('api.json', JSON.stringify({
      openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {},
      servers: [{ url: 'https://dev.client.example/v1', description: 'Dev' }, { url: 'https://{tenant}.client.example', description: 'Prod', variables: { tenant: { default: 'acme' } } }],
    }));
    assert.deepEqual(r.environments.map((e) => [e.name, e.baseUrl]), [['Dev', 'https://dev.client.example/v1'], ['Prod', 'https://{{tenant}}.client.example']]);
    assert.deepEqual(r.environments[1].variables, [{ key: 'tenant', value: 'acme', secret: false }]);
    assert.equal(resolveEnvironment(r.environments[1]).baseUrl, 'https://acme.client.example');
  });

  test('a .env file: KEY=VALUE lines, quotes and comments handled, the name from the file name', () => {
    const r = parseEnvironmentFile('.env.uat', '# comment\nBASE_URL="https://uat.example"\nexport API_KEY=abc123\n\nEMPTY=\n');
    const e = r.environments[0];
    assert.equal(e.name, 'uat');
    assert.deepEqual(e.variables.map((v) => [v.key, v.value, v.secret]), [['BASE_URL', 'https://uat.example', false], ['API_KEY', 'abc123', true], ['EMPTY', '', false]]);
    assert.equal(e.baseUrl, '{{BASE_URL}}');
    assert.equal(parseEnvironmentFile('prod.env', 'A=1').environments[0].name, 'prod');
  });

  test('a file that is none of these says so', () => {
    const r = parseEnvironmentFile('notes.txt', 'just some words');
    assert.equal(r.environments.length, 0);
    assert.match(r.notes.join(' '), /no KEY=VALUE/);
    assert.match(parseEnvironmentFile('x.json', '{"a":1}').notes.join(' '), /not a Postman/);
  });

  test('labelled addresses from a document become environments with distinct names', () => {
    const envs = environmentsFromBaseUrls([{ label: 'UAT', url: 'https://uat.example/' }, { label: 'UAT', url: 'https://uat2.example' }, { label: 'PROD', url: 'https://p.example' }, { label: 'x', url: 'ftp://nope' }]);
    assert.deepEqual(envs.map((e) => [e.name, e.baseUrl]), [['UAT', 'https://uat.example'], ['UAT 2', 'https://uat2.example'], ['PROD', 'https://p.example']]);
  });
});

describe('variables and the active environment', () => {
  before(() => { setConfig(createTestConfig()); }); // saving encrypts with the portal's key
  test('{{name}} is filled in; an undefined name is reported and left as it is', () => {
    const r = substitute('https://{{host}}/{{ver}}/{{nope}}', [{ key: 'host', value: 'h.example', secret: false }, { key: 'ver', value: 'v2', secret: false }]);
    assert.equal(r.text, 'https://h.example/v2/{{nope}}');
    assert.deepEqual(r.missing, ['nope']);
  });

  test('the base URL is checked: an undefined variable or a non-https address is a problem and is not made live', () => {
    const base = { id: 'a', name: 'dev', headers: [], variables: [] };
    assert.match(resolveEnvironment({ ...base, baseUrl: 'https://{{host}}' }).problem, /\{\{host\}\}/);
    assert.match(resolveEnvironment({ ...base, baseUrl: 'http://plain.example' }).problem, /https/);
    assert.equal(resolveEnvironment({ ...base, baseUrl: 'https://ok.example/' }).problem, '');
    assert.equal(resolveEnvironment({ ...base, baseUrl: 'https://ok.example/' }).baseUrl, 'https://ok.example');
    const fields = recordFields({ active: 'a', environments: [{ ...base, baseUrl: 'http://plain.example' }] });
    assert.equal(fields.live_base_url, undefined);
  });

  test('saving sets the live address and the login headers of the active environment, filled in', () => {
    const env = { id: 'a', name: 'uat', baseUrl: '{{base}}', variables: [{ key: 'base', value: 'https://uat.example', secret: false }, { key: 'tok', value: 'T0K', secret: true }], headers: [{ name: 'Authorization', value: 'Bearer {{tok}}' }] };
    const fields = recordFields({ active: 'a', environments: [env] });
    assert.equal(fields.live_base_url, 'https://uat.example');
    assert.deepEqual(readLiveHeaders(fields.live_headers_enc ?? null), { Authorization: 'Bearer T0K' });
    assert.deepEqual(readEnvironments(fields.environments_enc).environments[0].name, 'uat');
  });

  test('the browser sees no secret values and no header values', () => {
    const state = { active: 'a', environments: [{ id: 'a', name: 'uat', baseUrl: 'https://x.example', variables: [{ key: 'tok', value: 'T0K', secret: true }, { key: 'region', value: 'sg', secret: false }], headers: [{ name: 'Authorization', value: 'Bearer secret' }] }] };
    const shown = JSON.stringify(publicEnvironments(state));
    assert.ok(!shown.includes('T0K') && !shown.includes('Bearer secret'), shown);
    assert.ok(shown.includes('"sg"'));
    assert.ok(!(storeEnvironments(state) ?? '').includes('T0K'), 'stored encrypted');
  });

  test('saving from a form keeps a secret whose value was left empty, and rejects bad input', () => {
    const existing = { active: 'a', environments: [{ id: 'a', name: 'uat', baseUrl: 'https://x.example', variables: [{ key: 'tok', value: 'T0K', secret: true }], headers: [{ name: 'Authorization', value: 'Bearer old' }] }] };
    const ok = buildEnvironments({ active: 'a', environments: [{ id: 'a', name: 'uat', baseUrl: 'https://x.example', variables: [{ key: 'tok', value: '', secret: true }], headers: [{ name: 'Authorization', value: '' }] }] }, existing);
    assert.ok('state' in ok);
    if ('state' in ok) {
      assert.equal(ok.state.environments[0].variables[0].value, 'T0K');
      assert.equal(ok.state.environments[0].headers[0].value, 'Bearer old');
    }
    const bad = (input: unknown) => ('error' in buildEnvironments(input, existing) ? (buildEnvironments(input, existing) as { error: string }).error : '');
    assert.match(bad({ environments: [{ name: 'a' }, { name: 'A' }] }), /two environments/);
    assert.match(bad({ environments: [{ name: '' }] }), /name/);
    assert.match(bad({ environments: [{ name: 'x', variables: [{ key: 'bad key', value: '1' }] }] }), /not a valid variable name/);
    assert.match(bad({ environments: [{ name: 'x', headers: [{ name: 'Host', value: 'a' }] }] }), /cannot be used/);
    assert.match(bad({ environments: Array.from({ length: 11 }, (_, i) => ({ name: `e${i}` })) }), /At most 10/);
    assert.match(bad('nope'), /list/);
  });

  test('merging files into an existing set: same name (any case) is updated, new ones added, the limit respected', () => {
    const state = { active: 'a', environments: [{ id: 'a', name: 'UAT', baseUrl: '', variables: [{ key: 'k', value: 'old', secret: false }], headers: [{ name: 'X-Key', value: 'v' }] }] };
    const m = mergeEnvironments(state, [
      { id: 'n1', name: 'uat', baseUrl: '{{k}}', variables: [{ key: 'k', value: 'new', secret: false }, { key: 'j', value: '1', secret: false }], headers: [] },
      { id: 'n2', name: 'prod', baseUrl: '', variables: [], headers: [] },
    ]);
    assert.deepEqual([m.added, m.updated], [['prod'], ['UAT']]);
    const uat = m.state.environments.find((e) => e.id === 'a')!;
    assert.equal(uat.baseUrl, '{{k}}');
    assert.deepEqual(uat.variables.map((v) => [v.key, v.value]), [['k', 'new'], ['j', '1']]);
    assert.equal(uat.headers.length, 1, 'login headers are kept');
    assert.equal(m.state.active, 'a');
  });
});

describe('through the routes', () => {
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  let apiId = '';
  const mgmt = (p: string) => `/api/projects/${projectId}/sim${p}`;

  before(async () => {
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'admin@env.test', password: 'adminpassword1', name: 'Admin' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'admin@env.test', password: 'adminpassword1' } })).cookie ?? '';
    projectId = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'Env project' }, cookie })).body as { project: { id: string } }).project.id;
  });
  after(cleanup);

  test('importing a Postman collection creates the environment from its variables and makes its address live', async () => {
    const collection = {
      info: { name: 'EPO', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'baseUrl', value: 'https://ops.example/3.2' }, { key: 'consumerKey', value: 'abc' }],
      item: [{ name: 'Get doc', request: { method: 'GET', url: { raw: '{{baseUrl}}/rest-services/doc/EP1', host: ['{{baseUrl}}'], path: ['rest-services', 'doc', 'EP1'] } } }],
    };
    const r = await fetchJson(baseUrl, mgmt('/import'), { body: { kind: 'postman', collection }, cookie });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    apiId = (r.body as { created: Array<{ id: string }> }).created[0].id;
    const detail = (await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { cookie })).body as { api: { environments: Array<{ name: string; resolvedBaseUrl: string; variables: Array<{ key: string; secret: boolean; value: string }> }>; liveBaseUrl: string; activeEnvironment: string } };
    assert.equal(detail.api.environments.length, 1);
    assert.equal(detail.api.environments[0].name, 'EPO');
    assert.equal(detail.api.environments[0].resolvedBaseUrl, 'https://ops.example/3.2');
    assert.equal(detail.api.liveBaseUrl, 'https://ops.example/3.2');
    const key = detail.api.environments[0].variables.find((v) => v.key === 'consumerKey')!;
    assert.deepEqual([key.secret, key.value], [true, ''], 'a secret value is not sent to the browser');
  });

  test('importing environment files adds dev, uat and prod; switching the active one changes the live address', async () => {
    const files = [
      { name: 'dev.postman_environment.json', content: postmanEnv('dev', [{ key: 'baseUrl', value: 'https://dev.example/3.2' }, { key: 'apiToken', value: 'DEVTOKEN', type: 'secret' }]) },
      { name: 'uat.postman_environment.json', content: postmanEnv('uat', [{ key: 'baseUrl', value: 'https://uat.example/3.2' }]) },
      { name: 'prod.env', content: 'BASE_URL=https://prod.example/3.2\nCLIENT_SECRET=zzz\n' },
    ];
    const r = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/environments/import`), { body: { files }, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body as { added: string[]; api: { environments: Array<{ id: string; name: string }>; liveBaseUrl: string } };
    assert.deepEqual(b.added, ['dev', 'uat', 'prod']);
    assert.equal(b.api.liveBaseUrl, 'https://ops.example/3.2', 'importing does not change which environment is active');
    assert.ok(!JSON.stringify(r.body).includes('DEVTOKEN') && !JSON.stringify(r.body).includes('zzz'), 'no secret in the answer');

    const uat = b.api.environments.find((e) => e.name === 'uat')!;
    const sw = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/environments/active`), { method: 'PUT', body: { active: uat.id }, cookie });
    assert.equal(sw.status, 200);
    assert.equal((sw.body as { api: { liveBaseUrl: string; activeEnvironment: string } }).api.liveBaseUrl, 'https://uat.example/3.2');
    assert.equal((await getSimulationRepository().getApi(projectId, apiId))!.live_base_url, 'https://uat.example/3.2');

    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}/environments/active`), { method: 'PUT', body: { active: 'nope' }, cookie })).status, 400);
  });

  test('saving environments by hand: a login header of the active environment becomes the live login; empty secrets are kept', async () => {
    const cur = ((await fetchJson(baseUrl, mgmt(`/apis/${apiId}`), { cookie })).body as { api: { environments: Array<{ id: string; name: string; baseUrl: string; variables: Array<{ key: string; secret: boolean; value: string }> }> } }).api.environments;
    const dev = cur.find((e) => e.name === 'dev')!;
    const form = {
      active: dev.id,
      environments: cur.map((e) => e.id === dev.id
        ? { ...e, headers: [{ name: 'Authorization', value: 'Bearer {{apiToken}}' }], variables: e.variables.map((v) => ({ ...v })) }
        : { ...e, headers: [], variables: e.variables.map((v) => ({ ...v })) }),
    };
    const r = await fetchJson(baseUrl, mgmt(`/apis/${apiId}/environments`), { method: 'PUT', body: form, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rec = (await getSimulationRepository().getApi(projectId, apiId))!;
    assert.equal(rec.live_base_url, 'https://dev.example/3.2');
    assert.deepEqual(readLiveHeaders(rec.live_headers_enc), { Authorization: 'Bearer DEVTOKEN' }, 'the stored secret was kept and filled in');
    assert.ok(!JSON.stringify(r.body).includes('DEVTOKEN'));
  });

  test('bad requests are refused and an outsider cannot read or change them', async () => {
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}/environments/import`), { body: { files: [] }, cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}/environments/import`), { body: { files: [{ name: 'a.txt', content: 'no variables here' }] }, cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}/environments`), { method: 'PUT', body: { environments: 'x' }, cookie })).status, 400);
    assert.equal((await fetchJson(baseUrl, mgmt(`/apis/${apiId}/environments`), { method: 'PUT', body: { environments: [] } })).status, 401);
  });
});
