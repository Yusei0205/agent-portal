import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { navigate } from '../lib/router.js';
import { useBulkSelect } from '../lib/useBulkSelect.js';
import { BulkActionBar } from '../components/BulkActionBar.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { buildFolderList } from '../lib/vaultFolders.js';
import { useSort } from '../lib/useSort.jsx';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Parse the `folder` query-param from the current hash URL.
 * The router strips query-params from its parseRoute result, so we read
 * window.location.hash directly.
 * @returns {string | null}
 */
function readFolderFromHash() {
  const hash = window.location.hash;
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return null;
  const qs = hash.slice(qIdx + 1);
  const params = new URLSearchParams(qs);
  return params.get('folder') ?? null;
}

// ── Personal / Portal scopes — simple flat file list ─────────────────────────

function FlatScopeTab({ projectId, scope, label }) {
  const [files, setFiles] = useState([]);
  const { sorted: sortedFiles, sortProps } = useSort(files, { name: (f) => f.name, size: (f) => f.size_bytes, type: (f) => f.mime_type, by: (f) => f.uploaded_by, date: (f) => f.created_at });
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const fileRef = useRef(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();
  const bulk = useBulkSelect(files);

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
      bulk.clearAll();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleBulkDelete = async () => {
    const n = bulk.selected.size;
    if (!await requestConfirm(
      `Delete ${n} file${n === 1 ? '' : 's'}? This cannot be undone.`,
      'Delete', 'danger',
    )) return;
    setBulkBusy(true);
    const ids = [...bulk.selected];
    const failed = [];
    await Promise.all(ids.map(async (id) => {
      try {
        await api.delete(`/api/projects/${projectId}/vault/${id}`);
      } catch {
        failed.push(id);
      }
    }));
    setFiles((f) => f.filter((x) => !ids.includes(x.id) || failed.includes(x.id)));
    bulk.clearAll();
    if (failed.length > 0) {
      toast(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be deleted.`, 'error');
    }
    setBulkBusy(false);
  };

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
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
        <div style={{ position: 'relative' }}>
          <table className="data-table" aria-label={`${label} vault files`}>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all files"
                    checked={bulk.allSelected}
                    ref={(el) => { if (el) el.indeterminate = bulk.someSelected; }}
                    onChange={bulk.toggleAll}
                  />
                </th>
                <th {...sortProps('name')}>Name</th>
                <th {...sortProps('size')}>Size</th>
                <th {...sortProps('type')}>Type</th>
                <th {...sortProps('by')}>Uploaded by</th>
                <th {...sortProps('date')}>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedFiles.map((f) => (
                <tr key={f.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${f.name}`}
                      checked={bulk.selected.has(f.id)}
                      onChange={() => bulk.toggle(f.id)}
                    />
                  </td>
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
          <BulkActionBar
            selected={bulk.selected}
            onDelete={handleBulkDelete}
            onClear={bulk.clearAll}
            busy={bulkBusy}
            noun="file"
          />
        </div>
      )}
    </div>
  );
}

// ── Project scope — folder-grouped view ───────────────────────────────────────

/**
 * Parse a folder path into breadcrumb segments.
 * 'Sessions/My session (abc123)' → ['Sessions', 'My session (abc123)']
 * @param {string | null} folder
 * @returns {string[]}
 */
function parseFolderSegments(folder) {
  if (!folder) return [];
  return folder.split('/').filter(Boolean);
}

/**
 * Accessible dialog for moving selected files to a target folder.
 */
