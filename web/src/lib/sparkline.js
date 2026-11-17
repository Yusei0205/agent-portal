/**
 * Geometry of a small trend line (the sparkline under a dashboard card): the line path, the filled area under it and the last
 * point, for a series of numbers. Fewer than two usable numbers give null (nothing to draw).
 */

/** Numbers only: a missing or non-finite value is dropped. */
export function cleanSeries(values) {
  return (values ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * @param {Array<number|null|undefined>} values
 * @param {{ width?: number, height?: number, pad?: number }} [box]
 * @returns {{ line: string, area: string, last: [number, number], min: number, max: number } | null}
 */
export function sparkPath(values, { width = 160, height = 28, pad = 3 } = {}) {
  const v = cleanSeries(values);
  if (v.length < 2) return null;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min;
  const stepX = (width - pad * 2) / (v.length - 1);
  const pts = v.map((n, i) => {
    const x = pad + i * stepX;
    // A flat series sits in the middle instead of on the bottom edge.
    const y = span === 0 ? height / 2 : pad + (1 - (n - min) / span) * (height - pad * 2);
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0]} ${height} L${pts[0][0]} ${height} Z`;
  return { line, area, last: pts[pts.length - 1], min, max };
}
