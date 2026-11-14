/**
 * Branch Scans page — list + new scan dialog (F9).
 * Routes: #/p/:pid/reviews/branch-scans and #/p/:pid/reviews/branch-scans/:sid
 *
 * Filters are reflected in the URL hash query so lists can be shared.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { AiChoicePicker } from '../components/AiChoicePicker.jsx';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';

// ── URL hash query helpers ────────────────────────────────────────────────────

function parseHashQuery() {
  const hash = window.location.hash;
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return new URLSearchParams();
  return new URLSearchParams(hash.slice(qIdx + 1));
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Map scan statuses to badge classes defined in components.css
const SCAN_STATUS_BADGE = {
  estimating:     'badge badge-neutral',
  estimate_ready: 'badge badge-info',
  queued:         'badge badge-info',
  fetching:       'badge badge-warn',
  reviewing:      'badge badge-info',
  completed:      'badge badge-ok',
  failed:         'badge badge-danger',
};

const STATUS_LABELS = {
  estimating:     'Estimating',
  estimate_ready: 'Estimate ready',
  queued:         'Queued',
  fetching:       'Fetching',
  reviewing:      'Reviewing',
  completed:      'Completed',
  failed:         'Failed',
};

function StatusBadge({ status }) {
  return (
    <span className={SCAN_STATUS_BADGE[status] ?? 'badge badge-neutral'}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Filters bar ───────────────────────────────────────────────────────────────

function FiltersBar({ filters, repos, users, onChange }) {
  const hasActiveFilters = filters.q || filters.status || filters.repository ||
    filters.dateFrom || filters.dateTo || filters.runBy !== 'everyone';

  return (
    <div role="search" aria-label="Branch scan filters" className="filter-bar">
      {/* Search */}
      <input
        type="search"
        placeholder="Search branch or paths…"
        value={filters.q}
        onChange={(e) => onChange({ ...filters, q: e.target.value })}
        aria-label="Search scans"
      />

      {/* Run by */}
      <select
        value={filters.runBy}
        onChange={(e) => onChange({ ...filters, runBy: e.target.value })}
        aria-label="Filter by who ran the scan"
      >
        <option value="everyone">Everyone</option>
        <option value="me">Me</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name || u.email}</option>
        ))}
      </select>

      {/* Status */}
      <select
        value={filters.status}
        onChange={(e) => onChange({ ...filters, status: e.target.value })}
        aria-label="Filter by scan status"
      >
        <option value="">All statuses</option>
        <option value="estimating">Estimating</option>
        <option value="estimate_ready">Estimate ready</option>
        <option value="queued">Queued</option>
        <option value="fetching">Fetching</option>
        <option value="reviewing">Reviewing</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
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
          onClick={() => onChange({ q: '', runBy: 'everyone', status: '', repository: '', dateFrom: '', dateTo: '' })}
          aria-label="Clear all filters"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

// ── New Scan Dialog ────────────────────────────────────────────────────────────

