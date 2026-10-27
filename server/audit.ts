/**
 * Audit log — append-only record of every mutating action that matters.
 *
 * Usage:
 *   appendAudit(db, actorId, 'auth.login', `user:${id}`, { email }, '1.2.3.4');
 *   auditRaw(actorId, 'session.start', `workflow:${wid}`, { title });
 *
 * Routes:
 *   GET /api/admin/audit-log  — list entries (admin only)
 */

import type { DatabaseSync } from 'node:sqlite';
import { getDb, isDbOpen, all, one } from './db.ts';
import type { Row } from './db.ts';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { now } from './util.ts';

/**
 * Append a row to the `audit_log` table.
 *
 * @param db       The open database connection.
 * @param actorId  ID of the user performing the action, or null for system actions.
 * @param action   Dot-separated action string, e.g. 'auth.login', 'user.create'.
 * @param target   Entity being acted on, e.g. 'user:u_123', or null.
 * @param detail   Safe-to-log details (no secrets). Will be JSON-serialised.
 * @param ip       Client IP address, or null.
 */
export function appendAudit(
  db: DatabaseSync,
  actorId: string | null,
  action: string,
  target: string | null,
  detail: object | null,
  ip: string | null,
): void {
  db.prepare(
    'INSERT INTO audit_log (ts, actor_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    now(),
    actorId ?? null,
    action,
    target ?? null,
    JSON.stringify(detail ?? {}),
    ip ?? null,
  );
}



/**
 * Record an audit entry using the singleton DB. Safe to call when the DB may be closing
 * (catches all errors). For use by vault-generated.ts and similar modules.
 */
export function auditRaw(
  actorId: string | null,
  action: string,
  target: string | null,
  detail: object,
): void {
  try {
    if (!isDbOpen()) return;
    getDb().prepare(
      'INSERT INTO audit_log (ts, actor_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(now(), actorId ?? null, action, target ?? null, JSON.stringify(detail), null);
  } catch {
    /* best-effort audit */
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/audit-log
 * List audit log entries. Admin only.
 * Query: ?limit=100&offset=0&actorId=&action=
 */
export function registerAuditRoutes(): void {
  router.get(
    '/api/admin/audit-log',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) {
        sendJson(res, 403, { error: 'Admin access required' });
        return;
      }

      const limit = Math.min(500, Math.max(1, Number(req.query.get('limit') || 100)));
      const offset = Math.max(0, Number(req.query.get('offset') || 0));
      const actorId = req.query.get('actorId') || '';
      const action = req.query.get('action') || '';

      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (actorId) { conditions.push('al.actor_id = ?'); params.push(actorId); }
      if (action) { conditions.push('al.action LIKE ?'); params.push(`${action}%`); }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const entries = all<Row>(
        `SELECT al.id, al.ts, al.actor_id, al.action, al.target, al.detail, al.ip,
                u.name AS actor_name, u.email AS actor_email
         FROM audit_log al
         LEFT JOIN users u ON u.id = al.actor_id
         ${where}
         ORDER BY al.id DESC
         LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );

      const total = Number(
        one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM audit_log al ${where}`,
          ...params,
        )?.n ?? 0,
      );

      sendJson(res, 200, {
        entries: entries.map((r) => ({
          id: r.id,
          ts: r.ts,
          actor_id: r.actor_id ?? null,
          actor_name: r.actor_name ?? null,
          actor_email: r.actor_email ?? null,
          action: r.action,
          target: r.target ?? null,
          detail: (() => { try { return JSON.parse(String(r.detail ?? '{}')); } catch { return {}; } })(),
          ip: r.ip ?? null,
        })),
        total,
        limit,
        offset,
      });
    }),
  );
}
