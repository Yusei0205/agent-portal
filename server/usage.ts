/**
 * Usage: what the agents used, by project, by person and by day.
 *
 * GET /api/usage?period=7d|30d|90d&projectId=<optional>
 *
 * Claude is priced in dollars, Kiro in credits, and Codex reports tokens only, so each engine is reported on its own (every row has
 * `engines.claude|kiro|codex|other`) and the units are never added together. Runs are the runs that reported usage (a run that
 * reported none is not in these rows).
 *
 * Who sees what: an admin sees every project and the per-person table; anyone else sees the projects they belong to, and no
 * per-person table (that would show what their colleagues used). With a projectId the caller must be a member (or an admin).
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getStatsRepository } from './repositories/stats.ts';
import { USAGE_ENGINES, addUsage, newUsageRow } from './repositories/stats.ts';
import type { UsageRow } from './repositories/stats.ts';
import { requireMember } from './dashboard.ts';

const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** The rows added up, engine by engine. */
const sum = (rows: UsageRow[]): UsageRow => {
  const total = newUsageRow('total', 'Total');
  for (const r of rows) for (const e of USAGE_ENGINES) addUsage(total, e, r.engines[e]);
  return total;
};

/** One row for every UTC day of the window, so a day with no usage is a zero line rather than a missing one. */
export function fillUsageDays(sinceDay: string, days: number, rows: UsageRow[]): UsageRow[] {
  const byDay = new Map(rows.map((r) => [r.id, r]));
  const out: UsageRow[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00.000Z`);
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(date) ?? newUsageRow(date, date));
  }
  return out;
}

export function registerUsageRoutes(): void {
  router.get(
    '/api/usage',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const period = req.query.get('period') || '30d';
      const days = PERIOD_DAYS[period];
      if (!days) {
        sendJson(res, 400, { error: 'period must be 7d, 30d or 90d' });
        return;
      }
      const projectId = req.query.get('projectId') || null;
      if (projectId && !(await requireMember(req, res, projectId))) return;

      const isAdmin = Boolean(req.user?.is_admin);
      const userId = req.user!.id;
      let projectIds: string[] | null;
      if (projectId) projectIds = [projectId];
      else if (isAdmin) projectIds = null;
      else projectIds = (await getProjectRepository().listMyProjects(userId)).map((p) => p.id);

      const sinceDay = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const since = `${sinceDay}T00:00:00.000Z`;
      const until = new Date(Date.now() + 1000).toISOString();
      const stats = getStatsRepository();
      const [usage, runs] = await Promise.all([
        stats.getUsageBreakdown(since, until, projectIds, isAdmin),
        stats.getSuccessRateCounts(since, until, projectId, userId, isAdmin),
      ]);

      const totals = sum(usage.byProject);
      sendJson(res, 200, {
        period,
        since,
        generatedAt: new Date().toISOString(),
        totals,
        // Runs that ended in the period, whether or not they reported usage: "runs happened but none reported" is not "nothing happened".
        finishedRuns: runs.finished,
        byProject: usage.byProject,
        // Only for admins.
        byUser: isAdmin ? usage.byUser : null,
        byDay: fillUsageDays(sinceDay, days, usage.byDay),
      });
    }),
  );
}
