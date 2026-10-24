/** Per-user usage API by month with team grouping. */
import { all, one, type Row } from '../db.ts';
import { get } from '../http.ts';
import { forbidden, notFound, monthStart } from '../util.ts';

function buildUserUsage(userId: string) {
  const since = monthStart();
  const user = one<Row>('SELECT id, email, name, monthly_budget_usd FROM users WHERE id = ?', userId);
  if (!user) throw notFound('User not found');

  const byProject = all<Row>(
    `SELECT p.id, p.name, COALESCE(SUM(r.cost_usd), 0) AS usd, COUNT(r.id) AS runs
       FROM projects p
       LEFT JOIN agent_runs r ON r.project_id = p.id AND r.created_by = ? AND r.created_at >= ?
      WHERE r.id IS NOT NULL
      GROUP BY p.id ORDER BY usd DESC`,
    userId, since,
  );

  const byMonth = all<Row>(
    `SELECT strftime('%Y-%m', r.created_at) AS month,
            COALESCE(SUM(r.cost_usd), 0) AS usd,
            COUNT(r.id) AS runs
       FROM agent_runs r
      WHERE r.created_by = ? AND r.created_at >= date('now', '-12 months')
      GROUP BY month ORDER BY month DESC`,
    userId,
  );

  const teams = all<Row>(
    `SELECT t.id, t.name, t.monthly_budget_usd FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = ?`,
    userId,
  );

  return {
    user: { id: user.id, email: user.email, name: user.name, monthly_budget_usd: user.monthly_budget_usd },
    since,
    month_usd: byProject.reduce((s, p) => s + Number(p.usd), 0),
    by_project: byProject,
    by_month: byMonth,
    teams,
  };
}

export function registerUsageRoutes(): void {
  // ── Per-user usage API ────────────────────────────────────────────────────

  /**
   * GET /api/usage/me — current user's own usage by month.
   * GET /api/usage/users/:id — admin-only, or own id.
   * GET /api/usage/users — admin-only: all users with team grouping.
   */
  get('/api/usage/me', (ctx) => {
    return buildUserUsage(ctx.user!.id);
  });

  get('/api/usage/users', (ctx) => {
    if (!ctx.user!.is_admin) throw forbidden('Only admins can view all users\' usage');
    const since = monthStart();
    const users = all<Row>(
      `SELECT u.id, u.email, u.name,
              COALESCE(SUM(r.cost_usd), 0) AS month_usd,
              COUNT(r.id) AS month_runs,
              u.monthly_budget_usd
         FROM users u
         LEFT JOIN agent_runs r ON r.created_by = u.id AND r.created_at >= ?
        GROUP BY u.id ORDER BY month_usd DESC`,
      since,
    );
    // Attach team memberships for grouping
    const teams = all<Row>('SELECT tm.user_id, t.id AS team_id, t.name AS team_name FROM team_members tm JOIN teams t ON t.id = tm.team_id');
    const teamsByUser = new Map<string, Array<{ team_id: string; team_name: string }>>();
    for (const t of teams) {
      if (!teamsByUser.has(t.user_id)) teamsByUser.set(t.user_id, []);
      teamsByUser.get(t.user_id)!.push({ team_id: t.team_id, team_name: t.team_name });
    }
    return {
      since,
      users: users.map((u) => ({
        ...u,
        teams: teamsByUser.get(u.id) ?? [],
      })),
    };
  }, { auth: 'admin' });

  get('/api/usage/users/:id', (ctx) => {
    if (!ctx.user!.is_admin && ctx.user!.id !== ctx.params.id) {
      throw forbidden('You can only view your own usage');
    }
    return buildUserUsage(ctx.params.id);
  });
}
