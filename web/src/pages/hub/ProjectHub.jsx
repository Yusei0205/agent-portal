import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../lib/api.js';
import { navigate } from '../../lib/router.js';
import { formatRelative } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../../components/Toast.jsx';
import { PageHeader, SectionHead } from '../../components/PageHeader.jsx';

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CLASS = {
  new:     'badge-neutral',
  cloning: 'badge-info',
  syncing: 'badge-info',
  ready:   'badge-success',
  error:   'badge-error',
};

function StatusBadge({ status }) {
  const cls = STATUS_CLASS[status] || 'badge-neutral';
  return <span className={`badge ${cls}`}>{status}</span>;
}

// ── Clone / sync progress helpers ────────────────────────────────────────────

const PHASE_ORDER = ['connecting','counting','compressing','receiving','resolving','checkout','finalizing'];
const STEP_PHASES = ['connecting','receiving','resolving','checkout'];
const STEP_LABELS = { connecting:'Connecting', receiving:'Receiving', resolving:'Resolving', checkout:'Checkout' };

/** True while any operation (clone or re-sync) is running on this repo. */
function isRepoInProgress(r) {
  return r.status === 'cloning' || r.status === 'syncing' || r.progress != null;
}

/** "45s" or "1m 12s" since startedAt ISO string. */
function formatElapsed(startedAt) {
  if (!startedAt) return '';
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/**
 * Compact progress bar shown inside a repo card while cloning/syncing.
 * Respects prefers-reduced-motion for the indeterminate animation.
 */
function RepoProgressBar({ repoName, progress }) {
  const [elapsed, setElapsed] = useState(() => formatElapsed(progress.startedAt));

  useEffect(() => {
    const tid = setInterval(() => setElapsed(formatElapsed(progress.startedAt)), 1000);
    return () => clearInterval(tid);
  }, [progress.startedAt]);

  const { phase, phaseLabel, percent, detail } = progress;
  const isDeterminate = percent !== null && percent !== undefined;
  const phaseIdx      = PHASE_ORDER.indexOf(phase ?? '');

  return (
    <div className="repo-progress">
      {/* Phase label + percent + elapsed */}
      <div className="repo-progress-header">
        <span className="repo-progress-phase">{phaseLabel || phase || 'Starting…'}</span>
        <span className="repo-progress-pct">
          {isDeterminate ? `${Math.round(percent)}% · ` : ''}{elapsed}
        </span>
      </div>

      {/* Progress bar — determinate or indeterminate */}
      <div
        className="progress-track"
        role="progressbar"
        aria-label={`${repoName} clone progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(isDeterminate ? { 'aria-valuenow': Math.round(percent) } : {})}
      >
        <div
          className={`progress-fill${isDeterminate ? '' : ' is-indeterminate'}`}
          style={isDeterminate ? { width: `${Math.max(2, percent)}%` } : undefined}
        />
      </div>

      {/* Speed / object count detail */}
      {detail && <div className="repo-progress-detail">{detail}</div>}

      {/* Abbreviated phase steps */}
      <div className="repo-phase-steps" aria-hidden="true">
        {STEP_PHASES.map((p, i) => {
          const idx      = PHASE_ORDER.indexOf(p);
          const isDone   = phaseIdx > idx;
          const isActive = phaseIdx === idx;
          return [
            i > 0 ? <span key={`sep-${p}`} className="repo-phase-sep">→</span> : null,
            <span
              key={p}
              className={`repo-phase-step${isActive ? ' is-active' : isDone ? ' is-done' : ''}`}
            >
              {STEP_LABELS[p]}
            </span>,
          ];
        })}
      </div>
    </div>
  );
}

// ── Add repos modal (Browse connection + URL tabs) ───────────────────────────

function AddReposModal({ projectId, existingRepos, onNewRepos, onClose }) {
  const dialogRef  = useFocusTrap();
  const searchRef  = useRef(null);

  // ── UI tabs ───────────────────────────────────────────────────────────────
  const [addTab, setAddTab] = useState('browse'); // 'browse' | 'url'

  // ── Browse tab state ──────────────────────────────────────────────────────
  const [connections,    setConnections]    = useState([]);
  const [connsLoading,   setConnsLoading]   = useState(true);
  const [connId,         setConnId]         = useState('');
  const [search,         setSearch]         = useState('');
  const [debouncedSearch,setDebouncedSearch]= useState('');
  const [workspace,      setWorkspace]      = useState('');
  const [workspaces,     setWorkspaces]     = useState([]); // Bitbucket workspace list
  const [repoList,       setRepoList]       = useState(null);
  const [repoLoading,    setRepoLoading]    = useState(false);
  const [repoError,      setRepoError]      = useState(null);
  const [nextPage,       setNextPage]       = useState(null);
  const [loadingMore,    setLoadingMore]    = useState(false);
  const [region,         setRegion]         = useState(null); // CodeCommit region from last repos response
  const [loadMoreError,  setLoadMoreError]  = useState(null); // error from "Load more"
  const [selected,       setSelected]       = useState(new Set()); // fullName → true
  const [adding,         setAdding]         = useState(false);
  const [addError,       setAddError]       = useState(null);
  const [addSummary,     setAddSummary]     = useState(null); // { added, skipped, errors }

  // ── URL tab state ─────────────────────────────────────────────────────────
  const [urlName,     setUrlName]     = useState('');
  const [urlUrl,      setUrlUrl]      = useState('');
  const [urlProvider, setUrlProvider] = useState('github');
  const [urlBranch, setUrlBranch] = useState('');
  const [bulkBranch, setBulkBranch] = useState('');
  const [urlAdding,   setUrlAdding]   = useState(false);
  const [urlError,    setUrlError]    = useState(null);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Load connections on mount
  useEffect(() => {
    api.get('/api/git-connections')
      .then((r) => {
        const list = r.connections || [];
        setConnections(list);
        if (list.length > 0) setConnId(list[0].id);
      })
      .catch(() => {})
      .finally(() => setConnsLoading(false));
  }, []);

  // Fetch repos when connection / search / workspace changes
  useEffect(() => {
    if (!connId) { setRepoList(null); return; }
    let cancelled = false;
    setRepoLoading(true);
    setRepoError(null);
    setNextPage(null);
    setRegion(null);
    setLoadMoreError(null);

    const params = new URLSearchParams();
    if (debouncedSearch) params.set('q', debouncedSearch);
    if (workspace)       params.set('workspace', workspace);

    api.get(`/api/git-connections/${connId}/repos?${params}`)
      .then((r) => {
        if (cancelled) return;
        setRepoList(r.repos || []);
        setNextPage(r.nextPage || null);
        if (r.workspaces) setWorkspaces(r.workspaces);
        if (r.region)     setRegion(r.region);
        // HTTP 200 with { repos: [], error: "…" } means the provider failed
        if (r.error)      setRepoError(r.error);
      })
      .catch((e) => {
        if (cancelled) return;
        setRepoError(e.message);
        setRepoList(null);
      })
      .finally(() => { if (!cancelled) setRepoLoading(false); });

    return () => { cancelled = true; };
  }, [connId, debouncedSearch, workspace]);

  const loadMore = async () => {
    if (!nextPage || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('q', debouncedSearch);
    if (workspace)       params.set('workspace', workspace);
    params.set('page', nextPage);
    try {
      const r = await api.get(`/api/git-connections/${connId}/repos?${params}`);
      setRepoList((prev) => [...(prev || []), ...(r.repos || [])]);
      setNextPage(r.nextPage || null);
      // HTTP 200 with { repos: [], error: "…" } means the provider failed mid-pagination
      if (r.error) setLoadMoreError(r.error);
    } catch (e) {
      setLoadMoreError(e.message || 'Failed to load more repositories');
    } finally {
      setLoadingMore(false);
    }
  };

  // Existing repo URLs for "Already added" detection
  const existingUrls = new Set((existingRepos || []).map((r) => r.url));

  const isAdded = (repo) =>
    existingUrls.has(repo.url) || existingUrls.has(repo.fullName);

  const toggleSelect = (repo) => {
    if (isAdded(repo)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(repo.fullName)) next.delete(repo.fullName);
      else next.add(repo.fullName);
      return next;
    });
  };

  const selectablePage  = (repoList || []).filter((r) => !isAdded(r));
  const allPageSelected = selectablePage.length > 0 && selectablePage.every((r) => selected.has(r.fullName));

  const toggleSelectAll = () => {
    if (allPageSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        selectablePage.forEach((r) => next.delete(r.fullName));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        selectablePage.forEach((r) => next.add(r.fullName));
        return next;
      });
    }
  };

  const selectedRepos = (repoList || []).filter((r) => selected.has(r.fullName));

  const bulkAdd = async () => {
    if (selectedRepos.length === 0 || !connId) return;
    setAdding(true);
    setAddError(null);
    setAddSummary(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/repos/bulk`, {
        connectionId: connId,
        repos: selectedRepos.map((r) => ({
          url:           r.url,
          name:          r.name,
          defaultBranch: bulkBranch.trim() || r.defaultBranch,
        })),
      });
      const added   = Array.isArray(r.added)   ? r.added   : [];
      const skipped = Array.isArray(r.skipped) ? r.skipped : [];
      setAddSummary({ added, skipped, errors: r.errors || [] });
      if (added.length > 0) {
        onNewRepos(added); // use real repo rows returned by the server
      }
      setSelected(new Set());
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const addByUrl = async (e) => {
    e.preventDefault();
    if (!urlName.trim()) { setUrlError('Name is required.'); return; }
    if (!urlUrl.trim())  { setUrlError('URL is required.');  return; }
    setUrlAdding(true);
    setUrlError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/repos`, {
        name:     urlName.trim(),
        url:      urlUrl.trim(),
        provider: urlProvider,
        ...(urlBranch.trim() ? { defaultBranch: urlBranch.trim() } : {}),
      });
      onNewRepos([r.repo]);
      onClose();
    } catch (err) {
      setUrlError(err.message || 'Failed to add repository');
      setUrlAdding(false);
    }
  };

  const selectedConn = connections.find((c) => c.id === connId);
  const isBitbucket  = selectedConn?.provider === 'bitbucket';

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="add-repos-title">
      <div className="modal modal-wide" ref={dialogRef}>
        <div className="modal-header">
          <h2 id="add-repos-title">Add repositories</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="conn-dialog-tabs" role="tablist" aria-label="Add method">
          <button
            type="button"
            role="tab"
            className={`conn-dialog-tab${addTab === 'browse' ? ' is-active' : ''}`}
            aria-selected={addTab === 'browse'}
            onClick={() => setAddTab('browse')}
          >
            Browse connection
          </button>
          <button
            type="button"
            role="tab"
            className={`conn-dialog-tab${addTab === 'url' ? ' is-active' : ''}`}
            aria-selected={addTab === 'url'}
            onClick={() => setAddTab('url')}
          >
            Add by URL
          </button>
        </div>

        {/* ── Browse tab ──────────────────────────────────────── */}
        {addTab === 'browse' && (
          <div className="stack">
            {connsLoading ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--ink-3)', fontSize: '0.84rem' }}>
                <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading connections…" />
                Loading connections…
              </div>
            ) : connections.length === 0 ? (
              <div className="card">
                <p className="muted" style={{ fontSize: '0.84rem' }}>
                  No Git connections configured.{' '}
                  <a href="#/connect/git">Add a connection</a> first, then come back here.
                </p>
              </div>
            ) : (
              <>
                {/* Connection picker */}
                <div className="field">
                  <label htmlFor="repos-conn-id">Connection</label>
                  <select
                    id="repos-conn-id"
                    value={connId}
                    onChange={(e) => { setConnId(e.target.value); setSelected(new Set()); setSearch(''); setWorkspace(''); setAddSummary(null); }}
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.provider})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Search + workspace filter */}
                <div className="conn-search-bar">
                  <input
                    ref={searchRef}
                    type="search"
                    placeholder="Search repositories…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search repositories"
                    style={{ flex: 1, width: 'auto' }}
                  />
                  {isBitbucket && workspaces.length > 0 && (
                    <select
                      value={workspace}
                      onChange={(e) => { setWorkspace(e.target.value); setSelected(new Set()); }}
                      aria-label="Filter by workspace"
                      style={{ width: 'auto', flexShrink: 0 }}
                    >
                      <option value="">All workspaces</option>
                      {workspaces.map((w) => (
                        <option key={w} value={w}>{w}</option>
                      ))}
                    </select>
                  )}
                </div>

                {/* Select-all bar */}
                {repoList && repoList.length > 0 && !repoLoading && (
                  <div className="conn-select-bar">
                    <label>
                      <input
                        type="checkbox"
                        checked={allPageSelected}
                        onChange={toggleSelectAll}
                        aria-label="Select all repositories on this page"
                      />
                      Select all ({selectablePage.length})
                    </label>
                    {selected.size > 0 && (
                      <span className="muted" style={{ fontSize: '0.82rem', marginLeft: 'auto' }}>
                        {selected.size} selected
                      </span>
                    )}
                  </div>
                )}

                {/* Repo list */}
                {repoLoading ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--ink-3)', fontSize: '0.84rem', padding: '8px 0' }}>
                    <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading repositories…" />
                    Loading repositories…
                  </div>
                ) : repoError ? (
                  <div>
                    <p className="error-note" role="alert">{repoError}</p>
                  </div>
                ) : repoList && repoList.length === 0 ? (
                  <div className="conn-repo-list">
                    <div className="conn-repo-empty">
                      {search
                        ? `No repositories matching "${search}"`
                        : region
                          ? (
                            <>
                              No repositories found in {region}.
                              <div className="muted" style={{ marginTop: 4, fontSize: '0.82em' }}>
                                The connection's region can be changed under{' '}
                                <a href="#/connect/git">Connect › Git connections</a>.
                              </div>
                            </>
                          )
                          : 'No repositories found for this connection.'}
                    </div>
                  </div>
                ) : repoList ? (
                  <div className="conn-repo-list" role="list" aria-label="Available repositories">
                    {repoList.map((repo) => {
                      const added   = isAdded(repo);
                      const checked = selected.has(repo.fullName);
                      return (
                        <div
                          key={repo.fullName || repo.url}
                          className={`conn-repo-row${added ? ' is-added' : ''}${checked ? ' is-selected' : ''}`}
                          role="listitem"
                          onClick={() => toggleSelect(repo)}
                        >
                          <input
                            type="checkbox"
                            checked={checked || added}
                            disabled={added}
                            onChange={() => toggleSelect(repo)}
                            aria-label={`Select ${repo.fullName || repo.name}`}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div className="conn-repo-body">
                            <div className="conn-repo-name">
                              <span className="conn-repo-name-text">{repo.fullName || repo.name}</span>
                              <span className={`badge ${repo.private ? 'badge-neutral' : 'badge-ok'}`} style={{ flexShrink: 0 }}>
                                {repo.private ? 'private' : 'public'}
                              </span>
                              {added && (
                                <span className="badge badge-info" style={{ flexShrink: 0 }}>Added</span>
                              )}
                            </div>
                            {repo.description && (
                              <div className="conn-repo-desc">{repo.description}</div>
                            )}
                            <div className="conn-repo-meta">
                              {repo.defaultBranch && <span>Branch: {repo.defaultBranch}</span>}
                              {repo.updatedAt     && <span>{formatRelative(repo.updatedAt)}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {nextPage && (
                      <div className="conn-load-more">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={loadMore}
                          disabled={loadingMore}
                        >
                          {loadingMore ? 'Loading…' : 'Load more'}
                        </button>
                      </div>
                    )}
                    {loadMoreError && (
                      <p className="error-note" role="alert" style={{ margin: '8px 0 0' }}>{loadMoreError}</p>
                    )}
                  </div>
                ) : null}

                {/* Live region for status */}
                <div aria-live="polite" aria-atomic="true" className="sr-only">
                  {repoList ? `${repoList.length} repositories loaded` : ''}
                </div>

                {!addSummary && (
                  <div className="field" style={{ marginTop: 8 }}>
                    <label htmlFor="ar-bulk-branch">Default branch <span className="muted">(optional, for the selected repositories)</span></label>
                    <input id="ar-bulk-branch" type="text" value={bulkBranch} onChange={(e) => setBulkBranch(e.target.value)} placeholder="Empty: each repository's own default branch" maxLength={255} />
                  </div>
                )}

                {addError && <p className="error-note" role="alert">{addError}</p>}

                {addSummary && (
                  <div
                    className={`conn-bulk-summary ${addSummary.errors.length > 0 || addSummary.skipped.length > 0 ? 'is-warn' : 'is-ok'}`}
                    role="status"
                    aria-live="polite"
                  >
                    {addSummary.added.length > 0 && (
                      <span>✓ {addSummary.added.length} {addSummary.added.length === 1 ? 'repository' : 'repositories'} added. </span>
                    )}
                    {addSummary.skipped.length > 0 && (
                      <span>{addSummary.skipped.length} skipped (already in project). </span>
                    )}
                    {addSummary.errors.length > 0 && (
                      <span>{addSummary.errors.length} failed.</span>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="modal-footer" style={{ marginTop: 0 }}>
              <button type="button" className="btn" onClick={onClose}>
                {addSummary ? 'Close' : 'Cancel'}
              </button>
              {connections.length > 0 && !addSummary && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={bulkAdd}
                  disabled={selected.size === 0 || adding}
                  aria-disabled={selected.size === 0}
                >
                  {adding
                    ? 'Adding…'
                    : selected.size === 0
                      ? 'Add repositories'
                      : `Add ${selected.size} ${selected.size === 1 ? 'repository' : 'repositories'}`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Add by URL tab ───────────────────────────────────── */}
        {addTab === 'url' && (
          <form onSubmit={addByUrl} noValidate>
            <div className="stack">
              <div className="field">
                <label htmlFor="ar-name">Name <span aria-hidden="true">*</span></label>
                <input
                  id="ar-name"
                  type="text"
                  value={urlName}
                  onChange={(e) => setUrlName(e.target.value)}
                  required
                  autoFocus
                  placeholder="e.g. my-service"
                  aria-required="true"
                />
              </div>
              <div className="field">
                <label htmlFor="ar-url">URL <span aria-hidden="true">*</span></label>
                <input
                  id="ar-url"
                  type="url"
                  value={urlUrl}
                  onChange={(e) => setUrlUrl(e.target.value)}
                  required
                  placeholder="https://github.com/owner/repo"
                  aria-required="true"
                />
              </div>
              <div className="field">
                <label htmlFor="ar-branch">Default branch <span className="muted">(optional)</span></label>
                <input
                  id="ar-branch"
                  type="text"
                  value={urlBranch}
                  onChange={(e) => setUrlBranch(e.target.value)}
                  placeholder="e.g. main, develop (empty: the repository's own default)"
                  maxLength={255}
                />
                <p className="muted small">Agents get the full history of this repository, starting on this branch.</p>
              </div>
              <div className="field">
                <label htmlFor="ar-provider">Provider</label>
                <select id="ar-provider" value={urlProvider} onChange={(e) => setUrlProvider(e.target.value)}>
                  <option value="github">GitHub</option>
                  <option value="codecommit">AWS CodeCommit</option>
                  <option value="bitbucket">Bitbucket</option>
                  <option value="git">Other Git</option>
                </select>
              </div>
              {urlError && <p className="error-note" role="alert">{urlError}</p>}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={urlAdding}>
                {urlAdding ? 'Adding…' : 'Add repository'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Add member modal ──────────────────────────────────────────────────────────

function AddMemberModal({ projectId, onClose, onAdded }) {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/users').then((r) => setUsers(r.users || [])).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!userId) { setError('Please select a user'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/projects/${projectId}/members`, { userId, role });
      onAdded();
    } catch (err) {
      setError(err.message || 'Failed to add member');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="add-member-title">
      <div className="modal">
        <div className="modal-header">
          <h2 id="add-member-title">Add member</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="am-user">User <span aria-hidden="true">*</span></label>
            <select id="am-user" value={userId} onChange={(e) => setUserId(e.target.value)} required>
              <option value="">— select a user —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="am-role">Role</label>
            <select id="am-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="owner">Owner</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          {error && <div className="error-note" role="alert">{error}</div>}
          <div className="row gap-sm">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add member'}
            </button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab({ projectId, repos, members, onNavigateTab }) {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    api.get('/api/settings').then((s) => {
      setSettings(s);
    }).catch(() => {});
  }, []);

  const providerMode = settings?.provider?.mode;
  const isSsoAuth    = providerMode === 'bedrock' && settings?.provider?.bedrockAuth === 'sso';
  const hasProvider  = Boolean(providerMode && providerMode !== 'demo' && (!isSsoAuth || settings?.provider?.sso?.signedIn));
  const hasRepo      = repos?.some((r) => r.status === 'ready');
  const hasMember    = (members?.length ?? 0) > 1; // more than just the owner

  const linkBtnStyle = {
    color: 'var(--link, var(--accent))',
    background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit',
  };

  const checks = [
    {
      label: 'Model provider configured',
      ok: hasProvider,
      fix: <a href="#/settings" style={{ color: 'var(--link, var(--accent))' }}>Settings › Provider</a>,
    },
    {
      label: 'At least one repository cloned and ready',
      ok: hasRepo,
      fix: <button type="button" style={linkBtnStyle} onClick={() => onNavigateTab?.('repositories')}>Repositories tab</button>,
    },
    {
      label: 'At least one team member added',
      ok: hasMember,
      fix: <button type="button" style={linkBtnStyle} onClick={() => onNavigateTab?.('team')}>Team tab</button>,
    },
  ];

  return (
    <div className="stack">
      <h2>Readiness checklist</h2>
      <ul className="checklist">
        {checks.map((c) => (
          <li key={c.label} className={`checklist-item ${c.ok ? 'ok' : 'pending'}`}>
            <span className="checklist-icon" aria-hidden="true">{c.ok ? '✓' : '○'}</span>
            <span>{c.label}</span>
            {!c.ok && (
              <span className="muted small">
                {' '}— not yet{c.fix ? <> · {c.fix}</> : ''}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Repositories tab ──────────────────────────────────────────────────────────

function RepositoriesTab({ projectId, repos, setRepos, requestConfirm, toast }) {
  const [showModal,   setShowModal]   = useState(false);
  const [expanded,    setExpanded]    = useState({});
  const [branches,    setBranches]    = useState({});
  const [justSynced,  setJustSynced]  = useState({});  // { [id]: true } — brief success flash
  const [liveMessage, setLiveMessage] = useState('');  // aria-live announcement text

  // ── Progress polling ─────────────────────────────────────────────────────
  // anyInProgress flips true → false as repos finish, which both starts and
  // stops the effect.  Visibility pausing and cleanup are handled inside.
  const anyInProgress = repos.some(isRepoInProgress);

  useEffect(() => {
    if (!anyInProgress) return;

    let active = true;
    let timer  = null;

    const poll = async () => {
      if (!active) return;
      // Pause while tab is hidden; resume on visibilitychange (see listener below)
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(poll, 1500);
        return;
      }

      try {
        const r = await api.get(`/api/projects/${projectId}/repos/progress`);
        if (!active) return;

        const progressList = r.repos || [];
        const stillActive  = progressList.some(isRepoInProgress);

        // Merge lightweight progress snapshot into full repo list
        setRepos((prev) =>
          prev.map((repo) => {
            const upd = progressList.find((p) => p.id === repo.id);
            if (!upd) return repo;
            return {
              ...repo,
              status:     upd.status,
              progress:   upd.progress    ?? null,
              last_error: upd.lastError   ?? repo.last_error,
            };
          }),
        );

        if (!stillActive && progressList.length > 0) {
          // All repos done — full refresh to pick up last_synced_at / default branch.
          // Not guarded by `active` so it fires even after effect cleanup.
          const doneIds = progressList.map((p) => p.id);
          api.get(`/api/projects/${projectId}/repos`)
            .then((full) => {
              setRepos(full.repos || []);
              const synced = {};
              const failed = [];
              for (const repo of (full.repos || [])) {
                if (!doneIds.includes(repo.id)) continue;
                if (repo.status === 'ready') synced[repo.id] = true;
                if (repo.status === 'error') failed.push(repo.name);
              }
              if (Object.keys(synced).length > 0) {
                const names = (full.repos || [])
                  .filter((repo) => synced[repo.id])
                  .map((repo)  => repo.name)
                  .join(', ');
                setJustSynced(synced);
                setLiveMessage(`${names} synced successfully`);
                setTimeout(() => { setJustSynced({}); setLiveMessage(''); }, 3500);
              }
              if (failed.length > 0) {
                setLiveMessage(`Sync failed for: ${failed.join(', ')}`);
                setTimeout(() => setLiveMessage(''), 5000);
              }
            })
            .catch(() => {});
          return; // stop polling loop
        }
      } catch { /* non-fatal — keep trying */ }

      timer = setTimeout(poll, 1500);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    poll();

    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyInProgress, projectId]);

  const sync = async (repoId) => {
    try {
      await api.post(`/api/projects/${projectId}/repos/${repoId}/sync`);
      setRepos((prev) =>
        prev.map((r) => r.id === repoId
          ? { ...r, status: 'cloning', progress: null, last_error: null }
          : r),
      );
    } catch (err) {
      if (err.status === 409) {
        // Already syncing — attach to the existing progress stream
        setRepos((prev) =>
          prev.map((r) => r.id === repoId ? { ...r, status: 'cloning', last_error: null } : r),
        );
      } else {
        toast(err.message || 'Sync failed', 'error');
      }
    }
  };

  /** The branch new sessions start from for this repository. */
  const makeDefault = async (repo, branch) => {
    try {
      await api.put(`/api/projects/${projectId}/repos/${repo.id}/default-branch`, { branch });
      setRepos((prev) => prev.map((r) => r.id === repo.id ? { ...r, default_branch: branch } : r));
      setBranches((prev) => ({ ...prev, [repo.id]: [branch, ...(prev[repo.id] || []).filter((b) => b !== branch)] }));
      setLiveMessage(`${branch} is now the default branch of ${repo.name}`);
      toast(`Default branch of ${repo.name} is now ${branch}`, 'success');
    } catch (err) {
      toast(err.message || 'Could not change the default branch', 'error');
    }
  };

  const remove = async (repoId) => {
    const ok = await requestConfirm('Remove this repository from the project?', 'Remove', 'danger');
    if (!ok) return;
    try {
      await api.delete(`/api/projects/${projectId}/repos/${repoId}`);
      setRepos((prev) => prev.filter((r) => r.id !== repoId));
    } catch (err) {
      toast(err.message || 'Failed to remove repository', 'error');
    }
  };

  const toggleBranches = async (repoId) => {
    setExpanded((prev) => ({ ...prev, [repoId]: !prev[repoId] }));
    if (!branches[repoId]) {
      try {
        const r = await api.get(`/api/projects/${projectId}/repos/${repoId}/branches`);
        setBranches((prev) => ({ ...prev, [repoId]: r.branches || [] }));
      } catch {
        setBranches((prev) => ({ ...prev, [repoId]: [] }));
      }
    }
  };

  return (
    <div className="stack">
      {/* Polite live region — announces sync completion/failure to screen readers */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </div>

      <div className="row between">
        <h2>Repositories</h2>
        <button type="button" className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Icon name="plus" size={14} />
          Add repositories
        </button>
      </div>

      {repos.length === 0 && (
        <p className="muted">No repositories yet. Add one to get started.</p>
      )}

      <div className="stack">
        {repos.map((repo) => (
          <div key={repo.id} className="card">
            <div className="row between">
              <div>
                <strong>{repo.name}</strong>
                <span className="muted small" style={{ marginLeft: '0.5em' }}>{repo.provider}</span>
              </div>
              <div className="row tight">
                <StatusBadge status={repo.status} />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => sync(repo.id)}
                  disabled={isRepoInProgress(repo)}
                  aria-busy={isRepoInProgress(repo) || undefined}
                >
                  {isRepoInProgress(repo) ? 'Syncing…' : 'Sync'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => toggleBranches(repo.id)}
                  aria-expanded={Boolean(expanded[repo.id])}
                >
                  {expanded[repo.id] ? 'Hide branches' : 'Branches'}
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => remove(repo.id)}
                  aria-label={`Remove ${repo.name}`}
                  title="Remove repository"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            </div>
            <p className="muted small" style={{ marginTop: '0.25em' }}>{repo.url}</p>
            <p className="small" style={{ marginTop: '0.25em' }}>
              <span className="muted">Default branch: </span>
              <strong>{repo.default_branch || 'not set'}</strong>
              <span className="muted"> — new sessions start from it. Open <em>Branches</em> to change it.</span>
            </p>
            {repo.progress ? (
              <RepoProgressBar repoName={repo.name} progress={repo.progress} />
            ) : (
              <>
                {justSynced[repo.id] && (
                  <p className="success-note small" style={{ marginTop: '0.5em' }}>✓ Synced just now</p>
                )}
                {repo.last_error && (
                  <p className="error-note small" style={{ marginTop: '0.25em' }}>{repo.last_error}</p>
                )}
              </>
            )}
            {expanded[repo.id] && (
              <div style={{ marginTop: '0.5em' }}>
                {branches[repo.id]?.length ? (
                  <ul className="branch-list">
                    {branches[repo.id].map((b) => (
                      <li key={b} className="branch-item muted small">
                        {b}
                        {b === repo.default_branch ? (
                          <span className="badge" style={{ marginLeft: '0.5em' }}>default</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ marginLeft: '0.5em' }}
                            onClick={() => makeDefault(repo, b)}
                            aria-label={`Make ${b} the default branch of ${repo.name}`}
                          >
                            Make default
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">No branches found (repo may not be cloned yet).</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {showModal && (
        <AddReposModal
          projectId={projectId}
          existingRepos={repos}
          onNewRepos={(newRepos) => setRepos((prev) => [...prev, ...newRepos])}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

// ── Team tab ──────────────────────────────────────────────────────────────────

function TeamTab({ projectId, members, setMembers, currentUserId, isAdmin, requestConfirm, toast }) {
  const [showModal, setShowModal] = useState(false);

  const changeRole = async (userId, role) => {
    try {
      await api.put(`/api/projects/${projectId}/members/${userId}`, { role });
      setMembers((prev) =>
        prev.map((m) => m.user_id === userId ? { ...m, role, access: role } : m),
      );
    } catch (err) {
      toast(err.message || 'Failed to change role', 'error');
    }
  };

  const removeMember = async (userId) => {
    const ok = await requestConfirm('Remove this member from the project?', 'Remove', 'danger');
    if (!ok) return;
    try {
      await api.delete(`/api/projects/${projectId}/members/${userId}`);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      toast(err.message || 'Failed to remove member', 'error');
    }
  };

  const reload = async () => {
    try {
      const r = await api.get(`/api/projects/${projectId}/members`);
      setMembers(r.members || []);
    } catch { /* best effort */ }
  };

  const ROLE_BADGE = { owner: 'badge-primary', editor: 'badge-info', viewer: 'badge-neutral' };

  return (
    <div className="stack">
      <div className="row-between">
        <h2>Team &amp; members</h2>
        <button type="button" className="btn btn-primary" onClick={() => setShowModal(true)}>
          + Add member
        </button>
      </div>

      {members.length === 0 && (
        <p className="muted">No members yet.</p>
      )}

      <div className="stack">
        {members.map((m) => {
          const canEdit = isAdmin || (
            members.some((x) => x.user_id === currentUserId && x.role === 'owner')
          );
          return (
            <div key={m.user_id} className="card row-between">
              <div>
                <strong>{m.name}</strong>
                <span className="muted small" style={{ marginLeft: '0.5em' }}>{m.email}</span>
              </div>
              <div className="row gap-sm">
                <span className={`badge ${ROLE_BADGE[m.role] || 'badge-neutral'}`}>{m.role}</span>
                {canEdit && (
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m.user_id, e.target.value)}
                    aria-label={`Change role for ${m.name}`}
                    className="select-inline"
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                )}
                {canEdit && m.user_id !== currentUserId && (
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => removeMember(m.user_id)}
                    aria-label={`Remove ${m.name}`}
                    title="Remove member"
                  >
                    <Icon name="x" size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showModal && (
        <AddMemberModal
          projectId={projectId}
          onClose={() => setShowModal(false)}
          onAdded={() => {
            setShowModal(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

// ── Permissions tab ───────────────────────────────────────────────────────────

function PullRequestsTab({ projectId, canEdit, toast }) {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newBranch, setNewBranch] = useState('');

  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/pull-request-settings`)
      .then((r) => { if (live) setSettings(r); })
      .catch((e) => { if (live) setError(e.message || 'Could not load the pull request settings'); });
    return () => { live = false; };
  }, [projectId]);

  const save = async (patch) => {
    setBusy(true);
    try {
      setSettings(await api.put(`/api/projects/${projectId}/pull-request-settings`, patch));
      return true;
    } catch (err) {
      toast(err.message || 'Failed to save the pull request settings', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addBranch = async () => {
    const name = newBranch.trim();
    if (!name) return;
    if (await save({ protectedBranches: [...settings.protectedBranches, name] })) setNewBranch('');
  };

  if (error) return <div className="error-note" role="alert">{error}</div>;
  if (!settings) return <div className="spinner-wrap"><div className="spinner" aria-label="Loading…" /></div>;

  return (
    <div className="stack" role="group" aria-label="Pull requests">
      <h2>Pull requests</h2>

      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={settings.openPullRequests}
          disabled={!canEdit || busy}
          onChange={(e) => save({ openPullRequests: e.target.checked })}
        />
        Open a pull request when a session fixes code
      </label>

      <div>
        <h3>Branches that are never pushed to</h3>
        {settings.protectedBranches.length === 0 && (
          <p className="muted small">No branches listed.</p>
        )}
        <div className="stack">
          {settings.protectedBranches.map((b) => (
            <div key={b} className="card row-between">
              <span className="small"><strong>{b}</strong></span>
              {canEdit && (
                <button
                  type="button"
                  className="btn-icon"
                  disabled={busy}
                  onClick={() => save({ protectedBranches: settings.protectedBranches.filter((x) => x !== b) })}
                  aria-label={`Remove ${b} from the protected branches`}
                >
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {canEdit && (
          <div className="row gap-sm" style={{ marginTop: '1em' }}>
            <input
              type="text"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBranch(); } }}
              placeholder="Branch name (e.g. release/*)"
              aria-label="Branch name"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn" onClick={addBranch} disabled={busy || !newBranch.trim()}>Add</button>
          </div>
        )}
        <p className="muted small">The repository's default branch is always protected. A * at the end matches any branch that starts with the same text, for example release/*.</p>
      </div>
      {!canEdit && <p className="muted small">Only project editors can change these settings.</p>}
    </div>
  );
}

function PermissionsTab({ projectId, toast }) {
  const [groups, setGroups] = useState([]);
  const [currentGroupId, setCurrentGroupId] = useState(null);
  const [toolRules, setToolRules] = useState([]);
  const [busy, setBusy] = useState(false);
  const [newTool, setNewTool] = useState('');
  const [newAction, setNewAction] = useState('allow');

  useEffect(() => {
    api.get(`/api/projects/${projectId}/permissions`).then((r) => {
      setCurrentGroupId(r.rule_group_id || null);
      setToolRules(r.tool_rules || []);
    }).catch(() => {});
    api.get('/api/admin/permissions').then((r) => {
      // We only have built-in groups for now
      setGroups([{ id: 'standard', name: 'Standard' }, { id: 'core-safe', name: 'Core Safe' }]);
    }).catch(() => {});
  }, [projectId]);

  const saveGroupOverride = async (groupId) => {
    setBusy(true);
    try {
      await api.put(`/api/projects/${projectId}/permissions`, { ruleGroupId: groupId || null });
      setCurrentGroupId(groupId || null);
    } catch (err) {
      toast(err.message || 'Failed to save permission override', 'error');
    } finally {
      setBusy(false);
    }
  };

  const addToolRule = async () => {
    if (!newTool.trim()) return;
    try {
      const r = await api.post(`/api/projects/${projectId}/tool-rules`, {
        toolName: newTool.trim(),
        action: newAction,
        scope: 'always',
      });
      setToolRules((prev) => [...prev, r.rule]);
      setNewTool('');
    } catch (err) {
      toast(err.message || 'Failed to add tool rule', 'error');
    }
  };

  const removeToolRule = async (ruleId) => {
    try {
      await api.delete(`/api/projects/${projectId}/tool-rules/${ruleId}`);
      setToolRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch (err) {
      toast(err.message || 'Failed to remove tool rule', 'error');
    }
  };

  return (
    <div className="stack">
      <h2>Permissions</h2>

      <div className="field">
        <label htmlFor="perm-group">Rule group override</label>
        <select
          id="perm-group"
          value={currentGroupId || ''}
          onChange={(e) => saveGroupOverride(e.target.value)}
          disabled={busy}
        >
          <option value="">— use portal default —</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>

      <div>
        <h3>Project tool rules</h3>
        {toolRules.length === 0 && (
          <p className="muted small">No custom tool rules for this project.</p>
        )}
        <div className="stack">
          {toolRules.map((rule) => (
            <div key={rule.id} className="card row-between">
              <span className="small"><strong>{rule.tool_name}</strong> — {rule.action}</span>
              <button
                type="button"
                className="btn-icon"
                onClick={() => removeToolRule(rule.id)}
                aria-label={`Remove rule for ${rule.tool_name}`}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="row gap-sm" style={{ marginTop: '1em' }}>
          <input
            type="text"
            value={newTool}
            onChange={(e) => setNewTool(e.target.value)}
            placeholder="Tool name (e.g. Bash)"
            aria-label="Tool name"
            style={{ flex: 1 }}
          />
          <select value={newAction} onChange={(e) => setNewAction(e.target.value)} aria-label="Action">
            <option value="allow">Allow</option>
            <option value="ask">Ask</option>
            <option value="block">Block</option>
          </select>
          <button type="button" className="btn" onClick={addToolRule}>Add</button>
        </div>
      </div>
    </div>
  );
}

// ── ProjectHub ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'team', label: 'Team & members' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'pull-requests', label: 'Pull requests' },
];

/**
 * The project's repositories, as a panel of the Workspaces page: it loads its own list and brings its own
 * confirmation and toast shelf.
 */
export function ProjectRepositories({ projectId }) {
  const [repos, setRepos] = useState(null);
  const [error, setError] = useState(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toasts, toast, removeToast } = useToast();

  useEffect(() => {
    let live = true;
    setRepos(null);
    api.get(`/api/projects/${projectId}/repos`)
      .then((r) => { if (live) setRepos(r.repos || []); })
      .catch((e) => { if (live) setError(e.message || 'Failed to load repositories'); });
    return () => { live = false; };
  }, [projectId]);

  if (error) return <div className="error-note" role="alert">{error}</div>;
  if (!repos) return <div className="spinner-wrap"><div className="spinner" aria-label="Loading…" /></div>;
  return (
    <>
      <RepositoriesTab projectId={projectId} repos={repos} setRepos={setRepos} requestConfirm={requestConfirm} toast={toast} />
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </>
  );
}

/**
 * @param {{ projectId: string, user: object, initialTab?: string }} props
 */
export function ProjectHub({ projectId, user, initialTab }) {
  const validTabIds = TABS.map((t) => t.id);
  const [activeTab, setActiveTab] = useState(
    initialTab && validTabIds.includes(initialTab) ? initialTab : 'overview',
  );
  const [project, setProject] = useState(null);
  const [members, setMembers] = useState([]);
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const { confirmState, requestConfirm } = useConfirm();
  const { toasts, toast, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projR, repoR] = await Promise.all([
        api.get(`/api/projects/${projectId}`),
        api.get(`/api/projects/${projectId}/repos`),
      ]);
      setProject(projR.project);
      setMembers(projR.members || []);
      setRepos(repoR.repos || []);
    } catch (err) {
      setError(err.message || 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="page">
        <div className="spinner-wrap"><div className="spinner" aria-label="Loading…" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="error-note" role="alert">{error}</div>
      </div>
    );
  }

  const isAdmin = Boolean(user?.is_admin);
  const currentUserId = user?.id;
  const myAccess = members.find((m) => m.user_id === currentUserId);
  const canEditPr = isAdmin || ['editor', 'owner'].includes(String(myAccess?.access ?? myAccess?.role ?? ''));

  return (
    <div className="page">
      <PageHeader
        title="Setup"
        description={project?.description ? `${project.name} — ${project.description}` : (project?.name || '')}
      />

      {/* Tab navigation */}
      <nav className="tab-nav" role="tablist" aria-label="Setup sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            aria-controls={`tabpanel-${t.id}`}
            className={`tab-btn${activeTab === t.id ? ' is-active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* Tab panels */}
      <div role="tabpanel" id={`tabpanel-${activeTab}`} className="tab-panel">
        {activeTab === 'overview' && (
          <OverviewTab projectId={projectId} repos={repos} members={members} onNavigateTab={(t) => (t === 'repositories' ? navigate(`/p/${projectId}/workspaces/repositories`) : setActiveTab(t))} />
        )}
        {activeTab === 'team' && (
          <TeamTab
            projectId={projectId}
            members={members}
            setMembers={setMembers}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
            requestConfirm={requestConfirm}
            toast={toast}
          />
        )}
        {activeTab === 'permissions' && (
          <PermissionsTab projectId={projectId} toast={toast} />
        )}
        {activeTab === 'pull-requests' && (
          <PullRequestsTab projectId={projectId} canEdit={canEditPr} toast={toast} />
        )}
      </div>
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

export default ProjectHub;
