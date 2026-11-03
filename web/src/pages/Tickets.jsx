/**
 * Tickets page — per-project Jira integration.
 *
 * Two states:
 *   1. Not connected → connect card (API token or OAuth app)
 *   2. Connected     → settings panel + ticket browser + detail panel
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useSort } from '../lib/useSort.jsx';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { TicketPreview } from '../components/TicketPreview.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';

// ── Helpers ────────────────────────────────────────────────────────────────────

function statusBadgeClass(status) {
  if (!status) return 'badge';
  const cat = typeof status === 'object' ? status.category : null;
  if (cat === 'done') return 'badge badge-ok';
  if (cat === 'indeterminate') return 'badge badge-info';
  return 'badge';
}

function statusDisplayName(status) {
  if (!status) return null;
  return typeof status === 'object' ? status.name : String(status);
}

// ── Connect card ───────────────────────────────────────────────────────────────

/**
 * Shown when Jira is not connected. Offers two auth methods:
 *   - API token (site URL + email + token)
 *   - OAuth app (client ID + secret, then opens a browser tab)
 */
function ConnectCard({ projectId, onConnected }) {
  const [method, setMethod]         = useState('token'); // 'token' | 'oauth'
  // API-token fields
  const [siteUrl, setSiteUrl]       = useState('');
  const [email, setEmail]           = useState('');
  const [apiToken, setApiToken]     = useState('');
  // OAuth fields
  const [clientId, setClientId]     = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [appSaved, setAppSaved]     = useState(false);
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState(null);

  // Poll for connection after OAuth tab is opened
  const pollRef = useRef(null);
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  useEffect(() => () => stopPolling(), []);

  const startPolling = () => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.get(`/api/projects/${projectId}/jira`);
        if (r.connected) { stopPolling(); onConnected(); }
      } catch { /* keep polling */ }
    }, 3000);
  };

  // Also poll on window-focus (user returns from OAuth tab)
  useEffect(() => {
    const onFocus = async () => {
      if (!pollRef.current) return; // only when polling is active
      try {
        const r = await api.get(`/api/projects/${projectId}/jira`);
        if (r.connected) { stopPolling(); onConnected(); }
      } catch { /* ignore */ }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [projectId, onConnected]);

  // Save OAuth app credentials
  const saveOAuthApp = async () => {
    setBusy(true); setError(null);
    try {
      await api.put(`/api/projects/${projectId}/jira/app`, { clientId, clientSecret });
      setAppSaved(true);
    } catch (e) { setError(e.message || 'Failed to save app'); }
    finally { setBusy(false); }
  };

  // Open OAuth connect window
  const connectOAuth = async () => {
    setBusy(true); setError(null);
    try {
      const { url } = await api.post(`/api/projects/${projectId}/jira/connect`, {
        return: `#/p/${encodeURIComponent(projectId)}/tickets`,
      });
      window.open(url, '_blank', 'noopener');
      startPolling();
    } catch (e) { setError(e.message || 'Failed to start OAuth'); }
    finally { setBusy(false); }
  };

  // Connect via API token
  const connectToken = async (e) => {
    e.preventDefault();
    if (!siteUrl || !email || !apiToken) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/projects/${projectId}/jira/token`, { siteUrl, email, apiToken });
      onConnected();
    } catch (e) { setError(e.message || 'Failed to connect'); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ maxWidth: 540 }}>
      <div className="card stack">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="ticket" size={22} />
          <div>
            <h2>Connect Jira</h2>
            <p className="muted small">
              Link this project to a Jira site so you can browse tickets and
              start agent sessions directly from a ticket.
            </p>
          </div>
        </div>

        {/* Method selector */}
        <div
          role="radiogroup"
          aria-label="Connection method"
          style={{ display: 'flex', gap: 0 }}
        >
          {[
            { id: 'token', label: 'API token' },
            { id: 'oauth', label: 'OAuth app' },
          ].map(({ id, label }, i) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={method === id}
              className={`btn${method === id ? ' btn-primary' : ' btn-secondary'}`}
              style={{
                borderRadius: i === 0
                  ? 'var(--radius) 0 0 var(--radius)'
                  : '0 var(--radius) var(--radius) 0',
                borderRightWidth: i === 0 ? 0 : undefined,
              }}
              onClick={() => { setMethod(id); setError(null); }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── API token form ── */}
        {method === 'token' && (
          <form className="stack" noValidate onSubmit={connectToken}>
            <div className="field">
              <label htmlFor="jira-site-url">Jira Cloud site URL</label>
              <input
                id="jira-site-url"
                type="url"
                className="input"
                placeholder="https://yourorg.atlassian.net"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="jira-email">Atlassian account email</label>
              <input
                id="jira-email"
                type="email"
                className="input"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="field">
              <label htmlFor="jira-api-token">API token</label>
              <input
                id="jira-api-token"
                type="password"
                className="input"
                placeholder="Paste your Atlassian API token"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                required
                autoComplete="current-password"
              />
              <p className="field-hint">
                Generate one at{' '}
                <a
                  href="https://id.atlassian.com/manage-profile/security/api-tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  id.atlassian.com
                </a>
                .
              </p>
            </div>
            {error && (
              <div className="error-note" role="alert">{error}</div>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}
              disabled={busy || !siteUrl || !email || !apiToken}
            >
              {busy ? (
                <>
                  <span
                    className="spinner"
                    style={{ width: 14, height: 14 }}
                    aria-hidden="true"
                  />{' '}
                  Connecting…
                </>
              ) : (
                <>
                  <Icon name="ticket" size={14} /> Connect Jira
                </>
              )}
            </button>
          </form>
        )}

        {/* ── OAuth app form ── */}
        {method === 'oauth' && (
          <div className="stack">
            <p className="muted small">
              Create an OAuth 2.0 app in the{' '}
              <a
                href="https://developer.atlassian.com/console/myapps/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Atlassian developer console
              </a>{' '}
              and paste the credentials below. The redirect URL you configure
              must match your portal URL.
            </p>
            <div className="field">
              <label htmlFor="jira-client-id">Client ID</label>
              <input
                id="jira-client-id"
                type="text"
                className="input"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="jira-client-secret">Client secret</label>
              <input
                id="jira-client-secret"
                type="password"
                className="input"
                placeholder="Client secret"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {error && (
              <div className="error-note" role="alert">{error}</div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || !clientId || !clientSecret}
                onClick={saveOAuthApp}
              >
                {busy && !appSaved ? (
                  <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
                ) : (
                  <Icon name="check" size={14} />
                )}
                {appSaved ? 'App saved' : 'Save app credentials'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !appSaved}
                onClick={connectOAuth}
              >
                {busy && appSaved ? (
                  <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
                ) : (
                  <Icon name="external" size={14} />
                )}
                Connect Jira (OAuth)
              </button>
            </div>
            {appSaved && (
              <p className="muted small" role="status">
                Credentials saved. Click "Connect Jira (OAuth)" to open the
                Atlassian authorization page. Come back here once you have
                approved access.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Site selector (multi-site OAuth result) ────────────────────────────────────

function SiteSelector({ sites, currentSiteId, projectId, onSiteChanged }) {
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  const select = async (siteId) => {
    setBusy(true); setError(null);
    try {
      await api.put(`/api/projects/${projectId}/jira/site`, { siteId });
      onSiteChanged();
    } catch (e) { setError(e.message || 'Failed to select site'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card stack">
      <h3>Choose a Jira site</h3>
      <p className="muted small">
        Your Atlassian account has access to multiple sites. Pick the one to use
        for this project.
      </p>
      {error && <div className="error-note" role="alert">{error}</div>}
      <ul className="stack" style={{ listStyle: 'none' }}>
        {sites.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={`btn${currentSiteId === s.id ? ' btn-primary' : ' btn-secondary'}`}
              style={{ width: '100%', justifyContent: 'flex-start' }}
              disabled={busy}
              onClick={() => select(s.id)}
            >
              <Icon name="ticket" size={14} />
              <span style={{ flex: 1, textAlign: 'left' }}>{s.name}</span>
              <span className="muted small">{s.url}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Jira project settings ──────────────────────────────────────────────────────

function JiraProjectSettings({ projectId, mapping, onSaved }) {
  const [allProjects, setAllProjects] = useState(null);
  const [total, setTotal]             = useState(0);
  const [truncated, setTruncated]     = useState(false);
  const [loadErr, setLoadErr]         = useState(null);
  const [open, setOpen]               = useState(false); // collapsed by default: it is a long list
  const [selected, setSelected]       = useState(
    new Set(mapping?.projectKeys ?? []),
  );
  const [jql, setJql]                 = useState(mapping?.jql ?? '');
  const [busy, setBusy]               = useState(false);
  const [refreshing, setRefreshing]   = useState(false);
  const [error, setError]             = useState(null);
  const [saved, setSaved]             = useState(false);
  const [searchQ, setSearchQ]         = useState('');

  const loadProjects = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoadErr(null);
    try {
      const url = refresh
        ? `/api/projects/${projectId}/jira/projects?refresh=1`
        : `/api/projects/${projectId}/jira/projects`;
      const r = await api.get(url);
      setAllProjects(r.projects ?? []);
      setTotal(r.total ?? (r.projects?.length ?? 0));
      setTruncated(r.truncated ?? false);
    } catch (e) {
      setLoadErr(e.message || 'Could not load Jira projects');
    } finally {
      if (refresh) setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // Client-side filter by key or name
  const filteredProjects = allProjects
    ? (searchQ
        ? allProjects.filter((p) => {
            const q = searchQ.toLowerCase();
            return (
              p.key.toLowerCase().includes(q) ||
              p.name.toLowerCase().includes(q)
            );
          })
        : allProjects)
    : null;

  // Projects currently selected (for chip row)
  const selectedList = allProjects
    ? allProjects.filter((p) => selected.has(p.key))
    : [];

  const toggle = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const removeChip = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const selectAllShown = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      filteredProjects?.forEach((p) => next.add(p.key));
      return next;
    });
  };

  const clearAll = () => setSelected(new Set());

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.put(`/api/projects/${projectId}/jira`, {
        projectKeys: [...selected],
        jql: jql.trim() || undefined,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      if (onSaved) onSaved();
    } catch (e) { setError(e.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card stack">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="jira-projects-body"
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit',
        }}
      >
        <Icon
          name="chevronRight"
          size={14}
          style={{ transition: 'transform .15s', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0 }}
        />
        <h3 style={{ margin: 0 }}>Jira projects</h3>
        <span className="muted small">
          {selected.size > 0 ? `${selected.size} selected` : 'all projects allowed'}
        </span>
      </button>
      {open && (
      <div id="jira-projects-body" className="stack">
      <p className="muted small">
        Select which Jira projects are available for ticket browsing in this
        portal project. Leaving all unchecked means every project is allowed.
      </p>

      {loadErr && <div className="error-note" role="alert">{loadErr}</div>}

      {allProjects === null && !loadErr && (
        <div
          className="spinner"
          style={{ margin: '8px auto' }}
          aria-label="Loading Jira projects…"
        />
      )}

      {allProjects !== null && (
        <>
          {/* Selected chips row */}
          {selectedList.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                alignItems: 'center',
              }}
              aria-label={`Selected projects: ${selectedList.length}`}
            >
              <span className="muted small" style={{ whiteSpace: 'nowrap' }}>
                Selected ({selectedList.length}):
              </span>
              {selectedList.map((p) => (
                <span
                  key={p.key}
                  className="badge"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    paddingRight: 4,
                  }}
                >
                  {p.key}
                  <button
                    type="button"
                    className="btn-icon"
                    style={{ width: 14, height: 14, padding: 0, lineHeight: 1 }}
                    aria-label={`Remove ${p.key}`}
                    onClick={() => removeChip(p.key)}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Search bar + refresh */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Icon
                name="search"
                size={13}
                style={{
                  position: 'absolute',
                  left: 7,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--ink-3)',
                  pointerEvents: 'none',
                }}
                aria-hidden="true"
              />
              <input
                type="search"
                className="input"
                style={{ paddingLeft: 26 }}
                placeholder="Filter by key or name…"
                aria-label="Filter Jira projects"
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Refresh project list"
              title="Refresh"
              disabled={refreshing}
              onClick={() => loadProjects(true)}
            >
              {refreshing ? (
                <span
                  className="spinner"
                  style={{ width: 13, height: 13 }}
                  aria-hidden="true"
                />
              ) : (
                <Icon name="refresh" size={13} />
              )}
            </button>
          </div>

          {/* Count + bulk actions */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span className="muted small">
              Showing {filteredProjects?.length ?? 0} of {total} project
              {total !== 1 ? 's' : ''}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={(filteredProjects?.length ?? 0) === 0}
              onClick={selectAllShown}
            >
              Select all shown
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={selected.size === 0}
              onClick={clearAll}
            >
              Clear
            </button>
          </div>

          {truncated && (
            <p className="muted small" role="note">
              Not all projects are listed — use the search box to find projects
              by key or name.
            </p>
          )}

          {/* Checklist — padding prevents the first row from being clipped */}
          {filteredProjects && filteredProjects.length > 0 && (
            <div
              className="stack"
              style={{
                gap: 6,
                maxHeight: 240,
                overflowY: 'auto',
                padding: '2px 0',
              }}
              role="group"
              aria-label="Jira project selection"
            >
              {filteredProjects.map((p) => (
                <label
                  key={p.key}
                  className="choice"
                  style={{ cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(p.key)}
                    onChange={() => toggle(p.key)}
                  />
                  <span>
                    <strong>{p.key}</strong>{' '}
                    <span className="muted">— {p.name}</span>
                    {p.type && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        {p.type}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}

          {filteredProjects &&
            filteredProjects.length === 0 &&
            allProjects.length > 0 && (
              <p className="muted small">No projects match "{searchQ}".</p>
            )}

          {allProjects.length === 0 && (
            <p className="muted small">No Jira projects found in this site.</p>
          )}
        </>
      )}

      <div className="field">
        <label htmlFor="jira-jql-filter">JQL filter (optional)</label>
        <input
          id="jira-jql-filter"
          type="text"
          className="input"
          placeholder="issuetype = Bug AND labels = backend"
          value={jql}
          onChange={(e) => setJql(e.target.value)}
        />
        <p className="field-hint">
          Applied on top of every ticket search in this project.
        </p>
      </div>

      {error && <div className="error-note" role="alert">{error}</div>}
      {saved && (
        <p className="ok small" role="status">
          ✓ Saved
        </p>
      )}

      <button
        type="button"
        className="btn btn-primary"
        style={{ alignSelf: 'flex-start' }}
        disabled={busy}
        onClick={save}
      >
        {busy ? (
          <span
            className="spinner"
            style={{ width: 14, height: 14 }}
            aria-hidden="true"
          />
        ) : (
          <Icon name="check" size={14} />
        )}
        Save settings
      </button>
      </div>
      )}
    </div>
  );
}

// ── Ticket browser ─────────────────────────────────────────────────────────────

function TicketBrowser({ projectId, allowedKeys, onNewSession }) {
  // Load all Jira projects to populate the project dropdown
  const [allJiraProjects, setAllJiraProjects] = useState(null);
  useEffect(() => {
    api
      .get(`/api/projects/${projectId}/jira/projects`)
      .then((r) => setAllJiraProjects(r.projects ?? []))
      .catch(() => setAllJiraProjects([]));
  }, [projectId]);

  // Compute which projects to offer in the dropdown.
  // When allowedKeys is non-empty, restrict to those keys; otherwise show all.
  const projectsForDropdown =
    allJiraProjects === null
      ? []
      : allowedKeys?.length > 0
      ? allJiraProjects.filter((p) => allowedKeys.includes(p.key))
      : allJiraProjects;

  const showProjectDropdown = projectsForDropdown.length > 1;
  const isLongList = projectsForDropdown.length > 8;

  const [projectSearch, setProjectSearch] = useState('');
  const filteredDropdownProjects =
    isLongList && projectSearch
      ? projectsForDropdown.filter(
          (p) =>
            p.key.toLowerCase().includes(projectSearch.toLowerCase()) ||
            p.name.toLowerCase().includes(projectSearch.toLowerCase()),
        )
      : projectsForDropdown;

  const [jiraProject, setJiraProject] = useState('');
  const [q, setQ]                     = useState('');
  const [status, setStatus]           = useState('');
  const [assigneeMe, setAssigneeMe]   = useState(true);
  const [statuses, setStatuses]       = useState([]);
  const [issues, setIssues]           = useState(null);
  const { sorted: sortedIssues, sortProps } = useSort(issues, {
    key: (i) => i.key,
    summary: (i) => i.summary,
    status: (i) => i.status,
    priority: (i) => i.priority,
    assignee: (i) => i.assignee,
    updated: (i) => i.updated,
  });
  const [nextPage, setNextPage]       = useState(null);
  const [loading, setLoading]         = useState(false);
  const [loadErr, setLoadErr]         = useState(null);
  const [selected, setSelected]       = useState(null); // { key, summary, ... }

  const loadIdRef = useRef(0);

  // Load available statuses when project changes
  useEffect(() => {
    if (!jiraProject) { setStatuses([]); return; }
    api
      .get(
        `/api/projects/${projectId}/jira/statuses?project=${encodeURIComponent(jiraProject)}`,
      )
      .then((r) => setStatuses(r.statuses ?? []))
      .catch(() => setStatuses([]));
  }, [projectId, jiraProject]);

  // Debounce search
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async ({ more = false } = {}) => {
      const id = ++loadIdRef.current;
      setLoading(true);
      setLoadErr(null);
      try {
        const params = new URLSearchParams({ assignee: assigneeMe ? 'me' : 'any' });
        if (jiraProject) params.set('project', jiraProject);
        if (debouncedQ) params.set('q', debouncedQ);
        if (status) params.set('status', status);
        if (more && nextPage) params.set('page', String(nextPage));

        const r = await api.get(
          `/api/projects/${projectId}/jira/issues?${params}`,
        );
        if (id !== loadIdRef.current) return;
        setIssues((prev) =>
          more ? [...(prev ?? []), ...(r.issues ?? [])] : (r.issues ?? []),
        );
        setNextPage(r.nextPage ?? null);
      } catch (e) {
        if (id === loadIdRef.current)
          setLoadErr(e.message || 'Failed to load tickets');
      } finally {
        if (id === loadIdRef.current) setLoading(false);
      }
    },
    [projectId, jiraProject, debouncedQ, status, assigneeMe, nextPage],
  );

  useEffect(() => {
    setIssues(null);
    setNextPage(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jiraProject, debouncedQ, status, assigneeMe]);

  return (
    <div
      className={`tickets-layout${selected ? ' has-detail' : ''}`}
      aria-label="Ticket browser"
    >
      {/* Left: list */}
      <div className="stack" style={{ gap: 10 }}>
        {/* Filter bar */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
          }}
        >
          {/* Project dropdown — visible when multiple projects available */}
          {showProjectDropdown && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                minWidth: 140,
                maxWidth: isLongList ? 220 : 160,
              }}
            >
              {isLongList && (
                <input
                  type="search"
                  className="input"
                  style={{ fontSize: '0.82rem' }}
                  placeholder="Filter projects…"
                  aria-label="Filter project list"
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                />
              )}
              <select
                aria-label="Jira project"
                className="input"
                value={jiraProject}
                onChange={(e) => {
                  setJiraProject(e.target.value);
                  setSelected(null);
                }}
              >
                <option value="">All projects</option>
                {filteredDropdownProjects.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} – {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Search */}
          <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
            <Icon
              name="search"
              size={14}
              style={{
                position: 'absolute',
                left: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--ink-3)',
                pointerEvents: 'none',
              }}
              aria-hidden="true"
            />
            <input
              type="search"
              className="input"
              style={{ paddingLeft: 28, width: '100%' }}
              placeholder="Search tickets…"
              aria-label="Search tickets"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          {/* Status filter */}
          {statuses.length > 0 && (
            <select
              aria-label="Status filter"
              className="input"
              style={{ maxWidth: 140 }}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">Any status</option>
              {statuses.map((s) => (
                <option
                  key={typeof s === 'string' ? s : s.name}
                  value={typeof s === 'string' ? s : s.name}
                >
                  {typeof s === 'string' ? s : s.name}
                </option>
              ))}
            </select>
          )}

          {/* Assigned-to-me toggle */}
          <label
            className="choice"
            style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            <input
              type="checkbox"
              checked={assigneeMe}
              onChange={(e) => setAssigneeMe(e.target.checked)}
            />
            <span>Assigned to me</span>
          </label>
        </div>

        {/* Issue list */}
        <div
          className="card"
          style={{ padding: 0, overflow: 'hidden' }}
          aria-label="Ticket list"
        >
          {loading && !issues && (
            <div style={{ padding: '24px', textAlign: 'center' }}>
              <div
                className="spinner"
                style={{ margin: '0 auto' }}
                aria-label="Loading tickets…"
              />
            </div>
          )}
          {loadErr && (
            <div className="error-note" style={{ margin: 12 }} role="alert">
              {loadErr}
            </div>
          )}
          {!loading && issues && issues.length === 0 && (
            <p className="muted small" style={{ padding: '16px 18px' }}>
              {assigneeMe ? (
                <>
                  No open tickets assigned to you.{' '}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ display: 'inline', padding: '0 4px' }}
                    onClick={() => setAssigneeMe(false)}
                  >
                    Show all tickets
                  </button>
                </>
              ) : (
                'No tickets found. Try adjusting your filters.'
              )}
            </p>
          )}
          {issues && issues.length > 0 && (
            <table className="data-table" aria-label="Jira tickets">
              <thead>
                <tr>
                  <th {...sortProps('key')}>Key</th>
                  <th {...sortProps('summary')}>Summary</th>
                  <th {...sortProps('status')}>Status</th>
                  <th {...sortProps('priority')}>Priority</th>
                  <th {...sortProps('assignee')}>Assignee</th>
                  <th {...sortProps('updated')}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {sortedIssues.map((issue) => (
                  <tr
                    key={issue.key}
                    className={`ticket-row${selected?.key === issue.key ? ' is-selected' : ''}`}
                    tabIndex={0}
                    role="row"
                    aria-selected={selected?.key === issue.key}
                    onClick={() => setSelected(issue)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(issue);
                      }
                    }}
                  >
                    <td>
                      <code
                        className="mono"
                        style={{ fontSize: '0.82rem', color: 'var(--accent)' }}
                      >
                        {issue.key}
                      </code>
                    </td>
                    <td style={{ maxWidth: 300 }}>
                      <span className="truncate" style={{ display: 'block' }}>
                        {issue.summary}
                      </span>
                    </td>
                    <td>
                      {issue.status && (
                        <span className={statusBadgeClass(issue.status)}>
                          {statusDisplayName(issue.status)}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="muted small">{issue.priority || '—'}</span>
                    </td>
                    <td>
                      <span className="muted small">{issue.assignee || '—'}</span>
                    </td>
                    <td>
                      {issue.updated && (
                        <time
                          className="muted small"
                          dateTime={issue.updated}
                          title={new Date(issue.updated).toLocaleString()}
                        >
                          {formatRelative(issue.updated)}
                        </time>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {nextPage !== null && (
            <div
              style={{ padding: '8px 18px', borderTop: '1px solid var(--line)' }}
            >
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={loading}
                onClick={() => load({ more: true })}
              >
                {loading ? (
                  <span
                    className="spinner"
                    style={{ width: 12, height: 12 }}
                    aria-hidden="true"
                  />
                ) : null}
                Load more
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right: detail panel */}
      {selected && (
        <div className="ticket-detail card" style={{ padding: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <code
              className="mono"
              style={{ fontWeight: 700, color: 'var(--accent)' }}
            >
              {selected.key}
            </code>
            <button
              type="button"
              className="btn-icon"
              aria-label="Close ticket detail"
              onClick={() => setSelected(null)}
            >
              <Icon name="x" size={15} />
            </button>
          </div>
          <TicketPreview
            projectId={projectId}
            ticketKey={selected.key}
            onStartSession={(ticket) => {
              if (onNewSession) onNewSession(ticket);
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── Connected header ───────────────────────────────────────────────────────────

function ConnectedHeader({ jira, projectId, onDisconnected }) {
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const { confirmState, requestConfirm } = useConfirm();

  const disconnect = async () => {
    const ok = await requestConfirm(
      'Disconnect Jira? This will remove the saved connection and app credentials.',
      'Disconnect',
      'danger',
    );
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      await api.delete(`/api/projects/${projectId}/jira/connection`);
      onDisconnected();
    } catch (e) { setError(e.message || 'Failed to disconnect'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          justifyContent: 'space-between',
        }}
      >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="ticket" size={20} />
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong>
              {jira.site?.name ?? 'Jira'}
            </strong>
            <span className="badge badge-ok">Connected</span>
          </div>
          {jira.site?.url && (
            <a
              className="muted small"
              href={jira.site.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {jira.site.url}
            </a>
          )}
          {jira.account?.email && (
            <p className="muted small">
              {jira.account.name || jira.account.email}
            </p>
          )}
        </div>
      </div>

      <div>
        {error && (
          <p className="danger small" role="alert" style={{ marginBottom: 6 }}>
            {error}
          </p>
        )}
        {jira.canManage && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: 'var(--danger)' }}
            disabled={busy}
            onClick={disconnect}
          >
            {busy ? (
              <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" />
            ) : (
              <Icon name="trash" size={13} />
            )}
            Disconnect
          </button>
        )}
      </div>
    </div>
    <ConfirmDialog state={confirmState} />
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   projectId: string,
 *   route:     object,
 *   onNewSession?: (ticket: object) => void,
 * }} props
 */
export function Tickets({ projectId, route, onNewSession }) {
  const [jira, setJira]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const { toast, toasts, removeToast } = useToast();

  const loadJira = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/jira`);
      setJira(r);
    } catch (e) {
      // Treat 404 as "not configured" — the backend may not have this endpoint yet
      if (e.status === 404) {
        setJira({ connected: false, canManage: true });
      } else {
        setError(e.message || 'Failed to load Jira status');
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadJira(); }, [loadJira]);

  // Detect OAuth callback: ?jira=connected or ?jira=error in window.location.search
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const jiraParam = search.get('jira');
    if (jiraParam === 'connected') {
      // Strip query string, keep the hash (which is the route path)
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      toast('Jira connected successfully.', 'ok');
      loadJira();
    } else if (jiraParam === 'error') {
      const reason = search.get('reason') || 'Unknown error';
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      toast(`Jira connection failed: ${reason}`, 'error');
      loadJira();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="page">
        <div style={{ display: 'grid', placeItems: 'center', minHeight: 200 }}>
          <div className="spinner" aria-label="Loading…" />
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="page">
        <div className="error-note" role="alert">
          {error}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={loadJira}
            style={{ marginLeft: 8 }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ── Not connected ─────────────────────────────────────────────────────────
  if (!jira?.connected) {
    return (
      <div className="page">
        <div className="page-header" style={{ marginBottom: 20 }}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="ticket" size={24} aria-hidden="true" />
            Tickets
          </h1>
        </div>

        {jira?.canManage === false ? (
          <div className="card" style={{ maxWidth: 480 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: 'var(--ink-2)',
              }}
            >
              <Icon name="lock" size={20} />
              <p>Ask a project owner to connect Jira for this project.</p>
            </div>
          </div>
        ) : (
          <ConnectCard
            projectId={projectId}
            onConnected={loadJira}
          />
        )}
      </div>
    );
  }

  // ── Multi-site selector ───────────────────────────────────────────────────
  if (jira.sites && jira.sites.length > 1 && !jira.site) {
    return (
      <div className="page">
        <div className="page-header" style={{ marginBottom: 20 }}>
          <h1>
            <Icon name="ticket" size={24} aria-hidden="true" /> Tickets
          </h1>
        </div>
        <SiteSelector
          sites={jira.sites}
          currentSiteId={null}
          projectId={projectId}
          onSiteChanged={loadJira}
        />
      </div>
    );
  }

  // ── Connected ─────────────────────────────────────────────────────────────
  return (
    <div className="page">
      <ToastShelf toasts={toasts} onRemove={removeToast} />

      <div className="page-header" style={{ marginBottom: 20 }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="ticket" size={24} aria-hidden="true" />
          Tickets
        </h1>
      </div>

      <div className="stack-lg">
        <ConnectedHeader
          jira={jira}
          projectId={projectId}
          onDisconnected={loadJira}
        />

        {/* Settings — project key filter + JQL (managers only) */}
        {jira.canManage && (
          <JiraProjectSettings
            projectId={projectId}
            mapping={jira.mapping ?? null}
            onSaved={loadJira}
          />
        )}

        {/* Ticket browser */}
        <TicketBrowser
          projectId={projectId}
          allowedKeys={jira.mapping?.projectKeys ?? []}
          onNewSession={onNewSession}
        />
      </div>
    </div>
  );
}
