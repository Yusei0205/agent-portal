import { useEffect, useRef, useState } from 'react';

const EMBED = 'https://embed.diagrams.net/?embed=1&ui=min&spin=1&proto=json&noSaveBtn=1&noExitBtn=1&saveAndExit=0&libraries=0';

/**
 * Shows a stored .drawio file with draw.io's own viewer, embedded as a frame.
 * The diagram is handed to the frame with postMessage and is drawn in this browser (the embed mode keeps it there;
 * only the viewer's own files are fetched from embed.diagrams.net). The frame brings its own pan, zoom and fit controls.
 *
 * Download PNG and Download SVG ask the frame to draw the picture (action "export") and save what it sends back, so
 * pictures are made in the browser with no server-side renderer.
 *
 * @param {{ xml: string, name?: string, height?: string }} props
 */
export function DrawioViewer({ xml, name = 'diagram', height = '70vh' }) {
  const frame = useRef(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState('');
  const wanted = useRef('');

  const save = (dataUrl, ext) => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${String(name).replace(/[^a-z0-9._-]+/gi, '_') || 'diagram'}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const exportAs = (fmt) => {
    wanted.current = fmt;
    setBusy(fmt);
    frame.current?.contentWindow?.postMessage(
      JSON.stringify(fmt === 'png'
        ? { action: 'export', format: 'png', scale: 2, border: 10, background: '#ffffff' }
        : { action: 'export', format: 'xmlsvg', border: 10 }),
      'https://embed.diagrams.net',
    );
  };

  useEffect(() => {
    const onMessage = (e) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== 'https://embed.diagrams.net') return;
      let msg;
      try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (msg?.event === 'init') {
        frame.current.contentWindow.postMessage(JSON.stringify({ action: 'load', xml, autosave: 0 }), 'https://embed.diagrams.net');
      } else if (msg?.event === 'load') {
        setReady(true);
      } else if (msg?.event === 'export' && typeof msg.data === 'string') {
        const fmt = wanted.current;
        wanted.current = '';
        setBusy('');
        if (fmt === 'png') save(msg.data.startsWith('data:') ? msg.data : `data:image/png;base64,${msg.data}`, 'png');
        else if (fmt === 'svg') save(msg.data.startsWith('data:') ? msg.data : `data:image/svg+xml;base64,${msg.data}`, 'svg');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [xml, name]);

  return (
    <div className="drawio-viewer" style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 8 }}>
        <button type="button" className="btn-secondary" disabled={!ready || !!busy} onClick={() => exportAs('png')}>{busy === 'png' ? 'Making PNG…' : 'Download PNG'}</button>
        <button type="button" className="btn-secondary" disabled={!ready || !!busy} onClick={() => exportAs('svg')}>{busy === 'svg' ? 'Making SVG…' : 'Download SVG'}</button>
      </div>
      <div style={{ height, position: 'relative' }}>
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
    </div>
  );
}
