/**
 * OutputFilePreview — modal dialog to preview a session output file.
 *
 * Fetches the preview URL from the API and renders:
 *   - Inline image (click to zoom to actual size with scroll)
 *   - PDF via iframe (inline URL)
 *   - Plain text / markdown
 *   - PPTX slides (text rendering)
 *   - Fallback "no preview" state
 *
 * When `files` is provided (array with 2+ entries), shows previous/next
 * navigation and honours arrow-key presses to move between files.
 *
 * Header shows name, version (if > 1), and file size.
 * Download and "Open in Vault" actions are in the header.
 * Focus is trapped inside while open; Escape closes it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { sanitizeMarkdown } from '../../lib/sanitize.js';
import { navigate } from '../../lib/router.js';
import { formatBytes } from '../../lib/outputFileUtils.js';

// ── Markdown renderer (lazy-loads marked) ─────────────────────────────────────

let _markedLib = null;
let _markedPromise = null;

function loadMarked() {
  if (_markedLib) return Promise.resolve(_markedLib);
  if (_markedPromise) return _markedPromise;
  _markedPromise = import('marked')
    .then(({ marked }) => { _markedLib = marked; return marked; })
    .catch(() => null);
  return _markedPromise;
}

function renderMd(text) {
  if (!_markedLib || !text) return null;
  const raw = typeof _markedLib === 'function'
    ? _markedLib(text, { gfm: true, breaks: true })
    : _markedLib.parse(text, { gfm: true, breaks: true });
  return sanitizeMarkdown(String(raw));
}

// ── Preview content switcher ──────────────────────────────────────────────────

function PreviewBody({ preview }) {
  const { type } = preview;

  if (type === 'inline') {
    if (preview.mime?.startsWith('image/')) {
      return <ZoomableImage src={preview.url} alt={preview.name || 'image preview'} />;
    }
    if (preview.mime === 'application/pdf') {
      return (
        <iframe
          src={preview.url}
          title={preview.name || 'PDF preview'}
          className="file-preview-pdf"
          aria-label={`PDF preview of ${preview.name || 'file'}`}
        />
      );
    }
  }

  if (type === 'text') {
    return <pre className="file-preview-text">{preview.content}</pre>;
  }

  if (type === 'markdown') {
    return <MdPreview content={preview.content} />;
  }

  if (type === 'pptx') {
    return <PptxPreview slides={preview.slides ?? []} />;
  }

  return (
    <div
      className="file-preview-image"
      style={{ color: 'var(--ink-3)', fontSize: '0.85rem', flexDirection: 'column', gap: 8 }}
    >
      <Icon name="file" size={32} />
      <p>Preview not available — download the file to view it.</p>
    </div>
  );
}

// ── Zoomable image ────────────────────────────────────────────────────────────

function ZoomableImage({ src, alt }) {
  const [zoomed, setZoomed] = useState(false);
  const toggle = () => setZoomed((z) => !z);

  return (
    <button
      type="button"
      className={`file-preview-image-zoom-wrap${zoomed ? ' is-zoomed' : ''}`}
      onClick={toggle}
      aria-label={zoomed ? 'Click to fit image in view' : 'Click to zoom to actual size'}
      title={zoomed ? 'Fit in view' : 'Zoom to actual size'}
    >
      <img src={src} alt={alt} />
    </button>
  );
}

// ── Markdown preview ──────────────────────────────────────────────────────────

function MdPreview({ content }) {
  const [html, setHtml] = useState(() => renderMd(content));

  useEffect(() => {
    if (!content) { setHtml(''); return; }
    const rendered = renderMd(content);
    if (rendered !== null) { setHtml(rendered); return; }
    let cancelled = false;
    loadMarked().then(() => {
      if (!cancelled) setHtml(renderMd(content) ?? '');
    });
    return () => { cancelled = true; };
  }, [content]);

  return (
    <div
      className="file-preview-text live-markdown-body"
      style={{ background: 'var(--panel)', fontFamily: 'inherit' }}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html ?? '' }}
    />
  );
}

// ── PPTX slide carousel ───────────────────────────────────────────────────────

function PptxPreview({ slides }) {
  const [current, setCurrent] = useState(0);
  const total = slides.length;
  if (!total) return <p className="muted" style={{ padding: 16 }}>No slides.</p>;
  const slide = slides[current];
  return (
    <div className="file-preview-carousel">
      <div className="file-preview-slides">
        <div className="file-preview-slide">
          {slide.title && <div style={{ fontWeight: 660, marginBottom: 8 }}>{slide.title}</div>}
          {slide.text && <pre className="file-preview-text" style={{ flex: 1 }}>{slide.text}</pre>}
        </div>
      </div>
      <div className="file-preview-slide-nav">
        <button
          type="button"
          className="btn-icon"
          onClick={() => setCurrent((c) => Math.max(0, c - 1))}
          disabled={current === 0}
          aria-label="Previous slide"
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="file-preview-slide-count">{current + 1} / {total}</span>
        <button
          type="button"
          className="btn-icon"
          onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}
          disabled={current === total - 1}
          aria-label="Next slide"
        >
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   file:        {id: string, name: string, path: string, size_bytes: number,
 *                 version: number, download_url: string, preview_url: string,
 *                 vault_file_id: string | null},
 *   files?:      Array<object> | null,  // full list for prev/next navigation
 *   projectId:   string,
 *   vaultFolder: string | null,
 *   onClose:     () => void,
 * }} props
 */
