import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ── Error helper ────────────────────────────────────────────────────────────

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string): HttpError => new HttpError(400, msg);
export const notFound = (msg = 'Not found'): HttpError => new HttpError(404, msg);
export const forbidden = (msg = 'You do not have access to this'): HttpError => new HttpError(403, msg);

// ── Identity ─────────────────────────────────────────────────────────────────

/** Generate a globally unique ID using crypto.randomUUID. */
export function generateId(): string {
  return randomUUID();
}

// ── Time ─────────────────────────────────────────────────────────────────────

/** Returns current time as ISO 8601 datetime string. */
export function now(): string {
  return new Date().toISOString();
}

// ── Async helpers ─────────────────────────────────────────────────────────────

/** Resolves after the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Object helpers ───────────────────────────────────────────────────────────

/** Return a shallow copy of `obj` without the given keys. */
export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result as Omit<T, K>;
}

// ── String helpers ────────────────────────────────────────────────────────────

export function str(
  v: unknown,
  field: string,
  opts: { max?: number; optional?: boolean } = {},
): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw badRequest(`${field} is required`);
  }
  if (typeof v !== 'string') throw badRequest(`${field} must be text`);
  const max = opts.max ?? 10_000;
  if (v.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return v;
}

export function int(
  v: unknown,
  field: string,
  def?: number,
  min = -Infinity,
  max = Infinity,
): number {
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

// ── Mutex ─────────────────────────────────────────────────────────────────────

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

// ── Slug helpers ──────────────────────────────────────────────────────────────

/** Convert a title to a URL-safe kebab-case slug. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Generate a prefixed unique ID (e.g. 'dg_abc123'). */
export function newId(prefix = ''): string {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 20);
}

/** SHA-256 hex digest of a string. */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Safely join a root and a relative path, refusing to escape the root.
 * Throws if the resolved path is outside root.
 *
 * Uses a trailing `path.sep` in the containment check so that a sibling
 * directory whose name shares a prefix with the root cannot pass:
 *   root = /a/b/c  →  /a/b/csibling is rejected (does not start with /a/b/c/)
 */
export function safeJoin(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, rel);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path "${rel}" escapes root "${root}"`);
  }
  return resolved;
}

/**
 * safeJoin that also follows symlinks. When something exists at the path, its real location must be
 * inside the root's real location too, so a link such as `notes -> /etc/passwd` is refused.
 * Returns the real path to read, or null when nothing exists there (or it cannot be resolved).
 * Throws like safeJoin when the path escapes the root.
 */
export function realPathInside(root: string, rel: string): string | null {
  const joined = safeJoin(root, rel);
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(joined);
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`Path "${rel}" escapes root "${root}"`);
  }
  return real;
}
