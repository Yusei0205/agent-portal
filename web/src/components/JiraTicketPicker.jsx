/**
 * JiraTicketPicker — compact searchable Jira ticket picker for the New Session dialog.
 *
 * Shows a project dropdown + search box + "Mine / All" toggle that queries
 * GET /api/projects/:pid/jira/issues with the debounced search term.
 * Selecting a ticket calls onChange({ key, summary, status, priority, url }).
 * Once a ticket is selected the card shows it; clicking the ✕ clears it.
 *
 * Props:
 *   projectId:   portal project ID
 *   jiraMapping: mapping object from GET /jira (may be null while loading)
 *   value:       selected ticket or null
 *   onChange:    called with ticket object or null
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from './Icon.jsx';
import { TicketPreview } from './TicketPreview.jsx';

const LS_KEY = (pid) => `jira-picker-project-${pid}`;

/** Map Jira priority → badge class */
function priorityBadgeClass(priority) {
  if (!priority) return 'badge';
  const p = priority.toLowerCase();
  if (p === 'highest' || p === 'critical' || p === 'blocker') return 'badge badge-danger';
  if (p === 'high') return 'badge badge-warn';
  return 'badge';
}

function statusBadgeClass(status) {
  if (!status) return 'badge';
  const cat = typeof status === 'object' ? status.category : null;
  if (cat === 'done') return 'badge badge-ok';
  if (cat === 'indeterminate') return 'badge badge-info';
  return 'badge';
}

function statusName(status) {
  if (!status) return null;
  return typeof status === 'object' ? status.name : String(status);
}

/**
 * @param {{
 *   projectId: string,
 *   jiraMapping?: { projectKeys?: string[] } | null,
 *   value: { key: string, summary: string, status?: any, priority?: string, url?: string } | null,
 *   onChange: (ticket: object | null) => void,
 * }} props
 */
