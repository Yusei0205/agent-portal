/**
 * A live graph of the agents working in this session, shown above the conversation.
 *
 * Hidden until the session has agents. Each node shows an agent's name, status and task and updates as the agents
 * work; selecting one opens its full task, result and usage beside the graph. It can be folded away.
 */
import { useState } from 'react';
import { AgentGraph } from './AgentGraph.jsx';
import { AgentDetail } from './AgentDetail.jsx';
import { useSessionAgents } from './useSessionAgents.js';

const FOLD_KEY = 'portal.agentsStrip.folded';

function readFolded() {
  try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; }
}

/**
 * @param {{ workflowId: string, projectId: string, workflow?: { title?: string, goal?: string, status?: string } }} props
 */
export function SessionAgentsStrip({ workflowId, projectId, workflow }) {
  const { agents } = useSessionAgents(workflowId, projectId);
  const [folded, setFolded] = useState(readFolded);
  const [selectedId, setSelectedId] = useState(null);

  if (!agents || agents.length === 0) return null;

  const working = agents.filter((a) => a.status === 'running' || a.status === 'pending').length;
  const failed = agents.filter((a) => a.status === 'failed').length;
  const toggle = () => {
    const next = !folded;
    setFolded(next);
    try { localStorage.setItem(FOLD_KEY, next ? '1' : '0'); } catch { /* not saved: it still folds for now */ }
  };

  const root = `session:${workflowId}`;
  const picked = selectedId === root
    ? { name: workflow?.title || 'Session lead', status: workflow?.status, description: workflow?.goal }
    : agents.find((a) => a.id === selectedId);

  return (
    <section className="agents-strip" aria-label="Agents working in this session">
      <div className="agents-strip-bar">
        <strong>Agents</strong>
        <span className="agents-strip-count">{agents.length}</span>
        {working > 0 && <span className="agents-strip-chip is-running">{working} working</span>}
        {failed > 0 && <span className="agents-strip-chip is-failed">{failed} failed</span>}
        <button type="button" className="btn btn-sm btn-ghost agents-strip-fold" aria-expanded={!folded} onClick={toggle}>
          {folded ? 'Show graph' : 'Hide graph'}
        </button>
      </div>
      {!folded && (
        <div className="agents-strip-body">
          <div className="agents-strip-graph">
            <AgentGraph
              agents={agents}
              workflowId={workflowId}
              selectedId={selectedId}
              onSelect={setSelectedId}
              rootTask={workflow?.goal}
              rootStatus={workflow?.status}
            />
          </div>
          {picked && (
            <div className="agents-strip-detail">
              <AgentDetail agent={picked} projectId={projectId} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
