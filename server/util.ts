import { randomUUID } from 'node:crypto';

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
