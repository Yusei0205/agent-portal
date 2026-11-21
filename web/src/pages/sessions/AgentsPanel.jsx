/**
 * The session's agents: a header with the counts, three views (Tree, Timeline, Graph — the graph as an Orbit or a box Tree),
 * and the selected agent's own transcript beside them.
 */
import { useMemo, useState, useCallback } from 'react';
import { AgentOrbit } from './AgentOrbit.jsx';
import { AgentGraph } from './AgentGraph.jsx';
import { AgentTreeList, AgentTimeline } from './AgentViews.jsx';
import { AgentDetail } from './AgentDetail.jsx';
import { summarizeActivity, agentLabels } from '../../lib/agent-activity.js';
import { ORBIT_MAIN } from '../../lib/agent-orbit.js';

const FINISHED = new Set(['done', 'failed', 'stopped']);
const MIN_H = 240;
const MAX_H = 1400;
const HEIGHT_KEY = 'agents-panel-height';
const clampH = (n) => Math.min(MAX_H, Math.max(MIN_H, Math.round(n)));
function savedHeight() {
  try { const n = Number(localStorage.getItem(HEIGHT_KEY)); return n ? clampH(n) : 420; } catch { return 420; }
}

const NO_TRANSCRIPT = 'This engine does not send this agent\'s own messages, so only its task and result are shown.';

/**
 * @param {{ agents: Array<object>, events?: Array<object>, workflowId: string, projectId?: string,
 *   workflow?: { title?: string, goal?: string, status?: string }, onClose?: () => void }} props
 */
export function AgentsPanel({ agents, events = [], workflowId, projectId, workflow, onClose }) {
  const [view, setView] = useState('graph');
  const [graphMode, setGraphMode] = useState('orbit');
  const [selectedId, setSelectedId] = useState(null);
  const [height, setHeight] = useState(savedHeight);

  // Drag the bar under the panel (or use the arrow keys on it) to make the panel taller or shorter.
  const startResize = useCallback((e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let last = startH;
    const move = (ev) => { last = clampH(startH + ev.clientY - startY); setHeight(last); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem(HEIGHT_KEY, String(last)); } catch { /* not saved */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [height]);
  const nudge = (d) => setHeight((h) => { const n = clampH(h + d); try { localStorage.setItem(HEIGHT_KEY, String(n)); } catch { /* not saved */ } return n; });

  const activity = useMemo(() => summarizeActivity(events, agents), [events, agents]);
  const labels = useMemo(() => agentLabels(agents), [agents]);
  const rootName = workflow?.title || 'Main agent';
  const rootStatus = workflow?.status || 'running';

  const active = agents.filter((a) => !FINISHED.has(a.status)).length;
  const running = agents.filter((a) => a.status === 'running' || a.status === 'pending').length;
  const finished = agents.length - active;
  const noun = (n) => `${n} subagent${n === 1 ? '' : 's'}`;

  const picked = selectedId === ORBIT_MAIN || selectedId === `session:${workflowId}`
    ? { name: rootName, status: rootStatus, description: workflow?.goal }
    : (() => { const a = agents.find((x) => x.id === selectedId); return a ? { ...a, name: labels.get(a.id) ?? a.name } : a; })();
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

      <div className="agents-panel-body" style={{ '--panel-h': `${height}px` }}>
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
      <div
        className="agents-panel-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize agents panel (drag, or use the up and down arrow keys)"
        tabIndex={0}
        title="Drag to change the height (double-click to reset)"
        onPointerDown={startResize}
        onDoubleClick={() => nudge(420 - height)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); nudge(40); } else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(-40); } }}
      />
    </section>
  );
}
