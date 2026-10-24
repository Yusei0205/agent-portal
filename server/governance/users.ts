/** User lifecycle: deactivate, reactivate, password reset links and the self-service profile. */
import { randomBytes } from 'node:crypto';
import { all, insert, one, run as exec, update, type Row } from '../db.ts';
import { get, post, patch } from '../http.ts';
import { HttpError, badRequest, notFound, now, sha256, str } from '../util.ts';
import { audit, auditRaw, type AuditAction } from '../audit.ts';
import { hashPassword, checkPassword } from '../auth.ts';
import { monthSpend } from '../settings.ts';

export function registerUserLifecycleRoutes(): void {
  // ── User lifecycle ────────────────────────────────────────────────────────

  /** PATCH /api/users/:id/deactivate — deactivate + revoke sessions */
  post('/api/users/:id/deactivate', async (ctx) => {
    const target = one<Row>('SELECT id, email FROM users WHERE id = ?', ctx.params.id);
    if (!target) throw notFound('User not found');
    if (ctx.params.id === ctx.user!.id) throw badRequest('You cannot deactivate your own account');
    exec('UPDATE users SET disabled = 1 WHERE id = ?', target.id);
    exec('DELETE FROM sessions WHERE user_id = ?', target.id);
    exec("UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", now(), target.id);
    // Stop any running sessions owned by this user
    const running = all<Row>("SELECT id FROM workflows WHERE created_by = ? AND status = 'running'", target.id);
    for (const wf of running) {
      exec("UPDATE workflows SET status = 'stopped', stop_reason = 'account_disabled', updated_at = ? WHERE id = ?", now(), wf.id);
    }
    audit(ctx, 'user.disable', `user:${target.id}`, { stopped_sessions: running.length });
    return { ok: true, stopped_sessions: running.length };
  }, { auth: 'admin' });

  /** POST /api/users/:id/reactivate */
  post('/api/users/:id/reactivate', (ctx) => {
    const target = one<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = ?', ctx.params.id);
    if (!target) throw notFound('User not found');
    exec('UPDATE users SET disabled = 0 WHERE id = ?', target.id);
    audit(ctx, 'user.enable', `user:${target.id}`, {});
    return { ok: true };
  }, { auth: 'admin' });

  /**
   * POST /api/users/:id/password-reset-link — admin generates a copy-paste password reset link.
   * Returns the token once; it is only stored hashed.
   */
  post('/api/users/:id/password-reset-link', async (ctx) => {
    const target = one<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = ?', ctx.params.id);
    if (!target) throw notFound('User not found');

    // Invalidate any previous reset links for this user
    exec('DELETE FROM password_resets WHERE user_id = ?', target.id);

    const token = `pr_${randomBytes(30).toString('base64url')}`;
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();  // 24 hours
    insert('password_resets', {
      token_hash: tokenHash,
      user_id: target.id,
      expires_at: expiresAt,
      created_by: ctx.user!.id,
      created_at: now(),
    });
    audit(ctx, 'user.password_reset_link' as AuditAction, `user:${target.id}`, {});
    return { token, expires_at: expiresAt };
  }, { auth: 'admin' });

  /** POST /api/auth/reset-password — consume a password reset token */
  post('/api/auth/reset-password', async (ctx) => {
    const body = await ctx.json();
    const token = str(body.token, 'Token');
    const password = checkPassword(body.password);
    const tokenHash = sha256(token);
    const row = one<Row>('SELECT * FROM password_resets WHERE token_hash = ?', tokenHash);
    if (!row || row.used_at || row.expires_at < now()) {
      throw new HttpError(400, 'This reset link has expired or has already been used');
    }
    exec('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), row.user_id);
    exec('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', now(), tokenHash);
    // Revoke all existing sessions for security
    exec('DELETE FROM sessions WHERE user_id = ?', row.user_id);
    auditRaw(row.user_id, 'auth.password_change', `user:${row.user_id}`, { via: 'reset_link' });
    return { ok: true };
  }, { auth: 'public' });

  /** PATCH /api/profile — self-service profile update */
  patch('/api/profile', async (ctx) => {
    const body = await ctx.json();
    const u = ctx.user!;
    const p: Record<string, string> = {};
    if (body.name !== undefined) p.name = str(body.name, 'Name', { max: 120 }).trim();
    update('users', u.id, p);
    audit(ctx, 'user.update', `user:${u.id}`, { fields: Object.keys(p) });
    return { ok: true };
  });

  /** GET /api/profile — current user profile with spend */
  get('/api/profile', (ctx) => {
    const u = ctx.user!;
    const row = one<Row>('SELECT id, email, name, is_admin, created_at, google_sub, google_email FROM users WHERE id = ?', u.id);
    const spendUsd = monthSpend(undefined, u.id);
    const userRow = one<{ monthly_budget_usd: number | null }>('SELECT monthly_budget_usd FROM users WHERE id = ?', u.id);
    return {
      ...row,
      has_google: !!row?.google_sub,
      month_spend_usd: spendUsd,
      monthly_budget_usd: userRow?.monthly_budget_usd ?? null,
    };
  });
}
