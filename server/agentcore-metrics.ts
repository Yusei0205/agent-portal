/**
 * AgentCore dashboard: what the AgentCore runtimes used, read from CloudWatch (namespace AWS/Bedrock-AgentCore).
 *
 * GET /api/agentcore/metrics?period=24h|7d|30d   (admin only)
 *
 * Runtime sessions bill for the CPU and memory they use, so the page leads with vCPU-hours and GB-hours per runtime plus an
 * estimated cost. The cost is an ESTIMATE from the published per-hour rates below, not the invoice: check Cost Explorer for that.
 * A runtime that was recreated (the job runner gets a new id each time) is one row: runtimes are grouped by their name.
 *
 * `buildSnapshot` is a pure function over the metric data so it can be tested without AWS; `collectMetrics` does the CloudWatch calls.
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';

export const NAMESPACE = 'AWS/Bedrock-AgentCore';
/** Published AgentCore Runtime rates, USD per hour. Estimates only. */
export const RATE_VCPU_HOUR = 0.0895;
export const RATE_GB_HOUR = 0.00945;

export interface PeriodSpec { label: string; ms: number; step: number }
export const PERIODS: Record<string, PeriodSpec> = {
  '24h': { label: '24 hours', ms: 86_400_000, step: 3600 },
  '7d': { label: '7 days', ms: 7 * 86_400_000, step: 86_400 },
  '30d': { label: '30 days', ms: 30 * 86_400_000, step: 86_400 },
};

/** One metric stream: which runtime it belongs to, and its datapoints (one value per step, oldest first). */
export interface Series { metric: string; resource: string; name: string; points: Array<{ t: number; v: number }> }

export interface RuntimeRow {
  name: string;
  vcpuHours: number;
  gbHours: number;
  invocations: number;
  errors: number;
  throttles: number;
  sessions: number;
  estCostUsd: number;
  /** Share of the estimated cost that is memory: a high share means sessions sit idle holding memory. */
  memoryShare: number;
}

export interface Snapshot {
  available: true;
  period: string;
  generatedAt: string;
  rates: { vcpuHour: number; gbHour: number };
  activeSessions: number | null;
  totals: { vcpuHours: number; gbHours: number; invocations: number; errors: number; throttles: number; sessions: number; estCostUsd: number };
  runtimes: RuntimeRow[];
  /** Estimated cost per step across every runtime, for the chart. */
  timeline: Array<{ t: string; estCostUsd: number; vcpuHours: number; gbHours: number }>;
}

/** `agentPortalJobRunner::DEFAULT` -> `agentPortalJobRunner`; a resource ARN falls back to its runtime id. */
export function runtimeName(name: string, resource: string): string {
  const n = (name || '').split('::')[0];
  if (n) return n;
  const id = resource.split('/').pop() || resource;
  return id.replace(/-[A-Za-z0-9]{10}$/, '');
}

const sumPoints = (s: Series): number => s.points.reduce((a, p) => a + (Number.isFinite(p.v) ? p.v : 0), 0);

