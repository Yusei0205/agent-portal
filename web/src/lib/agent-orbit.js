/**
 * Orbit layout: the main agent in the centre, the agents it started on a ring around it, and the agents those started on
 * the next ring out, close to the angle of their parent. Pure data in, positions out.
 *
 * Positions are in a plane centred on the main agent (0, 0); the view pans and zooms it.
 */

export const ORBIT_MAIN = '__main__';
// An agent is drawn as a circle with its name and current action under it: a box about 190px wide and 106px tall. Two such
// boxes can only overlap when their centres are closer than the box's diagonal (about 218px), so every pair of agents is
// kept at least MIN_GAP_PX apart: agents on one ring by the straight line between them, and rings by a full RING_STEP, which
// also covers 3 and 9 o'clock where the distance between rings is horizontal.
export const RING_STEP = 230;
const MIN_GAP_PX = 225;

/** The ring radius at which `n` agents fit side by side around a full circle with at least MIN_GAP_PX between neighbours. */
const radiusToFit = (n) => (n <= 1 ? 0 : MIN_GAP_PX / (2 * Math.sin(Math.PI / n)));

/**
 * @param {Array<{ id: string, parentId?: string | null, name?: string, status?: string }>} agents
 * @returns {{ nodes: Array<{ id: string, x: number, y: number, depth: number, angle: number, isMain?: boolean }>,
 *   edges: Array<{ from: string, to: string }>, rings: number[], extent: number }}
 */
export function orbitLayout(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const byId = new Map(list.map((a) => [a.id, a]));
  const parentOf = (a) => (a.parentId && a.parentId !== a.id && byId.has(a.parentId) ? a.parentId : ORBIT_MAIN);

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
  const radii = [];

  // Ring by ring. Each ring is as wide as its agents need, and at least one ring step outside the one before.
  let level = [ORBIT_MAIN];
  for (let depth = 1; level.length; depth++) {
    const members = [];
    for (const parent of level) for (const id of kids.get(parent)) { members.push({ id, parent }); edges.push({ from: parent, to: id }); }
    if (!members.length) break;

    const radius = Math.max(depth * RING_STEP, (radii[depth - 2] ?? 0) + RING_STEP, radiusToFit(members.length));
    radii.push(radius);
    const minAngle = 2 * Math.asin(Math.min(1, MIN_GAP_PX / (2 * radius)));

    // Where each agent would like to be: the first ring evenly round the circle starting at the top; further rings
    // close to the angle of the parent, the children of one parent spread around it.
    const desired = new Map();
    if (depth === 1) {
      members.forEach((m, i) => desired.set(m.id, -Math.PI / 2 + (Math.PI * 2 * i) / members.length));
    } else {
      for (const parent of level) {
        const ids = kids.get(parent);
        if (!ids.length) continue;
        const base = pos.get(parent).angle;
        const span = Math.min(Math.PI * 1.2, Math.max(0.5, ((ids.length - 1) * minAngle)));
        ids.forEach((id, i) => desired.set(id, base + (ids.length === 1 ? 0 : -span / 2 + (span * i) / (ids.length - 1))));
      }
    }

    // Spread them so neighbours (round the whole circle, the last next to the first) keep minAngle between them: push
    // each too-close pair apart by the same amount until none is. The ring is wide enough for this to settle.
    const order = members.map((m) => m.id).sort((a, b) => desired.get(a) - desired.get(b));
    const angle = order.map((id) => desired.get(id));
    for (let pass = 0; pass < 600; pass++) {
      let moved = false;
      for (let i = 0; i < angle.length; i++) {
        const j = (i + 1) % angle.length;
        if (j === i) break;
        const a = angle[i];
        const b = j === 0 ? angle[0] + Math.PI * 2 : angle[j];
        const gap = b - a;
        if (gap < minAngle - 1e-9) {
          const push = (minAngle - gap) / 2;
          angle[i] -= push;
          angle[j] += push;
          moved = true;
        }
      }
      if (!moved) break;
    }
    order.forEach((id, i) => pos.set(id, { x: Math.cos(angle[i]) * radius, y: Math.sin(angle[i]) * radius, depth, angle: angle[i] }));
    level = order;
  }

  const outer = radii.length ? radii[radii.length - 1] : 0;
  const nodes = [...pos.entries()].map(([id, p]) => ({ id, ...p, ...(id === ORBIT_MAIN ? { isMain: true } : {}) }));
  return { nodes, edges, rings: radii, extent: outer + 0.6 * RING_STEP };
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
