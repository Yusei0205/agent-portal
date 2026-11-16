/**
 * Usage page — what the agents used.
 *
 * Every engine is priced in its own unit, so each gets its own card and its own column, and the units are never added together:
 * Claude in dollars, Kiro in credits, Codex in tokens (it reports no dollars). Under the cards, one breakdown panel shows people,
 * projects or days, ranked by whichever engine you choose. "Runs" are the runs that reported usage. Data: GET /api/usage.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';

const PERIODS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

export function fmtUsd(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

export function fmtCredits(n) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtTok(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(Math.round(v));
}

/** The engines, each with the one figure it is measured in. */
export const ENGINES = [
  { key: 'claude', label: 'Claude', unit: 'dollars', metric: 'costUsd', fmt: fmtUsd, color: 'var(--accent)' },
  { key: 'kiro', label: 'Kiro', unit: 'credits', metric: 'credits', fmt: fmtCredits, color: 'var(--info)' },
  { key: 'codex', label: 'Codex', unit: 'tokens', metric: 'tokens', fmt: fmtTok, color: 'var(--ok)' },
  { key: 'other', label: 'Other', unit: 'tokens', metric: 'tokens', fmt: fmtTok, color: 'var(--ink-3)' },
];

const engineOf = (row, e) => row?.engines?.[e.key] ?? { runs: 0, costUsd: 0, credits: 0, tokens: 0 };