export function JiraTicketPicker({ projectId, jiraMapping = null, value, onChange }) {
  const [q, setQ]                   = useState('');
  const [assigneeMode, setAssigneeMode] = useState('me'); // 'me' | 'any'
  const [open, setOpen]             = useState(false);
  const [issues, setIssues]         = useState([]);
  const [nextPage, setNextPage]     = useState(null);
  const [loading, setLoading]       = useState(false);
  const [loadError, setLoadError]   = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  // ── Jira project selector state ──────────────────────────────────────────
  const [jiraProjects, setJiraProjects] = useState(/** @type {Array<{key:string,name:string}>|null} */(null));
  const [jiraProject, setJiraProject] = useState(() => {
    try { return localStorage.getItem(LS_KEY(projectId)) ?? ''; } catch { return ''; }
  });

  // Load Jira projects from the API
  useEffect(() => {
    if (!projectId) return;
    api.get(`/api/projects/${projectId}/jira/projects`)
      .then((r) => setJiraProjects(r.projects ?? []))
      .catch(() => setJiraProjects([]));
  }, [projectId]);

  // Compute which projects to offer in the dropdown.
  // When jiraMapping.projectKeys is non-empty, restrict to those keys;
  // otherwise show everything returned by /jira/projects.
  const allowedKeys = jiraMapping?.projectKeys;
  const filteredProjects = jiraProjects === null
    ? null
    : (allowedKeys?.length > 0
        ? jiraProjects.filter((p) => allowedKeys.includes(p.key))
        : jiraProjects);

  // Show the project dropdown only when there is >1 option to choose from
  // (the "All projects" slot is always present, so show when filteredProjects.length >= 1).
  const showProjectDropdown = filteredProjects !== null && filteredProjects.length > 1;

  // Persist project selection in localStorage when it changes
  const handleProjectChange = (key) => {
    setJiraProject(key);
    try { localStorage.setItem(LS_KEY(projectId), key); } catch { /* private mode */ }
    setOpen(true);
  };

  const inputRef  = useRef(null);
  const listRef   = useRef(null);
  const loadIdRef = useRef(0);

  // Debounce the search query
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async ({ more = false } = {}) => {
      const id = ++loadIdRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const params = new URLSearchParams({
          assignee: assigneeMode === 'me' ? 'me' : 'any',
        });
        if (jiraProject) params.set('project', jiraProject);
        if (debouncedQ) params.set('q', debouncedQ);
        if (more && nextPage) params.set('page', String(nextPage));

        const r = await api.get(
          `/api/projects/${projectId}/jira/issues?${params}`,
        );
        if (id !== loadIdRef.current) return;
        setIssues((prev) =>
          more ? [...prev, ...(r.issues ?? [])] : (r.issues ?? []),
        );
        setNextPage(r.nextPage ?? null);
      } catch (e) {
        if (id === loadIdRef.current) setLoadError(e);
      } finally {
        if (id === loadIdRef.current) setLoading(false);
      }
    },
    [projectId, jiraProject, assigneeMode, debouncedQ, nextPage],
  );

  // Reset + reload when search / scope / project changes
  useEffect(() => {
    setIssues([]);
    setNextPage(null);
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assigneeMode, debouncedQ, open, jiraProject]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); inputRef.current?.focus(); }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        listRef.current?.querySelector('[role="option"]')?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const select = (issue) => {
    onChange({
      key:      issue.key,
      summary:  issue.summary,
      status:   issue.status ?? null,
      priority: issue.priority ?? null,
      url:      issue.url ?? null,
      updated:  issue.updated ?? null,
    });
    setOpen(false);
    setQ('');
  };

  // ── Selected ticket card ────────────────────────────────────────────────────
  if (value) {
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div
          className="jira-ticket-card"
          role="status"
          aria-label={`Selected Jira ticket: ${value.key}`}
        >
          <span className="jira-ticket-card-key mono">{value.key}</span>
          <span className="jira-ticket-card-summary">{value.summary}</span>
          {value.priority && (
            <span className={priorityBadgeClass(value.priority)}>
              {value.priority}
            </span>
          )}
          {value.status && (
            <span className={statusBadgeClass(value.status)}>
              {statusName(value.status)}
            </span>
          )}
          {value.url && (
            <a
              href={value.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-icon"
              aria-label={`Open ${value.key} in Jira`}
              title="Open in Jira"
            >
              <Icon name="external" size={14} />
            </a>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={showPreview}
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? 'Hide details' : 'Details'}
          </button>
          <button
            type="button"
            className="btn-icon"
            aria-label={`Remove ticket ${value.key}`}
            onClick={() => onChange(null)}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        {showPreview && (
          <div
            className="card"
            style={{ padding: 12, maxHeight: 320, overflowY: 'auto' }}
          >
            <TicketPreview projectId={projectId} ticketKey={value.key} />
          </div>
        )}
      </div>
    );
  }

  // ── Picker ──────────────────────────────────────────────────────────────────
  const resultCount = issues.length;

  return (
    <div className="jira-picker">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Project dropdown — compact, shown when >1 project available */}
        {showProjectDropdown && (
          <select
            aria-label="Jira project"
            className="input"
            style={{ maxWidth: 140, fontSize: '0.82rem' }}
            value={jiraProject}
            onChange={(e) => handleProjectChange(e.target.value)}
          >
            <option value="">All projects</option>
            {filteredProjects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key}
              </option>
            ))}
          </select>
        )}
        <input
          ref={inputRef}
          type="search"
          className="input"
          style={{ flex: 1 }}
          placeholder="Search tickets or type a key (e.g. PAY-123)"
          aria-label="Search Jira tickets"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls="jira-picker-list"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
        />
        {/* Mine / All toggle */}
        <div role="group" aria-label="Ticket scope" style={{ display: 'flex', gap: 0 }}>
          {(['me', 'any']).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`btn btn-sm${assigneeMode === mode ? ' btn-primary' : ' btn-secondary'}`}
              style={{ borderRadius: mode === 'me' ? 'var(--radius) 0 0 var(--radius)' : '0 var(--radius) var(--radius) 0', borderRightWidth: mode === 'me' ? 0 : undefined }}
              aria-pressed={assigneeMode === mode}
              onClick={() => { setAssigneeMode(mode); setOpen(true); }}
            >
              {mode === 'me' ? 'Mine' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Live region for screen readers */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? 'Loading tickets…'
          : open
          ? `${resultCount} ticket${resultCount === 1 ? '' : 's'} found`
          : ''}
      </div>

      {open && (
        <div
          id="jira-picker-list"
          role="listbox"
          aria-label="Jira tickets"
          ref={listRef}
          className="jira-picker-dropdown"
          onMouseDown={(e) => e.preventDefault()}
        >
          {loading && !issues.length ? (
            <div className="jira-picker-state">
              <div
                className="spinner"
                style={{ width: 14, height: 14 }}
                aria-hidden="true"
              />{' '}
              Loading…
            </div>
          ) : loadError ? (
            <div className="jira-picker-state" style={{ color: 'var(--danger)' }}>
              <Icon name="warning" size={14} />{' '}
              {loadError.message || 'Could not load tickets'}
            </div>
          ) : !issues.length ? (
            <div className="jira-picker-state muted">No tickets found</div>
          ) : (
            issues.map((issue) => (
              <button
                key={issue.key}
                role="option"
                aria-selected="false"
                type="button"
                className="jira-picker-option"
                onClick={() => select(issue)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    e.currentTarget.nextElementSibling?.focus();
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    (e.currentTarget.previousElementSibling || inputRef.current)?.focus();
                  }
                  if (e.key === 'Enter') { e.preventDefault(); select(issue); }
                  if (e.key === 'Escape') { setOpen(false); inputRef.current?.focus(); }
                }}
              >
                {/* Screen-reader full description */}
                <span className="sr-only">
                  {issue.key} {issue.summary}
                  {issue.priority ? `, ${issue.priority} priority` : ''}
                  {issue.status ? `, ${statusName(issue.status)}` : ''}
                  {issue.updated ? `, updated ${formatRelative(issue.updated)}` : ''}
                </span>
                <span className="jira-picker-option-key mono" aria-hidden="true">
                  {issue.key}
                </span>
                <span className="jira-picker-option-summary" aria-hidden="true">
                  {issue.summary}
                </span>
                {issue.priority ? (
                  <span className={priorityBadgeClass(issue.priority)} aria-hidden="true">
                    {issue.priority}
                  </span>
                ) : (
                  <span aria-hidden="true" />
                )}
                {issue.status ? (
                  <span className={statusBadgeClass(issue.status)} aria-hidden="true">
                    {statusName(issue.status)}
                  </span>
                ) : (
                  <span aria-hidden="true" />
                )}
                {issue.updated ? (
                  <time
                    className="jira-picker-option-date muted small"
                    dateTime={issue.updated}
                    title={new Date(issue.updated).toLocaleString()}
                    aria-hidden="true"
                  >
                    {formatRelative(issue.updated)}
                  </time>
                ) : (
                  <span aria-hidden="true" />
                )}
              </button>
            ))
          )}
          {nextPage !== null && (
            <button
              type="button"
              className="jira-picker-more"
              onClick={() => load({ more: true })}
              disabled={loading}
            >
              {loading ? (
                <div
                  className="spinner"
                  style={{ width: 12, height: 12, display: 'inline-block' }}
                  aria-hidden="true"
                />
              ) : (
                'Load more'
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
