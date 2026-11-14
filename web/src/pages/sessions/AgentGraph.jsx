import { useEffect, useRef } from 'react';
import { ReactFlow, Background, Controls, useReactFlow, getNodesBounds, getViewportForBounds } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

function FitGraph({ container }) {
  const { setViewport, getNodes } = useReactFlow();
  useEffect(() => {
    if (!container.current) return;
    let frame;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { width, height } = container.current.getBoundingClientRect();
        if (width > 0 && height > 0) setViewport(getViewportForBounds(getNodesBounds(getNodes()), width, height, 0.1, 1.5, 0.05));
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container.current);
    fit();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [setViewport, getNodes, container]);
  return null;
}

const NODE_W = 220;
const NODE_H = 96;
const COL = 255;
const ROW = 108;

/**
 * @param {{ agents: Array<object>, workflowId: string, selectedId?: string | null, onSelect?: (id: string) => void,
 *   rootTask?: string, rootStatus?: string }} props
 * Selecting a node (click, or Enter/Space on its name) reports its id; the session itself is `session:<workflowId>`.
 * Each node shows the agent's name, status and task; the tree grows to the right, one column per level.
 */
export function AgentGraph({ agents, workflowId, selectedId = null, onSelect, rootTask, rootStatus }) {
  const container = useRef(null);
  const root = `session:${workflowId}`;
  const ids = new Set(agents.map(a => a.id));
  const parent = agent => ids.has(agent.parentId) && agent.parentId !== agent.id ? agent.parentId : root;
  const depth = (agent, seen = new Set()) => {
    if (seen.has(agent.id)) return 1;
    seen.add(agent.id);
    const ancestor = agents.find(a => a.id === parent(agent));
    return ancestor ? Math.min(8, 1 + depth(ancestor, seen)) : 1;
  };

  // Tidy tree: each leaf gets its own row and a parent sits level with the middle of its children, so the graph stays compact.
  const kids = new Map([[root, []]]);
  for (const a of agents) kids.set(a.id, []);
  for (const a of agents) kids.get(parent(a))?.push(a.id);
  const rows = new Map();
  const placed = new Set();
  let nextRow = 0;
  const place = (id) => {
    if (placed.has(id)) return rows.get(id);
    placed.add(id);
    const children = kids.get(id) || [];
    let row;
    if (children.length) {
      const r = children.map(place);
      row = (r[0] + r[r.length - 1]) / 2;
    } else row = nextRow++;
    rows.set(id, row);
    return row;
  };
  place(root);
  // An agent caught in a parent loop is not reachable from the session; give it a row of its own rather than lose it.
  for (const a of agents) if (!placed.has(a.id)) place(a.id);

  const colors = { running: 'var(--accent)', pending: 'var(--ink-3)', done: 'var(--ok)', failed: 'var(--danger)', stopped: 'var(--ink-3)' };
  // The name is a real button so keyboard users can select a node; clicking anywhere on the node does too.
  const pick = (id, label, children) => (
    <button type="button" className="agent-node-btn" aria-label={label} aria-pressed={id === selectedId} onClick={() => onSelect?.(id)}>{children}</button>
  );
  const card = (name, status, task) => (
    <>
      <strong className="agent-node-name">{name}</strong>
      <span className="agent-node-status" style={{ color: colors[status] || 'var(--ink-3)' }}>{status || ''}</span>
      {task && <span className="agent-node-task">{task}</span>}
    </>
  );
  const nodes = [
    { id: root, position: { x: 0, y: (rows.get(root) ?? 0) * ROW }, style: { borderColor: colors[rootStatus] || 'var(--line)' }, data: { label: pick(root, 'Session lead', card('Session lead', rootStatus, rootTask)) } },
    ...agents.map((a) => ({
      id: a.id, position: { x: depth(a) * COL, y: (rows.get(a.id) ?? 0) * ROW },
      style: { borderColor: colors[a.status] || 'var(--line)' },
      data: { label: pick(a.id, `${a.name}, ${a.status}`, card(a.name, a.status, a.description)) },
    })),
  ].map(n => ({ ...n, sourcePosition: 'right', targetPosition: 'left', width: NODE_W, height: NODE_H, style: { width: NODE_W, color: 'var(--ink)', background: 'var(--panel, #101820)', ...n.style, ...(n.id === selectedId ? { borderWidth: 3, borderColor: 'var(--accent)' } : {}) } }));
  const edges = agents.map(a => ({ id: `edge:${a.id}`, source: parent(a), target: a.id, animated: a.status === 'running' }));
  return <div ref={container} style={{ height: '100%', minHeight: 260 }} aria-label="Agent collaboration graph">
    <ReactFlow key={agents.map(a => a.id).join('|')} nodes={nodes} edges={edges} nodesDraggable={false} nodesConnectable={false} minZoom={0.1} onNodeClick={(_, node) => onSelect?.(node.id)}>
      <Background /><Controls showInteractive={false} /><FitGraph container={container} />
    </ReactFlow>
  </div>;
}
