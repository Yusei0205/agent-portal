/**
 * SQLite implementation of StatsRepository.
 *
 * All SQL for dashboard (G1–G11) and insights (H1–H6) lives here.
 * The queries are extracted verbatim from the original dashboard.ts and
 * insights.ts to preserve existing behaviour.
 *
 * H2/H3: reads from agent_runs (legacy M3 table), matching original insights.ts.
 */

import { one, all } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  StatsRepository,
  InsightTotals,
  RunStatusCount,
  DailyCost,
  ProjectCost,
  UserCost,
  AgentRollup,
  AgentEdge,
  RecentSession,
  ActiveSessionData,
  ActiveSessionStep,
  AgentRunItem,
} from './stats.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = "'done','failed','cancelled'";

// ── Scope helper ──────────────────────────────────────────────────────────────

function buildScope(
  alias: string,
  projectId: string | null,
  isAdmin: boolean,
  userId: string,
): { filter: string; args: (string | null)[] } {
  if (projectId) return { filter: `AND ${alias}.project_id = ?`, args: [projectId] };
  if (isAdmin) return { filter: '', args: [] };
  return {
    filter: `AND ${alias}.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)`,
    args: [userId],
  };
}

// ── Helper ────────────────────────────────────────────────────────────────────

function agentName(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return s || 'default';
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sortedAsc[lo]);
  return Math.round(sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo));
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class SqliteStatsRepository implements StatsRepository {

  // ── H1: total cost + tokens ─────────────────────────────────────────────────

  async getInsightTotals(
    since: string,
    projectId: string | null,
    _userId: string,
    _isAdmin: boolean,
  ): Promise<InsightTotals> {
    const projectFilter = projectId ? 'AND bu.project_id = ?' : '';
    const args: (string | null)[] = projectId ? [since, projectId] : [since];
    const row = one<{ cost: number; credits: number; tokens: number }>(
      `SELECT
         COALESCE(SUM(bu.cost_usd), 0) AS cost,
         COALESCE(SUM(bu.credits), 0) AS credits,
         COALESCE(SUM(bu.input_tokens + bu.output_tokens), 0) AS tokens
       FROM budget_usage bu
       WHERE bu.created_at >= ? ${projectFilter}`,
      ...args,
    );
    return { totalCredits: Number(row?.credits ?? 0), totalCost: Number(row?.cost ?? 0), totalTokens: Number(row?.tokens ?? 0) };
  }

  // ── H2: run counts by status ────────────────────────────────────────────────

  async getRunStatusCounts(
    since: string,
    projectId: string | null,
    _userId: string,
    _isAdmin: boolean,
  ): Promise<RunStatusCount[]> {
    const runFilter = projectId ? 'AND r.project_id = ?' : '';
    const args: (string | null)[] = projectId ? [since, projectId] : [since];
    // Reads from agent_runs (legacy M3 table) to match original insights.ts behaviour.
    const rows = all<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count
       FROM agent_runs r
       WHERE r.created_at >= ? ${runFilter}
       GROUP BY status`,
      ...args,
    );
    return rows.map((r) => ({ status: String(r.status), count: Number(r.count) }));
  }

  // ── H3: average run duration ────────────────────────────────────────────────

  async getAvgRunDuration(
    since: string,
    projectId: string | null,
    _userId: string,
    _isAdmin: boolean,
  ): Promise<number> {
    const runFilter = projectId ? 'AND r.project_id = ?' : '';
    const args: (string | null)[] = projectId ? [since, projectId] : [since];
    // Reads from agent_runs (legacy M3 table) to match original insights.ts behaviour.
    const row = one<{ avg_dur: number }>(
      `SELECT AVG(
         (julianday(r.finished_at) - julianday(r.started_at)) * 86400 * 1000
       ) AS avg_dur
       FROM agent_runs r
       WHERE r.created_at >= ? ${runFilter}
         AND r.started_at IS NOT NULL
         AND r.finished_at IS NOT NULL`,
      ...args,
    );
    return Math.round(row?.avg_dur ?? 0);
  }

  // ── H4: daily budget ────────────────────────────────────────────────────────

  async getDailyBudget(
    dates: string[],
    projectId: string | null,
    _userId: string,
    _isAdmin: boolean,
  ): Promise<DailyCost[]> {
    if (dates.length === 0) return [];
    const since = dates[0];
    const projectFilter = projectId ? 'AND bu.project_id = ?' : '';
    const args: (string | null)[] = projectId ? [since, projectId] : [since];
    const rows = all<{ date: string; cost: number }>(
      `SELECT
         substr(bu.created_at, 1, 10) AS date,
         SUM(bu.cost_usd) AS cost
       FROM budget_usage bu
       WHERE bu.created_at >= ? ${projectFilter}
       GROUP BY substr(bu.created_at, 1, 10)
       ORDER BY date`,
      ...args,
    );
    const map = new Map(rows.map((r) => [String(r.date), Number(r.cost)]));
    return dates.map((date) => ({ date, cost: map.get(date) ?? 0 }));
  }

  // ── H5: cost by project ─────────────────────────────────────────────────────

  async getCostByProject(
    since: string,
    projectId: string | null,
    _userId: string,
    _isAdmin: boolean,
  ): Promise<ProjectCost[]> {
    const projectFilter = projectId ? 'AND bu.project_id = ?' : '';
    const args: (string | null)[] = projectId ? [since, projectId] : [since];
    const rows = all<{ projectId: string; name: string; cost: number }>(
      `SELECT bu.project_id AS projectId, p.name, SUM(bu.cost_usd) AS cost
       FROM budget_usage bu
       JOIN projects p ON p.id = bu.project_id
       WHERE bu.created_at >= ? ${projectFilter}
       GROUP BY bu.project_id
       ORDER BY cost DESC
       LIMIT 20`,
      ...args,
    );
    return rows.map((r) => ({
      projectId: String(r.projectId),
      name: String(r.name),
      cost: Number(r.cost),
    }));
  }

  // ── H6: cost by user ────────────────────────────────────────────────────────

  async getCostByUser(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<UserCost[]> {
    if (!isAdmin) return [];
    const projectFilter = projectId ? 'AND bu.project_id = ?' : '';
    const args: (string | null)[] = projectId ? [since, projectId] : [since];
    void userId;
    const rows = all<{ userId: string; name: string; cost: number }>(
      `SELECT bu.user_id AS userId, u.name, SUM(bu.cost_usd) AS cost
       FROM budget_usage bu
       JOIN users u ON u.id = bu.user_id
       WHERE bu.created_at >= ? ${projectFilter}
       GROUP BY bu.user_id
       ORDER BY cost DESC
       LIMIT 50`,
      ...args,
    );
    return rows.map((r) => ({
      userId: String(r.userId),
      name: String(r.name),
      cost: Number(r.cost),
    }));
  }

  // ── G1: count distinct agents ───────────────────────────────────────────────

  async countDistinctAgents(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number> {
    const scope = buildScope('w', projectId, isAdmin, userId);
    const row = one<{ cnt: number }>(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(w.lead_agent, ''), 'default')) AS cnt
       FROM p6_runs r
       JOIN p6_workflows w ON w.id = r.workflow_id
       WHERE r.created_at >= ?
         ${scope.filter}`,
      since,
      ...scope.args,
    );
    return Number(row?.cnt ?? 0);
  }

  // ── G (active agents) ───────────────────────────────────────────────────────

  async countActiveAgents(
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number> {
    const scope = buildScope('w', projectId, isAdmin, userId);
    const row = one<{ cnt: number }>(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(w.lead_agent, ''), 'default')) AS cnt
       FROM p6_runs r
       JOIN p6_workflows w ON w.id = r.workflow_id
       WHERE r.status = 'running'
         ${scope.filter}`,
      ...scope.args,
    );
    return Number(row?.cnt ?? 0);
  }

  async listRunningAgentNames(
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<Set<string>> {
    const scope = buildScope('w', projectId, isAdmin, userId);
    const rows = all<{ agent: string }>(
      `SELECT DISTINCT COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent
       FROM p6_runs r
       JOIN p6_workflows w ON w.id = r.workflow_id
       WHERE r.status = 'running'
         ${scope.filter}`,
      ...scope.args,
    );
    return new Set(rows.map((r) => String(r.agent)));
  }

  // ── G2/G3: workflow counts by status ────────────────────────────────────────

  async countWorkflowsByStatus(
    status: 'running' | 'pending',
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<number> {
    const scope = buildScope('w', projectId, isAdmin, userId);
    const row = one<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM p6_workflows w
       WHERE w.status = ?
         ${scope.filter}`,
      status,
      ...scope.args,
    );
    return Number(row?.cnt ?? 0);
  }

  // ── G4: completed today/yesterday ───────────────────────────────────────────

  async getCompletedCounts(
    today: string,
    yesterday: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<{ today: number; yesterday: number }> {
    const scope = buildScope('w', projectId, isAdmin, userId);
    const row = one<{ today_count: number; yesterday_count: number }>(
      `SELECT
         SUM(CASE WHEN r.finished_at >= ? THEN 1 ELSE 0 END) AS today_count,
         SUM(CASE WHEN r.finished_at >= ? AND r.finished_at < ? THEN 1 ELSE 0 END) AS yesterday_count
       FROM p6_runs r
       JOIN p6_workflows w ON w.id = r.workflow_id
       WHERE r.status IN (${TERMINAL_STATUSES})
         AND r.finished_at IS NOT NULL
         AND r.finished_at >= ?
         ${scope.filter}`,
      today, yesterday, today, yesterday,
      ...scope.args,
    );
    return {
      today: Number(row?.today_count ?? 0),
      yesterday: Number(row?.yesterday_count ?? 0),
    };
  }

  // ── G5/G6: success rate counts ──────────────────────────────────────────────

  async getSuccessRateCounts(
    since: string,
    until: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<{ done: number; finished: number }> {
    const scope = buildScope('w', projectId, isAdmin, userId);
    const row = one<{ done_count: number; finished: number }>(
      `SELECT
         SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done_count,
         SUM(CASE WHEN r.status IN (${TERMINAL_STATUSES}) THEN 1 ELSE 0 END) AS finished
       FROM p6_runs r
       JOIN p6_workflows w ON w.id = r.workflow_id
       WHERE r.created_at >= ? AND r.created_at < ?
         ${scope.filter}`,
      since, until,
      ...scope.args,
    );
    return {
      done: Number(row?.done_count ?? 0),
      finished: Number(row?.finished ?? 0),
    };
  }

  // ── G7: per-agent rollups ────────────────────────────────────────────────────

  async getAgentRollups(
    since: string,
    until: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<AgentRollup[]> {
    const scope = buildScope('w', projectId, isAdmin, userId);

    const agentRows = all<{
      agent: string;
      runs: number;
      completed: number;
      failed: number;
      cancelled: number;
      finished: number;
      cost_usd: number;
      credits: number;
      input_tokens: number;
      output_tokens: number;
      last_run_at: string | null;
    }>(
      `SELECT
         COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent,
         COUNT(*) AS runs,
         SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN r.status IN (${TERMINAL_STATUSES}) THEN 1 ELSE 0 END) AS finished,
         COALESCE(SUM(r.cost_usd), 0) AS cost_usd,
         COALESCE(SUM(r.credits), 0) AS credits,
         COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
         COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
         MAX(r.created_at) AS last_run_at
       FROM p6_runs r
       JOIN p6_workflows w ON w.id = r.workflow_id
       WHERE r.created_at >= ? AND r.created_at < ?
         ${scope.filter}
       GROUP BY agent
       ORDER BY runs DESC`,
      since, until,
      ...scope.args,
    );

    // Duration rows for percentile computation
    const durScope = buildScope('w', projectId, isAdmin, userId);
    const durRows = all<{ agent: string; duration_ms: number }>(
      `SELECT
         COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent,
         CAST((julianday(r.finished_at) - julianday(r.started_at)) * 86400000 AS INTEGER) AS duration_ms
       FROM p6_runs r
       JOIN p6_workflows w ON w.id = r.workflow_id
       WHERE r.created_at >= ? AND r.created_at < ?
         AND r.started_at IS NOT NULL
         AND r.finished_at IS NOT NULL
         AND r.status IN (${TERMINAL_STATUSES})
         ${durScope.filter}
       ORDER BY agent, duration_ms ASC`,
      since, until,
      ...durScope.args,
    );

    const durMap = new Map<string, number[]>();
    for (const row of durRows) {
      const a = String(row.agent);
      if (!durMap.has(a)) durMap.set(a, []);
      durMap.get(a)!.push(Number(row.duration_ms));
    }

    // Tool call counts per agent
    const toolScope = buildScope('w', projectId, isAdmin, userId);
    const toolRows = all<{ agent: string; tool_calls: number; tool_errors: number }>(
      `SELECT
         COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent,
         SUM(CASE WHEN e.type = 'tool-start' THEN 1 ELSE 0 END) AS tool_calls,
         SUM(CASE WHEN e.type = 'tool-blocked' THEN 1 ELSE 0 END) AS tool_errors
       FROM p6_runs r
       JOIN p6_workflows w ON w.id = r.workflow_id
       JOIN p6_events e ON e.run_id = r.id
       WHERE r.created_at >= ? AND r.created_at < ?
         AND e.type IN ('tool-start', 'tool-blocked')
         ${toolScope.filter}
       GROUP BY agent`,
      since, until,
      ...toolScope.args,
    );
    const toolMap = new Map(toolRows.map((r) => [
      String(r.agent),
      { toolCalls: Number(r.tool_calls ?? 0), toolErrors: Number(r.tool_errors ?? 0) },
    ]));

    return agentRows.map((r) => {
      const agent = String(r.agent);
      const finished = Number(r.finished ?? 0);
      const doneCount = Number(r.completed ?? 0);
      const failedCount = Number(r.failed ?? 0);
      const cancelledCount = Number(r.cancelled ?? 0);
      const durs = durMap.get(agent) ?? [];
      const totalDurationMs = durs.reduce((a, b) => a + b, 0);
      const tools = toolMap.get(agent) ?? { toolCalls: 0, toolErrors: 0 };
      return {
        agent,
        runs: Number(r.runs),
        doneCount,
        failedCount,
        cancelledCount,
        successRate: finished > 0 ? doneCount / finished : 0,
        totalDurationMs,
        durationCount: durs.length,
        p50DurationMs: percentile(durs, 50),
        p95DurationMs: percentile(durs, 95),
        costUsd: Number(r.cost_usd ?? 0),
        credits: Number(r.credits ?? 0),
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        toolCalls: tools.toolCalls,
        toolErrors: tools.toolErrors,
        lastRunAt: r.last_run_at ? String(r.last_run_at) : null,
      };
    });
  }

  // ── G8: agent edges ─────────────────────────────────────────────────────────

  async getAgentEdges(
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<AgentEdge[]> {
    const edgeScope = buildScope('cw', projectId, isAdmin, userId);
    const rows = all<{ source: string; target: string; cnt: number }>(
      `SELECT
         COALESCE(NULLIF(pw.lead_agent, ''), 'default') AS source,
         COALESCE(NULLIF(cw.lead_agent, ''), 'default') AS target,
         COUNT(*) AS cnt
       FROM p6_workflows cw
       JOIN p6_workflows pw ON pw.id = cw.parent_id
       WHERE cw.parent_id IS NOT NULL
         AND cw.created_at >= ?
         ${edgeScope.filter}
       GROUP BY source, target`,
      since,
      ...edgeScope.args,
    );
    return rows.map((r) => ({
      source: String(r.source),
      target: String(r.target),
      count: Number(r.cnt),
    }));
  }

  // ── G9: recent sessions ─────────────────────────────────────────────────────

  async getRecentSessions(
    limit: number,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<RecentSession[]> {
    const scope = buildScope('w', projectId, isAdmin, userId);
    const rows = all<{
      id: string;
      project_id: string | null;
      project_name: string | null;
      title: string;
      agent: string;
      status: string;
      updated_at: string;
    }>(
      `SELECT
         w.id,
         w.project_id,
         COALESCE(p.name, '') AS project_name,
         COALESCE(NULLIF(w.title, ''), substr(w.goal, 1, 100)) AS title,
         COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent,
         w.status,
         w.updated_at
       FROM p6_workflows w
       LEFT JOIN projects p ON p.id = w.project_id
       WHERE 1=1
         ${scope.filter}
       ORDER BY w.updated_at DESC
       LIMIT ?`,
      ...scope.args,
      limit,
    );
    return rows.map((w) => {
      const childAgentRows = all<{ agent: string }>(
        `SELECT DISTINCT COALESCE(NULLIF(lead_agent, ''), 'default') AS agent
         FROM p6_workflows WHERE parent_id = ?`,
        String(w.id),
      );
      return {
        id: String(w.id),
        projectId: String(w.project_id ?? ''),
        projectName: String(w.project_name ?? ''),
        title: String(w.title ?? ''),
        agent: String(w.agent),
        status: String(w.status),
        childAgents: childAgentRows.map((c) => String(c.agent)),
        updatedAt: String(w.updated_at),
      };
    });
  }

  // ── G10: active session ─────────────────────────────────────────────────────

  async getActiveSession(
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<ActiveSessionData | null> {
    const scope = buildScope('w', projectId, isAdmin, userId);
    const activeWf = one<{
      id: string;
      project_id: string | null;
      title: string;
      agent: string;
      status: string;
    }>(
      `SELECT
         w.id,
         w.project_id,
         COALESCE(NULLIF(w.title, ''), substr(w.goal, 1, 100)) AS title,
         COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent,
         w.status
       FROM p6_workflows w
       WHERE w.status = 'running'
         ${scope.filter}
       ORDER BY w.updated_at DESC
       LIMIT 1`,
      ...scope.args,
    );
    if (!activeWf) return null;

    const wfId = String(activeWf.id);
    const parentAgent = String(activeWf.agent);

    const ownRuns = all<{
      id: string;
      status: string;
      started_at: string | null;
      finished_at: string | null;
      created_at: string;
    }>(
      `SELECT id, status, started_at, finished_at, created_at
       FROM p6_runs
       WHERE workflow_id = ?
       ORDER BY created_at ASC`,
      wfId,
    );

    const childWfs = all<{
      id: string;
      label: string;
      agent: string;
      status: string;
      created_at: string;
      finished_at: string | null;
    }>(
      `SELECT
         id,
         COALESCE(NULLIF(title, ''), substr(goal, 1, 80)) AS label,
         COALESCE(NULLIF(lead_agent, ''), 'default') AS agent,
         status,
         created_at,
         CASE WHEN status IN ('done','failed','paused','blocked') THEN updated_at ELSE NULL END AS finished_at
       FROM p6_workflows
       WHERE parent_id = ?
       ORDER BY created_at ASC`,
      wfId,
    );

    const steps: ActiveSessionStep[] = [];
    let runIdx = 0;
    for (const r of ownRuns) {
      runIdx++;
      steps.push({
        id: String(r.id),
        label: `Run #${runIdx}`,
        agent: parentAgent,
        kind: 'run',
        status: String(r.status),
        startedAt: r.started_at ? String(r.started_at) : null,
        finishedAt: r.finished_at ? String(r.finished_at) : null,
      });
    }
    for (const c of childWfs) {
      steps.push({
        id: String(c.id),
        label: String(c.label),
        agent: String(c.agent),
        kind: 'child',
        status: String(c.status),
        startedAt: c.created_at ? String(c.created_at) : null,
        finishedAt: c.finished_at ? String(c.finished_at) : null,
      });
    }
    steps.sort((a, b) => {
      if (!a.startedAt) return 1;
      if (!b.startedAt) return -1;
      return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
    });

    return {
      id: wfId,
      projectId: String(activeWf.project_id ?? ''),
      title: String(activeWf.title),
      agent: parentAgent,
      status: String(activeWf.status),
      steps,
    };
  }

  // ── G11: agent run list ─────────────────────────────────────────────────────

  async getAgentRunList(
    agentParam: string,
    since: string,
    projectId: string | null,
    userId: string,
    isAdmin: boolean,
  ): Promise<AgentRunItem[]> {
    const isDefault = agentParam === 'default';
    const agentFilter = isDefault
      ? "(w.lead_agent IS NULL OR w.lead_agent = '')"
      : 'w.lead_agent = ?';
    const agentArgs: (string | null)[] = isDefault ? [] : [agentParam];
    const scope = buildScope('w', projectId, isAdmin, userId);

    const rows = all<{
      id: string;
      workflow_id: string;
      project_id: string | null;
      title: string;
      status: string;
      model: string | null;
      provider: string | null;
      cost_usd: number;
      credits: number;
      input_tokens: number;
      output_tokens: number;
      error: string | null;
      created_at: string;
      duration_ms: number | null;
      tool_calls: number;
    }>(
      `SELECT
         r.id,
         r.workflow_id,
         w.project_id,
         COALESCE(NULLIF(w.title, ''), substr(w.goal, 1, 100)) AS title,
         r.status,
         r.model,
         (SELECT bu.provider
            FROM budget_usage bu
           WHERE bu.workflow_id = r.workflow_id
             AND bu.provider IS NOT NULL
           ORDER BY bu.id DESC
           LIMIT 1) AS provider,
         COALESCE(r.cost_usd, 0) AS cost_usd,
         COALESCE(r.credits, 0) AS credits,
         COALESCE(r.input_tokens, 0) AS input_tokens,
         COALESCE(r.output_tokens, 0) AS output_tokens,
         (SELECT JSON_EXTRACT(e.payload, '$.error')
            FROM p6_events e
           WHERE e.run_id = r.id AND e.type = 'run-failed'
           ORDER BY e.id DESC LIMIT 1) AS error,
         r.created_at,
         CASE
           WHEN r.started_at IS NOT NULL AND r.finished_at IS NOT NULL
           THEN CAST((julianday(r.finished_at) - julianday(r.started_at)) * 86400000 AS INTEGER)
           ELSE NULL
         END AS duration_ms,
         (SELECT COUNT(*) FROM p6_events e WHERE e.run_id = r.id AND e.type = 'tool-start') AS tool_calls
       FROM p6_runs r
       JOIN p6_workflows w ON w.id = r.workflow_id
       WHERE ${agentFilter}
         AND r.created_at >= ?
         ${scope.filter}
       ORDER BY r.created_at DESC
       LIMIT 50`,
      ...agentArgs,
      since,
      ...scope.args,
    );

    return rows.map((r) => ({
      id: String(r.id),
      workflowId: String(r.workflow_id),
      projectId: String(r.project_id ?? ''),
      title: String(r.title ?? ''),
      status: String(r.status),
      model: r.model ? String(r.model) : null,
      provider: r.provider ? String(r.provider) : null,
      durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
      costUsd: Number(r.cost_usd ?? 0),
      credits: Number(r.credits ?? 0),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      toolCalls: Number(r.tool_calls ?? 0),
      error: r.error ? String(r.error) : null,
      createdAt: String(r.created_at),
    }));
  }
}
