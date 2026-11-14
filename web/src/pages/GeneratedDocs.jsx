import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { AttachmentPicker } from '../components/AttachmentPicker.jsx';
import { AiChoicePicker } from '../components/AiChoicePicker.jsx';
import { CreateContextPicker } from '../components/CreateContextPicker.jsx';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { BulkActionBar } from '../components/BulkActionBar.jsx';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { useSort } from '../lib/useSort.jsx';
import { PageHeader, SectionHead } from '../components/PageHeader.jsx';

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

function StatusBadge({ stale, hasVersion, status }) {
  if (stale) return <span className="badge badge-warn">Stale</span>;
  if (status === 'failed') return <span className="badge badge-error">Failed</span>;
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
  const [ai, setAi] = useState({});
  const [ctx, setCtx] = useState({ repoIds: [], docIds: [] });
  const [name, setName] = useState('');
  const [docType, setDocType] = useState('overview');
  const [audience, setAudience] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [attachmentIds, setAttachmentIds] = useState([]);
  const [uploadsBusy, setUploadsBusy]     = useState(false);

  const handleAttachments = (ids, uploading) => {
    setAttachmentIds(ids);
    setUploadsBusy(uploading);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (uploadsBusy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/generated-docs`, {
        name:          name.trim(),
        docType,
        audience:      audience.trim() || undefined,
        description:   description.trim() || undefined,
        ...ai,
        sources:       ctx,
        attachmentIds: attachmentIds.length ? attachmentIds : undefined,
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
            <label htmlFor="nd-desc">Description (optional)</label>
            <textarea
              id="nd-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="Add context for the agent: what the document is for, what to focus on or leave out, anything it should know."
            />
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

          <CreateContextPicker projectId={projectId} onChange={setCtx} disabled={busy} attachmentCount={attachmentIds.length} />

          <AiChoicePicker onChange={setAi} disabled={busy} idPrefix="ai0" />
          <p className="field-hint">The agent runs on this sign-in and model, and writes the file.</p>

          <AttachmentPicker
            projectId={projectId}
            onAttachmentsChange={handleAttachments}
            disabled={busy}
          />

          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy || uploadsBusy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || uploadsBusy || !name.trim()}>
              {busy ? 'Creating…' : uploadsBusy ? 'Uploading…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Refresh document dialog ───────────────────────────────────────────────────

function RefreshDocDialog({ projectId, doc, onClose, onRefreshed }) {
  const [ai, setAi] = useState({});
  const [busy, setBusy]                   = useState(false);
  const [error, setError]                 = useState(null);
  const [attachmentIds, setAttachmentIds] = useState([]);
  const [uploadsBusy, setUploadsBusy]     = useState(false);
  const trapRef = useFocusTrap();

  const handleAttachments = (ids, uploading) => {
    setAttachmentIds(ids);
    setUploadsBusy(uploading);
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy && !uploadsBusy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy, uploadsBusy]);

  const submit = async () => {
    if (busy || uploadsBusy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/api/projects/${projectId}/generated-docs/${doc.id}/refresh`,
        { ...ai, attachmentIds: attachmentIds.length ? attachmentIds : undefined },
      );
      onRefreshed();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to refresh');
      setBusy(false);
    }
  };

  const overlayDismiss = useOverlayDismiss(onClose, { disabled: busy || uploadsBusy });

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="refresh-doc-title"
        style={{ maxWidth: 520 }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="refresh-doc-title">Refresh document</h2>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            disabled={busy || uploadsBusy}
            aria-label="Close"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="dialog-body stack">
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Regenerate <strong>{doc.name}</strong>. Attach additional files to supplement
            or replace the existing source material.
          </p>
          <AiChoicePicker onChange={setAi} disabled={busy} idPrefix="ai1" />
          <p className="field-hint">The agent runs on this sign-in and model, and writes the file.</p>

          <div className="field">
            <label>Attachments <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
            <AttachmentPicker
              projectId={projectId}
              initialAttachments={doc.attachments ?? []}
              onAttachmentsChange={handleAttachments}
              disabled={busy}
            />
          </div>
          {error && <div className="error-note" role="alert">{error}</div>}
        </div>
        <div className="dialog-foot">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={busy || uploadsBusy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || uploadsBusy}
          >
            {busy
              ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Refreshing…</>
              : uploadsBusy
                ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Uploading…</>
                : <><Icon name="refresh" size={14} /> Refresh</>}
          </button>
        </div>
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
  const { sorted: sortedDocs, sortProps } = useSort(docs, { name: (d) => d.name, type: (d) => d.doc_type, status: (d) => d.status, updated: (d) => d.updated_at ?? d.created_at });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [refreshingDoc, setRefreshingDoc] = useState(null);
  const [retryingIds, setRetryingIds] = useState(new Set());
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

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
    const ok = await requestConfirm('Delete this document and all its versions?', 'Delete', 'danger');
    if (!ok) return;
    try {
      await api.delete(`/api/projects/${projectId}/generated-docs/${id}`);
      setDocs((prev) => prev.filter((d) => d.id !== id));
      setSelected((prev) => { const s = new Set(prev); s.delete(id); return s; });
    } catch (err) {
      toast(err.message || 'Failed to delete', 'error');
    }
  };

  const handleRefresh = (doc) => {
    setRefreshingDoc(doc);
  };

  const handleRetryDoc = async (id) => {
    setRetryingIds((prev) => { const s = new Set(prev); s.add(id); return s; });
    try {
      const r = await api.post(`/api/projects/${projectId}/generated-docs/${id}/retry`, {});
      setDocs((prev) => prev.map((d) => d.id === id ? { ...d, ...(r.doc ?? {}) } : d));
    } catch (err) {
      toast(err.message || 'Failed to retry', 'error');
    } finally {
      setRetryingIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
  };

  const handleBulkDelete = async () => {
    const ok = await requestConfirm(`Delete ${selected.size} document(s)?`, 'Delete', 'danger');
    if (!ok) return;
    setBulkBusy(true);
    try {
      const toDelete = new Set(selected); // capture before state changes
      await Promise.all([...toDelete].map((id) =>
        api.delete(`/api/projects/${projectId}/generated-docs/${id}`)
      ));
      // Remove deleted items from state immediately — no reload delay.
      setDocs((prev) => prev.filter((d) => !toDelete.has(d.id)));
      setSelected(new Set());
    } catch (err) {
      toast(err.message || 'Failed to delete', 'error');
      load(); // re-sync with server on partial failure
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
      <SectionHead description="AI-generated Word documents from your repositories and knowledge.">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowNew(true)}
        >
          <Icon name="plus" size={14} />
          New document
        </button>
      </SectionHead>

      {docs.length === 0 ? (
        <div className="empty-state">
          <p>No documents yet. Create one to get started.</p>
        </div>
      ) : (
        <>

          <table className="data-table" aria-label="Generated documents" data-has-sel={selected.size > 0 ? '' : undefined}>
            <thead>
              <tr>
                <th className="sel-col">
                  <input
                    type="checkbox"
                    checked={selected.size === docs.length && docs.length > 0}
                    onChange={toggleAll}
                    aria-label="Select all"
                  />
                </th>
                <th {...sortProps('name')}>Name</th>
                <th {...sortProps('type')}>Type</th>
                <th {...sortProps('status')}>Status</th>
                <th {...sortProps('updated')}>Last updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedDocs.map((d) => (
                <tr key={d.id} className={selected.has(d.id) ? 'is-selected' : ''}>
                  <td className="sel-col">
                    <input
                      type="checkbox"
                      checked={selected.has(d.id)}
                      onChange={() => toggleSelect(d.id)}
                      aria-label={`Select ${d.name}`}
                    />
                  </td>
                  <td className="table-primary">
                    {d.name}
                    {d.attachments?.length > 0 && (
                      <span
                        className="badge badge-muted"
                        style={{ marginLeft: 6 }}
                        title={`${d.attachments.length} attachment${d.attachments.length !== 1 ? 's' : ''}`}
                      >
                        <Icon name="attach" size={10} />
                        {' '}{d.attachments.length}
                      </span>
                    )}
                    {d.status === 'failed' && d.error && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--danger)', marginTop: 2 }}>
                        {d.error}
                        {/Workspaces → AWS/.test(d.error) && <> <a href={`#/p/${projectId}/workspaces/aws`}>Update AWS keys</a></>}
                        {/Workspaces → Repositories/.test(d.error) && <> <a href={`#/p/${projectId}/workspaces/repositories`}>Update repository sign-in</a></>}
                      </div>
                    )}
                  </td>
                  <td><DocTypeBadge type={d.doc_type} /></td>
                  <td>
                    <StatusBadge stale={d.stale} hasVersion={Boolean(d.latest_version_id)} status={d.status} />
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
                      {d.status === 'failed' && d.retryable && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => handleRetryDoc(d.id)}
                          disabled={retryingIds.has(d.id)}
                          aria-label={`Retry ${d.name}`}
                        >
                          {retryingIds.has(d.id) ? 'Retrying\u2026' : 'Retry'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => handleRefresh(d)}
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
              selected={selected}
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

      {refreshingDoc && (
        <RefreshDocDialog
          projectId={projectId}
          doc={refreshingDoc}
          onClose={() => setRefreshingDoc(null)}
          onRefreshed={() => { setRefreshingDoc(null); load(); }}
        />
      )}

      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
