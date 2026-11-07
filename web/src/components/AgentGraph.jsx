const STATUS = { running: 'Running', waiting: 'Waiting', done: 'Completed', failed: 'Failed', stopped: 'Stopped' };

function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const match = findNode(child, id);
    if (match) return match;
  }
  return null;
}

function Branch({ node, selected, onSelect }) {
  const task = node.description || (node.kind === 'main' ? 'Coordinates this run' : 'Delegated task');
  return (
    <li className="agent-graph-branch">
      <button type="button" className="agent-graph-node" aria-pressed={selected === node.id} onClick={() => onSelect(node.id)}>
        <span className="agent-graph-name">{node.label}</span>
        <span className={`agent-graph-status agent-graph-status-${node.status}`}>{STATUS[node.status] || node.status}</span>
        <span className="agent-graph-summary">{task}</span>
        <span className="agent-graph-meta">{node.toolCount || 0} tool calls</span>
      </button>
      {node.children?.length ? (
        <ul className="agent-graph-children">
          {node.children.map((child) => <Branch key={child.id} node={child} selected={selected} onSelect={onSelect} />)}
        </ul>
      ) : null}
    </li>
  );
}

export function AgentGraph({ root, selected, onSelect, mainTask }) {
  const node = findNode(root, selected) || root;
  const task = node.kind === 'main' ? mainTask : node.prompt || node.description;
  return (
    <section className="agent-graph" aria-label="Agent collaboration">
      <h2>Agents working together</h2>
      <p className="agent-graph-help">Connections show who delegated each task. Select an agent to view its task and activity below.</p>
      <div className="agent-graph-scroll" tabIndex={0} role="region" aria-label="Agent task graph">
        <ul className="agent-graph-root"><Branch node={root} selected={node.id} onSelect={onSelect} /></ul>
      </div>
      {!root.children?.length ? <p className="agent-graph-help">No delegated agents have appeared in this run yet.</p> : null}
      <div className="agent-graph-task">
        <h3>{node.label} task</h3>
        <p className="agent-graph-help">{STATUS[node.status] || node.status}</p>
        {task ? <pre>{task}</pre> : <p>No task details recorded.</p>}
      </div>
    </section>
  );
}
