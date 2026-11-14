/**
 * Password confirmation for sensitive actions ("step-up").
 *
 * A stolen or left-open browser session can read a lot, but should not be able to change what the portal trusts
 * (stored credentials, users, project deletion) without the password. Those routes call requireStepUp(); when the
 * person has not confirmed their password in the last 10 minutes they get 403 { code: 'reauth_required' }, the page
 * asks for the password, posts it to /api/auth/confirm, and repeats the action.
 *
 * The confirmation is a signed cookie tied to the session, so it cannot be moved to another session and needs no storage.
 * People who sign in only with Google have no password of their own to confirm; they are not asked (Google protects that account).
 * Requests that do not use the browser session cookie (API tokens) are not affected.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { router, sendJson, parseCookies, setCookie } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { config } from './config.ts';
import { sha256 } from './util.ts';
import { COOKIE_NAME, verifyPassword, dummyPasswordHash } from './auth.ts';
import { getAuthRepository } from './repositories/auth.ts';
import { clearLoginFailures, loginBlocked, recordLoginFailure } from './login-limiter.ts';
import { appendAudit } from './audit.ts';

export const STEP_UP_COOKIE = 'portal_reauth';
export const STEP_UP_WINDOW_MS = 10 * 60_000;

function sign(sessionHash: string, expMs: number): string {
  return createHmac('sha256', config.secretKey).update(`step-up|${sessionHash}|${expMs}`).digest('hex');
}

export function makeStepUpToken(sessionHash: string, nowMs: number): string {
  const exp = nowMs + STEP_UP_WINDOW_MS;
  return `${exp}.${sign(sessionHash, exp)}`;
}

export function stepUpTokenValid(token: string | undefined, sessionHash: string, nowMs: number): boolean {
  if (!token) return false;
  const [expStr, mac] = token.split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < nowMs || exp > nowMs + STEP_UP_WINDOW_MS || !mac) return false;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(sessionHash, exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionHashOf(req: PortalRequest): string | null {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return raw ? sha256(decodeURIComponent(raw)) : null;
}

/** True when the action may go ahead; otherwise the response has been sent. */
export async function requireStepUp(req: PortalRequest, res: PortalResponse): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const sessionHash = sessionHashOf(req);
  if (!sessionHash) return true; // not a browser session
  const user = await getAuthRepository().getUserById(req.user.id);
  if (user?.google_sub) return true; // no password of their own to confirm
  const cookie = parseCookies(req.headers.cookie)[STEP_UP_COOKIE];
  if (stepUpTokenValid(cookie ? decodeURIComponent(cookie) : undefined, sessionHash, Date.now())) return true;
  sendJson(res, 403, { error: 'Confirm your password to continue', code: 'reauth_required' });
  return false;
}

export function registerStepUpRoutes(): void {
  // POST /api/auth/confirm { password } — start a 10-minute window for sensitive actions
  router.post('/api/auth/confirm', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const sessionHash = sessionHashOf(req);
    if (!sessionHash) { sendJson(res, 400, { error: 'Sign in with the browser to confirm your password' }); return; }
    const email = req.user.email.trim().toLowerCase();
    // Same limits as sign-in: a hijacked session must not be able to guess the password here.
    if (await loginBlocked(email, req.ip)) {
      sendJson(res, 429, { error: 'Too many failed attempts. Wait 15 minutes and try again.' });
      return;
    }
    const user = await getAuthRepository().getUserById(req.user.id);
    const password = String((req.body as Record<string, unknown> | undefined)?.password ?? '');
    const ok = verifyPassword(password, user?.password_hash ?? dummyPasswordHash());
    if (!user || !ok) {
      await recordLoginFailure(email, req.ip);
      sendJson(res, 400, { error: 'Password is incorrect' });
      return;
    }
    await clearLoginFailures(email);
    setCookie(res, STEP_UP_COOKIE, makeStepUpToken(sessionHash, Date.now()), { maxAge: STEP_UP_WINDOW_MS / 1000, secure: req.secure });
    appendAudit(null, user.id, 'auth.confirm', `user:${user.id}`, {}, req.ip);
    sendJson(res, 200, { ok: true });
  });
}
