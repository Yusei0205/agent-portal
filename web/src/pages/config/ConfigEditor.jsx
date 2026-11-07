/**
 * Configuration file editor with lazy-loaded CodeMirror.
 * Handles JSON validation, "save anyway" path, and keyboard save (Ctrl+S).
 */

import { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';

// Lazy-load CodeMirror — keeps it out of the main bundle
const LazyCodeMirror = lazy(() =>
  import('../sessions/codemirror-editor.jsx').then((m) => ({ default: m.CodeMirrorEditor })),
);

function extOf(path) {
  if (!path) return '.txt';
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot) : '';
}

/**
 * @param {{
 *   folder: string,
 *   filePath: string|null,
 *   following: boolean,
 *   onFileSaved: () => void,
 *   onRequestNewFile?: () => void,
 * }} props
 */
export function ConfigEditor({ folder, filePath, following, onFileSaved, onRequestNewFile }) {
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveErrorInvalidJson, setSaveErrorInvalidJson] = useState(false);
  const [saved, setSaved] = useState(false);
  const contentRef = useRef(content);
  contentRef.current = content;

  useEffect(() => {
    if (!filePath) return;
    let ignore = false;
    setLoading(true);
    setError(null);
    setSaveError(null);
    setSaved(false);
    const encodedPath = encodeURIComponent(filePath);
    api.get(`/api/user-config/${folder}/file?path=${encodedPath}`)
      .then(({ content: c }) => {
        if (ignore) return;
        setContent(c ?? '');
        setSavedContent(c ?? '');
        setLoading(false);
      })
      .catch((e) => {
        if (ignore) return;
        setError(e.message);
        setLoading(false);
      });
    return () => { ignore = true; };
  }, [folder, filePath]);

  const handleSave = async (force = false) => {
    if (!filePath || following || loading) return;
    setSaving(true);
    setSaveError(null);
    setSaveErrorInvalidJson(false);
    setSaved(false);
    try {
      await api.put(`/api/user-config/${folder}/file`, {
        path: filePath,
        content: contentRef.current,
        force,
      });
      setSavedContent(contentRef.current);
      setSaved(true);
      onFileSaved?.();
    } catch (e) {
      if (e.data?.invalidJson) {
        setSaveError(e.message);
        setSaveErrorInvalidJson(true);
      } else {
        setSaveError(e.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const isDirty = content !== savedContent;

  if (!filePath) {
    return (
      <div className="config-placeholder">
        <Icon name="file" size={32} aria-hidden="true" />
        <p><strong>No File Open</strong></p>
        <p>
          Pick a file from <code style={{ fontFamily: 'var(--mono)', fontSize: '0.9em' }}>.{folder}</code> on the left, or create one.
          JSON files are checked as you type.
        </p>
        {onRequestNewFile && !following && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRequestNewFile}
            aria-label="Create a new file in this folder"
          >
            <Icon name="file-plus" size={13} />
            New File
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="config-placeholder">
        <div className="spinner" style={{ width: 20, height: 20 }} aria-label="Loading file…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="config-placeholder">
        <p style={{ color: 'var(--danger)' }}>{error}</p>
      </div>
    );
  }

  const ext = extOf(filePath);

  return (
    <>
      <div className="config-editor-header">
        <span className="editor-filename" aria-label={`Editing ${filePath}`}>
          {filePath}
        </span>
        {isDirty && !following && (
          <span
            style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--warn)', flexShrink: 0 }}
            title="Unsaved changes"
            aria-label="Unsaved changes"
          />
        )}
        {following && (
          <span className="badge">Read-only (team default)</span>
        )}
      </div>

      <div className="config-editor-body">
        <Suspense
          fallback={
            <div style={{ padding: 20 }}>
              <div className="spinner" style={{ width: 18, height: 18 }} aria-label="Loading editor…" />
            </div>
          }
        >
          <LazyCodeMirror
            content={content}
            ext={ext}
            onChange={setContent}
            onSave={() => handleSave(false)}
            readOnly={following}
          />
        </Suspense>
      </div>

      <div className="config-editor-footer">
        {!following && (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => handleSave(false)}
              disabled={saving || !isDirty || loading}
              aria-label="Save file (Ctrl+S)"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <span style={{ fontSize: '0.78rem', color: 'var(--ink-3)' }}>
              Ctrl+S to save
            </span>
          </>
        )}
        {saved && !isDirty && (
          <span style={{ color: 'var(--ok)', fontSize: '0.82rem' }} role="status">
            ✓ Saved
          </span>
        )}
        {saveError && (
          <div style={{ flex: 1 }}>
            <span
              className="error-note"
              role="alert"
              style={{ fontSize: '0.82rem', display: 'inline' }}
            >
              {saveError}
            </span>
            {saveErrorInvalidJson && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: 8 }}
                onClick={() => handleSave(true)}
                disabled={saving}
                aria-label="Save the file even though it contains invalid JSON"
              >
                Save anyway
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