export function buildSnapshot(period: string, series: Series[], activeSessions: number | null, now = new Date()): Snapshot {
  const rows = new Map<string, RuntimeRow>();
  const row = (name: string): RuntimeRow => {
    let r = rows.get(name);
    if (!r) {
      r = { name, vcpuHours: 0, gbHours: 0, invocations: 0, errors: 0, throttles: 0, sessions: 0, estCostUsd: 0, memoryShare: 0 };
      rows.set(name, r);
    }
    return r;
  };
  const byTime = new Map<number, { vcpuHours: number; gbHours: number }>();
  const bucket = (t: number) => {
    let b = byTime.get(t);
    if (!b) { b = { vcpuHours: 0, gbHours: 0 }; byTime.set(t, b); }
    return b;
  };

  for (const s of series) {
    const r = row(runtimeName(s.name, s.resource));
    const total = sumPoints(s);
    if (s.metric === 'CPUUsed-vCPUHours') { r.vcpuHours += total; for (const p of s.points) bucket(p.t).vcpuHours += p.v; }
    else if (s.metric === 'MemoryUsed-GBHours') { r.gbHours += total; for (const p of s.points) bucket(p.t).gbHours += p.v; }
    else if (s.metric === 'Invocations') r.invocations += total;
    else if (s.metric === 'Errors' || s.metric === 'SystemErrors') r.errors += total;
    else if (s.metric === 'Throttles') r.throttles += total;
    else if (s.metric === 'Sessions') r.sessions += total;
  }

  const totals = { vcpuHours: 0, gbHours: 0, invocations: 0, errors: 0, throttles: 0, sessions: 0, estCostUsd: 0 };
  const runtimes = [...rows.values()].map((r) => {
    const cpuCost = r.vcpuHours * RATE_VCPU_HOUR;
    const memCost = r.gbHours * RATE_GB_HOUR;
    const estCostUsd = cpuCost + memCost;
    totals.vcpuHours += r.vcpuHours; totals.gbHours += r.gbHours; totals.invocations += r.invocations;
    totals.errors += r.errors; totals.throttles += r.throttles; totals.sessions += r.sessions; totals.estCostUsd += estCostUsd;
    return { ...r, estCostUsd, memoryShare: estCostUsd > 0 ? memCost / estCostUsd : 0 };
  }).filter((r) => r.vcpuHours || r.gbHours || r.invocations || r.sessions || r.errors || r.throttles)
    .sort((a, b) => b.estCostUsd - a.estCostUsd);

  const timeline = [...byTime.entries()].sort(([a], [b]) => a - b).map(([t, b]) => ({
    t: new Date(t).toISOString(),
    vcpuHours: b.vcpuHours,
    gbHours: b.gbHours,
    estCostUsd: b.vcpuHours * RATE_VCPU_HOUR + b.gbHours * RATE_GB_HOUR,
  }));

  return {
    available: true,
    period,
    generatedAt: now.toISOString(),
    rates: { vcpuHour: RATE_VCPU_HOUR, gbHour: RATE_GB_HOUR },
    activeSessions,
    totals,
    runtimes,
    timeline,
  };
}

// ── CloudWatch ────────────────────────────────────────────────────────────────

const METRICS = ['CPUUsed-vCPUHours', 'MemoryUsed-GBHours', 'Invocations', 'Errors', 'SystemErrors', 'Throttles', 'Sessions'];
/** CloudWatch allows 500 queries in one GetMetricData call. */
const MAX_QUERIES = 450;

type CwClient = {
  send(cmd: unknown): Promise<any>;
};

async function loadClient(): Promise<{ client: CwClient; sdk: typeof import('@aws-sdk/client-cloudwatch') }> {
  const sdk = await import('@aws-sdk/client-cloudwatch');
  return { client: new sdk.CloudWatchClient({ region: process.env.AWS_REGION || 'ap-southeast-1' }), sdk };
}

/** Every metric that is reported per runtime (it has a Resource dimension), found with ListMetrics. */
async function listRuntimeMetrics(client: CwClient, sdk: typeof import('@aws-sdk/client-cloudwatch')) {
  const found: Array<{ metric: string; dims: Array<{ Name: string; Value: string }>; resource: string; name: string }> = [];
  for (const metric of METRICS) {
    let token: string | undefined;
    do {
      const out = await client.send(new sdk.ListMetricsCommand({ Namespace: NAMESPACE, MetricName: metric, NextToken: token }));
      for (const m of out.Metrics ?? []) {
        const dims: Array<{ Name: string; Value: string }> = m.Dimensions ?? [];
        const resource = dims.find((d) => d.Name === 'Resource')?.Value;
        if (!resource || !resource.includes(':runtime/')) continue;
        // The same figure is also published with fewer dimensions (no Name) and with an extra ComputeType one; counting
        // those too would add every number up two or three times, so only the Resource+Name (+Operation/Service) set is read.
        const name = dims.find((d) => d.Name === 'Name')?.Value;
        if (!name || dims.some((d) => d.Name === 'ComputeType')) continue;
        found.push({ metric, dims, resource, name });
      }
      token = out.NextToken;
    } while (token);
  }
  return found;
}

