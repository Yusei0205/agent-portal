/**
 * A small force layout for the Code map: items repel each other, linked items pull together, and the chosen item sits in
 * the middle. Deterministic (no random start), so the same neighbourhood always draws the same way. Meant for the
 * few dozen items of one neighbourhood, not for a whole repository.
 *
 * @param {{ id: string }[]} nodes
 * @param {{ s: string, t: string }[]} links
 * @param {string} centerId
 * @param {{ width?: number, height?: number, iterations?: number }} [opts]
 * @returns {Map<string, { x: number, y: number }>}
 */
export function forceLayout(nodes, links, centerId, opts = {}) {
  const width = opts.width ?? 900;
  const height = opts.height ?? 560;
  const iterations = opts.iterations ?? 260;
  const cx = width / 2;
  const cy = height / 2;
  const n = nodes.length;
  const pos = nodes.map((node, i) => {
    if (node.id === centerId) return { x: cx, y: cy, vx: 0, vy: 0 };
    // Start on a ring around the centre.
    const a = (i / Math.max(1, n - 1)) * Math.PI * 2;
    const r = Math.min(width, height) * 0.32;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, vx: 0, vy: 0 };
  });
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const edges = [];
  for (const l of links) {
    const a = index.get(l.s);
    const b = index.get(l.t);
    if (a != null && b != null && a !== b) edges.push([a, b]);
  }
  const ideal = Math.max(90, Math.min(170, Math.sqrt((width * height) / Math.max(1, n)) * 1.1));
  for (let step = 0; step < iterations; step++) {
    const cool = 1 - step / iterations;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i % 2 ? 1 : -1) * 0.1; dy = (j % 2 ? 1 : -1) * 0.1; d2 = 0.02; }
        const d = Math.sqrt(d2);
        const f = (ideal * ideal) / d2;
        pos[i].vx += (dx / d) * f; pos[i].vy += (dy / d) * f;
        pos[j].vx -= (dx / d) * f; pos[j].vy -= (dy / d) * f;
      }
    }
    for (const [a, b] of edges) {
      const dx = pos[b].x - pos[a].x;
      const dy = pos[b].y - pos[a].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - ideal) * 0.06;
      pos[a].vx += (dx / d) * f; pos[a].vy += (dy / d) * f;
      pos[b].vx -= (dx / d) * f; pos[b].vy -= (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      pos[i].vx += (cx - pos[i].x) * 0.004;
      pos[i].vy += (cy - pos[i].y) * 0.004;
      if (nodes[i].id === centerId) { pos[i].x = cx; pos[i].y = cy; pos[i].vx = pos[i].vy = 0; continue; }
      const speed = Math.hypot(pos[i].vx, pos[i].vy) || 1;
      const cap = 14 * cool + 1;
      const k = Math.min(1, cap / speed);
      pos[i].x += pos[i].vx * k; pos[i].y += pos[i].vy * k;
      pos[i].vx *= 0.5; pos[i].vy *= 0.5;
      pos[i].x = Math.max(40, Math.min(width - 40, pos[i].x));
      pos[i].y = Math.max(30, Math.min(height - 30, pos[i].y));
    }
  }
  return new Map(nodes.map((node, i) => [node.id, { x: pos[i].x, y: pos[i].y }]));
}
