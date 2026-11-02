/**
 * Insights: cost, tokens, latency, failures and agent activity.
 *
 * GET /api/insights?projectId=&period=30d|7d|today
 * GET /api/projects/:id/insights?period=30d|7d|today
 *
 * SQL-free: all queries go through the stats repository.
 * H2/H3 note: SQLite mode reads from agent_runs (legacy); DynamoDB mode reads
 * from p6_runs RUNSTATS rollups.  See stats.ts header for the full explanation.
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getStatsRepository } from './repositories/stats.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function periodToSince(period: string): string {
  const now = new Date();
  if (period === 'today') {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  }
  if (period === '7d') return new Date(now.getTime() - 7 * 86_400_000).toISOString();
  return new Date(now.getTime() - 30 * 86_400_000).toISOString();
}

function last30Days(): string[] {
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

async function requireMember(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Promise<boolean> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  const projectRepo = getProjectRepository();
  const project = await projectRepo.getProjectById(projectId);
  if (!project || project.archived) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = await projectRepo.isMember(projectId, req.user.id);
  if (!member) {
    sendJson(res, 403, { error: 'Access denied' });
    return false;
  }
  return true;
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

async function computeInsights(
  projectId: string | null,
  since: string,
  isAdmin: boolean,
  userId: string,
): Promise<InsightsShape> {
  const stats = getStatsRepository();
  const days = last30Days();

  const [
    totals,
    runStatusCounts,
    avgRunDuration,
    dailyBudget,
    costByProject,
    costByUser,
  ] = await Promise.all([
    stats.getInsightTotals(since, projectId, userId, isAdmin),
    stats.getRunStatusCounts(since, projectId, userId, isAdmin),
    stats.getAvgRunDuration(since, projectId, userId, isAdmin),
    stats.getDailyBudget(days, projectId, userId, isAdmin),
    stats.getCostByProject(since, projectId, userId, isAdmin),
    stats.getCostByUser(since, projectId, userId, isAdmin),
  ]);

  const totalRuns = runStatusCounts.reduce((s, r) => s + r.count, 0);
  const failedRuns = runStatusCounts.find((r) => r.status === 'failed')?.count ?? 0;
  const failureRate = totalRuns > 0 ? failedRuns / totalRuns : 0;

  return {
    totalCost: totals.totalCost,
    totalRuns,
    totalTokens: totals.totalTokens,
    failureRate,
    avgRunDuration,
    dailyCosts: dailyBudget.map((d) => ({ date: d.date, cost: d.cost })),
    costByProject,
    costByUser,
    runsByStatus: runStatusCounts,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerInsightsRoutes(): void {
  router.get(
    '/api/insights',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const period = req.query.get('period') || '30d';
      if (!['30d', '7d', 'today'].includes(period)) {
        sendJson(res, 400, { error: 'period must be 30d, 7d or today' });
        return;
      }
      const since = periodToSince(period);
      const projectId = req.query.get('projectId') || null;

      if (projectId) {
        const ok = await requireMember(req, res, projectId);
        if (!ok) return;
      }

      const data = await computeInsights(
        projectId,
        since,
        Boolean(req.user?.is_admin),
        req.user!.id,
      );
      sendJson(res, 200, data);
    }),
  );

  router.get(
    '/api/projects/:id/insights',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const ok = await requireMember(req, res, req.params.id);
      if (!ok) return;

      const period = req.query.get('period') || '30d';
      if (!['30d', '7d', 'today'].includes(period)) {
        sendJson(res, 400, { error: 'period must be 30d, 7d or today' });
        return;
      }
      const since = periodToSince(period);

      const data = await computeInsights(
        req.params.id,
        since,
        Boolean(req.user?.is_admin),
        req.user!.id,
      );
      sendJson(res, 200, data);
    }),
  );
}

export { computeInsights };
