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
        if (width > 0 && height > 0) setViewport(getViewportForBounds(getNodesBounds(getNodes()), width, height, 0.1, 1.5, 0.2));
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container.current);
    fit();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [setViewport, getNodes, container]);
  return null;
}

/**
 * @param {{ agents: Array<object>, workflowId: string, selectedId?: string | null, onSelect?: (id: string) => void }} props
 * Selecting a node (click, or Enter/Space on its name) reports its id; the session itself is `session:<workflowId>`.
 */
export function AgentGraph({ agents, workflowId, selectedId = null, onSelect }) {
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
  const colors = { running: 'var(--accent)', pending: 'var(--ink-3)', done: 'var(--ok)', failed: 'var(--danger)', stopped: 'var(--ink-3)' };
  // The name is a real button so keyboard users can select a node; clicking anywhere on the node does too.
  const pick = (id, children, label) => (
    <button type="button" className="agent-node-btn" aria-label={label} aria-pressed={id === selectedId} onClick={() => onSelect?.(id)}>{children}</button>
  );
  const nodes = [{ id: root, position: { x: 0, y: 0 }, data: { label: pick(root, <strong>Session lead</strong>, 'Session lead') } }, ...agents.map((a, i) => ({
    id: a.id, position: { x: depth(a) * 250, y: i * 100 },
    style: { borderColor: colors[a.status] || 'var(--line)' },
    data: { label: pick(a.id, <><strong>{a.name}</strong><div style={{ fontSize: 12 }}>{a.status}</div></>, `${a.name}, ${a.status}`) },
  }))].map(n => ({ ...n, sourcePosition: 'right', targetPosition: 'left', width: 210, height: 64, style: { width: 210, color: 'var(--ink)', background: 'var(--panel, #101820)', ...n.style, ...(n.id === selectedId ? { borderWidth: 3, borderColor: 'var(--accent)' } : {}) } }));
  const edges = agents.map(a => ({ id: `edge:${a.id}`, source: parent(a), target: a.id, animated: a.status === 'running' }));
  return <div ref={container} style={{ height: '100%', minHeight: 260 }} aria-label="Agent collaboration graph">
    <ReactFlow key={agents.map(a => a.id).join('|')} nodes={nodes} edges={edges} nodesDraggable={false} nodesConnectable={false} minZoom={0.1} onNodeClick={(_, node) => onSelect?.(node.id)}>
      <Background /><Controls showInteractive={false} /><FitGraph container={container} />
    </ReactFlow>
  </div>;
}
