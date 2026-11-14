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

/**
 * A roomy layout for the Code map: the chosen item in the middle and its neighbours on widening elliptical rings, the best
 * connected on the inner rings and items of one group side by side, so related code sits together and nothing is on top of
 * anything else. The picture grows with the number of items (a repository with fifty neighbours gets a larger canvas, not a
 * smaller drawing), and a short relaxation pass pushes apart any two that still end up too close.
 *
 * @param {{ id: string, c?: number, d?: number }[]} nodes
 * @param {string} centerId
 * @param {{ spacing?: number, aspect?: number }} [opts]
 * @returns {{ pos: Map<string, { x: number, y: number }>, width: number, height: number }}
 */
export function radialLayout(nodes, centerId, opts = {}) {
  const spacing = opts.spacing ?? 118;   // the least distance between two items along a ring
  const aspect = opts.aspect ?? 1.45;    // wider than tall, like the panel it is drawn in
  const margin = 110;
  const others = nodes.filter((n) => n.id !== centerId);
  const byDegree = [...others].sort((a, b) => (b.d ?? 0) - (a.d ?? 0));

  // Ring capacity: how many items fit on an ellipse of vertical radius r.
  const perimeter = (r) => {
    const a = r * aspect;
    const b = r;
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  };
  const rings = [];
  let r = Math.max(210, spacing * 1.8);
  let left = byDegree.length;
  while (left > 0) {
    const cap = Math.max(4, Math.floor(perimeter(r) / spacing));
    const take = Math.min(cap, left);
    rings.push({ r, take });
    left -= take;
    r += spacing * 1.2;
  }

  const rMax = rings.length ? rings[rings.length - 1].r : 150;
  const width = Math.max(900, Math.round(2 * (rMax * aspect + margin)));
  const height = Math.max(600, Math.round(2 * (rMax + margin)));
  const cx = width / 2;
  const cy = height / 2;
  const pos = new Map([[centerId, { x: cx, y: cy }]]);

  let at = 0;
  rings.forEach((ring, ri) => {
    const members = byDegree.slice(at, at + ring.take);
    at += ring.take;
    // Same group side by side, groups in a stable order.
    members.sort((a, b) => (a.c ?? 0) - (b.c ?? 0) || (b.d ?? 0) - (a.d ?? 0));
    const offset = (ri % 2 ? Math.PI / ring.take : 0) + ri * 0.35;
    members.forEach((n, i) => {
      const t = offset + (i / ring.take) * Math.PI * 2 - Math.PI / 2;
      pos.set(n.id, { x: cx + Math.cos(t) * ring.r * aspect, y: cy + Math.sin(t) * ring.r });
    });
  });

  // Relaxation: push apart anything closer than 74 px (a node and its label), keeping the middle item fixed and all inside the frame.
  const min = 74;
  const ids = others.map((n) => n.id);
  for (let step = 0; step < 40; step++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      const a = pos.get(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        const b = pos.get(ids[j]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d >= min) continue;
        const push = (min - d) / 2 + 0.01;
        const ux = d > 0.001 ? dx / d : 1;
        const uy = d > 0.001 ? dy / d : 0;
        a.x -= ux * push; a.y -= uy * push;
        b.x += ux * push; b.y += uy * push;
        moved = true;
      }
    }
    for (const id of ids) {
      const p = pos.get(id);
      p.x = Math.max(60, Math.min(width - 60, p.x));
      p.y = Math.max(50, Math.min(height - 50, p.y));
      const dx = p.x - cx;
      const dy = p.y - cy;
      if (Math.hypot(dx, dy) < 90) { const k = 90 / (Math.hypot(dx, dy) || 1); p.x = cx + dx * k; p.y = cy + dy * k; }
    }
    if (!moved) break;
  }
  return { pos, width, height };
}
