/**
 * Agents activity panel — shows running and completed sub-agents and delegated child sessions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AgentGraph } from './AgentGraph.jsx';
import { AgentDetail } from './AgentDetail.jsx';
import { api } from '../../lib/api.js';
import { subscribeProject } from '../../lib/events.js';
import { href } from '../../lib/router.js';
import { Icon } from '../../components/Icon.jsx';
import { formatRelative } from '../../lib/util.js';

function statusDotClass(status) {
  if (status === 'running') return 'dot-running';
  if (status === 'failed')  return 'dot-failed';
  if (status === 'pending') return 'dot-pending';
  return 'dot-stopped';
}

function statusLabel(status) {
  if (status === 'running') return 'Running';
  if (status === 'pending') return 'Starting';
  if (status === 'done')    return 'Done';
  if (status === 'failed')  return 'Failed';
  if (status === 'paused')  return 'Paused';
  return status || 'Unknown';
}

/**
 * @param {{ workflowId: string, projectId: string, workflow?: { title?: string, goal?: string, status?: string } }} props
 */
export function IdeAgents({ workflowId, projectId, workflow }) {
  const [agents, setAgents] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const dialogRef = useRef(null);
  useEffect(() => {
    if (expanded) dialogRef.current?.showModal();
  }, [expanded]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get(`/api/workflows/${workflowId}/agents`);
      setAgents(data.agents || []);
    } catch (e) {
      if (e.status === 404) {
        setAgents([]);
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  // Live updates via project SSE — child-started/finished events
  useEffect(() => {
    if (!projectId) return;
    const unsub = subscribeProject(projectId, (event) => {
      if (
        (event.type === 'workflow.child-started' || event.type === 'workflow.child-finished') &&
        event.parentWorkflowId === workflowId
      ) {
        load();
      } else if (
        event.type === 'run.event' && event.workflowId === workflowId &&
        typeof event.eventType === 'string' && event.eventType.startsWith('subagent-')
      ) {
        load();
      }
    });
    return unsub;
  }, [projectId, workflowId, load]);

  if (loading && agents === null) {
    return <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}><div className="spinner" aria-label="Loading agents…" /></div>;
  }

  if (error) {
    return (
      <div className="error-note" style={{ margin: 8 }} role="alert">
        {error}
        <button type="button" className="btn btn-sm btn-ghost" onClick={load} style={{ marginLeft: 6 }}>Retry</button>
      </div>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="ws-placeholder" style={{ padding: '24px 12px' }}>
        <Icon name="agents" size={28} />
        <p style={{ fontSize: '0.84rem' }}>No agents yet</p>
        <p style={{ fontSize: '0.77rem', opacity: 0.7 }}>Sub-agents and delegated sessions will appear here</p>
      </div>
    );
  }

  // The agent picked in the graph; the session itself stands for the top node.
  const sessionNode = { name: workflow?.title || 'Session lead', status: workflow?.status, description: workflow?.goal };
  const picked = selectedId === `session:${workflowId}` ? sessionNode : agents.find((a) => a.id === selectedId);
  const detail = picked
    ? <AgentDetail agent={picked} projectId={projectId} />
    : <p className="agent-detail-hint">Select an agent in the graph to see its task.</p>;

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div style={{ height: 280 }}><AgentGraph agents={agents} workflowId={workflowId} selectedId={selectedId} onSelect={setSelectedId} rootTask={workflow?.goal} rootStatus={workflow?.status} /></div>
      {detail}
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded(true)}>Expand agent graph</button>
      {expanded && createPortal(<dialog ref={dialogRef} aria-label="Agent collaboration" onCancel={() => setExpanded(false)} onClose={() => setExpanded(false)} style={{ width: 'min(1100px, 92vw)', maxWidth: '92vw', height: '80vh', background: 'var(--panel, #101820)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><strong>Agent collaboration</strong><button type="button" className="btn btn-sm" onClick={() => setExpanded(false)}>Close</button></div>
        <div style={{ height: 'calc(100% - 40px)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0 }}><AgentGraph agents={agents} workflowId={workflowId} selectedId={selectedId} onSelect={setSelectedId} rootTask={workflow?.goal} rootStatus={workflow?.status} /></div>
          {detail}
        </div>
      </dialog>, document.body)}
      <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ flex: 1, fontSize: '0.75rem', color: 'var(--ink-3)' }}>
          {agents.length} agent{agents.length !== 1 ? 's' : ''}
        </span>
        <button type="button" className="btn-icon" title="Refresh" aria-label="Refresh agents" style={{ width: 22, height: 22 }} onClick={load}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {agents.map((agent, i) => (
        <div key={agent.id ?? agent.sessionId ?? i} className={`ide-agent-item${agent.id && agent.id === selectedId ? ' is-selected' : ''}`}>
          <button type="button" className="ide-agent-item-name agent-item-pick" aria-pressed={agent.id === selectedId} onClick={() => setSelectedId(agent.id)}>
            <span className={`dot ${statusDotClass(agent.status)}`} aria-label={agent.status} style={{ marginRight: 6 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agent.name || `Agent ${i + 1}`}
            </span>
            {agent.source === 'session' && (
              <span className="badge" style={{ fontSize: '0.66rem', marginLeft: 4, flexShrink: 0 }}>delegated</span>
            )}
          </button>
          {agent.description && (
            <div className="ide-agent-item-meta" style={{ opacity: 0.8 }} title={agent.description}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.description}</span>
            </div>
          )}
          <div className="ide-agent-item-meta">
            <span>{statusLabel(agent.status)}</span>
            {agent.startedAt && <span>{formatRelative(agent.startedAt)}</span>}
            {agent.finishedAt && agent.source === 'session' && (
              <span className="muted" style={{ fontSize: '0.72rem' }}>finished {formatRelative(agent.finishedAt)}</span>
            )}
            {agent.source === 'session' && agent.sessionId && projectId && (
              <a
                href={href(projectId, 'sessions', agent.sessionId)}
                style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: '0.72rem' }}
                aria-label={`Open child session: ${agent.name || agent.sessionId}`}
              >
                Open session
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
