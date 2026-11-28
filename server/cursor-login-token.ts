/**
 * A Cursor login token: the access token "Sign in with Cursor" (server/cursor-login.ts) receives, the same one the CLI writes to its
 * auth.json after `agent login`. It is a 60-day session token, accepted by the CLI as CURSOR_AUTH_TOKEN. Pure module: it also runs
 * inside the runner image.
 *
 * parseLoginToken checks a token before it is kept (shape, and an expiry that has not passed). It also reads a whole auth.json
 * ({"accessToken": ..., "refreshToken": ...}); only the access token is ever kept, and the refresh token is dropped.
 */

const MAX_PASTE_BYTES = 16_000;
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

export interface ParsedLoginToken {
  token: string;
  /** ISO time the token stops working. */
  expiresAt: string;
}

/** The token a value holds (the token itself or a whole auth.json), or an Error saying what is wrong with it. */
export function parseLoginToken(pasted: string, now = Date.now()): ParsedLoginToken {
  const raw = String(pasted ?? '').trim();
  if (!raw) throw new Error('No login token was received.');
  if (Buffer.byteLength(raw) > MAX_PASTE_BYTES) throw new Error('That is too long to be a login token.');
  let token = raw;
  if (raw.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('That looks like JSON but could not be read.'); }
    const value = (parsed as { accessToken?: unknown } | null)?.accessToken;
    if (typeof value !== 'string' || !value) throw new Error('No accessToken was found in that JSON.');
    token = value.trim();
  }
  token = token.replace(/^"+|"+$/g, '').replace(/\s+/g, '');
  if (!JWT.test(token)) throw new Error('That is not a Cursor login token (three parts separated by dots).');
  const exp = Number((claims(token) ?? {}).exp);
  if (!Number.isFinite(exp)) throw new Error('This login token has no expiry, so it cannot be checked. Sign in again.');
  if (exp * 1000 <= now) throw new Error(`This login token expired on ${new Date(exp * 1000).toISOString().slice(0, 10)}. Sign in again.`);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The token's payload claims (not verified: only the expiry is read from it). */
function claims(token: string): Record<string, unknown> | null {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return null; }
}

/** Whole days until `expiresAt` (negative when past), or null when unknown. */
export function daysLeft(expiresAt: unknown, now = Date.now()): number | null {
  const t = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(t) ? Math.floor((t - now) / 86_400_000) : null;
}

/** Shape check for a token arriving at the runner (it never decodes or trusts the claims). */
export function looksLikeLoginToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8_000 && JWT.test(value);
}

/** Which Cursor variable carries this credential: an API key or a login token. */
export interface CursorAuth { apiKey?: string; authToken?: string }

export function cursorAuthEnv(auth: CursorAuth): NodeJS.ProcessEnv {
  return { ...(auth.apiKey ? { CURSOR_API_KEY: auth.apiKey } : {}), ...(auth.authToken ? { CURSOR_AUTH_TOKEN: auth.authToken } : {}) };
}
