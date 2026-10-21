import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { useLoad } from '../../lib/useAsync.js';
import { href, runHref } from '../../lib/router.js';
import { cx, money, timeAgo } from '../../lib/util.js';
import { KIND_LABEL } from '../../components/run/RunViewer.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Badge, Segmented, Spinner } from '../../components/ui.jsx';
import { budgetOf, groupSessions, needsYou, statusOf } from './status.js';

/** The left column of Sessions: every session of the project, grouped by what it needs, and the single runs. */
export function SessionList({ selectedId, selectedRunId, view, onView }) {
  const { project, canEdit } = useProject();
  const sessions = useLoad(() => api.get(`/api/projects/${project.id}/workflows`), [project.id]);
  const runs = useLoad(() => api.get(`/api/projects/${project.id}/runs?standalone=1&limit=100`), [project.id]);
  const timer = useRef(null);
  // Run and input events arrive in bursts; reload once they settle.
  useProjectEvents(['workflow.updated', 'workflow.deleted', 'run.updated', 'input.created', 'input.resolved'], () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sessions.reload(true);
      runs.reload(true);
    }, 400);
  });
  // A session or run opened right after it was created may not be in the list yet: fetch again without waiting.
  const known = !sessions.data || !selectedId || sessions.data.workflows.some((w) => w.id === selectedId);
  const knownRun = !runs.data || !selectedRunId || runs.data.runs.some((r) => r.id === selectedRunId);
  useEffect(() => {
    if (!known) sessions.reload(true);
    if (!knownRun) runs.reload(true);
  }, [known, knownRun]); // eslint-disable-line react-hooks/exhaustive-deps
  // What each running session or run is doing right now, from the project's live activity events.
  const [live, setLive] = useState({});
  useProjectEvents(['run.activity'], (event, p) => setLive((m) => ({ ...m, [p.workflowId || p.runId]: p.line })));
  const notify = useFinishedNotifications(sessions.data?.workflows);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const items = (sessions.data?.workflows || []).filter((w) => !needle || `${w.title} ${w.goal} ${w.jira_key}`.toLowerCase().includes(needle));
  const singles = (runs.data?.runs || []).filter((r) => !needle || r.title.toLowerCase().includes(needle));
  const groups = useMemo(() => groupSessions(items), [items]);
  const waiting = (sessions.data?.workflows || []).filter(needsYou).length;
  // The browser tab shows how many sessions need someone, so it can be noticed from another tab.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = waiting ? `(${waiting}) ${base}` : base;
    return () => {
      document.title = document.title.replace(/^\(\d+\) /, '');
    };
  }, [waiting]);

  return (
    <aside className="ws-list" aria-label="Sessions">
      <div className="ws-list-head">
        <h1>Sessions</h1>
        {notify.supported ? (
          <button
            type="button"
            className={cx('icon-btn ws-bell', notify.on && 'is-on')}
            aria-pressed={notify.on}
            onClick={notify.toggle}
            title={notify.on ? 'Desktop notifications are on: you hear when a session finishes or needs you' : 'Notify me when a session finishes or needs me'}
            aria-label="Desktop notifications"
          >
            <Icon name="alert" size={16} />
          </button>
        ) : null}
        {canEdit ? (
          <a className="btn btn-primary btn-sm" href={href(project.id, 'sessions', 'new')}>
            <Icon name="plus" size={15} />
            <span>New</span>
          </a>
        ) : null}
      </div>
      <Segmented
        size="sm"
        value={view}
        onChange={onView}
        label="Show"
        options={[
          { value: 'sessions', label: 'Sessions', count: waiting || undefined },
          { value: 'runs', label: 'Single runs' },
        ]}
      />
      <input type="search" className="input input-sm" placeholder="Search" aria-label="Search sessions and runs" value={q} onChange={(e) => setQ(e.target.value)} />
      {view === 'sessions' ? (
        sessions.loading && !sessions.data ? (
          <Spinner />
        ) : !groups.length ? (
          <p className="muted small pad-sm">{needle ? 'Nothing matches.' : 'No sessions yet. Start one with New.'}</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="ws-group" aria-label={g.label}>
              <h2 className="ws-group-head">
                {g.label} <span className="muted">{g.items.length}</span>
              </h2>
              <ul className="ws-items">
                {g.items.map((w) => (
                  <SessionRow key={w.id} w={w} projectId={project.id} active={w.id === selectedId} now={w.status === 'running' ? live[w.id] : null} />
                ))}
              </ul>
            </section>
          ))
        )
      ) : runs.loading && !runs.data ? (
        <Spinner />
      ) : (
        <ul className="ws-items">
          {singles.map((r) => (
            <li key={r.id}>
              <a href={runHref(project.id, r.id)} className={cx('ws-item', r.id === selectedRunId && 'is-active')} aria-current={r.id === selectedRunId ? 'page' : undefined}>
                <span className={cx('dot', `dot-${r.status}`)} aria-hidden="true" />
                <span className="ws-item-main">
                  <span className="ws-item-title">{r.title}</span>
                  {['queued', 'running'].includes(r.status) && live[r.id] ? <span className="ws-now small">{live[r.id]}</span> : null}
                  <span className="muted small">
                    {KIND_LABEL[r.kind] ?? r.kind}, {timeAgo(r.created_at)}
                    {r.meta?.kiroCredits != null ? `, ${r.meta.kiroCredits} credits` : r.cost_usd ? `, ${money(r.cost_usd)}` : ''}
                  </span>
                </span>
                {r.status === 'waiting' ? <Badge status="waiting" /> : null}
              </a>
            </li>
          ))}
          {!singles.length ? <li className="muted small pad-sm">{needle ? 'Nothing matches.' : 'No single runs yet.'}</li> : null}
        </ul>
      )}
    </aside>
  );
}

