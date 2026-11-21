import { SPRITES, SPRITE_SIZE, frameCount, sheetRects } from '../lib/cat-sprites.js';

// Each sprite's rectangles are computed once; horizontal runs of one colour are merged so adjacent pixels leave no seams.
const SHEETS = {};
function sheet(name) {
  if (SHEETS[name]) return SHEETS[name];
  const runs = [];
  let prev = null;
  for (const p of sheetRects(name)) {
    if (prev && prev.key === p.key && prev.frame === p.frame && prev.y === p.y && prev.x + prev.w === p.x) prev.w += 1;
    else { prev = { ...p, w: 1 }; runs.push(prev); }
  }
  SHEETS[name] = runs;
  return runs;
}

/** A pixel-art cat animation: one SVG sheet of frames, stepped with CSS (see mascot.css). Decorative. */
export function CatSprite({ name, flip = false, size = 56 }) {
  const spec = SPRITES[name];
  const n = frameCount(name);
  const style = {
    width: size,
    height: size,
    '--cat-n': n,
    '--cat-dur': `${n / spec.fps}s`,
    '--cat-iter': spec.loop ? 'infinite' : '1',
    transform: flip ? 'scaleX(-1)' : undefined,
  };
  return (
    <div className="cat-sprite" style={style} aria-hidden="true" data-sprite={name}>
      <svg className="cat-sheet" viewBox={`0 0 ${SPRITE_SIZE * n} ${SPRITE_SIZE}`} preserveAspectRatio="none" shapeRendering="crispEdges" focusable="false">
        {sheet(name).map((r, i) => (
          <rect key={i} x={r.frame * SPRITE_SIZE + r.x} y={r.y} width={r.w} height="1" style={{ fill: `var(--cat-${r.key})` }} />
        ))}
      </svg>
    </div>
  );
}
