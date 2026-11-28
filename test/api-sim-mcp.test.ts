/**
 * The simulated APIs as an MCP server, used the way an agent's runner uses a remote MCP server.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { McpHttpClient, isReadOnlyTool } from '../server/agent/runner-mcp.ts';
import type { McpTool } from '../server/agent/runner-mcp.ts';
import { getSimulationRepository } from '../server/repositories/simulation.ts';

const PETS = {
  openapi: '3.0.1',
  info: { title: 'Pets', version: '1' },
  paths: {
    '/pets/{id}': {
      get: {
        operationId: 'getPet', summary: 'Fetch one pet',
        parameters: [{ name: 'verbose', in: 'query', schema: { type: 'boolean' } }, { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string', example: 'Rex' } } } } } } },
      },
    },
    '/pets': {
      post: {
        operationId: 'createPet', summary: 'Create a pet', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 5, 'x-note': 'internal' } } } } } },
        responses: { '201': { description: 'created', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } },
      },
    },
  },
};

describe('simulated APIs as MCP tools', () => {
  let baseUrl: string;
  let cookie: string;
  let pid: string;
  let petsId: string;
  let token: string;
  let client: McpHttpClient;
  const endpoint = () => `${baseUrl}/api/sim-mcp/${pid}`;
  const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0].text);

  before(async () => {
    baseUrl = (await createTestServer()).baseUrl;
    await fetchJson(baseUrl, '/api/auth/setup', { body: { email: 'a@mcp.test', password: 'adminpassword1', name: 'A' } });
    cookie = (await fetchJson(baseUrl, '/api/auth/login', { body: { email: 'a@mcp.test', password: 'adminpassword1' } })).cookie ?? '';
    pid = ((await fetchJson(baseUrl, '/api/projects', { body: { name: 'M' }, cookie })).body as { project: { id: string } }).project.id;
    token = ((await fetchJson(baseUrl, '/api/api-tokens', { body: { name: 'agent', scope: 'write' }, cookie })).body as { token: string }).token;
    const imp = await fetchJson(baseUrl, `/api/projects/${pid}/sim/import`, { body: { kind: 'openapi', spec: PETS }, cookie });
    petsId = (imp.body as { created: Array<{ id: string }> }).created[0].id;
    // a second API that stays a draft: its tools must not appear
    await fetchJson(baseUrl, `/api/projects/${pid}/sim/import`, { body: { kind: 'openapi', spec: { openapi: '3.0.1', info: { title: 'Draft' }, paths: { '/d': { get: { operationId: 'draftOp', responses: { '200': { description: 'ok' } } } } } } }, cookie });
    client = new McpHttpClient(endpoint(), { Authorization: `Bearer ${token}` });
  });

  after(cleanup);

  test('only an API token may use it', async () => {
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const asCookie = await fetchJson(baseUrl, `/api/sim-mcp/${pid}`, { body: rpc, cookie });
    assert.equal(asCookie.status, 401);
    const anon = await fetch(endpoint(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc) });
    assert.equal(anon.status, 401);
    const get = await fetch(endpoint(), { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(get.status, 405);
  });

  test('nothing is offered until a version is approved', async () => {
    assert.deepEqual(await client.listTools(), []);
    assert.equal((await fetchJson(baseUrl, `/api/projects/${pid}/sim/apis/${petsId}/versions/1/approve`, { body: {}, cookie })).status, 200);
  });

  test('tools: one per operation of an approved API, with schemas an agent can fill in', async () => {
    const tools = await new McpHttpClient(endpoint(), { Authorization: `Bearer ${token}` }).listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['createPet', 'getPet']);
    const get = tools.find((t) => t.name === 'getPet') as McpTool & { inputSchema: { properties: Record<string, { required?: string[] }>; required: string[] } };
    assert.deepEqual(get.inputSchema.required.sort(), ['headers', 'pathParams']);
    assert.deepEqual(get.inputSchema.properties.pathParams.required, ['id']);
    assert.equal(get.annotations?.readOnlyHint, true);
    const create = tools.find((t) => t.name === 'createPet') as McpTool & { inputSchema: { properties: Record<string, unknown>; required: string[] } };
    assert.deepEqual(create.inputSchema.required.sort(), ['body', 'clientAuthorization']);
    assert.ok(create.inputSchema.properties.clientAuthorization);
    assert.equal(JSON.stringify(create.inputSchema).includes('x-note'), false);
    assert.match(create.description ?? "", /POST \/pets/);
    assert.match(create.description ?? "", /clientAuthorization/);
    // what the runner's read-only filter will do with them
    assert.equal(isReadOnlyTool(get), true);
    assert.equal(isReadOnlyTool(create), false);
  });

  test('calling a tool answers like the simulated API, with the status first', async () => {
    const get = text(await client.callTool('getPet', { pathParams: { id: '7' }, headers: { 'X-Trace': 't' } }));
    assert.match(get, /^HTTP 200 \(simulated\)/);
    assert.match(get, /"name": "Rex"/);

    const noToken = text(await client.callTool('createPet', { body: { name: 'Rex' } }));
    assert.match(noToken, /^HTTP 401/);
    const bad = text(await client.callTool('createPet', { body: { name: 'Far too long' }, clientAuthorization: 'Bearer client' }));
    assert.match(bad, /^HTTP 400/);
    assert.match(bad, /body\.name/);
    const created = text(await client.callTool('createPet', { body: { name: 'Rex' }, clientAuthorization: 'Bearer client' }));
    assert.match(created, /^HTTP 201 \(simulated\)/);
  });

  test('mistakes are explained, not thrown', async () => {
    const r1 = await client.callTool('getPet', { headers: { 'X-Trace': 't' } }) as { isError?: boolean };
    assert.equal(r1.isError, true);
    assert.match(text(r1), /Missing path value "id"/);
    const r2 = await client.callTool('nope', {}) as { isError?: boolean };
    assert.equal(r2.isError, true);
    assert.match(text(r2), /no simulated API tool called "nope"/);
  });

  test('a draft API has no tools, and a notification gets no answer', async () => {
    const names = (await client.listTools()).map((t) => t.name);
    assert.ok(!names.includes('draftOp'));
    const note = await fetch(endpoint(), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202);
    const unknown = await fetch(endpoint(), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }) });
    assert.equal(((await unknown.json()) as { error: { code: number } }).error.code, -32601);
  });

  test('in live mode the call goes to the live address (here stopped by the SSRF guard) and the portal token never leaves', async () => {
    await getSimulationRepository().updateApi(pid, petsId, { mode: 'live', live_base_url: 'https://127.0.0.1:9' });
    const r = await client.callTool('getPet', { pathParams: { id: '7' }, headers: { 'X-Trace': 't' } }) as { isError?: boolean };
    assert.match(text(r), /^HTTP 502 \(live API\)/);
    assert.match(text(r), /SSRF/);
    assert.equal(r.isError, true);
    assert.equal(text(r).includes(token), false);
    await getSimulationRepository().updateApi(pid, petsId, { mode: 'mock' });
  });

  test('the settings screen can list the tools', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${pid}/sim/mcp-info`, { cookie });
    assert.equal(r.status, 200);
    const b = r.body as { path: string; tools: Array<{ name: string; readOnly: boolean; method: string }> };
    assert.equal(b.path, `/api/sim-mcp/${pid}`);
    assert.deepEqual(b.tools.map((t) => `${t.method} ${t.name} ${t.readOnly}`).sort(), ['GET getPet true', 'POST createPet false']);
  });
});
