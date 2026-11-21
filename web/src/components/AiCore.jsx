import { useEffect, useState } from 'react';
import { CLOVER_PIXELS, LIVES, coreLabel, lifeDots } from '../lib/nine-lives.js';

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

// Nine lives on a circle of radius 10 around the centre of a 24-unit box, the first at the top, going clockwise.
const RING = Array.from({ length: LIVES }, (_, i) => {
  const a = (i / LIVES) * Math.PI * 2 - Math.PI / 2;
  return { x: +(12 + Math.cos(a) * 10 - 0.9).toFixed(2), y: +(12 + Math.sin(a) * 10 - 0.9).toFixed(2) };
});

/**
 * The portal's core, the "nine lives ring": a pixel four-leaf clover inside nine pixel lives, coloured from the theme.
 * idle: one life brightens in turn round the ring; running: one life per running agent (`active`, three when unknown), pulsing, the ring
 * turning; success: all nine lit; failed: one life, a leaf and the centre turn red. No motion when `animated` is false or the person
 * asks for reduced motion.
 *
 * @param {{ state?: 'idle'|'running'|'success'|'failed', active?: number, size?: number, animated?: boolean, className?: string }} props
 */
export function AiCore({ state = 'idle', active, size = 120, animated = true, className = '' }) {
  const reduced = usePrefersReducedMotion();
  const live = animated && !reduced;
  const known = ['idle', 'running', 'success', 'failed'].includes(state) ? state : 'idle';
  const dots = lifeDots(known, active);
  return (
    <div
      className={`ai-core ai-core--${known}${live ? ' is-live' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={coreLabel(known, active)}
      data-lit={dots.filter((d) => d === 'on').length}
    >
      <svg className="ai-core-svg" viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true">
        <g className="ai-core-ring">
          {RING.map((p, i) => (
            <rect key={i} className={`ai-core-life is-${dots[i]}`} x={p.x} y={p.y} width="1.8" height="1.8" style={{ '--i': i }} />
          ))}
        </g>
        {/* The position sits on the outer group: the breathing animation sets `transform` on the inner one. */}
        <g transform="translate(6.5 6.5)">
          <g className="ai-core-clover">
            {CLOVER_PIXELS.map((p) => (
              <rect key={`${p.x}-${p.y}-${p.part}`} className={`ai-core-px ai-core-${p.part}`} x={p.x} y={p.y} width="1.02" height="1.02" />
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}
