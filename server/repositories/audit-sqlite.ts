/**
 * SQLite implementation of AuditRepository.
 *
 * All SQL for audit_log lives here.
 */

import { all, one, getDb } from '../db.ts';
import type { Row } from '../db.ts';
import { now } from '../util.ts';
import type {
  AuditRepository,
  AuditEntry,
  AppendAuditInput,
  AuditQueryOptions,
  AuditQueryResult,
} from './audit.ts';

function toEntry(row: Row): AuditEntry {
  let detail: object = {};
  try { detail = JSON.parse(String(row.detail ?? '{}')); } catch { /* keep {} */ }

  return {
    id:           Number(row.id),
    ts:           String(row.ts),
    actor_id:     row.actor_id != null ? String(row.actor_id) : null,
    actor_name:   row.actor_name != null ? String(row.actor_name) : null,
    actor_email:  row.actor_email != null ? String(row.actor_email) : null,
    action:       String(row.action),
    target:       row.target != null ? String(row.target) : null,
    detail,
    ip:           row.ip != null ? String(row.ip) : null,
  };
}

export class SqliteAuditRepository implements AuditRepository {
  async append(input: AppendAuditInput): Promise<void> {
    const db = getDb();
    db.prepare(
      'INSERT INTO audit_log (ts, actor_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      now(),
      input.actorId ?? null,
      input.action,
      input.target ?? null,
      JSON.stringify(input.detail ?? {}),
      input.ip ?? null,
    );
  }

  async query(opts: AuditQueryOptions): Promise<AuditQueryResult> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.actorId) {
      conditions.push('al.actor_id = ?');
      params.push(opts.actorId);
    }
    if (opts.action) {
      conditions.push('al.action LIKE ?');
      params.push(`${opts.action}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Decode offset from cursor (if provided) or fall back to opts.offset
    let offset = opts.offset ?? 0;
    if (opts.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(opts.cursor, 'base64').toString('utf8')) as { offset?: number };
        if (typeof decoded.offset === 'number') offset = decoded.offset;
      } catch {
        // Ignore invalid cursor — use default offset
      }
    }

    const entries = all<Row>(
      `SELECT al.id, al.ts, al.actor_id, al.action, al.target, al.detail, al.ip,
              u.name AS actor_name, u.email AS actor_email
         FROM audit_log al
         LEFT JOIN users u ON u.id = al.actor_id
         ${where}
         ORDER BY al.id DESC
         LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      offset,
    );

    const total = Number(
      one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log al ${where}`,
        ...params,
      )?.n ?? 0,
    );

    const hasMore = offset + entries.length < total;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ offset: offset + opts.limit })).toString('base64')
      : undefined;

    return {
      entries: entries.map(toEntry),
      total,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
}
