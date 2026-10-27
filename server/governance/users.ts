/**
 * User management and invitation routes.
 *
 * Routes:
 *   GET  /api/governance/users          — list all users (admin only)
 *   PUT  /api/governance/users/:id      — update user disabled/is_admin (admin only)
 *   POST /api/governance/invitations    — create invitation (admin only)
 *   GET  /api/governance/invitations    — list pending invitations (admin only)
 *   POST /api/auth/accept-invite        — accept invitation (public)
 */

import { createHash, randomBytes } from 'node:crypto';
import { router, sendJson, requireAuth } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { one, all, run, insert, getDb } from '../db.ts';
import { generateId, now, str, badRequest, HttpError } from '../util.ts';
import { appendAudit } from '../audit.ts';
import { hashPassword } from '../auth.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function requireAdmin(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user?.is_admin) {
    sendJson(res, 403, { error: 'Admin access required' });
    return false;
  }
  return true;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerUserRoutes(): void {
  // GET /api/governance/users — list all users
  router.get('/api/governance/users', requireAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const users = all<{
      id: string;
      email: string;
      name: string;
      is_admin: number;
      disabled: number;
      created_at: string;
      last_active_at: string | null;
    }>(
      `SELECT u.id, u.email, u.name, u.is_admin, u.disabled, u.created_at,
              MAX(s.created_at) AS last_active_at
         FROM users u
         LEFT JOIN sessions s ON s.user_id = u.id
        GROUP BY u.id
        ORDER BY u.created_at`,
    );

    sendJson(res, 200, { users });
  }));

  // PUT /api/governance/users/:id — update user (admin only)
  router.put('/api/governance/users/:id', requireAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const userId = req.params.id;
    const body = req.body as Record<string, unknown>;

    const user = one<{ id: string; email: string; is_admin: number }>(
      'SELECT id, email, is_admin FROM users WHERE id = ?',
      userId,
    );
    if (!user) {
      sendJson(res, 404, { error: 'User not found' });
      return;
    }

    // Prevent admin from removing their own admin status
    if (req.user!.id === userId && body.is_admin === false) {
      sendJson(res, 400, { error: 'You cannot remove your own admin access' });
      return;
    }

    const patch: Record<string, unknown> = {};
    if (typeof body.disabled === 'boolean') patch.disabled = body.disabled ? 1 : 0;
    if (typeof body.is_admin === 'boolean') patch.is_admin = body.is_admin ? 1 : 0;

    if (Object.keys(patch).length > 0) {
      const setClauses = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      run(
        `UPDATE users SET ${setClauses} WHERE id = ?`,
        ...Object.values(patch),
        userId,
      );
    }

    appendAudit(
      getDb(),
      req.user!.id,
      'user.update',
      `user:${userId}`,
      { patch, targetEmail: user.email },
      req.ip,
    );

    const updated = one<{ id: string; email: string; name: string; is_admin: number; disabled: number }>(
      'SELECT id, email, name, is_admin, disabled FROM users WHERE id = ?',
      userId,
    )!;

    sendJson(res, 200, { user: updated });
  }));

  // POST /api/governance/invitations — create invitation
  router.post('/api/governance/invitations', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const body = req.body as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const role = typeof body.role === 'string' ? body.role : 'member';
    const projectId = typeof body.projectId === 'string' ? body.projectId : null;

    if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) {
      throw badRequest('Enter a valid email address');
    }
    if (!['member', 'admin'].includes(role)) {
      throw badRequest('Role must be "member" or "admin"');
    }

    // Check for existing user with this email
    if (email) {
      const existing = one('SELECT id FROM users WHERE email = ?', email);
      if (existing) throw badRequest('A user with this email already exists');
    }

    // Generate a secure random token
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);

    // Expiry: 7 days
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();

    insert('invitations', {
      token_hash: tokenHash,
      email: email || null,
      is_admin: role === 'admin' ? 1 : 0,
      portal_role: role,
      project_id: projectId,
      project_access: projectId ? 'member' : null,
      team_id: null,
      expires_at: expiresAt,
      created_by: req.user!.id,
      created_at: now(),
    });

    appendAudit(
      getDb(),
      req.user!.id,
      'invitation.create',
      email ? `email:${email}` : null,
      { email, role, projectId },
      req.ip,
    );

    // Build invite URL using the request's host
    const host = req.headers.host ?? 'localhost:8787';
    const protocol = req.secure ? 'https' : 'http';
    const inviteUrl = `${protocol}://${host}/#/accept-invite?token=${encodeURIComponent(token)}`;

    sendJson(res, 201, {
      invitation: {
        tokenHash,
        email,
        role,
        projectId,
        expiresAt,
        inviteUrl,
      },
    });
  }));

  // GET /api/governance/invitations — list pending invitations
  router.get('/api/governance/invitations', requireAuth((req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const invitations = all<{
      token_hash: string;
      email: string | null;
      is_admin: number;
      portal_role: string;
      project_id: string | null;
      expires_at: string;
      created_by: string;
      created_at: string;
      used_at: string | null;
    }>(
      `SELECT token_hash, email, is_admin, portal_role, project_id,
              expires_at, created_by, created_at, used_at
         FROM invitations
        WHERE used_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
      now(),
    );

    sendJson(res, 200, { invitations });
  }));

  // POST /api/auth/accept-invite — accept an invitation (public)
  router.post('/api/auth/accept-invite', async (req: PortalRequest, res: PortalResponse) => {
    const body = req.body as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const name = str(body.name, 'Name', { max: 120 });
    const password = typeof body.password === 'string' ? body.password : '';

    if (!token) throw badRequest('Invitation token is required');
    if (name.length < 1) throw badRequest('Name is required');
    if (password.length < 10) throw badRequest('Password must be at least 10 characters');

    const tokenHash = sha256(token);
    const inv = one<{
      token_hash: string;
      email: string | null;
      is_admin: number;
      portal_role: string;
      project_id: string | null;
      expires_at: string;
      used_at: string | null;
    }>(
      'SELECT token_hash, email, is_admin, portal_role, project_id, expires_at, used_at FROM invitations WHERE token_hash = ?',
      tokenHash,
    );

    if (!inv) {
      sendJson(res, 400, { error: 'Invitation not found or already used' });
      return;
    }
    if (inv.used_at) {
      sendJson(res, 400, { error: 'This invitation has already been used' });
      return;
    }
    if (inv.expires_at < now()) {
      sendJson(res, 400, { error: 'This invitation has expired' });
      return;
    }

    // Email from invitation or from body
    const email = inv.email || (typeof body.email === 'string' ? body.email.trim().toLowerCase() : '');
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
      throw badRequest('Enter a valid email address');
    }

    // Check for duplicate
    if (one('SELECT id FROM users WHERE email = ?', email)) {
      throw badRequest('A user with this email already exists');
    }

    // Create the user
    const userId = generateId();
    insert('users', {
      id: userId,
      email,
      name: name.trim(),
      password_hash: hashPassword(password),
      is_admin: inv.is_admin,
      disabled: 0,
      created_at: now(),
    });

    // If invitation had a project, add the user as a member
    if (inv.project_id) {
      const project = one('SELECT id FROM projects WHERE id = ?', inv.project_id);
      if (project) {
        try {
          insert('project_members', {
            project_id: inv.project_id,
            user_id: userId,
            access: 'member',
            role: '',
          });
        } catch {
          // ignore duplicate member insertion
        }
      }
    }

    // Mark invitation as used
    run(
      'UPDATE invitations SET used_at = ?, used_by = ? WHERE token_hash = ?',
      now(),
      userId,
      tokenHash,
    );

    appendAudit(
      getDb(),
      userId,
      'auth.accept_invite',
      `user:${userId}`,
      { email, projectId: inv.project_id },
      req.ip,
    );

    sendJson(res, 200, { ok: true, userId });
  });
}
