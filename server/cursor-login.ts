/**
 * "Sign in with Cursor": the browser login the Cursor CLI runs for `agent login`, done by the portal itself.
 *
 *   1. Make a random verifier and a uuid; the challenge is base64url(sha256(verifier)).
 *   2. The person opens <website>/loginDeepControl?challenge=…&uuid=…&mode=login&redirectTarget=cli and approves.
 *   3. The portal polls POST <api>/auth/poll {uuid, verifier}: 404 until approved, then 200 with
 *      {accessToken, refreshToken, challenge, authId, uuid, token_type} (checked against the real service).
 *
 * Only the access token is kept (a 60-day session token); the refresh token is dropped. These are the endpoints the CLI itself uses,
 * so they are not a documented API: PORTAL_CURSOR_API_URL / PORTAL_CURSOR_WEBSITE_URL point them elsewhere (tests, or if they move).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { parseLoginToken } from './cursor-login-token.ts';

const DEFAULT_API = 'https://api2.cursor.sh';
const DEFAULT_WEBSITE = 'https://cursor.com';
/** How long a started sign-in may be approved (the person has this long to open the link). */
export const LOGIN_WINDOW_SECONDS = 10 * 60;

const b64 = (b: Buffer): string => b.toString('base64url');

/** A base URL from the environment, accepted only as https (or http to this machine, for tests). */
function baseUrl(envName: string, fallback: string): string {
  const raw = process.env[envName];
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin;
  } catch { /* fall through */ }
  throw new Error(`${envName} must be an https URL`);
}

export interface CursorLoginStart { uuid: string; verifier: string; loginUrl: string }

export function startCursorLogin(): CursorLoginStart {
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash('sha256').update(verifier).digest());
  const uuid = randomUUID();
  const url = new URL('/loginDeepControl', baseUrl('PORTAL_CURSOR_WEBSITE_URL', DEFAULT_WEBSITE));
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('uuid', uuid);
  url.searchParams.set('mode', 'login');
  url.searchParams.set('redirectTarget', 'cli');
  return { uuid, verifier, loginUrl: url.toString() };
}

export type CursorLoginPoll =
  | { status: 'pending' }
  | { status: 'complete'; token: string; expiresAt: string }
  | { status: 'failed'; message: string };

export async function pollCursorLogin(uuid: string, verifier: string, fetchImpl: typeof fetch = fetch): Promise<CursorLoginPoll> {
  // A bad setting is thrown here, not mistaken for a network blip below.
  const endpoint = `${baseUrl('PORTAL_CURSOR_API_URL', DEFAULT_API)}/auth/poll`;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uuid, verifier }),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
  } catch { return { status: 'pending' }; } // a network blip: the next poll tries again
  if (res.status === 404 || res.status === 429 || res.status >= 500) return { status: 'pending' };
  if (res.status !== 200) return { status: 'failed', message: `Cursor refused the sign-in (HTTP ${res.status}). Start again.` };
  let body: { accessToken?: unknown };
  try { body = await res.json() as { accessToken?: unknown }; } catch { return { status: 'failed', message: 'Cursor answered with something unreadable. Start again.' }; }
  try {
    const parsed = parseLoginToken(String(body.accessToken ?? ''));
    return { status: 'complete', token: parsed.token, expiresAt: parsed.expiresAt };
  } catch (e) { return { status: 'failed', message: (e as Error).message }; }
}
