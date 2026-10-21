import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { bootServer, Client, waitFor, type TestServer } from './client.ts';

// Server modules are imported only after bootServer() has pointed DATA_DIR at a temporary folder: importing them
// earlier would load the configuration, and the database, of the real portal.
test('read-only integrations refuse tools that change something, and allow the rest', async () => {
  const { integrationGuard, mcpToolOf } = await import('../server/integrations.ts');
  const ro = new Set(['jira']);
  assert.deepEqual(mcpToolOf('mcp__jira__getJiraIssue'), { server: 'jira', tool: 'getJiraIssue' });
  assert.deepEqual(mcpToolOf('@jira/get_issue'), { server: 'jira', tool: 'get_issue' });
  for (const t of ['mcp__jira__getJiraIssue', 'mcp__jira__searchJiraIssuesUsingJql', 'mcp__jira__listRuns', 'mcp__jira__getDataset', '@jira/get_issue']) {
    assert.equal(integrationGuard(ro, t), null, `allowed: ${t}`);
  }
  for (const t of ['mcp__jira__createJiraIssue', 'mcp__jira__transitionJiraIssue', 'mcp__jira__addCommentToJiraIssue', 'mcp__jira__update_page', '@jira/delete-issue', 'jira/editJiraIssue']) {
    assert.match(String(integrationGuard(ro, t)), /read-only/, `blocked: ${t}`);
  }
  assert.equal(integrationGuard(ro, 'mcp__confluence__createPage'), null, 'only read-only servers are checked');
  assert.equal(integrationGuard(ro, 'Write'), null, 'built-in tools are not integration tools');
});

/* ---------------- the API, against fake MCP servers ---------------- */

let srv: TestServer;
let admin: Client;
let bob: Client;
let pid: string;
let mcpHttp: http.Server;
let mcpUrl = '';
let seenAuth = '';

before(async () => {
  // A streamable-HTTP MCP server that wants a bearer token.
  mcpHttp = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seenAuth = String(req.headers.authorization ?? '');
      if (seenAuth !== 'Bearer mcp-secret-42') {
        res.writeHead(401).end();
        return;
      }
      const m = JSON.parse(body || '{}');
      if (m.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 's1' });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-http-mcp' } } })}\n\n`);
      } else if (m.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } }));
      } else res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => mcpHttp.listen(0, '127.0.0.1', r));
  // The form insists on https; tests reach the local fake through this switch.
  process.env.PORTAL_ALLOW_HTTP_MCP = '1';
  mcpUrl = `http://127.0.0.1:${(mcpHttp.address() as any).port}/mcp`;

  srv = await bootServer();
  admin = new Client(srv.base);
  bob = new Client(srv.base);
  await admin.post('/api/auth/setup', { email: 'a@example.com', name: 'Ann', password: 'a-long-password-1' });
  await admin.post('/api/users', { email: 'b@example.com', name: 'Bob', password: 'a-long-password-2' });
  await bob.post('/api/auth/login', { email: 'b@example.com', password: 'a-long-password-2' });
  pid = (await admin.post('/api/projects', { name: 'Integ', description: 'd' })).project.id;
  await admin.post(`/api/projects/${pid}/members`, { email: 'b@example.com', access: 'editor', role: 'Dev' });
});

after(async () => {
  await srv.close();
  mcpHttp.close();
});

test('integrations: write-only secrets, a real MCP handshake to test, and who may use what', async () => {
  const { integration: web } = await admin.post('/api/integrations', { kind: 'http', name: 'Tickets', url: mcpUrl, headers: { Authorization: 'Bearer mcp-secret-42' } });
  assert.deepEqual(web.config.headerNames, ['Authorization']);
  assert.ok(!JSON.stringify(await admin.get('/api/integrations')).includes('mcp-secret-42'), 'header values never come back');
  const t = await admin.post(`/api/integrations/${web.id}/test`);
  assert.equal(t.test.ok, true, t.test.message);
  assert.equal(t.test.message, 'Connected to fake-http-mcp; 3 tools available.');
  assert.equal(seenAuth, 'Bearer mcp-secret-42');
  assert.equal(web.allowWrites, false, 'read-only unless writes are allowed');

  // Editing with the header listed but left empty keeps the saved value.
  await admin.put(`/api/integrations/${web.id}`, { headers: { Authorization: '' }, allowWrites: true });
  assert.equal((await admin.post(`/api/integrations/${web.id}/test`)).test.ok, true);

  // Command-line servers run on the portal server: admins only.
  assert.equal((await bob.req('POST', '/api/integrations', { kind: 'stdio', name: 'Mine', command: 'node', args: ['x.js'] })).status, 400);
  const { integration: cli } = await admin.post('/api/integrations', { kind: 'stdio', name: 'Local tools', command: process.execPath, args: [path.join(import.meta.dirname, 'fake-mcp.mjs')], env: { FAKE_MCP_TOKEN: 'tok-1' } });
  const ct = await admin.post(`/api/integrations/${cli.id}/test`);
  assert.equal(ct.test.message, 'Started fake-mcp-with-token; 2 tools available.', 'secret env reaches the server');

  // Personal integrations: invisible to others and never in a workspace.
  const { integration: mine } = await bob.post('/api/integrations', { kind: 'http', name: 'Bob only', scope: 'personal', url: mcpUrl, headers: { Authorization: 'Bearer mcp-secret-42' } });
  assert.ok(!(await admin.get('/api/integrations')).integrations.some((i: any) => i.id === mine.id));
  assert.equal((await bob.req('POST', `/api/projects/${pid}/workspaces`, { name: 'With personal', integrations: [mine.id] })).status, 400);
  assert.equal((await admin.req('POST', `/api/projects/${pid}/workflows`, { goal: 'x', start: false, integrations: [mine.id], playground: true })).status, 400, 'nobody else can attach it');
  const own = await bob.post(`/api/projects/${pid}/workflows`, { goal: 'mine', start: false, integrations: [mine.id], playground: true });
  assert.deepEqual(own.workflow.integrations, [mine.id], 'its owner can');

  // Team integrations in a workspace come with every session started from it; they cannot be deleted while attached.
  const { workspace } = await admin.post(`/api/projects/${pid}/workspaces`, { name: 'Tools', integrations: [web.id] });
  const { workflow } = await bob.post(`/api/projects/${pid}/workflows`, { goal: 'Use the tools [demo-iterations: 1]', workspaceId: workspace.id, model: 'haiku' });
  assert.deepEqual(workflow.integrations, [web.id]);
  const d = await waitFor(async () => {
    const x = await bob.get(`/api/workflows/${workflow.id}`);
    return x.workflow.status !== 'running' && !x.driving ? x : null;
  }, 'session');
  const run = (await bob.get(`/api/runs/${d.workflow.last_run_id}`)).run;
  assert.deepEqual(run.meta.integrations.map((x: any) => [x.name, x.server, x.readOnly]), [['Tickets', 'tickets', false]]);
  const blocked = await admin.req('DELETE', `/api/integrations/${web.id}`);
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /Still attached to Integ \/ Tools/);
  assert.equal((await bob.req('PUT', `/api/integrations/${web.id}`, { name: 'x' })).status, 403, 'only admins and its maker change a team integration');
});
