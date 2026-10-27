/**
 * Audit log — append-only record of every mutating action that matters.
 *
 * Usage:
 *   appendAudit(db, actorId, 'auth.login', `user:${id}`, { email }, '1.2.3.4');
 */

import type { DatabaseSync } from 'node:sqlite';
import { getDb, isDbOpen } from './db.ts';
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
