/**
 * Insights: cost, credits, tokens, latency, models, projects, agents and tools over a date range.
 *
 * GET /api/insights?days=30&projectId=&provider=&kind=&tz=<minutes, Date#getTimezoneOffset()>
 *
 * Everything is computed from data the portal already records: the agent_runs table (cost, tokens, provider, status,
 * timings, Kiro credits in meta), agent_run_events (the model a run really used, tool calls, subagent launches and their
 * results) and inputs (approvals). Non-admins only see projects they are a member of.
 *
 * Kiro CLI reports credits per run, not tokens, and does not split them by agent: Kiro runs count towards runs,
 * credits and latency but not towards token or per-agent figures. Per-agent dollar figures are estimates from each
 * agent's own token usage and list prices; run totals use the provider's real cost.
 */
import { all, type Row } from './db.ts';
import { get } from './http.ts';
import { listProjectsFor, requireProject } from './projects.ts';
import { getSettings, monthSpend } from './settings.ts';
import { ssoStatus } from './sso.ts';
import { estimateCost } from './agent/pricing.ts';
import { connectionSummary } from './project-aws.ts';
import { badRequest, parseJson } from './util.ts';

const DAY = 86_400_000;
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const PROVIDERS = new Set(['demo', 'anthropic', 'bedrock', 'kiro']);
const KINDS = new Set(['chat', 'test', 'review', 'qa', 'learn', 'quiz', 'verify', 'connection']);
/** Per-agent and tool figures read run events; cap how many runs that covers so a long range stays fast. */
const EVENT_RUN_CAP = 1500;

