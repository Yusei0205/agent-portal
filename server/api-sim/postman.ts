/**
 * Postman collections (v2.0 / v2.1) as draft API specifications.
 *
 * A collection holds examples, not rules, so the field types are inferred from the example bodies and nothing is marked
 * required (the example cannot say). Every inferred schema is flagged for a person to check. Each top-level folder
 * becomes one API (like each Excel sheet); requests outside any folder become one API named after the collection.
 */

import type { ApiSpec, Flag, HttpMethod, Operation, Parameter, Schema } from './types.ts';

interface PmUrl { raw?: string; path?: Array<string | { value?: string }>; query?: Array<{ key?: string; value?: string; disabled?: boolean }> }
interface PmRequest {
  method?: string;
  url?: string | PmUrl;
  header?: Array<{ key?: string; value?: string; disabled?: boolean }>;
  body?: { mode?: string; raw?: string };
  auth?: { type?: string };
}
interface PmItem { name?: string; item?: PmItem[]; request?: PmRequest | string; response?: Array<{ code?: number; body?: string; name?: string }> }
interface PmCollection { info?: { name?: string; schema?: string }; item?: PmItem[]; auth?: { type?: string } }

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const MAX_DEPTH = 8;

export function looksLikePostman(v: unknown): boolean {
  const c = v as PmCollection | null;
  return Boolean(c && typeof c === 'object' && Array.isArray(c.item) && c.info && typeof c.info === 'object');
}

/** A schema inferred from an example value. Leaves keep the example so the simulation can answer with it. */
export function inferSchema(v: unknown, depth = 0): Schema {
  if (depth > MAX_DEPTH) return {};
  if (Array.isArray(v)) {
    const first = v.find((x) => x !== null && x !== undefined);
    return { type: 'array', items: first === undefined ? { type: 'string' } : inferSchema(first, depth + 1) };
  }
  switch (typeof v) {
    case 'string': return { type: 'string', example: v };
    case 'number': return { type: Number.isInteger(v) ? 'integer' : 'number', example: v };
    case 'boolean': return { type: 'boolean', example: v };
    case 'object': {
      if (v === null) return { type: 'string' };
      const properties: Record<string, Schema> = {};
      for (const [k, sub] of Object.entries(v as Record<string, unknown>)) properties[k] = inferSchema(sub, depth + 1);
      return { type: 'object', properties };
    }
    default: return {};
  }
}

function slug(s: string): string {
  const parts = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (parts.length === 0) return 'request';
  return parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join('');
}

/** The path of a request, with {{variables}} and the host removed and :id turned into {id}. */
function pathOf(url: string | PmUrl | undefined): { path: string; query: string[] } {
  let segments: string[] = [];
  const query: string[] = [];
  if (typeof url === 'string') {
    const noHost = url.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/i, '');
    const [p, q] = noHost.split('?');
    segments = p.split('/').filter(Boolean);
    if (q) q.split('&').forEach((kv) => { const k = kv.split('=')[0]; if (k) query.push(k); });
  } else if (url) {
    if (Array.isArray(url.path)) segments = url.path.map((s) => (typeof s === 'string' ? s : s.value ?? '')).filter(Boolean);
    else if (url.raw) return pathOf(url.raw);
    for (const q of url.query ?? []) if (q.key && !q.disabled) query.push(q.key);
  }
  const path = '/' + segments.map((s) => (s.startsWith(':') ? `{${s.slice(1)}}` : s.replace(/^\{\{([^}]+)\}\}$/, '{$1}'))).join('/');
  return { path: path === '/' ? '/' : path.replace(/\/+$/, ''), query: [...new Set(query)] };
}

function parseJson(raw: string | undefined): unknown | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function flatten(items: PmItem[], out: PmItem[] = []): PmItem[] {
  for (const it of items) {
    if (it.item) flatten(it.item, out);
    else if (it.request) out.push(it);
  }
  return out;
}

