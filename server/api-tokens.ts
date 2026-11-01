/**
 * Personal + project API tokens.
 *
 * A token acts as the person who created it. Only its SHA-256 hash is stored;
 * the raw token is shown once on creation.
 *
 * Token format: ap_<random 32 hex chars>
 *
 * Scopes (multi-valued, stored as JSON array in `scopes` column):
 *   read    — always granted; list sessions, get transcripts, list/get reviews
 *   write   — sessions: start, prompt, stop; config edits
 *   review  — start reviews/scans, post PR comments
 *   merge   — merge pull requests
 *
 * Routes (browser-session only — API tokens are refused):
 *   GET    /api/api-tokens              — list user's own tokens
 *   POST   /api/api-tokens              — create token (returns token once)
 *   DELETE /api/api-tokens/:id          — revoke
 *   GET    /api/admin/api-tokens        — list all tokens (admin only)
 */

import { randomBytes } from 'node:crypto';
import { router, sendJson, requireCookieAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { generateId, now, str, sha256 } from './util.ts';
import { getApiTokenRepository } from './repositories/api-tokens.ts';
import { SqliteApiTokenRepository } from './repositories/api-tokens-sqlite.ts';
import type { TokenRecord } from './repositories/api-tokens.ts';

export const TOKEN_PREFIX = 'ap_';
const MAX_ACTIVE = 10;

export type TokenScope = 'read' | 'write' | 'review' | 'merge' | 'tests' | 'delegate';

const VALID_SCOPES: TokenScope[] = ['read', 'write', 'review', 'merge', 'tests'];
// 'delegate' is an internal scope created only by createRunToken() — not user-creatable.

// ── View helper ───────────────────────────────────────────────────────────────

function tokenView(t: TokenRecord) {
  const rawScopes = t.scopes;
  const scopes: string[] = rawScopes
    ? ((): string[] => {
        try { return JSON.parse(rawScopes) as string[]; }
        catch { return [t.scope === 'write' ? 'write' : 'read']; }
      })()
    : (t.scope === 'write' ? ['read', 'write'] : ['read']);
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope,
    scopes,
    project_id: t.project_id ?? null,
    created_at: t.created_at,
    expires_at: t.expires_at,
    last_used_at: t.last_used_at ?? null,
    revoked_at: t.revoked_at ?? null,
    active: !t.revoked_at && t.expires_at >= now(),
  };
}

// ── Legacy middleware (kept as export; auth.ts handles scope propagation now) ─

/**
 * @deprecated Use req.tokenScopes (set by auth.ts authenticator) instead.
 *
 * Reads Authorization: Bearer ap_... header, sha256-hashes the token,
 * looks up via the SQLite repository synchronously, verifies not
 * revoked/expired, sets req.user and req.tokenScopes.
 * Returns true if authenticated via token.
 *
 * This function is intentionally synchronous for backward compatibility
 * with existing tests.  It only works with the SQLite repository.
 */
export function authenticateApiToken(req: PortalRequest): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const token = authHeader.slice(7).trim();
  if (!token.startsWith(TOKEN_PREFIX)) return false;

  const hash = sha256(token);

  const repo = getApiTokenRepository();
  if (!(repo instanceof SqliteApiTokenRepository)) {
    // Should not happen during normal usage; DynamoDB auth goes through
    // the async path in auth.ts.
    throw new Error(
      'authenticateApiToken() requires the SQLite repository. ' +
        'Use the async authenticate() function from auth.ts instead.',
    );
  }

  const row = repo.getByHashSync(hash);
  if (!row) return false;
  if (row.revoked_at) return false;
  if (row.user_disabled) return false;
  if (row.expires_at && row.expires_at < now()) return false;

  // Update last_used_at at most once per minute
  if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - 60_000) {
    repo.updateLastUsedSync(row.id, now());
  }

  req.user = {
    id: row.user_id,
    email: row.user_email,
    name: row.user_name,
    is_admin: row.user_is_admin,
  };
  const rawScopes = row.scopes;
  req.tokenScopes = rawScopes
    ? ((): string[] => { try { return JSON.parse(rawScopes) as string[]; } catch { return ['read']; } })()
    : (row.scope === 'write' ? ['read', 'write'] : ['read']);
  req.authViaToken = true;
  return true;
}

// ── Routes (browser-session only) ────────────────────────────────────────────

export function registerApiTokenRoutes(): void {
  /** GET /api/api-tokens — list user's own tokens (browser-session only) */
  router.get(
    '/api/api-tokens',
    requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
      const repo = getApiTokenRepository();
      const tokens = await repo.listByUser(req.user!.id);
      sendJson(res, 200, { tokens: tokens.map(tokenView), maxActive: MAX_ACTIVE });
    }),
  );

  /** POST /api/api-tokens — create a new token (browser-session only) */
  router.post(
    '/api/api-tokens',
    requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
      const body = req.body as Record<string, unknown>;
      const name = str(body.name, 'Token name', { max: 80 }).trim();
      if (!name) {
        sendJson(res, 400, { error: 'Name the token after where it will be used' });
        return;
      }

      // Support both legacy `scope` (string) and new `scopes` (array) fields.
      let scopes: TokenScope[];
      if (Array.isArray(body.scopes)) {
        scopes = ['read', ...((body.scopes as unknown[])
          .map(String)
          .filter((s) => VALID_SCOPES.includes(s as TokenScope) && s !== 'read') as TokenScope[])];
      } else {
        const legacyScope = body.scope === 'write' ? 'write' : 'read';
        scopes = legacyScope === 'write' ? ['read', 'write'] : ['read'];
      }
      // Derive legacy scope for backward compatibility
      const scopeLegacy: TokenScope = scopes.includes('write') ? 'write' : 'read';

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

      const repo = getApiTokenRepository();

      // Check active token limit
      const active = await repo.countActive(req.user!.id);
      if (active >= MAX_ACTIVE) {
        sendJson(res, 400, { error: `You already have ${MAX_ACTIVE} active tokens. Revoke one first.` });
        return;
      }

      const token = `${TOKEN_PREFIX}${randomBytes(16).toString('hex')}`;
      const id = generateId();

      const record = await repo.create({
        id,
        user_id: req.user!.id,
        name,
        token_hash: sha256(token),
        prefix: token.slice(0, 10),
        scope: scopeLegacy,
        scopes: JSON.stringify(scopes),
        project_id: projectId,
        expires_at: expiresAt,
        created_at: now(),
      });

      sendJson(res, 201, { token, info: tokenView(record) });
    }),
  );

  /** DELETE /api/api-tokens/:id — revoke a token (browser-session only) */
  router.delete(
    '/api/api-tokens/:id',
    requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
      const repo = getApiTokenRepository();
      const t = await repo.getByIdAndUser(req.params.id, req.user!.id);
      if (!t) {
        sendJson(res, 404, { error: 'Token not found' });
        return;
      }
      if (!t.revoked_at) {
        await repo.revoke(t.id, t.user_id, now());
      }
      sendJson(res, 200, { ok: true });
    }),
  );

  /** GET /api/admin/api-tokens — list all tokens (admin, browser-session only) */
  router.get(
    '/api/admin/api-tokens',
    requireCookieAuth(async (req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }
      const repo = getApiTokenRepository();
      const tokens = await repo.listAll();
      sendJson(res, 200, {
        tokens: tokens.map((t) => ({
          ...tokenView(t),
          user_id: t.user_id,
          user_name: t.user_name,
          user_email: t.user_email,
        })),
      });
    }),
  );
}
