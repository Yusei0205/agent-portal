/**
 * Personal + project API tokens.
 *
 * A token acts as the person who created it. Only its SHA-256 hash is stored;
 * the raw token is shown once on creation.
 *
 * Token format: ap_<random 32 hex chars>
 *
 * Routes:
 *   GET    /api/api-tokens              — list user's own tokens
 *   POST   /api/api-tokens              — create token (returns token once)
 *   DELETE /api/api-tokens/:id          — revoke
 *   GET    /api/admin/api-tokens        — list all tokens (admin only)
 *
 * Middleware:
 *   authenticateApiToken — reads Authorization: Bearer ap_... header,
 *   verifies against DB, sets req.user and req.tokenScope
 */

import { randomBytes } from 'node:crypto';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { all, one, run, insert } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now, str, badRequest, sha256 } from './util.ts';

export const TOKEN_PREFIX = 'ap_';
const MAX_ACTIVE = 10;

export type TokenScope = 'read' | 'write';

// ── View helper ───────────────────────────────────────────────────────────────

function tokenView(t: Row) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope,
    project_id: t.project_id ?? null,
    created_at: t.created_at,
    expires_at: t.expires_at,
    last_used_at: t.last_used_at ?? null,
    revoked_at: t.revoked_at ?? null,
    active: !t.revoked_at && String(t.expires_at) >= now(),
  };
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Reads Authorization: Bearer ap_... header, sha256-hashes the token,
 * looks up in api_tokens table, verifies not revoked/expired, sets req.user.
 * Returns true if authenticated via token, false otherwise.
 */
export function authenticateApiToken(req: PortalRequest): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const token = authHeader.slice(7).trim();
  if (!token.startsWith(TOKEN_PREFIX)) return false;

  const hash = sha256(token);
  const row = one<Row>(
    `SELECT t.id, t.scope, t.expires_at, t.revoked_at, t.last_used_at,
            u.id AS user_id, u.email, u.name, u.is_admin, u.disabled
     FROM api_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?`,
    hash,
  );

  if (!row) return false;
  if (row.revoked_at) return false;
  if (row.disabled) return false;
  if (row.expires_at && String(row.expires_at) < now()) return false;

  // Update last_used_at at most once per minute
  if (!row.last_used_at || Date.parse(String(row.last_used_at)) < Date.now() - 60_000) {
    run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), String(row.id));
  }

  req.user = {
    id: String(row.user_id),
    email: String(row.email),
    name: String(row.name),
    is_admin: Number(row.is_admin),
  };
  // Attach token scope to request for downstream use
  (req as PortalRequest & { tokenScope?: TokenScope }).tokenScope = row.scope as TokenScope;
  return true;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerApiTokenRoutes(): void {
  /** GET /api/api-tokens — list user's own tokens (no hash, prefix only) */
  router.get(
    '/api/api-tokens',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const tokens = all<Row>(
        `SELECT id, name, prefix, scope, project_id, created_at, expires_at,
                last_used_at, revoked_at
         FROM api_tokens
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 50`,
        req.user!.id,
      );
      sendJson(res, 200, { tokens: tokens.map(tokenView), maxActive: MAX_ACTIVE });
    }),
  );

  /** POST /api/api-tokens — create a new token */
  router.post(
    '/api/api-tokens',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const body = req.body as Record<string, unknown>;
      const name = str(body.name, 'Token name', { max: 80 }).trim();
      if (!name) {
        sendJson(res, 400, { error: 'Name the token after where it will be used' });
        return;
      }

      const scope: TokenScope = body.scope === 'write' ? 'write' : 'read';
      const projectId = body.projectId ? String(body.projectId) : null;

      // Optional expiry — defaults to 90 days
      let expiresAt: string;
      if (body.expiresAt) {
        const d = new Date(String(body.expiresAt));
        if (isNaN(d.getTime())) {
          sendJson(res, 400, { error: 'Invalid expiresAt date' });
          return;
        }
        expiresAt = d.toISOString();
      } else {
        expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
      }

      // Check active token limit
      const active = Number(
        one<Row>(
          'SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at >= ?',
          req.user!.id,
          now(),
        )?.n ?? 0,
      );
      if (active >= MAX_ACTIVE) {
        sendJson(res, 400, { error: `You already have ${MAX_ACTIVE} active tokens. Revoke one first.` });
        return;
      }

      // Generate: ap_ + 32 hex chars (16 random bytes)
      const token = `${TOKEN_PREFIX}${randomBytes(16).toString('hex')}`;
      const id = generateId();

      insert('api_tokens', {
        id,
        user_id: req.user!.id,
        name,
        token_hash: sha256(token),
        prefix: token.slice(0, 10),
        scope,
        project_id: projectId,
        expires_at: expiresAt,
        created_at: now(),
      });

      const info = tokenView(
        one<Row>('SELECT * FROM api_tokens WHERE id = ?', id)!,
      );
      // Return the raw token ONCE — it cannot be retrieved again
      sendJson(res, 201, { token, info });
    }),
  );

  /** DELETE /api/api-tokens/:id — revoke a token */
  router.delete(
    '/api/api-tokens/:id',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const t = one<Row>(
        'SELECT * FROM api_tokens WHERE id = ? AND user_id = ?',
        req.params.id,
        req.user!.id,
      );
      if (!t) {
        sendJson(res, 404, { error: 'Token not found' });
        return;
      }
      if (!t.revoked_at) {
        run('UPDATE api_tokens SET revoked_at = ? WHERE id = ?', now(), String(t.id));
      }
      sendJson(res, 200, { ok: true });
    }),
  );

  /** GET /api/admin/api-tokens — list all tokens (admin only) */
  router.get(
    '/api/admin/api-tokens',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }
      const tokens = all<Row>(
        `SELECT t.id, t.name, t.prefix, t.scope, t.project_id,
                t.created_at, t.expires_at, t.last_used_at, t.revoked_at,
                u.id AS user_id, u.name AS user_name, u.email AS user_email
         FROM api_tokens t
         JOIN users u ON u.id = t.user_id
         ORDER BY t.created_at DESC
         LIMIT 200`,
      );
      sendJson(res, 200, {
        tokens: tokens.map((t) => ({
          ...tokenView(t),
          user_id: String(t.user_id),
          user_name: String(t.user_name),
          user_email: String(t.user_email),
        })),
      });
    }),
  );
}
