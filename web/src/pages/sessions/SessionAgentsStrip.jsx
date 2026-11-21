/**
 * The agents of this session above the conversation: counts, an Orbit / Tree / Timeline view, and the selected agent's own
 * transcript. Hidden until the session has agents. It can be folded away to a one-line bar.
 */
import { useMemo, useState } from 'react';
import { AgentsPanel } from './AgentsPanel.jsx';
import { useSessionAgents } from './useSessionAgents.js';

const FOLD_KEY = 'portal.agentsStrip.folded';

function readFolded() {
  try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; }
}

/**
 * @param {{ workflowId: string, projectId: string, workflow?: { title?: string, goal?: string, status?: string }, events?: Array<object> }} props
 *   events: the session's run events (oldest first), which carry each agent's own messages and tool calls
 */
export function SessionAgentsStrip({ workflowId, projectId, workflow, events }) {
  const { agents } = useSessionAgents(workflowId, projectId);
  const [folded, setFolded] = useState(readFolded);
  const list = useMemo(() => agents ?? [], [agents]);

  if (!agents || agents.length === 0) return null;

  const setFold = (next) => {
    setFolded(next);
    try { localStorage.setItem(FOLD_KEY, next ? '1' : '0'); } catch { /* not saved: it still folds for now */ }
  };

  if (folded) {
    const working = list.filter((a) => a.status === 'running' || a.status === 'pending').length;
    return (
      <section className="agents-strip" aria-label="Agents working in this session">
        <div className="agents-strip-bar">
          <strong>Agents</strong>
          <span className="agents-strip-count">{list.length}</span>
          {working > 0 && <span className="agents-strip-chip is-running">{working} working</span>}
          <button type="button" className="btn btn-sm btn-ghost agents-strip-fold" aria-expanded="false" onClick={() => setFold(false)}>Show agents</button>
        </div>
      </section>
    );
  }
  return (
    <section className="agents-strip" aria-label="Agents working in this session">
      <AgentsPanel agents={list} events={events} workflowId={workflowId} projectId={projectId} workflow={workflow} onClose={() => setFold(true)} />
    </section>
  );
}
