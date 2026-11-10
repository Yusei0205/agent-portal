/**
 * The simulated APIs of a project as an MCP server, so an agent in a session can call them like any other tool.
 *
 *   POST /api/sim-mcp/:projectId        JSON-RPC over HTTP (initialize, tools/list, tools/call, ping), API token only
 *   GET  /api/projects/:id/sim/mcp-info the address and the tool list, for the settings screen
 *
 * One tool per operation of every API that has an approved version. A call goes through the same code as the hosted
 * REST endpoint (call.ts), so the mode of the API decides whether it is simulated or forwarded to the client's real API.
 * Add it to a project as a remote MCP server (Tools & services) with the header Authorization: Bearer ap_...; tools that
 * change something (POST, PUT, PATCH, DELETE) are only offered to agents when "allow writes" is on for that server.
 *
 * Hand-written rather than built on the MCP SDK: it needs four methods, no streaming and no sessions.
 */

import type { IncomingMessage } from 'node:http';
import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { hasScope } from '../testing/helpers.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';
import type { SimApiRecord, SimVersionRecord } from '../repositories/simulation.ts';
import { requireProjectAccess } from './access.ts';
import { answerCall } from './call.ts';
import type { HttpMethod, Operation, Schema } from './types.ts';

const MAX_TOOLS = 200;
const MAX_BODY = 1024 * 1024;
const MAX_TEXT = 20_000;
const MAX_DELAY_MS = 5_000;
const TOOL_NAME_RE = /[^A-Za-z0-9_-]/g;

export interface SimTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  api: SimApiRecord;
  ver: SimVersionRecord;
  method: HttpMethod;
  path: string;
  op: Operation;
}

/** A schema without our own x- notes, which are not JSON Schema and only add noise for a model. */
function clean(schema: Schema | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !k.startsWith('x-')).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(schema) as Record<string, unknown>;
}

function slug(s: string): string {
  return s.replace(TOOL_NAME_RE, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'api';
}

export function toolFor(api: SimApiRecord, ver: SimVersionRecord, path: string, method: HttpMethod, op: Operation, name: string): SimTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  if (pathParams.length > 0) {
    properties.pathParams = { type: 'object', description: 'Values for the {…} parts of the path.', properties: Object.fromEntries(pathParams.map((p) => [p, { type: 'string' }])), required: pathParams };
    required.push('pathParams');
  }
  const query = (op.parameters ?? []).filter((p) => p.in === 'query');
  if (query.length > 0) {
    properties.query = { type: 'object', properties: Object.fromEntries(query.map((p) => [p.name, clean(p.schema) ?? { type: 'string' }])), required: query.filter((p) => p.required).map((p) => p.name) };
    if (query.some((p) => p.required)) required.push('query');
  }
  const headerParams = (op.parameters ?? []).filter((p) => p.in === 'header');
  if (headerParams.length > 0) {
    properties.headers = { type: 'object', properties: Object.fromEntries(headerParams.map((p) => [p.name, { type: 'string', ...(p.description ? { description: p.description } : {}) }])), required: headerParams.filter((p) => p.required).map((p) => p.name) };
    if (headerParams.some((p) => p.required)) required.push('headers');
  }
  const bodySchema = clean(op.requestBody?.content['application/json']?.schema);
  if (bodySchema) {
    properties.body = bodySchema;
    required.push('body');
  }
  const secured = Array.isArray(op.security) && op.security.length > 0;
  if (secured) {
    properties.clientAuthorization = { type: 'string', description: 'The client\'s own login token for this API, for example "Bearer eyJ…". It is sent to the API as the Authorization header.' };
    required.push('clientAuthorization');
  }

  const description = [
    `${op.summary || op.operationId}.`,
    `Calls ${method.toUpperCase()} ${path} on the ${api.name} API (${api.mode === 'mock' ? 'simulated' : api.mode === 'live' ? 'forwarded to the live API' : 'simulated or live per operation'}).`,
    secured ? 'Needs the client\'s login token in clientAuthorization.' : '',
    'The answer starts with the HTTP status.',
  ].filter(Boolean).join(' ');

  return {
    name, description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    annotations: { readOnlyHint: method === 'get', destructiveHint: false },
    api, ver, method, path, op,
  };
}

