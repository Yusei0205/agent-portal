// Positions for the agent canvas: a top-down tidy tree. Leaves take consecutive slots; a parent sits centred over its
// children, so subagents started in parallel line up side by side under the agent that started them.

export const LAYOUT = { colW: 168, rowH: 150, padX: 24, padY: 56 };

/**
 * @param root    tree node ({ id, children })
 * @param options collapsed: Set of node ids whose children are hidden
 * @returns { pos: Map<id, {x, y, depth}>, parent: Map<id, id|null>, edges: [{ from, to }], width, height }
 */
export function layoutTree(root, { collapsed = new Set(), colW = LAYOUT.colW, rowH = LAYOUT.rowH, padX = LAYOUT.padX, padY = LAYOUT.padY } = {}) {
  const pos = new Map();
  const parent = new Map([[root.id, null]]);
  const edges = [];
  let slot = 0;
  let maxDepth = 0;
  const visit = (n, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = collapsed.has(n.id) ? [] : n.children;
    let x;
    if (!kids.length) {
      x = slot++;
    } else {
      const xs = kids.map((c) => {
        parent.set(c.id, n.id);
        edges.push({ from: n.id, to: c.id });
        return visit(c, depth + 1);
      });
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    pos.set(n.id, { x, y: depth, depth });
    return x;
  };
  visit(root, 0);
  for (const p of pos.values()) {
    p.x = padX + p.x * colW + colW / 2;
    p.y = padY + p.y * rowH;
  }
  return { pos, parent, edges, width: padX * 2 + Math.max(1, slot) * colW, height: padY + maxDepth * rowH + rowH };
}

/** A key that changes only when the shape of the tree changes, so positions stay put while statuses update. */
export function shapeKey(root, collapsed = new Set()) {
  const parts = [];
  const walk = (n) => {
    parts.push(n.id, collapsed.has(n.id) ? '+' : '(');
    if (!collapsed.has(n.id)) for (const c of n.children) walk(c);
    parts.push(')');
  };
  walk(root);
  return parts.join(' ');
}

/** "business-analyst" → "BA", "Main agent" → "MA". */
export function initials(label) {
  const words = String(label || '?')
    .split(/[\s_\-./]+/)
    .filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

/** The node that most recently did something while running: the one "Follow live" shows. */
export function liveNode(nodes) {
  let best = null;
  let bestSeq = -1;
  for (const n of nodes.values()) {
    if (n.status !== 'running') continue;
    const last = n.items.length ? n.items[n.items.length - 1].seq ?? 0 : 0;
    // Ties go to the deeper (later-created) agent: it is the one actually doing the work.
    if (last >= bestSeq) {
      best = n;
      bestSeq = last;
    }
  }
  return best;
}
