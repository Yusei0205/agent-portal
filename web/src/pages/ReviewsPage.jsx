/**
 * Reviews page — tabbed project-scoped page.
 * Tabs: Code reviews · Branch scans · Dashboard
 *
 * URLs:
 *   #/p/:pid/reviews/code                → code reviews list
 *   #/p/:pid/reviews/code/:reviewId      → review detail
 *   #/p/:pid/reviews/branch-scans        → branch scans list
 *   #/p/:pid/reviews/branch-scans/:scanId → scan detail
 *   #/p/:pid/reviews/dashboard           → review dashboard
 *
 * Old URLs redirect here (handled in App.jsx):
 *   /p/:pid/review          → /p/:pid/reviews/code
 *   /p/:pid/review/:id      → /p/:pid/reviews/code/:id
 *   /p/:pid/branchscans     → /p/:pid/reviews/branch-scans
 *   /p/:pid/branchscans/:id → /p/:pid/reviews/branch-scans/:id
 */

import { useState, useEffect, useCallback } from 'react';
import { navigate } from '../lib/router.js';
import { Icon } from '../components/Icon.jsx';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import Review from './Review.jsx';
import ReviewDetail from './ReviewDetail.jsx';
import BranchScans from './BranchScans.jsx';
import BranchScanDetail from './BranchScanDetail.jsx';
import { useSort } from '../lib/useSort.jsx';
import { PageHeader, SectionHead } from '../components/PageHeader.jsx';

const TABS = [
  { id: 'code',          label: 'Code reviews' },
  { id: 'branch-scans',  label: 'Branch scans' },
  { id: 'dashboard',     label: 'Dashboard'    },
];

// ── Dashboard (project-filtered) ──────────────────────────────────────────────

/**
 * Thin wrapper around the review dashboard data that adds a per-project view
 * with a "Show all projects" toggle.
 *
 * NOTE: The `/api/reviews/dashboard` endpoint is portal-wide and does not
 * accept a projectId filter. Aggregate stats (total spend, token counts) always
 * reflect all projects. The "current project" view filters `recentReviews` on
 * the client. Aggregate tiles continue to show portal-wide numbers in that
 * mode; a notice is shown to make this clear.
 */
