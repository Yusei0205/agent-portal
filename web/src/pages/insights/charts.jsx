import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useState } from 'react';
import { cx, tokens } from '../../lib/util.js';
import { useSortable } from '../../lib/useSortable.js';
import { Empty } from '../../components/ui.jsx';
import { SortHeader } from '../../components/SortHeader.jsx';
import { fmtDuration } from './format.js';

export function DeltaChip({ pct }) {
  if (pct === null || pct === undefined) return null;
  const up = pct > 0;
  return (
    <span
      className={cx('ins-delta', up ? 'ins-delta-up' : 'ins-delta-down')}
      aria-label={`${up ? 'Up' : 'Down'} ${Math.abs(pct).toFixed(0)}% vs previous period`}
    >
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

export function TableToggle({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ins-table-toggle">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="ins-dt"
      >
        {open ? 'Hide table' : 'View as table'}
      </button>
      {open ? (
        <div id="ins-dt" className="ins-data-table">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export const CHART_TOOLTIP_STYLE = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  fontSize: 12,
  color: 'var(--ink)',
};

export function SuccessRing({ pct }) {
  const r = 28;
  const circ = 2 * Math.PI * r;
  const fill = (pct / 100) * circ;
  const tone = pct >= 90 ? 'var(--ok)' : pct >= 70 ? 'var(--warn)' : 'var(--danger)';
  return (
    <div className="ins-ring" role="img" aria-label={`Success rate ${pct.toFixed(0)}%`}>
      <svg width={72} height={72} viewBox="0 0 72 72" aria-hidden="true">
        <circle cx={36} cy={36} r={r} fill="none" stroke="var(--line-2)" strokeWidth={6} />
        <circle
          cx={36} cy={36} r={r}
          fill="none"
          stroke={tone}
          strokeWidth={6}
          strokeDasharray={`${fill} ${circ - fill}`}
          strokeLinecap="round"
          strokeDashoffset={circ * 0.25}
          style={{ transition: 'stroke-dasharray 0.5s ease' }}
        />
      </svg>
      <span className="ins-ring-label">{pct.toFixed(0)}%</span>
    </div>
  );
}

// ─── Big chart: Runs & Latency ────────────────────────────────────────────────

function RunsLatencyDataTable({ daily }) {
  const COLS = [
    { key: 'date',   label: 'Date',   accessor: 'date',     type: 'date' },
    { key: 'runs',   label: 'Runs',   accessor: 'runs',     type: 'number' },
    { key: 'failed', label: 'Failed', accessor: 'failed',   type: 'number' },
    { key: 'median', label: 'Median', accessor: 'medianMs', type: 'number' },
    { key: 'p95',    label: 'p95',    accessor: 'p95Ms',    type: 'number' },
  ];
  const { sorted, sortKey, sortDir, toggle } = useSortable(daily, {
    columns: COLS,
    storageKey: 'sort:insights:latency-table',
  });
  return (
    <table className="table compact">
      <thead>
        <tr>
          <SortHeader col={COLS[0]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
          <SortHeader col={COLS[1]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
          <SortHeader col={COLS[2]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
          <SortHeader col={COLS[3]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
          <SortHeader col={COLS[4]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((d) => (
          <tr key={d.date}>
            <td>{d.date}</td>
            <td className="num">{d.runs}</td>
            <td className="num">{d.failed}</td>
            <td className="num">{fmtDuration(d.medianMs)}</td>
            <td className="num">{fmtDuration(d.p95Ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RunsLatencyChart({ daily, reduced }) {
  if (!daily?.length) {
    return (
      <div className="ins-chart-wrap panel">
        <h2 className="ins-chart-title">Runs &amp; latency</h2>
        <Empty icon="runs" title="No run data yet" />
      </div>
    );
  }
  return (
    <div className="ins-chart-wrap panel" aria-label="Runs and latency over time">
      <h2 className="ins-chart-title">Runs &amp; latency</h2>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={daily} margin={{ top: 10, right: 56, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line-2)" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--ink-3)' }} tickLine={false} axisLine={false} />
          <YAxis yAxisId="runs" tick={{ fontSize: 11, fill: 'var(--ink-3)' }} tickLine={false} axisLine={false} width={28} />
          <YAxis
            yAxisId="lat"
            orientation="right"
            tick={{ fontSize: 11, fill: 'var(--ink-3)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${Math.round(v / 1000)}s`}
            width={36}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            labelStyle={{ color: 'var(--ink-2)', marginBottom: 4 }}
            formatter={(v, name) => (name === 'Median' || name === 'p95') ? fmtDuration(v) : v}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
          <Bar yAxisId="runs" dataKey="runs" name="Runs" fill="var(--accent)" fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={!reduced} />
          <Bar yAxisId="runs" dataKey="failed" name="Failed" fill="var(--danger)" fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={!reduced} />
          <Line yAxisId="lat" type="monotone" dataKey="medianMs" name="Median" stroke="var(--ok)" strokeWidth={2} dot={false} isAnimationActive={!reduced} />
          <Line yAxisId="lat" type="monotone" dataKey="p95Ms" name="p95" stroke="var(--warn)" strokeWidth={2} strokeDasharray="4 2" dot={false} isAnimationActive={!reduced} />
        </ComposedChart>
      </ResponsiveContainer>
      <TableToggle label="Runs and latency data">
        <RunsLatencyDataTable daily={daily} />
      </TableToggle>
    </div>
  );
}

// ─── Big chart: Tokens by model ───────────────────────────────────────────────

const MODEL_COLORS = [
  'var(--accent)', 'var(--ok)', 'var(--warn)',
  '#a78bfa', '#f472b6', '#38bdf8', '#fb923c', '#34d399',
];

function TokensByModelDataTable({ daily, modelIds }) {
  const COLS = [
    { key: 'date', label: 'Date', accessor: 'date', type: 'date' },
    ...modelIds.map((m) => ({
      key: m,
      label: m.split('.').pop(),
      accessor: (d) => d.tokensByModel?.[m] || 0,
      type: 'number',
    })),
  ];
  const { sorted, sortKey, sortDir, toggle } = useSortable(daily, {
    columns: COLS,
    storageKey: 'sort:insights:tokens-table',
  });
  return (
    <table className="table compact">
      <thead>
        <tr>
          {COLS.map((c, i) => (
            <SortHeader key={c.key} col={c} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className={i > 0 ? 'num' : undefined} />
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((d) => (
          <tr key={d.date}>
            <td>{d.date}</td>
            {modelIds.map((m) => (
              <td key={m} className="num">{tokens(d.tokensByModel?.[m] || 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TokensByModelChart({ daily, reduced }) {
  const modelIds = [...new Set((daily || []).flatMap((d) => Object.keys(d.tokensByModel || {})))];

  if (!modelIds.length) {
    return (
      <div className="ins-chart-wrap panel">
        <h2 className="ins-chart-title">Tokens by model</h2>
        <Empty icon="knowledge" title="No token data yet" />
      </div>
    );
  }

  const totalByModel = {};
  for (const d of daily) {
    for (const [m, t] of Object.entries(d.tokensByModel || {})) {
      totalByModel[m] = (totalByModel[m] || 0) + t;
    }
  }
  const grand = Object.values(totalByModel).reduce((a, b) => a + b, 0);

  return (
    <div className="ins-chart-wrap panel" aria-label="Tokens by model over time">
      <h2 className="ins-chart-title">Tokens by model</h2>
      <div className="ins-model-legend" aria-hidden="true">
        {modelIds.map((m, i) => (
          <span key={m} className="ins-model-legend-item">
            <span className="ins-model-dot" style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
            <span className="muted small">{m.split('.').pop()}</span>
            {grand > 0 ? <span className="muted small"> ({((totalByModel[m] / grand) * 100).toFixed(0)}%)</span> : null}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line-2)" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--ink-3)' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--ink-3)' }} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => tokens(v)} />
          <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={(v) => tokens(v)} />
          {modelIds.map((m, i) => (
            <Bar
              key={m}
              dataKey={(d) => d.tokensByModel?.[m] || 0}
              name={m.split('.').pop()}
              stackId="m"
              fill={MODEL_COLORS[i % MODEL_COLORS.length]}
              isAnimationActive={!reduced}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <TableToggle label="Tokens by model data">
        <TokensByModelDataTable daily={daily} modelIds={modelIds} />
      </TableToggle>
    </div>
  );
}
