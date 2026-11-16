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
import { GuideAccountsModal } from '../components/GuideAccounts.jsx';
import { GuideShotBoard } from '../components/GuideShotBoard.jsx';
import { IdeBrowser } from './sessions/IdeBrowser.jsx';

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
  // User guide made from the running system, with numbered screenshots.
  const [shots, setShots]         = useState(false);
  const [guideUrl, setGuideUrl]   = useState('');
  const [guideHosts, setGuideHosts] = useState('');
  const [accounts, setAccounts]   = useState([]);
  const [roles, setRoles]         = useState([]);
  const [manualSignIn, setManualSignIn] = useState(false);
  const [perRole, setPerRole] = useState(false);
  const [manage, setManage]       = useState(false);

  const handleAttachments = (ids, uploading) => {
    setAttachmentIds(ids);
    setUploadsBusy(uploading);
  };

  const isGuide = docType === 'user-guide';
  useEffect(() => {
    if (!isGuide || !shots) return undefined;
    let live = true;
    api.get(`/api/projects/${projectId}/guide-accounts`).then((r) => { if (live) setAccounts(r.accounts || []); }).catch(() => {});
    return () => { live = false; };
  }, [isGuide, shots, projectId]);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (isGuide && shots && !guideUrl.trim()) { setError('Give the address of the system to capture'); return; }
    if (uploadsBusy) return;
    setBusy(true);
    setError(null);
    try {
      // A large guide: one document per role, each its own session (and its own 40 screenshots), grouped by a shared tag.
      if (isGuide && shots && perRole && roles.length >= 2) {
        const setTag = { id: `set_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`, name: name.trim() };
        let last = null;
        for (const role of roles) {
          last = await api.post(`/api/projects/${projectId}/generated-docs`, {
            name:          `${name.trim()} — ${role}`.slice(0, 120),
            docType,
            audience:      audience.trim() || undefined,
            description:   [description.trim(), `This part of the guide covers only what the "${role}" role does: sign in as that role and document its tasks.`].filter(Boolean).join('\n\n'),
            ...ai,
            sources:       ctx,
            guideSet:      setTag,
            guide:         { screenshots: true, url: guideUrl.trim(), roles: [role], hosts: guideHosts.split(/[\s,]+/).filter(Boolean), manualSignIn: false },
          });
        }
        onCreated(last);
        return;
      }
      const r = await api.post(`/api/projects/${projectId}/generated-docs`, {
        name:          name.trim(),
        docType,
        audience:      audience.trim() || undefined,
        description:   description.trim() || undefined,
        ...ai,
        sources:       ctx,
        attachmentIds: attachmentIds.length ? attachmentIds : undefined,
        guide: isGuide && shots
          ? { screenshots: true, url: guideUrl.trim(), roles, hosts: guideHosts.split(/[\s,]+/).filter(Boolean), manualSignIn }
          : undefined,
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

          {isGuide && (
            <fieldset className="field" style={{ border: '1px solid var(--line, #ddd)', borderRadius: 8, padding: 12 }}>
              <legend>Screenshots from the running system</legend>
              <label className="checkbox-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={shots} onChange={(e) => setShots(e.target.checked)} disabled={busy} />
                Open the system in the cloud browser and capture screenshots, with numbered boxes on what to click
              </label>
              {shots && (
                <div className="stack" style={{ marginTop: 10 }}>
                  <div className="field">
                    <label htmlFor="nd-guide-url">Address of the system <span aria-hidden>*</span></label>
                    <input id="nd-guide-url" type="url" value={guideUrl} onChange={(e) => setGuideUrl(e.target.value)} maxLength={500} placeholder="https://app.example.com" disabled={busy} />
                    <p className="field-hint">The browser runs in the cloud, so the system must be reachable from the internet (not localhost, an intranet or a VPN).</p>
                  </div>
                  <div className="field">
                    <span className="label">Sign in as</span>
                    {accounts.length === 0 ? (
                      <p className="field-hint">No test accounts yet: the guide covers only what can be opened without signing in.</p>
                    ) : (
                      <div className="checkbox-group" role="group" aria-label="Test accounts">
                        {accounts.map((a) => (
                          <label key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                              type="checkbox" checked={roles.includes(a.role)} disabled={busy}
                              onChange={(e) => setRoles((rs) => (e.target.checked ? [...rs, a.role] : rs.filter((x) => x !== a.role)))}
                            />
                            <span>{a.role}</span> <span className="muted">{a.username}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {roles.length >= 2 && (
                      <label className="checkbox-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                        <input type="checkbox" checked={perRole} onChange={(e) => setPerRole(e.target.checked)} disabled={busy} />
                        Large guide: one document per role ({roles.length} sessions, up to 40 screenshots each)
                      </label>
                    )}
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setManage(true)} disabled={busy}>Manage test accounts…</button>
                    <p className="field-hint">The agent never sees the passwords: they are typed into the sign-in page for it. Use test accounts only.</p>
                    <label className="checkbox-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                      <input type="checkbox" checked={manualSignIn} onChange={(e) => setManualSignIn(e.target.checked)} disabled={busy} />
                      I will sign in myself in the live browser
                    </label>
                    <p className="field-hint">When the agent reaches the sign-in page it waits, and the guide's row shows <strong>Watch browser</strong>. Open it, switch on Remote control, sign in (or enter a code) and switch control off. Your password never goes through the portal. Waits up to 10 minutes.</p>
                  </div>
                  <div className="field">
                    <label htmlFor="nd-guide-hosts">Other hosts used to sign in (optional)</label>
                    <input id="nd-guide-hosts" type="text" value={guideHosts} onChange={(e) => setGuideHosts(e.target.value)} maxLength={300} placeholder="login.example.com" disabled={busy} />
                    <p className="field-hint">Only the system's own address (and these) may receive a sign-in.</p>
                  </div>
                </div>
              )}
            </fieldset>
          )}

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
      {manage && (
        <GuideAccountsModal
          projectId={projectId}
          onClose={() => setManage(false)}
          onChanged={(list) => { setAccounts(list); setRoles((rs) => rs.filter((r) => list.some((a) => a.role === r))); }}
        />
      )}
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
/** The agent's cloud browser while a guide is being written: watch it, and sign in yourself when the agent asks. */
function WatchBrowserModal({ doc, projectId, onClose }) {
  const ref = useFocusTrap();
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="watch-browser-title">
      <div className="modal" ref={ref} style={{ width: 'min(1100px, 96vw)', maxWidth: 'none' }}>
        <div className="modal-header">
          <h2 id="watch-browser-title">Browser for {doc.name}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div style={{ height: 'min(70vh, 720px)' }}>
          <IdeBrowser workflowId={doc.workflow_id} projectId={projectId} />
        </div>
      </div>
    </div>
  );
}

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
  const [watching, setWatching] = useState(null);
  const [shotsDoc, setShotsDoc] = useState(null);
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
                          {d.sources?.guide?.screenshots && (
                            <a
                              href={`/api/projects/${projectId}/generated-docs/${d.id}/download?format=zip`}
                              className="btn btn-sm btn-ghost"
                              download
                              title="The Markdown, the Word file and the screenshots"
                            >
                              Download ZIP
                            </a>
                          )}
                          {d.doc_type === 'user-guide' && (
                            <>
                              <a
                                href={`/api/projects/${projectId}/generated-docs/${d.id}/download?format=html`}
                                className="btn btn-sm btn-ghost"
                                download
                                title="A single web page (index.html) with its screenshots folder: unzip and open index.html"
                              >
                                Download HTML guide
                              </a>
                              {d.sources?.guideSet && (
                                <a
                                  href={`/api/projects/${projectId}/generated-docs/guide-set/${d.sources.guideSet.id}/download?format=html`}
                                  className="btn btn-sm btn-ghost"
                                  download
                                  title="All the documents of this large guide as one web page, a chapter per role"
                                >
                                  Whole guide (HTML)
                                </a>
                              )}
                              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShotsDoc(d)} title="Which screenshots the guide shows, and which it does not">
                                Screenshots
                              </button>
                            </>
                          )}
                        </>
                      )}
                      {d.status === 'generating' && d.sources?.guide?.screenshots && d.workflow_id && (
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setWatching(d)} title="See the cloud browser and sign in yourself if the agent asks">
                          Watch browser
                        </button>
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

      {shotsDoc && <GuideShotBoard projectId={projectId} doc={shotsDoc} onClose={() => setShotsDoc(null)} />}
      {watching && <WatchBrowserModal doc={watching} projectId={projectId} onClose={() => setWatching(null)} />}
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
