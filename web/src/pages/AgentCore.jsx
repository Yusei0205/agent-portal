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

const scoreText = (s) => (s.value === null || s.value === undefined ? '–' : `${Math.round(s.value * 100)}%`);

/** Quality scores from AgentCore Evaluations: score the latest sessions on demand, or a share of finished ones automatically. */
function QualityPanel() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState('0');
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/api/agentcore/evals');
      setCfg(r);
      setPct(String(r.samplePercent));
      setError(null);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const scoreLatest = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post('/api/agentcore/evals', { recent: 5 });
      setMsg(`Scored ${r.evaluations.length} session${r.evaluations.length === 1 ? '' : 's'}`);
      await load();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const savePct = async () => {
    setBusy(true); setMsg(null);
    try { await api.put('/api/agentcore/evals', { samplePercent: Number(pct) }); setMsg('Saved'); await load(); } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const pctValid = /^\d+$/.test(pct.trim()) && Number(pct) <= 100;

  return (
    <section className="us-panel" aria-label="Session quality">
      <div className="us-panel-head"><strong>Session quality</strong><span className="muted">scored by AgentCore Evaluations</span></div>
      <p className="muted us-lead">
        Each session is scored on goal success, tool choice, tool parameters and helpfulness, from its saved transcript. Scoring costs a few cents
        per session, so automatic scoring is off until you set a share of finished sessions.
      </p>
      {error && <p className="error-note" role="alert">{error}</p>}
      <div className="us-controls" role="group" aria-label="Scoring controls">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={scoreLatest}>Score latest 5 sessions</button>
        <label className="muted" htmlFor="eval-sample">Automatically score</label>
        <input id="eval-sample" type="text" inputMode="numeric" value={pct} aria-invalid={!pctValid} style={{ width: 60, textAlign: 'right' }} onChange={(e) => { setPct(e.target.value); setMsg(null); }} />
        <span className="muted">% of finished sessions</span>
        <button type="button" className="btn btn-sm" disabled={busy || !pctValid || (cfg && String(cfg.samplePercent) === pct.trim())} onClick={savePct}>Save</button>
        {msg && <span className="muted" role="status">{msg}</span>}
      </div>
      {cfg && cfg.evaluations.length === 0 && <p className="muted us-empty">No session has been scored yet.</p>}
      {cfg && cfg.evaluations.length > 0 && (
        <div className="table-wrap">
          <table className="data-table us-table" aria-label="Scored sessions">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Runner</th>
                {cfg.evaluators.map((e) => <th key={e} scope="col" className="us-num">{e.replace(/([a-z])([A-Z])/g, '$1 $2')}</th>)}
                <th scope="col" className="us-num">Turns</th>
                <th scope="col" className="us-num">Tool calls</th>
                <th scope="col">Scored</th>
              </tr>
            </thead>
            <tbody>
              {cfg.evaluations.map((r) => (
                <tr key={r.workflowId}>
                  <td className="us-name" title={r.title}>{r.title || r.workflowId}</td>
                  <td>{r.engine}</td>
                  {cfg.evaluators.map((name) => {
                    const s = r.scores.find((x) => x.evaluator === name);
                    return <td key={name} className="us-num" title={s?.explanation || s?.error || undefined}>{s ? `${scoreText(s)}${s.label ? ` ${s.label}` : ''}` : '–'}</td>;
                  })}
                  <td className="us-num">{r.turns}</td>
                  <td className="us-num">{r.toolCalls}</td>
                  <td className="muted">{new Date(r.at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** One runner: blank means the platform timeout; a number stops its idle sessions after that many minutes. */
function IdleRow({ row, platformMinutes, maxMinutes, onSaved }) {
  const [value, setValue] = useState(row.minutes === null ? '' : String(row.minutes));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const saved = row.minutes === null ? '' : String(row.minutes);
  const trimmed = value.trim();
  const valid = trimmed === '' || (/^\d+$/.test(trimmed) && Number(trimmed) <= maxMinutes);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.put('/api/agentcore/idle', { engine: row.engine, minutes: trimmed === '' ? null : Number(trimmed) });
      setMsg('Saved');
      onSaved();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td className="us-name">{row.label}</td>
      <td className="us-num">
        <input
          type="text" inputMode="numeric" value={value} placeholder="Default" style={{ width: 90, textAlign: 'right' }}
          aria-label={`${row.label} idle minutes`} aria-invalid={!valid} onChange={(e) => { setValue(e.target.value); setMsg(null); }}
        />
      </td>
      <td className="muted">{trimmed === '' ? `Platform timeout (${platformMinutes} min)` : Number(trimmed) === 0 ? 'Stopped as soon as a turn ends' : `Stopped after ${trimmed} min idle`}</td>
      <td className="us-num">
        <button type="button" className="btn btn-sm" disabled={busy || !valid || value === saved} onClick={save} aria-label={`Save ${row.label} idle time`}>Save</button>
        {msg && <span className="muted" role="status" style={{ marginLeft: 8 }}>{msg}</span>}
      </td>
    </tr>
  );
}

/** Idle time for each runner's sessions. A session that is stopped starts again on the next message, from its saved workspace. */
function IdleSettings() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try { setCfg(await api.get('/api/agentcore/idle')); setError(null); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <section className="us-panel" aria-label="Idle time per runner">
      <div className="us-panel-head"><strong>Idle time per runner</strong><span className="muted">stops sessions sooner, never later</span></div>
      <p className="muted us-lead">
        An idle session holds memory until AgentCore times it out. Set how many minutes after a turn ends the portal should stop it.
        Blank keeps the platform timeout, 0 stops it as soon as the turn ends. The next message starts it again from the saved workspace;
        a running terminal or installed tools in that session are lost.
      </p>
      {error && <p className="error-note" role="alert">{error}</p>}
      {cfg && (
        <div className="table-wrap">
          <table className="data-table us-table" aria-label="Idle minutes by runner">
            <thead><tr><th scope="col">Runner</th><th scope="col" className="us-num">Idle minutes</th><th scope="col">Effect</th><th scope="col" /></tr></thead>
            <tbody>
              {cfg.engines.map((r) => <IdleRow key={`${r.engine}:${r.minutes}`} row={r} platformMinutes={cfg.platformMinutes} maxMinutes={cfg.maxMinutes} onSaved={load} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
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

      <QualityPanel />

      <IdleSettings />
    </div>
  );
}
