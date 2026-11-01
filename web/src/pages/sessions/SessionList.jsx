import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { subscribeProject } from '../../lib/events.js';
import { useBulkSelect } from '../../lib/useBulkSelect.js';
import { formatRelative, formatDate } from '../../lib/util.js';
import { navigate, href } from '../../lib/router.js';
import { Icon } from '../../components/Icon.jsx';
import { BulkActionBar } from '../../components/BulkActionBar.jsx';
import { NewSessionDialog } from './NewSessionDialog.jsx';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../../components/Toast.jsx';

// ── Status helpers ─────────────────────────────────────────────────────────────

/** Dot class for a workflow status. */
function dotClass(status) {
  if (status === 'running') return 'dot-running';
  if (status === 'failed')  return 'dot-failed';
  if (status === 'pending') return 'dot-pending';
  return 'dot-stopped';
}

/** Engine badge label. */
function engineLabel(engine) {
  if (engine === 'kiro') return 'kiro';
  if (engine === 'claude-code') return 'claude';
  return engine || 'demo';
}

// ── Date grouping ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = todayStart - new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (diff <= 0) return 'Today';
  if (diff <= DAY_MS) return 'Yesterday';
  // Weekday + date for items up to 6 days old, or a locale date for older
  if (diff <= 6 * DAY_MS) {
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: diff > 365 * DAY_MS ? 'numeric' : undefined });
}

function isActive(w) {
  return w.status === 'running' || w.status === 'pending';
}

/**
 * Group an array of workflows into { key, label, items } buckets.
 * Active (running/pending) → "Active N", then today, yesterday, dated groups.
 */
function groupWorkflows(workflows) {
  const active = workflows.filter(isActive);
  const inactive = workflows.filter((w) => !isActive(w));

  // Group inactive by day label
  const dayMap = new Map();
  for (const w of inactive) {
    const label = dayLabel(w.updated_at);
    if (!dayMap.has(label)) dayMap.set(label, []);
    dayMap.get(label).push(w);
  }

  const groups = [];
  if (active.length) {
    groups.push({ key: '__active', label: 'Active', items: active });
  }
  for (const [label, items] of dayMap) {
    groups.push({ key: label, label, items });
  }
  return groups;
}

// ── Session row ────────────────────────────────────────────────────────────────

