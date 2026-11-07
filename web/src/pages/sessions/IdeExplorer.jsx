/**
 * IDE Explorer panel — file tree for session working copy, uploads, and vault.
 *
 * Fixes applied:
 *  - Upload now checks res.ok and surfaces 4xx/5xx errors.
 *  - Tree nodes use role="treeitem" (not role="option") with aria-level and
 *    arrow-key navigation (Up/Down/Left/Right/Enter/ ).
 *  - "Team vault" root added alongside "My vault" (both read-only).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../../components/Toast.jsx';

function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

// ── Confirm / toast helpers are provided by the shared components ─────────────

// ── Tree node ─────────────────────────────────────────────────────────────────

/**
 * A single node in the file tree.
 *
 * Accessibility:
 *  - role="treeitem" on every node (not role="option" which belongs in listboxes)
 *  - aria-expanded on directory nodes
 *  - aria-level derived from depth
 *  - roving-tabindex: the focused item gets tabIndex=0, siblings get -1
 *  - Arrow key navigation handled at the tree container level (see ScopeSection)
 */
function TreeNode({
  entry, depth, workflowId, scope, onFileOpen, refresh, readOnly,
  isFocused, onRequestFocus,
}) {
  const [open, setOpen]                   = useState(false);
  const [children, setChildren]           = useState(null);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [renaming, setRenaming]           = useState(false);
  const [newName, setNewName]             = useState(entry.name);
  const nodeRef = useRef(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const indent   = (depth + 1) * 14;
  const isDir    = entry.type === 'directory';
  const isReadOnly = readOnly || entry.readOnly;

  // Roving tabindex: this node owns focus only when it is the "focused" node
  useEffect(() => {
    if (isFocused) nodeRef.current?.focus();
  }, [isFocused]);

  const loadChildren = useCallback(async () => {
    if (!isDir) return;
    setLoadingChildren(true);
    try {
      const data = await api.get(
        `/api/workflows/${workflowId}/ide/tree?scope=${scope}&path=${encodeURIComponent(entry.path)}`,
      );
      setChildren(data.entries || []);
    } catch {
      setChildren([]);
    } finally {
      setLoadingChildren(false);
    }
  }, [workflowId, scope, entry.path, isDir]);

  const toggle = () => {
    if (!isDir) {
      onFileOpen({ scope, path: entry.path, name: entry.name, ext: extOf(entry.name) });
      return;
    }
    if (!open && !children) loadChildren();
    setOpen((o) => !o);
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!await requestConfirm(`Delete "${entry.name}"?`, 'Delete', 'danger')) return;
    try {
      await api.delete(
        `/api/workflows/${workflowId}/ide/file?scope=${scope}&path=${encodeURIComponent(entry.path)}`,
      );
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const handleRename = (e) => {
    e.stopPropagation();
    setRenaming(true);
    setNewName(entry.name);
  };

  const submitRename = async (e) => {
    e?.preventDefault();
    if (!newName || newName === entry.name) { setRenaming(false); return; }
    const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1) : '';
    const newPath = dir + newName;
    try {
      await api.patch(`/api/workflows/${workflowId}/ide/rename`, {
        scope,
        path: entry.path,
        newPath,
      });
      setRenaming(false);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
      setRenaming(false);
    }
  };

  const handleKeyDown = (e) => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        toggle();
        break;
      case 'ArrowRight':
        if (isDir && !open) {
          e.preventDefault();
          if (!children) loadChildren();
          setOpen(true);
        }
        break;
      case 'ArrowLeft':
        if (isDir && open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      default:
        // ArrowUp/Down handled at the tree container via focus management
        break;
    }
  };

  return (
    <div>
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div
        ref={nodeRef}
        className={`ide-tree-node${entry.ignored ? ' is-ignored' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={toggle}
        onFocus={() => onRequestFocus && onRequestFocus()}
        role="treeitem"
        aria-expanded={isDir ? open : undefined}
        aria-level={depth + 1}
        aria-label={entry.name}
        tabIndex={isFocused ? 0 : -1}
        onKeyDown={handleKeyDown}
      >
        <span className="ide-tree-node-icon" aria-hidden="true">
          {isDir
            ? <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
            : <Icon name="file" size={13} />}
        </span>

        {renaming ? (
          <form
            onSubmit={submitRename}
            style={{ display: 'flex', gap: 4, flex: 1 }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(false); }}
              style={{ flex: 1, fontSize: '0.82rem', height: 22, padding: '0 4px' }}
              aria-label="New name"
            />
          </form>
        ) : (
          <>
            <span className="ide-tree-node-name">{entry.name}</span>
            {!isReadOnly && (
              <span className="ide-tree-node-actions">
                <button
                  type="button"
                  className="btn-icon"
                  title="Rename"
                  aria-label={`Rename ${entry.name}`}
                  style={{ width: 20, height: 20 }}
                  onClick={handleRename}
                >
                  <Icon name="rename" size={12} />
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  title="Delete"
                  aria-label={`Delete ${entry.name}`}
                  style={{ width: 20, height: 20, color: 'var(--danger)' }}
                  onClick={handleDelete}
                >
                  <Icon name="trash" size={12} />
                </button>
              </span>
            )}
          </>
        )}
      </div>

      {isDir && open && (
        <div role="group" aria-label={`Contents of ${entry.name}`}>
          {loadingChildren && (
            <div style={{ paddingLeft: indent + 14 }}>
              <div
                className="spinner"
                style={{ width: 12, height: 12, margin: '4px 0' }}
                aria-label="Loading…"
              />
            </div>
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              workflowId={workflowId}
              scope={scope}
              onFileOpen={onFileOpen}
              refresh={() => { loadChildren(); refresh(); }}
              readOnly={isReadOnly}
              isFocused={false}
              onRequestFocus={() => {}}
            />
          ))}
          {children?.length === 0 && (
            <div
              style={{
                paddingLeft: indent + 14,
                fontSize: '0.75rem',
                color: 'var(--ink-3)',
                padding: `3px 0 3px ${indent + 14}px`,
              }}
            >
              (empty)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Scope root section ────────────────────────────────────────────────────────

function ScopeSection({ root, workflowId, onFileOpen, globalRefreshCount }) {
  const [entries, setEntries]     = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [open, setOpen]           = useState(true);
  const [dragging, setDragging]   = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [focusedPath, setFocusedPath] = useState(null); // for roving tabindex
  const [showNewFile, setShowNewFile]     = useState(false);
  const [newFileName, setNewFileName]     = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const treeRef = useRef(null);
  const isReadOnly = root.readOnly;
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(
        `/api/workflows/${workflowId}/ide/tree?scope=${root.scope}&path=`,
      );
      setEntries(data.entries || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [workflowId, root.scope]);

  useEffect(() => { if (open) load(); }, [open, load, globalRefreshCount]);

  const handleNewFile = async (e) => {
    e.preventDefault();
    if (!newFileName.trim()) return;
    try {
      await api.post(`/api/workflows/${workflowId}/ide/file`, {
        scope: root.scope,
        path: newFileName.trim(),
        content: '',
      });
      setNewFileName('');
      setShowNewFile(false);
      load();
    } catch (e) { toast(e.message, 'error'); }
  };

  const handleNewFolder = async (e) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      await api.post(`/api/workflows/${workflowId}/ide/folder`, {
        scope: root.scope,
        path: newFolderName.trim(),
      });
      setNewFolderName('');
      setShowNewFolder(false);
      load();
    } catch (e) { toast(e.message, 'error'); }
  };

  // Upload: check res.ok and surface 4xx/5xx errors (fix #3)
  const handleUpload = (files) => {
    setUploadError(null);
    Array.from(files).forEach((file) => {
      const fd = new FormData();
      fd.append('file', file);
      fetch(`/api/workflows/${workflowId}/ide/upload`, {
        method: 'POST',
        headers: { 'x-requested-with': 'agent-portal' },
        credentials: 'same-origin',
        body: fd,
      })
        .then(async (res) => {
          if (!res.ok) {
            let msg = `Upload failed (HTTP ${res.status})`;
            try {
              const body = await res.json();
              msg = body.error ?? body.message ?? msg;
            } catch { /* use status text */ }
            setUploadError(msg);
            return;
          }
          load();
        })
        .catch((e) => setUploadError(e.message));
    });
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (root.readOnly) return;
    handleUpload(e.dataTransfer.files);
  };

  const handleDownloadZip = () => {
    const url = `/api/workflows/${workflowId}/ide/download-zip?scope=${root.scope}`;
    window.open(url, '_blank', 'noopener');
  };

  // Arrow-key navigation for the tree (roving focus across visible treeitems)
  const handleTreeKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const treeitems = Array.from(
      treeRef.current?.querySelectorAll('[role="treeitem"]') ?? [],
    );
    if (treeitems.length === 0) return;
    const current = document.activeElement;
    const idx = treeitems.indexOf(current);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = treeitems[idx + 1] ?? treeitems[0];
      next.focus();
    } else {
      e.preventDefault();
      const prev = treeitems[idx - 1] ?? treeitems[treeitems.length - 1];
      prev.focus();
    }
  };

  return (
    <div>
      <div
        className="ide-tree-root-header"
        onClick={() => setOpen((o) => !o)}
        role="button"
        aria-expanded={open}
        aria-label={root.name}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') setOpen((o) => !o); }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        <span style={{ flex: 1 }}>{root.name}</span>
        {isReadOnly && (
          <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>read-only</span>
        )}
        <span className="ide-tree-root-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn-icon"
            title="Refresh"
            aria-label="Refresh"
            style={{ width: 22, height: 22 }}
            onClick={load}
          >
            <Icon name="refresh" size={12} />
          </button>
          {!isReadOnly && (
            <>
              <button
                type="button"
                className="btn-icon"
                title="New file"
                aria-label="New file"
                style={{ width: 22, height: 22 }}
                onClick={() => { setShowNewFile(true); setShowNewFolder(false); }}
              >
                <Icon name="file-plus" size={12} />
              </button>
              <button
                type="button"
                className="btn-icon"
                title="New folder"
                aria-label="New folder"
                style={{ width: 22, height: 22 }}
                onClick={() => { setShowNewFolder(true); setShowNewFile(false); }}
              >
                <Icon name="folder-plus" size={12} />
              </button>
              {root.scope === 'uploads' && (
                <label
                  title="Upload file"
                  aria-label="Upload file"
                  style={{
                    width: 22,
                    height: 22,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <Icon name="upload" size={12} />
                  <input
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => handleUpload(e.target.files)}
                  />
                </label>
              )}
              <button
                type="button"
                className="btn-icon"
                title="Download as zip"
                aria-label="Download as zip"
                style={{ width: 22, height: 22 }}
                onClick={handleDownloadZip}
              >
                <Icon name="zip-download" size={12} />
              </button>
            </>
          )}
        </span>
      </div>

      {uploadError && (
        <div
          className="error-note"
          style={{ margin: '2px 6px', padding: '3px 8px', fontSize: '0.78rem' }}
          role="alert"
        >
          {uploadError}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => setUploadError(null)}
            style={{ marginLeft: 4 }}
          >
            Dismiss
          </button>
        </div>
      )}

      <ToastShelf toasts={toasts} onRemove={removeToast} />
      {showNewFile && (
        <form onSubmit={handleNewFile} style={{ padding: '4px 8px', display: 'flex', gap: 4 }}>
          <input type="text" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} placeholder="path/file.json" autoFocus style={{ flex: 1, fontSize: '0.8rem', minHeight: 26, padding: '2px 6px' }} aria-label="New file name" onKeyDown={(e) => { if (e.key === 'Escape') { setShowNewFile(false); setNewFileName(''); } }} />
          <button type="submit" className="btn btn-sm btn-primary" style={{ padding: '2px 6px' }}>Add</button>
          <button type="button" className="btn btn-sm" style={{ padding: '2px 6px' }} onClick={() => { setShowNewFile(false); setNewFileName(''); }}>✕</button>
        </form>
      )}
      {showNewFolder && (
        <form onSubmit={handleNewFolder} style={{ padding: '4px 8px', display: 'flex', gap: 4 }}>
          <input type="text" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="folder-name" autoFocus style={{ flex: 1, fontSize: '0.8rem', minHeight: 26, padding: '2px 6px' }} aria-label="New folder name" onKeyDown={(e) => { if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName(''); } }} />
          <button type="submit" className="btn btn-sm btn-primary" style={{ padding: '2px 6px' }}>Add</button>
          <button type="button" className="btn btn-sm" style={{ padding: '2px 6px' }} onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}>✕</button>
        </form>
      )}

      {open && (
        <div
          ref={treeRef}
          className={`ide-tree${dragging ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); if (!isReadOnly) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onKeyDown={handleTreeKeyDown}
          role="tree"
          aria-label={`${root.name} file tree`}
        >
          {loading && (
            <div style={{ padding: '4px 16px' }}>
              <div className="spinner" style={{ width: 12, height: 12 }} aria-label="Loading…" />
            </div>
          )}
          {error && (
            <div
              className="error-note"
              style={{ margin: 6, padding: '4px 8px', fontSize: '0.8rem' }}
            >
              {error}
            </div>
          )}
          {entries?.map((entry, i) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              workflowId={workflowId}
              scope={root.scope}
              onFileOpen={onFileOpen}
              refresh={load}
              readOnly={isReadOnly}
              isFocused={focusedPath === entry.path || (focusedPath === null && i === 0)}
              onRequestFocus={() => setFocusedPath(entry.path)}
            />
          ))}
          {entries?.length === 0 && (
            <div style={{ padding: '6px 16px', fontSize: '0.78rem', color: 'var(--ink-3)' }}>
              {isReadOnly ? 'No files' : 'Drop files here to upload'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * @param {{
 *   workflowId: string,
 *   onFileOpen: (file: { scope: string, path: string, name: string, ext: string }) => void,
 * }} props
 */
export function IdeExplorer({ workflowId, onFileOpen }) {
  const [roots, setRoots] = useState(null);
  const [error, setError] = useState(null);
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    api.get(`/api/workflows/${workflowId}/ide/tree`)
      .then((data) => {
        const r = data.roots || [];
        // Add vault roots after server-provided roots.
        // "My vault"   → personal vault entries (read-only, scope=vault)
        // "Team vault" → project / portal vault entries (read-only, scope=vault:team)
        setRoots([
          ...r,
          { name: 'My vault',   scope: 'vault',      path: '', readOnly: true },
          { name: 'Team vault', scope: 'vault:team',  path: '', readOnly: true },
        ]);
      })
      .catch((e) => setError(e.message));
  }, [workflowId]);

  if (error) {
    return (
      <div className="error-note" style={{ margin: 8 }} role="alert">
        {error}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setError(null)}
          style={{ marginLeft: 6 }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!roots) {
    return (
      <div style={{ padding: '16px', textAlign: 'center' }}>
        <div className="spinner" style={{ margin: '0 auto' }} aria-label="Loading explorer…" />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      {roots.map((root) => (
        <ScopeSection
          key={root.scope}
          root={root}
          workflowId={workflowId}
          onFileOpen={onFileOpen}
          globalRefreshCount={refreshCount}
        />
      ))}
    </div>
  );
}
