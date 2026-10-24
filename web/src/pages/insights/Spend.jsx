import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { cx, money } from '../../lib/util.js';
import { useSortable } from '../../lib/useSortable.js';
import { Spinner } from '../../components/ui.jsx';
import { SortHeader } from '../../components/SortHeader.jsx';
import { useApp } from '../../lib/context.js';
import { CHART_TOOLTIP_STYLE, TableToggle } from './charts.jsx';

// ─── Loop metrics section ────────────────────────────────────────────────────

const OUTCOME_COLORS = {
  done: '#22c55e',
  failed: '#ef4444',
  blocked: '#f59e0b',
  stopped: '#64748b',
};

export function LoopMetricsSection({ projectId, days, reduced }) {
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

export function UserSpendSection({ projectId }) {
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
