/**
 * Insights: cost, tokens, latency, failures and agent activity.
 *
 * GET /api/insights?projectId=&period=30d|7d|today
 * GET /api/projects/:id/insights?period=30d|7d|today
 *
 * All queries use budget_usage joined with agent_runs, p6_workflows, projects, users.
 * Non-admins only see cost-by-user for their own entries.
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all } from './db.ts';
import type { Row } from './db.ts';
import { badRequest, notFound } from './util.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function periodToSince(period: string): string {
  const now = new Date();
  if (period === 'today') {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
  if (period === '7d') {
    return new Date(now.getTime() - 7 * 86_400_000).toISOString();
  }
  // default: 30d
  return new Date(now.getTime() - 30 * 86_400_000).toISOString();
}

/** Last 30 daily buckets (ISO date strings, UTC). */
function last30Days(): string[] {
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function requireMember(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Row | null {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const project = one<Row>('SELECT * FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project;
  const member = one<Row>(
    'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) {
    sendJson(res, 403, { error: 'Access denied' });
    return null;
  }
  return project;
}

interface InsightsShape {
  totalCost: number;
  totalRuns: number;
  totalTokens: number;
  failureRate: number;
  avgRunDuration: number;
  dailyCosts: { date: string; cost: number }[];
  costByProject: { projectId: string; name: string; cost: number }[];
  costByUser: { userId: string; name: string; cost: number }[];
  runsByStatus: { status: string; count: number }[];
}

function computeInsights(
  projectId: string | null,
  since: string,
  isAdmin: boolean,
  userId: string,
): InsightsShape {
  const projectFilter = projectId ? 'AND bu.project_id = ?' : '';
  const baseArgs: (string | null)[] = projectId ? [since, projectId] : [since];

  // ── Totals from budget_usage ──
  const totals = one<{ cost: number; tokens: number }>(
    `SELECT
       COALESCE(SUM(bu.cost_usd), 0) AS cost,
       COALESCE(SUM(bu.input_tokens + bu.output_tokens), 0) AS tokens
     FROM budget_usage bu
     WHERE bu.created_at >= ? ${projectFilter}`,
    ...baseArgs,
  ) ?? { cost: 0, tokens: 0 };

  // ── Run stats from agent_runs ──
  const runArgs: (string | null)[] = projectId ? [since, projectId] : [since];
  const runFilter = projectId ? 'AND r.project_id = ?' : '';

  const runRows = all<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count
     FROM agent_runs r
     WHERE r.created_at >= ? ${runFilter}
     GROUP BY status`,
    ...runArgs,
  );

  const totalRuns = runRows.reduce((s, r) => s + Number(r.count), 0);
  const failedRuns = runRows.find((r) => r.status === 'failed')?.count ?? 0;
  const failureRate = totalRuns > 0 ? Number(failedRuns) / totalRuns : 0;

  // Average duration from runs that have both started_at and finished_at
  const durRow = one<{ avg_dur: number }>(
    `SELECT AVG(
       (julianday(r.finished_at) - julianday(r.started_at)) * 86400 * 1000
     ) AS avg_dur
     FROM agent_runs r
     WHERE r.created_at >= ? ${runFilter}
       AND r.started_at IS NOT NULL
       AND r.finished_at IS NOT NULL`,
    ...runArgs,
  );
  const avgRunDuration = Math.round(durRow?.avg_dur ?? 0);

  // ── Daily costs (last 30 days) ──
  const dailyRows = all<{ date: string; cost: number }>(
    `SELECT
       substr(bu.created_at, 1, 10) AS date,
       SUM(bu.cost_usd) AS cost
     FROM budget_usage bu
     WHERE bu.created_at >= ? ${projectFilter}
     GROUP BY substr(bu.created_at, 1, 10)
     ORDER BY date`,
    ...baseArgs,
  );
  const dailyMap = new Map(dailyRows.map((r) => [r.date, r.cost]));
  const dailyCosts = last30Days().map((date) => ({
    date,
    cost: Number(dailyMap.get(date) ?? 0),
  }));

  // ── Cost by project ──
  const projectArgs: (string | null)[] = projectId ? [since, projectId] : [since];
  const byProject = all<{ projectId: string; name: string; cost: number }>(
    `SELECT bu.project_id AS projectId, p.name, SUM(bu.cost_usd) AS cost
     FROM budget_usage bu
     JOIN projects p ON p.id = bu.project_id
     WHERE bu.created_at >= ? ${projectFilter}
     GROUP BY bu.project_id
     ORDER BY cost DESC
     LIMIT 20`,
    ...projectArgs,
  );
  const costByProject = byProject.map((r) => ({
    projectId: String(r.projectId),
    name: String(r.name),
    cost: Number(r.cost),
  }));

  // ── Cost by user (admin only, or own entry) ──
  let costByUser: { userId: string; name: string; cost: number }[] = [];
  if (isAdmin) {
    const userRows = all<{ userId: string; name: string; cost: number }>(
      `SELECT bu.user_id AS userId, u.name, SUM(bu.cost_usd) AS cost
       FROM budget_usage bu
       JOIN users u ON u.id = bu.user_id
       WHERE bu.created_at >= ? ${projectFilter}
       GROUP BY bu.user_id
       ORDER BY cost DESC
       LIMIT 50`,
      ...baseArgs,
    );
    costByUser = userRows.map((r) => ({
      userId: String(r.userId),
      name: String(r.name),
      cost: Number(r.cost),
    }));
  }

  return {
    totalCost: Number(totals.cost),
    totalRuns,
    totalTokens: Number(totals.tokens),
    failureRate,
    avgRunDuration,
    dailyCosts,
    costByProject,
    costByUser,
    runsByStatus: runRows.map((r) => ({ status: String(r.status), count: Number(r.count) })),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerInsightsRoutes(): void {
  /** GET /api/insights?projectId=&period=30d|7d|today */
  router.get(
    '/api/insights',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const period = req.query.get('period') || '30d';
      if (!['30d', '7d', 'today'].includes(period)) {
        sendJson(res, 400, { error: 'period must be 30d, 7d or today' });
        return;
      }
      const since = periodToSince(period);
      const projectId = req.query.get('projectId') || null;

      // If projectId specified, ensure user has access
      if (projectId) {
        const ok = requireMember(req, res, projectId);
        if (!ok) return;
      }

      const data = computeInsights(
        projectId,
        since,
        Boolean(req.user?.is_admin),
        req.user!.id,
      );
      sendJson(res, 200, data);
    }),
  );

  /** GET /api/projects/:id/insights?period=30d|7d|today */
  router.get(
    '/api/projects/:id/insights',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const project = requireMember(req, res, req.params.id);
      if (!project) return;

      const period = req.query.get('period') || '30d';
      if (!['30d', '7d', 'today'].includes(period)) {
        sendJson(res, 400, { error: 'period must be 30d, 7d or today' });
        return;
      }
      const since = periodToSince(period);

      const data = computeInsights(
        String(project.id),
        since,
        Boolean(req.user?.is_admin),
        req.user!.id,
      );
      sendJson(res, 200, data);
    }),
  );
}

export { computeInsights };