interface AgentAgg {
  name: string;
  kind: 'main' | 'subagent';
  runs: number;
  completed: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  durationMs: number;
  timed: number;
  tools: Map<string, number>;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const durationOf = (r: Row) => (r.started_at && r.finished_at ? Math.max(0, Date.parse(r.finished_at) - Date.parse(r.started_at)) : null);
const creditsOf = (r: Row) => Number(parseJson<any>(r.meta, {}).kiroCredits) || 0;
const tokensOf = (r: Row) => (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0);

export function computeInsights(opts: { projectIds: string[]; days: number; provider?: string; kind?: string; tzOffsetMin?: number; now?: number }) {
  const now = opts.now ?? Date.now();
  const until = new Date(now).toISOString();
  const since = new Date(now - opts.days * DAY).toISOString();
  const prevSince = new Date(now - 2 * opts.days * DAY).toISOString();
  const tz = (opts.tzOffsetMin ?? 0) * 60_000;
  const dayKey = (iso: string) => new Date(Date.parse(iso) - tz).toISOString().slice(0, 10);

  if (!opts.projectIds.length) return { ...blank(opts.days, since, until, dayKey, now), projects: [] as Row[] };

  const ph = opts.projectIds.map(() => '?').join(',');
  const where = [`r.project_id IN (${ph})`, 'r.created_at >= ?'];
  const args: string[] = [...opts.projectIds, prevSince];
  if (opts.provider) {
    where.push('r.provider = ?');
    args.push(opts.provider);
  }
  if (opts.kind) {
    where.push('r.kind = ?');
    args.push(opts.kind);
  }
  const rows = all<Row>(
    `SELECT r.id, r.project_id, r.kind, r.title, r.status, r.model, r.provider, r.cost_usd, r.input_tokens, r.output_tokens,
            r.meta, r.created_at, r.started_at, r.finished_at, r.error
       FROM agent_runs r WHERE ${where.join(' AND ')} ORDER BY r.created_at`,
    ...args,
  );
  const cur = rows.filter((r) => r.created_at >= since);
  const prev = rows.filter((r) => r.created_at < since);

  // The model a run really used (the alias in runs.model is resolved by the provider at start).
  const realModel = new Map<string, string>();
  if (cur.length) {
    const inits = all<Row>(
      `SELECT e.run_id, e.data FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id
        WHERE e.type = 'system:init' AND ${where.join(' AND ')} AND r.created_at >= ?`,
      ...args,
      since,
    );
    for (const e of inits) {
      const m = parseJson<any>(e.data, {}).model;
      if (m && !realModel.has(e.run_id)) realModel.set(e.run_id, String(m));
    }
  }
  const modelOf = (r: Row) => realModel.get(r.id) || r.model || 'unknown';

  /* ---------------- Totals ---------------- */
  const finished = cur.filter((r) => ['completed', 'failed', 'stopped'].includes(r.status));
  const completed = cur.filter((r) => r.status === 'completed').length;
  const failed = cur.filter((r) => r.status === 'failed').length;
  const durations = cur.map(durationOf).filter((d): d is number => d !== null).sort((a, b) => a - b);
  const sum = (list: Row[], f: (r: Row) => number) => list.reduce((s, r) => s + f(r), 0);
  const totals = {
    runs: cur.length,
    completed,
    failed,
    stopped: cur.filter((r) => r.status === 'stopped').length,
    active: cur.filter((r) => ['queued', 'running', 'waiting'].includes(r.status)).length,
    successRate: finished.length ? completed / finished.length : null,
    costUsd: sum(cur, (r) => Number(r.cost_usd) || 0),
    credits: sum(cur, creditsOf),
    inputTokens: sum(cur, (r) => Number(r.input_tokens) || 0),
    outputTokens: sum(cur, (r) => Number(r.output_tokens) || 0),
    medianDurationMs: pct(durations, 50),
    p95DurationMs: pct(durations, 95),
    prev: { runs: prev.length, costUsd: sum(prev, (r) => Number(r.cost_usd) || 0), credits: sum(prev, creditsOf), tokens: sum(prev, tokensOf) },
  };

  /* ---------------- Daily series ---------------- */
  const daily = new Map<string, any>();
  for (let t = now - (opts.days - 1) * DAY; t <= now; t += DAY) {
    const k = dayKey(new Date(t).toISOString());
    daily.set(k, { date: k, runs: 0, failed: 0, costUsd: 0, credits: 0, inputTokens: 0, outputTokens: 0, byProvider: {}, tokensByModel: {}, durations: [] as number[] });
  }
  for (const r of cur) {
    const d = daily.get(dayKey(r.created_at));
    if (!d) continue;
    d.runs++;
    if (r.status === 'failed') d.failed++;
    d.costUsd += Number(r.cost_usd) || 0;
    d.credits += creditsOf(r);
    d.inputTokens += Number(r.input_tokens) || 0;
    d.outputTokens += Number(r.output_tokens) || 0;
    const p = r.provider || 'unknown';
    d.byProvider[p] = (d.byProvider[p] || 0) + 1;
    const tok = tokensOf(r);
    if (tok) d.tokensByModel[modelOf(r)] = (d.tokensByModel[modelOf(r)] || 0) + tok;
    const dur = durationOf(r);
    if (dur !== null) d.durations.push(dur);
  }
  const dailyOut = [...daily.values()].map(({ durations: ds, ...d }) => {
    ds.sort((a: number, b: number) => a - b);
    return { ...d, medianMs: pct(ds, 50), p95Ms: pct(ds, 95) };
  });

  /* ---------------- Models, providers, kinds ---------------- */
  const group = <K extends string>(keyOf: (r: Row) => K) => {
    const m = new Map<K, { runs: number; completed: number; finished: number; costUsd: number; credits: number; tokens: number; durations: number[] }>();
    for (const r of cur) {
      const k = keyOf(r);
      const g = m.get(k) ?? { runs: 0, completed: 0, finished: 0, costUsd: 0, credits: 0, tokens: 0, durations: [] };
      g.runs++;
      if (r.status === 'completed') g.completed++;
      if (['completed', 'failed', 'stopped'].includes(r.status)) g.finished++;
      g.costUsd += Number(r.cost_usd) || 0;
      g.credits += creditsOf(r);
      g.tokens += tokensOf(r);
      const dur = durationOf(r);
      if (dur !== null) g.durations.push(dur);
      m.set(k, g);
    }
    return [...m.entries()].map(([key, g]) => {
      g.durations.sort((a, b) => a - b);
      const { durations: ds, ...rest } = g;
      return { key, ...rest, successRate: g.finished ? g.completed / g.finished : null, medianMs: pct(ds, 50) };
    });
  };
  const models = group((r) => modelOf(r)).map(({ key, ...g }) => ({ model: key, provider: cur.find((r) => modelOf(r) === key)?.provider ?? '', ...g })).sort((a, b) => b.runs - a.runs);
  const providers = group((r) => r.provider || 'unknown').map(({ key, ...g }) => ({ provider: key, ...g })).sort((a, b) => b.runs - a.runs);
  const kinds = group((r) => r.kind).map(({ key, ...g }) => ({ kind: key, ...g })).sort((a, b) => b.runs - a.runs);

  /* ---------------- Projects ---------------- */
  const projRows = all<Row>(`SELECT id, name, slug, archived FROM projects WHERE id IN (${ph}) ORDER BY name COLLATE NOCASE`, ...opts.projectIds);
  const pending = new Map(all<Row>(`SELECT project_id, COUNT(*) AS n FROM inputs WHERE status = 'pending' AND project_id IN (${ph}) GROUP BY project_id`, ...opts.projectIds).map((x) => [x.project_id, x.n]));
  const sessions = new Map(all<Row>(`SELECT project_id, COUNT(*) AS n FROM workflows WHERE status = 'running' AND project_id IN (${ph}) GROUP BY project_id`, ...opts.projectIds).map((x) => [x.project_id, x.n]));
  const lastActivity = new Map(all<Row>(`SELECT project_id, MAX(created_at) AS at FROM agent_runs WHERE project_id IN (${ph}) GROUP BY project_id`, ...opts.projectIds).map((x) => [x.project_id, x.at]));
  const byProjectAgg = new Map(group((r) => r.project_id).map(({ key, ...g }) => [key, g]));
  const projects = projRows.map((p) => {
    const g = byProjectAgg.get(p.id);
    let connection: ReturnType<typeof connectionSummary> | null = null;
    try {
      connection = connectionSummary(p.id);
    } catch {
      connection = null;
    }
    return {
      id: p.id,
      name: p.name,
      archived: Boolean(p.archived),
      runs: g?.runs ?? 0,
      costUsd: g?.costUsd ?? 0,
      credits: g?.credits ?? 0,
      tokens: g?.tokens ?? 0,
      successRate: g?.successRate ?? null,
      medianMs: g?.medianMs ?? 0,
      activeSessions: sessions.get(p.id) ?? 0,
      pendingInputs: pending.get(p.id) ?? 0,
      lastActivity: lastActivity.get(p.id) ?? null,
      connection,
    };
  });

  /* ---------------- Agents and tools (from run events) ---------------- */
  const agents = new Map<string, AgentAgg>();
  const agentFor = (name: string, kind: 'main' | 'subagent') => {
    const key = `${kind}:${name}`;
    let a = agents.get(key);
    if (!a) {
      a = { name, kind, runs: 0, completed: 0, failed: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0, durationMs: 0, timed: 0, tools: new Map() };
      agents.set(key, a);
    }
    return a;
  };
  const tools = new Map<string, { calls: number; errors: number }>();
  let blocked = 0;
  const eventRuns = cur.slice(-EVENT_RUN_CAP);
  const runById = new Map(eventRuns.map((r) => [r.id, r]));
  if (eventRuns.length) {
    const ids = eventRuns.map((r) => r.id);
    const events: Row[] = [];
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      events.push(
        ...all<Row>(
          `SELECT run_id, seq, ts, type, parent_tool_use_id AS parent, data FROM agent_run_events
            WHERE run_id IN (${chunk.map(() => '?').join(',')}) AND type IN ('assistant', 'user', 'system:portal_blocked')
            ORDER BY run_id, seq`,
          ...chunk,
        ),
      );
    }
    let runId = '';
    let main: AgentAgg | null = null;
    let subs = new Map<string, { agg: AgentAgg; startTs: number }>();
    let seen = new Set<string>();
    const toolNames = new Map<string, { name: string; agent: AgentAgg }>();
    const closeRun = () => {
      // A subagent that never returned a result is counted as failed when its run did not complete.
      const ok = runById.get(runId)?.status === 'completed';
      for (const s of subs.values()) if (s.startTs >= 0 && !ok) s.agg.failed++;
    };
    for (const e of events) {
      if (e.run_id !== runId) {
        if (runId) closeRun();
        runId = e.run_id;
        const r = runById.get(runId)!;
        const meta = parseJson<any>(r.meta, {});
        main = agentFor(meta.leadAgent || 'Main agent', 'main');
        main.runs++;
        if (r.status === 'completed') main.completed++;
        else if (r.status === 'failed') main.failed++;
        const dur = durationOf(r);
        if (dur !== null) {
          main.durationMs += dur;
          main.timed++;
        }
        subs = new Map();
        seen = new Set();
        toolNames.clear();
      }
      const d = parseJson<any>(e.data, {});
      const r = runById.get(runId)!;
      if (e.type === 'system:portal_blocked') {
        blocked++;
        continue;
      }
      if (e.type === 'assistant') {
        const agent = e.parent ? subs.get(e.parent)?.agg ?? agentFor('Subagent', 'subagent') : main!;
        const msg = d.message ?? {};
        const mid = String(msg.id ?? d.uuid ?? e.seq);
        if (msg.usage && !seen.has(mid) && r.provider !== 'kiro') {
          seen.add(mid);
          const u = msg.usage;
          agent.inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          agent.outputTokens += u.output_tokens || 0;
          agent.estCostUsd += estimateCost(msg.model || modelOf(r), u);
        }
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b?.type !== 'tool_use') continue;
          const name = String(b.name ?? 'tool');
          agent.tools.set(name, (agent.tools.get(name) ?? 0) + 1);
          const t = tools.get(name) ?? { calls: 0, errors: 0 };
          t.calls++;
          tools.set(name, t);
          toolNames.set(b.id, { name, agent });
          if (SUBAGENT_TOOLS.has(name)) {
            const sub = agentFor(String(b.input?.subagent_type || 'Subagent'), 'subagent');
            sub.runs++;
            subs.set(b.id, { agg: sub, startTs: Date.parse(e.ts) || 0 });
          }
        }
      } else if (e.type === 'user') {
        for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
          if (b?.type !== 'tool_result') continue;
          const t = toolNames.get(b.tool_use_id);
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          if (/Blocked by Agent Portal/.test(text)) blocked++;
          if (t && b.is_error) {
            const agg = tools.get(t.name);
            if (agg) agg.errors++;
          }
          const s = subs.get(b.tool_use_id);
          if (s && s.startTs >= 0) {
            if (b.is_error) s.agg.failed++;
            else s.agg.completed++;
            const end = Date.parse(e.ts) || 0;
            if (s.startTs && end >= s.startTs) {
              s.agg.durationMs += end - s.startTs;
              s.agg.timed++;
            }
            s.startTs = -1;
          }
        }
      }
    }
    if (runId) closeRun();
  }
  const agentsOut = [...agents.values()]
    .map((a) => ({
      name: a.name,
      kind: a.kind,
      runs: a.runs,
      completed: a.completed,
      failed: a.failed,
      successRate: a.completed + a.failed ? a.completed / (a.completed + a.failed) : null,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      estCostUsd: a.estCostUsd,
      avgDurationMs: a.timed ? Math.round(a.durationMs / a.timed) : 0,
      topTools: [...a.tools.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
    }))
    .filter((a) => a.runs > 0)
    .sort((a, b) => b.runs - a.runs);
  const toolsOut = [...tools.entries()].map(([name, t]) => ({ name, ...t })).sort((a, b) => b.calls - a.calls).slice(0, 15);

  /* ---------------- Approvals ---------------- */
  const approvals = all<Row>(
    `SELECT response FROM inputs WHERE type = 'approval' AND project_id IN (${ph}) AND created_at >= ?`,
    ...opts.projectIds,
    since,
  );
  const denied = approvals.filter((a) => parseJson<any>(a.response, {})?.decision === 'deny').length;

  /* ---------------- Notable runs ---------------- */
  const brief = (r: Row) => ({ id: r.id, projectId: r.project_id, title: r.title, kind: r.kind, status: r.status, provider: r.provider, model: modelOf(r), costUsd: Number(r.cost_usd) || 0, credits: creditsOf(r), tokens: tokensOf(r), durationMs: durationOf(r), createdAt: r.created_at, error: r.status === 'failed' ? String(r.error ?? '').slice(0, 200) : '' });
  const slowest = cur.filter((r) => durationOf(r) !== null).sort((a, b) => durationOf(b)! - durationOf(a)!).slice(0, 5).map(brief);
  const priciest = [...cur].sort((a, b) => (Number(b.cost_usd) || 0) + creditsOf(b) / 100 - ((Number(a.cost_usd) || 0) + creditsOf(a) / 100)).filter((r) => (Number(r.cost_usd) || 0) > 0 || creditsOf(r) > 0).slice(0, 5).map(brief);
  const failures = cur.filter((r) => r.status === 'failed').slice(-5).reverse().map(brief);

  /* ---------------- Health ---------------- */
  const sso = ssoStatus();
  const tests = all<Row>(
    `SELECT r.project_id, r.status, r.created_at, r.error FROM agent_runs r
      WHERE r.kind = 'connection' AND r.project_id IN (${ph})
        AND r.created_at = (SELECT MAX(x.created_at) FROM agent_runs x WHERE x.kind = 'connection' AND x.project_id = r.project_id)`,
    ...opts.projectIds,
  );
  const s = getSettings();
  const health = {
    sso: { signedIn: sso.signedIn, expiresAt: sso.expiresAt ?? null },
    connectionTests: tests.map((t) => ({ projectId: t.project_id, ok: t.status === 'completed', at: t.created_at, error: t.status === 'completed' ? '' : String(t.error ?? '').slice(0, 200) })),
    budget: { monthlyUsd: s.budget.monthlyUsd, monthUsd: monthSpend() },
  };

  return {
    range: { days: opts.days, since, until },
    totals,
    daily: dailyOut,
    models,
    providers,
    kinds,
    projects,
    agents: agentsOut,
    agentsSampled: cur.length > EVENT_RUN_CAP ? EVENT_RUN_CAP : null,
    tools: toolsOut,
    approvals: { asked: approvals.length, denied },
    blocked,
    slowest,
    priciest,
    failures,
    health,
  };
}

