import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';

// ── File extension icon lookup ─────────────────────────────────────────────────

function iconForExt(ext) {
  const code = ['.ts', '.js', '.mjs', '.tsx', '.jsx', '.py', '.go', '.rs', '.rb', '.sh', '.cs'];
  const doc = ['.md', '.txt', '.yaml', '.yml', '.json', '.toml', '.xml', '.html', '.css'];
  const img = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
  if (code.includes(ext)) return 'file';
  if (doc.includes(ext)) return 'file';
  if (img.includes(ext)) return 'eye';
  return 'file';
}

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * File changes tab — P6 placeholder.
 * Shows files written by the run; full diff view deferred to P8.
 *
 * @param {{ runId: string | null | undefined }} props
 */
export function SessionChanges({ runId }) {
  const [files, setFiles] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(`/api/runs/${runId}/files`);
      setFiles(data.files || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    setFiles(null);
    load();
  }, [load]);

  if (!runId) {
    return (
      <div className="ws-placeholder" style={{ flex: 1 }}>
        <Icon name="file" size={32} />
        <p className="muted">No run selected</p>
      </div>
    );
  }

  if (loading && !files) {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center' }}>
        <div className="spinner" style={{ margin: '0 auto' }} aria-label="Loading changed files…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-note" style={{ margin: 16 }} role="alert">
        {error}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={load}
          style={{ marginLeft: 8 }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (files && files.length === 0) {
    return (
      <div className="ws-placeholder" style={{ flex: 1 }}>
        <Icon name="file" size={32} />
        <p>No files changed yet</p>
        <p className="small muted">Files written by the agent will appear here.</p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div
        style={{
          padding: '8px 12px',
          fontSize: '0.78rem',
          color: 'var(--ink-3)',
          borderBottom: '1px solid var(--line-2)',
        }}
      >
        {files?.length ?? 0} file{(files?.length ?? 0) === 1 ? '' : 's'} changed
        {' '}<span className="muted">· Full diff view coming in P8</span>
      </div>
      <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {(files || []).map((f) => {
          const ext = extOf(f);
          const downloadUrl = `/api/runs/${runId}/file/preview?path=${encodeURIComponent(f)}`;
          return (
            <li
              key={f}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px',
                borderBottom: '1px solid var(--line-2)',
                fontSize: '0.84rem',
              }}
            >
              <Icon name={iconForExt(ext)} size={15} style={{ flexShrink: 0, color: 'var(--ink-3)' }} />
              <span
                style={{
                  flex: 1,
                  fontFamily: 'var(--mono)',
                  fontSize: '0.8rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={f}
              >
                {f}
              </span>
              <a
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-icon"
                aria-label={`Download ${f}`}
                title="Download file"
              >
                <Icon name="download" size={14} />
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