function toOperation(item: PmItem, taken: Set<string>, collectionAuth: boolean): { path: string; method: HttpMethod; op: Operation } | null {
  const req = typeof item.request === 'string' ? ({ method: 'GET', url: item.request } as PmRequest) : item.request;
  if (!req) return null;
  const method = String(req.method ?? 'GET').toLowerCase() as HttpMethod;
  if (!METHODS.has(method)) return null;
  const { path, query } = pathOf(req.url);
  let operationId = slug(item.name || `${method} ${path}`);
  while (taken.has(operationId)) operationId += '_';
  taken.add(operationId);

  const flags: Flag[] = [];
  const parameters: Parameter[] = [];
  for (const q of query) parameters.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
  let secured = collectionAuth || Boolean(req.auth && req.auth.type && req.auth.type !== 'noauth');
  for (const h of req.header ?? []) {
    if (!h.key || h.disabled) continue;
    const k = h.key.toLowerCase();
    if (k === 'content-type' || k === 'accept') continue;
    if (k === 'authorization') { secured = true; continue; }
    parameters.push({ name: h.key, in: 'header', required: false, schema: { type: 'string' } });
  }

  const op: Operation = { operationId, summary: item.name || operationId, responses: {} };
  if (parameters.length > 0) op.parameters = parameters;
  if (secured) op.security = [{ bearerAuth: [] }];

  const body = req.body?.mode === 'raw' ? parseJson(req.body.raw) : undefined;
  if (body !== undefined && typeof body === 'object' && body !== null) {
    op.requestBody = { required: false, content: { 'application/json': { schema: inferSchema(body) } } };
    flags.push({ code: 'SCHEMA_INFERRED', severity: 'warning', message: 'The request fields were inferred from an example body. No field is marked required and no limits are known: check them against the client\'s document.' });
  }

  for (const r of item.response ?? []) {
    const code = String(r.code ?? 200);
    if (op.responses[code]) continue;
    const rb = parseJson(r.body);
    op.responses[code] = rb !== undefined && typeof rb === 'object' && rb !== null
      ? { description: r.name ?? code, content: { 'application/json': { schema: inferSchema(rb), example: rb } } }
      : { description: r.name ?? code };
  }
  if (Object.keys(op.responses).length === 0) {
    op.responses['200'] = { description: 'Success', content: { 'application/json': { schema: { type: 'object', properties: {} } } } };
    flags.push({ code: 'NO_RESPONSE_EXAMPLE', severity: 'warning', message: 'The collection has no saved response for this request, so the answer has no fields. Add a response example in Postman, or write a mock rule.' });
  } else if (!Object.keys(op.responses).some((c) => /^2\d\d$/.test(c))) {
    op.responses['200'] = { description: 'Success', content: { 'application/json': { schema: { type: 'object', properties: {} } } } };
    flags.push({ code: 'NO_SUCCESS_EXAMPLE', severity: 'warning', message: 'The collection only has error responses saved, so a success answer has no fields.' });
  }
  if (flags.length > 0) op['x-flags'] = flags;
  return { path, method, op };
}

export interface PostmanDraft { name: string; spec: ApiSpec }

export function postmanToSpecs(collection: unknown): { drafts: PostmanDraft[]; errors: string[] } {
  if (!looksLikePostman(collection)) return { drafts: [], errors: ['That does not look like a Postman collection (it needs "info" and "item").'] };
  const c = collection as PmCollection;
  const collectionAuth = Boolean(c.auth && c.auth.type && c.auth.type !== 'noauth');
  const groups: Array<{ name: string; items: PmItem[] }> = [];
  const loose = (c.item ?? []).filter((i) => !i.item);
  if (loose.length > 0) groups.push({ name: c.info?.name || 'Collection', items: loose });
  for (const folder of (c.item ?? []).filter((i) => i.item)) groups.push({ name: folder.name || 'Folder', items: flatten(folder.item ?? []) });

  const drafts: PostmanDraft[] = [];
  const errors: string[] = [];
  for (const g of groups) {
    const taken = new Set<string>();
    const paths: ApiSpec['paths'] = {};
    let secured = false;
    for (const it of g.items) {
      const r = toOperation(it, taken, collectionAuth);
      if (!r) continue;
      if (paths[r.path]?.[r.method]) { errors.push(`${g.name}: ${r.method.toUpperCase()} ${r.path} appears twice; only the first is kept.`); continue; }
      (paths[r.path] ??= {})[r.method] = r.op;
      if (r.op.security) secured = true;
    }
    if (Object.keys(paths).length === 0) { errors.push(`${g.name}: no requests found.`); continue; }
    drafts.push({
      name: g.name,
      spec: {
        openapi: '3.0.3',
        info: { title: g.name, version: '1' },
        paths,
        ...(secured ? { components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } } : {}),
      },
    });
  }
  if (drafts.length === 0 && errors.length === 0) errors.push('The collection has no requests.');
  return { drafts, errors };
}
