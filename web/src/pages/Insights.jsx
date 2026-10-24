/**
 * Insights dashboard — cost, credits, tokens, latency, models, projects, agents, tools.
 *
 * This file is a React.lazy() chunk. Recharts is imported here at module level, so esbuild
 * places it in this lazy chunk, keeping it out of the main bundle.
 */
import {
  Area, AreaChart,
  Bar, BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie, PieChart,
  ResponsiveContainer,
  Scatter, ScatterChart,
  Tooltip,
  XAxis, YAxis,
} from 'recharts';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { go, href } from '../lib/router.js';
import { cx, money, timeAgo, tokens } from '../lib/util.js';
import { useSortable } from '../lib/useSortable.js';
import { Badge, Button, Empty, ErrorNote, PageHeader, Segmented, Spinner } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { SortHeader } from '../components/SortHeader.jsx';
import { useApp } from '../lib/context.js';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtCredits(n) {
  if (n === null || n === undefined || n === 0) return null;
  return `${Number(n).toFixed(2)} credits`;
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function pctDelta(now, prev) {
  if (prev === null || prev === undefined || prev === 0) return null;
  return ((now - prev) / Math.abs(prev)) * 100;
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = (e) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

function DeltaChip({ pct }) {
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

function TableToggle({ label, children }) {
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

const CHART_TOOLTIP_STYLE = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  fontSize: 12,
  color: 'var(--ink)',
};

// ─── Filter bar ───────────────────────────────────────────────────────────────

const RANGE_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

const PROVIDER_OPTIONS = [
  { value: '', label: 'All providers' },
  { value: 'demo', label: 'Demo' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'bedrock', label: 'Bedrock' },
  { value: 'kiro', label: 'Kiro' },
];

const KIND_OPTIONS = [
  { value: '', label: 'All run types' },
  { value: 'chat', label: 'Chat' },
  { value: 'test', label: 'Test' },
  { value: 'review', label: 'Review' },
  { value: 'qa', label: 'QA' },
  { value: 'learn', label: 'Learn' },
  { value: 'quiz', label: 'Quiz' },
  { value: 'verify', label: 'Verify' },
  { value: 'connection', label: 'Connection test' },
];

function FilterBar({ filters, onChange, projects, showProjectSelect }) {
  return (
    <div className="ins-filter-bar" role="search" aria-label="Filter insights">
      <div className="ins-filter-group">
        <label className="ins-filter-label" htmlFor="ins-range">Range</label>
        <select
          id="ins-range"
          className="input input-sm"
          value={filters.days}
          onChange={(e) => onChange({ ...filters, days: e.target.value })}
        >
          {RANGE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>

      <div className="ins-filter-group">
        <label className="ins-filter-label" htmlFor="ins-provider">Provider</label>
        <select
          id="ins-provider"
          className="input input-sm"
          value={filters.provider}
          onChange={(e) => onChange({ ...filters, provider: e.target.value })}
        >
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      <div className="ins-filter-group">
        <label className="ins-filter-label" htmlFor="ins-kind">Run type</label>
        <select
          id="ins-kind"
          className="input input-sm"
          value={filters.kind}
          onChange={(e) => onChange({ ...filters, kind: e.target.value })}
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
      </div>

      {showProjectSelect ? (
        <div className="ins-filter-group">
          <label className="ins-filter-label" htmlFor="ins-project">Project</label>
          <select
            id="ins-project"
            className="input input-sm"
            value={filters.projectId}
            onChange={(e) => onChange({ ...filters, projectId: e.target.value })}
          >
            <option value="">All projects</option>
            {(projects || []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

// ─── Tile: Cost ───────────────────────────────────────────────────────────────

function CostTile({ totals, daily, health, reduced }) {
  const pctVsCap =
    health?.budget?.monthlyUsd && health.budget.monthlyUsd > 0
      ? Math.min(100, ((health.budget.monthUsd || 0) / health.budget.monthlyUsd) * 100)
      : null;
  const costDelta = pctDelta(totals.costUsd, totals.prev?.costUsd);
  const sparkData = (daily || []).map((d) => ({ date: d.date, v: d.costUsd || 0 }));

  return (
    <div className="ins-tile panel" aria-label="Cost this period">
      <div className="ins-tile-head">
        <span className="ins-tile-label">Cost</span>
        <DeltaChip pct={costDelta} />
      </div>
      <div className="ins-tile-big">{money(totals.costUsd, 2)}</div>
      {fmtCredits(totals.credits) ? (
        <div className="ins-tile-sub muted">{fmtCredits(totals.credits)}</div>
      ) : null}
      {pctVsCap !== null ? (
        <div className="ins-tile-gauge">
          <div className="ins-gauge-track" role="progressbar" aria-valuenow={Math.round(pctVsCap)} aria-valuemin={0} aria-valuemax={100} aria-label={`${Math.round(pctVsCap)}% of monthly cap`}>
            <div
              className={cx('ins-gauge-fill', pctVsCap > 90 ? 'ins-gauge-danger' : pctVsCap > 70 ? 'ins-gauge-warn' : '')}
              style={{ width: `${pctVsCap}%` }}
            />
          </div>
          <span className="ins-tile-sub muted small">
            {money(health.budget.monthUsd, 2)} / {money(health.budget.monthlyUsd, 2)} monthly cap
          </span>
        </div>
      ) : null}
      {sparkData.length > 1 ? (
        <ResponsiveContainer width="100%" height={44} aria-hidden="true">
          <AreaChart data={sparkData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.4} />
                <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={1.5} fill="url(#costGrad)" dot={false} isAnimationActive={!reduced} />
          </AreaChart>
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}

// ─── Tile: Runs ───────────────────────────────────────────────────────────────

function RunsTile({ totals, daily, reduced }) {
  const runDelta = pctDelta(totals.runs, totals.prev?.runs);
  const providerKeys = [...new Set((daily || []).flatMap((d) => Object.keys(d.byProvider || {})))];
  const COLORS = ['var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--danger)'];

  return (
    <div className="ins-tile panel" aria-label="Runs this period">
      <div className="ins-tile-head">
        <span className="ins-tile-label">Runs</span>
        <DeltaChip pct={runDelta} />
      </div>
      <div className="ins-tile-big">{totals.runs}</div>
      <div className="ins-tile-sub">
        {totals.active > 0 ? <Badge tone="accent">{totals.active} active</Badge> : null}
        {totals.successRate !== null && totals.successRate !== undefined ? (
          <span className="muted"> {(totals.successRate * 100).toFixed(0)}% success</span>
        ) : null}
      </div>
      {daily?.length > 1 ? (
        <ResponsiveContainer width="100%" height={44} aria-hidden="true">
          <AreaChart data={daily} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            {providerKeys.length > 0 ? (
              providerKeys.map((k, i) => (
                <Area
                  key={k}
                  type="monotone"
                  dataKey={(d) => d.byProvider?.[k] || 0}
                  name={k}
                  stackId="p"
                  stroke={COLORS[i % COLORS.length]}
                  fill={COLORS[i % COLORS.length]}
                  fillOpacity={0.3}
                  dot={false}
                  isAnimationActive={!reduced}
                />
              ))
            ) : (
              <Area type="monotone" dataKey="runs" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.25} dot={false} isAnimationActive={!reduced} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}

// ─── Tile: Tokens ─────────────────────────────────────────────────────────────

function TokensTile({ totals, daily, reduced }) {
  const total = (totals.inputTokens || 0) + (totals.outputTokens || 0);
  const tokenDelta = pctDelta(total, totals.prev?.tokens);

  return (
    <div className="ins-tile panel" aria-label="Tokens this period">
      <div className="ins-tile-head">
        <span className="ins-tile-label">Tokens</span>
        <DeltaChip pct={tokenDelta} />
      </div>
      <div className="ins-tile-big">{tokens(total)}</div>
      <div className="ins-tile-sub muted small">
        ↑ {tokens(totals.inputTokens || 0)} in · ↓ {tokens(totals.outputTokens || 0)} out
      </div>
      {daily?.length > 1 ? (
        <ResponsiveContainer width="100%" height={44} aria-hidden="true">
          <BarChart data={daily} margin={{ top: 2, right: 0, left: 0, bottom: 0 }} barSize={4}>
            <Bar dataKey="inputTokens" name="Input" stackId="t" fill="var(--accent)" isAnimationActive={!reduced} />
            <Bar dataKey="outputTokens" name="Output" stackId="t" fill="var(--ok)" isAnimationActive={!reduced} />
          </BarChart>
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}

// ─── Tile: Health ─────────────────────────────────────────────────────────────

function HealthTile({ totals, health }) {
  const rate = totals.successRate;
  const pct = rate !== null && rate !== undefined ? rate * 100 : null;
  const failedTests = (health?.connectionTests || []).filter((t) => !t.ok).length;
  const sso = health?.sso;

  return (
    <div className="ins-tile panel" aria-label="Health overview">
      <div className="ins-tile-head">
        <span className="ins-tile-label">Health</span>
      </div>
      {pct !== null ? (
        <SuccessRing pct={pct} />
      ) : (
        <div className="ins-tile-big muted">No data</div>
      )}
      <div className="ins-health-chips">
        {sso ? (
          <span className={cx('ins-chip', sso.signedIn ? 'ins-chip-ok' : 'ins-chip-warn')}>
            SSO {sso.signedIn ? 'signed in' : 'signed out'}
            {sso.signedIn && sso.expiresAt ? ` · exp ${timeAgo(sso.expiresAt)}` : ''}
          </span>
        ) : null}
        {failedTests > 0 ? (
          <span className="ins-chip ins-chip-danger">
            {failedTests} connection{failedTests !== 1 ? 's' : ''} failed
          </span>
        ) : health?.connectionTests?.length > 0 ? (
          <span className="ins-chip ins-chip-ok">All connections OK</span>
        ) : null}
      </div>
    </div>
  );
}

function SuccessRing({ pct }) {
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

function RunsLatencyChart({ daily, reduced }) {
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

function TokensByModelChart({ daily, reduced }) {
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

// ─── Spend by project ─────────────────────────────────────────────────────────

function SpendByProject({ projects }) {
  // Dollars and Kiro credits are different units: each gets its own bar, scaled against its own maximum.
  const sorted = [...(projects || [])]
    .filter((p) => (p.costUsd || 0) > 0 || (p.credits || 0) > 0)
    .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || (b.credits || 0) - (a.credits || 0))
    .slice(0, 12);
  const maxUsd = Math.max(0, ...sorted.map((p) => p.costUsd || 0));
  const maxCredits = Math.max(0, ...sorted.map((p) => p.credits || 0));

  if (!sorted.length) {
    return (
      <div className="ins-chart-wrap panel">
        <h2 className="ins-chart-title">Spend by project</h2>
        <Empty icon="projects" title="No spend data" />
      </div>
    );
  }

  return (
    <div className="ins-chart-wrap panel" aria-label="Spend by project">
      <h2 className="ins-chart-title">Spend by project</h2>
      <div className="ins-hbar-list">
        {sorted.map((p) => (
          <div key={p.id} className="ins-hbar-row">
            <a href={href(p.id, 'insights')} className="ins-hbar-label" title={p.name}>{p.name}</a>
            <div className="ins-hbar-track" role="presentation">
              {p.costUsd ? <div className="ins-hbar-fill" style={{ width: `${(p.costUsd / maxUsd) * 100}%` }} /> : null}
              {p.credits ? <div className="ins-hbar-fill ins-hbar-credits" style={{ width: `${(p.credits / maxCredits) * 100}%` }} /> : null}
            </div>
            <span className="ins-hbar-val">
              {[p.costUsd ? money(p.costUsd, 2) : '', p.credits ? `${Number(p.credits).toFixed(2)} credits` : ''].filter(Boolean).join(' · ')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Connection map ───────────────────────────────────────────────────────────

function ConnectionMap({ projects }) {
  const connected = (projects || []).filter((p) => p.connection);

  if (!connected.length) {
    return (
      <div className="ins-chart-wrap panel">
        <h2 className="ins-chart-title">Connection map</h2>
        <Empty icon="repos" title="No connections" />
      </div>
    );
  }

  // One row per project: project → provider → AWS account (or how it signs in when the account is not known yet).
  const PROVIDER_NAMES = { kiro: 'Kiro CLI', bedrock: 'Amazon Bedrock', anthropic: 'Anthropic API', demo: 'Demo' };
  return (
    <div className="ins-chart-wrap panel" aria-label="Connection map">
      <h2 className="ins-chart-title">Connection map</h2>
      <ul className="ins-connrows">
        {connected.map((p) => {
          const c = p.connection;
          const aws = c.aws?.account ? `AWS ${c.aws.account}` : c.aws?.how ? `AWS ${c.aws.how}` : 'AWS (Settings)';
          return (
            <li key={p.id} className="ins-connrow">
              <a href={href(p.id, 'setup', 'connection')} className="ins-connmap-node ins-connmap-project" title={`${p.name}: open the connection settings`}>
                {p.name}
              </a>
              <span className="ins-connrow-link" aria-hidden="true">
                <span className="ins-connrow-count">{p.runs} runs</span>
              </span>
              <span className="ins-connmap-node ins-connmap-prov" title={c.providerSource === 'settings' ? 'From Settings' : 'Set on this project'}>
                {PROVIDER_NAMES[c.provider] || c.provider}
                {c.providerSource === 'settings' ? <span className="muted small"> (Settings)</span> : null}
              </span>
              <span className="ins-connrow-link" aria-hidden="true" />
              <span className="ins-connmap-node ins-connmap-aws" title={c.modelAws === 'project' ? 'The model uses this account too' : ''}>
                {aws}
                {c.aws?.region ? <span className="muted small"> · {c.aws.region}</span> : null}
              </span>
              <span className="sr-only">
                {`${p.name}: ${PROVIDER_NAMES[c.provider] || c.provider}, ${aws}${c.aws?.region ? `, ${c.aws.region}` : ''}, ${p.runs} runs.`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Agent performance scatter ────────────────────────────────────────────────

function AgentPerformance({ agents, onSelect, reduced }) {
  if (!agents?.length) {
    return (
      <div className="ins-chart-wrap panel">
        <h2 className="ins-chart-title">Agent performance</h2>
        <Empty icon="builder" title="No agent data" />
      </div>
    );
  }

  const data = agents.map((a) => ({
    ...a,
    avgTokens: a.runs > 0 ? Math.round(((a.inputTokens || 0) + (a.outputTokens || 0)) / a.runs) : 0,
    successPct: (a.successRate || 0) * 100,
    dotSize: Math.max(30, Math.min(300, a.runs * 8)),
  }));

  return (
    <div className="ins-chart-wrap panel" aria-label="Agent performance scatter plot">
      <h2 className="ins-chart-title">Agent performance</h2>
      <p className="muted small">x = avg tokens/run · y = success rate · size = run count · click to highlight</p>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart margin={{ top: 8, right: 20, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line-2)" />
          <XAxis
            type="number"
            dataKey="avgTokens"
            name="Avg tokens/run"
            tick={{ fontSize: 11, fill: 'var(--ink-3)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => tokens(v)}
          />
          <YAxis
            type="number"
            dataKey="successPct"
            name="Success rate"
            tick={{ fontSize: 11, fill: 'var(--ink-3)' }}
            tickLine={false}
            axisLine={false}
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            width={36}
          />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            contentStyle={CHART_TOOLTIP_STYLE}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload;
              if (!d) return null;
              return (
                <div style={{ padding: '8px 12px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12 }}>
                  <div><strong>{d.name}</strong></div>
                  <div className="muted">{d.kind}</div>
                  <div>Runs: {d.runs}</div>
                  <div>Success: {d.successPct.toFixed(0)}%</div>
                  <div>Avg tokens: {tokens(d.avgTokens)}</div>
                </div>
              );
            }}
          />
          <Scatter
            data={data}
            isAnimationActive={!reduced}
            onClick={(d) => onSelect?.(d.name)}
            cursor="pointer"
          >
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={d.kind === 'main' ? 'var(--accent)' : 'var(--ok)'}
                fillOpacity={0.75}
              />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Agent leaderboard ────────────────────────────────────────────────────────

function AgentLeaderboard({ agents, agentsSampled, selectedAgent }) {
  const AGENT_COLS = [
    { key: 'name',     label: 'Agent',        accessor: 'name',       type: 'text' },
    { key: 'kind',     label: 'Kind',         accessor: 'kind',       type: 'text' },
    { key: 'runs',     label: 'Runs',         accessor: 'runs',       type: 'number' },
    { key: 'success',  label: 'Success',      accessor: (a) => a.successRate ?? null, type: 'number' },
    { key: 'duration', label: 'Avg duration', accessor: 'avgDurationMs', type: 'number' },
    { key: 'tokens',   label: 'Tokens',       accessor: (a) => (a.inputTokens || 0) + (a.outputTokens || 0), type: 'number' },
    { key: 'cost',     label: 'Est. cost',    accessor: 'estCostUsd', type: 'number' },
    { key: 'tools',    label: 'Top tools',    accessor: (a) => (a.topTools || []).slice(0, 3).map((t) => t.name).join(', '), type: 'text' },
  ];
  const { sorted, sortKey, sortDir, toggle } = useSortable(agents || [], {
    columns: AGENT_COLS,
    storageKey: 'sort:insights:agents',
  });

  if (!agents?.length) {
    return (
      <div className="panel stack">
        <h2>Agent leaderboard</h2>
        <Empty icon="builder" title="No agent data yet" />
      </div>
    );
  }

  return (
    <div className="panel stack">
      <h2>Agent leaderboard</h2>
      <div style={{ overflowX: 'auto' }}>
        <table className="table compact" aria-label="Agent leaderboard">
          <thead>
            <tr>
              <SortHeader col={AGENT_COLS[0]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={AGENT_COLS[1]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={AGENT_COLS[2]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={AGENT_COLS[3]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={AGENT_COLS[4]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={AGENT_COLS[5]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={AGENT_COLS[6]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={AGENT_COLS[7]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr
                key={a.name}
                className={selectedAgent === a.name ? 'ins-row-selected' : undefined}
              >
                <td><strong>{a.name}</strong></td>
                <td><Badge tone={a.kind === 'main' ? 'accent' : 'muted'}>{a.kind}</Badge></td>
                <td className="num">{a.runs}</td>
                <td className="num">
                  {a.successRate !== null && a.successRate !== undefined ? (
                    <span className={a.successRate >= 0.9 ? 'ok' : a.successRate < 0.7 ? 'danger' : undefined}>
                      {(a.successRate * 100).toFixed(0)}%
                    </span>
                  ) : '—'}
                </td>
                <td className="num">{fmtDuration(a.avgDurationMs)}</td>
                <td className="num">{tokens((a.inputTokens || 0) + (a.outputTokens || 0))}</td>
                <td className="num">{a.estCostUsd ? money(a.estCostUsd, 4) : '—'}</td>
                <td className="muted small">
                  {(a.topTools || []).slice(0, 3).map((t) => t.name).join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Per-agent cost is an estimate from token usage. Kiro runs report credits only — no tokens, no per-agent split.
        {agentsSampled !== null && agentsSampled !== undefined
          ? ` Showing data from a sample of ${agentsSampled} agent${agentsSampled !== 1 ? 's' : ''}.`
          : null}
      </p>
    </div>
  );
}

// ─── Project cards (global view) ─────────────────────────────────────────────

function ProjectCards({ projects }) {
  if (!projects?.length) return <Empty icon="projects" title="No project data" />;
  return (
    <div className="ins-project-grid">
      {projects.map((p) => (
        <a key={p.id} href={href(p.id, 'insights')} className="ins-project-card">
          <div className="ins-project-card-head">
            <strong>{p.name}</strong>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {p.archived ? <Badge tone="muted">Archived</Badge> : null}
              {p.connection ? <Badge tone="accent">{p.connection.provider}</Badge> : null}
            </div>
          </div>
          <dl className="kv">
            <div><dt>Runs</dt><dd>{p.runs}</dd></div>
            <div><dt>Cost</dt><dd>{money(p.costUsd, 2)}{fmtCredits(p.credits) ? ` / ${fmtCredits(p.credits)}` : ''}</dd></div>
            <div><dt>Success</dt><dd>
              {p.successRate !== null && p.successRate !== undefined
                ? `${(p.successRate * 100).toFixed(0)}%`
                : '—'}
            </dd></div>
            {p.activeSessions > 0 ? <div><dt>Active</dt><dd><Badge tone="accent">{p.activeSessions}</Badge></dd></div> : null}
            {p.pendingInputs > 0 ? <div><dt>Waiting</dt><dd><Badge tone="warn">{p.pendingInputs}</Badge></dd></div> : null}
          </dl>
          {p.lastActivity ? <p className="muted small">{timeAgo(p.lastActivity)}</p> : null}
        </a>
      ))}
    </div>
  );
}

// ─── Run lists (slowest / priciest / failures) ────────────────────────────────

function RunBriefRow({ run }) {
  const title = run.title || run.id;
  return (
    <tr>
      <td style={{ maxWidth: 260, overflow: 'hidden' }}>
        <a href={href(run.projectId, 'runs', run.id)} className="strong-link" title={title} style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </a>
      </td>
      <td><Badge status={run.status} /></td>
      <td className="muted small">{run.provider}</td>
      <td className="num">{run.costUsd ? money(run.costUsd, 4) : (fmtCredits(run.credits) || '—')}</td>
      <td className="num">{fmtDuration(run.durationMs)}</td>
      {run.error ? (
        <td className="danger small" title={run.error}>{run.error.slice(0, 60)}</td>
      ) : <td />}
    </tr>
  );
}

function RunList({ title, runs }) {
  const RUN_COLS = [
    { key: 'run',      label: 'Run',      accessor: (r) => r.title || r.id,  type: 'text' },
    { key: 'status',   label: 'Status',   accessor: 'status',                type: 'status' },
    { key: 'provider', label: 'Provider', accessor: 'provider',              type: 'text' },
    { key: 'cost',     label: 'Cost',     accessor: (r) => r.costUsd ?? r.credits ?? null, type: 'number' },
    { key: 'duration', label: 'Duration', accessor: 'durationMs',            type: 'number' },
    { key: 'error',    label: 'Error',    accessor: 'error',                 type: 'text' },
  ];
  const { sorted, sortKey, sortDir, toggle } = useSortable(runs || [], {
    columns: RUN_COLS,
    storageKey: `sort:insights:runlist:${title}`,
  });

  if (!runs?.length) return null;

  return (
    <div className="panel stack">
      <h2>{title}</h2>
      <div style={{ overflowX: 'auto' }}>
        <table className="table compact" aria-label={title}>
          <thead>
            <tr>
              <SortHeader col={RUN_COLS[0]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={RUN_COLS[1]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={RUN_COLS[2]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={RUN_COLS[3]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={RUN_COLS[4]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={RUN_COLS[5]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => <RunBriefRow key={r.id} run={r} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Tool usage ───────────────────────────────────────────────────────────────

function ToolUsage({ tools, approvals, blocked }) {
  const hasData = tools?.length || approvals?.asked || blocked;

  const TOOL_COLS = [
    { key: 'tool',      label: 'Tool',       accessor: 'name',   type: 'text' },
    { key: 'calls',     label: 'Calls',      accessor: 'calls',  type: 'number' },
    { key: 'errors',    label: 'Errors',     accessor: 'errors', type: 'number' },
    { key: 'errorrate', label: 'Error rate', accessor: (t) => t.calls > 0 ? t.errors / t.calls : null, type: 'number' },
  ];
  const { sorted: sortedTools, sortKey: toolSortKey, sortDir: toolSortDir, toggle: toolToggle } = useSortable(
    tools || [],
    { columns: TOOL_COLS, storageKey: 'sort:insights:tools' }
  );

  if (!hasData) {
    return (
      <div className="panel stack">
        <h2>Tool usage</h2>
        <Empty icon="builder" title="No tool data yet" />
      </div>
    );
  }

  return (
    <div className="panel stack">
      <h2>Tool usage</h2>
      {tools?.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="table compact" aria-label="Tool usage">
            <thead>
              <tr>
                <SortHeader col={TOOL_COLS[0]} sortKey={toolSortKey} sortDir={toolSortDir} onSort={toolToggle} />
                <SortHeader col={TOOL_COLS[1]} sortKey={toolSortKey} sortDir={toolSortDir} onSort={toolToggle} className="num" />
                <SortHeader col={TOOL_COLS[2]} sortKey={toolSortKey} sortDir={toolSortDir} onSort={toolToggle} className="num" />
                <SortHeader col={TOOL_COLS[3]} sortKey={toolSortKey} sortDir={toolSortDir} onSort={toolToggle} className="num" />
              </tr>
            </thead>
            <tbody>
              {sortedTools.map((t) => (
                <tr key={t.name}>
                  <td><code>{t.name}</code></td>
                  <td className="num">{t.calls}</td>
                  <td className="num">{t.errors}</td>
                  <td className="num">{t.calls > 0 ? `${((t.errors / t.calls) * 100).toFixed(0)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {(approvals || blocked) ? (
        <dl className="kv">
          {approvals ? (
            <>
              <div><dt>Approvals asked</dt><dd>{approvals.asked}</dd></div>
              <div><dt>Approvals denied</dt><dd>{approvals.denied}</dd></div>
            </>
          ) : null}
          {blocked ? <div><dt>Blocked by guardrails</dt><dd>{blocked}</dd></div> : null}
        </dl>
      ) : null}
    </div>
  );
}

// ─── Model / Provider / Kind breakdowns ──────────────────────────────────────

function ModelBreakdown({ models }) {
  const MODEL_COLS = [
    { key: 'model',    label: 'Model',    accessor: 'model',      type: 'text' },
    { key: 'provider', label: 'Provider', accessor: 'provider',   type: 'text' },
    { key: 'runs',     label: 'Runs',     accessor: 'runs',       type: 'number' },
    { key: 'success',  label: 'Success',  accessor: (m) => m.successRate ?? null, type: 'number' },
    { key: 'tokens',   label: 'Tokens',   accessor: 'tokens',     type: 'number' },
    { key: 'cost',     label: 'Cost',     accessor: (m) => m.costUsd ?? m.credits ?? null, type: 'number' },
    { key: 'median',   label: 'Median',   accessor: 'medianMs',   type: 'number' },
  ];
  const { sorted, sortKey, sortDir, toggle } = useSortable(models || [], {
    columns: MODEL_COLS,
    storageKey: 'sort:insights:models',
  });

  if (!models?.length) return null;

  return (
    <div className="panel stack">
      <h2>Model breakdown</h2>
      <div style={{ overflowX: 'auto' }}>
        <table className="table compact" aria-label="Model breakdown">
          <thead>
            <tr>
              <SortHeader col={MODEL_COLS[0]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={MODEL_COLS[1]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={MODEL_COLS[2]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={MODEL_COLS[3]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={MODEL_COLS[4]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={MODEL_COLS[5]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={MODEL_COLS[6]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={`${m.provider}:${m.model}`}>
                <td><code className="small">{m.model}</code></td>
                <td className="muted">{m.provider}</td>
                <td className="num">{m.runs}</td>
                <td className="num">
                  {m.successRate !== null && m.successRate !== undefined
                    ? `${(m.successRate * 100).toFixed(0)}%`
                    : '—'}
                </td>
                <td className="num">{tokens(m.tokens || 0)}</td>
                <td className="num">{m.costUsd ? money(m.costUsd, 4) : m.credits ? `${Number(m.credits).toFixed(2)} credits` : '—'}</td>
                <td className="num">{fmtDuration(m.medianMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Insights content (when data is loaded) ───────────────────────────────────

function InsightsContent({ data, reduced, projectId, selectedAgent, onSelectAgent }) {
  const {
    totals, daily, models, projects, agents, agentsSampled,
    tools, approvals, blocked, slowest, priciest, failures, health,
  } = data;

  return (
    <>
      {/* Row 1: Four tiles */}
      <div className="ins-tiles">
        <CostTile totals={totals} daily={daily} health={health} reduced={reduced} />
        <RunsTile totals={totals} daily={daily} reduced={reduced} />
        <TokensTile totals={totals} daily={daily} reduced={reduced} />
        <HealthTile totals={totals} health={health} />
      </div>

      {/* Row 2: Big charts */}
      <div className="ins-charts-2col">
        <RunsLatencyChart daily={daily} reduced={reduced} />
        <TokensByModelChart daily={daily} reduced={reduced} />
      </div>

      {/* Row 3: Spend / Connection / Agent scatter */}
      <div className="ins-charts-3col">
        <SpendByProject projects={projects} />
        <ConnectionMap projects={projects} />
        <AgentPerformance agents={agents} onSelect={onSelectAgent} reduced={reduced} />
      </div>

      {/* Agent leaderboard */}
      <AgentLeaderboard agents={agents} agentsSampled={agentsSampled} selectedAgent={selectedAgent} />

      {/* Project cards — global view only */}
      {!projectId && projects?.length > 0 ? (
        <div className="panel stack">
          <h2>Projects</h2>
          <ProjectCards projects={projects} />
        </div>
      ) : null}

      {/* Run lists */}
      <div className="ins-lists-3col">
        <RunList title="Slowest runs" runs={slowest} />
        <RunList title="Most expensive" runs={priciest} />
        <RunList title="Recent failures" runs={failures} />
      </div>

      {/* Tool usage */}
      <ToolUsage tools={tools} approvals={approvals} blocked={blocked} />

      {/* Model breakdown */}
      <ModelBreakdown models={models} />
    </>
  );
}

// ─── Loop metrics section ────────────────────────────────────────────────────

const OUTCOME_COLORS = {
  done: '#22c55e',
  failed: '#ef4444',
  blocked: '#f59e0b',
  stopped: '#64748b',
};

function LoopMetricsSection({ projectId, days, reduced }) {
  const [lmData, setLmData] = useState(null);
  const [lmLoading, setLmLoading] = useState(true);

  useEffect(() => {
    if (!projectId) { setLmLoading(false); return; }
    const url = `/api/projects/${projectId}/loop-metrics?window=${days}`;
    setLmLoading(true);
    api.get(url).then((r) => { setLmData(r); setLmLoading(false); }).catch(() => setLmLoading(false));
  }, [projectId, days]);

  if (lmLoading || !lmData) return null;

  const specs = lmData.specs ?? [];
  const overall = lmData.overall ?? {};
  if (!overall.total) return null;

  const timeRows = lmData.by_day ?? [];

  return (
    <section className="ins-loop-section" aria-label="Loop metrics">
      <h2 className="ins-section-title">Loop sessions (last {days} days)</h2>
      <div className="ins-kpis">
        <div className="ins-kpi">
          <span className="ins-kpi-val">{overall.total ?? 0}</span>
          <span className="ins-kpi-label">total loop runs</span>
        </div>
        <div className="ins-kpi">
          <span className="ins-kpi-val">{overall.success_rate != null ? `${Math.round(overall.success_rate * 100)}%` : '—'}</span>
          <span className="ins-kpi-label">success rate</span>
        </div>
        <div className="ins-kpi">
          <span className="ins-kpi-val">{overall.autonomy_rate != null ? `${Math.round(overall.autonomy_rate * 100)}%` : '—'}</span>
          <span className="ins-kpi-label">autonomy rate</span>
        </div>
        <div className="ins-kpi">
          <span className="ins-kpi-val">{overall.avg_cost_usd != null ? money(overall.avg_cost_usd, 3) : '—'}</span>
          <span className="ins-kpi-label">avg cost / done</span>
        </div>
      </div>
      {timeRows.length > 0 ? (
        <div className="ins-chart-block">
          <h3 className="ins-chart-title">Sessions per day by outcome</h3>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={timeRows} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} isAnimationActive={!reduced} />
              <Bar dataKey="done" name="Done" fill={OUTCOME_COLORS.done} isAnimationActive={!reduced} stackId="a" />
              <Bar dataKey="failed" name="Failed" fill={OUTCOME_COLORS.failed} isAnimationActive={!reduced} stackId="a" />
              <Bar dataKey="blocked" name="Blocked" fill={OUTCOME_COLORS.blocked} isAnimationActive={!reduced} stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : null}
      {specs.length > 0 ? (
        <TableToggle label="Per-spec breakdown">
          <table className="table" aria-label="Per-spec loop metrics">
            <thead><tr><th>Spec</th><th>Runs</th><th>Success</th><th>Avg cost</th></tr></thead>
            <tbody>
              {specs.map((s, i) => (
                <tr key={i}>
                  <td>{s.spec_name ?? 'Ad-hoc'}</td>
                  <td>{s.total ?? 0}</td>
                  <td>{s.success_rate != null ? `${Math.round(s.success_rate * 100)}%` : '—'}</td>
                  <td>{s.avg_cost_usd != null ? money(s.avg_cost_usd, 3) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableToggle>
      ) : null}
    </section>
  );
}

// ─── Main exported component ─────────────────────────────────────────────────

// ─── User & team spend section (admin: all users; members: own) ──────────────

function UserSpendSection({ projectId }) {
  const { user } = useApp();
  const isAdmin = user?.is_admin;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    const url = isAdmin ? '/api/usage/users' : '/api/usage/me';
    api.get(url).then((r) => { setData(r); setError(null); }).catch(setError).finally(() => setLoading(false));
  }, [isAdmin]);

  if (loading) return <div className="pad"><Spinner /></div>;
  if (error) return null; // non-critical; don't block the rest of insights
  if (!data) return null;

  // Admin view: all users table with team grouping
  if (isAdmin && data.users) {
    const users = data.users;
    const since = data.since;
    const fmtSince = since ? new Date(since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '';
    // Group by team (users may be in multiple teams; show ungrouped if no teams)
    const teamGroups = new Map();
    for (const u of users) {
      for (const t of (u.teams || [])) {
        if (!teamGroups.has(t.team_id)) teamGroups.set(t.team_id, { name: t.team_name, users: [] });
        teamGroups.get(t.team_id).users.push(u);
      }
    }
    const ungrouped = users.filter((u) => !u.teams?.length);
    return (
      <section className="ins-user-spend" aria-label="User spend this month">
        <h2 className="ins-section-title">User spend{fmtSince ? ` — ${fmtSince}` : ''} (admin view)</h2>
        {teamGroups.size > 0 ? (
          <>
            {[...teamGroups.values()].map((tg) => (
              <div key={tg.name} className="ins-team-group">
                <h3 className="ins-team-name">{tg.name}</h3>
                <UserSpendTable users={tg.users} isAdmin />
              </div>
            ))}
            {ungrouped.length > 0 ? (
              <div className="ins-team-group">
                <h3 className="ins-team-name">No team</h3>
                <UserSpendTable users={ungrouped} isAdmin />
              </div>
            ) : null}
          </>
        ) : (
          <UserSpendTable users={users} isAdmin />
        )}
      </section>
    );
  }

  // Member view: own spend only
  const me = data;
  const byMonth = me.by_month ?? [];
  const prev = byMonth[1];
  return (
    <section className="ins-user-spend" aria-label="My spend">
      <h2 className="ins-section-title">My spend</h2>
      <div className="ins-kpis">
        <div className="ins-kpi">
          <span className="ins-kpi-val">{money(me.month_usd ?? 0, 2)}</span>
          <span className="ins-kpi-label">this month</span>
        </div>
        {prev ? (
          <div className="ins-kpi">
            <span className="ins-kpi-val">{money(prev.usd ?? 0, 2)}</span>
            <span className="ins-kpi-label">last month</span>
          </div>
        ) : null}
        {me.user?.monthly_budget_usd ? (
          <div className="ins-kpi">
            <span className="ins-kpi-val">{money(me.user.monthly_budget_usd, 2)}</span>
            <span className="ins-kpi-label">monthly cap</span>
          </div>
        ) : null}
      </div>
      {(me.by_project || []).length > 0 ? (
        <table className="table compact" aria-label="My spend by project">
          <thead><tr><th>Project</th><th className="num">This month</th><th className="num">Runs</th></tr></thead>
          <tbody>
            {me.by_project.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="num">{money(p.usd ?? 0, 2)}</td>
                <td className="num">{p.runs ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function UserSpendTable({ users, isAdmin }) {
  const USER_COLS = [
    { key: 'name',  label: 'Name',        accessor: 'name',      type: 'text' },
    { key: 'month', label: 'This month',   accessor: 'month_usd', type: 'number' },
    { key: 'runs',  label: 'Runs',         accessor: 'month_runs',type: 'number' },
    { key: 'cap',   label: 'Monthly cap',  accessor: (u) => u.monthly_budget_usd ?? 0, type: 'number' },
  ];
  const { sorted, sortKey, sortDir, toggle } = useSortable(users, { columns: USER_COLS, storageKey: 'sort:ins:users' });
  return (
    <table className="table compact" aria-label="User spend">
      <thead>
        <tr>
          <SortHeader col={USER_COLS[0]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
          <SortHeader col={USER_COLS[1]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
          <SortHeader col={USER_COLS[2]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
          <SortHeader col={USER_COLS[3]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((u) => {
          const budget = u.monthly_budget_usd;
          const pct = budget && budget > 0 ? Math.round(((u.month_usd ?? 0) / budget) * 100) : null;
          return (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td className="num">
                {money(u.month_usd ?? 0, 2)}
                {pct !== null ? (
                  <span className={cx('ins-budget-pct small', pct >= 100 && 'danger', pct >= 80 && 'warn')}>
                    {' '}{pct}%
                  </span>
                ) : null}
              </td>
              <td className="num">{u.month_runs ?? 0}</td>
              <td className="num">{budget ? money(budget, 0) : <span className="muted">—</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The project the scope switch jumps to from the all-projects view: the last one you were in. */
function lastProjectId(projects) {
  let id = '';
  try {
    id = localStorage.getItem('rail-last-project') || '';
  } catch {
    /* private mode */
  }
  return (projects || []).some((p) => p.id === id && !p.archived) ? id : '';
}

/**
 * Insights is one page with a scope switch: this project, or all projects. It has one place in the menu.
 */
function ScopeSwitch({ projectId }) {
  const projects = useApp()?.projects;
  const jumpTo = projectId || lastProjectId(projects);
  if (!jumpTo) return null;
  return (
    <Segmented
      value={projectId ? 'project' : 'all'}
      onChange={(v) => (v === 'project' ? go(jumpTo, 'insights') : go(null, 'insights'))}
      label="Insights scope"
      options={[
        { value: 'project', label: 'This project' },
        { value: 'all', label: 'All projects' },
      ]}
    />
  );
}

export function Insights({ projectId }) {
  const [filters, setFilters] = useState({
    days: '30',
    provider: '',
    kind: '',
    projectId: projectId || '',
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);

  // Keep projectId filter synced when prop changes (e.g. navigating between project tabs)
  useEffect(() => {
    setFilters((f) => ({ ...f, projectId: projectId || '' }));
  }, [projectId]);

  const load = useCallback(async (f) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        days: f.days,
        tz: String(new Date().getTimezoneOffset()),
      });
      if (f.provider) params.set('provider', f.provider);
      if (f.kind) params.set('kind', f.kind);
      if (f.projectId) params.set('projectId', f.projectId);
      const result = await api.get(`/api/insights?${params}`);
      setData(result);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filters);
  }, [load, filters]);

  const handleFilters = useCallback((next) => setFilters(next), []);
  const reduced = useReducedMotion();

  const title = 'Insights';
  const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const sub = data?.range ? `${fmtDay(data.range.since)} – ${fmtDay(data.range.until)}` : undefined;

  return (
    <div className="page wide">
      <PageHeader
        title={title}
        sub={sub || (projectId ? 'Cost, tokens, latency and agents for this project.' : 'Cost, tokens, latency and agents across all projects.')}
        actions={
          <Button icon="refresh" busy={loading && Boolean(data)} onClick={() => load(filters)}>
            Refresh
          </Button>
        }
      />

      <ScopeSwitch projectId={projectId} />

      <FilterBar
        filters={filters}
        onChange={handleFilters}
        projects={data?.projects || null}
        showProjectSelect={!projectId}
      />

      {error ? (
        <ErrorNote error={error} onClose={() => setError(null)} />
      ) : loading && !data ? (
        <div className="pad"><Spinner /></div>
      ) : data ? (
        <>
          <InsightsContent
            data={data}
            reduced={reduced}
            projectId={projectId}
            selectedAgent={selectedAgent}
            onSelectAgent={setSelectedAgent}
          />
          <LoopMetricsSection projectId={projectId} days={filters.days} reduced={reduced} />
          {!projectId ? <UserSpendSection /> : null}
        </>
      ) : null}
    </div>
  );
}
