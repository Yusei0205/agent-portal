/**
 * Deterministic reader for a client's API requirement workbook (one sheet = one API), producing a DRAFT OpenAPI spec
 * per API plus a list of flags for a person to review. No AI here: this is the part that must be repeatable. A later
 * step may enrich the draft (types, enums, conditional rules) but never replaces this structure.
 *
 * Layout it understands (found in the FLASH/ISD3 sample, v1.9):
 *   "1. Request" / "2. Response" markers in column A
 *   label rows:   API Name | Method | Authentication | Content-Type
 *   field tables: NO. | FIELD NAME | (M)andatory... | Data Type | Data Length | FIELD NAME DESCRIPTION | REMARKS ...
 *   nesting lives in the NO. column: "11.[n].10.[m].2" = list 11 > list 10 > field 2; "11.[n]" rows only mark an array.
 * Columns are found by header text because they move between sheets; the extra columns (Screen Code, ...) are ignored.
 */

import type { ApiSpec, Flag, HttpMethod, Operation, Parameter, Schema } from './types.ts';

export type Grid = string[][];

export interface FieldNode {
  no: string;
  name: string;
  mandatory: string;
  dataType: string;
  length: string;
  description: string;
  remarks: string;
  children: FieldNode[];
  /** A "11.[n]" row was present: this field is a list of its children. */
  listMarker: boolean;
}

export interface ParsedApi {
  sheet: string;
  apiName: string;
  method: string;
  authentication: string;
  contentType: string;
  requestHeaders: FieldNode[];
  hasBearer: boolean;
  request: FieldNode[];
  response: FieldNode[];
  /** The response table says "Refer to <sheet> worksheet response" instead of listing fields. */
  responseRef?: string;
  flags: Flag[];
}

const MARKER_REQUEST = /^\s*\d+\s*\.\s*request\b/i;
const MARKER_RESPONSE = /^\s*\d+\s*\.\s*response\b/i;
const NO_RE = /^\d+(\.(\d+|\[[a-z]\]))*$/i;
const TYPE_WORDS = new Set(['string', 'numeric', 'number', 'integer', 'object', 'array', 'boolean', 'date', 'datetime', '-']);
const MANDATORY_WORDS = new Set(['m', 'o', 'c', 'cm', 'n', 'e', 'echo', 'mandatory', 'optional', 'conditional']);

interface ColumnMap { no: number; name: number; mandatory: number; type: number; length: number; desc: number; remarks: number[] }

