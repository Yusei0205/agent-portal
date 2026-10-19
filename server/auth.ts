import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { all, insert, one, run, update } from './db.ts';
import { get, post, patch, del, setCookie, type Ctx, type User } from './http.ts';
import { HttpError, badRequest, newId, now, sha256, str } from './util.ts';

const COOKIE = 'portal_session';
const SESSION_DAYS = 14;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

function checkPassword(p: unknown): string {
  const pw = str(p, 'Password', { max: 200 });
  if (pw.length < 10) throw badRequest('Password must be at least 10 characters');
  return pw;
}

function checkEmail(e: unknown): string {
  const email = str(e, 'Email', { max: 200 }).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('Enter a valid email address');
  return email;
}

export function userCount(): number {
  return one<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
}

export function createUser(input: { email: string; name: string; password: string; isAdmin: boolean }): User {
  const email = checkEmail(input.email);
  if (one('SELECT id FROM users WHERE email = ?', email)) throw badRequest('A user with this email already exists');
  const id = newId('u_');
  insert('users', {
    id,
    email,
    name: str(input.name, 'Name', { max: 120 }).trim(),
    password_hash: hashPassword(checkPassword(input.password)),
    is_admin: input.isAdmin ? 1 : 0,
    disabled: 0,
    created_at: now(),
  });
  return one<User>('SELECT id, email, name, is_admin FROM users WHERE id = ?', id)!;
}

function startSession(ctx: Ctx, userId: string): void {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  insert('sessions', { token_hash: sha256(token), user_id: userId, created_at: now(), expires_at: expires });
  setCookie(ctx.res, COOKIE, token, { maxAge: SESSION_DAYS * 86400, secure: ctx.secure });
}

export function authenticate(ctx: Ctx): User | null {
  const cookie = ctx.req.headers.cookie || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const row = one<User & { expires_at: string; disabled: number }>(
    `SELECT u.id, u.email, u.name, u.is_admin, u.disabled, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(decodeURIComponent(m[1])),
  );
  if (!row || row.disabled || row.expires_at < now()) return null;
  return { id: row.id, email: row.email, name: row.name, is_admin: row.is_admin };
}

// Simple in-memory throttle: 8 failed attempts per 15 minutes per IP+email.
const failures = new Map<string, { count: number; until: number }>();
function throttleKey(ctx: Ctx, email: string) {
  return `${ctx.ip}|${email}`;
}

export function registerAuthRoutes(): void {
  get('/api/auth/state', (ctx) => ({ needsSetup: userCount() === 0, user: ctx.user }), { auth: 'public' });

  get('/api/auth/me', (ctx) => ({ user: ctx.user }));

  post(
    '/api/auth/setup',
    async (ctx) => {
      if (userCount() > 0) throw new HttpError(409, 'Setup is already done. Sign in instead.');
      const body = await ctx.json();
      const user = createUser({ email: body.email, name: body.name, password: body.password, isAdmin: true });
      startSession(ctx, user.id);
      return { user };
    },
    { auth: 'public' },
  );

  post(
    '/api/auth/login',
    async (ctx) => {
      const body = await ctx.json();
      const email = String(body.email || '').trim().toLowerCase();
      const key = throttleKey(ctx, email);
      const f = failures.get(key);
      if (f && f.count >= 8 && f.until > Date.now()) {
        throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
      }
      const row = one<{ id: string; password_hash: string; disabled: number }>(
        'SELECT id, password_hash, disabled FROM users WHERE email = ?',
        email,
      );
      if (!row || row.disabled || !verifyPassword(String(body.password || ''), row.password_hash)) {
        const next = { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60_000 };
        failures.set(key, next);
        throw new HttpError(401, 'Email or password is incorrect');
      }
      failures.delete(key);
      startSession(ctx, row.id);
      return { user: one('SELECT id, email, name, is_admin FROM users WHERE id = ?', row.id) };
    },
    { auth: 'public' },
  );

  post(
    '/api/auth/logout',
    (ctx) => {
      const m = (ctx.req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
      if (m) run('DELETE FROM sessions WHERE token_hash = ?', sha256(decodeURIComponent(m[1])));
      setCookie(ctx.res, COOKIE, '', { maxAge: 0, secure: ctx.secure });
      return { ok: true };
    },
    { auth: 'public' },
  );

  post('/api/auth/password', async (ctx) => {
    const body = await ctx.json();
    const row = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', ctx.user!.id)!;
    if (!verifyPassword(String(body.current || ''), row.password_hash)) throw badRequest('Current password is incorrect');
    update('users', ctx.user!.id, { password_hash: hashPassword(checkPassword(body.password)) });
    return { ok: true };
  });

  // ---- User management (admins) ----
  get(
    '/api/users',
    () => ({ users: all('SELECT id, email, name, is_admin, disabled, created_at FROM users ORDER BY created_at') }),
    { auth: 'user' },
  );

  post(
    '/api/users',
    async (ctx) => {
      const body = await ctx.json();
      return { user: createUser({ email: body.email, name: body.name, password: body.password, isAdmin: !!body.isAdmin }) };
    },
    { auth: 'admin' },
  );

  patch(
    '/api/users/:id',
    async (ctx) => {
      const body = await ctx.json();
      const target = one('SELECT id FROM users WHERE id = ?', ctx.params.id);
      if (!target) throw new HttpError(404, 'User not found');
      const p: Record<string, any> = {};
      if (body.name !== undefined) p.name = str(body.name, 'Name', { max: 120 });
      if (body.isAdmin !== undefined) {
        if (ctx.params.id === ctx.user!.id && !body.isAdmin) throw badRequest('You cannot remove your own admin access');
        p.is_admin = body.isAdmin ? 1 : 0;
      }
      if (body.disabled !== undefined) {
        if (ctx.params.id === ctx.user!.id) throw badRequest('You cannot disable your own account');
        p.disabled = body.disabled ? 1 : 0;
        if (body.disabled) run('DELETE FROM sessions WHERE user_id = ?', ctx.params.id);
      }
      if (body.password) p.password_hash = hashPassword(checkPassword(body.password));
      update('users', ctx.params.id, p);
      return { ok: true };
    },
    { auth: 'admin' },
  );

  del(
    '/api/users/:id',
    (ctx) => {
      if (ctx.params.id === ctx.user!.id) throw badRequest('You cannot delete your own account');
      run('DELETE FROM users WHERE id = ?', ctx.params.id);
      return { ok: true };
    },
    { auth: 'admin' },
  );
}

export function cleanupSessions(): void {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
}
