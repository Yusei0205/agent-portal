import { CartesianGrid, Cell, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { href } from '../../lib/router.js';
import { money, tokens } from '../../lib/util.js';
import { useSortable } from '../../lib/useSortable.js';
import { Badge, Empty } from '../../components/ui.jsx';
import { SortHeader } from '../../components/SortHeader.jsx';
import { CHART_TOOLTIP_STYLE } from './charts.jsx';
import { fmtCredits, fmtDuration } from './format.js';

// ─── Agent performance scatter ────────────────────────────────────────────────

export function AgentPerformance({ agents, onSelect, reduced }) {
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

export function AgentLeaderboard({ agents, agentsSampled, selectedAgent }) {
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

export function RunList({ title, runs }) {
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

export function ToolUsage({ tools, approvals, blocked }) {
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

export function ModelBreakdown({ models }) {
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