function SessionRow({ w, projectName, active, checked, onCheck, onRename, selectionMode }) {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const title = (w.title || w.goal)
    ? ((w.title || w.goal).length > 60 ? (w.title || w.goal).slice(0, 59) + '…' : (w.title || w.goal))
    : `Session ${w.id.slice(0, 8)}`;

  const engineBadgeClass =
    w.engine === 'kiro'
      ? 'badge badge-engine-kiro'
      : w.engine === 'claude-code'
      ? 'badge badge-engine-claude'
      : 'badge';

  const startRename = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setRenameValue(w.title || w.goal || '');
    setRenaming(true);
  };

  const submitRename = async (e) => {
    e?.preventDefault();
    const t = renameValue.trim();
    if (!t) { setRenaming(false); return; }
    setRenameBusy(true);
    try {
      await api.patch(`/api/projects/${w.project_id}/workflows/${w.id}`, { title: t });
      setRenaming(false);
      if (onRename) onRename(w.id, t);
    } catch { setRenaming(false); }
    finally { setRenameBusy(false); }
  };

  const wsItemClass = [
    'ws-item',
    active       ? 'is-active'        : '',
    checked      ? 'is-selected'      : '',
    selectionMode ? 'is-selection-mode' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={wsItemClass}
      role="row"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Leading cell: dot or checkbox, same slot — no layout shift */}
      <div className="session-row-leading">
        <span
          className={`dot ${dotClass(w.status)}`}
          title={w.status}
          aria-label={w.status}
        />
        <input
          type="checkbox"
          className="session-row-check"
          aria-label={`Select session: ${title}`}
          checked={checked}
          onChange={(e) => { e.stopPropagation(); onCheck(w.id); }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {renaming ? (
        <form className="session-row-rename-form" onSubmit={submitRename} onClick={(e) => e.stopPropagation()}>
          <input
            autoFocus
            className="session-row-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => !renameBusy && setRenaming(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(false); }}
            aria-label="Rename session"
            disabled={renameBusy}
          />
          <button type="submit" className="btn-icon" disabled={renameBusy} aria-label="Save name" style={{ width: 24, height: 24 }}>
            {renameBusy ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Icon name="check" size={12} />}
          </button>
          <button type="button" className="btn-icon" aria-label="Cancel" onClick={() => setRenaming(false)} style={{ width: 24, height: 24 }}>
            <Icon name="x" size={12} />
          </button>
        </form>
      ) : (
        <>
          {/* Clickable row body — dot has moved to the leading cell */}
          <a
            href={href(w.project_id, 'sessions', w.id)}
            className="session-row-link"
            aria-current={active ? 'page' : undefined}
            style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 8, textDecoration: 'none', color: 'inherit' }}
          >
            <div className="ws-item-body">
              <span className="ws-item-title">{title}</span>
              <div className="ws-item-sub">
                <span className={engineBadgeClass}>{engineLabel(w.engine)}</span>
                {projectName && <span>{projectName}</span>}
                <span className="muted" style={{ marginLeft: 'auto' }}>{formatRelative(w.updated_at)}</span>
              </div>
            </div>
          </a>
          {/* Rename action (visible on hover) */}
          {hovered && (
            <button
              type="button"
              className="btn-icon"
              aria-label="Rename session"
              title="Rename session"
              style={{ width: 24, height: 24, flexShrink: 0, opacity: 0.7 }}
              onClick={startRename}
            >
              <Icon name="rename" size={12} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

/**
 * Left panel: session list.
 *
 * @param {{
 *   project: { id: string, name: string },
 *   selectedId: string | null,
 *   onSelect: (id: string) => void,
 *   initialDialogTicket?: object | null,
 *   onInitialDialogConsumed?: () => void,
 * }} props
 */
export function SessionList({ project, selectedId, onSelect, initialDialogTicket, onInitialDialogConsumed }) {
  const [workflows, setWorkflows] = useState(null);
  const [repos, setRepos] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [engineFilter, setEngineFilter] = useState('all');
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [dialogInitialTicket, setDialogInitialTicket] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const searchRef = useRef(null);
  const timerRef = useRef(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/api/projects/${project.id}/workflows?limit=200`);
      setWorkflows(data.workflows || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  // Load repos for the new session dialog
  const loadRepos = useCallback(async () => {
    try {
      const data = await api.get(`/api/projects/${project.id}/repos`);
      setRepos(data.repos || []);
    } catch {
      setRepos([]);
    }
  }, [project.id]);

  // Load workspaces for the new session dialog
  const loadWorkspaces = useCallback(async () => {
    try {
      const data = await api.get(`/api/projects/${project.id}/workspaces`);
      setWorkspaces(data.workspaces || []);
    } catch {
      setWorkspaces([]);
    }
  }, [project.id]);

  useEffect(() => {
    setLoading(true);
    setWorkflows(null);
    load();
    loadRepos();
    loadWorkspaces();
  }, [load, loadRepos, loadWorkspaces]);

  // Real-time updates via project SSE
  useEffect(() => {
    const unsubscribe = subscribeProject(project.id, (event) => {
      if (
        event.type === 'workflow.created' ||
        event.type === 'workflow.updated' ||
        event.type === 'workflow.deleted' ||
        event.type === 'run.updated'
      ) {
        // Debounce rapid bursts
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => load(), 400);
      }
      // Inline title update without full reload
      if (event.type === 'workflow.renamed' && event.workflowId) {
        setWorkflows((prev) => prev
          ? prev.map((w) => w.id === event.workflowId ? { ...w, title: event.title } : w)
          : prev,
        );
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timerRef.current);
    };
  }, [project.id, load]);

  // Alt+N opens new session dialog; '/' focuses search
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && e.key === 'n') { e.preventDefault(); setShowNewDialog(true); return; }
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // When the parent sends a ticket to pre-fill (from Tickets page), open the dialog
  useEffect(() => {
    if (!initialDialogTicket) return;
    setDialogInitialTicket(initialDialogTicket);
    setShowNewDialog(true);
    if (onInitialDialogConsumed) onInitialDialogConsumed();
  }, [initialDialogTicket, onInitialDialogConsumed]);

  const needle = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!workflows) return [];
    return workflows.filter((w) => {
      if (statusFilter === 'running' && !['running', 'pending'].includes(w.status)) return false;
      if (statusFilter === 'stopped' && !['done', 'paused', 'stopped'].includes(w.status)) return false;
      if (statusFilter === 'failed' && w.status !== 'failed') return false;
      if (engineFilter !== 'all' && w.engine !== engineFilter) return false;
      if (needle && !w.goal?.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [workflows, statusFilter, engineFilter, needle]);

  // Determine whether to show engine filter (both kiro and claude-code sessions exist)
  const engines = useMemo(() => {
    const set = new Set((workflows || []).map((w) => w.engine));
    return { hasKiro: set.has('kiro'), hasClaude: set.has('claude-code') };
  }, [workflows]);

  const showEngineFilter = engines.hasKiro && engines.hasClaude;

  const groups = useMemo(() => groupWorkflows(filtered), [filtered]);

  const bulk = useBulkSelect(filtered);

  const handleDelete = async () => {
    if (bulk.selected.size === 0) return;
    const ok = await requestConfirm(
      `Delete ${bulk.selected.size} session${bulk.selected.size === 1 ? '' : 's'}? This cannot be undone.`,
      'Delete',
      'danger',
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await Promise.all(
        [...bulk.selected].map((id) =>
          api.delete(`/api/projects/${project.id}/workflows/${id}`),
        ),
      );
      bulk.clearAll();
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  const total = workflows?.length ?? 0;

  return (
    <div className="sessions-list-panel" aria-label="Sessions">
      {/* Header */}
      <div className="ws-header">
        <span className="ws-header-title">
          Sessions{total > 0 && <span className="muted" style={{ marginLeft: 4, fontWeight: 400 }}>{total}</span>}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => setShowNewDialog(true)}
          title="New session (Alt+N)"
          aria-label="New session (Alt+N)"
          aria-keyshortcuts="Alt+n"
          style={{ marginLeft: 'auto' }}
        >
          <Icon name="plus" size={14} />
          New session
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--line)' }}>
        <div className="session-search-wrap">
          <span className="session-search-icon" aria-hidden="true">
            <Icon name="search" size={14} />
          </span>
          <input
            ref={searchRef}
            type="search"
            className="session-search-input"
            aria-label="Search sessions"
            placeholder="Search sessions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {!search && (
            <kbd className="session-search-kbd" aria-hidden="true">/</kbd>
          )}
        </div>
      </div>

      {/* Filter pills */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div role="group" aria-label="Filter by status" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[
            { value: 'all', label: 'All' },
            { value: 'running', label: 'Running' },
            { value: 'stopped', label: 'Stopped' },
            { value: 'failed', label: 'Failed' },
          ].map((f) => (
            <button
              key={f.value}
              type="button"
              className={`btn btn-sm${statusFilter === f.value ? ' btn-primary' : ' btn-ghost'}`}
              onClick={() => setStatusFilter(f.value)}
              aria-pressed={statusFilter === f.value}
            >
              {f.label}
            </button>
          ))}
        </div>
        {showEngineFilter && (
          <div role="group" aria-label="Filter by engine" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[
              { value: 'all', label: 'All engines' },
              { value: 'kiro', label: 'Kiro' },
              { value: 'claude-code', label: 'Claude Code' },
            ].map((f) => (
              <button
                key={f.value}
                type="button"
                className={`btn btn-sm${engineFilter === f.value ? ' btn-primary' : ' btn-ghost'}`}
                onClick={() => setEngineFilter(f.value)}
                aria-pressed={engineFilter === f.value}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Bulk select hint removed — checkboxes appear on hover */}

      {/* List body */}
      <div className="ws-list-body">
        {loading && !workflows && (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '0 auto' }} aria-label="Loading sessions…" />
          </div>
        )}

        {error && (
          <div className="error-note" style={{ margin: 8 }} role="alert">
            {error}
          </div>
        )}

        {!loading && !error && groups.length === 0 && (
          <div className="ws-placeholder" style={{ padding: '32px 16px' }}>
            <Icon name="play" size={32} />
            <p>{needle ? 'No sessions match.' : 'No sessions yet.'}</p>
            {!needle && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setShowNewDialog(true)}
              >
                Start your first session
              </button>
            )}
          </div>
        )}

        {groups.map((g) => (
          <section key={g.key} aria-label={g.label}>
            <div className="ws-section-header">
              {g.label}
              <span className="muted" style={{ marginLeft: 4, fontWeight: 400 }}>{g.items.length}</span>
            </div>
            <div role="rowgroup">
              {g.items.map((w) => (
                <SessionRow
                  key={w.id}
                  w={w}
                  projectName={project.name}
                  active={w.id === selectedId}
                  checked={bulk.selected.has(w.id)}
                  onCheck={bulk.toggle}
                  selectionMode={bulk.selected.size > 0}
                  onRename={(id, title) => {
                    setWorkflows((prev) => prev
                      ? prev.map((wf) => wf.id === id ? { ...wf, title } : wf)
                      : prev,
                    );
                  }}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Bulk action bar */}
      <BulkActionBar
        selected={bulk.selected}
        onDelete={handleDelete}
        onClear={bulk.clearAll}
        busy={deleting}
      />

      {/* New session dialog */}
      {showNewDialog && (
        <NewSessionDialog
          project={project}
          repos={repos}
          workspaces={workspaces}
          onClose={() => { setShowNewDialog(false); setDialogInitialTicket(null); }}
          initialTicket={dialogInitialTicket}
        />
      )}
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
