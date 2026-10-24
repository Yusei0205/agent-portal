import { Area, AreaChart, Bar, BarChart, ResponsiveContainer } from 'recharts';
import { cx, money, timeAgo, tokens } from '../../lib/util.js';
import { Badge } from '../../components/ui.jsx';
import { fmtCredits, pctDelta } from './format.js';
import { DeltaChip, SuccessRing } from './charts.jsx';

// ─── Tile: Cost ───────────────────────────────────────────────────────────────

export function CostTile({ totals, daily, health, reduced }) {
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

export function RunsTile({ totals, daily, reduced }) {
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

export function TokensTile({ totals, daily, reduced }) {
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

export function HealthTile({ totals, health }) {
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
