import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const SEVERITY_COLORS = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#d97706',
  low: '#65a30d',
  info: '#2563eb',
};

const STATUS_COLORS = {
  pending: '#6b7280',
  running: '#2563eb',
  done: '#16a34a',
  failed: '#dc2626',
};

function SeverityBadge({ severity }) {
  return (
    <span
      style={{
        background: SEVERITY_COLORS[severity] ?? '#6b7280',
        color: '#fff',
        borderRadius: 4,
        padding: '1px 8px',
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
      }}
    >
      {severity}
    </span>
  );
}

function StatusBadge({ status }) {
  return (
    <span
      style={{
        background: STATUS_COLORS[status] ?? '#6b7280',
        color: '#fff',
        borderRadius: 4,
        padding: '1px 8px',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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
      role="dialog"
      aria-modal="true"
      aria-label="New code review"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: 440, maxWidth: '95vw' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>New Code Review</h2>
        <form onSubmit={submit}>
          {repos.length > 0 && (
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>Repository</span>
              <select
                value={form.repoId}
                onChange={(e) => setForm((f) => ({ ...f, repoId: e.target.value }))}
                style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}
              >
                <option value="">None</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </label>
          )}

          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>Base branch / ref</span>
            <input
              value={form.baseRef}
              onChange={(e) => setForm((f) => ({ ...f, baseRef: e.target.value }))}
              placeholder="main"
              required
              style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, boxSizing: 'border-box' }}
            />
          </label>

          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>Head branch / ref</span>
            <input
              value={form.headRef}
              onChange={(e) => setForm((f) => ({ ...f, headRef: e.target.value }))}
              placeholder="feature/my-branch"
              style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, boxSizing: 'border-box' }}
            />
          </label>

          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>PR number (optional)</span>
            <input
              type="number"
              value={form.prNumber}
              onChange={(e) => setForm((f) => ({ ...f, prNumber: e.target.value }))}
              placeholder="123"
              min="1"
              style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, boxSizing: 'border-box' }}
            />
          </label>

          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <label style={{ flex: 1 }}>
              <span style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>Post mode</span>
              <select
                value={form.postMode}
                onChange={(e) => setForm((f) => ({ ...f, postMode: e.target.value }))}
                style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}
              >
                <option value="draft">Draft (approve before posting)</option>
                <option value="auto">Auto (post immediately)</option>
              </select>
            </label>

            <label style={{ flex: 1 }}>
              <span style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>Min severity</span>
              <select
                value={form.minSeverity}
                onChange={(e) => setForm((f) => ({ ...f, minSeverity: e.target.value }))}
                style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}
              >
                <option value="info">Info</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
          </div>

          {error && <p style={{ color: '#dc2626', margin: '8px 0', fontSize: 14 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer' }}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || (!form.headRef && !form.prNumber)}
              style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', opacity: loading ? 0.7 : 1 }}
            >
              {loading ? 'Creating…' : 'Create Review'}
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
      alert(e.message);
    }
  };

  const postToGithub = async () => {
    setPosting(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/reviews/${review.id}/post`, {});
      onPostSuccess?.(r);
      alert(r.message);
    } catch (e) {
      setError(e.message);
    } finally {
      setPosting(false);
    }
  };

  if (loading) return <div style={{ padding: 12, color: '#6b7280' }}>Loading findings…</div>;

  const canPost = isAdmin && review.post_mode === 'draft' && review.status === 'done';

  return (
    <div style={{ padding: '12px 0' }}>
      {error && <p style={{ color: '#dc2626', fontSize: 14, margin: '0 0 8px' }}>{error}</p>}

      {canPost && (
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={postToGithub}
            disabled={posting}
            style={{
              padding: '6px 14px', background: '#16a34a', color: '#fff',
              border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 14,
              opacity: posting ? 0.7 : 1,
            }}
          >
            {posting ? 'Posting…' : '📤 Post to GitHub'}
          </button>
          <span style={{ marginLeft: 8, fontSize: 13, color: '#6b7280' }}>
            {findings.filter((f) => !f.posted_at && f.accepted !== -1).length} findings eligible
          </span>
        </div>
      )}

      {findings.length === 0 ? (
        <p style={{ color: '#6b7280', fontSize: 14 }}>No findings yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {findings.map((f) => (
            <li
              key={f.id}
              style={{
                borderLeft: `3px solid ${SEVERITY_COLORS[f.severity] ?? '#6b7280'}`,
                padding: '8px 12px',
                marginBottom: 8,
                background: f.accepted === -1 ? '#f9fafb' : '#fff',
                borderRadius: '0 4px 4px 0',
                opacity: f.accepted === -1 ? 0.5 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <SeverityBadge severity={f.severity} />
                <code style={{ fontSize: 13, color: '#374151' }}>
                  {f.file_path}{f.line_number ? `:${f.line_number}` : ''}
                </code>
                {f.posted_at && (
                  <span style={{ fontSize: 11, color: '#16a34a' }}>✓ posted</span>
                )}
              </div>
              <p style={{ margin: '4px 0', fontWeight: 500, fontSize: 14 }}>{f.title}</p>
              <p style={{ margin: '4px 0', fontSize: 13, color: '#374151' }}>{f.body}</p>
              {f.confidence != null && (
                <p style={{ margin: '2px 0', fontSize: 12, color: '#6b7280' }}>
                  Confidence: {Math.round(f.confidence * 100)}%
                </p>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {f.accepted !== 1 && (
                  <button
                    onClick={() => accept(f.id, 1)}
                    aria-label="Accept finding"
                    style={{ padding: '3px 10px', fontSize: 12, background: '#dcfce7', border: '1px solid #86efac', borderRadius: 4, cursor: 'pointer' }}
                  >
                    ✓ Accept
                  </button>
                )}
                {f.accepted !== -1 && (
                  <button
                    onClick={() => accept(f.id, -1)}
                    aria-label="Dismiss finding"
                    style={{ padding: '3px 10px', fontSize: 12, background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 4, cursor: 'pointer' }}
                  >
                    ✕ Dismiss
                  </button>
                )}
                {f.accepted !== 0 && (
                  <button
                    onClick={() => accept(f.id, 0)}
                    aria-label="Reset finding status"
                    style={{ padding: '3px 10px', fontSize: 12, background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer' }}
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
  );
}

// ── Review row ────────────────────────────────────────────────────────────────

function ReviewRow({ review, projectId, isAdmin }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li style={{ borderBottom: '1px solid #f3f4f6', padding: '12px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <StatusBadge status={review.status} />
        <span style={{ fontWeight: 500, fontSize: 14 }}>
          {review.repo_name ? `${review.repo_name}: ` : ''}
          <code style={{ background: '#f3f4f6', padding: '1px 5px', borderRadius: 3 }}>
            {review.base_ref}
          </code>
          {' → '}
          <code style={{ background: '#f3f4f6', padding: '1px 5px', borderRadius: 3 }}>
            {review.head_ref}
          </code>
          {review.pr_number ? ` (PR #${review.pr_number})` : ''}
        </span>
        {review.finding_count > 0 && (
          <span style={{ fontSize: 13, color: '#6b7280' }}>
            {review.finding_count} finding{review.finding_count !== 1 ? 's' : ''}
          </span>
        )}
        <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto' }}>
          {formatDate(review.created_at)}
        </span>
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          style={{
            padding: '4px 10px', fontSize: 13,
            border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff', cursor: 'pointer',
          }}
        >
          {expanded ? 'Hide findings' : 'View findings'}
        </button>
      </div>
      {review.summary && (
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#6b7280' }}>{review.summary}</p>
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rr, repoRes] = await Promise.all([
        api.get(`/api/projects/${projectId}/reviews`),
        api.get(`/api/projects/${projectId}/repositories`).catch(() => ({ repositories: [] })),
      ]);
      setReviews(rr.reviews || []);
      setRepos(repoRes.repositories || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const isAdmin = user?.is_admin;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Code Review</h1>
        <button
          onClick={() => setShowModal(true)}
          style={{
            padding: '8px 16px', background: '#2563eb', color: '#fff',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 500,
          }}
        >
          + New review
        </button>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 4, padding: '8px 12px', marginBottom: 16, color: '#dc2626' }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading reviews…</p>
      ) : reviews.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: '#6b7280' }}>
          <p style={{ fontSize: 16, margin: '0 0 8px' }}>No reviews yet.</p>
          <p style={{ fontSize: 14 }}>Click "+ New review" to start a code review.</p>
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
    </div>
  );
}
