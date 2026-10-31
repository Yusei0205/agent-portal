/**
 * Insights page — cost, runs, failure rate and activity.
 *
 * Shows portal-wide or project-scoped metrics with period selector.
 * Uses recharts for charts (already in dependencies).
 */

import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  BarChart, Bar, Cell, PieChart, Pie, Legend,
} from 'recharts';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(n) {
  if (!n) return '$0.00';
  return `$${Number(n).toFixed(2)}`;
}

function fmtPct(n) {
  if (n === undefined || n === null) return '—';
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function fmtMs(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// ── Stat tile ─────────────────────────────────────────────────────────────────

function Tile({ label, value, sub }) {
  return (
    <div className="stat-tile" style={{ padding: '1.25rem', background: 'var(--panel)', borderRadius: 8, border: '1px solid var(--line)' }}>
      <div style={{ fontSize: '.8rem', color: 'var(--ink-3)', marginBottom: '.25rem' }}>{label}</div>
      <div style={{ fontSize: '1.8rem', fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: '.8rem', color: 'var(--ink-3)', marginTop: '.25rem' }}>{sub}</div>}
    </div>
  );
}

// ── Status colours — read from CSS tokens at render time so they follow the theme ──
function getStatusColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  return {
    completed: v('--ok',       '#2c7a4e'),
    failed:    v('--danger',   '#b0281c'),
    running:   v('--info',     '#2f6fde'),
    queued:    v('--warn',     '#9a6512'),
    stopped:   v('--ink-3',    '#737e93'),
    waiting:   v('--accent-3', '#a855f7'),
  };
}

// ── Main component ────────────────────────────────────────────────────────────

export function Insights({ projectId, user }) {
  const [period, setPeriod] = useState('30d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Compute CSS-variable colours at render time so they track the active theme
  const STATUS_COLORS = getStatusColors();
  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0e7a7e';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = projectId
        ? `/api/projects/${projectId}/insights?period=${period}`
        : `/api/insights?period=${period}`;
      const r = await api.get(url);
      setData(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, period]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Insights</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '.5rem' }}>
          {['today', '7d', '30d'].map((p) => (
            <button
              key={p}
              type="button"
              className={`btn${period === p ? ' btn-primary' : ''}`}
              onClick={() => setPeriod(p)}
              style={{ minWidth: 60 }}
            >
              {p === 'today' ? 'Today' : p === '7d' ? '7 days' : '30 days'}
            </button>
          ))}
          <button type="button" className="btn" onClick={load} aria-label="Refresh">
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </div>

      {loading && <div className="spinner" aria-label="Loading insights…" />}
      {error && <p className="error-note" role="alert">{error}</p>}

      {data && !loading && (
        <>
          {/* ── Tiles ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            <Tile label="Total cost" value={fmtCost(data.totalCost)} />
            <Tile label="Total runs" value={fmt(data.totalRuns)} />
            <Tile label="Failure rate" value={fmtPct(data.failureRate)} />
            <Tile label="Avg duration" value={fmtMs(data.avgRunDuration)} />
          </div>

          {/* ── Daily cost chart ── */}
          {data.dailyCosts?.length > 0 && (
            <section style={{ marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '1rem', marginBottom: '.75rem' }}>Daily costs (USD)</h2>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={data.dailyCosts} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(2)}`} width={55} />
                  <Tooltip formatter={(v) => [`$${Number(v).toFixed(4)}`, 'Cost']} />
                  <Line type="monotone" dataKey="cost" stroke={accentColor} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </section>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
            {/* ── Cost by project ── */}
            {!projectId && data.costByProject?.length > 0 && (
              <section>
                <h2 style={{ fontSize: '1rem', marginBottom: '.75rem' }}>Cost by project</h2>
                <ResponsiveContainer width="100%" height={Math.max(120, data.costByProject.length * 32)}>
                  <BarChart layout="vertical" data={data.costByProject} margin={{ left: 0, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
                    <Tooltip formatter={(v) => [`$${Number(v).toFixed(4)}`, 'Cost']} />
                    <Bar dataKey="cost" fill={accentColor} />
                  </BarChart>
                </ResponsiveContainer>
              </section>
            )}

            {/* ── Run status breakdown ── */}
            {data.runsByStatus?.length > 0 && (
              <section>
                <h2 style={{ fontSize: '1rem', marginBottom: '.75rem' }}>Runs by status</h2>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={data.runsByStatus}
                      dataKey="count"
                      nameKey="status"
                      cx="50%"
                      cy="50%"
                      outerRadius={70}
                      label={({ status, count }) => `${status}: ${count}`}
                      labelLine={false}
                    >
                      {data.runsByStatus.map((entry) => (
                        <Cell
                          key={entry.status}
                          fill={STATUS_COLORS[entry.status] || '#6b7280'}
                        />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </section>
            )}
          </div>

          {/* ── Cost by user (admin only) ── */}
          {user?.is_admin && data.costByUser?.length > 0 && (
            <section style={{ marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '1rem', marginBottom: '.75rem' }}>Cost by user</h2>
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>User</th>
                    <th style={{ textAlign: 'right' }}>Cost (USD)</th>
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
            </section>
          )}

          {data.totalRuns === 0 && (
            <p className="muted" style={{ textAlign: 'center', padding: '2rem' }}>
              No runs in this period yet.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default Insights;
