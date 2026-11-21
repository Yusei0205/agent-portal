import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';
import { AgentDetail } from '../pages/sessions/AgentDetail.jsx';
import { summarizeActivity } from '../lib/agent-activity.js';
import { useMissionSnapshot } from '../lib/useMissionSnapshot.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';
import { href } from '../lib/router.js';
import { formatRelative } from '../lib/util.js';
import { ExecutionTimeline } from './ExecutionTimeline.jsx';

const AgentGraph = lazy(() => import('../pages/sessions/AgentGraph.jsx').then((module) => ({ default: module.AgentGraph })));
const OutputFilePreview = lazy(() => import('../pages/sessions/OutputFilePreview.jsx').then((module) => ({ default: module.OutputFilePreview })));
const statusText = { pending: 'Starting', running: 'Running', blocked: 'Needs a decision', paused: 'Paused', done: 'Completed', failed: 'Needs attention', stopped: 'Stopped' };
const isRunning = (status) => ['running', 'pending'].includes(status);
const sessionProject = (session) => session.projectId || session.project_id;

function MissionInspector({ snapshot, session, selectedId, onSelect, onClose, onPreview, initialView = 'collaboration', animated }) {
  const ref = useFocusTrap();
  const dismiss = useOverlayDismiss(onClose);
  const [tab, setTab] = useState(initialView);
  useEffect(() => {
    const escape = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  const agents = snapshot.agents || [];
  const workflow = snapshot.workflow || session;
  const rootId = `session:${session.id}`;
  const root = { id: rootId, name: 'Session lead', status: workflow.status, description: workflow.goal || workflow.title };
  const selected = agents.find((agent) => agent.id === selectedId) || root;
  const activity = useMemo(() => summarizeActivity(snapshot.events || [], agents), [snapshot.events, agents]);
  const ownActivity = selected.id === rootId ? activity.main : activity.byId.get(selected.id);
  const projectId = sessionProject(session);
  return createPortal(<div className="dialog-overlay mc-overlay" data-animated={animated ? 'true' : 'false'} onMouseDown={dismiss.onMouseDown} onClick={dismiss.onClick}>
    <section className="mc-inspector" role="dialog" aria-modal="true" aria-labelledby="mc-inspector-title" ref={ref}>
      <header className="mc-inspector-head"><div><span className="db-eyebrow">Mission inspector</span><h2 id="mc-inspector-title">{workflow.title || 'Untitled session'}</h2></div><button type="button" className="btn-icon" onClick={onClose} aria-label="Close mission inspector"><Icon name="x" size={18} /></button></header>
      <div className="mc-inspector-toolbar"><div role="group" aria-label="Mission inspector view">{[['collaboration', 'Collaboration'], ['activity', 'Activity'], ['outputs', 'Deliverables']].map(([key, label]) => <button type="button" className="btn btn-sm" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div><a className="btn btn-sm btn-primary" href={href(projectId, 'sessions', session.id)}>Open workspace <Icon name="external" size={12} /></a></div>
      <SnapshotStatus snapshot={snapshot} />
      <div className="mc-inspector-body">
        {tab === 'collaboration' && <div className="mc-collaboration">
          <div className="mc-graph"><Suspense fallback={<p role="status">Loading collaboration view…</p>}><AgentGraph agents={agents} workflowId={session.id} selectedId={selected.id} onSelect={onSelect} rootTask={workflow.goal || workflow.title} rootStatus={workflow.status} /></Suspense></div>
          <div className="mc-agent-inspector"><label className="mc-picker">Inspect agent<select value={selected.id} onChange={(event) => onSelect(event.target.value)}>{[root, ...agents].map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><AgentDetail agent={selected} projectId={projectId} lines={ownActivity?.lines} transcriptNote="No messages for this agent in the most recent 50 events. Open the workspace for the full trace." /></div>
          {!agents.length && <p className="mc-note">No delegated agents have been reported for this session.</p>}
        </div>}
        {tab === 'activity' && <section aria-label="Recent mission activity" className="mc-activity"><h3>Recent recorded activity</h3><p className="mc-note">Up to 50 recent events. Open the workspace for full tool inputs, results and earlier history.</p>{snapshot.errors.events && <p className="error-note">Activity could not be refreshed.</p>}{(snapshot.events || []).filter((event) => ['tool-start', 'tool-end', 'assistant-text', 'approval-request'].includes(event.type)).slice(-12).reverse().map((event, index) => <article key={event.id || index} className="mc-event"><Icon name={event.type === 'approval-request' ? 'warning' : event.type.startsWith('tool') ? 'terminal' : 'agents'} size={16} aria-hidden="true" /><div><strong>{event.type === 'approval-request' ? 'Approval requested' : event.payload?.toolName || 'Agent update'}{event.payload?.agent ? ` · ${event.payload.agent}` : ''}</strong><p>{event.type === 'assistant-text' ? String(event.payload?.text || '').slice(0, 360) : event.type === 'tool-end' ? 'Tool result recorded — inspect its outcome in the workspace.' : event.type === 'approval-request' ? 'Open the workspace to check whether this request still needs your decision.' : 'Tool call recorded'}</p></div>{event.created_at && <time dateTime={event.created_at}>{formatRelative(event.created_at)}</time>}</article>)}{!snapshot.errors.events && !(snapshot.events || []).length && <p className="mc-note">No activity recorded yet.</p>}</section>}
        {tab === 'outputs' && <section aria-label="Mission deliverables" className="mc-deliverables"><h3>Generated deliverables</h3><p className="mc-note">Files produced by this session. A generated file is not proof of verification or deployment.</p>{snapshot.errors.files && <p className="error-note">Deliverables could not be refreshed.</p>}{(snapshot.files || []).map((file) => <button type="button" className="mc-file" key={file.id} onClick={() => onPreview(file)}><Icon name="file" size={19} aria-hidden="true" /><span><strong>{file.name}</strong><small>Version {file.version || 1}{file.created_at ? ` · ${formatRelative(file.created_at)}` : ''}</small></span><span>Preview <Icon name="chevronRight" size={13} /></span></button>)}{!snapshot.errors.files && !(snapshot.files || []).length && <p className="mc-note">No output files reported yet.</p>}</section>}
      </div>
      <footer className="mc-inspector-footer"><span>Review changes and verification evidence in the workspace.</span><a className="btn btn-sm" href={href(projectId, 'sessions', session.id)}>Open session</a><a className="btn btn-sm" href={href(projectId, 'reviews', 'code')}>Project reviews</a></footer>
    </section>
  </div>, document.body);
}

function SnapshotStatus({ snapshot }) {
  const failed = Object.keys(snapshot.errors);
  const labels = { workflow: 'Session', agents: 'Agents', events: 'Activity', files: 'Deliverables' };
  return <div className={`mc-freshness${failed.length ? ' is-stale' : ''}`} role="status"><span className="mc-signal" aria-hidden="true" /><span>{snapshot.loading ? 'Loading session data…' : failed.length ? `${failed.map((key) => labels[key]).join(', ')} unavailable${snapshot.updatedAt ? ' · showing last available data' : ''}` : `Synced ${formatRelative(snapshot.updatedAt)} · refreshes every 10s`}</span><button type="button" className="btn btn-sm" onClick={snapshot.refresh} disabled={snapshot.loading || snapshot.refreshing}>{snapshot.refreshing ? 'Refreshing…' : failed.length ? 'Retry' : 'Refresh'}</button></div>;
}

function SelectedMission({ session, animated }) {
  const snapshot = useMissionSnapshot(session.id, sessionProject(session));
  const [selectedId, setSelectedId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [inspectorView, setInspectorView] = useState('collaboration');
  const opener = useRef(null);
  const rootId = `session:${session.id}`;
  const workflow = snapshot.workflow || session;
  const root = { id: rootId, name: 'Session lead', status: workflow.status };
  const agents = snapshot.agents || [];
  const active = agents.filter((agent) => isRunning(agent.status)).length;
  const open = (id, element) => { opener.current = element; setInspectorView('collaboration'); setSelectedId(id); };
  const close = () => { setSelectedId(null); requestAnimationFrame(() => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }); };
  return <div className={`mc-selected${animated ? ' mc-animated' : ''}`}>
    <div className="mc-mission-heading"><div><span className="db-eyebrow">{session.projectName || 'Selected session'}</span><h3>{workflow.title || 'Untitled session'}</h3><p>{statusText[workflow.status] || workflow.status || 'Status unavailable'}{snapshot.agents ? ` · ${active} delegated agents running` : ''}</p></div><a className="btn btn-sm" href={href(sessionProject(session), 'sessions', session.id)} aria-label="View session details"><Icon name="external" size={13} />Open</a></div>
    <SnapshotStatus snapshot={snapshot} />
    <div className="mc-overview-stats"><span><strong>{snapshot.agents ? agents.length + 1 : '—'}</strong> agents in this session</span><span><strong>{snapshot.agents ? active + (isRunning(workflow.status) ? 1 : 0) : '—'}</strong> running</span><span><strong>{snapshot.files?.length ?? '—'}</strong> deliverables</span></div>
    <ExecutionTimeline root={root} agents={agents} onSelect={open} />
    {!snapshot.loading && !snapshot.errors.agents && !agents.length && <p className="mc-note">No delegated agents reported. This session may use only its lead agent.</p>}
    <div className="mc-actions"><button type="button" className="btn btn-sm btn-primary" onClick={(event) => open(rootId, event.currentTarget)}><Icon name="workflow" size={14} />Inspect collaboration</button><button type="button" className="btn btn-sm" onClick={(event) => { open(rootId, event.currentTarget); setInspectorView('outputs'); }}><Icon name="file" size={14} />Deliverables{snapshot.files ? ` (${snapshot.files.length})` : ''}</button></div>
    {selectedId && !preview && <MissionInspector snapshot={snapshot} session={session} selectedId={selectedId} onSelect={setSelectedId} onClose={close} onPreview={(file) => { setInspectorView('outputs'); setPreview(file); }} initialView={inspectorView} animated={animated} />}
    {preview && createPortal(<Suspense fallback={<div role="status" className="dialog-overlay">Loading preview…</div>}><OutputFilePreview file={preview} files={snapshot.files || []} projectId={sessionProject(session)} onClose={() => setPreview(null)} /></Suspense>, document.body)}
  </div>;
}

export function MissionControl({ activeSession, recentSessions = [], projectId, animated }) {
  const sessions = [...new Map([activeSession, ...recentSessions].filter((session) => session?.id && sessionProject(session)).map((session) => [session.id, session])).values()].slice(0, 8);
  const [chosenId, setChosenId] = useState(null);
  const selected = sessions.find((session) => session.id === chosenId) || sessions[0];
  return <section className="panel db-active mc-panel" aria-label="Mission control">
    <header className="mc-panel-head"><h2 className="db-panel-title"><Icon name="activity" size={16} />Mission control</h2><span className="mc-note">From objective to outcome</span></header>
    {selected ? <><label className="mc-picker">Inspect recent work<select value={selected.id} onChange={(event) => setChosenId(event.target.value)}>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title || 'Untitled session'} · {statusText[session.status] || session.status}</option>)}</select></label><SelectedMission key={selected.id} session={selected} animated={animated} /></> : <div className="mc-empty"><Icon name="workflow" size={30} /><h3>Your next outcome starts here</h3><p>Start a session to see its agents, recorded activity and deliverables in one place.</p><a className="btn btn-sm btn-primary" href={projectId ? href(projectId, 'sessions') : '#/projects'}>{projectId ? 'Open sessions' : 'Choose a project'}</a></div>}
  </section>;
}
