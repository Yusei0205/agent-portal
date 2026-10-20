import { cx, hueFor, money, tokens } from '../lib/util.js';
import { toolSummary } from '../lib/tree.js';

const STATUS_TEXT = { running: 'working', done: 'done', failed: 'failed', stopped: 'stopped', waiting: 'waiting for you' };

/** One line about what this agent is doing right now (or did last). */
function nowLine(node) {
  for (let i = node.items.length - 1; i >= 0; i--) {
    const it = node.items[i];
    if (it.kind === 'tool' && it.status === 'running' && !it.childId) return `${it.name}: ${toolSummary(it.name, it.input)}`;
  }
  if (node.status === 'running') {
    const open = node.children.filter((c) => c.status === 'running');
    if (open.length) return `waiting for ${open.map((c) => c.label).join(', ')}`;
  }
  for (let i = node.items.length - 1; i >= 0; i--) {
    const it = node.items[i];
    if (it.kind === 'text') return it.text.replace(/\s+/g, ' ').trim().slice(0, 90);
    if (it.kind === 'tool' && !it.childId) return `${it.name}: ${toolSummary(it.name, it.input)}`;
  }
  return node.description || '';
}

function GraphNode({ node, selected, onSelect }) {
  const hue = node.kind === 'main' ? null : hueFor(node.label);
  const line = nowLine(node);
  return (
    <li className="ag-branch">
      <button
        type="button"
        className={cx('ag-node', `ag-${node.status}`, node.kind === 'main' && 'ag-main', selected === node.id && 'is-selected')}
        style={hue !== null ? { '--role-h': hue } : undefined}
        onClick={() => onSelect(node.id)}
        aria-pressed={selected === node.id}
      >
        <span className="ag-head">
          <span className="ag-dot" aria-hidden="true" />
          <strong className="ag-label">{node.label}</strong>
          <span className="ag-state">{STATUS_TEXT[node.status] ?? node.status}</span>
        </span>
        {line ? <span className="ag-now">{line}</span> : null}
        <span className="ag-stats">
          {node.toolCount} tool{node.toolCount === 1 ? '' : 's'} · {tokens(node.inputTokens + node.outputTokens)} tokens{node.cost ? ` · ≈${money(node.cost)}` : ''}
        </span>
      </button>
      {node.children.length ? (
        <ul className="ag-children">
          {node.children.map((c) => (
            <GraphNode key={c.id} node={c} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The agents of one run as a live graph: the main agent on top, the subagents it started below it. */
export function AgentGraph({ tree, selected, onSelect }) {
  const running = [...tree.nodes.values()].filter((n) => n.status === 'running').length;
  return (
    <section className="agraph" aria-label="Agent graph">
      <div className="agraph-head">
        <h2>Agents</h2>
        <span className="muted small">
          {tree.root.totals.subagents} subagent{tree.root.totals.subagents === 1 ? '' : 's'}
          {running ? ` · ${running} working now` : ''}
        </span>
      </div>
      <div className="agraph-scroll">
        <ul className="ag-tree">
          <GraphNode node={tree.root} selected={selected} onSelect={onSelect} />
        </ul>
      </div>
    </section>
  );
}