function norm(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

function headerMap(row: string[]): ColumnMap | null {
  // "(M)andatory or (O)ptional" has its first letter in parentheses, so drop them before comparing.
  const lc = row.map((c) => norm(c.replace(/[()]/g, '')).toLowerCase());
  const name = lc.indexOf('field name');
  const type = lc.findIndex((c) => c === 'data type');
  if (name < 0 || type < 0) return null;
  return {
    no: lc.findIndex((c) => c === 'no.' || c === 'no'),
    name,
    mandatory: lc.findIndex((c) => c.includes('mandatory')),
    type,
    length: lc.findIndex((c) => c === 'data length'),
    desc: lc.findIndex((c) => c.startsWith('field name description')),
    remarks: lc.map((c, i) => (c.includes('remark') ? i : -1)).filter((i) => i >= 0),
  };
}

function cell(row: string[], i: number): string { return i >= 0 && i < row.length ? norm(row[i] ?? '') : ''; }

/** Like `cell` but keeps line breaks: remarks use them to lay out lists such as "Valid Values". */
function multiline(row: string[], i: number): string {
  return i >= 0 && i < row.length ? (row[i] ?? '').split(/\r?\n/).map(norm).join('\n').trim() : '';
}

/**
 * Reads one data row. Some rows (request headers) are shifted by a column, so when the mapped cells do not hold a
 * recognised type / mandatory word, the neighbouring cells are searched.
 */
function readRow(row: string[], m: ColumnMap): FieldNode | null {
  const no = cell(row, m.no >= 0 ? m.no : 0);
  if (!NO_RE.test(no)) return null;
  let name = cell(row, m.name);
  let type = cell(row, m.type);
  let mandatory = cell(row, m.mandatory);
  let length = cell(row, m.length);
  let desc = cell(row, m.desc);
  if (!TYPE_WORDS.has(type.toLowerCase())) {
    const at = row.findIndex((c, i) => i > m.name && TYPE_WORDS.has(norm(c).toLowerCase()) && norm(c) !== '-');
    if (at >= 0) {
      type = cell(row, at);
      mandatory = row.slice(m.name + 1, at).map(norm).find((c) => MANDATORY_WORDS.has(c.toLowerCase())) ?? mandatory;
      length = cell(row, at + 1);
      desc = cell(row, at + 2);
    }
  }
  const remarks = m.remarks.map((i) => multiline(row, i)).filter(Boolean).join('\n');
  return { no, name, mandatory, dataType: type, length, description: desc, remarks, children: [], listMarker: false };
}

/** Turns the flat rows of one table into a tree using the NO. column. */
export function buildTree(rows: FieldNode[], flags: Flag[], where: string): FieldNode[] {
  const roots: FieldNode[] = [];
  const byChain = new Map<string, FieldNode>();
  for (const r of rows) {
    const tokens = r.no.split('.');
    const chain = tokens.filter((t) => /^\d+$/.test(t));
    const key = chain.join('.');
    const isMarker = /^\[[a-z]\]$/i.test(tokens[tokens.length - 1] ?? '') || r.name === '-';
    if (isMarker) {
      const owner = byChain.get(key);
      if (owner) owner.listMarker = true;
      continue;
    }
    byChain.set(key, r);
    if (chain.length === 1) { roots.push(r); continue; }
    const parent = byChain.get(chain.slice(0, -1).join('.'));
    if (!parent) {
      flags.push({ code: 'ORPHAN_FIELD', severity: 'warning', at: `${where}.${r.name}`, message: `Row ${r.no} (${r.name}) has no parent row; placed at the top level.` });
      roots.push(r);
    } else {
      parent.children.push(r);
    }
  }
  return roots;
}

// ── Sheet reader ──────────────────────────────────────────────────────────────

export function isApiSheet(grid: Grid): boolean {
  let request = false;
  let header = false;
  for (const row of grid) {
    if (MARKER_REQUEST.test(row[0] ?? '')) request = true;
    if (headerMap(row)) header = true;
  }
  return request && header;
}

export function parseApiSheet(sheet: string, grid: Grid): ParsedApi {
  const api: ParsedApi = {
    sheet, apiName: '', method: '', authentication: '', contentType: '',
    requestHeaders: [], hasBearer: false, request: [], response: [], flags: [],
  };
  const tables: Record<'request' | 'response', FieldNode[][]> = { request: [], response: [] };
  let section: 'pre' | 'request' | 'response' = 'pre';
  let map: ColumnMap | null = null;
  let current: FieldNode[] | null = null;

  for (const row of grid) {
    const a = norm(row[0] ?? '');
    if (MARKER_REQUEST.test(a)) { section = 'request'; map = null; current = null; continue; }
    if (MARKER_RESPONSE.test(a)) { section = 'response'; map = null; current = null; continue; }

    const label = a.replace(/:$/, '').toLowerCase();
    if (label === 'api name' && !api.apiName) api.apiName = norm(row[1] ?? '');
    else if (label === 'method' && !api.method) api.method = norm(row[1] ?? '').toUpperCase();
    else if (label === 'authentication' && !api.authentication) api.authentication = norm(row[1] ?? '');
    else if (label === 'content-type' && !api.contentType) api.contentType = norm(row[1] ?? '');

    const hm = headerMap(row);
    if (hm && section !== 'pre') {
      map = hm;
      current = [];
      tables[section].push(current);
      continue;
    }
    if (!map || !current) continue;
    const field = readRow(row, map);
    if (field) current.push(field);
    else if (section === 'response') {
      const ref = /^refer to\s+(.+?)\s+(?:worksheet|sheet)/i.exec(a);
      if (ref) api.responseRef = ref[1];
    }
  }

  // Request: every table but the last holds headers; the last is the body.
  const reqTables = tables.request;
  const headerRows = reqTables.slice(0, -1).flat();
  const bodyRows = reqTables.length > 0 ? reqTables[reqTables.length - 1] : [];
  api.hasBearer = headerRows.some((r) => r.name.toLowerCase() === 'bearer');
  api.requestHeaders = headerRows.filter((r) => r.name && r.name.toLowerCase() !== 'bearer');
  api.request = buildTree(bodyRows, api.flags, 'request');
  const resTables = tables.response;
  api.response = buildTree(resTables.length > 0 ? resTables[resTables.length - 1] : [], api.flags, 'response');

  if (!api.apiName) api.flags.push({ code: 'NO_API_NAME', severity: 'warning', message: 'The sheet has no API Name.' });
  if (!api.method) api.flags.push({ code: 'NO_METHOD', severity: 'warning', message: 'The sheet has no HTTP method; POST is assumed.' });
  if (api.response.length === 0 && !api.responseRef) api.flags.push({ code: 'NO_RESPONSE', severity: 'warning', message: 'No response table was found.' });
  return api;
}

// ── Field tree to schema ──────────────────────────────────────────────────────

function parseEnum(remarks: string): { values: string[]; descriptions: Record<string, string> } | null {
  const at = remarks.search(/valid\s+values?\s*:/i);
  if (at < 0) return null;
  const values: string[] = [];
  const descriptions: Record<string, string> = {};
  for (const line of remarks.slice(at).split('\n').slice(1)) {
    const m = /^\s*([A-Za-z0-9_.]{1,40})\s+-\s+(.+?)\s*$/.exec(line);
    if (!m) { if (values.length > 0 && line.trim() === '') break; continue; }
    values.push(m[1]);
    descriptions[m[1]] = m[2];
  }
  return values.length > 0 ? { values, descriptions } : null;
}

function isConditional(mandatory: string): boolean {
  return /^(c|cm|conditional)$/i.test(mandatory.trim());
}

function isRequired(mandatory: string): boolean {
  return /^(m|mandatory)$/i.test(mandatory.trim());
}

function nodeToSchema(n: FieldNode, flags: Flag[], at: string): Schema {
  const t = n.dataType.toLowerCase();
  const s: Schema = {};
  if (n.description && n.description !== '-') s.description = n.description;

  const hasKids = n.children.length > 0;
  if (hasKids || n.listMarker || t === 'array') {
    if (hasKids && t !== 'object' && t !== 'array') {
      flags.push({ code: 'TYPE_MISMATCH', severity: 'info', at, message: `${n.name} is typed "${n.dataType}" but has child rows; treated as ${n.listMarker ? 'a list of objects' : 'an object'}.` });
    }
    if (!hasKids) {
      flags.push({ code: 'EMPTY_ARRAY_ITEMS', severity: 'warning', at, message: `${n.name} is an array with no child rows; item type assumed to be string.` });
      return { ...s, type: 'array', items: { type: 'string' } };
    }
    const obj = childrenToObject(n.children, flags, at);
    return n.listMarker || t === 'array' ? { ...s, type: 'array', items: obj } : { ...s, ...obj };
  }
  if (t === 'object') return { ...s, type: 'object', properties: {} };

  switch (t) {
    case 'numeric':
    case 'number':
    case 'integer': {
      const dec = /^\s*\d+\s*,\s*(\d+)\s*$/.exec(n.length);
      s.type = t === 'integer' || (dec && dec[1] === '0') ? 'integer' : 'number';
      break;
    }
    case 'boolean': s.type = 'boolean'; break;
    case 'date': s.type = 'string'; s.format = 'date'; break;
    case 'datetime': s.type = 'string'; s.format = 'date-time'; break;
    default: {
      s.type = 'string';
      if (t !== 'string') {
        flags.push({ code: 'TYPE_ASSUMED', severity: 'warning', at, message: `${n.name} has data type "${n.dataType || '(blank)'}"; string assumed.` });
      }
      const len = /^\d+$/.exec(n.length.trim());
      if (len) s.maxLength = Number(len[0]);
    }
  }

  const en = parseEnum(n.remarks);
  if (en) {
    s.enum = en.values;
    s['x-enum-descriptions'] = en.descriptions;
    flags.push({ code: 'ENUM_EXTRACTED', severity: 'info', at, message: `Allowed values for ${n.name} were read from the remarks: ${en.values.join(', ')}. Check them.` });
  }
  if (isConditional(n.mandatory)) {
    s['x-conditional'] = n.remarks.trim() || 'Conditional (see the client document)';
    flags.push({ code: 'CONDITIONAL_RULE', severity: 'warning', at, message: `${n.name} is conditional and is not enforced: ${s['x-conditional'].split('\n')[0].slice(0, 160)}` });
  }
  return s;
}

function childrenToObject(children: FieldNode[], flags: Flag[], at: string): Schema {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  for (const c of children) {
    if (!c.name) continue;
    const here = `${at}.${c.name}`;
    const schema = nodeToSchema(c, flags, here);
    if (isConditional(c.mandatory) && !schema['x-conditional']) schema['x-conditional'] = c.remarks.trim() || 'Conditional (see the client document)';
    properties[c.name] = schema;
    if (isRequired(c.mandatory)) required.push(c.name);
  }
  const out: Schema = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  return out;
}

// ── Draft OpenAPI ─────────────────────────────────────────────────────────────

export function slug(s: string): string {
  const parts = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (parts.length === 0) return 'api';
  return parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join('');
}

export interface DraftOptions {
  /** Path for this API (from the document, or typed by the team). Without it a placeholder is used and flagged. */
  path?: string;
}

export function toDraftSpec(api: ParsedApi, opts: DraftOptions = {}): ApiSpec {
  const flags: Flag[] = [...api.flags];
  const operationId = slug(api.sheet);
  const method = (api.method || 'POST').toLowerCase() as HttpMethod;
  const path = opts.path && opts.path.startsWith('/') ? opts.path : `/${operationId}`;
  if (!opts.path) {
    flags.push({ code: 'MISSING_PATH', severity: 'warning', message: `The document gives no URL path for ${api.apiName || api.sheet}. Enter it before approving; "${path}" is a placeholder.` });
  }

  const requestSchema = childrenToObject(api.request, flags, 'request');
  const responseSchema = childrenToObject(api.response, flags, 'response');

  const parameters: Parameter[] = api.requestHeaders.map((h) => ({
    name: h.name,
    in: 'header',
    required: isRequired(h.mandatory),
    schema: { type: 'string' },
    ...(h.description && h.description !== 'No limit' ? { description: h.description } : {}),
  }));

  const operation: Operation = {
    operationId,
    summary: api.apiName || api.sheet,
    responses: {
      '200': { description: 'Success', content: { 'application/json': { schema: responseSchema } } },
    },
  };
  if (method === 'get') {
    for (const [name, sub] of Object.entries(requestSchema.properties ?? {})) {
      parameters.push({ name, in: 'query', required: requestSchema.required?.includes(name) ?? false, schema: sub });
    }
  } else if (Object.keys(requestSchema.properties ?? {}).length > 0) {
    operation.requestBody = { required: true, content: { 'application/json': { schema: requestSchema } } };
  }
  if (parameters.length > 0) operation.parameters = parameters;

  const secured = api.hasBearer || /^(yes|y|bearer|jwt)$/i.test(api.authentication.trim());
  if (secured) operation.security = [{ bearerAuth: [] }];
  if (flags.length > 0) operation['x-flags'] = flags;

  return {
    openapi: '3.0.3',
    info: { title: api.apiName || api.sheet, version: '1' },
    paths: { [path]: { [method]: operation } },
    ...(secured ? { components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } } : {}),
  };
}

