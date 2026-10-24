/**
 * Personal access tokens, so scripts and CI can drive the portal through the same REST API the app uses.
 *
 * A token acts as the person who made it: sessions it starts are theirs. Only its SHA-256 is stored; the token itself
 * is shown once. Read tokens may only read; write tokens may also start, steer and stop sessions and runs, answer
 * questions and edit the project's .claude/.kiro files. Everything else stays browser-only: users, tokens, settings,
 * connections, integrations, AWS accounts, admin actions, pushing to remotes and protected config files. So a leaked
 * token cannot change who has access, mint more tokens, read or replace secrets, or push code.
 */
import { randomBytes } from 'node:crypto';
import { all, insert, one, run as exec, type Row } from './db.ts';
import { del, get, post, setTokenPolicy, type Ctx } from './http.ts';
import { HttpError, badRequest, newId, now, sha256, str } from './util.ts';

export const TOKEN_PREFIX = 'ap_';
const MAX_ACTIVE = 10;
const DAYS = [30, 90, 365];

/** Routes a token may call, by method and the pattern they were registered with. */
const READ_ROUTES = new Set([
  'GET /api/meta',
  'GET /api/projects',
  'GET /api/projects/:pid',
  'GET /api/projects/:pid/agents',
  'GET /api/projects/:pid/documents',
  'GET /api/projects/:pid/search',
  'GET /api/projects/:pid/repos',
  'GET /api/repos/:id/branches',
  'GET /api/projects/:pid/workspaces',
  'GET /api/projects/:pid/workflows',
  'GET /api/workflows/:id',
  'GET /api/workflows/:id/context',
  'GET /api/projects/:pid/runs',
  'GET /api/runs/:id',
  'GET /api/runs/:id/changes',
  'GET /api/runs/:id/file',
  'GET /api/runs/:id/stream',
  'GET /api/projects/:pid/config/files',
  'GET /api/projects/:pid/config/file',
  'GET /api/projects/:pid/config/export',
]);
const WRITE_ROUTES = new Set([
  'POST /api/projects/:pid/workflows',
  'PUT /api/workflows/:id',
  'POST /api/workflows/:id/messages',
  'POST /api/workflows/:id/resume',
  'POST /api/workflows/:id/pause',
  'POST /api/workflows/:id/stop',
  'DELETE /api/workflows/:id',
  'POST /api/workflows/:id/context',
  'DELETE /api/workflows/:id/context/:cid',
  'POST /api/runs/:id/stop',
  'POST /api/runs/:id/continue',
  'POST /api/inputs/:id/answer',
  'PUT /api/projects/:pid/config/file',
  'POST /api/projects/:pid/config/folder',
  'DELETE /api/projects/:pid/config/file',
]);

export type TokenScope = 'read' | 'write';

/** Look a bearer token up; null when it is unknown, revoked, expired or its owner can no longer sign in. */
export function tokenUser(token: string): { user: { id: string; email: string; name: string; is_admin: number }; token: { id: string; scope: TokenScope } } | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = one<Row>(
    `SELECT t.id, t.scope, t.expires_at, t.revoked_at, t.last_used_at, u.id AS user_id, u.email, u.name, u.is_admin, u.disabled
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    sha256(token),
  );
  if (!row || row.revoked_at || row.disabled || row.expires_at < now()) return null;
  // Remember use, at most once a minute.
  if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - 60_000) exec('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.id);
  return { user: { id: row.user_id, email: row.email, name: row.name, is_admin: row.is_admin }, token: { id: row.id, scope: row.scope } };
}

/** Called for every request made with a token, before its handler. */
function policy(ctx: Ctx, route: { method: string; pattern: string; auth: string }): void {
  const key = `${route.method} ${route.pattern}`;
  if (route.auth === 'admin' || (!READ_ROUTES.has(key) && !WRITE_ROUTES.has(key))) {
    throw new HttpError(403, 'API tokens cannot use this endpoint. It can only be used from a signed-in browser.');
  }
  if (WRITE_ROUTES.has(key) && ctx.apiToken!.scope !== 'write') throw new HttpError(403, 'This token can only read. Create a token with write access to do this.');
}

function view(t: Row) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope,
    created_at: t.created_at,
    expires_at: t.expires_at,
    last_used_at: t.last_used_at,
    revoked_at: t.revoked_at,
    active: !t.revoked_at && t.expires_at >= now(),
  };
}

const browserOnly = (ctx: Ctx) => {
  if (ctx.apiToken) throw new HttpError(403, 'Tokens can only be managed from a signed-in browser');
};

export function registerApiTokenRoutes(): void {
  setTokenPolicy(policy);

  get('/api/tokens', (ctx) => {
    browserOnly(ctx);
    return { tokens: all<Row>('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', ctx.user!.id).map(view), maxActive: MAX_ACTIVE };
  });

  post('/api/tokens', async (ctx) => {
    browserOnly(ctx);
    const body = await ctx.json();
    const name = str(body.name, 'Token name', { max: 80 }).trim();
    if (!name) throw badRequest('Name the token after where it will be used');
    const days = Number(body.days ?? 90);
    if (!DAYS.includes(days)) throw badRequest('Choose 30, 90 or 365 days');
    const scope: TokenScope = body.scope === 'write' ? 'write' : 'read';
    const active = Number(one<Row>('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at >= ?', ctx.user!.id, now())?.n ?? 0);
    if (active >= MAX_ACTIVE) throw badRequest(`You already have ${MAX_ACTIVE} active tokens. Revoke one first.`);
    const token = `${TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`;
    const id = newId('tk_');
    insert('api_tokens', {
      id,
      user_id: ctx.user!.id,
      name,
      token_hash: sha256(token),
      prefix: token.slice(0, 10),
      scope,
      expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      created_at: now(),
    });
    // The only time the token is ever shown.
    return { token, info: view(one<Row>('SELECT * FROM api_tokens WHERE id = ?', id)!) };
  });

  del('/api/tokens/:id', (ctx) => {
    browserOnly(ctx);
    const t = one<Row>('SELECT * FROM api_tokens WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user!.id);
    if (!t) throw new HttpError(404, 'Token not found');
    if (!t.revoked_at) exec('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', now(), t.id);
    return { ok: true };
  });
}
