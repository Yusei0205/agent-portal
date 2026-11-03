/**
 * Cost panel for the Dashboard — total cost, daily cost trend, cost by project
 * and (admins) cost by user. Takes the Dashboard's period and project filter.
 * Data comes from GET /api/insights.
 */

import { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  BarChart, Bar,
} from 'recharts';
import { api } from '../lib/api.js';
import { Icon } from './Icon.jsx';

function fmtCost(n) {
  if (!n) return '$0.00';
  return `$${Number(n).toFixed(2)}`;
}

function fmtTokens(n) {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function CostPanel({ period, projectId, user, refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const qs = new URLSearchParams({ period });
    if (projectId) qs.set('projectId', projectId);
    api.get(`/api/insights?${qs}`)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [period, projectId, refreshKey]);

  // Read theme colour at render time so the charts follow light/dark
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0e7a7e';

  if (error) {
    return (
      <section className="panel db-cost" aria-label="Cost" style={{ marginBottom: 16 }}>
        <h2 className="db-panel-title"><Icon name="chart" size={16} aria-hidden="true" />Cost</h2>
        <p className="error-note" role="alert">{error}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel db-cost" aria-label="Cost" style={{ marginBottom: 16 }}>
        <div className="skeleton" style={{ height: 180 }} />
      </section>
    );
  }

  const showByProject = !projectId && data.costByProject?.length > 1;
  const showByUser = user?.is_admin && data.costByUser?.length > 0;

  return (
    <section className="panel db-cost" aria-label="Cost" style={{ marginBottom: 16 }}>
      <h2 className="db-panel-title">
        <Icon name="chart" size={16} aria-hidden="true" />
        Cost
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: '0.8rem' }}>
          {fmtCost(data.totalCost)} total · {fmtTokens(data.totalTokens)} tokens · {data.totalRuns} runs
        </span>
      </h2>

      {data.totalRuns === 0 && data.totalCost === 0 ? (
        <p className="muted" style={{ padding: '12px 0' }}>No cost in this period yet.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
          {data.dailyCosts?.length > 0 && (
            <div>
              <h3 style={{ fontSize: '0.85rem', margin: '0 0 .5rem' }}>Daily cost (USD)</h3>
              <ResponsiveContainer width="100%" height={170}>
                <LineChart data={data.dailyCosts} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(2)}`} width={55} />
                  <Tooltip formatter={(v) => [`$${Number(v).toFixed(4)}`, 'Cost']} />
                  <Line type="monotone" dataKey="cost" stroke={accent} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {showByProject && (
            <div>
              <h3 style={{ fontSize: '0.85rem', margin: '0 0 .5rem' }}>Cost by project</h3>
              <ResponsiveContainer width="100%" height={Math.max(120, data.costByProject.length * 32)}>
                <BarChart layout="vertical" data={data.costByProject} margin={{ left: 0, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
                  <Tooltip formatter={(v) => [`$${Number(v).toFixed(4)}`, 'Cost']} />
                  <Bar dataKey="cost" fill={accent} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {showByUser && (
            <div>
              <h3 style={{ fontSize: '0.85rem', margin: '0 0 .5rem' }}>Cost by user</h3>
              <div className="table-wrap">
                <table className="data-table" style={{ width: '100%' }} aria-label="Cost by user">
                  <thead>
                    <tr>
                      <th scope="col">User</th>
                      <th scope="col" style={{ textAlign: 'right' }}>Cost (USD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.costByUser.map((u) => (
                      <tr key={u.userId}>
                        <td>{u.name || u.userId}</td>
                        <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtCost(u.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default CostPanel;
