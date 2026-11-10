/**
 * Stateful mocks: a mock rule can look up, save, remove or list the records an API remembers, so a POST that creates
 * something is followed by a GET that finds it. This is data-driven rather than REST-guessing, so it fits RPC-style APIs
 * too ("POST /application/update_application" then "GET /application/get_application?ApplicationNo=...").
 *
 * A rule's `store` says what to do and where the key comes from in the request; its `response.body` may use tokens:
 *   "{{record}}"            the record found or saved (a whole value keeps its type)
 *   "{{records}}"           all the records of the collection, as a list (action list)
 *   "{{record.a.b}}"        a field of that record
 *   "{{request.body.a}}"    a value from the request: request.query.x, request.header.x, request.body.a.b, request.path.id
 *   "{{key}}"               the key the record is stored under
 * Text with a token inside it has the token replaced by its value as text.
 *
 * The engine itself stays pure: it reads a snapshot of the records and returns the changes it wants made.
 */

import type { MockRequest, RuleStore } from './types.ts';
import type { RecordChange, RecordData } from '../repositories/simulation.ts';

const COLLECTION_RE = /^[A-Za-z0-9_-]{1,40}$/;
const REQUEST_PATH_RE = /^(query|header|body|path)(\.[A-Za-z0-9_-]+)*$/;
const MAX_RECORD_CHARS = 100_000;

/** Null when the store settings are fine; otherwise what is wrong. */
export function storeProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'store must be an object';
  const s = raw as Record<string, unknown>;
  if (!['find', 'save', 'remove', 'list'].includes(String(s.action))) return 'store.action must be find, save, remove or list';
  if (!COLLECTION_RE.test(String(s.collection ?? ''))) return 'store.collection must be 1-40 letters, digits, - or _';
  if (s.action !== 'list') {
    if (s.action === 'save' && s.key === undefined) { /* a key is generated */ }
    else if (!REQUEST_PATH_RE.test(String(s.key ?? ''))) return 'store.key must say where the key is in the request, for example query.id, path.id or body.Application.ApplicationNo';
  }
  if (s.from !== undefined && !REQUEST_PATH_RE.test(String(s.from))) return 'store.from must be a place in the request, for example body or body.Application';
  if (s.notFound !== undefined) {
    const n = s.notFound as Record<string, unknown>;
    const st = Number(n?.status);
    if (!n || !Number.isInteger(st) || st < 100 || st > 599) return 'store.notFound.status must be 100-599';
  }
  return null;
}

export function cleanStore(raw: Record<string, unknown>): RuleStore {
  const n = raw.notFound as Record<string, unknown> | undefined;
  return {
    action: raw.action as RuleStore['action'],
    collection: String(raw.collection),
    ...(raw.key !== undefined && raw.key !== '' ? { key: String(raw.key) } : {}),
    ...(raw.from !== undefined && raw.from !== '' ? { from: String(raw.from) } : {}),
    ...(n ? { notFound: { status: Number(n.status), ...(n.body !== undefined ? { body: n.body } : {}) } } : {}),
  };
}

// ── Reading values out of the request, and filling tokens ─────────────────────

