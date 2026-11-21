import { useEffect, useState } from 'react';
import { sanitizeMarkdown } from '../lib/sanitize.js';
import { PanZoom, TextZoom } from './PanZoom.jsx';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';

import { safeUrl } from '../lib/safeUrl.js';
// ── FilePreviewModal ──────────────────────────────────────────────────────────
//
// Props:
//   file       { id, name, mime_type }
//   previewUrl string — GET this to get { type, ... } preview data
//   onClose    () => void

export function FilePreviewModal({ file, previewUrl, onClose }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const overlayDismiss = useOverlayDismiss(onClose);

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Fetch preview data
  useEffect(() => {
    if (!previewUrl) return;
    setLoading(true);
    setError(null);
    fetch(previewUrl, {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'agent-portal' },
    })
      .then((r) => r.json())
      .then((data) => setPreview(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [previewUrl]);

  // Close when clicking backdrop (not content)

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${file?.name ?? ''}`}
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
    >
      <div className="modal modal-preview">
        <div className="modal-header">
          <h2 id="preview-title" className="modal-title">
            {file?.name ?? 'Preview'}
          </h2>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label="Close preview"
          >
            ✕
          </button>
        </div>

        <div className="modal-body preview-body">
          {loading && <p className="muted" style={{ padding: '2rem' }}>Loading preview…</p>}

          {error && (
            <p className="error-msg" role="alert">
              Failed to load preview: {error}
            </p>
          )}

          {!loading && !error && preview && <PreviewContent preview={preview} file={file} />}
        </div>
      </div>
    </div>
  );
}

// ── PreviewContent ────────────────────────────────────────────────────────────

function PreviewContent({ preview, file }) {
  const { type } = preview;

  // PDF — inline iframe
  if (type === 'inline' && preview.mime === 'application/pdf') {
    return (
      <iframe
        src={preview.url}
        title={preview.name || file?.name || 'PDF preview'}
        className="preview-iframe"
        style={{ width: '100%', minHeight: '70vh', border: 'none' }}
        aria-label={`PDF preview of ${preview.name || file?.name || 'file'}`}
      />
    );
  }

  // Image
  if (type === 'inline' && preview.mime?.startsWith('image/')) {
    return (
      <PanZoom label="Image" height="75vh">
        <img
          src={preview.url}
          alt={preview.name || file?.name || 'Image preview'}
          draggable={false}
          style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
        />
      </PanZoom>
    );
  }

  // PPTX slides
  if (type === 'pptx') {
    return (
      <div className="preview-slides">
        {preview.slides?.length === 0 && (
          <p className="muted">No slides found in this presentation.</p>
        )}
        {preview.slides?.map((slide) => (
          <div key={slide.index} className="preview-slide">
            <div className="preview-slide-num">Slide {slide.index}</div>
            {slide.title && <div className="preview-slide-title">{slide.title}</div>}
            {slide.text && (
              <pre className="preview-slide-text" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {slide.text}
              </pre>
            )}
          </div>
        ))}
      </div>
    );
  }

  // Markdown (rendered)
  if (type === 'markdown') {
    return <TextZoom><MarkdownPreview content={preview.content} /></TextZoom>;
  }

  // Plain text
  if (type === 'text') {
    return (
      <TextZoom>
        <pre
          className="preview-text"
          style={{
            whiteSpace: 'pre-wrap',
            fontFamily: 'monospace',
            fontSize: '0.85em',
            padding: '1rem',
            overflowY: 'auto',
            maxHeight: '70vh',
          }}
        >
          {preview.content}
        </pre>
      </TextZoom>
    );
  }

  // No preview available
  return (
    <div className="preview-none" style={{ padding: '2rem', textAlign: 'center' }}>
      <p className="muted">Preview not available — download the file to view it.</p>
    </div>
  );
}

// ── MarkdownPreview ───────────────────────────────────────────────────────────
// Uses the `marked` library already in dependencies.

function MarkdownPreview({ content }) {
  const [html, setHtml] = useState('');

  useEffect(() => {
    if (!content) { setHtml(''); return; }
    // Lazy-load marked
    import('marked').then(({ marked }) => {
      const rendered = typeof marked === 'function' ? marked(content) : marked.parse(content);
      setHtml(sanitizeMarkdown(String(rendered)));
    }).catch(() => {
      // Fallback: plain text
      setHtml(`<pre style="white-space:pre-wrap">${escapeHtml(content)}</pre>`);
    });
  }, [content]);

  return (
    <div
      className="preview-markdown"
      style={{ padding: '1rem', overflowY: 'auto', maxHeight: '70vh' }}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default FilePreviewModal;
