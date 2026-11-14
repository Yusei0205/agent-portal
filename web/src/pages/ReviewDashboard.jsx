/**
 * Portal-wide code review dashboard.
 *
 * Accessible via the "Review dashboard" nav item (global, not project-scoped).
 * Allows users to view aggregate review metrics across all projects they have
 * access to, with a period selector and recent reviews list.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { href, navigate } from '../lib/router.js';
import { Icon } from '../components/Icon.jsx';
import { formatRelative } from '../lib/util.js';
import { useSort } from '../lib/useSort.jsx';

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtUsd(n) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1 && n !== 0) return `$${Number(n).toFixed(2)}`;
  if (n === 0) return '$0.00';
  return `$${Number(n).toFixed(4)}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Stat tile ──────────────────────────────────────────────────────────────────

function StatTile({ label, value, sub, icon }) {
  return (
    <div className="card" style={{ padding: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={{ fontSize: '0.8rem', color: 'var(--ink-3)', fontWeight: 500 }}>{label}</div>
        {icon && <Icon name={icon} size={15} style={{ color: 'var(--ink-3)' }} />}
      </div>
      <div style={{ fontSize: '1.75rem', fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.8rem', color: 'var(--ink-3)', marginTop: '0.35rem' }}>{sub}</div>}
    </div>
  );
}

// ── Verdict badge ──────────────────────────────────────────────────────────────

function VerdictBadge({ verdict }) {
  if (verdict === 'mergeable') {
    return <span className="badge badge-ok">Mergeable</span>;
  }
  if (verdict === 'blocked') {
    return <span className="badge badge-danger">Blocked</span>;
  }
  return null;
}

// ── Status badge ───────────────────────────────────────────────────────────────

const STATUS_CLASS = {
  pending: 'badge badge-warn',
  running: 'badge badge-info',
  done:    'badge badge-ok',
  failed:  'badge badge-danger',
};

function StatusBadge({ status }) {
  return <span className={STATUS_CLASS[status] || 'badge badge-neutral'}>{status}</span>;
}

// ── Recent review row ──────────────────────────────────────────────────────────

function RecentReviewRow({ review }) {
  return (
    <tr>
      <td>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem', padding: '2px 6px' }}
          onClick={() => navigate(`/p/${review.project_id}/reviews/code/${review.id}`)}
        >
          {review.base_ref}
          <Icon name="chevronRight" size={12} />
          {review.head_ref}
          {review.pr_number ? ` #${review.pr_number}` : ''}
        </button>
      </td>
      <td>
        <StatusBadge status={review.status} />
      </td>
      <td>
        {review.verdict && <VerdictBadge verdict={review.verdict} />}
      </td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '0.84rem' }}>
        {fmtUsd(review.estimatedUsd)}
      </td>
      <td className="muted" style={{ fontSize: '0.82rem', textAlign: 'right' }}>
        {formatRelative(review.created_at)}
      </td>
      <td>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => navigate(`/p/${review.project_id}/reviews/code/${review.id}`)}
          aria-label={`Open review for ${review.head_ref}`}
        >
          Open
        </button>
      </td>
    </tr>
  );
}

// ── Main dashboard ─────────────────────────────────────────────────────────────

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '7',     label: '7 days' },
  { value: '30',    label: '30 days' },
  { value: '90',    label: '90 days' },
];

export default function ReviewDashboard() {
  const [period, setPeriod] = useState('30');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { sorted: sortedRecent, sortProps } = useSort(data?.recentReviews, {
    branch: (r) => `${r.base_ref}>${r.head_ref}`, status: (r) => r.status, verdict: (r) => r.verdict,
    cost: (r) => Number(r.estimatedUsd ?? 0), when: (r) => r.created_at,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/reviews/dashboard?period=${period}`);
      setData(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const isEmpty = data && data.reviews?.total === 0;

  return (
    <div className="page">
      {/* ── Header ── */}
      <div className="page-head">
        <h1>Review dashboard</h1>
        <div className="page-actions">
          <div className="tab-bar" role="group" aria-label="Time period" style={{ borderBottom: 'none', marginBottom: 0 }}>
            {PERIODS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`tab-btn${period === p.value ? ' is-active' : ''}`}
                onClick={() => setPeriod(p.value)}
                aria-pressed={period === p.value}
                style={{ borderRadius: 'var(--radius)' }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn"
            onClick={load}
            aria-label="Refresh dashboard"
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </div>

      {loading && <div className="spinner" aria-label="Loading dashboard…" />}
      {error && <p className="error-note" role="alert">{error}</p>}

      {data && !loading && (
        <>
          {/* ── Date range ── */}
          <p className="muted" style={{ fontSize: '0.82rem' }}>
            Period: {new Date(data.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} –{' '}
            {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>

          {/* ── Stat tiles ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
            <StatTile
              label="Estimated spend"
              value={fmtUsd(data.totalEstimatedUsd)}
              sub={data.totalCacheSavedUsd > 0 ? `${fmtUsd(data.totalCacheSavedUsd)} saved by caching` : undefined}
              icon="chart"
            />
            <StatTile
              label="Reviews"
              value={String(data.reviews?.total ?? 0)}
              sub={`${data.reviews?.completed ?? 0} completed · ${data.reviews?.failed ?? 0} failed`}
              icon="review"
            />
            <StatTile
              label="Pull requests"
              value={String(data.pullRequests?.count ?? 0)}
              sub={`${data.pullRequests?.mergedViaPortal ?? 0} merged via portal · ${data.pullRequests?.distinctPeople ?? 0} people`}
              icon="branch"
            />
            <StatTile
              label="Tokens"
              value={fmtTokens((data.tokens?.input ?? 0) + (data.tokens?.output ?? 0))}
              sub={`${fmtTokens(data.tokens?.input ?? 0)} in · ${fmtTokens(data.tokens?.output ?? 0)} out`}
              icon="builder"
            />
          </div>

          {/* ── Empty state ── */}
          {isEmpty && (
            <div className="empty-state" style={{ padding: '48px 16px' }}>
              <p>No code reviews in this period yet.</p>
              <p className="muted" style={{ marginTop: 6, fontSize: '0.84rem' }}>
                Start a review from any project's Code review page.
              </p>
            </div>
          )}

          {/* ── Recent reviews ── */}
          {!isEmpty && data.recentReviews?.length > 0 && (
            <section aria-label="Recent reviews">
              <h2>Recent reviews</h2>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table" aria-label="Recent code reviews">
                  <thead>
                    <tr>
                      <th {...sortProps('branch')}>Branch / PR</th>
                      <th {...sortProps('status')}>Status</th>
                      <th {...sortProps('verdict')}>Verdict</th>
                      <th {...sortProps('cost')} style={{ textAlign: 'right' }}>Est. cost</th>
                      <th {...sortProps('when')} style={{ textAlign: 'right' }}>When</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRecent.map((r) => (
                      <RecentReviewRow key={r.id} review={r} />
                    ))}
                  </tbody>
                </table>
              </div>
              {data.recentReviews.length === 20 && (
                <p className="muted" style={{ fontSize: '0.82rem', marginTop: 8 }}>
                  Showing the 20 most recent reviews. Narrow the period to see fewer.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
