/**
 * Audit log — append-only record of every mutating action that matters.
 *
 * Backward-compatible usage (db param accepted but ignored — repository is used):
 *   appendAudit(getDb(), actorId, 'auth.login', `user:${id}`, { email }, '1.2.3.4');
 *   auditRaw(actorId, 'session.start', `workflow:${wid}`, { title });
 *
 * All SQL (or DynamoDB writes) for audit_log live in the repository.
 *
 * Routes:
 *   GET /api/admin/audit-log  — list entries (admin only)
 */

import type { DatabaseSync } from 'node:sqlite';
import { isDbOpen } from './db.ts';
import { router, sendJson, requireAuth, registerBackgroundWrite } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getAuditRepository } from './repositories/audit.ts';

/**
 * Append a row to the audit log.
 * Fire-and-forget: do NOT await this function.
 * The db parameter is accepted for backward compatibility but is IGNORED;
 * the repository implementation (SQLite or DynamoDB) is used instead.
 *
 * @param db       Accepted but ignored (backward compat). Pass getDb() or null.
 * @param actorId  ID of the user performing the action, or null for system actions.
 * @param action   Dot-separated action string, e.g. 'auth.login'.
 * @param target   Entity being acted on, e.g. 'user:u_123', or null.
 * @param detail   Safe-to-log details (no secrets). Will be JSON-serialised.
 * @param ip       Client IP address, or null.
 */
export function appendAudit(
  db: DatabaseSync | null | undefined,
  actorId: string | null,
  action: string,
  target: string | null,
  detail: object | null,
  ip: string | null,
): void {
  const p = getAuditRepository()
    .append({ actorId, action, target, detail: detail ?? {}, ip })
    .catch(() => {/* best-effort audit */});
  registerBackgroundWrite(p);
}

/**
 * Record an audit entry using the singleton repository (no db param needed).
 * Safe to call when the DB may be closing. Errors are silently swallowed.
 */
export function auditRaw(
  actorId: string | null,
  action: string,
  target: string | null,
  detail: object,
): void {
  try {
    if (!isDbOpen()) return;
    const p = getAuditRepository()
      .append({ actorId, action, target, detail, ip: null })
      .catch(() => {/* best-effort */});
    registerBackgroundWrite(p);
  } catch {
    /* best-effort audit */
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/audit-log
 * List audit log entries. Admin only.
 * Query: ?limit=100&offset=0&actorId=&action=&cursor=
 */
export function registerAuditRoutes(): void {
  router.get(
    '/api/admin/audit-log',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }

      const limit = Math.min(500, Math.max(1, Number(req.query.get('limit') || 100)));
      const offset = Math.max(0, Number(req.query.get('offset') || 0));
      const actorId = req.query.get('actorId') || undefined;
      const action = req.query.get('action') || undefined;
      const cursor = req.query.get('cursor') || undefined;

      const result = await getAuditRepository().query({
        limit,
        offset,
        actorId,
        action,
        cursor,
      });

      sendJson(res, 200, {
        entries: result.entries.map((r) => ({
          id: r.id,
          ts: r.ts,
          actor_id: r.actor_id ?? null,
          actor_name: r.actor_name ?? null,
          actor_email: r.actor_email ?? null,
          action: r.action,
          target: r.target ?? null,
          detail: r.detail,
          ip: r.ip ?? null,
        })),
        total: result.total,   // exact integer in SQLite; null in DynamoDB
        hasMore: result.hasMore,
        limit,
        offset,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      });
    }),
  );
}
