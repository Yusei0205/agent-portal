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

import { registerGoogleAuthRoutes, googleSignInEnabled } from './google-auth.ts';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { router, sendJson, setCookie, parseCookies, setAuthenticator, registerBackgroundWrite } from './http.ts';
import type { PortalRequest, PortalResponse, PortalUser, AuthInfo } from './http.ts';
import { getDb } from './db.ts';
import { generateId, now, str, badRequest } from './util.ts';
import { getApiTokenRepository } from './repositories/api-tokens.ts';
import { getAuthRepository } from './repositories/auth.ts';
import { EmailAlreadyTakenError, AdminAlreadyExistsError } from './repositories/auth.ts';
import { appendAudit } from './audit.ts';
import { config } from './config.ts';
import { absoluteMs, nextExpiry, sessionExpiry } from './session-policy.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const COOKIE_NAME = 'portal_session';

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

export async function createUser(input: {
  email: string;
  name: string;
  password: string;
  isAdmin: boolean;
}): Promise<PortalUser> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address');
  if (input.password.length < 10) throw badRequest('Password must be at least 10 characters');

  const repo = getAuthRepository();
  const id = generateId();
  let user;
  try {
    user = await repo.createUser({
      id,
      email,
      name: str(input.name, 'Name', { max: 120 }).trim(),
      password_hash: hashPassword(input.password),
      is_admin: input.isAdmin ? 1 : 0,
      disabled: 0,
      created_at: now(),
    });
  } catch (e: unknown) {
    if (e instanceof EmailAlreadyTakenError) {
      throw badRequest('A user with this email already exists');
    }
    throw e;
  }

  return { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin };
}

// ── Session management ────────────────────────────────────────────────────────

async function startSession(res: PortalResponse, userId: string, secure: boolean): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const ts = now();
  const expires = sessionExpiry(ts, Date.now());
  await getAuthRepository().createSession({
    token_hash: sha256(token),
    user_id: userId,
    expires_at: expires,
    created_at: ts,
  });
  // The cookie lasts as long as the longest a session can; the server ends it sooner when the person is idle.
  setCookie(res, COOKIE_NAME, token, { maxAge: Math.round(absoluteMs() / 1000), secure });
}

export function cleanupSessions(): void {
  // Route through the repository so both SQLite and DynamoDB handle expiry correctly.
  // DynamoDB: TTL handles automatic expiry; deleteExpiredSessions() is a no-op.
  getAuthRepository().deleteExpiredSessions().catch(() => {/* best-effort cleanup */});
}

// ── Authenticator (used by HTTP router) ───────────────────────────────────────