/** A little bar chart of one engine's figure for each day of the window (bars scaled to that engine's busiest day). */
function DayBars({ days, engine }) {
  const values = days.map((d) => Number(engineOf(d, engine)[engine.metric] || 0));
  const max = Math.max(...values, 0);
  const W = 100 / Math.max(values.length, 1);
  return (
    <svg className="us-bars" viewBox="0 0 100 32" preserveAspectRatio="none" role="img"
      aria-label={`${engine.label} ${engine.unit} per day, last ${days.length} days`}>
      {values.map((v, i) => {
        const h = max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * 30) : 0;
        return (
          <rect key={days[i].id} x={i * W + W * 0.12} width={W * 0.76} y={32 - h} height={h} rx="0.6" fill={engine.color} opacity={v > 0 ? 0.9 : 0.15}>
            <title>{`${days[i].id}: ${engine.fmt(v)}`}</title>
          </rect>
        );
      })}
      {max === 0 && <line x1="0" x2="100" y1="31.5" y2="31.5" stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function EngineCard({ engine, totals, days }) {
  const t = totals ?? { runs: 0, costUsd: 0, credits: 0, tokens: 0 };
  const quiet = t.runs === 0;
  return (
    <article className={`us-engine${quiet ? ' is-quiet' : ''}`} aria-label={`${engine.label} usage`} style={{ '--engine': engine.color }}>
      <header className="us-engine-head">
        <span className="us-dot" aria-hidden="true" />
        <span className="us-engine-name">{engine.label}</span>
        <span className="muted us-engine-unit">{engine.unit}</span>
      </header>
      <div className="us-engine-value">{engine.fmt(t[engine.metric])}</div>
      <div className="muted us-engine-sub">
        {quiet
          ? 'No usage in this period'
          : `${t.runs} run${t.runs === 1 ? '' : 's'}${engine.key === 'claude' && t.tokens ? ` · ${fmtTok(t.tokens)} tokens` : ''}`}
      </div>
      <DayBars days={days} engine={engine} />
    </article>
  );
}

/** One cell of the breakdown: the engine's figure, a dash when it has none, and (for the ranked engine) its share as a bar. */
function Cell({ row, engine, rankedBy, total }) {
  const t = engineOf(row, engine);
  const v = Number(t[engine.metric] || 0);
  const showBar = rankedBy === engine.key && total > 0 && v > 0;
  return (
    <td className="us-num" title={v ? `${t.runs} run${t.runs === 1 ? '' : 's'} · ${fmtTok(t.tokens)} tokens` : undefined}>
      {showBar && <span className="us-share" style={{ width: `${Math.max(2, Math.round((v / total) * 100))}%` }} aria-hidden="true" />}
      <span className="us-cell-value">{v ? engine.fmt(v) : <span className="us-none-mark" aria-label="none">–</span>}</span>
    </td>
  );
}

function Breakdown({ tabs, rankedBy, setRankedBy, activeTab, setActiveTab, shownEngines }) {
  const tab = tabs.find((t) => t.id === activeTab) ?? tabs[0];
  const ranked = ENGINES.find((e) => e.key === rankedBy) ?? ENGINES[0];
  const rows = useMemo(() => {
    if (tab.id === 'days') return [...tab.rows].reverse();
    return [...tab.rows].sort((a, b) => Number(engineOf(b, ranked)[ranked.metric]) - Number(engineOf(a, ranked)[ranked.metric]) || b.runs - a.runs);
  }, [tab, ranked]);
  const total = rows.reduce((s, r) => s + Number(engineOf(r, ranked)[ranked.metric] || 0), 0);

  return (
    <section className="us-panel" aria-label="Usage breakdown">
      <div className="us-panel-head">
        <div role="tablist" aria-label="Break usage down by" className="us-tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" id={`us-tab-${t.id}`} aria-selected={t.id === tab.id} aria-controls="us-tabpanel"
              className={`us-tab${t.id === tab.id ? ' is-active' : ''}`} onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {tab.id !== 'days' && (
          <div className="us-rank" role="group" aria-label="Rank by">
            <span className="muted">Rank by</span>
            {shownEngines.map((e) => (
              <button key={e.key} type="button" className={`us-chip${e.key === ranked.key ? ' is-active' : ''}`} aria-pressed={e.key === ranked.key} onClick={() => setRankedBy(e.key)}>
                {e.label} <span className="muted">{e.unit}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div id="us-tabpanel" role="tabpanel" aria-labelledby={`us-tab-${tab.id}`}>
        {rows.length === 0 ? (
          <p className="muted us-empty">{tab.empty}</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table us-table" aria-label={tab.title}>
              <thead>
                <tr>
                  <th scope="col">{tab.first}</th>
                  <th scope="col" className="us-num">Runs</th>
                  {shownEngines.map((e) => <th key={e.key} scope="col" className="us-num">{e.label} <span className="us-th-unit">{e.unit}</span></th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id || r.name} className={r.runs === 0 ? 'us-quiet' : undefined}>
                    <td className="us-name">{r.name}</td>
                    <td className="us-num">{r.runs}</td>
                    {shownEngines.map((e) => <Cell key={e.key} row={r} engine={e} rankedBy={tab.id === 'days' ? null : ranked.key} total={total} />)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

export function Usage({ projects }) {
  const [period, setPeriod] = useState('30d');
  const [projectFilter, setProjectFilter] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(null);
  const [rankedBy, setRankedBy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ period });
      if (projectFilter) qs.set('projectId', projectFilter);
      setData(await api.get(`/api/usage?${qs}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [period, projectFilter]);

  useEffect(() => { load(); }, [load]);

  const totals = data?.totals;
  const nothingReported = Boolean(data) && (totals?.runs ?? 0) === 0;
  // Claude, Kiro and Codex always have a card; "Other" only when something used it.
  const shown = ENGINES.filter((e) => e.key !== 'other' || (totals?.engines?.other?.runs ?? 0) > 0);
  const days = data?.byDay ?? [];

  const tabs = useMemo(() => {
    if (!data) return [];
    const list = [];
    if (data.byUser) list.push({ id: 'people', label: 'People', title: 'Usage by person', first: 'Person', rows: data.byUser, empty: 'No usage by any person in this period.' });
    list.push({ id: 'projects', label: 'Projects', title: 'Usage by project', first: 'Project', rows: data.byProject, empty: 'No usage in any project in this period.' });
    list.push({ id: 'days', label: 'Days', title: 'Usage by day (UTC)', first: 'Day (UTC)', rows: days, empty: 'No usage in this period.' });
    return list;
  }, [data, days]);

  // Rank by the engine with the most runs, until the person picks one.
  const defaultRank = useMemo(() => {
    const busiest = [...shown].sort((a, b) => (totals?.engines?.[b.key]?.runs ?? 0) - (totals?.engines?.[a.key]?.runs ?? 0))[0];
    return busiest?.key ?? 'claude';
  }, [shown, totals]);

  return (
    <div className="page wide us-root" aria-label="Usage">
      <header className="us-header">
        <div>
          <h1 className="us-h1">Usage</h1>
          <p className="muted us-lead">
            What the agents used. Each engine is measured in its own unit (Claude in dollars, Kiro in credits, Codex in tokens), so they are
            shown side by side and never added together.
          </p>
        </div>
        <div className="us-controls" role="group" aria-label="Usage controls">
          <div className="us-segment" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.value} type="button" className={`us-seg${period === p.value ? ' is-active' : ''}`} aria-pressed={period === p.value} onClick={() => setPeriod(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
          <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="Filter by project" style={{ width: 'auto' }}>
            <option value="">All projects</option>
            {(projects || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="button" className="btn btn-sm" onClick={load} disabled={loading} aria-label="Refresh usage">
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

      {data && (
        <>
          <div className="us-engines" role="group" aria-label="Usage by engine">
            {shown.map((e) => <EngineCard key={e.key} engine={e} totals={totals?.engines?.[e.key]} days={days} />)}
          </div>

          {nothingReported && (
            <p className="muted us-none" role="status">
              {data.finishedRuns > 0
                ? `${data.finishedRuns} run${data.finishedRuns === 1 ? '' : 's'} finished in this period, but none reported any usage, so there is nothing to total. Runs that finished before usage was being recorded have none on file.`
                : 'No runs in this period yet.'}
            </p>
          )}

          <Breakdown
            tabs={tabs}
            activeTab={activeTab ?? tabs[0]?.id}
            setActiveTab={setActiveTab}
            rankedBy={rankedBy ?? defaultRank}
            setRankedBy={setRankedBy}
            shownEngines={shown}
          />
        </>
      )}
    </div>
  );
}

export default Usage;
