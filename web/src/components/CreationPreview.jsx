import { useEffect, useState } from 'react';
import { marked } from 'marked';
import { sanitizeMarkdown } from '../lib/sanitize.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';
import { ViewDiagramModal } from '../pages/Diagrams.jsx';
import { SlidePreviewModal } from '../pages/Presentations.jsx';

function DocumentPreview({ projectId, item, onClose }) {
  const ref = useFocusTrap();
  const dismiss = useOverlayDismiss(onClose);
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    const url = `/api/projects/${encodeURIComponent(projectId)}/generated-docs/${encodeURIComponent(item.id)}/download?format=md`;
    fetch(url, { credentials: 'same-origin', signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('The document preview is unavailable. Open its run for more details.');
      const text = await response.text();
      if (!controller.signal.aborted) setContent(sanitizeMarkdown(marked.parse(text)));
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [projectId, item.id]);
  useEffect(() => {
    const escape = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [onClose]);
  return <div className="dialog-overlay" onMouseDown={dismiss.onMouseDown} onClick={dismiss.onClick}>
    <section ref={ref} role="dialog" aria-modal="true" aria-labelledby="creation-preview-title" className="creation-preview">
      <header className="dashboard-details-head"><h2 id="creation-preview-title">{item.name}</h2><button type="button" className="btn btn-sm" onClick={onClose}>Close preview</button></header>
      <div className="creation-preview-body">{error ? <p role="alert">{error}</p> : content === null ? <p role="status">Loading preview…</p> : <div className="markdown-body" dangerouslySetInnerHTML={{ __html: content }} />}</div>
    </section>
  </div>;
}

export function CreationPreview({ projectId, kind, item, onClose }) {
  if (kind === 'diagram') return <ViewDiagramModal diagram={{ ...item, project_id: projectId }} onClose={onClose} />;
  if (kind === 'deck') return <SlidePreviewModal name={item.name} slides={Array.isArray(item.preview_json) ? item.preview_json : []} onClose={onClose} />;
  return <DocumentPreview projectId={projectId} item={item} onClose={onClose} />;
}
