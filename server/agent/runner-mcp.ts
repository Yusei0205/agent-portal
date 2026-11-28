/**
 * Remote MCP servers (integrations) for an agent run.
 *
 * The portal hands the runner a list of servers (URL, secret headers, "allow writes"). The runner does not give those
 * to the agent engine directly: it starts a small stdio proxy (this file's `runMcpProxy`) as the engine's MCP server.
 * The proxy holds the secret headers, forwards to the remote server over streamable HTTP, and hides and refuses every
 * tool that is not read-only unless the integration allows writes. Both engines (Claude, Kiro) therefore see one
 * ordinary local MCP server, and the secrets never appear in an argument list or a config file.
 *
 * The same HTTP client is used by the portal to test an integration (connect, list the tools).
 *
 * Shared by agent-runner, kiro-runner and the portal (copied in at image build time for the runners).
 * Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0. Nothing but protocol messages may go to stdout.
 */

import readline from 'node:readline';

export interface McpServerSpec {
  /** Short name; the agent sees its tools under this name. */
  name: string;
  url: string;
  /** Secret headers sent with every request, e.g. Authorization. */
  headers: Record<string, string>;
  allowWrites: boolean;
}

export const MCP_LIMITS = { servers: 8, headers: 10, headerValue: 4000, requestMs: 30_000, pages: 5 } as const;
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Reads the payload's `mcpServers`; anything that does not look right is dropped (the server is just not offered). */
export function parseMcpServers(raw: unknown): McpServerSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerSpec[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MCP_LIMITS.servers)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== 'string' || !NAME_RE.test(o.name) || seen.has(o.name)) continue;
    if (typeof o.url !== 'string' || o.url.length > 2000) continue;
    try { if (new URL(o.url).protocol !== 'https:') continue; } catch { continue; }
    const headers: Record<string, string> = {};
    if (o.headers && typeof o.headers === 'object') {
      for (const [k, v] of Object.entries(o.headers as Record<string, unknown>).slice(0, MCP_LIMITS.headers)) {
        if (!HEADER_NAME_RE.test(k) || typeof v !== 'string' || v.length > MCP_LIMITS.headerValue || /[\r\n]/.test(v)) continue;
        headers[k] = v;
      }
    }
    seen.add(o.name);
    out.push({ name: o.name, url: o.url, headers, allowWrites: o.allowWrites === true });
  }
  return out;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } & Record<string, unknown>;
}

const READ_NAME = /^(get|list|search|read|describe|fetch|query|find|view|show|lookup|count)([_\-.A-Z]|$)/;

/** A tool is read-only when it says so, or (when it says nothing) when its name starts with a reading verb. */
export function isReadOnlyTool(tool: McpTool): boolean {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === true) return a.destructiveHint !== true;
  if (a.readOnlyHint === false || a.destructiveHint === true) return false;
  return READ_NAME.test(tool.name);
}

// ── Streamable-HTTP client ────────────────────────────────────────────────────

type Json = Record<string, unknown>;

export class McpHttpClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private ready: Promise<void> | null = null;

  constructor(private readonly url: string, private readonly headers: Record<string, string>) {}

  private async post(body: Json): Promise<Response> {
    return fetch(this.url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...body }),
      signal: AbortSignal.timeout(MCP_LIMITS.requestMs),
      redirect: 'error',
    });
  }

  private async readReply(res: Response, id: number): Promise<Json> {
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (type.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as Json;
          if (msg.id === id) return msg;
        } catch { /* not a message */ }
      }
      throw new Error('The server sent no reply');
    }
    try { return JSON.parse(text) as Json; } catch { throw new Error('The server did not answer with JSON'); }
  }

  async request(method: string, params?: Json): Promise<unknown> {
    if (method !== 'initialize') await this.init();
    const id = this.nextId++;
    const res = await this.post({ id, method, ...(params ? { params } : {}) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (method === 'initialize') this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
    const msg = await this.readReply(res, id);
    if (msg.error) throw new Error(String((msg.error as Json).message ?? 'The server returned an error'));
    return msg.result;
  }

  init(): Promise<void> {
    this.ready ??= (async () => {
      await this.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'agent-portal', version: '1.0' },
      });
      const res = await this.post({ method: 'notifications/initialized' });
      await res.arrayBuffer().catch(() => undefined);
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MCP_LIMITS.pages; i++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : undefined)) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(r.tools ?? []));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args ?? {} });
  }
}

// ── Stdio proxy ───────────────────────────────────────────────────────────────

/** Runs until stdin closes. `spec.allowWrites` false hides and refuses every tool that is not read-only. */
export function runMcpProxy(spec: McpServerSpec): void {
  const client = new McpHttpClient(spec.url, spec.headers);
  let visible: McpTool[] | null = null;

  const send = (msg: Json): void => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };

  async function tools(): Promise<McpTool[]> {
    if (!visible) {
      const all = await client.listTools();
      visible = spec.allowWrites ? all : all.filter(isReadOnlyTool);
    }
    return visible;
  }

  async function handle(req: { id?: number | string; method?: string; params?: Json }): Promise<void> {
    const { id, method, params } = req;
    if (id === undefined) return;
    switch (method) {
      case 'initialize':
        send({ id, result: { protocolVersion: (params?.protocolVersion as string) ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: spec.name, version: '1.0.0' } } });
        return;
      case 'ping':
        send({ id, result: {} });
        return;
      case 'tools/list':
        send({ id, result: { tools: await tools() } });
        return;
      case 'tools/call': {
        const name = String(params?.name ?? '');
        if (!(await tools()).some((t) => t.name === name)) {
          send({ id, result: { content: [{ type: 'text', text: `"${name}" is not available: this integration is read-only.` }], isError: true } });
          return;
        }
        send({ id, result: await client.callTool(name, params?.arguments) });
        return;
      }
      default:
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: Parameters<typeof handle>[0];
    try { req = JSON.parse(line); } catch { return; }
    handle(req).catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      if (req.id === undefined) return;
      if (req.method === 'tools/call') send({ id: req.id, result: { content: [{ type: 'text', text: `${spec.name} failed: ${message}` }], isError: true } });
      else send({ id: req.id, error: { code: -32603, message } });
    });
  });
  rl.on('close', () => process.exit(0));
}

/** Entry point of the proxy process: the spec arrives in MCP_PROXY_SPEC (never as an argument). */
export function runMcpProxyFromEnv(): void {
  const [spec] = parseMcpServers([JSON.parse(process.env.MCP_PROXY_SPEC ?? 'null')]);
  if (!spec) { process.stderr.write('mcp-proxy: no valid server in MCP_PROXY_SPEC\n'); process.exit(2); }
  runMcpProxy(spec);
}
