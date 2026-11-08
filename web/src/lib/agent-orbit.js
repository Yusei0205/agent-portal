/**
 * Orbit layout: the main agent in the centre, the agents it started on a ring around it, and the agents those started on
 * the next ring out, close to the angle of their parent. Pure data in, positions out.
 *
 * Positions are in a plane centred on the main agent (0, 0); the view pans and zooms it.
 */

export const ORBIT_MAIN = '__main__';
export const RING_STEP = 135;
const MIN_GAP_PX = 105; // between neighbours on one ring

/**
 * @param {Array<{ id: string, parentId?: string | null, name?: string, status?: string }>} agents
 * @returns {{ nodes: Array<{ id: string, x: number, y: number, depth: number, angle: number, isMain?: boolean }>,
 *   edges: Array<{ from: string, to: string }>, rings: number[], extent: number }}
 */
export function orbitLayout(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const byId = new Map(list.map((a) => [a.id, a]));
  const parentOf = (a) => (a.parentId && a.parentId !== a.id && byId.has(a.parentId) ? a.parentId : ORBIT_MAIN);

  // Depth by walking up; a parent loop (never reaching the main agent) is broken by treating the repeat as depth 1.
  const depthOf = (a, seen = new Set()) => {
    if (seen.has(a.id)) return 1;
    seen.add(a.id);
    const p = parentOf(a);
    return p === ORBIT_MAIN ? 1 : 1 + depthOf(byId.get(p), seen);
  };

  const kids = new Map([[ORBIT_MAIN, []]]);
  for (const a of list) kids.set(a.id, []);
  for (const a of list) {
    // Re-attach a loop member to the main agent so every agent is reachable.
    let p = parentOf(a);
    const seen = new Set([a.id]);
    for (let cur = p; cur !== ORBIT_MAIN; cur = parentOf(byId.get(cur))) {
      if (seen.has(cur)) { p = ORBIT_MAIN; break; }
      seen.add(cur);
    }
    kids.get(p).push(a.id);
  }

  const pos = new Map([[ORBIT_MAIN, { x: 0, y: 0, depth: 0, angle: 0 }]]);
  const edges = [];

  const place = (parent, depth) => {
    const ids = kids.get(parent);
    if (!ids.length) return;
    const radius = depth * RING_STEP;
    const base = depth === 1 ? -Math.PI / 2 : pos.get(parent).angle;
    const span = depth === 1 ? Math.PI * 2 : Math.min(Math.PI * 1.2, Math.max(0.5, (ids.length * MIN_GAP_PX) / radius));
    ids.forEach((id, i) => {
      const angle = depth === 1
        ? base + (Math.PI * 2 * i) / ids.length
        : base + (ids.length === 1 ? 0 : -span / 2 + (span * i) / (ids.length - 1));
      pos.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, depth, angle });
      edges.push({ from: parent, to: id });
    });
    for (const id of ids) place(id, depth + 1);
  };
  place(ORBIT_MAIN, 1);

  // Keep neighbours on one ring apart: families from different parents can land on the same stretch of ring.
  const rings = new Map();
  for (const [id, p] of pos) if (id !== ORBIT_MAIN) { if (!rings.has(p.depth)) rings.set(p.depth, []); rings.get(p.depth).push(id); }
  for (const [depth, ids] of rings) {
    const radius = depth * RING_STEP;
    const minAngle = MIN_GAP_PX / radius;
    ids.sort((a, b) => pos.get(a).angle - pos.get(b).angle);
    for (let i = 1; i < ids.length; i++) {
      const prev = pos.get(ids[i - 1]);
      const cur = pos.get(ids[i]);
      if (cur.angle - prev.angle < minAngle) {
        cur.angle = prev.angle + minAngle;
        cur.x = Math.cos(cur.angle) * radius;
        cur.y = Math.sin(cur.angle) * radius;
      }
    }
  }

  const maxDepth = Math.max(0, ...[...pos.values()].map((p) => p.depth));
  const nodes = [...pos.entries()].map(([id, p]) => ({ id, ...p, ...(id === ORBIT_MAIN ? { isMain: true } : {}) }));
  return {
    nodes,
    edges,
    rings: Array.from({ length: maxDepth }, (_, i) => (i + 1) * RING_STEP),
    extent: (maxDepth + 0.6) * RING_STEP,
  };
}

/**
 * The fibre between two agents: a gentle curve (so the links look like nerves, not ruler lines), as an SVG path from `a` to
 * `b`, with the length for timing a signal along it. `bend` flips the curve's side so neighbours do not all lean one way.
 * @returns {{ d: string, length: number }}
 */
export function nervePath(a, b, bend = 1) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return { d: `M${a.x} ${a.y} L${b.x} ${b.y}`, length };
  const offset = Math.min(60, length * 0.16) * (bend >= 0 ? 1 : -1);
  const cx = (a.x + b.x) / 2 - (dy / length) * offset;
  const cy = (a.y + b.y) / 2 + (dx / length) * offset;
  const r = (n) => Math.round(n * 10) / 10;
  return { d: `M${r(a.x)} ${r(a.y)} Q${r(cx)} ${r(cy)} ${r(b.x)} ${r(b.y)}`, length };
}

/**
 * The agent nearest in a direction from the selected one, for arrow-key navigation. `dir` is a unit vector.
 * With nothing selected the main agent is the starting point.
 */
export function neighbourInDirection(nodes, fromId, dir) {
  const from = nodes.find((n) => n.id === (fromId ?? ORBIT_MAIN));
  if (!from) return null;
  let best = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    if (n.id === from.id) continue;
    const dx = n.x - from.x;
    const dy = n.y - from.y;
    const dist = Math.hypot(dx, dy);
    const along = (dx * dir.x + dy * dir.y) / (dist || 1);
    if (along < 0.5) continue; // within about 60 degrees of the direction
    const score = dist / along; // closer and straighter first
    if (score < bestScore) { bestScore = score; best = n; }
  }
  return best ? best.id : null;
}
