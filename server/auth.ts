/**
 * Authentication routes and middleware.
 *
 * Routes:
 *   GET  /api/auth/state          — current session state
 *   POST /api/auth/login          — email + password login
 *   POST /api/auth/logout         — logout (clears cookie)
 *   POST /api/auth/setup          — first-time admin setup
 *   GET  /api/auth/detect-platform — cloud platform detection
 *
 * Middleware:
 *   requireAuth(handler)          — ensure user is authenticated
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { router, sendJson, setCookie, parseCookies, setAuthenticator } from './http.ts';
import type { PortalRequest, PortalResponse, PortalUser, AuthInfo } from './http.ts';
import { one, run, insert, update, all } from './db.ts';
import { generateId, now, str, badRequest, HttpError } from './util.ts';
import { appendAudit } from './audit.ts';
import { getDb } from './db.ts';
import { config } from './config.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const COOKIE_NAME = 'portal_session';
const SESSION_DAYS = 14;

// ── Password hashing ──────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, 64) as Buffer;
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(expected, actual);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ── User helpers ──────────────────────────────────────────────────────────────

export function userCount(): number {
  return (one<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
}

export function createUser(input: {
  email: string;
  name: string;
  password: string;
  isAdmin: boolean;
}): PortalUser {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address');
  if (input.password.length < 10) throw badRequest('Password must be at least 10 characters');
  if (one('SELECT id FROM users WHERE email = ?', email)) {
    throw badRequest('A user with this email already exists');
  }
  const id = generateId();
  insert('users', {
    id,
    email,
    name: str(input.name, 'Name', { max: 120 }).trim(),
    password_hash: hashPassword(input.password),
    is_admin: input.isAdmin ? 1 : 0,
    disabled: 0,
    created_at: now(),
  });
  return one<PortalUser>('SELECT id, email, name, is_admin FROM users WHERE id = ?', id)!;
}

// ── Session management ────────────────────────────────────────────────────────

function startSession(res: PortalResponse, userId: string, secure: boolean): void {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  insert('sessions', {
    token_hash: sha256(token),
    user_id: userId,
    created_at: now(),
    expires_at: expires,
  });
  setCookie(res, COOKIE_NAME, token, { maxAge: SESSION_DAYS * 86400, secure });
}

export function cleanupSessions(): void {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
}

// ── Authenticator (used by HTTP router) ───────────────────────────────────────

export function authenticate(rawReq: import('node:http').IncomingMessage, authInfo: AuthInfo = {}): PortalUser | null {
  // 1. Try cookie auth first
  const cookieHeader = rawReq.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    const token = cookies[COOKIE_NAME];
    if (token) {
      const row = one<PortalUser & { expires_at: string; disabled: number }>(
        `SELECT u.id, u.email, u.name, u.is_admin, u.disabled, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        sha256(decodeURIComponent(token)),
      );
      if (row && !row.disabled && row.expires_at >= now()) {
        return { id: row.id, email: row.email, name: row.name, is_admin: row.is_admin };
      }
    }
  }

  // 2. Try Bearer token auth (ap_ prefix)
  const authHeader = String(rawReq.headers.authorization ?? '');
  if (authHeader.startsWith('Bearer ap_')) {
    const bearerToken = authHeader.slice(7).trim();
    const tokenHash = sha256(bearerToken);
    const row = one<{ user_id: string; email: string; name: string; is_admin: number; disabled: number; expires_at: string; revoked_at: string | null; scopes: string | null; scope: string; workflow_id: string | null }>(
      `SELECT t.expires_at, t.revoked_at, t.scopes, t.scope, t.workflow_id,
              u.id AS user_id, u.email, u.name, u.is_admin, u.disabled
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      tokenHash,
    );
    if (row && !row.revoked_at && !row.disabled && row.expires_at >= now()) {
      // Populate AuthInfo for downstream scope checks
      const scopesRaw = row.scopes ? String(row.scopes) : null;
      const scopes: string[] = scopesRaw
        ? ((): string[] => { try { return JSON.parse(scopesRaw) as string[]; } catch { return [String(row.scope) === 'write' ? 'write' : 'read']; } })()
        : (String(row.scope) === 'write' ? ['read', 'write'] : ['read']);
      authInfo.tokenScopes = scopes;
      authInfo.authViaToken = true;
      authInfo.tokenWorkflowId = row.workflow_id ?? null;
      return { id: String(row.user_id), email: String(row.email), name: String(row.name), is_admin: Number(row.is_admin) };
    }
  }

  return null;
}

// ── Rate limiting ──────────────────────────────────────────────────────────────

const loginFailures = new Map<string, { count: number; until: number }>();
const setupAttempts = new Map<string, { count: number; until: number }>();

// ── Platform detection ────────────────────────────────────────────────────────

type PlatformName = 'ec2' | 'ecs' | 'lambda' | 'gce' | 'azure' | 'fly' | 'render' | 'local';

interface PlatformInfo {
  platform: PlatformName;
  suggested: 'bedrock' | 'anthropic';
}

function detectPlatform(): PlatformInfo {
  // AWS Lambda
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return { platform: 'lambda', suggested: 'bedrock' };
  // AWS ECS
  if (process.env.ECS_CONTAINER_METADATA_URI || process.env.ECS_CONTAINER_METADATA_URI_V4) {
    return { platform: 'ecs', suggested: 'bedrock' };
  }
  // AWS EC2 (IMDSv2 would need a network call; use env hint)
  if (process.env.AWS_EXECUTION_ENV?.startsWith('AWS_EC2')) {
    return { platform: 'ec2', suggested: 'bedrock' };
  }
  // Google Cloud
  if (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT) {
    return { platform: 'gce', suggested: 'anthropic' };
  }
  // Azure
  if (process.env.WEBSITE_INSTANCE_ID || process.env.AZURE_CLIENT_ID) {
    return { platform: 'azure', suggested: 'anthropic' };
  }
  // Fly.io
  if (process.env.FLY_APP_NAME) return { platform: 'fly', suggested: 'anthropic' };
  // Render
  if (process.env.RENDER_SERVICE_ID) return { platform: 'render', suggested: 'anthropic' };
  // Default: local
  return { platform: 'local', suggested: 'anthropic' };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerAuthRoutes(): void {
  // Set the authenticator on the HTTP router
  setAuthenticator(authenticate);

  // GET /api/auth/state
  router.get('/api/auth/state', (req: PortalRequest, res: PortalResponse): void => {
    const needsSetup = userCount() === 0;
    const user = req.user;
    sendJson(res, 200, {
      loggedIn: user != null,
      needsSetup,
      user: user
        ? {
            id: user.id,
            name: user.name,
            email: user.email,
            is_admin: Boolean(user.is_admin),
          }
        : undefined,
      deployTarget: config.deployTarget ?? null,
    });
  });

  // GET /api/auth/detect-platform
  router.get('/api/auth/detect-platform', (_req: PortalRequest, res: PortalResponse): void => {
    sendJson(res, 200, detectPlatform());
  });

  // POST /api/auth/login
  router.post('/api/auth/login', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const body = req.body as Record<string, unknown>;
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');

    // Rate limiting: 8 failures per 15 minutes per IP+email
    const rateKey = `${req.ip}|${email}`;
    const failures = loginFailures.get(rateKey);
    if (failures && failures.count >= 8 && failures.until > Date.now()) {
      sendJson(res, 429, { error: 'Too many failed attempts. Wait 15 minutes and try again.' });
      return;
    }

    const row = one<{ id: string; password_hash: string; disabled: number }>(
      'SELECT id, password_hash, disabled FROM users WHERE email = ?',
      email,
    );

    if (!row || row.disabled || !verifyPassword(password, row.password_hash)) {
      const next = {
        count: (failures && failures.until > Date.now() ? failures.count : 0) + 1,
        until: Date.now() + 15 * 60_000,
      };
      loginFailures.set(rateKey, next);
      sendJson(res, 401, { error: 'Email or password is incorrect' });
      return;
    }

    loginFailures.delete(rateKey);
    startSession(res, row.id, req.secure);
    appendAudit(getDb(), row.id, 'auth.login', `user:${row.id}`, { email }, req.ip);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/auth/logout
  router.post('/api/auth/logout', (req: PortalRequest, res: PortalResponse): void => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (token) {
      run('DELETE FROM sessions WHERE token_hash = ?', sha256(decodeURIComponent(token)));
    }
    setCookie(res, COOKIE_NAME, '', { maxAge: 0, secure: req.secure });
    if (req.user) {
      appendAudit(getDb(), req.user.id, 'auth.logout', `user:${req.user.id}`, {}, req.ip);
    }
    sendJson(res, 200, { ok: true });
  });

  // POST /api/auth/setup
  router.post('/api/auth/setup', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    // Rate limit: 3 attempts per IP per hour
    const ip = req.ip || 'unknown';
    const sa = setupAttempts.get(ip);
    if (sa && sa.count >= 3 && sa.until > Date.now()) {
      sendJson(res, 429, { error: 'Too many setup attempts. Try again in an hour.' });
      return;
    }

    if (userCount() > 0) {
      sendJson(res, 409, { error: 'Setup is already done. Sign in instead.' });
      return;
    }

    // Record the attempt
    setupAttempts.set(ip, {
      count: (sa && sa.until > Date.now() ? sa.count : 0) + 1,
      until: Date.now() + 3600_000,
    });

    const body = req.body as Record<string, unknown>;

    // Validate required fields
    const email = String(body.email ?? '').trim().toLowerCase();
    const name = String(body.name ?? '').trim();
    const password = String(body.password ?? '');

    if (!email) {
      sendJson(res, 400, { error: 'Email is required' });
      return;
    }
    if (!name) {
      sendJson(res, 400, { error: 'Name is required' });
      return;
    }
    if (password.length < 10) {
      sendJson(res, 400, { error: 'Password must be at least 10 characters' });
      return;
    }

    const user = createUser({ email, name, password, isAdmin: true });

    // Write wizard settings if provided
    const db = getDb();
    const deployTarget = body.deployTarget ? String(body.deployTarget) : null;
    const provider = body.provider ? String(body.provider) : 'demo';

    if (deployTarget) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'deployTarget',
        JSON.stringify(deployTarget),
      );
    }

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'provider',
      JSON.stringify(provider),
    );

    // Handle optional provider settings
    if (body.secretKeyArn) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'aws.secretKeyArn',
        JSON.stringify(String(body.secretKeyArn)),
      );
    }
    if (body.awsRegion) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'aws.region',
        JSON.stringify(String(body.awsRegion)),
      );
    }

    startSession(res, user.id, req.secure);
    appendAudit(db, user.id, 'auth.setup', `user:${user.id}`, { email: user.email }, req.ip);

    // Clear rate limit on success
    setupAttempts.delete(ip);

    sendJson(res, 200, { ok: true });
  });

  // GET /api/users  (admin: list users)
  router.get('/api/users', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!req.user.is_admin) { sendJson(res, 403, { error: 'Admin access required' }); return; }
    const users = all('SELECT id, email, name, is_admin, disabled, created_at FROM users ORDER BY created_at');
    sendJson(res, 200, { users });
  });

  // POST /api/users  (admin: create user)
  router.post('/api/users', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!req.user.is_admin) { sendJson(res, 403, { error: 'Only admins can do this' }); return; }
    const body = req.body as Record<string, unknown>;
    const user = createUser({
      email: String(body.email ?? ''),
      name: String(body.name ?? ''),
      password: String(body.password ?? ''),
      isAdmin: Boolean(body.isAdmin),
    });
    appendAudit(getDb(), req.user.id, 'user.create', `user:${user.id}`, { email: user.email }, req.ip);
    sendJson(res, 201, { user });
  });

  // POST /api/auth/password  (change own password)
  router.post('/api/auth/password', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const body = req.body as Record<string, unknown>;
    const row = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', req.user.id)!;
    if (!verifyPassword(String(body.current ?? ''), row.password_hash)) {
      sendJson(res, 400, { error: 'Current password is incorrect' });
      return;
    }
    const newPassword = String(body.password ?? '');
    if (newPassword.length < 10) {
      sendJson(res, 400, { error: 'Password must be at least 10 characters' });
      return;
    }
    update('users', req.user.id, { password_hash: hashPassword(newPassword) });
    appendAudit(getDb(), req.user.id, 'auth.password_change', `user:${req.user.id}`, {}, req.ip);
    sendJson(res, 200, { ok: true });
  });
}
