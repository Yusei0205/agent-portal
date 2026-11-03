/** Remote MCP integrations: the HTTP client, the read-only filter and the stdio proxy the runners start. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseMcpServers, isReadOnlyTool, McpHttpClient } from '../server/agent/runner-mcp.ts';
import { serverName } from '../server/agent/runner-integrations.ts';

const TOOLS = [
  { name: 'search_docs', description: 'Find pages' },
  { name: 'get_item', description: 'Read one', annotations: { readOnlyHint: true } },
  { name: 'create_item', description: 'Write' },
  { name: 'list_things_but_deletes', annotations: { readOnlyHint: false } },
  { name: 'wipe', annotations: { destructiveHint: true } },
];

let server: http.Server;
let url = '';
const seen: Array<{ method: string; auth: string | undefined; session: string | undefined }> = [];
let sse = false;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
      seen.push({ method: msg.method, auth: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined });
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const reply = (result: unknown, headers: Record<string, string> = {}) => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
        if (sse && msg.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
          res.end(`event: message\ndata: ${payload}\n\n`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json', ...headers });
          res.end(payload);
        }
      };
      if (msg.method === 'initialize') reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }, { 'mcp-session-id': 'sess-1' });
      else if (msg.method === 'tools/list') reply({ tools: TOOLS });
      else if (msg.method === 'tools/call') reply({ content: [{ type: 'text', text: `ran ${msg.params?.name} ${JSON.stringify(msg.params?.arguments)}` }] });
      else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});

after(() => { server.close(); });

describe('parseMcpServers', () => {
  it('keeps well-formed https servers and drops the rest', () => {
    const out = parseMcpServers([
      { name: 'sentry', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' }, allowWrites: true },
      { name: 'plain', url: 'http://mcp.example.com/mcp' },
      { name: 'Bad Name', url: 'https://mcp.example.com/mcp' },
      { name: 'sentry', url: 'https://other.example.com/mcp' },
      { name: 'crlf', url: 'https://mcp.example.com/mcp', headers: { 'X-A': 'a\r\nX-B: b', Ok: 'fine' } },
      'nonsense',
    ]);
    assert.deepEqual(out.map((s) => s.name), ['sentry', 'crlf']);
    assert.equal(out[0].allowWrites, true);
    assert.deepEqual(out[1].headers, { Ok: 'fine' });
    assert.equal(out[1].allowWrites, false);
  });
  it('is empty for anything that is not a list', () => {
    assert.deepEqual(parseMcpServers(undefined), []);
    assert.deepEqual(parseMcpServers({}), []);
  });
});

describe('isReadOnlyTool', () => {
  it('trusts the tool\'s own hint, then falls back to the name', () => {
    assert.equal(isReadOnlyTool({ name: 'search_docs' }), true);
    assert.equal(isReadOnlyTool({ name: 'getItem' }), true);
    assert.equal(isReadOnlyTool({ name: 'create_item' }), false);
    assert.equal(isReadOnlyTool({ name: 'get_item', annotations: { readOnlyHint: false } }), false);
    assert.equal(isReadOnlyTool({ name: 'deploy', annotations: { readOnlyHint: true } }), true);
    assert.equal(isReadOnlyTool({ name: 'deploy', annotations: { readOnlyHint: true, destructiveHint: true } }), false);
    assert.equal(isReadOnlyTool({ name: 'wipe', annotations: { destructiveHint: true } }), false);
    assert.equal(isReadOnlyTool({ name: 'getaway' }), false);
  });
});

describe('serverName', () => {
  it('makes a safe, unique tool prefix', () => {
    const taken = new Set<string>(['browser']);
    assert.equal(serverName('Sentry Prod!', taken), 'sentry-prod');
    assert.equal(serverName('Sentry Prod', taken), 'sentry-prod-2');
    assert.equal(serverName('Browser', taken), 'browser-2');
    assert.match(serverName('123', taken), /^[a-z][a-z0-9_-]*$/);
  });
});

describe('McpHttpClient', () => {
  it('connects once, sends the secret headers and the session id, and lists the tools', async () => {
    seen.length = 0;
    const c = new McpHttpClient(url, { Authorization: 'Bearer secret' });
    const tools = await c.listTools();
    assert.equal(tools.length, TOOLS.length);
    assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list']);
    assert.ok(seen.every((s) => s.auth === 'Bearer secret'));
    assert.equal(seen[2].session, 'sess-1');
    await c.listTools();
    assert.equal(seen.filter((s) => s.method === 'initialize').length, 1);
  });
  it('reads a reply that arrives as an event stream', async () => {
    sse = true;
    try { assert.equal((await new McpHttpClient(url, {}).listTools()).length, TOOLS.length); } finally { sse = false; }
  });
  it('says why it failed', async () => {
    await assert.rejects(new McpHttpClient('http://127.0.0.1:1/mcp', {}).listTools());
  });
});

describe('stdio proxy', () => {
  /** Starts the proxy in a child process and talks to it the way a coding agent does. */
  async function ask(allowWrites: boolean, calls: Array<{ method: string; params?: unknown }>): Promise<Array<Record<string, unknown>>> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const mod = pathToFileURL(path.join(here, '..', 'server', 'agent', 'runner-mcp.ts')).href;
    const script = `import { runMcpProxy } from ${JSON.stringify(mod)}; runMcpProxy(${JSON.stringify({ name: 'fake', url, headers: { Authorization: 'Bearer secret' }, allowWrites })});`;
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
    const replies: Array<Record<string, unknown>> = [];
    let buf = '';
    const done = new Promise<void>((resolve) => {
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line.trim()) replies.push(JSON.parse(line));
          if (replies.length === calls.length) { child.stdin.end(); }
        }
      });
      child.on('close', () => resolve());
    });
    calls.forEach((c, i) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...c }) + '\n'));
    await done;
    return replies;
  }

  it('offers only read-only tools, and runs them with the secret header', async () => {
    seen.length = 0;
    const r = await ask(false, [
      { method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { method: 'tools/list' },
      { method: 'tools/call', params: { name: 'search_docs', arguments: { q: 'x' } } },
    ]);
    const names = ((r[1].result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    assert.deepEqual(names, ['search_docs', 'get_item']);
    assert.match(JSON.stringify(r[2]), /ran search_docs/);
    assert.ok(seen.every((s) => s.auth === 'Bearer secret'));
  });

  it('refuses a write tool the agent names anyway', async () => {
    seen.length = 0;
    const r = await ask(false, [{ method: 'tools/call', params: { name: 'create_item', arguments: {} } }]);
    assert.match(JSON.stringify(r[0]), /read-only/);
    assert.equal(seen.some((s) => s.method === 'tools/call'), false);
  });

  it('offers every tool when writes are allowed', async () => {
    const r = await ask(true, [{ method: 'tools/list' }, { method: 'tools/call', params: { name: 'create_item', arguments: { a: 1 } } }]);
    assert.equal(((r[0].result as { tools: unknown[] }).tools).length, TOOLS.length);
    assert.match(JSON.stringify(r[1]), /ran create_item/);
  });

  it('reports a server that cannot be reached as a tool error, not a crash', async () => {
    const live = url;
    url = 'http://127.0.0.1:1/mcp';
    try {
      const r = await ask(false, [{ method: 'tools/call', params: { name: 'search_docs' } }]);
      assert.equal(r.length, 1);
    } finally { url = live; }
  });
});
