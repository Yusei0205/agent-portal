/** Invitations via copy-paste link: single-use, expiring, hashed at rest. */
import { randomBytes } from 'node:crypto';
import { all, insert, one, run as exec, type Row } from '../db.ts';
import { get, post, del } from '../http.ts';
import { HttpError, badRequest, forbidden, newId, notFound, now, sha256, str } from '../util.ts';
import { audit, auditRaw, type AuditAction } from '../audit.ts';
import { getProject } from '../projects.ts';
import { hashPassword, checkPassword, startSessionFor } from '../auth.ts';
import { checkEmail } from './shared.ts';
import { effectiveAccess, type ProjectAccess, type PortalRole } from './permissions.ts';

const INVITE_EXPIRY_HOURS = 7 * 24; // 7 days

function hashInviteToken(token: string): string {
  return sha256(token);
}

function generateInviteToken(): string {
  return `inv_${randomBytes(30).toString('base64url')}`;
}

export function registerInvitationRoutes(): void {
  // ── Invitations ───────────────────────────────────────────────────────────

  /**
   * POST /api/invitations — create an invite link.
   * Admins: any fields. Project owners: only project-scoped invites for that project.
   */
  post('/api/invitations', async (ctx) => {
    const body = await ctx.json();
    const u = ctx.user!;

    // Determine if this is an admin-level invite or a project-scoped invite
    const isAdmin = !!u.is_admin;

    // If project_id provided, check the requester is at least a project owner or admin
    let projectId: string | null = null;
    let projectAccess: ProjectAccess | null = null;
    if (body.project_id) {
      const project = getProject(body.project_id);
      const myAccess = effectiveAccess(u, project.id);
      if (!isAdmin && myAccess !== 'owner') {
        throw forbidden('Only project owners or admins can invite people to a project');
      }
      projectId = project.id;
      const a = body.project_access;
      if (!['viewer', 'editor', 'owner'].includes(a)) throw badRequest('project_access must be viewer, editor, or owner');
      projectAccess = a as ProjectAccess;
    }

    // Team id (optional)
    let teamId: string | null = null;
    if (body.team_id) {
      if (!isAdmin) {
        const tm = one<{ role: string }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', body.team_id, u.id);
        if (!tm || tm.role !== 'maintainer') throw forbidden('Only team maintainers or admins can invite to a team');
      }
      teamId = body.team_id;
    }

    // Portal role — only admin can set is_admin
    const portalRole: PortalRole = (isAdmin && body.portal_role === 'admin') ? 'admin' : 'member';

    const expiryHours = Math.min(7 * 24, Math.max(1, Number(body.expiry_hours || INVITE_EXPIRY_HOURS)));
    const expiresAt = new Date(Date.now() + expiryHours * 3_600_000).toISOString();
    const email = body.email ? checkEmail(body.email) : null;

    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);

    insert('invitations', {
      token_hash: tokenHash,
      email: email ?? null,
      is_admin: portalRole === 'admin' ? 1 : 0,
      portal_role: portalRole,
      project_id: projectId ?? null,
      project_access: projectAccess ?? null,
      team_id: teamId ?? null,
      expires_at: expiresAt,
      created_by: u.id,
      created_at: now(),
    });

    audit(ctx, 'invitation.create' as AuditAction, null, {
      email: email ?? null, portalRole, projectId, expiresAt,
    });

    return { token, expires_at: expiresAt };
  }, { auth: 'user' });

  /** GET /api/invitations — list pending (admin: all, project owner: their project's) */
  get('/api/invitations', (ctx) => {
    const u = ctx.user!;
    let rows: Row[];
    if (u.is_admin) {
      rows = all<Row>(
        `SELECT i.*, u.name AS creator_name FROM invitations i
           LEFT JOIN users u ON u.id = i.created_by
          ORDER BY i.created_at DESC LIMIT 200`,
      );
    } else {
      rows = all<Row>(
        `SELECT i.*, u.name AS creator_name FROM invitations i
           LEFT JOIN users u ON u.id = i.created_by
          WHERE i.created_by = ? OR (i.project_id IN (
            SELECT pm.project_id FROM project_members pm WHERE pm.user_id = ? AND pm.access = 'owner'
          ))
          ORDER BY i.created_at DESC LIMIT 200`,
        u.id, u.id,
      );
    }
    return {
      invitations: rows.map((r) => ({
        id: r.token_hash.slice(0, 12),  // non-reversible short ID for display
        email: r.email,
        portal_role: r.portal_role,
        project_id: r.project_id,
        project_access: r.project_access,
        team_id: r.team_id,
        expires_at: r.expires_at,
        created_by: r.created_by,
        creator_name: r.creator_name,
        created_at: r.created_at,
        used_at: r.used_at,
        used_by: r.used_by,
        active: !r.used_at && r.expires_at > now(),
      })),
    };
  }, { auth: 'user' });

  /** DELETE /api/invitations/:tokenHash — revoke (mark used_at) */
  del('/api/invitations/:tokenHash', (ctx) => {
    const u = ctx.user!;
    const row = one<{ created_by: string; used_at: string | null }>(
      'SELECT created_by, used_at FROM invitations WHERE token_hash = ?',
      ctx.params.tokenHash,
    );
    if (!row) throw notFound('Invitation not found');
    if (row.used_at) throw badRequest('Invitation has already been used');
    if (!u.is_admin && row.created_by !== u.id) throw forbidden('You cannot revoke this invitation');
    exec('UPDATE invitations SET used_at = ? WHERE token_hash = ?', now(), ctx.params.tokenHash);
    audit(ctx, 'invitation.revoke' as AuditAction, null, {});
    return { ok: true };
  }, { auth: 'user' });

  /** GET /api/invitations/accept/:token — preview an invite (public, shows what it will do). */
  get('/api/invitations/accept/:token', (ctx) => {
    const token = ctx.params.token;
    const tokenHash = hashInviteToken(token);
    const row = one<Row>('SELECT * FROM invitations WHERE token_hash = ?', tokenHash);
    if (!row) throw notFound('Invitation not found or has expired');
    if (row.used_at) throw new HttpError(410, 'This invitation has already been used');
    if (row.expires_at < now()) throw new HttpError(410, 'This invitation has expired');

    let projectName: string | null = null;
    if (row.project_id) {
      const p = one<{ name: string }>('SELECT name FROM projects WHERE id = ?', row.project_id);
      projectName = p?.name ?? null;
    }
    let teamName: string | null = null;
    if (row.team_id) {
      const t = one<{ name: string }>('SELECT name FROM teams WHERE id = ?', row.team_id);
      teamName = t?.name ?? null;
    }

    return {
      email: row.email,
      portal_role: row.portal_role,
      project_id: row.project_id,
      project_name: projectName,
      project_access: row.project_access,
      team_id: row.team_id,
      team_name: teamName,
      expires_at: row.expires_at,
      // Signed out: the accept form creates an account. Signed in: it links the invite to that account.
      newUser: !ctx.user,
      signedInEmail: ctx.user?.email ?? null,
    };
  }, { auth: 'public' });

  /**
   * POST /api/invitations/accept/:token — accept an invite.
   * If signed in: links the invite to the current user.
   * If not signed in: creates a new user (requires name + password, or google_token).
   */
  post('/api/invitations/accept/:token', async (ctx) => {
    const token = ctx.params.token;
    const tokenHash = hashInviteToken(token);
    const row = one<Row>('SELECT * FROM invitations WHERE token_hash = ?', tokenHash);
    if (!row) throw notFound('Invitation not found or has expired');
    if (row.used_at) throw new HttpError(410, 'This invitation has already been used');
    if (row.expires_at < now()) throw new HttpError(410, 'This invitation has expired');

    const body = await ctx.json();
    let userId: string;

    if (ctx.user) {
      // Signed in: apply invite to existing user
      userId = ctx.user.id;
    } else {
      // Not signed in: need to create account or sign in via Google
      if (!body.name || !body.password) throw badRequest('Provide a name and password to create your account');
      const email = row.email ? row.email : checkEmail(body.email);
      if (one('SELECT id FROM users WHERE email = ?', email)) {
        throw badRequest('An account with that email already exists. Sign in first, then accept the invite.');
      }
      const name = str(body.name, 'Name', { max: 120 }).trim();
      const passwordHash = hashPassword(checkPassword(body.password));
      const uid = newId('u_');
      const isAdmin = row.is_admin ? 1 : 0;
      exec(
        `INSERT INTO users (id, email, name, password_hash, is_admin, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
        uid, email, name, passwordHash, isAdmin, now(),
      );
      userId = uid;
      await startSessionFor(ctx, userId);
      auditRaw(userId, 'user.create', `user:${userId}`, { via: 'invitation', email });
    }

    // Apply project membership
    if (row.project_id && row.project_access) {
      const existing = one('SELECT access FROM project_members WHERE project_id = ? AND user_id = ?', row.project_id, userId);
      if (!existing) {
        exec(
          'INSERT INTO project_members (project_id, user_id, access) VALUES (?, ?, ?)',
          row.project_id, userId, row.project_access,
        );
      }
    }
    // Apply team membership
    if (row.team_id) {
      const existing = one('SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?', row.team_id, userId);
      if (!existing) {
        exec('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)', row.team_id, userId, 'member');
      }
    }
    // Apply admin role
    if (row.is_admin) {
      exec('UPDATE users SET is_admin = 1 WHERE id = ?', userId);
    }

    // Mark invite used
    exec('UPDATE invitations SET used_at = ?, used_by = ? WHERE token_hash = ?', now(), userId, tokenHash);
    auditRaw(userId, 'invitation.accept' as AuditAction, null, { project_id: row.project_id, team_id: row.team_id });

    const user = one<Row>('SELECT id, email, name, is_admin FROM users WHERE id = ?', userId);
    return { ok: true, user };
  }, { auth: 'public' });
}
