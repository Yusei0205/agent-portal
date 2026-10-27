import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { BulkActionBar, BulkSelectHint } from '../components/BulkActionBar.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function DocTypeBadge({ type }) {
  const labels = {
    overview: 'Overview',
    architecture: 'Architecture',
    api: 'API',
    runbook: 'Runbook',
    'user-guide': 'User guide',
  };
  return <span className="badge badge-muted">{labels[type] ?? type}</span>;
}

function StatusBadge({ stale, hasVersion }) {
  if (stale) return <span className="badge badge-warn">Stale</span>;
  if (hasVersion) return <span className="badge badge-ok">Ready</span>;
  return <span className="badge badge-info">Generating…</span>;
}

// ── New document modal ────────────────────────────────────────────────────────

const DOC_TYPES = [
  { id: 'overview', label: 'System overview' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'api', label: 'API reference' },
  { id: 'runbook', label: 'Runbook' },
  { id: 'user-guide', label: 'User guide' },
];

function NewDocModal({ projectId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [docType, setDocType] = useState('overview');
  const [audience, setAudience] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/generated-docs`, {
        name: name.trim(),
        docType,
        audience: audience.trim() || undefined,
        sources: {},
      });
      onCreated(r);
    } catch (err) {
      setError(err.message || 'Failed to create document');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-doc-title">
      <div className="modal">
        <div className="modal-header">
          <h2 id="new-doc-title">New document</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="nd-name">Name <span aria-hidden>*</span></label>
            <input
              id="nd-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Payments API reference"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="nd-type">Document type <span aria-hidden>*</span></label>
            <select id="nd-type" value={docType} onChange={(e) => setDocType(e.target.value)} required>
              {DOC_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="nd-audience">Audience (optional)</label>
            <input
              id="nd-audience"
              type="text"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              maxLength={200}
              placeholder="e.g. Senior engineers, new team members"
            />
          </div>

          {error && <p className="error-msg" role="alert">{error}</p>}

          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── GeneratedDocs page ────────────────────────────────────────────────────────

/**
 * Generated Documents page — list, create, download and manage generated Word documents.
 *
 * @param {{ projectId: string }} props
 */
export function GeneratedDocs({ projectId }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/api/projects/${projectId}/generated-docs`);
      setDocs(r.docs ?? []);
    } catch (err) {
      setError(err.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleCreated = (r) => {
    setShowNew(false);
    load();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this document and all its versions?')) return;
    try {
      await api.delete(`/api/projects/${projectId}/generated-docs/${id}`);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      setSelected((prev) => { const s = new Set(prev); s.delete(id); return s; });
    } catch (err) {
      alert(err.message || 'Failed to delete');
    }
  };

  const handleRefresh = async (id) => {
    try {
      await api.post(`/api/projects/${projectId}/generated-docs/${id}/refresh`, {});
      load();
    } catch (err) {
      alert(err.message || 'Failed to refresh');
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} document(s)?`)) return;
    setBulkBusy(true);
    try {
      for (const id of selected) {
        await api.delete(`/api/projects/${projectId}/generated-docs/${id}`);
      }
      setSelected(new Set());
      load();
    } catch (err) {
      alert(err.message || 'Failed to delete');
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  };

  const toggleAll = () => {
    if (selected.size === docs.length) setSelected(new Set());
    else setSelected(new Set(docs.map((d) => d.id)));
  };

  if (loading) return <div className="page"><p className="muted">Loading documents…</p></div>;
  if (error) return <div className="page"><p className="error-msg">{error}</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Documents</h2>
          <p className="muted">AI-generated Word documents from your repositories and knowledge.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowNew(true)}
        >
          + New document
        </button>
      </div>

      {docs.length === 0 ? (
        <div className="empty-state">
          <p>No documents yet. Create one to get started.</p>
        </div>
      ) : (
        <>
          <BulkSelectHint selected={selected.size} total={docs.length} />

          <table className="data-table" aria-label="Generated documents">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={selected.size === docs.length && docs.length > 0}
                    onChange={toggleAll}
                    aria-label="Select all"
                  />
                </th>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Last updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(d.id)}
                      onChange={() => toggleSelect(d.id)}
                      aria-label={`Select ${d.name}`}
                    />
                  </td>
                  <td className="table-primary">{d.name}</td>
                  <td><DocTypeBadge type={d.doc_type} /></td>
                  <td>
                    <StatusBadge stale={d.stale} hasVersion={Boolean(d.latest_version_id)} />
                  </td>
                  <td className="table-muted">{formatDate(d.created_at)}</td>
                  <td>
                    <div className="action-row">
                      {d.latest_version_id && (
                        <>
                          <a
                            href={`/api/projects/${projectId}/generated-docs/${d.id}/download?format=md`}
                            className="btn btn-sm btn-ghost"
                            download
                          >
                            Download MD
                          </a>
                          <a
                            href={`/api/projects/${projectId}/generated-docs/${d.id}/download?format=docx`}
                            className="btn btn-sm btn-ghost"
                            download
                          >
                            Download Word
                          </a>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => handleRefresh(d.id)}
                        title="Refresh document"
                      >
                        Refresh
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDelete(d.id)}
                        title="Delete document"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {selected.size > 0 && (
            <BulkActionBar
              count={selected.size}
              busy={bulkBusy}
              onDelete={handleBulkDelete}
              onClear={() => setSelected(new Set())}
            />
          )}
        </>
      )}

      {showNew && (
        <NewDocModal
          projectId={projectId}
          onClose={() => setShowNew(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
