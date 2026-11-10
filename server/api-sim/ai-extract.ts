/**
 * Reading an API specification out of a Word or Excel document of ANY layout, with AI.
 *
 * Such documents differ from one project to the next, so nothing here knows a layout. The document is turned into text
 * (headings, paragraphs and tables kept, by server/convert.ts), cut into sections at its headings, and read in two steps:
 *   1. an outline: which sections describe which API, and which hold general information (base URLs, status codes, ...);
 *   2. one call per API that returns a description in a fixed JSON shape.
 * What the model returns is never trusted: `normalizeExtractedApi` rebuilds a draft specification from it, drops what is
 * malformed, and flags everything a person should check. Postman and OpenAPI files do not come through here.
 */

import type { ApiSpec, Flag, HttpMethod, Operation, Parameter, Schema } from './types.ts';
import { inferSchema } from './postman.ts';

// ── Document text ─────────────────────────────────────────────────────────────

export interface Section { id: number; level: number; title: string; body: string }

/** Cuts the text at its headings (not those inside code fences). Text before the first heading is section 0. */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let cur: { level: number; title: string; lines: string[] } = { level: 0, title: '(start of document)', lines: [] };
  let fenced = false;
  const push = (): void => {
    const body = cur.lines.join('\n').trim();
    if (body || cur.level > 0) sections.push({ id: sections.length, level: cur.level, title: cur.title, body });
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const h = !fenced ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (h) { push(); cur = { level: h[1].length, title: h[2].replace(/\s+/g, ' ').trim().slice(0, 200), lines: [] }; } else cur.lines.push(line);
  }
  push();
  return sections;
}

/**
 * Removes the noise a spreadsheet leaves in a text table: empty trailing columns, rows with nothing in them, and the
 * "Column 12" headings made up for unnamed columns.
 */
