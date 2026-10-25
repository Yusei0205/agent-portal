import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Button, Modal } from './ui.jsx';

const MIN = 0.2;
const MAX = 6;

/**
 * A drawn Mermaid diagram at full size, in a dialog: zoom with the buttons, the mouse wheel (with Ctrl) or the keys + and -,
 * pan by dragging or with the scroll bars. `svg` is markup already sanitised by the Markdown component.
 */
export function MermaidViewer({ svg, title = 'Diagram', onClose }) {
  const host = useRef(null);
  const pane = useRef(null);
  const drag = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState(null);

  // Put the drawing in, and remember the size it was drawn at; zoom 1 fits the dialog's width.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'] });
    const s = el.querySelector('svg');
    if (!s) return;
    const vb = s.viewBox?.baseVal;
    const w = vb && vb.width ? vb.width : s.getBoundingClientRect().width || 800;
    const h = vb && vb.height ? vb.height : s.getBoundingClientRect().height || 600;
    s.removeAttribute('height');
    s.style.maxWidth = 'none';
    s.style.height = 'auto';
    setNatural({ w, h });
    const fit = pane.current ? Math.min(1, (pane.current.clientWidth - 24) / w) : 1;
    setZoom(Math.max(MIN, Math.min(MAX, fit)));
  }, [svg]);

  useEffect(() => {
    const s = host.current?.querySelector('svg');
    if (s && natural) s.style.width = `${Math.round(natural.w * zoom)}px`;
  }, [zoom, natural]);

  const set = (z) => setZoom(Math.max(MIN, Math.min(MAX, z)));
  // A native listener: React's wheel handlers are passive and could not stop the page from zooming.
  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => Math.max(MIN, Math.min(MAX, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const onKey = (e) => {
    if (e.key === '+' || e.key === '=') set(zoom * 1.2);
    else if (e.key === '-') set(zoom / 1.2);
    else if (e.key === '0') set(1);
  };
  const down = (e) => {
    if (e.button !== 0 || !pane.current) return;
    drag.current = { x: e.clientX, y: e.clientY, left: pane.current.scrollLeft, top: pane.current.scrollTop };
    pane.current.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!drag.current || !pane.current) return;
    pane.current.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    pane.current.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const up = () => {
    drag.current = null;
  };

  return (
    <Modal
      wide
      title={title}
      onClose={onClose}
      footer={
        <>
          <span className="muted small mermaid-viewer-hint">Drag to move. Ctrl + wheel, or the buttons, to zoom.</span>
          <Button size="sm" onClick={() => set(zoom / 1.25)} aria-label="Zoom out">
            -
          </Button>
          <span className="small mermaid-viewer-zoom" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <Button size="sm" onClick={() => set(zoom * 1.25)} aria-label="Zoom in">
            +
          </Button>
          <Button size="sm" onClick={() => set(1)}>
            100%
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div
        ref={pane}
        className="mermaid-viewer"
        tabIndex={0}
        role="group"
        aria-label="Diagram, full size"
        onKeyDown={onKey}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <div ref={host} className="mermaid-viewer-svg" />
      </div>
    </Modal>
  );
}
