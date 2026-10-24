import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx, plural } from '../../lib/util.js';
import { useSortable } from '../../lib/useSortable.js';
import { Icon } from '../../components/Icon.jsx';
import { SortHeader } from '../../components/SortHeader.jsx';
import { Badge, Button, Empty, ErrorNote, IconButton, Spinner, useUi } from '../../components/ui.jsx';
import { Breadcrumb, FolderPickerModal, FolderTree, NewFolderModal, RenameFolderModal, buildFolderTree, cleanFolderPath, commonFolder } from './folders.jsx';
import { SearchBar, SearchResults } from './Search.jsx';
import { DocRow, RenameDocModal, SetRepoModal } from './DocRow.jsx';

/* ---------------- Documents (file manager) ---------------- */

export const TYPE_LABEL = { '.md': 'Markdown', '.markdown': 'Markdown', '.txt': 'Text', '.pdf': 'PDF', '.docx': 'Word', '.xlsx': 'Excel', '.pptx': 'PowerPoint', '.html': 'HTML', '.htm': 'HTML', '.csv': 'CSV', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.odt': 'OpenDocument', '.rtf': 'RTF', '.epub': 'EPUB' };

export function Documents() {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const docs = useLoad(() => api.get(`/api/projects/${project.id}/documents`), [project.id]);
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  useProjectEvents(['document.updated', 'document.deleted'], () => docs.reload(true));
  useProjectEvents(['repo.updated', 'repo.deleted'], () => {
    repos.reload(true);
    docs.reload(true);
  });

  const repoList = repos.data?.repos || [];
  const repoName = (id) => repoList.find((r) => r.id === id)?.name;

  // Selected folder in the tree. '' = root.
  const [selectedFolder, setSelectedFolder] = useState('');
  // Selected document ids for bulk operations.
  const [selectedIds, setSelectedIds] = useState(new Set());
  // Drag state: which folder path is being hovered.
  const [dropTarget, setDropTarget] = useState(null);
  // Drag source: ids being dragged.
  const draggingIds = useRef(null);
  // Search
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [searchError, setSearchError] = useState(null);
  // Upload repo tag
  const [uploadRepo, setUploadRepo] = useState('');
  // Upload batch state
  const [batch, setBatch] = useState(null);
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const [drag, setDrag] = useState(false);
  // Modals
  const [movingTo, setMovingTo] = useState(null); // 'single' | 'bulk' | null — opens FolderPickerModal
  const [renamingDoc, setRenamingDoc] = useState(null); // docRow | null
  const [settingRepo, setSettingRepo] = useState(null); // docRow | null
  const [newFolderAt, setNewFolderAt] = useState(null); // parent path | null
  const [renamingFolder, setRenamingFolder] = useState(null); // folder path | null
  // Live region
  const [liveMsg, setLiveMsg] = useState('');

  const announce = (msg) => {
    setLiveMsg('');
    setTimeout(() => setLiveMsg(msg), 10);
  };

  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const t = setTimeout(async () => {
      try {
        setSearchError(null);
        setHits(await api.get(`/api/projects/${project.id}/search?q=${encodeURIComponent(q)}`));
      } catch (e) {
        setSearchError(e);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, project.id]);

  const list = docs.data?.documents || [];
  const virtualFolders = docs.data?.folders || [];

  // Build folder tree: union of virtual folders + folders from documents.
  const allFolderPaths = useMemo(() => {
    const set = new Set(virtualFolders);
    for (const d of list) { if (d.folder) set.add(d.folder); }
    return [...set].sort();
  }, [list, virtualFolders]);

  const { root, nodeMap } = useMemo(() => buildFolderTree(allFolderPaths), [allFolderPaths]);

  // Attach doc counts to nodes.
  useMemo(() => {
    // Reset counts.
    for (const [, node] of nodeMap) node.docCount = 0;
    const uploaded = list.filter((d) => d.kind === 'upload');
    for (const d of uploaded) {
      const folder = d.folder || '';
      // Increment count on the exact folder and all ancestors.
      let parts = folder ? folder.split('/') : [];
      while (parts.length >= 0) {
        const p = parts.join('/');
        const node = nodeMap.get(p);
        if (node) node.docCount++;
        if (!parts.length) break;
        parts = parts.slice(0, -1);
      }
    }
  }, [list, nodeMap]);

  // "All documents" shows every document; any other folder shows its own documents, plus those in its
  // sub-folders when "Include sub-folders" is on.
  const [includeSub, setIncludeSub] = useState(false);
  const batchTimer = useRef(null);
  const docsInFolder = useMemo(() => {
    const decisionsDoc = list.find((d) => d.kind === 'decisions');
    const inScope = (d) => {
      const f = d.folder || '';
      if (selectedFolder === '') return true;
      return f === selectedFolder || (includeSub && f.startsWith(selectedFolder + '/'));
    };
    const uploaded = list.filter((d) => d.kind === 'upload' && inScope(d));
    return selectedFolder === '' ? [...(decisionsDoc ? [decisionsDoc] : []), ...uploaded] : uploaded;
  }, [list, selectedFolder, includeSub]);

  // Upload: send to the currently selected folder.
  const upload = async (items) => {
    const supported = new Set(docs.data?.supported || []);
    const usable = items.filter(({ file, folder }) => {
      const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
      const hidden = [...folder.split('/'), file.name].some((s) => s.startsWith('.') || s === 'node_modules');
      return supported.has(ext) && !hidden;
    });
    const skipped = items.length - usable.length;
    if (skipped) toast(`Skipped ${plural(skipped, 'file')}: unsupported type or inside a hidden / node_modules folder`);
    if (!usable.length) return;
    const failed = [];
    clearTimeout(batchTimer.current); // a finished batch's hide-timer must not wipe this one
    setBatch({ total: usable.length, done: 0, failed });
    // Uploads go inside the selected folder, keeping the structure of a dropped or chosen folder.
    const place = (folder) => [selectedFolder, folder].filter(Boolean).join('/');
    for (const { file, folder } of usable) {
      try {
        const uploadFolder = place(folder);
        const qs = `name=${encodeURIComponent(file.name)}${uploadFolder ? `&folder=${encodeURIComponent(uploadFolder)}` : ''}${uploadRepo ? `&repo=${encodeURIComponent(uploadRepo)}` : ''}`;
        const r = await api.upload(`/api/projects/${project.id}/documents?${qs}`, file);
        if (r.document.status === 'error') failed.push({ name: file.name, error: r.document.error });
      } catch (e) {
        failed.push({ name: file.name, error: e.message });
      }
      setBatch((b) => ({ ...b, done: b.done + 1, failed: [...failed] }));
    }
    await docs.reload(true);
    // Show what was just uploaded: go to the deepest folder that contains all of it, with its sub-folders.
    const common = commonFolder(usable.map((u) => place(u.folder)));
    if (common !== selectedFolder && (common.startsWith(selectedFolder ? selectedFolder + '/' : '') || selectedFolder === '')) {
      setSelectedFolder(common);
    }
    if (usable.some((u) => u.folder)) setIncludeSub(true);
    if (!failed.length) batchTimer.current = setTimeout(() => setBatch(null), 3000);
  };

  const fromPicker = (files) =>
    [...files].map((file) => {
      const rel = file.webkitRelativePath || '';
      return { file, folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' };
    });

  // Checkbox helpers.
  const toggleSelect = (id) =>
    setSelectedIds((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  // toggleAll is defined after sortedDocs (further below) so it selects visible rows.
  // Clear selections when folder changes.
  useEffect(() => setSelectedIds(new Set()), [selectedFolder]);

  // Move action (single or bulk).
  const moveToFolder = async (targetFolder) => {
    try {
      if (movingTo === 'single' && movingTo !== 'bulk') {
        // The single-doc case uses the last selected id (set before opening the modal).
        const id = [...selectedIds][0];
        if (!id) return;
        await api.patch(`/api/documents/${id}`, { folder: targetFolder });
        announce(`Moved document to ${targetFolder || 'root'}`);
      } else {
        const ids = [...selectedIds];
        await api.post(`/api/projects/${project.id}/documents/bulk-move`, { ids, folder: targetFolder });
        announce(`Moved ${ids.length} document${ids.length !== 1 ? 's' : ''} to ${targetFolder || 'root'}`);
      }
      setSelectedIds(new Set());
      setMovingTo(null);
      docs.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  // Drop handling.
  const handleDragStart = (e, docId) => {
    if (selectedIds.size > 1 && selectedIds.has(docId)) {
      draggingIds.current = [...selectedIds];
    } else {
      draggingIds.current = [docId];
    }
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDropOnFolder = async (e, folderPath) => {
    e.preventDefault();
    setDropTarget(null);
    if (!draggingIds.current?.length) return;
    const ids = draggingIds.current;
    draggingIds.current = null;
    try {
      await api.post(`/api/projects/${project.id}/documents/bulk-move`, { ids, folder: folderPath });
      announce(`Moved ${ids.length} document${ids.length !== 1 ? 's' : ''} to ${folderPath || 'root'}`);
      docs.reload(true);
    } catch (e2) {
      toast(e2.message, 'danger');
    }
  };

  // Folder actions.
  const createFolder = async (parentPath, name) => {
    const full = cleanFolderPath(parentPath ? `${parentPath}/${name}` : name);
    if (!full) return;
    try {
      await api.post(`/api/projects/${project.id}/folders`, { path: full });
      setSelectedFolder(full);
      docs.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  const renameFolder = async (oldPath, newName) => {
    const parts = oldPath.split('/');
    parts[parts.length - 1] = newName.trim();
    const newPath = cleanFolderPath(parts.join('/'));
    if (!newPath || newPath === oldPath) return;
    try {
      await api.patch(`/api/projects/${project.id}/folders`, { from: oldPath, to: newPath });
      if (selectedFolder === oldPath || selectedFolder.startsWith(oldPath + '/')) {
        setSelectedFolder(newPath + selectedFolder.slice(oldPath.length));
      }
      announce(`Folder renamed to ${newName}`);
      docs.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  const deleteFolder = async (folderPath) => {
    const uploadedCount = list.filter((d) => d.kind === 'upload' && (d.folder === folderPath || d.folder.startsWith(folderPath + '/'))).length;
    const msg = uploadedCount
      ? `Delete folder "${folderPath}" and move its ${plural(uploadedCount, 'document')} to root? Agents will still find them.`
      : `Delete empty folder "${folderPath}"?`;
    if (!(await confirm({ title: 'Delete folder', message: msg, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/projects/${project.id}/folders`, { path: folderPath, force: true });
      if (selectedFolder === folderPath || selectedFolder.startsWith(folderPath + '/')) {
        setSelectedFolder('');
      }
      announce(`Folder ${folderPath} deleted`);
      docs.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  const deleteDoc = async (d) => {
    if (!(await confirm({ title: 'Delete document', message: `Delete "${d.name}"? Agents will no longer find it. Learning content built from it will be marked out of date.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/documents/${d.id}`);
      toast('Document deleted');
      docs.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  const movableSelected = [...selectedIds].filter((id) => {
    const d = list.find((x) => x.id === id);
    return d && d.kind === 'upload';
  });

  // ---- Sorting for the documents table ----
  const DOC_COLUMNS = [
    { key: 'title',   label: 'Document',   accessor: (d) => d.name || d.title || '', type: 'text' },
    { key: 'type',    label: 'Type',       accessor: (d) => d.kind === 'upload' ? (d.size || 0) : null, type: 'size' },
    { key: 'repo',    label: 'Repository', accessor: (d) => repoName(d.repo_id) || '', type: 'text' },
    { key: 'sections',label: 'Sections',   accessor: (d) => d.sections_count ?? null, type: 'number' },
    { key: 'status',  label: 'Status',     accessor: (d) => d.status || '', type: 'status' },
    { key: 'updated', label: 'Updated',    accessor: (d) => d.updated_at || d.created_at || '', type: 'date' },
  ];
  const { sorted: sortedDocs, sortKey: docSortKey, sortDir: docSortDir, toggle: docToggle } = useSortable(
    docsInFolder,
    {
      columns: DOC_COLUMNS,
      storageKey: `sort:docs:${project.id}`,
      // Decisions log always pinned to top
      pinned: (d) => d.kind === 'decisions',
    }
  );

  // Search mode: show results, not the file manager. (After every hook, so the hook order never changes.)
  if (hits || searchError) {
    return (
      <div className="stack-lg">
        <SearchBar q={q} setQ={setQ} projectId={project.id} />
        <ErrorNote error={searchError} />
        {hits ? <SearchResults hits={hits} projectId={project.id} onClear={() => { setQ(''); setHits(null); }} /> : null}
      </div>
    );
  }

  // Select all visible (sorted) upload rows.
  const toggleAll = () => {
    const movable = sortedDocs.filter((d) => d.kind === 'upload');
    if (selectedIds.size === movable.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(movable.map((d) => d.id)));
    }
  };

  return (
    <div className="stack-lg">
      <SearchBar q={q} setQ={setQ} projectId={project.id} />

      {/* Live region for accessibility announcements */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{liveMsg}</div>

      {docs.loading && !docs.data ? (
        <Spinner />
      ) : (
        <div className="km-layout">
          {/* ---- Left: Folder tree ---- */}
          <div className="km-tree-pane">
            <div className="km-tree-head">
              <span className="field-label">Folders</span>
              {canEdit ? (
                <IconButton icon="plus" label="New folder at root" onClick={() => setNewFolderAt('')} />
              ) : null}
            </div>
            <FolderTree
              root={root}
              selectedFolder={selectedFolder}
              onSelect={setSelectedFolder}
              dropTarget={dropTarget}
              onDragOver={(e, path) => { e.preventDefault(); setDropTarget(path); }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={canEdit ? handleDropOnFolder : null}
              onNewFolder={canEdit ? (p) => setNewFolderAt(p) : null}
              onRename={canEdit ? (p) => setRenamingFolder(p) : null}
              onDelete={canEdit ? deleteFolder : null}
            />
          </div>

          {/* ---- Right: Document list ---- */}
          <div className="km-doc-pane">
            {/* Breadcrumb */}
            <Breadcrumb folder={selectedFolder} onNavigate={setSelectedFolder} />
            {selectedFolder && nodeMap.get(selectedFolder)?.children.length ? (
              <label className="check small">
                <input type="checkbox" checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} /> Include documents in sub-folders ({nodeMap.get(selectedFolder).docCount})
              </label>
            ) : null}

            {/* Upload dropzone */}
            {canEdit ? (
              <div
                className={cx('dropzone', drag && 'is-drag')}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDrag(false);
                  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
                  const loose = entries.length ? [] : [...e.dataTransfer.files].map((file) => ({ file, folder: '' }));
                  upload([...loose, ...(await readEntries(entries))]);
                }}
              >
                <Icon name="upload" size={22} />
                <div>
                  <strong>Drop files here</strong>
                  <p className="muted small">
                    They will be placed in <em>{selectedFolder || 'root'}</em>. Word, PDF, Excel, PowerPoint, Markdown, HTML and text, up to {docs.data?.maxUploadMb ?? 50} MB each.
                  </p>
                </div>
                <div className="row">
                  {repoList.length ? (
                    <select className="input input-md" aria-label="Repository for new uploads" value={uploadRepo} onChange={(e) => setUploadRepo(e.target.value)}>
                      <option value="">No repository</option>
                      {repoList.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  ) : null}
                  <Button icon="upload" onClick={() => fileInput.current?.click()}>Choose files</Button>
                  <Button icon="knowledge" onClick={() => folderInput.current?.click()}>Choose folder</Button>
                </div>
                <input ref={fileInput} type="file" multiple hidden accept={(docs.data?.supported || []).join(',')} onChange={(e) => { upload(fromPicker(e.target.files)); e.target.value = ''; }} />
                <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden onChange={(e) => { upload(fromPicker(e.target.files)); e.target.value = ''; }} />
              </div>
            ) : null}

            {/* Upload progress */}
            {batch ? (
              <div className="upload-batch stack" role="status" aria-live="polite">
                <div className="row between small">
                  <span>{batch.done < batch.total ? `Uploading ${batch.done + 1} of ${batch.total}…` : `Uploaded ${batch.total - batch.failed.length} of ${batch.total}`}</span>
                  {batch.done >= batch.total && batch.failed.length ? (
                    <button type="button" className="linkish" onClick={() => setBatch(null)}>Dismiss</button>
                  ) : null}
                </div>
                <div className="progress" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={batch.total} aria-valuenow={batch.done}>
                  <div className="progress-bar" style={{ width: `${Math.round((100 * batch.done) / batch.total)}%` }} />
                </div>
                {batch.failed.length ? (
                  <ul className="upload-list">
                    {batch.failed.map((f, i) => (
                      <li key={i}><Badge status="error" /><span>{f.name}</span><span className="danger small">{f.error}</span></li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {/* Bulk toolbar */}
            {canEdit && movableSelected.length > 0 ? (
              <div className="km-toolbar row" role="toolbar" aria-label="Bulk document actions">
                <span className="muted small">{plural(movableSelected.length, 'selected')}</span>
                <Button size="sm" icon="knowledge" onClick={() => setMovingTo('bulk')}>Move to…</Button>
                <Button size="sm" icon="trash" onClick={async () => {
                  if (!(await confirm({ title: 'Delete documents', message: `Delete ${plural(movableSelected.length, 'document')}? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
                  for (const id of movableSelected) {
                    try { await api.del(`/api/documents/${id}`); } catch { /* continue */ }
                  }
                  setSelectedIds(new Set());
                  docs.reload(true);
                }}>Delete</Button>
                <button type="button" className="linkish small" onClick={() => setSelectedIds(new Set())}>Clear</button>
              </div>
            ) : null}

            {/* Document list */}
            {docsInFolder.length === 0 ? (
              <Empty icon="knowledge" title="No documents here">
                {canEdit ? 'Drop files above or drag documents from another folder.' : 'No documents in this folder.'}
              </Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    {canEdit ? (
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          aria-label="Select all documents"
                          checked={selectedIds.size > 0 && selectedIds.size === sortedDocs.filter((d) => d.kind === 'upload').length}
                          onChange={toggleAll}
                        />
                      </th>
                    ) : null}
                    <SortHeader col={DOC_COLUMNS[0]} sortKey={docSortKey} sortDir={docSortDir} onSort={docToggle} />
                    <SortHeader col={DOC_COLUMNS[1]} sortKey={docSortKey} sortDir={docSortDir} onSort={docToggle} />
                    {repoList.length ? <SortHeader col={DOC_COLUMNS[2]} sortKey={docSortKey} sortDir={docSortDir} onSort={docToggle} /> : null}
                    <SortHeader col={DOC_COLUMNS[3]} sortKey={docSortKey} sortDir={docSortDir} onSort={docToggle} className="num" />
                    <SortHeader col={DOC_COLUMNS[4]} sortKey={docSortKey} sortDir={docSortDir} onSort={docToggle} />
                    <SortHeader col={DOC_COLUMNS[5]} sortKey={docSortKey} sortDir={docSortDir} onSort={docToggle} />
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {sortedDocs.map((d) => (
                    <DocRow
                      key={d.id}
                      doc={d}
                      project={project}
                      showPath
                      currentFolder={selectedFolder}
                      repoList={repoList}
                      repoName={repoName}
                      canEdit={canEdit}
                      selected={selectedIds.has(d.id)}
                      onToggleSelect={() => toggleSelect(d.id)}
                      onDragStart={(e) => handleDragStart(e, d.id)}
                      onMoveDoc={(doc) => { setSelectedIds(new Set([doc.id])); setMovingTo('single'); }}
                      onRenameDoc={setRenamingDoc}
                      onSetRepo={setSettingRepo}
                      onDelete={deleteDoc}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Modals */}
      {movingTo ? (
        <FolderPickerModal
          title={movingTo === 'single' ? 'Move document to…' : `Move ${plural(movableSelected.length, 'document')} to…`}
          folders={allFolderPaths}
          currentFolder={selectedFolder}
          onPick={moveToFolder}
          onClose={() => setMovingTo(null)}
        />
      ) : null}

      {renamingDoc ? (
        <RenameDocModal
          doc={renamingDoc}
          onDone={async (newName) => {
            try {
              await api.patch(`/api/documents/${renamingDoc.id}`, { name: newName });
              announce(`Renamed to ${newName}`);
              docs.reload(true);
            } catch (e) {
              toast(e.message, 'danger');
            }
            setRenamingDoc(null);
          }}
          onClose={() => setRenamingDoc(null)}
        />
      ) : null}

      {settingRepo ? (
        <SetRepoModal
          doc={settingRepo}
          repoList={repoList}
          project={project}
          onDone={async (repoId) => {
            try {
              await api.patch(`/api/documents/${settingRepo.id}`, { repoId: repoId || null });
              docs.reload(true);
            } catch (e) {
              toast(e.message, 'danger');
            }
            setSettingRepo(null);
          }}
          onClose={() => setSettingRepo(null)}
        />
      ) : null}

      {newFolderAt !== null ? (
        <NewFolderModal
          parentPath={newFolderAt}
          existingFolders={allFolderPaths}
          onDone={(name) => { createFolder(newFolderAt, name); setNewFolderAt(null); }}
          onClose={() => setNewFolderAt(null)}
        />
      ) : null}

      {renamingFolder !== null ? (
        <RenameFolderModal
          folderPath={renamingFolder}
          existingFolders={allFolderPaths}
          onDone={(newName) => { renameFolder(renamingFolder, newName); setRenamingFolder(null); }}
          onClose={() => setRenamingFolder(null)}
        />
      ) : null}
    </div>
  );
}

/** Walk dropped files and folders (FileSystemEntry) into [{ file, folder }], keeping the folder path. */
async function readEntries(entries) {
  const out = [];
  const walk = async (entry, folder) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, folder });
      return;
    }
    const reader = entry.createReader();
    const dir = folder ? `${folder}/${entry.name}` : entry.name;
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child, dir);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
