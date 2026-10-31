import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Scope tab ─────────────────────────────────────────────────────────────────

function ScopeTab({ projectId, scope, label }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  const { confirmState, requestConfirm } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = scope === 'portal'
        ? '/api/vault'
        : `/api/projects/${projectId}/vault?scope=${scope}`;
      const r = await api.get(url);
      setFiles(r.files || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, scope]);

  useEffect(() => { load(); }, [load]);

  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('scope', scope);
      const uploadUrl = scope === 'portal'
        ? '/api/vault/upload'
        : `/api/projects/${projectId}/vault/upload`;
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'x-requested-with': 'agent-portal' },
        body: fd,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Upload failed (${res.status})`);
      }
      fileRef.current.value = '';
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const downloadFile = (fileId, fileName) => {
    const url = `/api/projects/${projectId}/vault/${fileId}/download`;
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const downloadAll = () => {
    const url = `/api/projects/${projectId}/vault/zip?scope=${scope}`;
    window.open(url, '_blank');
  };

  const deleteFile = async (fileId, fileName) => {
    if (!await requestConfirm(`Delete "${fileName}"?`, 'Delete', 'danger')) return;
    try {
      await api.delete(`/api/projects/${projectId}/vault/${fileId}`);
      setFiles((f) => f.filter((x) => x.id !== fileId));
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <ConfirmDialog state={confirmState} />
      {error && <p className="error-note" role="alert">{error}</p>}

      <div className="actions-row">
        <label className={`btn btn-primary${uploading ? ' disabled' : ''}`}>
          <Icon name="upload" size={14} />
          {uploading ? 'Uploading…' : 'Upload file'}
          <input
            ref={fileRef}
            type="file"
            style={{ display: 'none' }}
            onChange={upload}
            disabled={uploading}
            aria-label={`Upload to ${label} vault`}
          />
        </label>

        {files.length > 0 && (
          <button type="button" className="btn btn-secondary" onClick={downloadAll}>
            <Icon name="download" size={14} />
            Download all as ZIP
          </button>
        )}
      </div>

      {files.length === 0 ? (
        <div className="empty-state">
          <p>No files in the {label.toLowerCase()} vault. Upload a file to get started.</p>
        </div>
      ) : (
        <table className="data-table" aria-label={`${label} vault files`}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Type</th>
              <th>Uploaded by</th>
              <th>Date</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td>{f.name}</td>
                <td>{formatBytes(f.size_bytes)}</td>
                <td><span className="muted">{f.mime_type || '—'}</span></td>
                <td><span className="muted">{f.uploaded_by || '—'}</span></td>
                <td className="muted">{formatRelative(f.created_at)}</td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() => downloadFile(f.id, f.name)}
                      aria-label={`Download ${f.name}`}
                      title="Download"
                    >
                      <Icon name="download" size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() => deleteFile(f.id, f.name)}
                      aria-label={`Delete ${f.name}`}
                      title="Delete"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const SCOPES = [
  { id: 'project',  label: 'Project'     },
  { id: 'personal', label: 'Personal'    },
  { id: 'portal',   label: 'Portal-wide' },
];

export function Vault({ projectId, user }) {
  const [tab, setTab] = useState('project');

  return (
    <div className="page">
      <h1>Vault</h1>
      <p className="muted">
        Files uploaded here are available to every agent run in this project.
      </p>

      <div className="tab-bar" role="tablist" aria-label="Vault scopes">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={tab === s.id}
            className={`tab-btn${tab === s.id ? ' is-active' : ''}`}
            onClick={() => setTab(s.id)}
            type="button"
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {SCOPES.map((s) => tab === s.id && (
          <ScopeTab
            key={s.id}
            projectId={projectId}
            scope={s.id}
            label={s.label}
          />
        ))}
      </div>
    </div>
  );
}

export default Vault;
