/**
 * Agents activity panel — shows running and completed sub-agents and delegated child sessions.
 */
import { useCallback, useEffect, useState } from 'react';
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
 * @param {{ workflowId: string, projectId: string }} props
 */
export function IdeAgents({ workflowId, projectId }) {
  const [agents, setAgents] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  useEffect(() => { load(); }, [load]);

  // Live updates via project SSE — child-started/finished events
  useEffect(() => {
    if (!projectId) return;
    const unsub = subscribeProject(projectId, (event) => {
      if (
        (event.type === 'workflow.child-started' || event.type === 'workflow.child-finished') &&
        event.parentWorkflowId === workflowId
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

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ flex: 1, fontSize: '0.75rem', color: 'var(--ink-3)' }}>
          {agents.length} agent{agents.length !== 1 ? 's' : ''}
        </span>
        <button type="button" className="btn-icon" title="Refresh" aria-label="Refresh agents" style={{ width: 22, height: 22 }} onClick={load}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {agents.map((agent, i) => (
        <div key={agent.sessionId ?? i} className="ide-agent-item">
          <div className="ide-agent-item-name">
            <span className={`dot ${statusDotClass(agent.status)}`} aria-label={agent.status} style={{ marginRight: 6 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agent.name || `Agent ${i + 1}`}
            </span>
            {agent.source === 'session' && (
              <span className="badge" style={{ fontSize: '0.66rem', marginLeft: 4, flexShrink: 0 }}>delegated</span>
            )}
          </div>
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