function SessionRow({ w, projectId, active, now }) {
  const st = statusOf(w);
  const b = budgetOf(w);
  const waiting = w.pending_inputs > 0;
  return (
    <li>
      <a href={href(projectId, 'sessions', w.id)} className={cx('ws-item', active && 'is-active')} aria-current={active ? 'page' : undefined}>
        <span className={cx('dot', `dot-${w.status === 'running' ? 'running' : w.status === 'done' ? 'completed' : needsYou(w) ? 'waiting' : w.status}`)} aria-hidden="true" />
        <span className="ws-item-main">
          <span className="ws-item-title">{w.title}</span>
          {w.parent ? <span className="muted small">↰ delegated by {w.parent.title}</span> : null}
          {now ? <span className="ws-now small">{now}</span> : <span className="ws-item-sub muted small">{w.summary || w.stop_reason || w.goal}</span>}
          <span className="muted small">
            {st.label} · iteration {w.iteration} · {b.unit === 'credits' ? `${b.spent} of ${b.total} credits` : `${money(b.spent, 2)} of ${money(b.total, 2)}`} · {timeAgo(w.updated_at)}
          </span>
        </span>
        {waiting ? (
          <span className="rail-count" title={`${w.pending_inputs} waiting for an answer`}>
            {w.pending_inputs}
          </span>
        ) : null}
      </a>
    </li>
  );
}

const NOTIFY_KEY = 'portal.notifySessions';
const LOUD = { done: 'is ready for review', blocked: 'needs you', failed: 'failed', paused: 'paused' };

/**
 * Opt-in desktop notifications: while this page is in the background, say when a session finishes, needs someone or
 * stops. Only status changes seen after the page loaded count.
 */
function useFinishedNotifications(workflows) {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [on, setOn] = useState(() => {
    try {
      return supported && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === '1';
    } catch {
      return false;
    }
  });
  const seen = useRef(null);
  useEffect(() => {
    if (!workflows) return;
    const prev = seen.current;
    seen.current = new Map(workflows.map((w) => [w.id, w.status]));
    if (!prev || !on || !document.hidden) return;
    for (const w of workflows) {
      const was = prev.get(w.id);
      if (was && was !== w.status && LOUD[w.status]) {
        try {
          new Notification(`${w.title} ${LOUD[w.status]}`, { body: w.stop_reason || w.summary || '', tag: `session-${w.id}` });
        } catch {
          /* some browsers only allow notifications from a service worker */
        }
      }
    }
  }, [workflows, on]);
  const toggle = async () => {
    let next = !on;
    if (next && Notification.permission !== 'granted') next = (await Notification.requestPermission()) === 'granted';
    setOn(next);
    try {
      localStorage.setItem(NOTIFY_KEY, next ? '1' : '0');
    } catch {
      /* not essential */
    }
  };
  return { supported, on, toggle };
}