export function compactMarkdown(markdown: string): string {
  const out: string[] = [];
  let cols = 0;
  let droppedHeader = false;
  // Word puts symbol-font glyphs (private-use characters) in front of headings and bullets; they carry no meaning.
  for (const line of markdown.replace(/[\uE000-\uF8FF]/g, '').split('\n')) {
    if (!line.trimStart().startsWith('|')) { out.push(line); cols = 0; droppedHeader = false; continue; }
    const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    if (/^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*$/.test(inner)) {
      if (droppedHeader) { droppedHeader = false; continue; }
      out.push(`| ${Array.from({ length: Math.max(cols, 1) }, () => '---').join(' | ')} |`);
      continue;
    }
    const cells = inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/^Column \d+$/, ''));
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) { droppedHeader = true; continue; }
    droppedHeader = false;
    cols = cells.length;
    out.push(`| ${cells.join(' | ')} |`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── Step 1: the outline ───────────────────────────────────────────────────────

export interface Outline {
  shared: number[];
  apis: Array<{ name: string; sections: number[] }>;
  baseUrls: Array<{ label: string; url: string }>;
  notes: string[];
}

export const OUTLINE_SYSTEM = [
  'You read the table of contents of API documentation, from a Word or Excel file of any layout, and say which parts describe which API.',
  'Reply with one JSON object and nothing else:',
  '{"shared": [section ids], "apis": [{"name": string, "sections": [section ids]}], "baseUrls": [{"label": string, "url": string}], "notes": [string]}',
  '"shared": sections with general information that applies to every API: base URLs, authentication, common headers, status codes, conventions, code or value lists.',
  '"apis": one entry per API, meaning one HTTP operation (a method and a path). "sections" lists every section that belongs to that API: its description, request, response, field tables and samples, including the sub-sections under its title.',
  'Ignore cover pages, version history, diagrams, process flows and anything that is not about an API.',
  'A section belongs to one API at most. Use only the section ids you are given. If you cannot tell, list fewer APIs rather than guess.',
  '"baseUrls": only addresses that appear in the text, with the label the text gives them (for example UAT or PROD). "notes": at most 5 short remarks.',
].join('\n');

const flat = (s: string, n: number): string => s.replace(/[|]/g, ' ').replace(/-{3,}/g, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The outline request: every section with its title, size and the start of its text. `budget` is how many characters it may
 * take; when the document is too long for it the first characters of each section are dropped, and then sections from the end.
 */
export function outlineUser(sections: Section[], budget = Infinity): string {
  const head = 'Sections of the document:\n';
  const more = '\n(more sections follow but are not listed)';
  const line = (s: Section, detail: number) => `[${s.id}] ${'#'.repeat(Math.max(1, s.level))} ${s.title} · ${s.body.split('\n').length} lines${detail > 0 ? ` · ${flat(s.body, detail)}` : ''}`;
  const listed = sections.slice(0, 500);
  for (const detail of [150, 60, 0]) {
    const lines = listed.map((s) => line(s, detail));
    const text = `${head}${lines.join('\n')}${sections.length > 500 ? more : ''}`;
    if (text.length <= budget) return text;
    if (detail === 0) {
      // Even titles alone are too long: keep as many sections as fit.
      let used = head.length + more.length;
      const fit: string[] = [];
      for (const l of lines) { if (used + l.length + 1 > budget) break; fit.push(l); used += l.length + 1; }
      return `${head}${fit.join('\n')}${more}`;
    }
  }
  return head;
}

export function extractJsonObject(text: string): unknown {
  const t = text.replace(/\u001b\[[0-9;]*m/g, '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const candidates = [fenced?.[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1), t].filter((x): x is string => Boolean(x));
  for (const c of candidates) {
    try { const v = JSON.parse(c.trim()); if (v && typeof v === 'object') return v; } catch { /* try the next */ }
  }
  return null;
}

export function parseOutline(raw: unknown, sectionCount: number): { outline: Outline | null; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { outline: null, problems: ['The model did not return an outline.'] };
  const o = raw as Record<string, unknown>;
  // A number, or text that is only digits. null, '' and booleans must not become 0.
  const toId = (x: unknown): number => (typeof x === 'number' ? x : typeof x === 'string' && /^\s*\d+\s*$/.test(x) ? Number(x) : NaN);
  const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(toId).filter((n) => Number.isInteger(n) && n >= 0 && n < sectionCount) : []);
  const taken = new Set<number>();
  const apis: Outline['apis'] = [];
  for (const a of Array.isArray(o.apis) ? o.apis.slice(0, 60) : []) {
    const r = (a ?? {}) as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 120) : '';
    const secs = [...new Set(ids(r.sections))].filter((n) => !taken.has(n)).sort((x, y) => x - y);
    if (!name || secs.length === 0) { problems.push(`An API entry without a name or sections was ignored.`); continue; }
    secs.forEach((n) => taken.add(n));
    apis.push({ name, sections: secs });
  }
  const shared = [...new Set(ids(o.shared))].filter((n) => !taken.has(n)).sort((x, y) => x - y);
  const baseUrls: Outline['baseUrls'] = [];
  for (const b of Array.isArray(o.baseUrls) ? o.baseUrls.slice(0, 10) : []) {
    const r = (b ?? {}) as Record<string, unknown>;
    if (typeof r.url === 'string' && /^https?:\/\/\S+$/i.test(r.url.trim())) baseUrls.push({ label: typeof r.label === 'string' ? r.label.trim().slice(0, 40) : '', url: r.url.trim().slice(0, 500) });
  }
  const notes = (Array.isArray(o.notes) ? o.notes : []).filter((n): n is string => typeof n === 'string').slice(0, 5).map((n) => n.slice(0, 300));
  if (apis.length === 0) problems.push('The model found no APIs in the document.');
  return { outline: { shared, apis, baseUrls, notes }, problems };
}

// ── Step 2: one API ───────────────────────────────────────────────────────────

export const API_SYSTEM = [
  'You read the documentation of ONE API, from a Word or Excel file of any layout converted to text, and describe it as JSON. Reply with one JSON object and nothing else.',
  '{"name": string, "description": string, "method": "GET"|"POST"|"PUT"|"PATCH"|"DELETE"|null, "path": string|null, "auth": "bearer"|"none"|"other"|"unknown",',
  ' "headers": [{"name": string, "required": boolean|null, "description": string}],',
  ' "query": [{"name": string, "type": string, "required": boolean|null, "description": string}],',
  ' "request": {"fields": [Field], "example": any|null} | null,',
  ' "responses": [{"status": number, "description": string, "fields": [Field]|null, "example": any|null}],',
  ' "notes": [string]}',
  'Field = {"name": string, "type": "string"|"number"|"integer"|"boolean"|"object"|"array", "required": boolean|null, "description": string, "maxLength": number|null, "allowed": [string|number]|null, "children": [Field]|null, "itemType": "string"|"number"|"integer"|"boolean"|"object"|null, "conditional": string|null}',
  'Rules:',
  '- Use only what the text says. Never invent fields, paths, types or values. Where the text does not say, use null ("required": null means the document does not say).',
  '- "path" is the URL path as written, without the host. "headers" excludes Content-Type, Accept and Authorization. A bearer token or "Authorization: Bearer ..." means "auth": "bearer".',
  '- Nested objects: when a field is an object, or a list of objects, and the text defines its fields in a table or sample, put them in "children" (for a list: "type": "array", "itemType": "object").',
  '- Type words: String/Text/Varchar -> string; Numeric/Decimal/Float/Double -> number; Int/Integer/Long -> integer; Boolean -> boolean; Object/Map -> object; List/Array/array[...] -> array; dates are strings.',
  '- "required": true for Mandatory, M or Required; false for Optional or O. A rule such as "mandatory when X" is not a plain yes: set "required": false and write the rule in "conditional".',
  '- A length such as 20 or "50 characters" is "maxLength". A list of valid values, even one written in a remark, is "allowed".',
  '- Every sample answer or error in the text is its own entry in "responses", with the HTTP status (the StatusCode or code the sample shows) and the sample as "example". Put the field definitions on the success answer. For an error sample, "fields" is null.',
  '- "notes": at most 5 short remarks about anything unclear, contradictory or missing that a person should check.',
].join('\n');

export function apiUser(name: string, shared: string, text: string): string {
  return `GENERAL INFORMATION FROM THE SAME DOCUMENT (applies to every API):\n${shared || '(none)'}\n\nTHE API TO DESCRIBE (the document calls it "${name}"):\n${text}`;
}

// ── Checking and rebuilding what the model said ───────────────────────────────

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const TYPE_WORDS: Record<string, Schema['type']> = {
  string: 'string', text: 'string', varchar: 'string', char: 'string', date: 'string', datetime: 'string', timestamp: 'string', uuid: 'string',
  number: 'number', numeric: 'number', decimal: 'number', float: 'number', double: 'number',
  integer: 'integer', int: 'integer', long: 'integer', boolean: 'boolean', bool: 'boolean',
  object: 'object', map: 'object', json: 'object', array: 'array', list: 'array',
};
const MAX_FIELDS = 800;
const MAX_DEPTH = 8;
const MAX_EXAMPLE_CHARS = 20_000;

export function slugOf(s: string): string {
  const parts = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (parts.length === 0) return 'api';
  return parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join('');
}

interface Ctx { flags: Flag[]; count: number; anyRequiredKnown: boolean }

function typeOf(raw: unknown): Schema['type'] | null {
  const key = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return TYPE_WORDS[key] ?? null;
}

function fieldsToObject(fields: unknown, ctx: Ctx, at: string, depth: number): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  if (!Array.isArray(fields) || depth > MAX_DEPTH) return { type: 'object', properties };
  for (const f of fields) {
    if (ctx.count >= MAX_FIELDS) { ctx.flags.push({ code: 'TOO_MANY_FIELDS', severity: 'warning', at, message: `More than ${MAX_FIELDS} fields: the rest were left out.` }); break; }
    if (!f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name || name.length > 120 || name in properties) continue;
    ctx.count++;
    const here = `${at}.${name}`;
    let type = typeOf(r.type);
    const children = Array.isArray(r.children) && r.children.length > 0 ? r.children : null;
    if (!type) {
      type = children ? 'object' : 'string';
      ctx.flags.push({ code: 'TYPE_ASSUMED', severity: 'warning', at: here, message: `${name}: the type "${String(r.type ?? '')}" was not understood; ${type} assumed.` });
    }
    const s: Schema = {};
    if (typeof r.description === 'string' && r.description.trim()) s.description = r.description.trim().slice(0, 500);

    if (type === 'object') {
      const o = fieldsToObject(children, ctx, here, depth + 1);
      s.type = 'object';
      s.properties = o.properties;
      if (o.required) s.required = o.required;
    } else if (type === 'array') {
      s.type = 'array';
      const itemType = typeOf(r.itemType) ?? (children ? 'object' : null);
      if (itemType === 'object') {
        const o = fieldsToObject(children, ctx, here, depth + 1);
        s.items = { type: 'object', properties: o.properties, ...(o.required ? { required: o.required } : {}) };
      } else {
        s.items = { type: itemType && itemType !== 'array' ? itemType : 'string' };
        if (!itemType) ctx.flags.push({ code: 'EMPTY_ARRAY_ITEMS', severity: 'warning', at: here, message: `${name} is a list with no item type given; strings assumed.` });
      }
    } else {
      s.type = type;
      if (type === 'string' && typeof r.maxLength === 'number' && Number.isInteger(r.maxLength) && r.maxLength > 0 && r.maxLength <= 100000) s.maxLength = r.maxLength;
      if (Array.isArray(r.allowed) && r.allowed.length > 0) {
        const vals = r.allowed.filter((v) => typeof v === 'string' || typeof v === 'number').slice(0, 100);
        if (vals.length > 0) {
          s.enum = type === 'string' ? vals.map(String) : vals.map(Number).filter((n) => Number.isFinite(n));
          if (s.enum.length === 0) delete s.enum;
        }
      }
    }
    if (typeof r.conditional === 'string' && r.conditional.trim()) {
      s['x-conditional'] = r.conditional.trim().slice(0, 600);
      ctx.flags.push({ code: 'CONDITIONAL_RULE', severity: 'warning', at: here, message: `${name} is conditional and is not enforced: ${s['x-conditional'].split('\n')[0].slice(0, 160)}` });
    }
    if (r.required === true) required.push(name);
    if (typeof r.required === 'boolean') ctx.anyRequiredKnown = true;
    properties[name] = s;
  }
  const out: Schema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  return out;
}

function cleanPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim().replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/<([A-Za-z0-9_]+)>/g, '{$1}').replace(/\/:([A-Za-z0-9_]+)/g, '/{$1}');
  p = p.replace(/\/{2,}/g, '/');
  if (!p) return null;
  if (!p.startsWith('/')) p = `/${p}`;
  return /^\/[A-Za-z0-9\-._~/{}]*$/.test(p) && p.length <= 200 ? p : null;
}