function MoveFolderDialog({ allFiles, currentFolder, busy, onMove, onClose }) {
  const [selected, setSelected] = useState(null); // null = not chosen yet
  const [custom, setCustom] = useState('');
  const trapRef = useFocusTrap();

  // Build deduplicated sorted folder list from all files
  const folders = buildFolderList(allFiles);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleMove = () => {
    // Custom field takes precedence if filled in; otherwise use the selected folder
    const target = custom.trim() || selected;
    onMove(target || null);
  };

  const canMove = (custom.trim() !== '' || selected !== null) && !busy;
  const overlayDismiss = useOverlayDismiss(onClose);

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
        aria-labelledby="move-dialog-title"
        style={{ maxWidth: 460 }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="move-dialog-title">Move to folder</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close" disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="muted" style={{ fontSize: '0.84rem', margin: 0 }}>
            Select an existing folder or type a new path.
          </p>

          {/* Existing folders list */}
          {folders.length > 0 && (
            <div role="listbox" aria-label="Existing folders">
              <div
                className={`vault-folder-option${selected === '' ? ' is-active' : ''}`}
                role="option"
                aria-selected={selected === ''}
                tabIndex={0}
                onClick={() => { setSelected(''); setCustom(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(''); setCustom(''); } }}
                style={{
                  padding: '6px 10px',
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
                  background: selected === '' ? 'var(--accent-wash)' : undefined,
                  color: selected === '' ? 'var(--accent)' : undefined,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: '0.84rem',
                  marginBottom: 2,
                }}
              >
                <Icon name="archive" size={13} />
                Root (no folder)
              </div>
              {folders.map((f) => (
                <div
                  key={f}
                  role="option"
                  aria-selected={selected === f}
                  tabIndex={0}
                  onClick={() => { setSelected(f); setCustom(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(f); setCustom(''); } }}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 'var(--radius)',
                    cursor: 'pointer',
                    background: selected === f ? 'var(--accent-wash)' : undefined,
                    color: selected === f ? 'var(--accent)' : undefined,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: '0.84rem',
                    marginBottom: 2,
                    fontFamily: 'var(--mono)',
                  }}
                >
                  <Icon name="explorer" size={13} />
                  {f}
                </div>
              ))}
            </div>
          )}

          {/* Custom folder path */}
          <div className="field">
            <label htmlFor="move-custom-folder" style={{ fontSize: '0.82rem' }}>
              Or type a new folder path
            </label>
            <input
              id="move-custom-folder"
              type="text"
              className="input"
              placeholder="e.g. Reports/2026"
              value={custom}
              onChange={(e) => { setCustom(e.target.value); setSelected(null); }}
              disabled={busy}
              style={{ fontFamily: 'var(--mono)', fontSize: '0.84rem' }}
            />
          </div>
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleMove}
            disabled={!canMove}
            aria-label={`Move to ${custom.trim() || selected || 'root'}`}
          >
            {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Move'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectScopeTab({ projectId }) {
  const [allFiles, setAllFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);

  // Current folder path (null = root)
  const [currentFolder, setCurrentFolder] = useState(() => readFolderFromHash());

  // Listen to hash changes to support browser back/forward
  useEffect(() => {
    const onHashChange = () => setCurrentFolder(readFolderFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const fileRef = useRef(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  // ── Derived folder structure (must come before useBulkSelect) ─────────────

  // Files directly in the current folder (their `folder` field matches exactly).
  // Wrapped in useMemo so esbuild's minification does not hoist the declaration
  // out of order and cause a temporal dead zone error in production builds.
  const filesHere = useMemo(
    () => allFiles.filter((f) => {
      const fileFolder = f.folder ?? null;
      if (currentFolder === null) return fileFolder === null;
      return fileFolder === currentFolder;
    }),
    [allFiles, currentFolder],
  );

  // Bulk select only files visible in the current folder
  const bulk = useBulkSelect(filesHere);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/vault?scope=project`);
      setAllFiles(r.files || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // ── Derived folder state (childFolders, breadcrumb) ─────────────────────

  // Sub-folders: files whose folder starts with currentFolder + '/' (or top-level folders)
  const childFolderSet = new Set();
  for (const f of allFiles) {
    const fileFolder = f.folder;
    if (!fileFolder) continue;
    if (currentFolder === null) {
      // At root — collect the first segment of each folder path
      const firstSegment = fileFolder.split('/')[0];
      if (firstSegment) childFolderSet.add(firstSegment);
    } else {
      // Inside a folder — collect direct child folders
      const prefix = currentFolder + '/';
      if (fileFolder.startsWith(prefix)) {
        const rest = fileFolder.slice(prefix.length);
        const nextSegment = rest.split('/')[0];
        if (nextSegment) childFolderSet.add(nextSegment);
      }
    }
  }

  // Convert to folder summaries
  const childFolders = Array.from(childFolderSet).sort().map((seg) => {
    const fullPath = currentFolder ? `${currentFolder}/${seg}` : seg;
    // Count all files that live inside this folder (at any depth)
    const contained = allFiles.filter((f) => {
      const ff = f.folder;
      return ff === fullPath || (ff && ff.startsWith(fullPath + '/'));
    });
    const totalSize = contained.reduce((s, f) => s + (f.size_bytes || 0), 0);
    return { name: seg, fullPath, count: contained.length, totalSize };
  });

  // ── Breadcrumb ────────────────────────────────────────────────────────────

  const segments = parseFolderSegments(currentFolder);

  const navigateToFolder = (folder) => {
    const qs = folder ? `?folder=${encodeURIComponent(folder)}` : '';
    navigate(`/p/${encodeURIComponent(projectId)}/vault${qs}`);
  };

  // ── Actions ───────────────────────────────────────────────────────────────

  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('scope', 'project');
      if (currentFolder) fd.append('folder', currentFolder);
      const res = await fetch(`/api/projects/${projectId}/vault/upload`, {
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

  const downloadAll = () => {
    const url = currentFolder
      ? `/api/projects/${projectId}/vault/zip?scope=project&folder=${encodeURIComponent(currentFolder)}`
      : `/api/projects/${projectId}/vault/zip?scope=project`;
    window.open(url, '_blank');
  };

  const downloadFolder = (folderPath) => {
    const url = `/api/projects/${projectId}/vault/zip?scope=project&folder=${encodeURIComponent(folderPath)}`;
    window.open(url, '_blank');
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

  const deleteFile = async (fileId, fileName) => {
    if (!await requestConfirm(`Delete "${fileName}"?`, 'Delete', 'danger')) return;
    try {
      await api.delete(`/api/projects/${projectId}/vault/${fileId}`);
      setAllFiles((prev) => prev.filter((x) => x.id !== fileId));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleBulkDelete = async () => {
    const n = bulk.selected.size;
    if (!await requestConfirm(
      `Delete ${n} file${n === 1 ? '' : 's'}? This cannot be undone.`,
      'Delete', 'danger',
    )) return;
    setBulkBusy(true);
    const ids = [...bulk.selected];
    try {
      await api.post(`/api/projects/${projectId}/vault/delete`, { fileIds: ids });
      setAllFiles((prev) => prev.filter((x) => !ids.includes(x.id)));
      bulk.clearAll();
    } catch (err) {
      toast(err.message || 'Delete failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkMove = async (folder) => {
    const n = bulk.selected.size;
    setBulkBusy(true);
    const ids = [...bulk.selected];
    try {
      await api.post(`/api/projects/${projectId}/vault/move`, {
        fileIds: ids,
        folder: folder || null,
      });
      const label = folder || 'Root';
      toast(`Moved ${n} file${n === 1 ? '' : 's'} to ${label}`, 'ok');
      bulk.clearAll();
      setShowMoveDialog(false);
      await load();
    } catch (err) {
      toast(err.message || 'Move failed', 'error');
    } finally {
      setBulkBusy(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      {error && <p className="error-note" role="alert">{error}</p>}

      {/* Breadcrumb */}
      <nav className="vault-breadcrumb" aria-label="Vault folder navigation">
        <button
          type="button"
          className={`vault-breadcrumb-seg${currentFolder === null ? ' is-current' : ''}`}
          onClick={() => navigateToFolder(null)}
          aria-current={currentFolder === null ? 'page' : undefined}
        >
          <Icon name="archive" size={13} aria-hidden="true" />
          Project
        </button>
        {segments.map((seg, idx) => {
          const folderPath = segments.slice(0, idx + 1).join('/');
          const isCurrent = idx === segments.length - 1;
          return (
            <span key={folderPath} className="vault-breadcrumb-item">
              <span className="vault-breadcrumb-sep" aria-hidden="true">/</span>
              <button
                type="button"
                className={`vault-breadcrumb-seg${isCurrent ? ' is-current' : ''}`}
                onClick={() => navigateToFolder(folderPath)}
                aria-current={isCurrent ? 'page' : undefined}
              >
                {seg}
              </button>
            </span>
          );
        })}
      </nav>

      {/* Actions row */}
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
            aria-label="Upload to project vault"
          />
        </label>

        {(childFolders.length > 0 || filesHere.length > 0) && (
          <button type="button" className="btn btn-secondary" onClick={downloadAll}>
            <Icon name="zip-download" size={14} />
            {currentFolder ? 'Download folder' : 'Download all'}
          </button>
        )}
      </div>

      {/* Empty state */}
      {childFolders.length === 0 && filesHere.length === 0 && (
        <div className="empty-state">
          <p>
            {currentFolder
              ? 'This folder is empty.'
              : 'No files in the project vault. Upload a file or run a session to generate outputs.'}
          </p>
        </div>
      )}

      {/* Folders table */}
      {childFolders.length > 0 && (
        <table className="data-table" aria-label="Sub-folders">
          <thead>
            <tr>
              <th>Folder</th>
              <th>Files</th>
              <th>Total size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {childFolders.map((folder) => (
              <tr key={folder.fullPath} className="vault-folder-row">
                <td>
                  <button
                    type="button"
                    className="vault-folder-link"
                    onClick={() => navigateToFolder(folder.fullPath)}
                    aria-label={`Open folder ${folder.name}`}
                  >
                    <Icon name="explorer" size={14} aria-hidden="true" />
                    {folder.name}
                  </button>
                </td>
                <td className="muted">{folder.count} file{folder.count !== 1 ? 's' : ''}</td>
                <td className="muted">{formatBytes(folder.totalSize)}</td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() => downloadFolder(folder.fullPath)}
                      aria-label={`Download folder ${folder.name} as ZIP`}
                      title="Download folder as ZIP"
                    >
                      <Icon name="zip-download" size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Files table */}
      {filesHere.length > 0 && (
        <div style={{ position: 'relative' }}>
          <table className="data-table" aria-label="Project vault files">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all files"
                    checked={bulk.allSelected}
                    ref={(el) => { if (el) el.indeterminate = bulk.someSelected; }}
                    onChange={bulk.toggleAll}
                  />
                </th>
                <th>Name</th>
                <th>Size</th>
                <th>Type</th>
                <th>Uploaded by</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filesHere.map((f) => (
                <tr key={f.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${f.name}`}
                      checked={bulk.selected.has(f.id)}
                      onChange={() => bulk.toggle(f.id)}
                    />
                  </td>
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
          <BulkActionBar
            selected={bulk.selected}
            onDelete={handleBulkDelete}
            onClear={bulk.clearAll}
            busy={bulkBusy}
            noun="file"
            extraActions={
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setShowMoveDialog(true)}
                disabled={bulkBusy}
                aria-label={`Move ${bulk.selected.size} selected file${bulk.selected.size === 1 ? '' : 's'} to a folder`}
              >
                <Icon name="folder" size={13} />
                Move to…
              </button>
            }
          />
          {showMoveDialog && (
            <MoveFolderDialog
              allFiles={allFiles}
              currentFolder={currentFolder}
              busy={bulkBusy}
              onMove={handleBulkMove}
              onClose={() => setShowMoveDialog(false)}
            />
          )}
        </div>
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
        {tab === 'project' && (
          <ProjectScopeTab projectId={projectId} />
        )}
        {tab === 'personal' && (
          <FlatScopeTab
            projectId={projectId}
            scope="personal"
            label="Personal"
          />
        )}
        {tab === 'portal' && (
          <FlatScopeTab
            projectId={projectId}
            scope="portal"
            label="Portal-wide"
          />
        )}
      </div>
    </div>
  );
}

export default Vault;
