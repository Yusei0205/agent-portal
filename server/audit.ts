/**
 * Audit log — append-only record of every mutating action that matters.
 *
 * Usage:
 *   audit(ctx, 'user.create', `user:${id}`, { email });
 *   auditRaw(actorId, 'session.start', `workflow:${wid}`, { title }, ip);
 */
import { run, all, one, type Row } from './db.ts';
import { get } from './http.ts';
import { now } from './util.ts';
import type { Ctx } from './http.ts';

export type AuditAction =
  // auth
  | 'auth.login' | 'auth.logout' | 'auth.setup' | 'auth.password_change'
  // users
  | 'user.create' | 'user.update' | 'user.delete' | 'user.disable' | 'user.enable'
  // project members
  | 'member.add' | 'member.remove' | 'member.update'
  // settings
  | 'settings.update'
  // secrets
  | 'secret.set' | 'secret.remove'
  // projects
  | 'project.create' | 'project.update' | 'project.delete' | 'project.archive'
  // repos / connections
  | 'repo.add' | 'repo.remove' | 'repo.update'
  | 'git_connection.add' | 'git_connection.remove' | 'git_connection.update'
  // sessions
  | 'session.start' | 'session.pause' | 'session.resume' | 'session.stop'
  | 'session.settings_change' | 'session.delete'
  // pushes / approvals
  | 'push.allowed' | 'push.denied' | 'push.auto'
  | 'approval.allowed' | 'approval.denied'
  // api tokens
  | 'api_token.create' | 'api_token.revoke'
  // Stage 3: governance
  | 'invitation.create' | 'invitation.revoke' | 'invitation.accept'
  | 'user.deactivate' | 'user.reactivate' | 'user.password_reset_link'
  | 'team.create' | 'team.update' | 'team.delete'
  | 'team.member_add' | 'team.member_remove'
  | 'team.project_add' | 'team.project_remove'
  | 'scim_token.create' | 'scim_token.revoke'
  | 'oidc.login';

/**
 * Write an audit row from a request context.
 * `target` is a "kind:id" string, e.g. "user:u_123" or "project:p_456".
 * `detail` is safe to log — never include secret values.
 */
export function audit(ctx: Ctx, action: AuditAction, target: string | null, detail: Record<string, unknown> = {}): void {
  auditRaw(ctx.user?.id ?? null, action, target, detail, ctx.ip);
}

/** Write an audit row without a request context (called from background workers). */
export function auditRaw(actorId: string | null, action: AuditAction, target: string | null, detail: Record<string, unknown> = {}, ip: string | null = null): void {
  run(
    'INSERT INTO audit_log (ts, actor_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
    now(),
    actorId ?? null,
    action,
    target ?? null,
    JSON.stringify(detail),
    ip ?? null,
  );
}

export function registerAuditRoutes(): void {
  /** GET /api/admin/audit-log?actor=…&project=…&action=…&from=…&to=…&limit=…&offset=… */
  get(
    '/api/admin/audit-log',
    (ctx) => {
      const actor = ctx.query.get('actor') ?? '';
      const project = ctx.query.get('project') ?? '';
      const action = ctx.query.get('action') ?? '';
      const from = ctx.query.get('from') ?? '';
      const to = ctx.query.get('to') ?? '';
      const limit = Math.min(500, Math.max(1, Number(ctx.query.get('limit') || 100)));
      const offset = Math.max(0, Number(ctx.query.get('offset') || 0));

      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (actor) { conditions.push('actor_id = ?'); params.push(actor); }
      if (project) { conditions.push("(target LIKE ? OR target LIKE ? OR detail LIKE ?)"); params.push(`project:${project}%`, `workflow:%`, `%"projectId":"${project}"%`); }
      if (action) { conditions.push("action LIKE ?"); params.push(`${action}%`); }
      if (from) { conditions.push('ts >= ?'); params.push(from); }
      if (to) { conditions.push('ts <= ?'); params.push(to); }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      const rows = all<Row>(
        `SELECT al.id, al.ts, al.actor_id, al.action, al.target, al.detail, al.ip,
                u.name AS actor_name, u.email AS actor_email
           FROM audit_log al
           LEFT JOIN users u ON u.id = al.actor_id
           ${where}
           ORDER BY al.id DESC
           LIMIT ? OFFSET ?`,
        ...params, limit, offset,
      );

      const total = (one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log ${where}`,
        ...params,
      )?.n ?? 0);

      return {
        entries: rows.map((r) => ({
          id: r.id,
          ts: r.ts,
          actor_id: r.actor_id,
          actor_name: r.actor_name ?? null,
          actor_email: r.actor_email ?? null,
          action: r.action,
          target: r.target,
          detail: (() => { try { return JSON.parse(r.detail); } catch { return {}; } })(),
          ip: r.ip,
        })),
        total,
        limit,
        offset,
      };
    },
    { auth: 'admin' },
  );
}
