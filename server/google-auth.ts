/**
 * Sign in with Google (OpenID Connect, authorization-code flow).
 *
 *   GET /api/auth/google/start     redirects to Google
 *   GET /api/auth/google/callback  Google redirects back here; we sign the user in
 *
 * Who may sign in: an existing, enabled user whose email matches the verified Google email, or an email /
 * domain on the allow-list (PORTAL_GOOGLE_ALLOWED, comma separated, e.g. "a@x.com,@mycompany.com").
 * Anyone else is rejected. The first admin must still be created on the setup page.
 *
 * Configuration:
 *   PORTAL_PUBLIC_URL          https://<portal host>   (used to build the redirect URI)
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   or   PORTAL_GOOGLE_SECRET_ARN (Secrets Manager JSON
 *                              {"clientId": "...", "clientSecret": "..."})
 *   PORTAL_GOOGLE_ALLOWED      allow-list (optional)
 *
 * State: the random `state` and `nonce` live in a short-lived HttpOnly cookie, so any Lambda instance can
 * finish the flow.
 */

import { randomBytes } from 'node:crypto';
import { router, parseCookies, setCookie } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getAuthRepository } from './repositories/auth.ts';
import { appendAudit } from './audit.ts';
import { generateId, now } from './util.ts';
import { hashPassword } from './auth.ts';

const STATE_COOKIE = 'portal_google_state';
const STATE_TTL_SECONDS = 600;
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── Pure helpers (unit tested) ────────────────────────────────────────────────

/** Parse "a@x.com, @corp.com" into exact emails and domains (lower case). */
export function parseAllowList(raw: string | undefined): { emails: Set<string>; domains: Set<string> } {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const part of (raw ?? '').split(/[,\s;]+/)) {
    const v = part.trim().toLowerCase();
    if (!v) continue;
    if (v.startsWith('@')) domains.add(v.slice(1));
    else if (v.includes('@')) emails.add(v);
  }
  return { emails, domains };
}

export function isEmailAllowed(email: string, raw: string | undefined): boolean {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  const { emails, domains } = parseAllowList(raw);
  return emails.has(e) || domains.has(e.slice(at + 1));
}

export interface GoogleClaims {
  iss?: string;
  aud?: string;
  exp?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  sub?: string;
}

/** Returns an error message, or null when the claims are acceptable. */
export function checkClaims(claims: GoogleClaims, clientId: string, nonce: string, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return 'Unexpected token issuer';
  if (claims.aud !== clientId) return 'Token was issued for a different application';
  if (!claims.exp || claims.exp < nowSeconds) return 'Sign-in token has expired';
  if (!claims.nonce || claims.nonce !== nonce) return 'Sign-in could not be verified (nonce)';
  if (!claims.email) return 'Google did not return an email address';
  if (claims.email_verified !== true && claims.email_verified !== 'true') return 'Your Google email address is not verified';
  return null;
}

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string; nonce: string }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', opts.state);
  u.searchParams.set('nonce', opts.nonce);
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

function decodeJwtPayload(jwt: string): GoogleClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as GoogleClaims; } catch { return null; }
}

// ── Configuration ─────────────────────────────────────────────────────────────

let cachedCreds: { clientId: string; clientSecret: string } | null | undefined;

export async function loadGoogleCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
  if (cachedCreds !== undefined && cachedCreds !== null) return cachedCreds;
  let clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? '';
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  const arn = process.env.PORTAL_GOOGLE_SECRET_ARN;
  if ((!clientId || !clientSecret) && arn) {
    try {
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
      const resp = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
      const parsed = JSON.parse(resp.SecretString ?? '{}') as { clientId?: string; clientSecret?: string };
      clientId = parsed.clientId?.trim() ?? '';
      clientSecret = parsed.clientSecret?.trim() ?? '';
    } catch (e) {
      console.error('[google-auth] could not read Google client secret:', e instanceof Error ? e.message : e);
    }
  }
  // Only remember a complete configuration so filling in the secret later works without a restart.
  cachedCreds = clientId && clientSecret ? { clientId, clientSecret } : null;
  return cachedCreds;
}

export async function googleSignInEnabled(): Promise<boolean> {
  return Boolean(process.env.PORTAL_PUBLIC_URL && (await loadGoogleCredentials()));
}

