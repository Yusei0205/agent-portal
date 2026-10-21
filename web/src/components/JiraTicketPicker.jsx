import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { timeAgo } from '../lib/util.js';
import { Icon } from './Icon.jsx';
import { TicketPreview } from './TicketPreview.jsx';
import { Badge, Segmented, Spinner } from './ui.jsx';

/** Map a Jira priority name to the Badge tone used across this portal. */
function severityTone(priority) {
  if (!priority) return 'muted';
  const p = priority.toLowerCase();
  if (p === 'highest' || p === 'critical' || p === 'blocker') return 'danger';
  if (p === 'high') return 'warn';
  if (p === 'low' || p === 'lowest') return 'muted';
  return 'muted'; // Medium and anything else → muted/default
}

/** KEY_RE mirrors the server's pattern: one or more capital letter-digit prefix, dash, digits. */
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/;

/**
 * Searchable picker that lets developers select a Jira ticket.
 * Only rendered when the project has Jira connected AND mapped to a project key.
 */
export function JiraTicketPicker({ projectId, value, onChange }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('mine');
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState({ list: [], next: null });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const loadIdRef = useRef(0);

  // Debounce text search
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async ({ more = false } = {}) => {
    const id = ++loadIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = more && pages.next ? `&next=${encodeURIComponent(pages.next)}` : '';
      const r = await api.get(
        `/api/projects/${projectId}/jira/issues?scope=${scope}&q=${encodeURIComponent(debouncedQ)}${next}`,
      );
      if (id !== loadIdRef.current) return;
      setPages((p) => ({ list: more ? [...p.list, ...r.issues] : r.issues, next: r.next }));
    } catch (e) {
      if (id === loadIdRef.current) setLoadError(e);
    } finally {
      if (id === loadIdRef.current) setLoading(false);
    }
  }, [projectId, scope, debouncedQ, pages.next]);

  // Reset and reload on scope/search change
  useEffect(() => {
    setPages({ list: [], next: null });
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, debouncedQ, open]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); inputRef.current?.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.querySelector('[role="option"]')?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const select = (issue) => {
    onChange({ key: issue.key, summary: issue.summary, status: issue.status, priority: issue.priority ?? null, updated: issue.updated ?? null, url: null });
    setOpen(false);
    setQ('');
  };

  // If user types a valid key directly (e.g. PAY-123) and blurs, accept it
  const handleInputBlur = () => {
    const trimmed = q.trim().toUpperCase();
    if (JIRA_KEY_RE.test(trimmed) && !value) {
      onChange({ key: trimmed, summary: '(key entered manually — details loaded when run starts)', status: null, url: null });
      setQ('');
      setOpen(false);
    }
  };

  const resultCount = pages.list.length;

  if (value) {
    // Show the selected ticket card
    return (
      <div className="stack" style={{ gap: 8 }}>
      <div className="jira-ticket-card" role="status" aria-label={`Selected Jira ticket: ${value.key}`}>
        <span className="jira-ticket-card-key mono">{value.key}</span>
        <span className="jira-ticket-card-summary">{value.summary}</span>
        {value.priority ? (
          <Badge tone={severityTone(value.priority)}>{value.priority}</Badge>
        ) : null}
        {value.status ? (
          <Badge tone={value.status.category === 'done' ? 'ok' : value.status.category === 'indeterminate' ? 'accent' : 'muted'}>
            {value.status.name}
          </Badge>
        ) : null}
        {value.url ? (
          <a href={value.url} target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label={`Open ${value.key} in Jira`} title="Open in Jira">
            <Icon name="external" size={14} />
          </a>
        ) : null}
        <button type="button" className="linkish small" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Remove selected ticket ${value.key}`}
          onClick={() => onChange(null)}
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      {showDetails ? <div className="panel"><TicketPreview projectId={projectId} ticketKey={value.key} /></div> : null}
      </div>
    );
  }

  return (
    <div className="jira-picker" style={{ position: 'relative' }}>
      <div className="row tight" style={{ gap: 6 }}>
        <input
          ref={inputRef}
          type="search"
          className="input"
          placeholder="Search tickets or type a key (e.g. PAY-123)"
          aria-label="Search Jira tickets"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls="jira-picker-list"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={handleInputBlur}
          autoComplete="off"
        />
        <Segmented
          size="sm"
          value={scope}
          onChange={(v) => { setScope(v); setOpen(true); }}
          label="Scope"
          options={[
            { value: 'mine', label: 'Mine' },
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      {/* Live region for screen reader announcements */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {loading ? 'Loading tickets…' : open ? `${resultCount} ticket${resultCount === 1 ? '' : 's'} found` : ''}
      </div>
      {open ? (
        <div
          id="jira-picker-list"
          role="listbox"
          aria-label="Jira tickets"
          ref={listRef}
          className="jira-picker-dropdown"
          onMouseDown={(e) => e.preventDefault()} // prevent blur before click
        >
          {loading && !pages.list.length ? (
            <div className="jira-picker-state"><Spinner small /> Loading…</div>
          ) : loadError ? (
            <div className="jira-picker-state danger"><Icon name="alert" size={14} /> {loadError.message || 'Could not load tickets'}</div>
          ) : !pages.list.length ? (
            <div className="jira-picker-state muted">No tickets found</div>
          ) : (
            pages.list.map((issue) => (
              <button
                key={issue.key}
                role="option"
                aria-selected="false"
                type="button"
                className="jira-picker-option"
                onClick={() => select(issue)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.nextElementSibling?.focus(); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); (e.currentTarget.previousElementSibling || inputRef.current)?.focus(); }
                  if (e.key === 'Enter') { e.preventDefault(); select(issue); }
                  if (e.key === 'Escape') { setOpen(false); inputRef.current?.focus(); }
                }}
              >
                {/* Visually-hidden full description for screen readers */}
                <span className="sr-only">
                  {issue.key} {issue.summary}
                  {issue.priority ? `, ${issue.priority} severity` : ''}
                  {`, ${issue.status.name}`}
                  {issue.type ? `, ${issue.type}` : ''}
                  {issue.updated ? `, updated ${timeAgo(issue.updated)}` : ''}
                </span>
                <span className="jira-picker-option-key mono" aria-hidden="true">{issue.key}</span>
                <span className="jira-picker-option-summary" aria-hidden="true">{issue.summary}</span>
                {issue.priority ? (
                  <Badge tone={severityTone(issue.priority)} aria-hidden="true">{issue.priority}</Badge>
                ) : <span aria-hidden="true" />}
                <Badge tone={issue.status.category === 'done' ? 'ok' : issue.status.category === 'indeterminate' ? 'accent' : 'muted'} aria-hidden="true">
                  {issue.status.name}
                </Badge>
                {issue.type ? <span className="muted small" aria-hidden="true">{issue.type}</span> : <span aria-hidden="true" />}
                {issue.updated ? (
                  <time
                    className="jira-picker-option-date muted small"
                    dateTime={issue.updated}
                    title={new Date(issue.updated).toLocaleString()}
                    aria-hidden="true"
                  >
                    {timeAgo(issue.updated)}
                  </time>
                ) : <span aria-hidden="true" />}
              </button>
            ))
          )}
          {pages.next ? (
            <button type="button" className="jira-picker-more" onClick={() => load({ more: true })} disabled={loading}>
              {loading ? <Spinner small /> : 'Load more'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
