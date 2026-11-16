/**
 * Agent Performance Dashboard API.
 *
 * GET /api/dashboard?period=today|7d|30d&projectId=<optional>
 * GET /api/dashboard/agents/:agent/runs?period=today|7d|30d&projectId=<optional>
 *
 * Access: signed in; admins see all projects; non-admins see only their
 * member projects.  If projectId is supplied, membership is enforced (404/403).
 * Invalid period → 400.  Default period: 7d.
 *
 * All data comes from p6_workflows + p6_runs (the active runner tables, M6).
 * The legacy M3 agent_runs / workflows tables are not touched here.
 * SQL-free: all queries go through the stats repository.
 *
 * Run statuses (p6_runs): pending | running | done | failed | cancelled
 * Workflow statuses (p6_workflows): pending | running | done | blocked | failed | paused
 * Terminal run statuses: done | failed | cancelled
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getStatsRepository } from './repositories/stats.ts';
import { listIdleClosingSoon } from './session-lifecycle.ts';

/** A session is listed as "closing soon" when the idle check will stop it within this many minutes. */
const IDLE_CLOSING_WINDOW_MIN = 15;

// ── Period helpers ─────────────────────────────────────────────────────────────

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

function prevPeriodRange(period: string): { prevSince: string; prevUntil: string } {
  const now = new Date();
  if (period === 'today') {
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
    return { prevSince: yesterdayStart.toISOString(), prevUntil: todayStart.toISOString() };
  }
  if (period === '7d') {
    const since = new Date(now.getTime() - 7 * 86_400_000);
    return {
      prevSince: new Date(now.getTime() - 14 * 86_400_000).toISOString(),
      prevUntil: since.toISOString(),
    };
  }
  const since = new Date(now.getTime() - 30 * 86_400_000);
  return {
    prevSince: new Date(now.getTime() - 60 * 86_400_000).toISOString(),
    prevUntil: since.toISOString(),
  };
}

function todayStart(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function yesterdayStart(): string {
  return new Date(new Date(todayStart()).getTime() - 86_400_000).toISOString();
}

// ── Access control helper ──────────────────────────────────────────────────────

export async function requireMember(
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

// ── DashboardShape ─────────────────────────────────────────────────────────────

interface AgentStats {
  agent: string;
  runs: number;
  completed: number;
  failed: number;
  successRate: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  avgDurationMs: number;
  costUsd: number;
  /** Kiro credits (Kiro bills in credits, not dollars). */
  credits: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolErrors: number;
  lastRunAt: string | null;
}

interface DashboardShape {
  period: string;
  generatedAt: string;
  summary: {
    totalAgents: number;
    activeAgents: number;
    runningSessions: number;
    queuedSessions: number;
    completedToday: number;
    completedYesterday: number;
    /** Done / (done + failed). A run the person stopped is not a failure, so it is not in this rate. */
    successRate: number;
    successRatePrev: number | null;
    /** Runs that ended in the period: done, failed, and stopped by the person (cancelled). 0 finished = no rate to show. */
    finishedRuns: number;
    failedRuns: number;
    stoppedRuns: number;
    /** Start of "today" (UTC midnight: the rollups are kept per UTC day), so the page can say what "today" means for the viewer. */
    dayStartUtc: string;
  };
  /** Runs per UTC day for the chart (30 days for the 30d period, otherwise 7), every day present, oldest first. */
  daily: Array<{ date: string; done: number; failed: number; cancelled: number; avgDurationMs: number }>;
  /** Idle sessions the idle check will close within IDLE_CLOSING_WINDOW_MIN minutes. */
  idleClosing: Array<{ id: string; projectId: string; projectName: string; title: string; stopAt: string }>;
  network: {
    nodes: Array<{
      id: string;
      label: string;
      runs: number;
      successRate: number;
      running: boolean;
      avgDurationMs: number;
    }>;
    edges: Array<{ source: string; target: string; count: number }>;
  };
  agents: AgentStats[];
  recentSessions: Array<{
    id: string;
    projectId: string;
    projectName: string;
    title: string;
    agent: string;
    status: string;
    childAgents: string[];
    updatedAt: string;
  }>;
  activeSession: null | {
    id: string;
    projectId: string;
    title: string;
    agent: string;
    status: string;
    steps: Array<{
      id: string;
      label: string;
      agent: string;
      kind: 'run' | 'child';
      status: string;
      startedAt: string | null;
      finishedAt: string | null;
    }>;
  };
}

// ── Chart and warning helpers ─────────────────────────────────────────────────

/** One row for every UTC day from `since`, so a day with no runs is a zero on the chart rather than a gap. */
export function fillDays(
  since: string,
  days: number,
  rows: Array<{ date: string; done: number; failed: number; cancelled: number; avgDurationMs: number }>,
): DashboardShape['daily'] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: DashboardShape['daily'] = [];
  const start = Date.parse(since);
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const r = byDate.get(date);
    out.push({ date, done: r?.done ?? 0, failed: r?.failed ?? 0, cancelled: r?.cancelled ?? 0, avgDurationMs: r?.avgDurationMs ?? 0 });
  }
  return out;
}