function ProjectDashboard({ projectId }) {
  const [period, setPeriod]         = useState('30');
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [showAll, setShowAll]       = useState(false);

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

  function fmtUsd(n) {
    if (n === null || n === undefined) return '—';
    if (n === 0) return '$0.00';
    return `$${Number(n).toFixed(2)}`;
  }
  function fmtTokens(n) {
    if (!n) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  // Client-side project filter for recentReviews
  const filteredReviews = data?.recentReviews?.filter((r) =>
    showAll ? true : r.project_id === projectId,
  ) ?? [];
  const { sorted: sortedReviews, sortProps } = useSort(filteredReviews, {
    branch: (r) => `${r.base_ref}>${r.head_ref}`, status: (r) => r.status,
    cost: (r) => Number(r.estimatedUsd ?? 0), when: (r) => r.created_at,
  });

  const STATUS_CLASS = {
    pending: 'badge badge-warn',
    running: 'badge badge-info',
    done:    'badge badge-ok',
    failed:  'badge badge-danger',
  };

  const PERIODS = [
    { value: 'today', label: 'Today' },
    { value: '7',     label: '7 days' },
    { value: '30',    label: '30 days' },
    { value: '90',    label: '90 days' },
  ];

  return (
    <div>
      {/* Header row */}
      <div className="page-head" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 640 }}>Dashboard</h2>
          {/* Project scope toggle */}
          <label
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              fontSize: '0.84rem', cursor: 'pointer', userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              style={{ width: 'auto', minHeight: 'auto' }}
              aria-label="Show all projects"
            />
            Show all projects
          </label>
        </div>
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
          <button type="button" className="btn" onClick={load} aria-label="Refresh dashboard">
            <Icon name="refresh" size={14} />
          </button>
        </div>
      </div>

      {loading && <div className="spinner" aria-label="Loading dashboard…" />}
      {error && <p className="error-note" role="alert">{error}</p>}

      {data && !loading && (
        <>
          <p className="muted" style={{ fontSize: '0.82rem' }}>
            Period: {new Date(data.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} –{' '}
            {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>

          {/* Aggregate tiles — always portal-wide */}
          {!showAll && (
            <p
              className="muted"
              role="note"
              style={{ fontSize: '0.78rem', marginBottom: '0.75rem' }}
            >
              Summary tiles show portal-wide totals. Showing recent reviews for this project.
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            {[
              { label: 'Estimated spend', value: fmtUsd(data.totalEstimatedUsd), icon: 'chart' },
              { label: 'Reviews',         value: String(data.reviews?.total ?? 0), icon: 'review' },
              { label: 'Pull requests',   value: String(data.pullRequests?.count ?? 0), icon: 'branch' },
              { label: 'Tokens',          value: fmtTokens((data.tokens?.input ?? 0) + (data.tokens?.output ?? 0)), icon: 'builder' },
            ].map(({ label, value, icon }) => (
              <div key={label} className="card" style={{ padding: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--ink-3)', fontWeight: 500 }}>{label}</div>
                  <Icon name={icon} size={15} style={{ color: 'var(--ink-3)' }} />
                </div>
                <div style={{ fontSize: '1.75rem', fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Recent reviews (filtered) */}
          {filteredReviews.length > 0 ? (
            <section aria-label="Recent reviews">
              <h2>Recent reviews</h2>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table" aria-label="Recent code reviews">
                  <thead>
                    <tr>
                      <th {...sortProps('branch')}>Branch / PR</th>
                      <th {...sortProps('status')}>Status</th>
                      <th {...sortProps('cost')} style={{ textAlign: 'right' }}>Est. cost</th>
                      <th {...sortProps('when')} style={{ textAlign: 'right' }}>When</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedReviews.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <code style={{ fontSize: '0.82rem' }}>
                            {r.base_ref}→{r.head_ref}{r.pr_number ? ` #${r.pr_number}` : ''}
                          </code>
                        </td>
                        <td>
                          <span className={STATUS_CLASS[r.status] || 'badge badge-neutral'}>{r.status}</span>
                        </td>
                        <td style={{ textAlign: 'right', fontSize: '0.84rem' }}>
                          {r.estimatedUsd ? `$${Number(r.estimatedUsd).toFixed(4)}` : '—'}
                        </td>
                        <td className="muted" style={{ textAlign: 'right', fontSize: '0.82rem' }}>
                          {formatRelative(r.created_at)}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => navigate(`/p/${r.project_id}/reviews/code/${r.id}`)}
                            aria-label={`Open review for ${r.head_ref}`}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <div className="empty-state" style={{ padding: '48px 0' }}>
              <p>
                {showAll
                  ? 'No code reviews in this period.'
                  : 'No reviews for this project in this period.'}
              </p>
              {!showAll && (
                <p className="muted" style={{ marginTop: 6, fontSize: '0.84rem' }}>
                  Enable "Show all projects" to see portal-wide reviews.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Reviews page ──────────────────────────────────────────────────────────────

export function ReviewsPage({ projectId, route, user }) {
  const subTab  = route.rest?.[0] || 'code';
  const detailId = route.rest?.[1] || null;

  const activeTab = TABS.find((t) => t.id === subTab) ? subTab : 'code';

  const switchTab = (id) => navigate(`/p/${projectId}/reviews/${id}`);

  return (
    <div className="page">
      <PageHeader title="Reviews" description="Code reviews, branch scans and review metrics for this project." />

      {/* Tab bar — hidden when a detail is open */}
      {!detailId && (
        <div className="tab-bar" role="tablist" aria-label="Reviews sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              className={`tab-btn${activeTab === t.id ? ' is-active' : ''}`}
              aria-selected={activeTab === t.id}
              onClick={() => switchTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      <div className="tab-content">
        {/* Code reviews list */}
        {activeTab === 'code' && !detailId && (
          <Review projectId={projectId} user={user} />
        )}

        {/* Code review detail */}
        {activeTab === 'code' && detailId && (
          <ReviewDetail
            key={detailId}
            projectId={projectId}
            reviewId={detailId}
            user={user}
          />
        )}

        {/* Branch scans list */}
        {activeTab === 'branch-scans' && !detailId && (
          <BranchScans key={projectId} projectId={projectId} user={user} />
        )}

        {/* Branch scan detail */}
        {activeTab === 'branch-scans' && detailId && (
          <BranchScanDetail
            key={detailId}
            projectId={projectId}
            scanId={detailId}
            user={user}
          />
        )}

        {/* Dashboard */}
        {activeTab === 'dashboard' && (
          <ProjectDashboard projectId={projectId} />
        )}
      </div>
    </div>
  );
}

export default ReviewsPage;
