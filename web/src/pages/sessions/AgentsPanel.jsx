/**
 * The session's agents: a header with the counts, three views (Tree, Timeline, Graph — the graph as an Orbit or a box Tree),
 * and the selected agent's own transcript beside them.
 */
import { useMemo, useState } from 'react';
import { AgentOrbit } from './AgentOrbit.jsx';
import { AgentGraph } from './AgentGraph.jsx';
import { AgentTreeList, AgentTimeline } from './AgentViews.jsx';
import { AgentDetail } from './AgentDetail.jsx';
import { summarizeActivity } from '../../lib/agent-activity.js';
import { ORBIT_MAIN } from '../../lib/agent-orbit.js';

const FINISHED = new Set(['done', 'failed', 'stopped']);
const NO_TRANSCRIPT = 'This engine does not send this agent\'s own messages, so only its task and result are shown.';

/**
 * @param {{ agents: Array<object>, events?: Array<object>, workflowId: string, projectId?: string,
 *   workflow?: { title?: string, goal?: string, status?: string }, onClose?: () => void }} props
 */
export function AgentsPanel({ agents, events = [], workflowId, projectId, workflow, onClose }) {
  const [view, setView] = useState('graph');
  const [graphMode, setGraphMode] = useState('orbit');
  const [selectedId, setSelectedId] = useState(null);

  const activity = useMemo(() => summarizeActivity(events, agents), [events, agents]);
  const rootName = workflow?.title || 'Main agent';
  const rootStatus = workflow?.status || 'running';

  const active = agents.filter((a) => !FINISHED.has(a.status)).length;
  const running = agents.filter((a) => a.status === 'running' || a.status === 'pending').length;
  const finished = agents.length - active;
  const noun = (n) => `${n} subagent${n === 1 ? '' : 's'}`;

  const picked = selectedId === ORBIT_MAIN || selectedId === `session:${workflowId}`
    ? { name: rootName, status: rootStatus, description: workflow?.goal }
    : agents.find((a) => a.id === selectedId);
  const pickedActivity = selectedId === ORBIT_MAIN || selectedId === `session:${workflowId}` ? activity.main : activity.byId.get(selectedId);
  // The box graph names the session `session:<id>`; everything else uses the orbit's main-agent id.
  const select = (id) => setSelectedId(id === `session:${workflowId}` ? ORBIT_MAIN : id);

  const tabs = [['tree', 'Tree'], ['timeline', 'Timeline'], ['graph', 'Graph']];
  return (
    <section className="agents-panel" aria-label="Agents">
      <header className="agents-panel-head">
        <strong>Agents</strong>
        <span className="agents-panel-count">{active > 0 ? `${noun(active)} · ${running} running` : `${noun(agents.length)} · none running`}</span>
        {finished > 0 && active > 0 && <span className="agents-panel-done">+{finished} done</span>}
        <div className="agents-panel-tabs" role="tablist" aria-label="Agents view">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? 'is-on' : ''} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
        {onClose && <button type="button" className="agents-panel-close" aria-label="Hide agents" onClick={onClose}>×</button>}
      </header>

      {view === 'graph' && (
        <div className="agents-panel-sub" role="tablist" aria-label="Graph style">
          {[['orbit', 'Orbit'], ['tree', 'Tree']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={graphMode === id} className={graphMode === id ? 'is-on' : ''} onClick={() => setGraphMode(id)}>{label}</button>
          ))}
        </div>
      )}

      <div className="agents-panel-body">
        <div className="agents-panel-main">
          {view === 'tree' && <AgentTreeList agents={agents} activity={activity} rootName={rootName} rootStatus={rootStatus} selectedId={selectedId} onSelect={select} />}
          {view === 'timeline' && <AgentTimeline agents={agents} selectedId={selectedId} onSelect={select} />}
          {view === 'graph' && graphMode === 'orbit' && (
            <AgentOrbit agents={agents} rootName={rootName} rootStatus={rootStatus} activity={activity} selectedId={selectedId} onSelect={select} />
          )}
          {view === 'graph' && graphMode === 'tree' && (
            <div className="agents-panel-flow">
              <AgentGraph agents={agents} workflowId={workflowId} selectedId={selectedId === ORBIT_MAIN ? `session:${workflowId}` : selectedId} onSelect={select} rootTask={workflow?.goal} rootStatus={rootStatus} />
            </div>
          )}
          {view === 'graph' && graphMode === 'orbit' && (
            <p className="agents-panel-hint">Select an agent to focus its transcript · arrows move between agents · scroll to zoom, drag to pan, double-click to zoom in · + − 0</p>
          )}
        </div>
        {picked ? (
          <div className="agents-panel-side">
            <AgentDetail agent={picked} projectId={projectId} lines={pickedActivity?.lines} transcriptNote={NO_TRANSCRIPT} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