/** A tool per operation of every approved API in the project. Names are unique and fit the MCP name rules. */
export async function buildTools(projectId: string): Promise<SimTool[]> {
  const repo = getSimulationRepository();
  const out: SimTool[] = [];
  const used = new Set<string>();
  for (const api of await repo.listApis(projectId)) {
    if (api.approved_version === 0) continue;
    const ver = await repo.getVersion(api.id, api.approved_version);
    if (!ver) continue;
    for (const [path, item] of Object.entries(ver.spec.paths)) {
      for (const [method, op] of Object.entries(item) as Array<[HttpMethod, Operation | undefined]>) {
        if (!op) continue;
        let name = slug(op.operationId).slice(0, 64);
        if (used.has(name)) name = `${slug(api.name)}_${slug(op.operationId)}`.slice(0, 64);
        for (let n = 2; used.has(name); n++) name = `${name.slice(0, 60)}_${n}`;
        used.add(name);
        out.push(toolFor(api, ver, path, method, op, name));
        if (out.length >= MAX_TOOLS) return out;
      }
    }
  }
  return out;
}

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };
const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolText = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function callTool(tool: SimTool, args: Record<string, unknown>): Promise<ReturnType<typeof toolText>> {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  let path = tool.path;
  for (const m of [...tool.path.matchAll(/\{([^}]+)\}/g)]) {
    const v = obj(args.pathParams)[m[1]];
    if (v === undefined || v === null || v === '') return toolText(`Missing path value "${m[1]}": give it in pathParams.`, true);
    path = path.replace(`{${m[1]}}`, encodeURIComponent(String(v)));
  }
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(obj(args.query))) if (v !== undefined && v !== null) search.set(k, String(v));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(args.headers))) if (typeof v === 'string' && !/[\r\n]/.test(v) && /^[A-Za-z0-9-]{1,64}$/.test(k)) headers[k] = v;
  if (typeof args.clientAuthorization === 'string' && args.clientAuthorization && !/[\r\n]/.test(args.clientAuthorization)) headers.authorization = args.clientAuthorization;

  const hasBody = args.body !== undefined && args.body !== null;
  const rawBody = hasBody ? Buffer.from(JSON.stringify(args.body)) : Buffer.alloc(0);
  if (hasBody) headers['content-type'] = 'application/json';

  const rules = await getSimulationRepository().listRules(tool.api.id);
  const out = await answerCall(tool.api, tool.ver, rules, {
    method: tool.method.toUpperCase(), path, search: search.size ? `?${search}` : '', headers, rawBody, body: hasBody ? args.body : undefined,
  });
  if (out.delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(out.delayMs, MAX_DELAY_MS)));

  let shown = out.text;
  try { shown = JSON.stringify(JSON.parse(out.text), null, 2); } catch { /* not JSON: show as is */ }
  if (shown.length > MAX_TEXT) shown = `${shown.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters)`;
  const where = out.mode === 'live' ? 'live API' : 'simulated';
  const note = out.warnings ? ` · ${out.warnings} note${out.warnings === 1 ? '' : 's'} (a rule the document states in words may apply)` : '';
  console.log(`[api-sim] mcp ${tool.api.project_id}/${tool.api.id} ${tool.method.toUpperCase()} ${path} -> ${out.status} ${out.source}`);
  return toolText(`HTTP ${out.status} (${where})${note}\n${shown}`, out.status >= 500);
}

export function registerSimMcpRoutes(): void {
  router.get('/api/projects/:id/sim/mcp-info', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const tools = await buildTools(req.params.id);
    sendJson(res, 200, {
      path: `/api/sim-mcp/${encodeURIComponent(req.params.id)}`,
      tools: tools.map((t) => ({ name: t.name, api: t.api.name, method: t.method.toUpperCase(), path: t.path, readOnly: t.annotations.readOnlyHint })),
    });
  });

  router.rawGet('/api/sim-mcp/:projectId', (_req: PortalRequest, res: PortalResponse): void => {
    sendJson(res, 405, { error: 'This MCP endpoint is stateless. Use POST with a JSON-RPC request.' });
  });

  // No CSRF check on this route, so only an API token may use it (a browser session could be driven by another site).
  router.rawPost('/api/sim-mcp/:projectId', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user || !req.authViaToken) { sendJson(res, 401, { error: 'Bearer token required. Cookie authentication is not accepted on this endpoint.' }); return; }
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    if (!await requireProjectAccess(req, res, req.params.projectId)) return;

    let msg: Rpc | Rpc[];
    try { msg = JSON.parse((await readRaw(req, MAX_BODY)).toString('utf8')) as Rpc | Rpc[]; } catch { sendJson(res, 400, fail(null, -32700, 'Parse error')); return; }

    const handle = async (m: Rpc): Promise<unknown | null> => {
      const params = m.params ?? {};
      if (m.id === undefined) return null; // a notification: nothing to answer
      switch (m.method) {
        case 'initialize':
          return ok(m.id, { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'agent-portal-api-simulation', version: '1.0.0' } });
        case 'ping':
          return ok(m.id, {});
        case 'tools/list': {
          const tools = await buildTools(req.params.projectId);
          return ok(m.id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) });
        }
        case 'tools/call': {
          const name = String(params.name ?? '');
          const tool = (await buildTools(req.params.projectId)).find((t) => t.name === name);
          if (!tool) return ok(m.id, toolText(`There is no simulated API tool called "${name}". List the tools to see what is available.`, true));
          const a = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
          try { return ok(m.id, await callTool(tool, a)); } catch (e) { return ok(m.id, toolText(`The call failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`, true)); }
        }
        default:
          return fail(m.id, -32601, `Method not found: ${m.method}`);
      }
    };

    if (Array.isArray(msg)) {
      const answers = (await Promise.all(msg.slice(0, 20).map(handle))).filter((x) => x !== null);
      if (answers.length === 0) { res.writeHead(202); res.end(); return; }
      sendJson(res, 200, answers);
      return;
    }
    const answer = await handle(msg);
    if (answer === null) { res.writeHead(202); res.end(); return; }
    sendJson(res, 200, answer);
  });
}