function jsonExample(v: unknown): unknown | undefined {
  if (v === null || v === undefined || typeof v !== 'object') return undefined;
  try { return JSON.stringify(v).length <= MAX_EXAMPLE_CHARS ? v : undefined; } catch { return undefined; }
}

export interface Extracted { name: string; spec: ApiSpec; flags: Flag[] }

/** Rebuilds a draft specification from the model's description, dropping what is malformed. */
export function normalizeExtractedApi(raw: unknown, fallbackName: string, takenIds: Set<string>): Extracted | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The model did not return a description of the API.' };
  const r = raw as Record<string, unknown>;
  const name = (typeof r.name === 'string' && r.name.trim() ? r.name.trim() : fallbackName).slice(0, 120);
  const ctx: Ctx = { flags: [], count: 0, anyRequiredKnown: false };
  const flags = ctx.flags;

  const methodRaw = typeof r.method === 'string' ? r.method.trim().toUpperCase() : '';
  let method = (METHODS.has(methodRaw) ? methodRaw : '') as HttpMethod | '';
  if (!method) {
    flags.push({ code: 'NO_METHOD', severity: 'warning', message: 'The document does not give an HTTP method for this API; POST is assumed.' });
    method = 'post';
  } else method = method.toLowerCase() as HttpMethod;

  let operationId = slugOf(name);
  while (takenIds.has(operationId)) operationId += '_';
  takenIds.add(operationId);

  const path = cleanPath(r.path);
  if (!path) {
    flags.push({ code: 'MISSING_PATH', severity: 'warning', message: `The document gives no usable URL path for ${name}${typeof r.path === 'string' && r.path.trim() ? ` (it says "${r.path.trim().slice(0, 80)}")` : ''}. Enter it before approving; "/${operationId}" is a placeholder.` });
  }

  const parameters: Parameter[] = [];
  for (const q of Array.isArray(r.query) ? r.query.slice(0, 50) : []) {
    const o = (q ?? {}) as Record<string, unknown>;
    const pn = typeof o.name === 'string' ? o.name.trim() : '';
    if (!pn || pn.length > 100) continue;
    parameters.push({ name: pn, in: 'query', required: o.required === true, schema: { type: typeOf(o.type) === 'integer' || typeOf(o.type) === 'number' || typeOf(o.type) === 'boolean' ? typeOf(o.type)! : 'string' }, ...(typeof o.description === 'string' && o.description.trim() ? { description: o.description.trim().slice(0, 300) } : {}) });
  }
  for (const h of Array.isArray(r.headers) ? r.headers.slice(0, 20) : []) {
    const o = (h ?? {}) as Record<string, unknown>;
    const hn = typeof o.name === 'string' ? o.name.trim() : '';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(hn) || /^(content-type|accept|authorization)$/i.test(hn)) continue;
    parameters.push({ name: hn, in: 'header', required: o.required === true, schema: { type: 'string' }, ...(typeof o.description === 'string' && o.description.trim() ? { description: o.description.trim().slice(0, 300) } : {}) });
  }

  const op: Operation = { operationId, summary: name, responses: {} };

  const request = r.request && typeof r.request === 'object' ? (r.request as Record<string, unknown>) : null;
  if (request) {
    let schema = Array.isArray(request.fields) && request.fields.length > 0 ? fieldsToObject(request.fields, ctx, 'request', 0) : null;
    const ex = jsonExample(request.example);
    if (!schema && ex !== undefined) { schema = inferSchema(ex); flags.push({ code: 'SCHEMA_INFERRED', severity: 'warning', at: 'request', message: 'The request fields were inferred from an example in the document; check types and which fields are required.' }); }
    if (schema && Object.keys(schema.properties ?? {}).length > 0) {
      if (method === 'get') {
        for (const [pn, sub] of Object.entries(schema.properties ?? {})) parameters.push({ name: pn, in: 'query', required: schema.required?.includes(pn) ?? false, schema: sub });
        flags.push({ code: 'GET_BODY_AS_QUERY', severity: 'info', message: 'The document lists request fields for a GET; they are treated as query parameters.' });
      } else {
        op.requestBody = { required: true, content: { 'application/json': { schema } } };
      }
    }
  }
  if (parameters.length > 0) op.parameters = parameters;

  const rawResponses = Array.isArray(r.responses) ? r.responses.slice(0, 20) : [];
  for (const resp of rawResponses) {
    const o = (resp ?? {}) as Record<string, unknown>;
    const status = Number(o.status);
    if (!Number.isInteger(status) || status < 100 || status > 599 || op.responses[String(status)]) continue;
    const ex = jsonExample(o.example);
    const fields = Array.isArray(o.fields) && o.fields.length > 0 ? fieldsToObject(o.fields, ctx, `response.${status}`, 0) : null;
    const schema = fields ?? (ex !== undefined ? inferSchema(ex) : null);
    if (!fields && ex !== undefined && status < 300) flags.push({ code: 'SCHEMA_INFERRED', severity: 'warning', at: `response.${status}`, message: `The ${status} response fields were inferred from the sample in the document; check them.` });
    op.responses[String(status)] = {
      description: typeof o.description === 'string' && o.description.trim() ? o.description.trim().slice(0, 200) : String(status),
      ...(schema ? { content: { 'application/json': { schema, ...(ex !== undefined ? { example: ex } : {}) } } } : {}),
    };
  }
  if (!Object.keys(op.responses).some((c) => /^2\d\d$/.test(c))) {
    flags.push({ code: 'NO_RESPONSE', severity: 'warning', message: 'No success response was found in the document, so the answer has no fields.' });
    op.responses['200'] = { description: 'Success', content: { 'application/json': { schema: { type: 'object', properties: {} } } } };
  }
  if (Object.keys(op.responses).some((c) => !/^2\d\d$/.test(c))) {
    flags.push({ code: 'ERROR_SAMPLES', severity: 'info', message: 'The document shows answers for other statuses (errors). They are kept with the specification; make a mock rule from one to simulate it.' });
  }

  const auth = typeof r.auth === 'string' ? r.auth : 'unknown';
  if (auth === 'bearer') op.security = [{ bearerAuth: [] }];
  else if (auth === 'other') flags.push({ code: 'AUTH_OTHER', severity: 'warning', message: 'The document describes a kind of login this tool does not simulate; the API is treated as open.' });
  else if (auth === 'unknown') flags.push({ code: 'AUTH_UNKNOWN', severity: 'info', message: 'The document does not say whether this API needs a login token; none is required.' });

  if (request && !ctx.anyRequiredKnown) {
    flags.push({ code: 'REQUIRED_UNKNOWN', severity: 'warning', message: 'The document does not say which request fields are required, so none is marked required. Confirm against the client.' });
  }
  flags.push({ code: 'AI_EXTRACTED', severity: 'info', message: 'Read from the document by AI. Check the fields, types and which fields are required against the original.' });
  for (const n of (Array.isArray(r.notes) ? r.notes : []).filter((x): x is string => typeof x === 'string').slice(0, 5)) {
    flags.push({ code: 'AI_NOTE', severity: 'info', message: n.trim().slice(0, 300) });
  }
  op['x-flags'] = flags;

  const finalPath = path ?? `/${operationId}`;
  const spec: ApiSpec = {
    openapi: '3.0.3',
    info: { title: name, version: '1' },
    paths: { [finalPath]: { [method]: op } },
    ...(op.security ? { components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } } : {}),
  };
  return { name, spec, flags };
}