function NewScanDialog({ projectId, repos, onClose, onCreated }) {
  const [form, setForm] = useState({
    repoId: repos[0]?.id ?? '',
    branch: '',
    includePaths: '',
    excludePaths: '',
    modelRole: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ai, setAi] = useState({});
  const trapRef = useFocusTrap();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !loading) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, loading]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.repoId) { setError('Select a repository.'); return; }
    setLoading(true);
    setError(null);
    try {
      const includePaths = form.includePaths.split('\n').map((s) => s.trim()).filter(Boolean);
      const excludePaths = form.excludePaths.split('\n').map((s) => s.trim()).filter(Boolean);
      const body = {
        repoId: form.repoId,
        branch: form.branch.trim() || undefined,
        includePaths,
        excludePaths,
        modelRole: form.modelRole.trim() || undefined,
      };
      if (ai.credentialId) { body.credentialId = ai.credentialId; if (ai.model) body.model = ai.model; }
      const r = await api.post(`/api/projects/${projectId}/scans`, body);
      onCreated(r.scan);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const overlayDismiss = useOverlayDismiss(onClose, { disabled: loading });

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-scan-title"
        ref={trapRef}
        style={{ maxWidth: 540 }}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="new-scan-title">New branch scan</h2>
          <button type="button" className="btn-icon" onClick={onClose} disabled={loading} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <div className="dialog-body stack">
            <p className="muted" style={{ fontSize: '0.84rem' }}>
              A full scan reviews a whole branch, not a diff. It starts with an estimate of files, tokens
              and cost — nothing runs until you confirm a budget.
            </p>

            {/* Repository */}
            <div className="field">
              <label htmlFor="scan-repo">Repository <span aria-hidden="true">*</span></label>
              <select
                id="scan-repo"
                value={form.repoId}
                onChange={(e) => setForm((f) => ({ ...f, repoId: e.target.value }))}
                required
                aria-required="true"
              >
                <option value="">— select repository —</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>

            {/* Branch */}
            <div className="field">
              <label htmlFor="scan-branch">
                Branch <span className="muted" style={{ fontWeight: 400 }}>(blank = default branch)</span>
              </label>
              <input
                id="scan-branch"
                type="text"
                value={form.branch}
                onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
                placeholder="main"
                aria-describedby="scan-branch-hint"
              />
              <p className="field-hint" id="scan-branch-hint">Leave blank to scan the repository's default branch.</p>
            </div>

            {/* Include paths */}
            <div className="field">
              <label htmlFor="scan-include">
                Include paths <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
              </label>
              <textarea
                id="scan-include"
                rows={3}
                value={form.includePaths}
                onChange={(e) => setForm((f) => ({ ...f, includePaths: e.target.value }))}
                placeholder={'src/**/*.ts\nlib/**/*.js'}
                aria-describedby="scan-include-hint"
                style={{ fontFamily: 'var(--mono)', fontSize: '0.84rem' }}
              />
              <p className="field-hint" id="scan-include-hint">One glob pattern per line. Leave blank to include all files.</p>
            </div>

            {/* Exclude paths */}
            <div className="field">
              <label htmlFor="scan-exclude">
                Exclude paths <span className="muted" style={{ fontWeight: 400 }}>(gitignore-style, optional)</span>
              </label>
              <textarea
                id="scan-exclude"
                rows={3}
                value={form.excludePaths}
                onChange={(e) => setForm((f) => ({ ...f, excludePaths: e.target.value }))}
                placeholder={'node_modules/**\ndist/**\n**/*.test.ts'}
                aria-describedby="scan-exclude-hint"
                style={{ fontFamily: 'var(--mono)', fontSize: '0.84rem' }}
              />
              <p className="field-hint" id="scan-exclude-hint">One gitignore-style pattern per line.</p>
            </div>

            {/* Model role */}
            <div className="field">
              <label htmlFor="scan-model-role">
                Model role <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="scan-model-role"
                type="text"
                value={form.modelRole}
                onChange={(e) => setForm((f) => ({ ...f, modelRole: e.target.value }))}
                placeholder="e.g. Security-focused code reviewer"
                aria-describedby="scan-model-role-hint"
              />
              <p className="field-hint" id="scan-model-role-hint">Custom instruction prepended to the model's system prompt for this scan.</p>
            </div>

            <div className="row wrap">
              <AiChoicePicker onChange={setAi} disabled={loading} idPrefix="scan-ai" allowPortalDefault />
            </div>
            <p className="field-hint">Which engine and model review each file, as in a new session. Portal default uses the portal's provider (LiteLLM, Anthropic or Bedrock), or your own sign-in when the portal has none.</p>

            {error && <p className="error-note" role="alert">{error}</p>}
          </div>

          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading || !form.repoId}
            >
              {loading ? 'Creating…' : 'Estimate scan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Scan row ──────────────────────────────────────────────────────────────────

function ScanRow({ scan, projectId, repos }) {
  const repoName = repos.find((r) => r.id === scan.repo_id)?.name ?? scan.repo_id ?? '—';
  const scanHref = `#/p/${encodeURIComponent(projectId)}/reviews/branch-scans/${encodeURIComponent(scan.id)}`;

  return (
    <li style={{ borderBottom: '1px solid var(--line-2)', padding: '12px 0' }}>
      <div className="row wrap" style={{ gap: 12 }}>
        <StatusBadge status={scan.status} />
        <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>
          {repoName}
          {scan.branch ? (
            <>
              {' / '}
              <code style={{ background: 'var(--raised)', padding: '1px 5px', borderRadius: 'var(--radius-sm)', fontSize: '0.84rem' }}>
                {scan.branch}
              </code>
            </>
          ) : (
            <span className="muted" style={{ fontWeight: 400 }}> (default branch)</span>
          )}
        </span>
        {scan.files_total > 0 && (
          <span className="muted" style={{ fontSize: '0.84rem' }}>
            {scan.files_done}/{scan.files_total} files
          </span>
        )}
        {scan.estimated_cost_usd != null && (
          <span className="muted" style={{ fontSize: '0.84rem' }}>
            est. ${scan.estimated_cost_usd.toFixed(4)}
          </span>
        )}
        <span className="muted push" style={{ fontSize: '0.8rem' }}>
          {formatRelative(scan.created_at)}
        </span>
        <a
          href={scanHref}
          className="btn btn-sm"
          aria-label={`Open scan for ${repoName}`}
        >
          Open
        </a>
      </div>
      {scan.fail_reason && (
        <p className="muted" style={{ fontSize: '0.84rem', marginTop: 6, color: 'var(--danger)' }}>
          {scan.fail_reason}
        </p>
      )}
    </li>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BranchScans({ projectId, user }) {
  const [scans, setScans]       = useState([]);
  const [repos, setRepos]       = useState([]);
  const [users, setUsers]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [showNew, setShowNew]   = useState(false);
  const [canScan, setCanScan]   = useState(null); // null = loading, true/false = resolved
  const isAdmin = Boolean(user?.is_admin);

  // Read initial filters from URL hash query
  const [filters, setFilters] = useState(() => {
    const q = parseHashQuery();
    return {
      q: q.get('q') ?? '',
      runBy: q.get('runBy') ?? 'everyone',
      status: q.get('status') ?? '',
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
      window.location.hash = newHash;
    }
  }, [filters]);

  const load = useCallback(async () => {
    let ignore = false;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.q) params.set('q', filters.q);
      if (filters.runBy !== 'everyone') params.set('runBy', filters.runBy);
      if (filters.status) params.set('status', filters.status);
      if (filters.repository) params.set('repository', filters.repository);
      if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) params.set('dateTo', filters.dateTo);

      const qs = params.toString();
      const [scanRes, repoRes] = await Promise.all([
        api.get(`/api/projects/${projectId}/scans${qs ? `?${qs}` : ''}`),
        api.get(`/api/projects/${projectId}/repos`).catch(() => ({ repos: [] })),
      ]);
      if (ignore) return;
      setScans(scanRes.scans || []);
      setRepos(repoRes.repos || []);

      if (isAdmin) {
        setCanScan(true);
      } else {
        try {
          const al = await api.get('/api/scans/allowlist');
          if (ignore) return;
          const myId = user?.id;
          const list = al.users || [];
          setCanScan(myId ? list.includes(myId) : list.length === 0);
        } catch (e) {
          if (ignore) return;
          setCanScan(false);
        }
      }
    } catch (e) {
      if (ignore) return;
      setError(e.message);
    } finally {
      if (!ignore) setLoading(false);
    }
    return () => { ignore = true; };
  }, [projectId, filters, isAdmin]);

  useEffect(() => {
    let ignore = false;
    api.get(`/api/projects/${projectId}/members`)
      .then((r) => { if (!ignore) setUsers(r.members || []); })
      .catch(() => { if (!ignore) setUsers([]); });
    return () => { ignore = true; };
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      {/* Toolbar — description + New scan button */}
      <div className="actions-row">
        <p className="muted" style={{ margin: 0, fontSize: '0.84rem', flex: 1 }}>
          Full-branch code review — reviews every file on a branch, not just a diff.
        </p>
        {canScan === false ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled
            title="Full scans are limited to a list of people. Ask an administrator to add you. Pull request reviews are not affected."
            aria-disabled="true"
            aria-label="New scan (not permitted)"
          >
            <Icon name="plus" size={14} />
            New scan
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowNew(true)}
            disabled={canScan === null}
            aria-label="Start a new branch scan"
          >
            <Icon name="plus" size={14} />
            New scan
          </button>
        )}
      </div>

      {canScan === false && (
        <div
          role="note"
          style={{
            background: 'var(--warn-wash)',
            border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
            borderRadius: 'var(--radius)',
            padding: '10px 14px',
            marginBottom: 16,
            fontSize: '0.84rem',
            color: 'var(--warn)',
          }}
        >
          Full scans are limited to a list of people. Ask an administrator to add you.{' '}
          Pull request reviews are not affected.
        </div>
      )}

      <FiltersBar
        filters={filters}
        repos={repos}
        users={users}
        onChange={setFilters}
      />

      {error && (
        <div className="error-note" role="alert" style={{ marginBottom: 16 }}>
          {error}
          <button type="button" className="btn btn-sm" onClick={load} style={{ marginLeft: 8 }}>Retry</button>
        </div>
      )}

      {loading ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <div className="spinner" aria-label="Loading scans…" />
        </div>
      ) : scans.length === 0 ? (
        <div className="empty-state">
          <p>No branch scans found.</p>
          <p className="muted" style={{ marginTop: 6, fontSize: '0.84rem' }}>Click "New scan" to start a full-branch code review.</p>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {scans.map((s) => (
            <ScanRow
              key={s.id}
              scan={s}
              projectId={projectId}
              repos={repos}
            />
          ))}
        </ul>
      )}

      {showNew && (
        <NewScanDialog
          projectId={projectId}
          repos={repos}
          onClose={() => setShowNew(false)}
          onCreated={(scan) => {
            setShowNew(false);
            navigate(`/p/${projectId}/reviews/branch-scans/${scan.id}`);
          }}
        />
      )}
    </>
  );
}
