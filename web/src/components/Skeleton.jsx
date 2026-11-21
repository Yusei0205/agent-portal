/**
 * Skeleton loading placeholder.
 *
 * Usage:
 *   <Skeleton height={20} width="60%" />
 *   <Skeleton variant="card" />
 *   <SkeletonList count={4} />
 */

/**
 * @param {{
 *   height?: number | string,
 *   width?: number | string,
 *   variant?: 'text' | 'card' | 'kpi' | 'row',
 *   className?: string,
 *   style?: object,
 * }} props
 */
export function Skeleton({ height, width, variant, className = '', style = {} }) {
  const baseClass = `skeleton${variant ? ` skeleton-${variant}` : ''}${className ? ` ${className}` : ''}`;
  const h = variant === 'kpi'  ? 96
           : variant === 'card' ? 120
           : variant === 'row'  ? 36
           : height ?? 18;
  const w = width ?? '100%';
  return (
    <div
      className={baseClass}
      style={{ height: typeof h === 'number' ? `${h}px` : h, width: w, ...style }}
      aria-hidden="true"
    />
  );
}

/**
 * Renders `count` skeleton rows.
 * @param {{ count?: number, gap?: number }} props
 */
export function SkeletonList({ count = 4, gap = 8 }) {
  return (
    <div style={{ display: 'grid', gap }} aria-hidden="true" aria-label="Loading…">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} variant="row" />
      ))}
    </div>
  );
}

/**
 * Renders `count` skeleton KPI cards in a kpi-row grid.
 * @param {{ count?: number }} props
 */
export function SkeletonKpiRow({ count = 4 }) {
  return (
    <div className="kpi-row" aria-hidden="true" aria-label="Loading statistics…">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} variant="kpi" />
      ))}
    </div>
  );
}
