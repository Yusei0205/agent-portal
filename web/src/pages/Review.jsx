import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { api } from '../lib/api.js';
import { navigate, href } from '../lib/router.js';
import { Icon } from '../components/Icon.jsx';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { useToast, ToastShelf } from '../components/Toast.jsx';

// ── URL hash query helpers ────────────────────────────────────────────────────

function parseHashQuery() {
  const hash = window.location.hash;
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return new URLSearchParams();
  return new URLSearchParams(hash.slice(qIdx + 1));
}

// ── Status / severity badge helpers ──────────────────────────────────────────

const STATUS_BADGE_CLASS = {
  pending: 'badge badge-warn',
  running: 'badge badge-info',
  done:    'badge badge-ok',
  failed:  'badge badge-danger',
};

function StatusBadge({ status }) {
  return (
    <span className={STATUS_BADGE_CLASS[status] ?? 'badge badge-neutral'}>
      {status}
    </span>
  );
}

function SeverityBadge({ severity }) {
  return (
    <span className={`badge badge-sev-${severity ?? 'info'}`} style={{ textTransform: 'uppercase', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em' }}>
      {severity}
    </span>
  );
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Review filters bar ────────────────────────────────────────────────────────

function ReviewFiltersBar({ filters, repos, onChange }) {
  const hasActiveFilters = filters.q || filters.status || filters.repository ||
    filters.dateFrom || filters.dateTo || filters.type || filters.runBy !== 'everyone';

  return (
    <div role="search" aria-label="Code review filters" className="filter-bar">
      {/* Search */}
      <input
        type="search"
        placeholder="Search branch or ref…"
        value={filters.q}
        onChange={(e) => onChange({ ...filters, q: e.target.value })}
        aria-label="Search reviews"
      />

      {/* Run by */}
      <select
        value={filters.runBy}
        onChange={(e) => onChange({ ...filters, runBy: e.target.value })}
        aria-label="Filter by who ran the review"
      >
        <option value="everyone">Everyone</option>
        <option value="me">Me</option>
      </select>

      {/* Status */}
      <select
        value={filters.status}
        onChange={(e) => onChange({ ...filters, status: e.target.value })}
        aria-label="Filter by review status"
      >
        <option value="">All statuses</option>
        <option value="pending">Pending</option>
        <option value="running">Running</option>
        <option value="done">Done</option>
        <option value="failed">Failed</option>
      </select>

      {/* Type */}
      <select
        value={filters.type}
        onChange={(e) => onChange({ ...filters, type: e.target.value })}
        aria-label="Filter by review type"
      >
        <option value="">All types</option>
        <option value="pr">PR review</option>
        <option value="scan">Full scan</option>
      </select>

      {/* Repository */}
      {repos.length > 0 && (
        <select
          value={filters.repository}
          onChange={(e) => onChange({ ...filters, repository: e.target.value })}
          aria-label="Filter by repository"
        >
          <option value="">All repositories</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      )}

      {/* Date range */}
      <span aria-hidden="true" className="muted" style={{ alignSelf: 'center', fontSize: '0.84rem', whiteSpace: 'nowrap' }}>From</span>
      <input
        type="date"
        value={filters.dateFrom}
        onChange={(e) => onChange({ ...filters, dateFrom: e.target.value })}
        aria-label="Filter from date"
      />
      <span aria-hidden="true" className="muted" style={{ alignSelf: 'center', fontSize: '0.84rem' }}>to</span>
      <input
        type="date"
        value={filters.dateTo}
        onChange={(e) => onChange({ ...filters, dateTo: e.target.value })}
        aria-label="Filter to date"
      />

      {/* Clear */}
      {hasActiveFilters && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => onChange({ q: '', runBy: 'everyone', status: '', type: '', repository: '', dateFrom: '', dateTo: '' })}
          aria-label="Clear all filters"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

// ── New Review Modal ──────────────────────────────────────────────────────────

function NewReviewModal({ projectId, repos, onClose, onCreated }) {
  const [form, setForm] = useState({
    repoId: repos[0]?.id ?? '',
    baseRef: 'main',
    headRef: '',
    prNumber: '',
    postMode: 'draft',
    minSeverity: 'medium',
    jiraKey: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const trapRef = useFocusTrap();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !loading) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, loading]);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const body = {
        repoId: form.repoId || undefined,
        baseRef: form.baseRef,
        headRef: form.headRef || form.prNumber,
        postMode: form.postMode,
        minSeverity: form.minSeverity,
      };
      if (form.prNumber) body.prNumber = Number(form.prNumber);
      if (form.jiraKey.trim()) body.jiraKey = form.jiraKey.trim();
      const r = await api.post(`/api/projects/${projectId}/reviews`, body);
      onCreated(r.review);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && !loading && onClose()}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New code review"
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title">New code review</h2>
          <button type="button" className="btn-icon" onClick={onClose} disabled={loading} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <div className="dialog-body stack">
            {repos.length > 0 && (
              <div className="field">
                <label htmlFor="nr-repo">Repository</label>
                <select
                  id="nr-repo"
                  value={form.repoId}
                  onChange={(e) => setForm((f) => ({ ...f, repoId: e.target.value }))}
                >
                  <option value="">None</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label htmlFor="nr-base">Base branch / ref</label>
              <input
                id="nr-base"
                type="text"
                value={form.baseRef}
                onChange={(e) => setForm((f) => ({ ...f, baseRef: e.target.value }))}
                placeholder="main"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="nr-head">Head branch / ref</label>
              <input
                id="nr-head"
                type="text"
                value={form.headRef}
                onChange={(e) => setForm((f) => ({ ...f, headRef: e.target.value }))}
                placeholder="feature/my-branch"
              />
            </div>

            <div className="field">
              <label htmlFor="nr-pr">PR number <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
              <input
                id="nr-pr"
                type="number"
                value={form.prNumber}
                onChange={(e) => setForm((f) => ({ ...f, prNumber: e.target.value }))}
                placeholder="123"
                min="1"
              />
            </div>

            <div className="field">
              <label htmlFor="nr-jira">Jira ticket key <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
              <input
                id="nr-jira"
                type="text"
                value={form.jiraKey}
                onChange={(e) => setForm((f) => ({ ...f, jiraKey: e.target.value }))}
                placeholder="e.g. PROJ-123 — auto-detected from branch when blank"
                aria-describedby="jira-key-hint"
              />
              <span id="jira-key-hint" className="field-hint">
                Leave blank to auto-detect from the branch name (e.g. feature/PROJ-123-my-feature).
              </span>
            </div>

            <div className="row wrap">
              <div className="field">
                <label htmlFor="nr-post">Post mode</label>
                <select
                  id="nr-post"
                  value={form.postMode}
                  onChange={(e) => setForm((f) => ({ ...f, postMode: e.target.value }))}
                >
                  <option value="draft">Draft (approve before posting)</option>
                  <option value="auto">Auto (post immediately)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="nr-sev">Min severity</label>
                <select
                  id="nr-sev"
                  value={form.minSeverity}
                  onChange={(e) => setForm((f) => ({ ...f, minSeverity: e.target.value }))}
                >
                  <option value="info">Info</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>

            {error && <p className="error-note" role="alert">{error}</p>}
          </div>

          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || (!form.headRef && !form.prNumber)}
            >
              {loading ? 'Creating…' : 'Create review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Findings panel ────────────────────────────────────────────────────────────

function FindingsPanel({ projectId, review, isAdmin, onPostSuccess }) {
  const [findings, setFindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(`/api/projects/${projectId}/reviews/${review.id}/findings`);
      setFindings(r.findings || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, review.id]);

  useEffect(() => { load(); }, [load]);

  const accept = async (fid, accepted) => {
    try {
      await api.put(`/api/projects/${projectId}/reviews/${review.id}/findings/${fid}`, { accepted });
      setFindings((prev) => prev.map((f) => f.id === fid ? { ...f, accepted } : f));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const postToGithub = async () => {
    setPosting(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/reviews/${review.id}/post`, {});
      onPostSuccess?.(r);
      toast(r.message, 'ok');
    } catch (e) {
      setError(e.message);
    } finally {
      setPosting(false);
    }
  };

  if (loading) return <div style={{ padding: 12 }}><span className="spinner" aria-label="Loading findings…" /></div>;

  const canPost = isAdmin && review.post_mode === 'draft' && review.status === 'done';

  return (
    <>
    <div style={{ padding: '12px 0' }}>
      {error && <p className="error-note" role="alert" style={{ marginBottom: 8 }}>{error}</p>}

      {canPost && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={postToGithub}
            disabled={posting}
          >
            {posting ? 'Posting…' : '📤 Post to GitHub'}
          </button>
          <span className="muted" style={{ fontSize: '0.84rem' }}>
            {findings.filter((f) => !f.posted_at && f.accepted !== -1).length} findings eligible
          </span>
        </div>
      )}

      {findings.length === 0 ? (
        <p className="muted" style={{ fontSize: '0.88rem' }}>No findings yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {findings.map((f) => (
            <li
              key={f.id}
              className={`finding-item finding-item-${f.severity ?? 'info'}${f.accepted === -1 ? ' is-dismissed' : ''}`}
            >
              <div className="row wrap" style={{ gap: 8, marginBottom: 4 }}>
                <SeverityBadge severity={f.severity} />
                <code style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                  {f.file_path}{f.line_number ? `:${f.line_number}` : ''}
                </code>
                {f.posted_at && (
                  <span className="badge badge-ok" style={{ fontSize: '0.72rem' }}>posted</span>
                )}
              </div>
              <p style={{ margin: '4px 0', fontWeight: 600, fontSize: '0.9rem' }}>{f.title}</p>
              <p style={{ margin: '4px 0', fontSize: '0.84rem', color: 'var(--ink-2)' }}>{f.body}</p>
              {f.confidence != null && (
                <p className="muted" style={{ margin: '2px 0', fontSize: '0.8rem' }}>
                  Confidence: {Math.round(f.confidence * 100)}%
                </p>
              )}
              <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {f.accepted !== 1 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ background: 'var(--ok-wash)', borderColor: 'color-mix(in srgb, var(--ok) 35%, transparent)' }}
                    onClick={() => accept(f.id, 1)}
                    aria-label="Accept finding"
                  >
                    ✓ Accept
                  </button>
                )}
                {f.accepted !== -1 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ background: 'var(--danger-wash)', borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)' }}
                    onClick={() => accept(f.id, -1)}
                    aria-label="Dismiss finding"
                  >
                    ✕ Dismiss
                  </button>
                )}
                {f.accepted !== 0 && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => accept(f.id, 0)}
                    aria-label="Reset finding status"
                  >
                    Reset
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
    <ToastShelf toasts={toasts} onRemove={removeToast} />
    </>
  );
}

// ── Review row ─────────────────────────────────────────────────────────────────

function ReviewRow({ review, projectId, isAdmin }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li style={{ borderBottom: '1px solid var(--line-2)', padding: '12px 0' }}>
      <div className="row wrap" style={{ gap: 12 }}>
        <StatusBadge status={review.status} />
        <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>
          {review.repo_name ? `${review.repo_name}: ` : ''}
          <code style={{ background: 'var(--raised)', padding: '1px 5px', borderRadius: 'var(--radius-sm)' }}>
            {review.base_ref}
          </code>
          {' → '}
          <code style={{ background: 'var(--raised)', padding: '1px 5px', borderRadius: 'var(--radius-sm)' }}>
            {review.head_ref}
          </code>
          {review.pr_number ? ` (PR #${review.pr_number})` : ''}
        </span>
        {review.finding_count > 0 && (
          <span className="muted" style={{ fontSize: '0.84rem' }}>
            {review.finding_count} finding{review.finding_count !== 1 ? 's' : ''}
          </span>
        )}
        <span className="muted push" style={{ fontSize: '0.8rem' }}>
          {formatDate(review.created_at)}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide findings' : 'View findings'}
        </button>
        <a
          href={href(projectId, 'reviews', 'code', review.id)}
          className="btn btn-sm"
          aria-label={`Open full detail for review ${review.head_ref}`}
        >
          Open
        </a>
      </div>
      {review.summary && (
        <p className="muted" style={{ margin: '6px 0 0', fontSize: '0.84rem' }}>{review.summary}</p>
      )}
      {expanded && (
        <FindingsPanel
          projectId={projectId}
          review={review}
          isAdmin={isAdmin}
        />
      )}
    </li>
  );
}

// ── Main Review page ──────────────────────────────────────────────────────────

export default function Review({ projectId, user }) {
  const [reviews, setReviews] = useState([]);
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);

  // Read initial filters from URL hash query
  const [filters, setFilters] = useState(() => {
    const q = parseHashQuery();
    return {
      q: q.get('q') ?? '',
      runBy: q.get('runBy') ?? 'everyone',
      status: q.get('status') ?? '',
      type: q.get('type') ?? '',
      repository: q.get('repository') ?? '',
      dateFrom: q.get('dateFrom') ?? '',
      dateTo: q.get('dateTo') ?? '',
    };
  });

  // Sync filters → URL hash query
  useEffect(() => {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    if (filters.runBy !== 'everyone') params.set('runBy', filters.runBy);
    if (filters.status) params.set('status', filters.status);
    if (filters.type) params.set('type', filters.type);
    if (filters.repository) params.set('repository', filters.repository);
    if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.set('dateTo', filters.dateTo);
    const hash = window.location.hash;
    const qIdx = hash.indexOf('?');
    const base = qIdx >= 0 ? hash.slice(0, qIdx) : hash;
    const qs = params.toString();
    const newHash = qs ? `${base}?${qs}` : base;
    if (window.location.hash !== newHash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
    }
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.q) params.set('q', filters.q);
      if (filters.runBy !== 'everyone') params.set('runBy', filters.runBy);
      if (filters.status) params.set('status', filters.status);
      if (filters.type) params.set('type', filters.type);
      if (filters.repository) params.set('repository', filters.repository);
      if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) params.set('dateTo', filters.dateTo);
      const qs = params.toString();

      const [rr, repoRes] = await Promise.all([
        api.get(`/api/projects/${projectId}/reviews${qs ? `?${qs}` : ''}`),
        api.get(`/api/projects/${projectId}/repos`).catch(() => ({ repos: [] })),
      ]);
      setReviews(rr.reviews || []);
      setRepos(repoRes.repos || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, filters]);

  useEffect(() => { load(); }, [load]);

  const isAdmin = user?.is_admin;

  return (
    <>
      {/* Toolbar row — "+ New review" aligned right, matching Tests page pattern */}
      <div className="actions-row" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowModal(true)}
        >
          + New review
        </button>
      </div>

      <ReviewFiltersBar filters={filters} repos={repos} onChange={setFilters} />

      {error && (
        <div role="alert" className="error-note" style={{ marginBottom: 16 }}>
          {error}
          <button type="button" className="btn btn-sm" onClick={load} style={{ marginLeft: 8 }}>Retry</button>
        </div>
      )}

      {loading ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <div className="spinner" aria-label="Loading reviews…" />
        </div>
      ) : reviews.length === 0 ? (
        <div className="empty-state">
          <p>No reviews yet.</p>
          <p className="muted" style={{ marginTop: 6, fontSize: '0.84rem' }}>Click &quot;+ New review&quot; to start a code review.</p>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {reviews.map((r) => (
            <ReviewRow
              key={r.id}
              review={r}
              projectId={projectId}
              isAdmin={isAdmin}
            />
          ))}
        </ul>
      )}

      {showModal && (
        <NewReviewModal
          projectId={projectId}
          repos={repos}
          onClose={() => setShowModal(false)}
          onCreated={(review) => {
            setShowModal(false);
            setReviews((prev) => [review, ...prev]);
          }}
        />
      )}
    </>
  );
}
