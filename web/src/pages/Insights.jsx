/**
 * Insights dashboard — cost, credits, tokens, latency, models, projects, agents, tools.
 *
 * This file is a React.lazy() chunk. Recharts is imported by the modules under ./insights/, so esbuild
 * places it in this lazy chunk, keeping it out of the main bundle.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Button, ErrorNote, PageHeader, Spinner } from '../components/ui.jsx';
import { CostTile, HealthTile, RunsTile, TokensTile } from './insights/Tiles.jsx';
import { RunsLatencyChart, TokensByModelChart } from './insights/charts.jsx';
import { ConnectionMap, ProjectCards, SpendByProject } from './insights/Projects.jsx';
import { AgentLeaderboard, AgentPerformance, ModelBreakdown, RunList, ToolUsage } from './insights/Agents.jsx';
import { useReducedMotion } from './insights/format.js';
import { FilterBar, ScopeSwitch } from './insights/FilterBar.jsx';
import { LoopMetricsSection, UserSpendSection } from './insights/Spend.jsx';

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
