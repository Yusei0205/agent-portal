/**
 * Agent Performance Dashboard API.
 *
 * GET /api/dashboard?period=today|7d|30d&projectId=<optional>
 * GET /api/dashboard/agents/:agent/runs?period=today|7d|30d&projectId=<optional>
 *
 * Access: signed in; admins see all projects; non-admins see only their
 * member projects. If projectId is supplied, membership is enforced (404/403).
 * Invalid period → 400. Default period: 7d.
 *
 * All data comes from p6_workflows + p6_runs + p6_events (the active runner
 * tables introduced in M6). The legacy M3 agent_runs / workflows tables are
 * not touched here.
 *
 * Run statuses (p6_runs): pending | running | done | failed | cancelled
 * Workflow statuses (p6_workflows): pending | running | done | blocked | failed | paused
 * Terminal run statuses: done | failed | cancelled
 * Tool events (p6_events.type): tool-start (call) | tool-blocked (denial/error)
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all } from './db.ts';
import type { Row } from './db.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = "'done','failed','cancelled'";

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
    const prevSince = new Date(now.getTime() - 14 * 86_400_000);
    return { prevSince: prevSince.toISOString(), prevUntil: since.toISOString() };
  }
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const prevSince = new Date(now.getTime() - 60 * 86_400_000);
  return { prevSince: prevSince.toISOString(), prevUntil: since.toISOString() };
}

/** UTC midnight of today (ISO string). */
function todayStart(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** UTC midnight of yesterday (ISO string). */
function yesterdayStart(): string {
  return new Date(new Date(todayStart()).getTime() - 86_400_000).toISOString();
}

/** Percentile over a pre-sorted ascending array. Returns null when empty. */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sortedAsc[lo]);
  return Math.round(sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo));
}

/** Normalise lead_agent: empty / null → "default". */
function agentName(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return s || 'default';
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

// ── Scope builder ─────────────────────────────────────────────────────────────

/**
 * Build a SQL WHERE fragment that restricts `alias`.project_id to the
 * projects the requesting user can see.
 *
 * @param alias     Table alias that has a project_id column (e.g. 'w', 'cw').
 * @param projectId Explicit project filter (already membership-checked), or null.
 * @param isAdmin   True → admin sees all projects.
 * @param userId    Non-admin user ID for the membership sub-select.
 */
function buildScope(
  alias: string,
  projectId: string | null,
  isAdmin: boolean,
  userId: string,
): { filter: string; args: (string | null)[] } {
  if (projectId) {
    return { filter: `AND ${alias}.project_id = ?`, args: [projectId] };
  }
  if (isAdmin) {
    return { filter: '', args: [] };
  }
  return {
    filter: `AND ${alias}.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)`,
    args: [userId],
  };
}

// ── Dashboard computation ─────────────────────────────────────────────────────

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
    successRate: number;
    successRatePrev: number | null;
  };
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

