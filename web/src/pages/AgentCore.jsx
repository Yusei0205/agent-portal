/**
 * AgentCore page (admin): what the AgentCore runtimes used, live from CloudWatch. Data: GET /api/agentcore/metrics.
 *
 * Sessions bill for the CPU and memory they use, so the cards lead with vCPU-hours and GB-hours, then an estimated cost. The cost is
 * an estimate from published rates, not the invoice. The page refreshes itself every 30 seconds.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';

const PERIODS = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];
const REFRESH_MS = 30_000;

export const fmtUsd = (n) => `$${Number(n || 0).toFixed(2)}`;
export const fmtNum = (n, d = 1) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: d });
export const fmtPct = (n) => `${Math.round(Number(n || 0) * 100)}%`;

/** Plain-language hints from the numbers: where the money goes and what to look at first. */
export function hints(data) {
  const out = [];
  const t = data?.totals;
  if (!t || t.estCostUsd <= 0) return out;
  const memCost = t.gbHours * data.rates.gbHour;
  const memShare = memCost / t.estCostUsd;
  if (memShare >= 0.8) {
    out.push(`${fmtPct(memShare)} of the estimated cost is memory held by sessions (${fmtNum(t.gbHours, 0)} GB-hours for ${fmtNum(t.vcpuHours)} vCPU-hours). Sessions are mostly idle: shorten the idle timeout and stop sessions when a run ends.`);
  }
  const top = data.runtimes[0];
  if (top && data.runtimes.length > 1 && top.estCostUsd / t.estCostUsd >= 0.5) {
    out.push(`${top.name} is ${fmtPct(top.estCostUsd / t.estCostUsd)} of the estimated cost. Start there.`);
  }
  if (t.throttles > 0) out.push(`${fmtNum(t.throttles, 0)} throttled call${t.throttles === 1 ? '' : 's'}: AgentCore refused some work.`);
  if (t.errors > 0) out.push(`${fmtNum(t.errors, 0)} error${t.errors === 1 ? '' : 's'} reported by the runtimes.`);
  return out;
}

function Bars({ points, metric, label }) {
  const values = points.map((p) => Number(p[metric] || 0));
  const max = Math.max(...values, 0);
  const W = 100 / Math.max(values.length, 1);
  return (
    <svg className="us-bars" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={label}>
      {values.map((v, i) => {
        const h = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * 30) : 0;
        return (
          <rect key={points[i].t} x={i * W + W * 0.12} width={W * 0.76} y={32 - h} height={h} rx="0.6" fill="var(--accent)" opacity={v > 0 ? 0.9 : 0.15}>
            <title>{`${new Date(points[i].t).toLocaleString()}: ${fmtUsd(v)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function Card({ title, value, sub, tone }) {
  return (
    <article className="us-engine" aria-label={title} style={tone ? { '--engine': tone } : undefined}>
      <header className="us-engine-head">
        <span className="us-dot" aria-hidden="true" />
        <span className="us-engine-name">{title}</span>
      </header>
      <div className="us-engine-value">{value}</div>
      <div className="muted us-engine-sub">{sub}</div>
    </article>
  );
}

export function AgentCore() {
  const [period, setPeriod] = useState('7d');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get(`/api/agentcore/metrics?period=${period}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const ok = data?.available === true;
  const t = data?.totals;
  const tips = ok ? hints(data) : [];

  return (
    <div className="page wide us-root" aria-label="AgentCore">
      <header className="us-header">
        <div>
          <h1 className="us-h1">AgentCore</h1>
          <p className="muted us-lead">
            What the AgentCore runtimes used, read live from CloudWatch. Cost is an estimate from published rates, not the invoice.
          </p>
        </div>
        <div className="us-controls" role="group" aria-label="AgentCore controls">
          <div className="us-segment" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.value} type="button" className={`us-seg${period === p.value ? ' is-active' : ''}`} aria-pressed={period === p.value} onClick={() => setPeriod(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-sm" onClick={load} disabled={loading} aria-label="Refresh AgentCore">
            <Icon name="refresh" size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      {error && (
        <p className="error-note" role="alert">
          {error} — <button type="button" className="btn-link" onClick={load}>Retry</button>
        </p>
      )}
      {!data && loading && <div className="skeleton" style={{ height: 140 }} />}
      {data && !ok && <p className="muted us-none" role="status">AgentCore metrics are not available here: {data.reason}</p>}

      {ok && (
        <>
          <div className="us-engines" role="group" aria-label="AgentCore totals">
            <Card title="Active sessions" value={data.activeSessions ?? '–'} sub="Running now" tone="var(--ok)" />
            <Card title="Estimated cost" value={fmtUsd(t.estCostUsd)} sub={`${PERIODS.find((p) => p.value === period)?.label}, CPU + memory`} />
            <Card title="Memory" value={`${fmtNum(t.gbHours, 0)} GB-h`} sub={`${fmtUsd(t.gbHours * data.rates.gbHour)} at ${fmtUsd(data.rates.gbHour)}/GB-h`} tone="var(--info)" />
            <Card title="CPU" value={`${fmtNum(t.vcpuHours)} vCPU-h`} sub={`${fmtUsd(t.vcpuHours * data.rates.vcpuHour)} at ${fmtUsd(data.rates.vcpuHour)}/vCPU-h`} tone="var(--accent)" />
          </div>

          {tips.length > 0 && (
            <section className="us-panel" aria-label="What to look at">
              <ul className="us-hints">{tips.map((h) => <li key={h}>{h}</li>)}</ul>
            </section>
          )}

          <section className="us-panel" aria-label="Estimated cost over time">
            <div className="us-panel-head"><strong>Estimated cost over time</strong><span className="muted">{period === '24h' ? 'per hour' : 'per day'}</span></div>
            <Bars points={data.timeline} metric="estCostUsd" label={`Estimated cost per ${period === '24h' ? 'hour' : 'day'}`} />
          </section>

          <section className="us-panel" aria-label="AgentCore runtimes">
            {data.runtimes.length === 0 ? (
              <p className="muted us-empty">No runtime reported any usage in this period.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table us-table" aria-label="Usage by runtime">
                  <thead>
                    <tr>
                      <th scope="col">Runtime</th>
                      <th scope="col" className="us-num">Est. cost</th>
                      <th scope="col" className="us-num">Memory share</th>
                      <th scope="col" className="us-num">GB-hours</th>
                      <th scope="col" className="us-num">vCPU-hours</th>
                      <th scope="col" className="us-num">Sessions</th>
                      <th scope="col" className="us-num">Invocations</th>
                      <th scope="col" className="us-num">Errors</th>
                      <th scope="col" className="us-num">Throttles</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runtimes.map((r) => (
                      <tr key={r.name}>
                        <td className="us-name">{r.name}</td>
                        <td className="us-num">{fmtUsd(r.estCostUsd)}</td>
                        <td className="us-num">{fmtPct(r.memoryShare)}</td>
                        <td className="us-num">{fmtNum(r.gbHours, 0)}</td>
                        <td className="us-num">{fmtNum(r.vcpuHours, 2)}</td>
                        <td className="us-num">{fmtNum(r.sessions, 0)}</td>
                        <td className="us-num">{fmtNum(r.invocations, 0)}</td>
                        <td className="us-num">{fmtNum(r.errors, 0)}</td>
                        <td className="us-num">{fmtNum(r.throttles, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="muted us-lead">Updated {new Date(data.generatedAt).toLocaleTimeString()}. Refreshes every 30 seconds.</p>
        </>
      )}
    </div>
  );
}