let listCache: { at: number; value: Awaited<ReturnType<typeof listRuntimeMetrics>> } | null = null;

export async function collectMetrics(period: string, now = new Date()): Promise<Snapshot> {
  const spec = PERIODS[period];
  const { client, sdk } = await loadClient();
  if (!listCache || Date.now() - listCache.at > 5 * 60_000) listCache = { at: Date.now(), value: await listRuntimeMetrics(client, sdk) };
  // A runtime recreated long ago can still be listed; the cap keeps the query count inside the API limit.
  const listed = listCache.value.slice(0, MAX_QUERIES);

  const start = new Date(now.getTime() - spec.ms);
  const queries = listed.map((m, i) => ({
    Id: `m${i}`,
    MetricStat: { Metric: { Namespace: NAMESPACE, MetricName: m.metric, Dimensions: m.dims }, Period: spec.step, Stat: 'Sum' },
    ReturnData: true,
  }));
  const series: Series[] = [];
  const results: any[] = [];
  let token: string | undefined;
  do {
    const out = await client.send(new sdk.GetMetricDataCommand({
      MetricDataQueries: queries, StartTime: start, EndTime: now, ScanBy: 'TimestampAscending', NextToken: token,
    }));
    results.push(...(out.MetricDataResults ?? []));
    token = out.NextToken;
  } while (token);
  const merged = new Map<string, { t: number; v: number }[]>();
  for (const r of results) {
    const pts = merged.get(r.Id) ?? [];
    (r.Timestamps ?? []).forEach((t: Date, i: number) => pts.push({ t: new Date(t).getTime(), v: Number(r.Values?.[i] ?? 0) }));
    merged.set(r.Id, pts);
  }
  listed.forEach((m, i) => series.push({ metric: m.metric, resource: m.resource, name: m.name, points: merged.get(`m${i}`) ?? [] }));

  // Sessions running right now (reported for the whole service, no runtime dimension).
  let active: number | null = null;
  try {
    const out = await client.send(new sdk.GetMetricDataCommand({
      MetricDataQueries: [{
        Id: 'active',
        MetricStat: { Metric: { Namespace: NAMESPACE, MetricName: 'ActiveSessionCount', Dimensions: [{ Name: 'Service', Value: 'AgentCore.Runtime' }] }, Period: 60, Stat: 'Maximum' },
      }],
      StartTime: new Date(now.getTime() - 15 * 60_000), EndTime: now, ScanBy: 'TimestampDescending',
    }));
    const v = out.MetricDataResults?.[0]?.Values;
    active = v && v.length ? Number(v[0]) : 0;
  } catch { active = null; }

  return buildSnapshot(period, series, active, now);
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function registerAgentCoreRoutes(): void {
  router.get(
    '/api/agentcore/metrics',
    requireAuth(async (req: PortalRequest, res: PortalResponse) => {
      if (!req.user?.is_admin) { sendJson(res, 403, { error: 'Admins only' }); return; }
      const period = req.query.get('period') || '7d';
      if (!PERIODS[period]) { sendJson(res, 400, { error: 'period must be 24h, 7d or 30d' }); return; }
      try {
        sendJson(res, 200, await collectMetrics(period));
      } catch (e) {
        // No AWS credentials (a local run) or no CloudWatch permission: the page says so instead of failing.
        console.error('[agentcore] could not read CloudWatch:', e);
        sendJson(res, 200, { available: false, reason: e instanceof Error ? e.message : 'CloudWatch could not be read' });
      }
    }),
  );
}
