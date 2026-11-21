import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { m } from 'motion/react';
import { api } from '../lib/api.js';
import { href } from '../lib/router.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';
import { Icon } from './Icon.jsx';

const TITLES = { agents: 'Agent activity', running: 'Running sessions', completed: 'Runs completed today', success: 'Run outcomes' };

export function DashboardDetails({ metric, value, animated, data, period, projectId, projects, onClose, onAgent }) {
  const ref = useFocusTrap();
  const dismiss = useOverlayDismiss(onClose);
  const [today, setToday] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const escape = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  useEffect(() => {
    if (metric !== 'completed' || period === 'today') return;
    let live = true;
    setToday(null); setError(null);
    const query = new URLSearchParams({ period: 'today' });
    if (projectId) query.set('projectId', projectId);
    api.get(`/api/dashboard?${query}`).then((value) => { if (live) setToday(value); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [metric, period, projectId, retry, data?.generatedAt]);
  const source = metric === 'completed' && period !== 'today' ? today : data;
  const agents = (source?.agents || []).filter((agent) => metric !== 'completed' || agent.completed > 0);
  const sessions = [...new Map([data?.activeSession, ...(data?.recentSessions || [])].filter((s) => s && ['running', 'pending'].includes(s.status)).map((s) => [s.id, s])).values()];
  const project = projects?.find((p) => p.id === projectId);
  const scope = metric === 'running' ? 'Now' : metric === 'completed' || period === 'today' ? 'Today (UTC)' : period === '7d' ? 'Last 7 days' : 'Last 30 days';
  return createPortal(
    <m.div className="dialog-overlay dashboard-details-overlay" data-animated={animated ? 'true' : 'false'} initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: animated ? 0.18 : 0 }} onMouseDown={dismiss.onMouseDown} onClick={dismiss.onClick}>
      <m.section className="dashboard-details" ref={ref} role="dialog" aria-modal="true" aria-labelledby="dashboard-details-title" initial={false} animate={{ x: 0, opacity: 1 }} exit={{ x: 24, opacity: 0 }} transition={{ duration: animated ? 0.2 : 0, ease: [0.22, 1, 0.36, 1] }}>
        <header className="dashboard-details-head">
          <div>
            <span className="db-eyebrow">{project?.name || 'All projects'} · {scope}</span>
            <m.div className="db-kpi-identity dashboard-details-metric" layoutId={animated ? `metric-${metric}` : undefined} initial={false} transition={{ type: 'spring', stiffness: 420, damping: 38 }}>
              <h2 id="dashboard-details-title" className="kpi-label">{TITLES[metric]}</h2>
              <div className="kpi-value stat-value">{value}</div>
            </m.div>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close details"><Icon name="x" size={18} /></button>
        </header>
        <div className="dashboard-details-body">
          {metric === 'running' ? <>
            <p>{data?.summary?.runningSessions ?? 0} running · {data?.summary?.queuedSessions ?? 0} queued</p>
            <p className="muted">Recent active sessions are shown below. Open a project’s Sessions page for its full list. These are current states, independent of the chart period.</p>
            {sessions.length ? sessions.map((session) => (
              <a key={session.id} className="dashboard-detail-row" href={href(session.projectId || session.project_id, 'sessions', session.id)}>
                <span><strong>{session.title || 'Untitled session'}</strong><small>{session.projectName}</small></span>
                <span className="pill">{session.status}</span>
              </a>
            )) : <p className="empty-state">No recent active sessions to display.</p>}
            {(projects || []).filter((p) => !projectId || p.id === projectId).map((p) => (
              <a key={p.id} className="btn btn-sm" href={href(p.id, 'sessions')}>Open {p.name} sessions</a>
            ))}
          </> : <>
            <p className="muted">{metric === 'completed' ? 'Completed runs by agent since UTC midnight. Select an agent to inspect its runs.' : metric === 'success' ? 'Success is completed ÷ (completed + failed). Runs stopped by you are excluded. Select an agent to inspect its runs.' : 'Agents with recorded activity in this period. Select one to inspect its runs.'}</p>
            {error ? (
              <p role="alert">{error} <button type="button" className="btn btn-sm" onClick={() => setRetry((n) => n + 1)}>Retry</button></p>
            ) : !source ? <p role="status">Loading details…</p> : agents.length ? agents.map((agent) => (
              <button key={agent.agent} type="button" className="dashboard-detail-row" onClick={() => onAgent(agent.agent, metric === 'completed' ? 'today' : period)}>
                <span>
                  <strong>{agent.agent}</strong>
                  <small>{agent.runs} runs · {agent.completed} completed · {agent.failed} failed</small>
                </span>
                <span>
                  {metric === 'completed' ? agent.completed : agent.completed + agent.failed > 0 ? `${(100 * agent.completed / (agent.completed + agent.failed)).toFixed(1)}%` : '—'}
                  <Icon name="chevronRight" size={14} />
                </span>
              </button>
            )) : <p className="empty-state">No matching runs in this period.</p>}
          </>}
        </div>
      </m.section>
    </m.div>, document.body,
  );
}
