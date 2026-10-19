import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'You do not have access to this') => new HttpError(403, msg);

export function newId(prefix = ''): string {
  return prefix + randomBytes(9).toString('base64url');
}

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function now(): string {
  return new Date().toISOString();
}

export function slugify(s: string, max = 48): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/** Names used for agents, skills and roles: lowercase letters, digits and hyphens. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function assertName(name: unknown, what = 'Name'): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw badRequest(`${what} must use lowercase letters, digits and hyphens (max 63 characters)`);
  }
  return name;
}

/** Join paths and refuse anything that escapes the base directory. */
export function safeJoin(base: string, ...parts: string[]): string {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, ...parts);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    throw badRequest('Path is outside the allowed folder');
  }
  return target;
}

export function str(v: unknown, field: string, opts: { max?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw badRequest(`${field} is required`);
  }
  if (typeof v !== 'string') throw badRequest(`${field} must be text`);
  const max = opts.max ?? 10_000;
  if (v.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return v;
}

export function int(v: unknown, field: string, def?: number, min = -Infinity, max = Infinity): number {
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    throw badRequest(`${field} is required`);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Pull the first JSON object or array out of model text (fenced or bare). */
export function extractJson<T = unknown>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  const starts = [firstObj, firstArr].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    const end = text.lastIndexOf(close);
    if (end > start) candidates.push(text.slice(start, end + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after any earlier call with the same key has finished (per-process mutex). */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const settled = next.catch(() => undefined);
  locks.set(key, settled);
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… (${s.length - max} more characters)`;
}

export function monthStart(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal YAML frontmatter used by Claude Code agents and skills. */
export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value === '' && i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s*-\s+/, '').trim()));
      }
      data[key] = items;
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
      continue;
    }
    if (value === '|' || value === '>') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value === '|' ? '\n' : ' ');
    }
    data[key] = unquote(value);
  }
  return { data, body: m[2] };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function yamlValue(v: string): string {
  if (v === '' || /: |#|^[\[\]{},&*!|>'"%@`?]|:$|^\s|\s$|^-\s|^-$/.test(v) || /\n/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

export function stringifyFrontmatter(data: Record<string, string | string[] | undefined>, body: string): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}: ${yamlValue(v.join(', '))}`);
    } else if (v !== '') {
      lines.push(`${k}: ${yamlValue(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n') + body.replace(/^\n+/, '') + (body.endsWith('\n') ? '' : '\n');
}

export function listValue(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