function computeDashboard(
  period: string,
  projectId: string | null,
  isAdmin: boolean,
  userId: string,
): DashboardShape {
  const since = periodToSince(period);
  const { prevSince, prevUntil } = prevPeriodRange(period);
  const today = todayStart();
  const yesterday = yesterdayStart();

  // Scope filter for queries joining through p6_workflows (alias 'w')
  const wScope = buildScope('w', projectId, isAdmin, userId);
  // Scope filter for queries on p6_workflows directly (alias 'w')
  const wfScope = wScope; // same alias

  // ── Summary ──────────────────────────────────────────────────────────────

  // Distinct agents with ≥1 run in period
  const totalAgentsRow = one<{ cnt: number }>(
    `SELECT COUNT(DISTINCT COALESCE(NULLIF(w.lead_agent, ''), 'default')) AS cnt
     FROM p6_runs r
     JOIN p6_workflows w ON w.id = r.workflow_id
     WHERE r.created_at >= ?
       ${wScope.filter}`,
    since,
    ...wScope.args,
  );
  const totalAgents = Number(totalAgentsRow?.cnt ?? 0);

  // Distinct agents with a currently running run (no period filter — live state)
  const activeAgentsScope = buildScope('w', projectId, isAdmin, userId);
  const activeAgentsRow = one<{ cnt: number }>(
    `SELECT COUNT(DISTINCT COALESCE(NULLIF(w.lead_agent, ''), 'default')) AS cnt
     FROM p6_runs r
     JOIN p6_workflows w ON w.id = r.workflow_id
     WHERE r.status = 'running'
       ${activeAgentsScope.filter}`,
    ...activeAgentsScope.args,
  );
  const activeAgents = Number(activeAgentsRow?.cnt ?? 0);

  // Running workflows
  const runningScope = buildScope('w', projectId, isAdmin, userId);
  const runningRow = one<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM p6_workflows w
     WHERE w.status = 'running'
       ${runningScope.filter}`,
    ...runningScope.args,
  );
  const runningSessions = Number(runningRow?.cnt ?? 0);

  // Queued workflows
  const queuedScope = buildScope('w', projectId, isAdmin, userId);
  const queuedRow = one<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM p6_workflows w
     WHERE w.status = 'pending'
       ${queuedScope.filter}`,
    ...queuedScope.args,
  );
  const queuedSessions = Number(queuedRow?.cnt ?? 0);

  // Completed today & yesterday (based on finished_at)
  const doneScope = buildScope('w', projectId, isAdmin, userId);
  const doneRow = one<{ today_count: number; yesterday_count: number }>(
    `SELECT
       SUM(CASE WHEN r.finished_at >= ? THEN 1 ELSE 0 END) AS today_count,
       SUM(CASE WHEN r.finished_at >= ? AND r.finished_at < ? THEN 1 ELSE 0 END) AS yesterday_count
     FROM p6_runs r
     JOIN p6_workflows w ON w.id = r.workflow_id
     WHERE r.status IN (${TERMINAL_STATUSES})
       AND r.finished_at IS NOT NULL
       AND r.finished_at >= ?
       ${doneScope.filter}`,
    today, yesterday, today, yesterday,
    ...doneScope.args,
  );
  const completedToday = Number(doneRow?.today_count ?? 0);
  const completedYesterday = Number(doneRow?.yesterday_count ?? 0);

  // Success rate for current period
  const srScope = buildScope('w', projectId, isAdmin, userId);
  const srRow = one<{ done_count: number; finished: number }>(
    `SELECT
       SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done_count,
       SUM(CASE WHEN r.status IN (${TERMINAL_STATUSES}) THEN 1 ELSE 0 END) AS finished
     FROM p6_runs r
     JOIN p6_workflows w ON w.id = r.workflow_id
     WHERE r.created_at >= ?
       ${srScope.filter}`,
    since,
    ...srScope.args,
  );
  const doneCurrent = Number(srRow?.done_count ?? 0);
  const finishedCurrent = Number(srRow?.finished ?? 0);
  const successRate = finishedCurrent > 0 ? doneCurrent / finishedCurrent : 0;

  // Success rate for previous period
  const srPrevScope = buildScope('w', projectId, isAdmin, userId);
  const srPrevRow = one<{ done_count: number; finished: number }>(
    `SELECT
       SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done_count,
       SUM(CASE WHEN r.status IN (${TERMINAL_STATUSES}) THEN 1 ELSE 0 END) AS finished
     FROM p6_runs r
     JOIN p6_workflows w ON w.id = r.workflow_id
     WHERE r.created_at >= ? AND r.created_at < ?
       ${srPrevScope.filter}`,
    prevSince, prevUntil,
    ...srPrevScope.args,
  );
  const donePrev = Number(srPrevRow?.done_count ?? 0);
  const finishedPrev = Number(srPrevRow?.finished ?? 0);
  const successRatePrev = finishedPrev > 0 ? donePrev / finishedPrev : null;

  // ── Network nodes ─────────────────────────────────────────────────────────

  const nodeScope = buildScope('w', projectId, isAdmin, userId);
  const nodeRows = all<{
    agent: string;
    runs: number;
    done_count: number;
    finished: number;
    avg_dur_ms: number | null;
  }>(
    `SELECT
       COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent,
       COUNT(*) AS runs,
       SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done_count,
       SUM(CASE WHEN r.status IN (${TERMINAL_STATUSES}) THEN 1 ELSE 0 END) AS finished,
       AVG(CASE
         WHEN r.started_at IS NOT NULL AND r.finished_at IS NOT NULL
         THEN (julianday(r.finished_at) - julianday(r.started_at)) * 86400000.0
         ELSE NULL
       END) AS avg_dur_ms
     FROM p6_runs r
     JOIN p6_workflows w ON w.id = r.workflow_id
     WHERE r.created_at >= ?
       ${nodeScope.filter}
     GROUP BY agent`,
    since,
    ...nodeScope.args,
  );

  const activeAgentScope = buildScope('w', projectId, isAdmin, userId);
  const activeAgentRows = all<{ agent: string }>(
    `SELECT DISTINCT COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent
     FROM p6_runs r
     JOIN p6_workflows w ON w.id = r.workflow_id
     WHERE r.status = 'running'
       ${activeAgentScope.filter}`,
    ...activeAgentScope.args,
  );
  const activeAgentSet = new Set(activeAgentRows.map((r) => String(r.agent)));

  const networkNodes = nodeRows.map((r) => {
    const n = Number(r.finished ?? 0);
    return {
      id: String(r.agent),
      label: String(r.agent),
      runs: Number(r.runs),
      successRate: n > 0 ? Number(r.done_count) / n : 0,
      running: activeAgentSet.has(String(r.agent)),
      avgDurationMs: Math.round(Number(r.avg_dur_ms ?? 0)),
    };
  });

  // ── Network edges ─────────────────────────────────────────────────────────

  const edgeScope = buildScope('cw', projectId, isAdmin, userId);
  const edgeRows = all<{ source: string; target: string; cnt: number }>(
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
  const networkEdges = edgeRows.map((r) => ({
    source: String(r.source),
    target: String(r.target),
    count: Number(r.cnt),
  }));

  // ── Per-agent stats ───────────────────────────────────────────────────────

  // Aggregate stats
  const agentScope = buildScope('w', projectId, isAdmin, userId);
  const agentRows = all<{
    agent: string;
    runs: number;
    completed: number;
    failed: number;
    finished: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    last_run_at: string | null;
  }>(
    `SELECT
       COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent,
       COUNT(*) AS runs,
       SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN r.status IN (${TERMINAL_STATUSES}) THEN 1 ELSE 0 END) AS finished,
       COALESCE(SUM(r.cost_usd), 0) AS cost_usd,
       COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
       COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
       MAX(r.created_at) AS last_run_at
     FROM p6_runs r
     JOIN p6_workflows w ON w.id = r.workflow_id
     WHERE r.created_at >= ?
       ${agentScope.filter}
     GROUP BY agent
     ORDER BY runs DESC`,
    since,
    ...agentScope.args,
  );

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
     WHERE r.created_at >= ?
       AND e.type IN ('tool-start', 'tool-blocked')
       ${toolScope.filter}
     GROUP BY agent`,
    since,
    ...toolScope.args,
  );
  const toolMap = new Map(toolRows.map((r) => [
    String(r.agent),
    { toolCalls: Number(r.tool_calls ?? 0), toolErrors: Number(r.tool_errors ?? 0) },
  ]));

  // Duration data for percentile computation (only finished runs with both timestamps)
  const durScope = buildScope('w', projectId, isAdmin, userId);
  const durRows = all<{ agent: string; duration_ms: number }>(
    `SELECT
       COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent,
       CAST((julianday(r.finished_at) - julianday(r.started_at)) * 86400000 AS INTEGER) AS duration_ms
     FROM p6_runs r
     JOIN p6_workflows w ON w.id = r.workflow_id
     WHERE r.created_at >= ?
       AND r.started_at IS NOT NULL
       AND r.finished_at IS NOT NULL
       AND r.status IN (${TERMINAL_STATUSES})
       ${durScope.filter}
     ORDER BY agent, duration_ms ASC`,
    since,
    ...durScope.args,
  );

  // Group durations by agent for percentile computation
  const durMap = new Map<string, number[]>();
  for (const row of durRows) {
    const a = String(row.agent);
    if (!durMap.has(a)) durMap.set(a, []);
    durMap.get(a)!.push(Number(row.duration_ms));
  }

  const agents: AgentStats[] = agentRows.map((r) => {
    const agent = String(r.agent);
    const finished = Number(r.finished ?? 0);
    const completed = Number(r.completed ?? 0);
    const durs = durMap.get(agent) ?? [];
    const tools = toolMap.get(agent) ?? { toolCalls: 0, toolErrors: 0 };
    return {
      agent,
      runs: Number(r.runs),
      completed,
      failed: Number(r.failed ?? 0),
      successRate: finished > 0 ? completed / finished : 0,
      p50DurationMs: percentile(durs, 50),
      p95DurationMs: percentile(durs, 95),
      avgDurationMs: durs.length > 0
        ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length)
        : 0,
      costUsd: Number(r.cost_usd ?? 0),
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      toolCalls: tools.toolCalls,
      toolErrors: tools.toolErrors,
      lastRunAt: r.last_run_at ? String(r.last_run_at) : null,
    };
  });

  // ── Recent sessions ───────────────────────────────────────────────────────

  const recentScope = buildScope('w', projectId, isAdmin, userId);
  const recentRows = all<{
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
       ${recentScope.filter}
     ORDER BY w.updated_at DESC
     LIMIT 10`,
    ...recentScope.args,
  );

  const recentSessions = recentRows.map((w) => {
    const childAgentRows = all<{ agent: string }>(
      `SELECT DISTINCT COALESCE(NULLIF(lead_agent, ''), 'default') AS agent
       FROM p6_workflows
       WHERE parent_id = ?`,
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

  // ── Active session ────────────────────────────────────────────────────────

  const activeScope = buildScope('w', projectId, isAdmin, userId);
  const activeWf = one<{
    id: string;
    project_id: string | null;
    title: string;
    agent: string;
    status: string;
    updated_at: string;
  }>(
    `SELECT
       w.id,
       w.project_id,
       COALESCE(NULLIF(w.title, ''), substr(w.goal, 1, 100)) AS title,
       COALESCE(NULLIF(w.lead_agent, ''), 'default') AS agent,
       w.status,
       w.updated_at
     FROM p6_workflows w
     WHERE w.status = 'running'
       ${activeScope.filter}
     ORDER BY w.updated_at DESC
     LIMIT 1`,
    ...activeScope.args,
  );

  let activeSession: DashboardShape['activeSession'] = null;
  if (activeWf) {
    const wfId = String(activeWf.id);
    const parentAgent = String(activeWf.agent);

    // Own runs
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

    // Child workflows
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

    type Step = {
      id: string;
      label: string;
      agent: string;
      kind: 'run' | 'child';
      status: string;
      startedAt: string | null;
      finishedAt: string | null;
    };

    const steps: Step[] = [];
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

    // Sort chronologically by startedAt (nulls last)
    steps.sort((a, b) => {
      if (!a.startedAt) return 1;
      if (!b.startedAt) return -1;
      return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
    });

    activeSession = {
      id: wfId,
      projectId: String(activeWf.project_id ?? ''),
      title: String(activeWf.title),
      agent: parentAgent,
      status: String(activeWf.status),
      steps,
    };
  }

  return {
    period,
    generatedAt: new Date().toISOString(),
    summary: {
      totalAgents,
      activeAgents,
      runningSessions,
      queuedSessions,
      completedToday,
      completedYesterday,
      successRate,
      successRatePrev,
    },
    network: {
      nodes: networkNodes,
      edges: networkEdges,
    },
    agents,
    recentSessions,
    activeSession,
  };
}

// ── Drill-down computation ────────────────────────────────────────────────────

function computeAgentRuns(
  agentParam: string,
  period: string,
  projectId: string | null,
  isAdmin: boolean,
  userId: string,
): object[] {
  const since = periodToSince(period);
  // 'default' agent maps to empty / null lead_agent in DB
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
    tokens: {
      input: Number(r.input_tokens ?? 0),
      output: Number(r.output_tokens ?? 0),
    },
    toolCalls: Number(r.tool_calls ?? 0),
    error: r.error ? String(r.error) : null,
    createdAt: String(r.created_at),
  }));
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerDashboardRoutes(): void {
  /**
   * GET /api/dashboard?period=today|7d|30d&projectId=<optional>
   */
  router.get(
    '/api/dashboard',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const period = req.query.get('period') || '7d';
      if (!['today', '7d', '30d'].includes(period)) {
        sendJson(res, 400, { error: 'period must be today, 7d or 30d' });
        return;
      }

      const projectId = req.query.get('projectId') || null;
      if (projectId) {
        const ok = requireMember(req, res, projectId);
        if (!ok) return;
      }

      const data = computeDashboard(
        period,
        projectId,
        Boolean(req.user?.is_admin),
        req.user!.id,
      );
      sendJson(res, 200, data);
    }),
  );

  /**
   * GET /api/dashboard/agents/:agent/runs?period=today|7d|30d&projectId=<optional>
   */
  router.get(
    '/api/dashboard/agents/:agent/runs',
    requireAuth((req: PortalRequest, res: PortalResponse) => {
      const period = req.query.get('period') || '7d';
      if (!['today', '7d', '30d'].includes(period)) {
        sendJson(res, 400, { error: 'period must be today, 7d or 30d' });
        return;
      }

      const projectId = req.query.get('projectId') || null;
      if (projectId) {
        const ok = requireMember(req, res, projectId);
        if (!ok) return;
      }

      const agentParam = req.params.agent;
      if (!agentParam) {
        sendJson(res, 400, { error: 'agent name required' });
        return;
      }

      const runs = computeAgentRuns(
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
