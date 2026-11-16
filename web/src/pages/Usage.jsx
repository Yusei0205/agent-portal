/**
 * Usage page — what the agents used, by person, project and day.
 *
 * Claude is priced in dollars and Kiro in credits, so the two are shown side by side and never added together. Codex runs report
 * tokens only. "Runs" are the runs that reported usage. Data: GET /api/usage.
 */

import { useState, useEffect, useCallback } from 'react';
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

function UsageTable({ title, note, firstColumn, rows, empty }) {
  return (
    <section className="us-section" aria-label={title}>
      <h2 className="us-h2">
        {title}
        {note && <span className="muted us-note"> {note}</span>}
      </h2>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table us-table" aria-label={title}>
            <thead>
              <tr>
                <th scope="col">{firstColumn}</th>
                <th scope="col" className="us-num">Runs</th>
                <th scope="col" className="us-num">Cost (Claude)</th>
                <th scope="col" className="us-num">Credits (Kiro)</th>
                <th scope="col" className="us-num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id || r.name} className={r.runs === 0 ? 'us-quiet' : undefined}>
                  <td>{r.name}</td>
                  <td className="us-num">{r.runs}</td>
                  <td className="us-num">{fmtUsd(r.costUsd)}</td>
                  <td className="us-num">{fmtCredits(r.credits)}</td>
                  <td className="us-num">{fmtTok(r.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Usage({ projects }) {
  const [period, setPeriod] = useState('30d');
  const [projectFilter, setProjectFilter] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

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

  const totals = data?.totals ?? { runs: 0, costUsd: 0, credits: 0, tokens: 0 };
  const nothingReported = data && totals.runs === 0 && totals.costUsd === 0 && totals.credits === 0 && totals.tokens === 0;

  return (
    <div className="page wide us-root" aria-label="Usage">
      <header className="us-header">
        <div>
          <h1 className="us-h1">Usage</h1>
          <p className="muted us-lead">
            What the agents used, by person, project and day. Claude is priced in dollars and Kiro in credits, so the two are shown
            side by side and never added together.
          </p>
        </div>
        <div className="us-controls" role="group" aria-label="Usage controls">
          <label className="us-control">
            <span className="muted">Last</span>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" style={{ width: 'auto' }}>
              {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
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

      {!data && loading && <div className="skeleton" style={{ height: 120 }} />}

      {data && (
        <>
          <div className="us-kpis" role="group" aria-label="Totals">
            <div className="us-kpi"><span className="muted">Runs</span><strong>{totals.runs}</strong></div>
            <div className="us-kpi"><span className="muted">Claude cost</span><strong>{fmtUsd(totals.costUsd)}</strong></div>
            <div className="us-kpi"><span className="muted">Kiro credits</span><strong>{fmtCredits(totals.credits)}</strong></div>
            <div className="us-kpi"><span className="muted">Tokens</span><strong>{fmtTok(totals.tokens)}</strong></div>
          </div>

          {nothingReported && (
            <p className="muted us-none" role="status">
              {data.finishedRuns > 0
                ? `${data.finishedRuns} run${data.finishedRuns === 1 ? '' : 's'} finished in this period, but none reported any usage, so there is nothing to total. Runs that finished before usage was being recorded have none on file.`
                : 'No runs in this period yet.'}
            </p>
          )}

          {data.byUser && (
            <UsageTable
              title="By person"
              note={data.byUserAllProjects ? '(all projects: per-person totals are not kept per project)' : undefined}
              firstColumn="Person"
              rows={data.byUser}
              empty="No usage by any person in this period."
            />
          )}
          <UsageTable title="By project" firstColumn="Project" rows={data.byProject} empty="No usage in any project in this period." />
          <UsageTable
            title="By day"
            note="(UTC days)"
            firstColumn="Day"
            rows={[...data.byDay].reverse()}
            empty="No usage in this period."
          />
        </>
      )}
    </div>
  );
}

export default Usage;