async function idleClosingSessions(projectId: string | null, userId: string, isAdmin: boolean): Promise<DashboardShape['idleClosing']> {
  try {
    let rows = await listIdleClosingSoon(IDLE_CLOSING_WINDOW_MIN);
    if (projectId) rows = rows.filter((r) => r.workflow.project_id === projectId);
    else if (!isAdmin) {
      const mine = new Set((await getProjectRepository().listMyProjects(userId)).map((p) => p.id));
      rows = rows.filter((r) => r.workflow.project_id && mine.has(r.workflow.project_id));
    }
    rows = rows.slice(0, 10);
    const names = new Map<string, string>();
    for (const pid of new Set(rows.map((r) => r.workflow.project_id).filter(Boolean) as string[])) {
      const p = await getProjectRepository().getProjectById(pid);
      if (p) names.set(pid, p.name);
    }
    return rows.map(({ workflow: w, stopAt }) => ({
      id: String(w.id),
      projectId: w.project_id ?? '',
      projectName: w.project_id ? (names.get(w.project_id) ?? '') : '',
      title: w.title || String(w.goal ?? '').slice(0, 100),
      stopAt,
    }));
  } catch (e) {
    // A warning strip must never take the dashboard down.
    console.error('[dashboard] could not list idle sessions:', e);
    return [];
  }
}

// ── Dashboard computation ─────────────────────────────────────────────────────

