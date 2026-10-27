import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { subscribeProject } from '../../lib/events.js';
import { useBulkSelect } from '../../lib/useBulkSelect.js';
import { formatRelative, formatDate } from '../../lib/util.js';
import { navigate, href } from '../../lib/router.js';
import { Icon } from '../../components/Icon.jsx';
import { BulkActionBar, BulkSelectHint } from '../../components/BulkActionBar.jsx';
import { NewSessionDialog } from './NewSessionDialog.jsx';

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

function SessionRow({ w, projectName, active, checked, onCheck }) {
  const [hovered, setHovered] = useState(false);
  const showCheckbox = hovered || active || checked;

  const title = w.goal
    ? (w.goal.length > 60 ? w.goal.slice(0, 59) + '…' : w.goal)
    : `Session ${w.id.slice(0, 8)}`;

  const engineBadgeClass =
    w.engine === 'kiro'
      ? 'badge badge-engine-kiro'
      : w.engine === 'claude-code'
      ? 'badge badge-engine-claude'
      : 'badge';

  return (
    <div
      className={`ws-item${active ? ' is-active' : ''}`}
      role="row"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Checkbox — visible on hover or when selected */}
      <div
        className="session-row-checkbox"
        style={{ opacity: showCheckbox ? 1 : 0, width: 18, flexShrink: 0 }}
      >
        <input
          type="checkbox"
          aria-label={`Select session: ${title}`}
          checked={checked}
          onChange={(e) => {
            e.stopPropagation();
            onCheck(w.id);
          }}
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: 'pointer' }}
        />
      </div>

      {/* Clickable row body */}
      <a
        href={href(w.project_id, 'sessions', w.id)}
        className="session-row-link"
        aria-current={active ? 'page' : undefined}
        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 8, textDecoration: 'none', color: 'inherit' }}
      >
        <span
          className={`dot ${dotClass(w.status)}`}
          title={w.status}
          style={{ marginTop: 4, flexShrink: 0 }}
          aria-label={w.status}
        />
        <div className="ws-item-body">
          <span className="ws-item-title">{title}</span>
          <div className="ws-item-sub">
            <span className={engineBadgeClass}>{engineLabel(w.engine)}</span>
            {projectName && <span>{projectName}</span>}
            <span className="muted" style={{ marginLeft: 'auto' }}>
              {formatRelative(w.updated_at)}
            </span>
          </div>
        </div>
      </a>
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
 * }} props
 */
export function SessionList({ project, selectedId, onSelect }) {
  const [workflows, setWorkflows] = useState(null);
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [engineFilter, setEngineFilter] = useState('all');
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const searchRef = useRef(null);
  const timerRef = useRef(null);

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

  useEffect(() => {
    setLoading(true);
    setWorkflows(null);
    load();
    loadRepos();
  }, [load, loadRepos]);

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
    });
    return () => {
      unsubscribe();
      clearTimeout(timerRef.current);
    };
  }, [project.id, load]);

  // '/' shortcut focuses search box
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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
    if (!window.confirm(`Delete ${bulk.selected.size} session${bulk.selected.size === 1 ? '' : 's'}? This cannot be undone.`)) return;
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
      alert(e.message);
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
          title="New session (⌘⌥N)"
          aria-label="New session"
          style={{ marginLeft: 'auto' }}
        >
          <Icon name="plus" size={14} />
          New
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--line)' }}>
        <div style={{ position: 'relative' }}>
          <Icon
            name="search"
            size={14}
            style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', pointerEvents: 'none' }}
          />
          <input
            ref={searchRef}
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 28, paddingRight: 28 }}
          />
          {!search && (
            <kbd
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: '0.7rem',
                color: 'var(--ink-3)',
                border: '1px solid var(--line)',
                borderRadius: 3,
                padding: '1px 4px',
                pointerEvents: 'none',
              }}
              aria-hidden="true"
            >
              /
            </kbd>
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

      {/* Bulk select hint */}
      <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--line-2)' }}>
        <BulkSelectHint />
      </div>

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
          onClose={() => setShowNewDialog(false)}
        />
      )}
    </div>
  );
}