export async function authenticate(rawReq: import('node:http').IncomingMessage, authInfo: AuthInfo = {}): Promise<PortalUser | null> {
  // 1. Try cookie auth (session lookup via repository)
  const cookieHeader = rawReq.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    const token = cookies[COOKIE_NAME];
    if (token) {
      const session = await getAuthRepository().getSessionWithUser(sha256(decodeURIComponent(token)));
      if (session && !session.disabled && session.expires_at >= now()) {
        // Sliding idle timeout: each request pushes the end out (written at most every few minutes).
        const next = nextExpiry(session.created_at, session.expires_at, Date.now());
        if (next) registerBackgroundWrite(getAuthRepository().extendSession(session.user_id, sha256(decodeURIComponent(token)), next).catch(() => {/* non-fatal */}));
        return {
          id: session.user_id,
          email: session.email,
          name: session.name,
          is_admin: session.is_admin,
        };
      }
    }
  }

  // 2. Try Bearer token auth (ap_ prefix) via repository
  const authHeader = String(rawReq.headers.authorization ?? '');
  if (authHeader.startsWith('Bearer ap_')) {
    const bearerToken = authHeader.slice(7).trim();
    const tokenHash = sha256(bearerToken);
    const repo = getApiTokenRepository();
    const row = await repo.getByHash(tokenHash);
    if (row && !row.revoked_at && !row.user_disabled && row.expires_at >= now()) {
      const scopesRaw = row.scopes;
      const scopes: string[] = scopesRaw
        ? ((): string[] => { try { return JSON.parse(scopesRaw) as string[]; } catch { return [String(row.scope) === 'write' ? 'write' : 'read']; } })()
        : (String(row.scope) === 'write' ? ['read', 'write'] : ['read']);
      authInfo.tokenScopes = scopes;
      authInfo.authViaToken = true;
      authInfo.tokenWorkflowId = row.workflow_id ?? null;

      // Update last_used_at at most once per minute (tracked background write)
      if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - 60_000) {
        const p = repo.updateLastUsed(row.id, row.user_id, now()).catch(() => {/* non-fatal */});
        registerBackgroundWrite(p);
      }

      return { id: row.user_id, email: row.user_email, name: row.user_name, is_admin: row.user_is_admin };
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
  registerGoogleAuthRoutes(startSession);

  // GET /api/auth/state
  router.get('/api/auth/state', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const needsSetup = (await getAuthRepository().countUsers()) === 0;
    const user = req.user;
    if (!user && parseCookies(req.headers.cookie)[COOKIE_NAME]) setCookie(res, COOKIE_NAME, '', { maxAge: 0, secure: req.secure });
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
      googleEnabled: await googleSignInEnabled(),
      // A session cookie arrived but is no longer good: the person was idle too long (or signed out elsewhere).
      sessionExpired: user == null && Boolean(parseCookies(req.headers.cookie)[COOKIE_NAME]),
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

    const user = await getAuthRepository().getUserByEmail(email);

    if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
      const next = {
        count: (failures && failures.until > Date.now() ? failures.count : 0) + 1,
        until: Date.now() + 15 * 60_000,
      };
      loginFailures.set(rateKey, next);
      sendJson(res, 401, { error: 'Email or password is incorrect' });
      return;
    }

    loginFailures.delete(rateKey);
    await startSession(res, user.id, req.secure);
    appendAudit(null, user.id, 'auth.login', `user:${user.id}`, { email }, req.ip);
    sendJson(res, 200, { ok: true });
  });

  // POST /api/auth/logout
  router.post('/api/auth/logout', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (token) {
      await getAuthRepository().deleteSession(sha256(decodeURIComponent(token)));
    }
    setCookie(res, COOKIE_NAME, '', { maxAge: 0, secure: req.secure });
    if (req.user) {
      appendAudit(null, req.user.id, 'auth.logout', `user:${req.user.id}`, {}, req.ip);
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
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      sendJson(res, 400, { error: 'Enter a valid email address' });
      return;
    }

    // Record the attempt
    setupAttempts.set(ip, {
      count: (sa && sa.until > Date.now() ? sa.count : 0) + 1,
      until: Date.now() + 3600_000,
    });

    // Atomically create the first admin only if no users exist yet.
    // createFirstAdmin() checks count=0 and inserts the user in a single atomic operation.
    // A concurrent request, or a pre-existing user in the database, returns AdminAlreadyExistsError.
    let user: import('./http.ts').PortalUser;
    try {
      const record = await getAuthRepository().createFirstAdmin({
        id: generateId(),
        email,
        name: str(name, 'Name', { max: 120 }).trim(),
        password_hash: hashPassword(password),
        is_admin: 1,
        disabled: 0,
        created_at: now(),
      });
      user = { id: record.id, email: record.email, name: record.name, is_admin: record.is_admin };
    } catch (e: unknown) {
      if (e instanceof AdminAlreadyExistsError) {
        sendJson(res, 409, { error: 'Setup is already done. Sign in instead.' });
        return;
      }
      if (e instanceof EmailAlreadyTakenError) {
        sendJson(res, 400, { error: 'A user with this email already exists' });
        return;
      }
      throw e;
    }

    // Write wizard settings if provided
    const db = getDb();
    const deployTarget = body.deployTarget ? String(body.deployTarget) : null;
    const provider = body.provider ? String(body.provider) : 'demo';

    // Collect settings to write atomically via the repository
    const settingPairs: Array<[string, string]> = [];
    const addSetting = (key: string, value: string) => settingPairs.push([key, value]);

    if (deployTarget) {
      addSetting('deployTarget', JSON.stringify(deployTarget));
    }

    addSetting('provider', JSON.stringify(provider));

    // Handle optional provider settings
    if (body.secretKeyArn) {
      addSetting('aws.secretKeyArn', JSON.stringify(String(body.secretKeyArn)));
    }
    if (body.awsRegion) {
      addSetting('aws.region', JSON.stringify(String(body.awsRegion)));
    }

    // Write all settings atomically
    const { getSettingsRepository, _updateSnapshotKeys } = await import('./repositories/settings.ts');
    const repo = getSettingsRepository();
    if (repo && settingPairs.length > 0) {
      await repo.setKeys(settingPairs);
      _updateSnapshotKeys(settingPairs);
    } else {
      // Fallback for pre-repository state (shouldn't happen post-startup)
      for (const [key, value] of settingPairs) {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
      }
    }

    await startSession(res, user.id, req.secure);
    appendAudit(null, user.id, 'auth.setup', `user:${user.id}`, { email: user.email }, req.ip);

    // Clear rate limit on success
    setupAttempts.delete(ip);

    sendJson(res, 200, { ok: true });
  });

  // GET /api/users  (admin: list users)
  router.get('/api/users', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!req.user.is_admin) { sendJson(res, 403, { error: 'Admin access required' }); return; }
    const users = await getAuthRepository().listUsersWithLastActive();
    sendJson(res, 200, { users: users.map((u) => ({
      id: u.id, email: u.email, name: u.name, is_admin: u.is_admin,
      disabled: u.disabled, created_at: u.created_at,
    })) });
  });

  // POST /api/users  (admin: create user)
  router.post('/api/users', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    if (!req.user.is_admin) { sendJson(res, 403, { error: 'Only admins can do this' }); return; }
    const body = req.body as Record<string, unknown>;
    const user = await createUser({
      email: String(body.email ?? ''),
      name: String(body.name ?? ''),
      password: String(body.password ?? ''),
      isAdmin: Boolean(body.isAdmin),
    });
    appendAudit(null, req.user.id, 'user.create', `user:${user.id}`, { email: user.email }, req.ip);
    sendJson(res, 201, { user });
  });

  // POST /api/auth/password  (change own password)
  // POST /api/auth/sign-out-others — end every other session of the signed-in person (other browsers and devices)
  router.post('/api/auth/sign-out-others', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const keep = token ? sha256(decodeURIComponent(token)) : '';
    const signedOut = await getAuthRepository().deleteSessionsForUser(req.user.id, keep);
    appendAudit(null, req.user.id, 'auth.sign_out_others', `user:${req.user.id}`, { sessions: signedOut }, req.ip);
    sendJson(res, 200, { ok: true, signedOut });
  });

  router.post('/api/auth/password', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const body = req.body as Record<string, unknown>;
    const user = await getAuthRepository().getUserById(req.user.id);
    if (!user || !verifyPassword(String(body.current ?? ''), user.password_hash)) {
      sendJson(res, 400, { error: 'Current password is incorrect' });
      return;
    }
    const newPassword = String(body.password ?? '');
    if (newPassword.length < 10) {
      sendJson(res, 400, { error: 'Password must be at least 10 characters' });
      return;
    }
    await getAuthRepository().updateUserFields(req.user.id, { password_hash: hashPassword(newPassword) });
    // A changed password ends the person's other sessions; this one stays.
    const cookieToken = parseCookies(req.headers.cookie)[COOKIE_NAME];
    await getAuthRepository().deleteSessionsForUser(req.user.id, cookieToken ? sha256(decodeURIComponent(cookieToken)) : '').catch(() => 0);
    appendAudit(null, req.user.id, 'auth.password_change', `user:${req.user.id}`, {}, req.ip);
    sendJson(res, 200, { ok: true });
  });
}