async function computeDashboard(
  period: string,
  projectId: string | null,
  isAdmin: boolean,
  userId: string,
): Promise<DashboardShape> {
  const since = periodToSince(period);
  const { prevSince, prevUntil } = prevPeriodRange(period);
  const today = todayStart();
  const yesterday = yesterdayStart();
  // The "until" for the current period is now (open-ended), with a second of margin: the range is exclusive at the
  // end, so a run stamped in the same millisecond as this request would otherwise be left out.
  const until = new Date(Date.now() + 1000).toISOString();
  // The chart shows a week at least (a single day is not a trend) and a month for the 30d period.
  const chartDays = period === '30d' ? 30 : 7;
  const chartSince = new Date(Date.now() - (chartDays - 1) * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z';

  const stats = getStatsRepository();

  const [
    totalAgents,
    activeAgents,
    runningSessions,
    queuedSessions,
    completedCounts,
    srCurrent,
    srPrev,
    agentRollups,
    edges,
    recentSessions,
    activeSession,
    runningAgentNames,
    dailyRows,
    idleClosingRows,
  ] = await Promise.all([
    stats.countDistinctAgents(since, projectId, userId, isAdmin),
    stats.countActiveAgents(projectId, userId, isAdmin),
    stats.countWorkflowsByStatus('running', projectId, userId, isAdmin),
    stats.countWorkflowsByStatus('pending', projectId, userId, isAdmin),
    stats.getCompletedCounts(today, yesterday, projectId, userId, isAdmin),
    stats.getSuccessRateCounts(since, until, projectId, userId, isAdmin),
    stats.getSuccessRateCounts(prevSince, prevUntil, projectId, userId, isAdmin),
    stats.getAgentRollups(since, until, projectId, userId, isAdmin),
    stats.getAgentEdges(since, projectId, userId, isAdmin),
    stats.getRecentSessions(10, projectId, userId, isAdmin),
    stats.getActiveSession(projectId, userId, isAdmin),
    stats.listRunningAgentNames(projectId, userId, isAdmin),
    stats.getDailyRunStats(chartSince, until, projectId, userId, isAdmin),
    idleClosingSessions(projectId, userId, isAdmin),
  ]);

  // Stopped by the person is not a failure: the rate is done out of the runs that ended on their own.
  const successRate = srCurrent.done + srCurrent.failed > 0 ? srCurrent.done / (srCurrent.done + srCurrent.failed) : 0;
  const successRatePrev = srPrev.done + srPrev.failed > 0 ? srPrev.done / (srPrev.done + srPrev.failed) : null;

  // Build network nodes from agent rollups with running state from live run data.
  const activeAgentSet = runningAgentNames;
  const networkNodes = agentRollups.map((r) => {
    const ended = r.doneCount + r.failedCount;
    return {
      id: r.agent,
      label: r.agent,
      runs: r.runs,
      successRate: ended > 0 ? r.doneCount / ended : 0,
      running: activeAgentSet.has(r.agent),
      avgDurationMs: r.durationCount > 0 ? Math.round(r.totalDurationMs / r.durationCount) : 0,
    };
  });

  const networkEdges = edges;

  const agents: AgentStats[] = agentRollups.map((r) => ({
    agent: r.agent,
    runs: r.runs,
    completed: r.doneCount,
    failed: r.failedCount,
    successRate: r.doneCount + r.failedCount > 0 ? r.doneCount / (r.doneCount + r.failedCount) : 0,
    p50DurationMs: r.p50DurationMs,
    p95DurationMs: r.p95DurationMs,
    avgDurationMs: r.durationCount > 0 ? Math.round(r.totalDurationMs / r.durationCount) : 0,
    costUsd: r.costUsd,
    credits: r.credits,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    toolCalls: r.toolCalls,
    toolErrors: r.toolErrors,
    lastRunAt: r.lastRunAt,
  }));

  return {
    period,
    generatedAt: new Date().toISOString(),
    summary: {
      totalAgents,
      activeAgents,
      runningSessions,
      queuedSessions,
      completedToday: completedCounts.today,
      completedYesterday: completedCounts.yesterday,
      successRate,
      successRatePrev,
      finishedRuns: srCurrent.finished,
      failedRuns: srCurrent.failed,
      stoppedRuns: srCurrent.cancelled,
      dayStartUtc: today,
    },
    daily: fillDays(chartSince, chartDays, dailyRows),
    idleClosing: idleClosingRows,
    network: { nodes: networkNodes, edges: networkEdges },
    agents,
    recentSessions,
    activeSession,
  };
}

// ── Agent run drill-down ───────────────────────────────────────────────────────

async function computeAgentRuns(
  agentParam: string,
  period: string,
  projectId: string | null,
  isAdmin: boolean,
  userId: string,
): Promise<object[]> {
  const since = periodToSince(period);
  const stats = getStatsRepository();
  const runs = await stats.getAgentRunList(agentParam, since, projectId, userId, isAdmin);
  // Reshape to match the expected API contract (tokens nested object)
  return runs.map((r) => ({
    id: r.id,
    workflowId: r.workflowId,
    projectId: r.projectId,
    title: r.title,
    status: r.status,
    model: r.model,
    provider: r.provider,
    durationMs: r.durationMs,
    costUsd: r.costUsd,
    credits: r.credits,
    tokens: { input: r.inputTokens, output: r.outputTokens },
    toolCalls: r.toolCalls,
    error: r.error,
    createdAt: r.createdAt,
  }));
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerDashboardRoutes(): void {
  router.get(
    '/api/dashboard',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const period = req.query.get('period') || '7d';
      if (!['today', '7d', '30d'].includes(period)) {
        sendJson(res, 400, { error: 'period must be today, 7d or 30d' });
        return;
      }

      const projectId = req.query.get('projectId') || null;
      if (projectId) {
        const ok = await requireMember(req, res, projectId);
        if (!ok) return;
      }

      const data = await computeDashboard(
        period,
        projectId,
        Boolean(req.user?.is_admin),
        req.user!.id,
      );
      sendJson(res, 200, data);
    }),
  );

  router.get(
    '/api/dashboard/agents/:agent/runs',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      const period = req.query.get('period') || '7d';
      if (!['today', '7d', '30d'].includes(period)) {
        sendJson(res, 400, { error: 'period must be today, 7d or 30d' });
        return;
      }

      const projectId = req.query.get('projectId') || null;
      if (projectId) {
        const ok = await requireMember(req, res, projectId);
        if (!ok) return;
      }

      const agentParam = req.params.agent;
      if (!agentParam) {
        sendJson(res, 400, { error: 'agent name required' });
        return;
      }

      const runs = await computeAgentRuns(
        agentParam,
        period,
        projectId,
        Boolean(req.user?.is_admin),
        req.user!.id,
      );
      sendJson(res, 200, { runs });
    }),
  );
}