export function googleRedirectUri(): string {
  return `${(process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/+$/, '')}/api/auth/google/callback`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

type StartSession = (res: PortalResponse, userId: string, secure: boolean) => Promise<void>;

function redirect(res: PortalResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function fail(res: PortalResponse, secure: boolean, message: string): void {
  setCookie(res, STATE_COOKIE, '', { maxAge: 0, secure });
  redirect(res, `/#/login?error=${encodeURIComponent(message)}`);
}

export function registerGoogleAuthRoutes(startSession: StartSession): void {
  router.get('/api/auth/google/start', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const creds = await loadGoogleCredentials();
    if (!creds || !process.env.PORTAL_PUBLIC_URL) {
      fail(res, req.secure, 'Google sign-in is not set up on this portal.');
      return;
    }
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    setCookie(res, STATE_COOKIE, `${state}.${nonce}`, { maxAge: STATE_TTL_SECONDS, secure: req.secure });
    redirect(res, buildAuthUrl({ clientId: creds.clientId, redirectUri: googleRedirectUri(), state, nonce }));
  });

  router.get('/api/auth/google/callback', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const secure = req.secure;
    const creds = await loadGoogleCredentials();
    if (!creds) { fail(res, secure, 'Google sign-in is not set up on this portal.'); return; }

    // "Connect Google Workspace" (Drive, Docs, Sheets, Slides) comes back through the same redirect address.
    if ((req.query.get('state') ?? '').startsWith('ws.')) {
      const { handleWorkspaceCallback } = await import('./google-workspace.ts');
      await handleWorkspaceCallback(req, res, creds);
      return;
    }

    const googleError = req.query.get('error');
    if (googleError) { fail(res, secure, googleError === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed.'); return; }

    const code = req.query.get('code') ?? '';
    const state = req.query.get('state') ?? '';
    const cookie = decodeURIComponent(parseCookies(req.headers.cookie)[STATE_COOKIE] ?? '');
    const [cookieState, nonce] = cookie.split('.');
    if (!code || !state || !cookieState || !nonce || state !== cookieState) {
      fail(res, secure, 'Sign-in session expired. Please try again.');
      return;
    }

    let claims: GoogleClaims | null = null;
    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          redirect_uri: googleRedirectUri(),
          grant_type: 'authorization_code',
        }).toString(),
      });
      if (!tokenRes.ok) {
        console.error('[google-auth] token exchange failed', tokenRes.status, (await tokenRes.text()).slice(0, 200));
        fail(res, secure, 'Google sign-in failed. Please try again.');
        return;
      }
      const body = (await tokenRes.json()) as { id_token?: string };
      // The ID token came straight from Google over TLS, so its claims are trusted after the checks below.
      claims = body.id_token ? decodeJwtPayload(body.id_token) : null;
    } catch (e) {
      console.error('[google-auth] token exchange error', e instanceof Error ? e.message : e);
      fail(res, secure, 'Could not reach Google. Please try again.');
      return;
    }

    const problem = claims ? checkClaims(claims, creds.clientId, nonce) : 'Google returned no sign-in token';
    if (problem || !claims) { fail(res, secure, problem ?? 'Sign-in failed'); return; }

    const email = String(claims.email).trim().toLowerCase();
    const repo = getAuthRepository();
    let user = await repo.getUserByEmail(email);

    if (user?.disabled) { fail(res, secure, 'This account is disabled. Ask your admin.'); return; }

    if (!user) {
      if ((await repo.countUsers()) === 0) { fail(res, secure, 'The portal has not been set up yet. Create the first admin account first.'); return; }
      if (!isEmailAllowed(email, process.env.PORTAL_GOOGLE_ALLOWED)) {
        appendAudit(null, null, 'auth.google_denied', `email:${email}`, {}, req.ip);
        fail(res, secure, `${email} is not allowed to use this portal. Ask your admin for an invite.`);
        return;
      }
      // Allow-listed: create a normal (non-admin) user. The random password is never used or shown.
      try {
        user = await repo.createUser({
          id: generateId(),
          email,
          name: String(claims.name ?? email.split('@')[0]).slice(0, 120),
          password_hash: hashPassword(randomBytes(24).toString('base64url')),
          is_admin: 0,
          disabled: 0,
          created_at: now(),
        });
      } catch {
        fail(res, secure, 'Could not create your account. Please try again.');
        return;
      }
    }

    await startSession(res, user.id, secure);
    setCookie(res, STATE_COOKIE, '', { maxAge: 0, secure });
    appendAudit(null, user.id, 'auth.google_login', `user:${user.id}`, { email }, req.ip);
    redirect(res, '/');
  });
}