// ── Workbook ──────────────────────────────────────────────────────────────────

export interface WorkbookParse {
  apis: ParsedApi[];
  /** Sheets that were skipped (cover page, diagrams, ...), by name. */
  skipped: string[];
  flags: Flag[];
}

function sheetKey(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/** Copies the response of the sheet a response table points at, and says so; flags the ones that cannot be found. */
function resolveResponseRefs(apis: ParsedApi[]): void {
  for (const a of apis) {
    if (a.response.length > 0 || !a.responseRef) continue;
    const want = sheetKey(a.responseRef);
    const target = apis.find((t) => t !== a && t.response.length > 0 && sheetKey(t.sheet) === want);
    if (target) {
      a.response = structuredClone(target.response);
      a.flags.push({ code: 'RESPONSE_SHARED', severity: 'info', message: `The response is the one on sheet "${target.sheet}", as the document says. Check it is right for ${a.apiName || a.sheet}.` });
    } else {
      a.flags.push({ code: 'RESPONSE_REFERENCE_UNRESOLVED', severity: 'warning', message: `The response refers to "${a.responseRef}", but no such sheet has a response table.` });
    }
  }
}

export function parseSheets(sheets: Array<{ name: string; grid: Grid }>): WorkbookParse {
  const apis: ParsedApi[] = [];
  const skipped: string[] = [];
  for (const s of sheets) {
    if (isApiSheet(s.grid)) apis.push(parseApiSheet(s.name, s.grid));
    else skipped.push(s.name);
  }
  const flags: Flag[] = [];
  resolveResponseRefs(apis);
  const seen = new Map<string, string>();
  for (const a of apis) {
    const key = a.apiName.toLowerCase();
    if (!key) continue;
    const first = seen.get(key);
    if (first) {
      const msg = `Sheets "${first}" and "${a.sheet}" both declare the API name "${a.apiName}". One may be a copy or have the wrong name.`;
      flags.push({ code: 'DUPLICATE_API_NAME', severity: 'warning', message: msg });
      a.flags.push({ code: 'DUPLICATE_API_NAME', severity: 'warning', message: msg });
    } else {
      seen.set(key, a.sheet);
    }
  }
  return { apis, skipped, flags };
}

/** Reads a .xlsx into plain text grids. Limits keep a sheet with a runaway used range from costing memory. */
export async function readWorkbook(source: string | Buffer): Promise<Array<{ name: string; grid: Grid }>> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  if (typeof source === 'string') await wb.xlsx.readFile(source);
  else await wb.xlsx.load(source as unknown as ArrayBuffer);
  const MAX_ROWS = 3000;
  const MAX_COLS = 20;
  const out: Array<{ name: string; grid: Grid }> = [];
  wb.eachSheet((ws) => {
    const grid: Grid = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > MAX_ROWS) return;
      const cells: string[] = Array.from({ length: MAX_COLS }, () => '');
      row.eachCell({ includeEmpty: false }, (c, col) => {
        if (col <= MAX_COLS) cells[col - 1] = cellText(c.value);
      });
      grid[rowNumber - 1] = cells;
    });
    // Fill the gaps so callers can iterate without holes.
    for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
    out.push({ name: ws.name, grid });
  });
  return out;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  const o = v as { richText?: Array<{ text: string }>; text?: string; result?: unknown };
  if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('');
  if (typeof o.text === 'string') return o.text;
  if (o.result !== undefined) return cellText(o.result);
  return '';
}