export function OutputFilePreview({ file: initialFile, files = null, projectId, vaultFolder, onClose }) {
  // ── Navigation state ──────────────────────────────────────────────────────
  const navFiles = Array.isArray(files) && files.length > 1 ? files : null;
  const [currentIndex, setCurrentIndex] = useState(() => {
    if (!navFiles) return 0;
    const idx = navFiles.findIndex((f) => f.id === initialFile.id);
    return idx >= 0 ? idx : 0;
  });

  const currentFile = navFiles ? (navFiles[currentIndex] ?? initialFile) : initialFile;

  const goToPrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, []);

  const goToNext = useCallback(() => {
    if (!navFiles) return;
    setCurrentIndex((i) => Math.min(navFiles.length - 1, i + 1));
  }, [navFiles]);

  // ── Preview fetching ──────────────────────────────────────────────────────
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const dialogRef = useFocusTrap();

  useEffect(() => {
    if (!currentFile?.preview_url) { setLoading(false); setPreview(null); return; }
    setLoading(true);
    setError(null);
    setPreview(null);
    let cancelled = false;
    fetch(currentFile.preview_url, {
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'agent-portal' },
    })
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setPreview(data); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentFile?.id]); // re-fetch when navigating to a different file

  // ── Keyboard: Escape, ArrowLeft/Right ────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (!navFiles) return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); goToPrev(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goToNext(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, navFiles, goToPrev, goToNext]);

  // ── Download / vault actions ──────────────────────────────────────────────
  const download = useCallback(() => {
    const a = document.createElement('a');
    a.href = currentFile.download_url;
    a.download = currentFile.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [currentFile]);

  const openInVault = useCallback(() => {
    const folder = vaultFolder || null;
    const qs = folder ? `?folder=${encodeURIComponent(folder)}` : '';
    navigate(`/p/${encodeURIComponent(projectId)}/vault${qs}`);
    onClose();
  }, [projectId, vaultFolder, onClose]);

  // ── Backdrop click ────────────────────────────────────────────────────────
  const backdropRef = useRef(null);
  const handleBackdrop = (e) => {
    if (e.target === backdropRef.current) onClose();
  };

  return (
    <div
      ref={backdropRef}
      className="file-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ofp-title"
      onClick={handleBackdrop}
    >
      <div ref={dialogRef} className="file-preview-modal">
        {/* Header */}
        <div className="file-preview-header">
          {/* Navigation arrows */}
          {navFiles && (
            <div className="file-preview-nav" aria-label="File navigation">
              <button
                type="button"
                className="btn-icon"
                onClick={goToPrev}
                disabled={currentIndex === 0}
                aria-label="Previous file (←)"
                title="Previous file (←)"
              >
                <Icon name="chevronLeft" size={14} />
              </button>
              <span className="file-preview-nav-count" aria-label={`File ${currentIndex + 1} of ${navFiles.length}`}>
                {currentIndex + 1}/{navFiles.length}
              </span>
              <button
                type="button"
                className="btn-icon"
                onClick={goToNext}
                disabled={currentIndex === navFiles.length - 1}
                aria-label="Next file (→)"
                title="Next file (→)"
              >
                <Icon name="chevronRight" size={14} />
              </button>
            </div>
          )}

          {/* File name (title) */}
          <span id="ofp-title" className="file-preview-title" title={currentFile.path}>
            {currentFile.name}
          </span>

          {/* Version badge */}
          {currentFile.version > 1 && (
            <span className="ide-outputs-version" aria-label={`Version ${currentFile.version}`}>
              v{currentFile.version}
            </span>
          )}

          {/* File size */}
          {currentFile.size_bytes != null && (
            <span className="file-preview-meta" aria-label={`File size: ${formatBytes(currentFile.size_bytes)}`}>
              {formatBytes(currentFile.size_bytes)}
            </span>
          )}

          {/* Download */}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={download}
            aria-label={`Download ${currentFile.name}`}
            title="Download"
          >
            <Icon name="download" size={13} />
            Download
          </button>

          {/* Open in Vault */}
          {currentFile.vault_file_id && projectId && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={openInVault}
              aria-label={`Open ${currentFile.name} in Vault`}
              title="Open in Vault"
            >
              <Icon name="archive" size={13} />
              Open in Vault
            </button>
          )}

          {/* Close */}
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label="Close preview"
            title="Close (Esc)"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="file-preview-body">
          {loading && (
            <div style={{ padding: 32, display: 'grid', placeItems: 'center' }}>
              <div className="spinner" aria-label="Loading preview…" />
            </div>
          )}
          {error && (
            <p className="error-note" role="alert" style={{ margin: 16 }}>
              Preview failed: {error}
            </p>
          )}
          {!loading && !error && preview && <PreviewBody preview={preview} />}
        </div>
      </div>
    </div>
  );
}
