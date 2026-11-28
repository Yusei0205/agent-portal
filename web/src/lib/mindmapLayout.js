/**
 * The Code map's mind-map layout: the chosen item in a card in the middle, its main neighbours as pill cards in two columns
 * either side (with one above and one below when there are enough), and each main neighbour's own neighbours as a small fan of
 * squares beyond it. Everything is placed on a grid of rows, so nothing overlaps whatever the number of items.
 *
 * Sizes are in the drawing's own units (the SVG scales them to the panel). The caller passes each pill's width (it knows the
 * label) and how many small squares it has.
 *
 * @param {{ id: string, w: number, kids: number }[]} mains  best connected first
 * @param {{ pillH?: number, kidSize?: number, rowGap?: number, centerSize?: number }} [opts]
 * @returns {{
 *   width: number, height: number,
 *   center: { x: number, y: number, size: number },
 *   mains: Map<string, { x: number, y: number, w: number, h: number, side: 'left' | 'right' | 'top' | 'bottom' }>,
 *   kids: Map<string, { x: number, y: number, size: number, side: string }[]>,
 * }}
 */
export function mindmapLayout(mains, opts = {}) {
  const pillH = opts.pillH ?? 42;
  const kidSize = opts.kidSize ?? 28;
  const centerSize = opts.centerSize ?? 124;
  const rowH = Math.max(pillH + 22, opts.rowGap ?? 124);
  const n = mains.length;

  // One pill above and one below once there are enough; the rest split between the two sides, best connected alternately.
  const top = n >= 6 ? mains[0] : null;
  const bottom = n >= 7 ? mains[1] : null;
  const rest = mains.filter((m) => m !== top && m !== bottom);
  const right = [];
  const left = [];
  rest.forEach((m, i) => (i % 2 === 0 ? right : left).push(m));

  const half = centerSize / 2;
  const sideRows = Math.max(right.length, left.length, 1);
  const colHeight = sideRows * rowH;
  // Room for a pill above and below the middle card.
  const innerH = Math.max(colHeight, centerSize + (top ? 2 * 150 : 0) + 40);
  const cx0 = 0;
  const cy0 = 0;
  const out = { mains: new Map(), kids: new Map() };

  const placeSide = (list, sign) => {
    const k = list.length;
    list.forEach((m, i) => {
      const dy = (i - (k - 1) / 2) * rowH;
      // The columns bulge outwards in the middle, like the arms of a mind map.
      const reach = Math.max(1, (k * rowH) / 2 + 40);
      const bulge = 46 * Math.sqrt(Math.max(0, 1 - (dy / reach) ** 2));
      const x = cx0 + sign * (half + 92 + m.w / 2 + bulge);
      const y = cy0 + dy;
      out.mains.set(m.id, { x, y, w: m.w, h: pillH, side: sign > 0 ? 'right' : 'left' });
      const c = Math.min(m.kids, 3);
      const spots = [];
      for (let j = 0; j < c; j++) {
        const ky = y + (j - (c - 1) / 2) * (kidSize + 14);
        const kx = x + sign * (m.w / 2 + 50 + (j === Math.floor((c - 1) / 2) && c % 2 ? 12 : 0));
        spots.push({ x: kx, y: ky, size: kidSize, side: sign > 0 ? 'right' : 'left' });
      }
      out.kids.set(m.id, spots);
    });
  };
  placeSide(right, 1);
  placeSide(left, -1);

  const placeEnd = (m, sign) => {
    if (!m) return;
    const y = cy0 + sign * (half + 112);
    out.mains.set(m.id, { x: cx0, y, w: m.w, h: pillH, side: sign < 0 ? 'top' : 'bottom' });
    const c = Math.min(m.kids, 3);
    const spots = [];
    for (let j = 0; j < c; j++) {
      const kx = cx0 + (j - (c - 1) / 2) * (kidSize + 30);
      const ky = y + sign * (pillH / 2 + 56 + (j === Math.floor((c - 1) / 2) && c % 2 ? 12 : 0));
      spots.push({ x: kx, y: ky, size: kidSize, side: sign < 0 ? 'top' : 'bottom' });
    }
    out.kids.set(m.id, spots);
  };
  placeEnd(top, -1);
  placeEnd(bottom, 1);

  // Bounds of everything, then shift so the drawing starts at a margin.
  let minX = -half; let maxX = half; let minY = -half; let maxY = half;
  const grow = (x, y, w, h) => { minX = Math.min(minX, x - w / 2); maxX = Math.max(maxX, x + w / 2); minY = Math.min(minY, y - h / 2); maxY = Math.max(maxY, y + h / 2); };
  for (const m of out.mains.values()) grow(m.x, m.y, m.w, m.h);
  for (const list of out.kids.values()) for (const k of list) grow(k.x, k.y, k.size, k.size);
  const margin = 56;
  const dx = margin - minX;
  const dy = margin - minY;
  for (const m of out.mains.values()) { m.x += dx; m.y += dy; }
  for (const list of out.kids.values()) for (const k of list) { k.x += dx; k.y += dy; }
  const width = Math.round(maxX - minX + 2 * margin);
  const height = Math.round(maxY - minY + 2 * margin);
  void innerH;
  return { width, height, center: { x: cx0 + dx, y: cy0 + dy, size: centerSize }, mains: out.mains, kids: out.kids };
}