// ── The whole read ────────────────────────────────────────────────────────────

export type ModelCall = (system: string, user: string, maxTokens: number) => Promise<string>;

export interface ExtractionResult {
  drafts: Array<{ key: string; name: string; spec: ApiSpec }>;
  baseUrls: Outline['baseUrls'];
  notes: string[];
  errors: Array<{ api: string; message: string }>;
}

export interface Progress { phase: 'outline' | 'extract'; done: number; total: number; current?: string }

const SHARED_CAP = 12_000;
const API_CAP = 100_000;
const MAX_APIS = 40;

function textOf(sections: Section[], ids: number[], cap: number): { text: string; cut: boolean } {
  const parts = ids.map((i) => sections[i]).filter(Boolean).map((s) => `${s.level > 0 ? `${'#'.repeat(s.level)} ${s.title}\n` : ''}${s.body}`);
  const text = parts.join('\n\n');
  return text.length > cap ? { text: `${text.slice(0, cap)}\n[... cut: the text is longer than the limit ...]`, cut: true } : { text, cut: false };
}

/** What the model behind `call` accepts: `promptChars` is the most system and user text together in one request. */
export interface ExtractionLimits { promptChars?: number }

// What apiUser adds around the two texts, and room for the name and the model's own formatting.
const API_WRAPPER_CHARS = 600;

