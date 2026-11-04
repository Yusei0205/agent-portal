import { useEffect, useRef, useState } from 'react';

const EMBED = 'https://embed.diagrams.net/?embed=1&ui=min&spin=1&proto=json&noSaveBtn=1&noExitBtn=1&saveAndExit=0&libraries=0';

/**
 * Shows a stored .drawio file with draw.io's own viewer, embedded as a frame.
 * The diagram is handed to the frame with postMessage and is drawn in this browser (the embed mode keeps it there;
 * only the viewer's own files are fetched from embed.diagrams.net). The frame brings its own pan, zoom and fit controls.
 *
 * @param {{ xml: string, height?: string }} props
 */
export function DrawioViewer({ xml, height = '70vh' }) {
  const frame = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMessage = (e) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== 'https://embed.diagrams.net') return;
      let msg;
      try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (msg?.event === 'init') {
        frame.current.contentWindow.postMessage(JSON.stringify({ action: 'load', xml, autosave: 0 }), 'https://embed.diagrams.net');
      } else if (msg?.event === 'load') {
        setReady(true);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [xml]);

  return (
    <div className="drawio-viewer" style={{ height, position: 'relative' }}>
      {!ready && <div className="spinner" aria-label="Drawing the diagram…" style={{ position: 'absolute', top: 12, left: 12 }} />}
      <iframe
        ref={frame}
        title="Icon diagram"
        src={EMBED}
        style={{ width: '100%', height: '100%', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}
