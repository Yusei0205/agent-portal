import { useEffect, useRef, useState } from 'react';
import { PanZoom } from './PanZoom.jsx';

/**
 * Renders a Mermaid diagram from source text.
 *
 * @param {{ mmd: string, className?: string }} props
 */
export function MermaidViewer({ mmd, className }) {
  const containerRef = useRef(null);
  const [error, setError] = useState(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    if (!mmd?.trim()) {
      setError(null);
      setRendered(false);
      return;
    }

    let cancelled = false;

    const render = async () => {
      try {
        // Detect theme from document root
        const isDark = document.documentElement.classList.contains('dark') ||
          window.matchMedia('(prefers-color-scheme: dark)').matches;

        const mermaid = (await import('mermaid')).default;

        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'strict',
        });

        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, mmd.trim());

        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
          setRendered(true);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || String(e));
          setRendered(false);
        }
      }
    };

    render();

    return () => {
      cancelled = true;
    };
  }, [mmd]);

  if (!mmd?.trim()) {
    return <div className={`mermaid-viewer mermaid-empty ${className || ''}`}>No diagram source</div>;
  }

  if (error) {
    return (
      <div className={`mermaid-viewer mermaid-error ${className || ''}`} role="alert">
        <p className="muted"><strong>Diagram error:</strong> {error}</p>
        <pre className="mermaid-source">{mmd}</pre>
      </div>
    );
  }

  return (
    <PanZoom className={`mermaid-viewer ${className || ''}`} label="Architecture diagram">
      <div ref={containerRef} aria-label="Architecture diagram" />
    </PanZoom>
  );
}
