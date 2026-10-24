/** Teams: CRUD, member roles, project grants and monthly budgets. */
import { all, insert, one, run as exec, update, type Row } from '../db.ts';
import { get, post, del, put, type Ctx } from '../http.ts';
import { badRequest, forbidden, newId, notFound, now, str } from '../util.ts';
import { audit, type AuditAction } from '../audit.ts';
import { getProject } from '../projects.ts';
import { checkEmail } from './shared.ts';
import { type ProjectAccess, type TeamRole } from './permissions.ts';

function getTeam(id: string): Row {
  const t = one('SELECT * FROM teams WHERE id = ?', id);
  if (!t) throw notFound('Team not found');
  return t;
}

function requireTeamMaintainer(ctx: Ctx, teamId: string): void {
  if (ctx.user!.is_admin) return;
  const m = one<{ role: string }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, ctx.user!.id);
  if (!m || m.role !== 'maintainer') throw forbidden('Only team maintainers or admins can do this');
}

export function registerTeamRoutes(): void {
  // ── Teams ─────────────────────────────────────────────────────────────────

  /** GET /api/teams */
  get('/api/teams', (ctx) => {
    const u = ctx.user!;
    let teams: Row[];
    if (u.is_admin) {
      teams = all<Row>(
        `SELECT t.*, COUNT(tm.user_id) AS member_count
           FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
          GROUP BY t.id ORDER BY t.name`,
      );
    } else {
      teams = all<Row>(
        `SELECT t.*, COUNT(tm2.user_id) AS member_count
           FROM teams t
           JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
           LEFT JOIN team_members tm2 ON tm2.team_id = t.id
          GROUP BY t.id ORDER BY t.name`,
        u.id,
      );
    }
    return { teams };
  });

  /** POST /api/teams */
  post('/api/teams', async (ctx) => {
    const body = await ctx.json();
    const name = str(body.name, 'Team name', { max: 80 }).trim();
    if (!name) throw badRequest('Team name is required');
    const id = newId('tm_');
    insert('teams', {
      id,
      name,
      description: str(body.description || '', 'Description', { max: 1000, optional: true }),
      monthly_budget_usd: body.monthly_budget_usd != null ? Number(body.monthly_budget_usd) : null,
      created_by: ctx.user!.id,
      created_at: now(),
      updated_at: now(),
    });
    // Auto-add creator as maintainer
    insert('team_members', { team_id: id, user_id: ctx.user!.id, role: 'maintainer' });
    audit(ctx, 'team.create' as AuditAction, `team:${id}`, { name });
    return { team: one('SELECT * FROM teams WHERE id = ?', id) };
  }, { auth: 'admin' });

  /** GET /api/teams/:id */
  get('/api/teams/:id', (ctx) => {
    const t = getTeam(ctx.params.id);
    const members = all<Row>(
      `SELECT tm.user_id, tm.role, u.email, u.name, u.disabled
         FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ? ORDER BY u.name`,
      t.id,
    );
    const projects = all<Row>(
      `SELECT tp.project_id, tp.access, p.name, p.slug
         FROM team_projects tp JOIN projects p ON p.id = tp.project_id
        WHERE tp.team_id = ? ORDER BY p.name`,
      t.id,
    );
    return { team: t, members, projects };
  }, { auth: 'user' });

  /** PUT /api/teams/:id */
  put('/api/teams/:id', async (ctx) => {
    const body = await ctx.json();
    const t = getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, t.id as string);
    const p: Record<string, string | number | null> = { updated_at: now() };
    if (body.name !== undefined) p.name = str(body.name, 'Name', { max: 80 }).trim();
    if (body.description !== undefined) p.description = str(body.description, 'Description', { max: 1000, optional: true });
    if (body.monthly_budget_usd !== undefined) {
      const v = body.monthly_budget_usd;
      if (v !== null && (typeof v !== 'number' || v < 0)) throw badRequest('Budget must be a positive number or null');
      p.monthly_budget_usd = v ?? null;
    }
    update('teams', t.id as string, p);
    audit(ctx, 'team.update' as AuditAction, `team:${t.id}`, { name: p.name });
    return { team: one('SELECT * FROM teams WHERE id = ?', t.id) };
  }, { auth: 'user' });

  /** DELETE /api/teams/:id */
  del('/api/teams/:id', (ctx) => {
    const t = getTeam(ctx.params.id);
    if (!ctx.user!.is_admin) throw forbidden('Only admins can delete teams');
    exec('DELETE FROM teams WHERE id = ?', t.id);
    audit(ctx, 'team.delete' as AuditAction, `team:${t.id}`, { name: t.name });
    return { ok: true };
  }, { auth: 'admin' });

  /** POST /api/teams/:id/members — add a member */
  post('/api/teams/:id/members', async (ctx) => {
    const body = await ctx.json();
    getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, ctx.params.id);
    const email = checkEmail(body.email);
    const user = one<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
    if (!user) throw notFound('User not found');
    const role: TeamRole = body.role === 'maintainer' ? 'maintainer' : 'member';
    const existing = one('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', ctx.params.id, user.id);
    if (existing) {
      exec('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', role, ctx.params.id, user.id);
    } else {
      insert('team_members', { team_id: ctx.params.id, user_id: user.id, role });
    }
    audit(ctx, 'team.member_add' as AuditAction, `team:${ctx.params.id}`, { user_id: user.id, role });
    return { ok: true };
  }, { auth: 'user' });

  /** DELETE /api/teams/:id/members/:userId — remove a member */
  del('/api/teams/:id/members/:userId', (ctx) => {
    getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, ctx.params.id);
    exec('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', ctx.params.id, ctx.params.userId);
    audit(ctx, 'team.member_remove' as AuditAction, `team:${ctx.params.id}`, { user_id: ctx.params.userId });
    return { ok: true };
  }, { auth: 'user' });

  /** POST /api/teams/:id/projects — grant team access to a project */
  post('/api/teams/:id/projects', async (ctx) => {
    const body = await ctx.json();
    getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, ctx.params.id);
    const projectId = str(body.project_id, 'project_id');
    const project = getProject(projectId);
    const access: ProjectAccess = ['viewer', 'editor', 'owner'].includes(body.access) ? body.access : 'viewer';
    const existing = one('SELECT access FROM team_projects WHERE team_id = ? AND project_id = ?', ctx.params.id, project.id);
    if (existing) {
      exec('UPDATE team_projects SET access = ? WHERE team_id = ? AND project_id = ?', access, ctx.params.id, project.id);
    } else {
      insert('team_projects', { team_id: ctx.params.id, project_id: project.id, access });
    }
    audit(ctx, 'team.project_add' as AuditAction, `team:${ctx.params.id}`, { project_id: project.id, access });
    return { ok: true };
  }, { auth: 'user' });

  /** DELETE /api/teams/:id/projects/:projectId */
  del('/api/teams/:id/projects/:projectId', (ctx) => {
    getTeam(ctx.params.id);
    requireTeamMaintainer(ctx, ctx.params.id);
    exec('DELETE FROM team_projects WHERE team_id = ? AND project_id = ?', ctx.params.id, ctx.params.projectId);
    audit(ctx, 'team.project_remove' as AuditAction, `team:${ctx.params.id}`, { project_id: ctx.params.projectId });
    return { ok: true };
  }, { auth: 'user' });
}