function dig(v: unknown, parts: string[]): unknown {
  let cur = v;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export interface RequestView { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; params: Record<string, string> }

export function requestView(req: MockRequest, params: Record<string, string>): RequestView {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
  return { method: req.method, path: req.path, query: req.query ?? {}, headers, body: req.body, params };
}

/** A value from the request by a place such as "query.id", "header.x-id", "path.id" or "body.a.b". */
export function fromRequest(view: RequestView, place: string): unknown {
  const [where, ...rest] = place.split('.');
  switch (where) {
    case 'query': return dig(view.query, rest);
    case 'header': return dig(view.headers, rest.map((r) => r.toLowerCase()));
    case 'path': return dig(view.params, rest);
    case 'body': return rest.length === 0 ? view.body : dig(view.body, rest);
    default: return undefined;
  }
}

interface FillContext { view: RequestView; record?: unknown; records?: unknown[]; key?: string }

function token(expr: string, ctx: FillContext): { found: boolean; value: unknown } {
  const [head, ...rest] = expr.split('.');
  switch (head) {
    case 'record': return ctx.record === undefined ? { found: false, value: undefined } : { found: true, value: rest.length ? dig(ctx.record, rest) : ctx.record };
    case 'records': return ctx.records === undefined ? { found: false, value: undefined } : { found: true, value: ctx.records };
    case 'key': return ctx.key === undefined ? { found: false, value: undefined } : { found: true, value: ctx.key };
    case 'request': return { found: true, value: fromRequest(ctx.view, rest.join('.')) };
    default: return { found: false, value: undefined };
  }
}

export function fill(value: unknown, ctx: FillContext, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
    if (whole) { const t = token(whole[1], ctx); return t.found ? t.value : value; }
    return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (m, e: string) => {
      const t = token(e, ctx);
      return !t.found || t.value === undefined || t.value === null ? m : typeof t.value === 'object' ? JSON.stringify(t.value) : String(t.value);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, ctx, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fill(v, ctx, depth + 1)]));
  return value;
}

/** Applies changes to a snapshot in place, so the next case of a test run sees what an earlier one saved. */
export function applyToSnapshot(data: RecordData, changes: RecordChange[]): void {
  for (const c of changes) {
    if (c.record === null) { delete data[c.collection]?.[c.key]; continue; }
    (data[c.collection] ??= {})[c.key] = c.record;
  }
}

// ── Doing what the rule says ──────────────────────────────────────────────────

export interface StoreOutcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  changes: RecordChange[];
  /** A short note for the call log. */
  note: string;
}

export function runStore(
  store: RuleStore,
  response: { status: number; body?: unknown; headers?: Record<string, string> } | undefined,
  view: RequestView,
  data: RecordData | undefined,
): StoreOutcome {
  const collection = data?.[store.collection] ?? {};
  const keyOf = (): string => {
    const k = store.key ? fromRequest(view, store.key) : undefined;
    return k === undefined || k === null || k === '' ? '' : String(k);
  };
  const notFound = (key: string): StoreOutcome => ({
    status: store.notFound?.status ?? 404,
    body: store.notFound?.body !== undefined ? fill(store.notFound.body, { view, key }) : { error: 'NOT_FOUND', message: `No ${store.collection} record with the key "${key}".` },
    changes: [],
    note: 'not found',
  });
  const answer = (ctx: FillContext, changes: RecordChange[], note: string, dflt: unknown): StoreOutcome => ({
    status: response?.status ?? 200,
    body: response?.body !== undefined ? fill(response.body, ctx) : dflt,
    ...(response?.headers ? { headers: response.headers } : {}),
    changes,
    note,
  });

  switch (store.action) {
    case 'list': {
      const records = Object.values(collection);
      return answer({ view, records }, [], `listed ${records.length}`, records);
    }
    case 'find': {
      const key = keyOf();
      if (!key || !(key in collection)) return notFound(key);
      return answer({ view, record: collection[key], key }, [], 'found', collection[key]);
    }
    case 'remove': {
      const key = keyOf();
      if (!key || !(key in collection)) return notFound(key);
      return answer({ view, record: collection[key], key }, [{ collection: store.collection, key, record: null }], 'removed', { removed: key });
    }
    case 'save': {
      const record = store.from ? fromRequest(view, store.from) : view.body;
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { status: 400, body: { error: 'NOTHING_TO_SAVE', message: `There is no object at ${store.from ?? 'body'} to save.` }, changes: [], note: 'nothing to save' };
      }
      if (JSON.stringify(record).length > MAX_RECORD_CHARS) return { status: 413, body: { error: 'RECORD_TOO_LARGE' }, changes: [], note: 'too large' };
      // With no key in the request, the record gets one, so a later lookup has something to ask for.
      const key = keyOf() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const existed = key in collection;
      return answer({ view, record, key }, [{ collection: store.collection, key, record }], existed ? 'updated' : 'created', record);
    }
    default:
      return { status: 500, body: { error: 'BAD_STORE_ACTION' }, changes: [], note: 'bad action' };
  }
}
