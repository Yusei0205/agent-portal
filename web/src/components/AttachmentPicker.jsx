/**
 * AttachmentPicker — reusable file-attachment widget for AI generation dialogs.
 *
 * Features:
 *  • Click-to-browse and drag-and-drop
 *  • Clipboard paste (images)
 *  • Per-file upload with spinner; immediate upload on selection
 *  • Image thumbnails; type icon + size for non-images
 *  • Remove button per file (fires DELETE for newly uploaded files)
 *  • aria-live region for screen-reader announcements
 *  • Keyboard-operable drop zone (Enter / Space triggers browse)
 *
 * Props:
 *   projectId           {string}   – project for the ai-attachments upload endpoint
 *   initialAttachments  {Array}    – pre-filled attachments (for Refresh dialogs)
 *   onAttachmentsChange {Function} – called as (readyIds: string[], isBusy: boolean)
 *                                    whenever attachment state changes
 *   disabled            {boolean}  – disable all interaction (e.g. while parent is busy)
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './Icon.jsx';

// ── Constants ─────────────────────────────────────────────────────────────────

const ALLOWED_EXTS = [
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.pdf', '.docx', '.xlsx', '.pptx',
  '.md', '.txt', '.csv',
  '.drawio', '.mmd', '.svg',
];

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DOC_EXTS   = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.md', '.txt', '.csv', '.drawio', '.mmd', '.svg']);
const MAX_FILES      = 5;
const IMAGE_MAX_MB   = 10;
const DOC_MAX_MB     = 20;
const IMAGE_MAX_BYTES = IMAGE_MAX_MB * 1024 * 1024;
const DOC_MAX_BYTES   = DOC_MAX_MB   * 1024 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function isImg(name) {
  return IMAGE_EXTS.has(getExt(name));
}

function fmtSize(bytes) {
  if (bytes < 1024)           return `${bytes} B`;
  if (bytes < 1024 * 1024)   return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeLabel(name) {
  const map = {
    '.pdf': 'PDF', '.docx': 'Word', '.xlsx': 'Excel', '.pptx': 'PPT',
    '.md': 'Markdown', '.txt': 'Text', '.csv': 'CSV', '.svg': 'SVG',
    '.drawio': 'Diagram', '.mmd': 'Mermaid',
  };
  const ext = getExt(name);
  return IMAGE_EXTS.has(ext) ? 'Image' : (map[ext] ?? (ext.replace('.', '').toUpperCase() || 'File'));
}

function FileIcon({ filename }) {
  const ext = getExt(filename);
  if (IMAGE_EXTS.has(ext) || ext === '.svg') return <Icon name="eye" size={14} />;
  if (ext === '.drawio' || ext === '.mmd')    return <Icon name="builder" size={14} />;
  return <Icon name="file" size={14} />;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AttachmentPicker({
  projectId,
  initialAttachments = [],
  onAttachmentsChange,
  disabled = false,
  fileInputRef = null,
  hideTrigger = false,
  maxFileBytes = null,
  maxTotalBytes = null,
}) {
  const [items, setItems] = useState(() =>
    initialAttachments.map((att) => ({
      clientId: att.id,
      id:       att.id,
      filename: att.filename,
      size:     att.size ?? 0,
      mimeType: att.mimeType ?? null,
      kind:     att.kind ?? null,
      state:    'done',
      error:    null,
      localUrl: null,
      source:   'existing',
    })),
  );

  const [dragOver, setDragOver] = useState(false);
  const [valError, setValError] = useState(null);

  const localInputRef = useRef(null);
  const inputRef = fileInputRef ?? localInputRef;
  const liveRef     = useRef(null);
  /** Keep a stable reference to processFiles so the paste listener can use it */
  const processRef  = useRef(null);

  // Notify parent whenever items change
  useEffect(() => {
    const readyIds = items.filter((a) => a.state === 'done' && a.id).map((a) => a.id);
    const busy     = items.some((a) => a.state === 'uploading');
    onAttachmentsChange(readyIds, busy);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clipboard paste — images only; never intercept paste in text inputs/textareas
  useEffect(() => {
    if (disabled) return;
    const onPaste = (e) => {
      // Let the browser handle paste events that target text-entry elements normally
      // A message box that opts in (data-paste-files) also takes pasted files, but only when the clipboard holds
      // no text: a screenshot or a copied image. Pasting text, including from Word or a web page that also puts
      // an image on the clipboard, stays an ordinary paste.
      const target = e.target;
      const optedIn = target instanceof HTMLElement && target.dataset.pasteFiles === 'true' && !e.clipboardData?.getData('text/plain');
      if (
        !optedIn && (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable))
      ) {
        return;
      }
      const files = [];
      for (const clipItem of Array.from(e.clipboardData?.items ?? [])) {
        if (clipItem.kind !== 'file') continue;
        let f = clipItem.getAsFile();
        if (!f) continue;
        // Pasted image blobs may lack an extension — supply one from the MIME type
        if (!getExt(f.name) && f.type.startsWith('image/')) {
          const ext = '.' + (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
          f = new File([f], `pasted-image${ext}`, { type: f.type });
        }
        if (isImg(f.name)) files.push(f);
      }
      if (!files.length) return;
      e.preventDefault();
      if (processRef.current) processRef.current(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [disabled]);

  // Announce helper for screen readers
  function announce(msg) {
    if (!liveRef.current) return;
    // Briefly blank and re-set to force re-announcement even for identical text
    liveRef.current.textContent = '';
    setTimeout(() => {
      if (liveRef.current) liveRef.current.textContent = msg;
    }, 10);
  }

  // Validate a list of File objects against limits and allowed extensions
  function validateFiles(fileList) {
    const currentCount = items.filter((a) => a.state !== 'error').length;
    const valid        = [];
    const errors       = [];
    for (const f of fileList) {
      if (currentCount + valid.length >= MAX_FILES) {
        errors.push(`Maximum ${MAX_FILES} files allowed`);
        break;
      }
      const ext = getExt(f.name);
      if (!ALLOWED_EXTS.includes(ext)) {
        errors.push(`${f.name}: file type not allowed`);
        continue;
      }
      const maxBytes = maxFileBytes ?? (IMAGE_EXTS.has(ext) ? IMAGE_MAX_BYTES : DOC_MAX_BYTES);
      const maxMb = maxBytes / 1024 / 1024;
      if (f.size > maxBytes) {
        errors.push(`${f.name}: exceeds ${maxMb} MB limit`);
        continue;
      }
      if (maxTotalBytes && items.filter(a => a.state !== 'error').reduce((n, a) => n + a.size, 0) + valid.reduce((n, a) => n + a.size, 0) + f.size > maxTotalBytes) {
        errors.push('Attachments exceed the total size limit');
        continue;
      }
      valid.push(f);
    }
    return { valid, errors };
  }

  async function uploadOne(file) {
    const clientId = crypto.randomUUID();
    const localUrl = isImg(file.name) ? URL.createObjectURL(file) : null;

    setItems((prev) => [
      ...prev,
      {
        clientId,
        id:       null,
        filename: file.name,
        size:     file.size,
        mimeType: file.type || null,
        kind:     null,
        state:    'uploading',
        error:    null,
        localUrl,
        source:   'new',
      },
    ]);

    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await api.upload(
        `/api/projects/${projectId}/ai-attachments`,
        fd,
      );
      setItems((prev) =>
        prev.map((a) =>
          a.clientId === clientId
            ? { ...a, ...data.attachment, state: 'done' }
            : a,
        ),
      );
      announce(`${file.name} attached`);
    } catch (err) {
      setItems((prev) =>
        prev.map((a) =>
          a.clientId === clientId
            ? { ...a, state: 'error', error: err.message }
            : a,
        ),
      );
      announce(`Failed to upload ${file.name}: ${err.message}`);
    }
  }

  function processFiles(fileList) {
    setValError(null);
    const { valid, errors } = validateFiles(Array.from(fileList));
    if (errors.length) {
      setValError(errors.join(' · '));
      announce(errors.join('. '));
    }
    valid.forEach((f) => uploadOne(f));
  }

  // Keep processRef in sync so the paste listener always calls the latest version
  processRef.current = processFiles;

  function removeItem(clientId) {
    setItems((prev) => {
      const item = prev.find((a) => a.clientId === clientId);
      if (item) {
        if (item.localUrl) URL.revokeObjectURL(item.localUrl);
        // Fire-and-forget server cleanup for newly uploaded (not pre-filled) attachments
        if (item.source === 'new' && item.id) {
          api
            .delete(`/api/projects/${projectId}/ai-attachments/${item.id}`)
            .catch(() => {/* best effort */});
        }
      }
      return prev.filter((a) => a.clientId !== clientId);
    });
  }

  const canAdd = !disabled && items.filter((a) => a.state !== 'error').length < MAX_FILES;

  const dropZoneLabel =
    `Attach files — drag and drop, click to browse, or paste an image. ` +
    `Docs up to ${DOC_MAX_MB} MB · images up to ${IMAGE_MAX_MB} MB · max ${MAX_FILES} files.`;

  return (
    <div className="attachment-picker">
      {/* Screen-reader live region for upload announcements */}
      <div
        ref={liveRef}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />

      {/* Drop zone — only shown when more files can be added */}
      {canAdd && !hideTrigger && (
        <div
          className={`attachment-dropzone${dragOver ? ' is-drag-over' : ''}`}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-label={dropZoneLabel}
          onClick={() => !disabled && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (!disabled) inputRef.current?.click();
            }
          }}
          onDragEnter={(e) => { e.preventDefault(); if (!disabled) setDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
          onDragOver={(e)  => { e.preventDefault(); }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!disabled && e.dataTransfer?.files) processFiles(e.dataTransfer.files);
          }}
        >
          <Icon name="attach" size={16} />
          <span>
            Drag &amp; drop, <span className="attachment-link">click to browse</span>, or paste an image
          </span>
          <span className="attachment-hint">
            Docs up to {DOC_MAX_MB} MB · images up to {IMAGE_MAX_MB} MB · max {MAX_FILES} files
          </span>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        disabled={disabled}
        multiple
        accept={ALLOWED_EXTS.join(',')}
        style={{ display: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          if (e.target.files) processFiles(e.target.files);
          e.target.value = ''; // allow re-selecting the same file
        }}
      />

      {/* Client-side validation errors */}
      {valError && (
        <p className="field-error" role="alert">{valError}</p>
      )}

      {/* Attached files list */}
      {items.length > 0 && (
        <ul className="attachment-list" aria-label="Attached files">
          {items.map((item) => (
            <li
              key={item.clientId}
              className={`attachment-item${item.state === 'error' ? ' is-error' : ''}`}
            >
              {/* Thumbnail (images) or type icon */}
              <div className="attachment-thumb" aria-hidden="true">
                {item.localUrl
                  ? <img src={item.localUrl} alt="" />
                  : <FileIcon filename={item.filename} />
                }
              </div>

              {/* File info */}
              <div className="attachment-info">
                <span className="attachment-name">{item.filename}</span>
                <span className="attachment-meta muted">
                  {typeLabel(item.filename)} · {fmtSize(item.size)}
                </span>
                {item.state === 'error' && (
                  <span className="attachment-error" role="alert">{item.error}</span>
                )}
              </div>

              {/* Upload status indicator */}
              <div className="attachment-status" aria-hidden="true">
                {item.state === 'uploading' && (
                  <span
                    className="spinner"
                    style={{ width: 14, height: 14 }}
                    aria-label={`Uploading ${item.filename}`}
                  />
                )}
                {item.state === 'done' && (
                  <Icon name="check" size={14} className="ok" />
                )}
              </div>

              {/* Remove */}
              <button
                type="button"
                className="btn-icon"
                onClick={() => removeItem(item.clientId)}
                disabled={disabled || item.state === 'uploading'}
                aria-label={`Remove ${item.filename}`}
                style={{ width: 24, height: 24 }}
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
