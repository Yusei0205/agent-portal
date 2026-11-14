import { useCallback, useEffect, useRef, useState } from 'react';

const MIN = 0.2;
const MAX = 8;
const clamp = (v) => Math.min(MAX, Math.max(MIN, v));

/**
 * Pan and zoom for a picture or diagram: drag to move, mouse wheel (or the buttons, or + / - / 0 on the keyboard)
 * to zoom, Reset to fit again.
 *
 * @param {{ children: any, className?: string, height?: string, label?: string }} props
 */
export function PanZoom({ children, className = '', height = '70vh', label = 'Diagram' }) {
  const frame = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef(null);

  const zoomAt = useCallback((factor, cx, cy) => {
    setView((v) => {
      const k = clamp(v.k * factor);
      const f = k / v.k;
      // Keep the point under the cursor where it is.
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  }, []);

  const zoomCentre = (factor) => {
    const r = frame.current?.getBoundingClientRect();
    zoomAt(factor, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2);
  };
  const reset = () => setView({ x: 0, y: 0, k: 1 });

  useEffect(() => {
    const el = frame.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // The pointer is only captured once it has moved a few pixels (a drag). Capturing on press would send the click to this frame
  // instead of the item under the pointer, so nothing inside the picture (a card in the Code map) could be clicked.
  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest('.panzoom-bar')) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, dragging: false };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    if (e.buttons === 0) { drag.current = null; return; }
    if (!d.dragging) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.dragging = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
  };
  const onPointerUp = () => { drag.current = null; };
  const onKeyDown = (e) => {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCentre(1.2); }
    else if (e.key === '-') { e.preventDefault(); zoomCentre(1 / 1.2); }
    else if (e.key === '0') { e.preventDefault(); reset(); }
  };

  return (
    <div
      ref={frame}
      className={`panzoom ${className}`}
      style={{ height }}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Drag to pan, scroll to zoom, 0 to reset.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    >
      <div className="panzoom-bar" role="toolbar" aria-label="Zoom">
        <button type="button" className="btn-icon" onClick={() => zoomCentre(1 / 1.25)} aria-label="Zoom out" title="Zoom out">−</button>
        <span className="panzoom-pct" aria-live="polite">{Math.round(view.k * 100)}%</span>
        <button type="button" className="btn-icon" onClick={() => zoomCentre(1.25)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" className="btn-icon panzoom-reset" onClick={reset} aria-label="Reset zoom and position" title="Reset (or double-click)">Reset</button>
      </div>
      <div className="panzoom-stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Zoom for text (a document): A−, A+ and Reset change the text size; scrolling works as usual.
 *
 * @param {{ children: any, className?: string }} props
 */
export function TextZoom({ children, className = '' }) {
  const [k, setK] = useState(1);
  return (
    <div className={`textzoom ${className}`}>
      <div className="panzoom-bar textzoom-bar" role="toolbar" aria-label="Text size">
        <button type="button" className="btn-icon" onClick={() => setK((v) => Math.max(0.6, +(v - 0.1).toFixed(2)))} aria-label="Smaller text" title="Smaller text">A−</button>
        <span className="panzoom-pct">{Math.round(k * 100)}%</span>
        <button type="button" className="btn-icon" onClick={() => setK((v) => Math.min(2.5, +(v + 0.1).toFixed(2)))} aria-label="Larger text" title="Larger text">A+</button>
        <button type="button" className="btn-icon panzoom-reset" onClick={() => setK(1)} aria-label="Reset text size">Reset</button>
      </div>
      <div style={{ fontSize: `${k * 100}%` }}>{children}</div>
    </div>
  );
}