export async function extractApis(markdown: string, call: ModelCall, onProgress?: (p: Progress) => void | Promise<void>, limits: ExtractionLimits = {}): Promise<ExtractionResult> {
  const sections = splitSections(compactMarkdown(markdown));
  const result: ExtractionResult = { drafts: [], baseUrls: [], notes: [], errors: [] };
  if (sections.length === 0) { result.errors.push({ api: '(document)', message: 'The document has no text to read.' }); return result; }

  await onProgress?.({ phase: 'outline', done: 0, total: 1 });
  let outline: Outline | null = null;
  let problems: string[] = [];
  try {
    const text = await call(OUTLINE_SYSTEM, outlineUser(sections, limits.promptChars ? limits.promptChars - OUTLINE_SYSTEM.length : Infinity), 4096);
    ({ outline, problems } = parseOutline(extractJsonObject(text), sections.length));
  } catch (e) {
    result.errors.push({ api: '(outline)', message: `The model could not be used: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` });
    return result;
  }
  result.notes.push(...problems);
  if (!outline || outline.apis.length === 0) {
    result.errors.push({ api: '(outline)', message: problems[0] ?? 'No APIs were found in the document.' });
    return result;
  }
  result.baseUrls = outline.baseUrls;
  result.notes.push(...outline.notes);

  // The general information is at most a sixth of what the model takes, and each API gets the rest.
  const sharedCap = limits.promptChars ? Math.min(SHARED_CAP, Math.floor(limits.promptChars / 6)) : SHARED_CAP;
  const shared = textOf(sections, outline.shared, sharedCap).text;
  const apis = outline.apis.slice(0, MAX_APIS);
  if (outline.apis.length > MAX_APIS) result.notes.push(`Only the first ${MAX_APIS} of ${outline.apis.length} APIs were read.`);
  const taken = new Set<string>();

  for (let i = 0; i < apis.length; i++) {
    const a = apis[i];
    await onProgress?.({ phase: 'extract', done: i, total: apis.length, current: a.name });
    const apiCap = limits.promptChars
      ? Math.max(2000, Math.min(API_CAP, limits.promptChars - API_SYSTEM.length - shared.length - API_WRAPPER_CHARS - a.name.length))
      : API_CAP;
    const body = textOf(sections, a.sections, apiCap);
    let extracted: Extracted | { error: string } = { error: 'No answer' };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await call(API_SYSTEM, apiUser(a.name, shared, body.text), 12_000);
        extracted = normalizeExtractedApi(extractJsonObject(text), a.name, taken);
        if (!('error' in extracted)) break;
      } catch (e) {
        extracted = { error: `The model could not be used: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
        break;
      }
    }
    if ('error' in extracted) { result.errors.push({ api: a.name, message: extracted.error }); continue; }
    if (body.cut) {
      const op = Object.values(Object.values(extracted.spec.paths)[0])[0]!;
      op['x-flags']!.push({ code: 'TEXT_CUT', severity: 'warning', message: `This API's text was longer than the limit (${apiCap.toLocaleString('en-US')} characters) and was cut, so later fields may be missing.` });
    }
    result.drafts.push({ key: `ai:${slugOf(extracted.name)}`, name: extracted.name, spec: extracted.spec });
  }
  await onProgress?.({ phase: 'extract', done: apis.length, total: apis.length });
  return result;
}