/** The same shape with nothing in it, for a user without projects. */
function blank(days: number, since: string, until: string, dayKey: (iso: string) => string, now: number) {
  const daily = [];
  for (let t = now - (days - 1) * DAY; t <= now; t += DAY) {
    daily.push({ date: dayKey(new Date(t).toISOString()), runs: 0, failed: 0, costUsd: 0, credits: 0, inputTokens: 0, outputTokens: 0, byProvider: {}, tokensByModel: {}, medianMs: 0, p95Ms: 0 });
  }
  return {
    range: { days, since, until },
    totals: { runs: 0, completed: 0, failed: 0, stopped: 0, active: 0, successRate: null, costUsd: 0, credits: 0, inputTokens: 0, outputTokens: 0, medianDurationMs: 0, p95DurationMs: 0, prev: { runs: 0, costUsd: 0, credits: 0, tokens: 0 } },
    daily,
    models: [],
    providers: [],
    kinds: [],
    agents: [],
    agentsSampled: null,
    tools: [],
    approvals: { asked: 0, denied: 0 },
    blocked: 0,
    slowest: [],
    priciest: [],
    failures: [],
    health: { sso: { signedIn: false, expiresAt: null }, connectionTests: [], budget: { monthlyUsd: getSettings().budget.monthlyUsd, monthUsd: monthSpend() } },
  };
}

export function registerInsightsRoutes(): void {
  get('/api/insights', (ctx) => {
    const q = ctx.query;
    const days = Number(q.get('days') || 30);
    if (![7, 14, 30, 90].includes(days)) throw badRequest('days must be 7, 14, 30 or 90');
    const provider = q.get('provider') || '';
    if (provider && !PROVIDERS.has(provider)) throw badRequest('Unknown provider');
    const kind = q.get('kind') || '';
    if (kind && !KINDS.has(kind)) throw badRequest('Unknown run type');
    const tz = Number(q.get('tz') || 0);
    const tzOffsetMin = Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0;
    const pid = q.get('projectId') || '';
    let projectIds: string[];
    if (pid) {
      requireProject(ctx, pid);
      projectIds = [pid];
    } else {
      projectIds = listProjectsFor(ctx.user!).map((p) => String(p.id));
    }
    return computeInsights({ projectIds, days, provider: provider || undefined, kind: kind || undefined, tzOffsetMin });
  });
}
