import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { bytes, cx, plural, timeAgo } from '../lib/util.js';
import { useSortable } from '../lib/useSortable.js';
import { Icon } from '../components/Icon.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { InputCard } from '../components/InputCard.jsx';
import { SortHeader } from '../components/SortHeader.jsx';
import { Badge, Button, Empty, ErrorNote, IconButton, Modal, Note, PageHeader, Segmented, Spinner, Tabs, useUi } from '../components/ui.jsx';

export function Knowledge({ route }) {
  const { project, counts } = useProject();
  const [sub, a, b] = route.rest;
  if (sub === 'doc' && a) return <DocView docId={a} anchor={b} />;
  const tab = ['ask', 'inbox', 'decisions'].includes(sub) ? sub : 'docs';
  return (
    <div className="page">
      <PageHeader title="Knowledge" sub="Project documents agents search before they answer, and the questions they raise." />
      <Tabs
        value={tab}
        tabs={[
          { value: 'docs', label: 'Documents', href: href(project.id, 'knowledge') },
          { value: 'ask', label: 'Ask', href: href(project.id, 'knowledge', 'ask') },
          { value: 'inbox', label: 'Open questions', href: href(project.id, 'knowledge', 'inbox'), count: counts.open_questions },
          { value: 'decisions', label: 'Decisions log', href: href(project.id, 'knowledge', 'decisions') },
        ]}
      />
      {tab === 'docs' ? <Documents /> : tab === 'ask' ? <Ask /> : tab === 'inbox' ? <Inbox /> : <Decisions />}
    </div>
  );
}

/* ---------------- Folder utilities ---------------- */

/** Build a tree from a flat list of folder paths. */
function buildFolderTree(allFolders) {
  const nodeMap = new Map(); // path -> node
  const root = { path: '', name: '', children: [], docCount: 0 };
  nodeMap.set('', root);

  const ensure = (path) => {
    if (nodeMap.has(path)) return nodeMap.get(path);
    const parts = path.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent = ensure(parentPath);
    const node = { path, name, children: [], docCount: 0 };
    nodeMap.set(path, node);
    parent.children.push(node);
    return node;
  };

  for (const f of allFolders) ensure(f);

  return { root, nodeMap };
}

/** Collect all paths in folder tree (including nested) for counting. */
function allSubPaths(folderPath) {
  // Returns true if docFolder equals folderPath OR is a child of it.
  return (docFolder) => {
    if (docFolder === folderPath) return true;
    if (folderPath === '') return true; // root shows all
    return docFolder.startsWith(folderPath + '/');
  };
}

/* ---------------- Documents (file manager) ---------------- */

const TYPE_LABEL = { '.md': 'Markdown', '.markdown': 'Markdown', '.txt': 'Text', '.pdf': 'PDF', '.docx': 'Word', '.xlsx': 'Excel', '.pptx': 'PowerPoint', '.html': 'HTML', '.htm': 'HTML', '.csv': 'CSV', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.odt': 'OpenDocument', '.rtf': 'RTF', '.epub': 'EPUB' };

function Documents() {
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

/* --- Search bar (always visible above the file manager) --- */
function SearchBar({ q, setQ, projectId: _pid }) {
  return (
    <div className="searchbar">
      <Icon name="search" />
      <input
        className="input"
        type="search"
        placeholder="Search all documents and decisions"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search documents"
      />
    </div>
  );
}

/* --- Breadcrumb --- */
function Breadcrumb({ folder, onNavigate }) {
  if (!folder) return (
    <nav className="km-breadcrumb" aria-label="Folder path">
      <span className="km-crumb-current" aria-current="page">All documents</span>
    </nav>
  );
  const parts = folder.split('/');
  return (
    <nav className="km-breadcrumb" aria-label="Folder path">
      <button type="button" className="linkish small" onClick={() => onNavigate('')}>All documents</button>
      {parts.map((part, i) => {
        const path = parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;
        return (
          <Fragment key={path}>
            <span className="muted" aria-hidden="true"> / </span>
            {isLast ? (
              <span className="km-crumb-current" aria-current="page">{part}</span>
            ) : (
              <button type="button" className="linkish small" onClick={() => onNavigate(path)}>{part}</button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/* --- Folder tree (role=tree) --- */
function FolderTree({ root, selectedFolder, onSelect, dropTarget, onDragOver, onDragLeave, onDrop, onNewFolder, onRename, onDelete }) {
  const treeRef = useRef(null);
  // Keyboard navigation: track focused path.
  const [focusedPath, setFocusedPath] = useState('');
  // Track expanded nodes. Folders start open (up to a limit) so nothing hides behind a small arrow.
  const [expanded, setExpanded] = useState(new Set(['']));
  const known = useRef(new Set());
  const branchPaths = useMemo(() => {
    const out = [];
    const walk = (n) => {
      if (n.children.length) {
        out.push(n.path);
        n.children.forEach(walk);
      }
    };
    walk(root);
    return out;
  }, [root]);
  // Open every folder the first time it is seen (new ones appear after an upload); folders the user closes stay closed.
  useEffect(() => {
    const fresh = branchPaths.filter((p) => !known.current.has(p));
    if (!fresh.length) return;
    fresh.forEach((p) => known.current.add(p));
    if (branchPaths.length <= 60) setExpanded((cur) => new Set([...cur, ...fresh]));
  }, [branchPaths]);
  // Keep the selected folder visible: open every folder above it.
  useEffect(() => {
    if (!selectedFolder) return;
    const parts = selectedFolder.split('/');
    setExpanded((s) => {
      const n = new Set(s);
      for (let i = 1; i < parts.length; i++) n.add(parts.slice(0, i).join('/'));
      return n.size === s.size ? s : n;
    });
  }, [selectedFolder]);

  const toggleExpand = (path, e) => {
    e?.stopPropagation();
    setExpanded((s) => {
      const n = new Set(s);
      n.has(path) ? n.delete(path) : n.add(path);
      return n;
    });
  };

  // Build a flat ordered list of visible nodes for arrow-key nav.
  const flatList = useMemo(() => {
    const list = [];
    const walk = (node, depth) => {
      list.push({ node, depth });
      if (expanded.has(node.path) && node.children.length) {
        const sorted = [...node.children].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        for (const child of sorted) walk(child, depth + 1);
      }
    };
    walk(root, 0);
    return list;
  }, [root, expanded]);

  const handleKeyDown = (e) => {
    const idx = flatList.findIndex((x) => x.node.path === focusedPath);
    if (idx < 0) return;
    const node = flatList[idx].node;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (idx < flatList.length - 1) setFocusedPath(flatList[idx + 1].node.path);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (idx > 0) setFocusedPath(flatList[idx - 1].node.path);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (node.children.length) {
          if (!expanded.has(node.path)) toggleExpand(node.path);
          else if (idx < flatList.length - 1 && flatList[idx + 1].node.path.startsWith(node.path)) {
            setFocusedPath(flatList[idx + 1].node.path);
          }
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (expanded.has(node.path) && node.children.length) {
          toggleExpand(node.path);
        } else {
          // Move to parent.
          const parts = node.path.split('/');
          if (parts.length > 1) setFocusedPath(parts.slice(0, -1).join('/'));
          else if (node.path) setFocusedPath('');
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(node.path);
        break;
      default:
        break;
    }
  };

  // Sync focus to DOM.
  useEffect(() => {
    const el = treeRef.current?.querySelector(`[data-tree-path="${CSS.escape(focusedPath)}"]`);
    if (el) el.focus();
  }, [focusedPath]);

  const renderNode = (node, depth) => {
    const isRoot = node.path === '';
    const sorted = [...node.children].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const isExpanded = expanded.has(node.path);
    const isSelected = selectedFolder === node.path;
    const isDropTarget = dropTarget === node.path;

    return (
      <li
        key={node.path}
        role="treeitem"
        aria-expanded={node.children.length > 0 ? isExpanded : undefined}
        aria-selected={isSelected}
        aria-label={isRoot ? `Root — ${node.docCount} documents` : `${node.name} — ${node.docCount} documents`}
      >
        <div
          className={cx('km-tree-item', isSelected && 'is-selected', isDropTarget && 'is-drop-target')}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onDragOver={onDragOver ? (e) => onDragOver(e, node.path) : undefined}
          onDragLeave={onDragLeave}
          onDrop={onDrop ? (e) => onDrop(e, node.path) : undefined}
        >
          {/* Expand toggle (only for nodes with children). */}
          <button
            type="button"
            className="km-tree-btn"
            data-tree-path={node.path}
            tabIndex={focusedPath === node.path ? 0 : -1}
            onClick={() => { onSelect(node.path); setFocusedPath(node.path); if (node.children.length && !isExpanded) toggleExpand(node.path); }}
            onFocus={() => setFocusedPath(node.path)}
          >
            {node.children.length > 0 ? (
              <span
                className="km-tree-chevron"
                aria-hidden="true"
                onClick={(e) => toggleExpand(node.path, e)}
              >
                {isExpanded ? '▾' : '▸'}
              </span>
            ) : (
              <span className="km-tree-chevron-placeholder" aria-hidden="true" />
            )}
            <Icon name={isRoot ? 'knowledge' : 'projects'} size={15} />
            <span className="km-tree-label">{isRoot ? 'All documents' : node.name}</span>
            {node.docCount > 0 ? <span className="km-tree-count" aria-hidden="true">{node.docCount}</span> : null}
          </button>

          {/* Folder actions (editor only). */}
          {!isRoot ? (
            <FolderMenu
              path={node.path}
              onNewFolder={onNewFolder}
              onRename={onRename}
              onDelete={onDelete}
            />
          ) : onNewFolder ? (
            <IconButton icon="plus" label={`New sub-folder in root`} className="km-tree-action" onClick={() => onNewFolder('')} />
          ) : null}
        </div>

        {/* Children. */}
        {node.children.length > 0 && isExpanded ? (
          <ul role="group">
            {sorted.map((child) => renderNode(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <>
      {branchPaths.length ? (
        <div className="km-tree-tools">
          <button type="button" className="linkish small" onClick={() => setExpanded(new Set(['', ...branchPaths]))}>
            Expand all
          </button>
          <button type="button" className="linkish small" onClick={() => setExpanded(new Set(['']))}>
            Collapse all
          </button>
        </div>
      ) : null}
      <ul
        role="tree"
        aria-label="Folder tree"
        className="km-tree"
        ref={treeRef}
        onKeyDown={handleKeyDown}
      >
        {renderNode(root, 0)}
      </ul>
    </>
  );
}

/* --- Folder kebab menu --- */
function FolderMenu({ path, onNewFolder, onRename, onDelete }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const shut = () => setOpen(false);
    document.addEventListener('mousedown', close);
    // The menu is placed with fixed coordinates so the tree's scroll box cannot clip it; move or close it with the page.
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
    };
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation();
    if (!open) {
      const r = e.currentTarget.getBoundingClientRect();
      // Open below the button, right-aligned to it, and flip upward near the bottom of the window.
      const left = Math.max(8, Math.min(r.right - 180, window.innerWidth - 188));
      const top = r.bottom + 4 + 120 > window.innerHeight ? Math.max(8, r.top - 4 - 112) : r.bottom + 4;
      setPos({ top, left });
    }
    setOpen((v) => !v);
  };

  if (!onNewFolder && !onRename && !onDelete) return null;

  return (
    <div className="km-folder-menu" ref={ref}>
      <IconButton
        icon="chevronDown"
        label={`Folder options for ${path}`}
        className="km-tree-action"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
      />
      {open ? (
        <ul className="km-folder-dropdown" role="menu" style={{ top: pos.top, left: pos.left }} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          {onNewFolder ? (
            <li role="none">
              <button type="button" role="menuitem" className="km-dropdown-item" onClick={() => { setOpen(false); onNewFolder(path); }}>
                <Icon name="plus" size={14} /> New sub-folder
              </button>
            </li>
          ) : null}
          {onRename ? (
            <li role="none">
              <button type="button" role="menuitem" className="km-dropdown-item" onClick={() => { setOpen(false); onRename(path); }}>
                <Icon name="edit" size={14} /> Rename
              </button>
            </li>
          ) : null}
          {onDelete ? (
            <li role="none">
              <button type="button" role="menuitem" className="km-dropdown-item km-dropdown-danger" onClick={() => { setOpen(false); onDelete(path); }}>
                <Icon name="trash" size={14} /> Delete folder
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** The deepest folder that contains every path ("a/b/c" and "a/b/d" give "a/b"). */
function commonFolder(paths) {
  const parts = paths.map((p) => (p ? p.split('/') : []));
  if (!parts.length) return '';
  let i = 0;
  while (parts.every((p) => p[i] !== undefined && p[i] === parts[0][i])) i++;
  return parts[0].slice(0, i).join('/');
}

/* --- Single document row --- */
function DocRow({ doc: d, project, repoList, repoName, canEdit, showPath, currentFolder, selected, onToggleSelect, onDragStart, onMoveDoc, onRenameDoc, onSetRepo, onDelete }) {
  return (
    <tr
      className={cx('doc-row', selected && 'is-selected')}
      draggable={canEdit && d.kind === 'upload'}
      onDragStart={canEdit ? (e) => onDragStart(e) : undefined}
    >
      {canEdit ? (
        <td>
          {d.kind === 'upload' ? (
            <input
              type="checkbox"
              aria-label={`Select ${d.name}`}
              checked={selected}
              onChange={onToggleSelect}
            />
          ) : <span />}
        </td>
      ) : null}
      <td>
        <a href={href(project.id, 'knowledge', 'doc', d.id)} className="strong-link">
          {d.name}
        </a>
        {d.kind === 'decisions' ? <span className="muted small"> built in</span> : null}
        {d.kind === 'upload' && showPath && (d.folder || '') !== currentFolder ? <div className="muted small mono">{d.folder || 'root'}</div> : null}
        {d.error ? <div className="danger small">{d.error}</div> : null}
      </td>
      <td className="muted">{d.kind === 'decisions' ? 'Log' : TYPE_LABEL[d.mime] || d.mime}{d.size ? `, ${bytes(d.size)}` : ''}</td>
      {repoList.length ? (
        <td>
          {d.kind !== 'upload' ? (
            <span className="muted">—</span>
          ) : canEdit ? (
            <button type="button" className="linkish small" onClick={() => onSetRepo(d)}>
              {repoName(d.repo_id) || <span className="muted">None</span>}
            </button>
          ) : (
            <span className="muted">{repoName(d.repo_id) || '—'}</span>
          )}
        </td>
      ) : null}
      <td className="num">{d.sections_count}</td>
      <td><Badge status={d.status} /></td>
      <td className="muted">{timeAgo(d.updated_at)}</td>
      <td className="actions">
        {d.kind === 'upload' ? (
          <>
            <a className="icon-btn" href={`/api/documents/${d.id}/original`} aria-label={`Download ${d.name}`} title="Download original">
              <Icon name="download" size={17} />
            </a>
            {canEdit ? (
              <>
                <IconButton icon="knowledge" label={`Move ${d.name}`} onClick={() => onMoveDoc(d)} title="Move to folder" />
                <IconButton icon="edit" label={`Rename ${d.name}`} onClick={() => onRenameDoc(d)} />
                <IconButton icon="trash" label={`Delete ${d.name}`} onClick={() => onDelete(d)} />
              </>
            ) : null}
          </>
        ) : null}
      </td>
    </tr>
  );
}

/* --- Modals --- */

function FolderPickerModal({ title, folders, currentFolder, onPick, onClose }) {
  const [selected, setSelected] = useState(currentFolder);
  const allChoices = useMemo(() => {
    const set = new Set(['', ...folders]);
    return [...set].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, undefined, { sensitivity: 'base' })));
  }, [folders]);

  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onPick(selected)}>Move here</Button>
      </>
    }>
      <p className="muted small">Select a destination folder:</p>
      <ul className="km-folder-pick-list" role="listbox" aria-label="Destination folders">
        {allChoices.map((f) => (
          <li key={f || '__root__'} role="option" aria-selected={selected === f}>
            <button
              type="button"
              className={cx('km-folder-pick-item', selected === f && 'is-selected')}
              onClick={() => setSelected(f)}
            >
              <Icon name={f ? 'projects' : 'knowledge'} size={14} />
              <span>{f || 'Root (no folder)'}</span>
              {selected === f ? <Icon name="check" size={14} className="push" /> : null}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function RenameDocModal({ doc, onDone, onClose }) {
  const [name, setName] = useState(doc.name);
  return (
    <Modal title="Rename document" onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!name.trim() || name.trim() === doc.name} onClick={() => onDone(name.trim())}>Rename</Button>
      </>
    }>
      <div className="field">
        <label className="field-label" htmlFor="rename-doc-input">New name</label>
        <input id="rename-doc-input" className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onDone(name.trim()); }} autoFocus />
      </div>
    </Modal>
  );
}

function SetRepoModal({ doc, repoList, project: _project, onDone, onClose }) {
  const [repoId, setRepoId] = useState(doc.repo_id || '');
  return (
    <Modal title={`Repository for "${doc.name}"`} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onDone(repoId)}>Save</Button>
      </>
    }>
      <div className="field">
        <label className="field-label" htmlFor="set-repo-select">Repository</label>
        <select id="set-repo-select" className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          <option value="">None</option>
          {repoList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
    </Modal>
  );
}

function NewFolderModal({ parentPath, existingFolders, onDone, onClose }) {
  const [name, setName] = useState('');
  const full = cleanFolderPath(parentPath ? `${parentPath}/${name.trim()}` : name.trim());
  const exists = existingFolders.includes(full);
  const invalid = !name.trim() || exists;
  return (
    <Modal title={`New folder${parentPath ? ` in "${parentPath}"` : ''}`} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={invalid} onClick={() => !invalid && onDone(name.trim())}>Create</Button>
      </>
    }>
      <div className="field">
        <label className="field-label" htmlFor="new-folder-input">Folder name</label>
        <input id="new-folder-input" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. API specs"
          onKeyDown={(e) => { if (e.key === 'Enter' && !invalid) onDone(name.trim()); }}
          aria-invalid={exists || undefined}
          aria-describedby={exists ? 'new-folder-err' : undefined}
        />
        {exists ? <p className="field-error" id="new-folder-err" role="alert">A folder with that name already exists</p> : null}
      </div>
    </Modal>
  );
}

function RenameFolderModal({ folderPath, existingFolders, onDone, onClose }) {
  const parts = folderPath.split('/');
  const [name, setName] = useState(parts[parts.length - 1]);
  const newParts = [...parts.slice(0, -1), name.trim()];
  const full = cleanFolderPath(newParts.join('/'));
  const unchanged = name.trim() === parts[parts.length - 1];
  const exists = !unchanged && existingFolders.includes(full);
  const invalid = !name.trim() || exists;
  return (
    <Modal title={`Rename "${parts[parts.length - 1]}"`} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={invalid || unchanged} onClick={() => !invalid && onDone(name.trim())}>Rename</Button>
      </>
    }>
      <div className="field">
        <label className="field-label" htmlFor="rename-folder-input">New name</label>
        <input id="rename-folder-input" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && !invalid && !unchanged) onDone(name.trim()); }}
          aria-invalid={exists || undefined}
          aria-describedby={exists ? 'rename-folder-err' : undefined}
        />
        {exists ? <p className="field-error" id="rename-folder-err" role="alert">A folder with that name already exists</p> : null}
      </div>
    </Modal>
  );
}

/* Normalise a folder path the same way the server does. */
function cleanFolderPath(raw) {
  return raw
    .replace(/[\u0000-\u001f]/g, '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
    .slice(0, 200);
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

/* ---------------- Highlight (used in search) ---------------- */

export function Highlight({ text, start, end }) {
  const parts = [];
  let rest = text || '';
  let i = 0;
  while (rest.length) {
    const a = rest.indexOf(start);
    if (a < 0) { parts.push(<Fragment key={i++}>{rest}</Fragment>); break; }
    const b = rest.indexOf(end, a);
    if (a > 0) parts.push(<Fragment key={i++}>{rest.slice(0, a)}</Fragment>);
    parts.push(<mark key={i++}>{rest.slice(a + start.length, b < 0 ? undefined : b)}</mark>);
    rest = b < 0 ? '' : rest.slice(b + end.length);
  }
  return <>{parts}</>;
}

function SearchResults({ hits, projectId, onClear }) {
  return (
    <div className="stack-lg">
      <div className="row between">
        <span className="muted small">{hits.hits.length ? `${hits.hits.length} result${hits.hits.length !== 1 ? 's' : ''}` : 'Nothing found'}</span>
        <button type="button" className="linkish small" onClick={onClear}>← Back to file manager</button>
      </div>
      {!hits.hits.length ? <Empty icon="search" title="Nothing found">Try fewer or different words.</Empty> : (
        <ol className="results">
          {hits.hits.map((h) => (
            <li key={h.sectionId}>
              <a href={href(projectId, 'knowledge', 'doc', h.docId, h.anchor)}>
                <span className="muted small">{h.docName}</span>
                <strong>{h.heading}</strong>
              </a>
              <p><Highlight text={h.snippet} start={hits.markStart} end={hits.markEnd} /></p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ---------------- Document viewer ---------------- */

function DocView({ docId, anchor }) {
  const { project, canEdit } = useProject();
  const { toast } = useUi();
  const doc = useLoad(() => api.get(`/api/documents/${docId}`), [docId]);
  useProjectEvents(['document.updated'], (_e, d) => d?.id === docId && doc.reload(true));
  const [reindexing, setReindexing] = useState(false);
  useEffect(() => {
    if (!doc.data || !anchor) return;
    const t = setTimeout(() => document.getElementById(`sec-${anchor}`)?.scrollIntoView({ block: 'start' }), 50);
    return () => clearTimeout(t);
  }, [doc.data, anchor]);
  if (doc.error) return <div className="page"><ErrorNote error={doc.error} /></div>;
  if (!doc.data) return <div className="page"><Spinner /></div>;
  const d = doc.data.document;
  return (
    <div className="page">
      <a className="back" href={href(project.id, 'knowledge')}>← All documents</a>
      <PageHeader
        title={d.name}
        sub={`${plural(d.sections_count, 'section')}, updated ${timeAgo(d.updated_at)}. Agents read the Markdown version shown here.`}
        actions={
          <>
            {d.kind === 'upload' ? (
              <a className="btn btn-default" href={`/api/documents/${d.id}/original`}>
                <Icon name="download" size={17} /><span>Original</span>
              </a>
            ) : null}
            {canEdit ? (
              <Button icon="refresh" busy={reindexing} onClick={async () => {
                setReindexing(true);
                try {
                  await api.post(`/api/documents/${d.id}/reindex`);
                  toast('Converted and indexed again');
                  doc.reload(true);
                } catch (e) {
                  toast(e.message, 'danger');
                } finally {
                  setReindexing(false);
                }
              }}>Convert again</Button>
            ) : null}
          </>
        }
      />
      {d.error ? <ErrorNote error={new Error(d.error)} /> : null}
      <div className="doc-layout">
        <nav className="doc-outline" aria-label="Sections">
          <ol>
            {doc.data.sections.map((s) => (
              <li key={s.id} className={cx(`lvl-${s.level}`, s.anchor === anchor && 'is-active')}>
                <a href={href(project.id, 'knowledge', 'doc', d.id, s.anchor)}>{s.heading}</a>
              </li>
            ))}
          </ol>
        </nav>
        <article className="doc-body"><Markdown text={doc.data.markdown} /></article>
      </div>
    </div>
  );
}

/* ---------------- Ask ---------------- */

function Ask() {
  const { project } = useProject();
  const { toast } = useUi();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [inboxQ, setInboxQ] = useState('');
  const [sent, setSent] = useState(false);
  const history = useLoad(() => api.get(`/api/projects/${project.id}/qa`), [project.id]);

  const ask = async (e) => {
    e?.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      const r = await api.post(`/api/projects/${project.id}/ask`, { question });
      setAnswer({ ...r, question });
      setInboxQ(r.suggestedQuestion || question);
      history.reload(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const citeTransform = useCallback((t) => t.replace(/\[(\d{1,2})\]/g, (_m, n) => `<sup class="cite" data-n="${n}"><a href="#">${n}</a></sup>`), []);
  const [focusN, setFocusN] = useState(null);

  return (
    <div className="ask-layout">
      <div className="stack-lg">
        <form className="ask-box" onSubmit={ask}>
          <label htmlFor="ask-q" className="field-label">Ask anything about this project</label>
          <textarea id="ask-q" className="input" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Who has to approve a refund above 500 USD?"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(); }} />
          <div className="row">
            <Button variant="primary" type="submit" busy={busy} disabled={!question.trim()}>Ask</Button>
            <span className="muted small">Answers come only from the project documents and decisions, with sources.</span>
          </div>
        </form>
        <ErrorNote error={error} />
        {answer ? (
          <section className="answer">
            <Markdown text={answer.answer} transform={citeTransform} onCite={setFocusN} />
            {answer.sources.length ? (
              <ol className="sources">
                {answer.sources.map((s) => (
                  <li key={s.n} className={cx(s.cited && 'is-cited', focusN === s.n && 'is-focus')}>
                    <span className="src-n">{s.n}</span>
                    <a href={href(project.id, 'knowledge', 'doc', s.docId, s.anchor)}>{s.docName} › {s.heading}</a>
                  </li>
                ))}
              </ol>
            ) : null}
            {answer.missing ? (
              <Note tone="warn" icon="question">
                <p><strong>The documents don't answer this yet.</strong> Send it to the team as an open question; the answer goes into the decisions log, so agents and future answers can use it.</p>
                <div className="row">
                  <input className="input" value={inboxQ} onChange={(e) => setInboxQ(e.target.value)} aria-label="Question for the team" />
                  <Button disabled={sent || !inboxQ.trim()} onClick={async () => {
                    try {
                      await api.post(`/api/projects/${project.id}/inbox`, { question: inboxQ });
                      setSent(true);
                      toast('Sent to open questions');
                    } catch (e) {
                      toast(e.message, 'danger');
                    }
                  }}>{sent ? 'Sent' : 'Ask the team'}</Button>
                </div>
              </Note>
            ) : null}
          </section>
        ) : null}
      </div>
      <aside className="side">
        <h2 className="side-title">Recent questions</h2>
        {history.data?.history?.length ? (
          <ul className="plain-list">
            {history.data.history.map((h) => (
              <li key={h.id}>
                <button type="button" className="linkish" onClick={() => setQuestion(h.meta?.question || h.title.replace(/^Question: /, ''))}>
                  {h.meta?.question || h.title}
                </button>
                <span className="muted small">{h.asked_by}, {timeAgo(h.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Questions people ask show up here.</p>
        )}
      </aside>
    </div>
  );
}

/* ---------------- Open questions ---------------- */

export function Inbox() {
  const { project, canEdit } = useProject();
  const [filter, setFilter] = useState('pending');
  const inputs = useLoad(() => api.get(`/api/projects/${project.id}/inputs?type=question&status=${filter === 'pending' ? 'pending' : 'all'}`), [project.id, filter]);
  useProjectEvents(['input.created', 'input.resolved'], () => inputs.reload(true));
  const { toast } = useUi();
  const list = inputs.data?.inputs || [];
  return (
    <div className="stack-lg">
      <div className="row between">
        <p className="muted">Questions agents asked during runs, and questions people sent from Ask. Answers go into the decisions log.</p>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'pending', label: 'Open' }, { value: 'all', label: 'All' }]} label="Filter" />
      </div>
      {inputs.loading && !inputs.data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty icon="inbox" title={filter === 'pending' ? 'No open questions' : 'Nothing here yet'}>
          When an agent is unsure, it asks here instead of guessing.
        </Empty>
      ) : (
        <div className="stack">
          {list.map((i) => (
            <div key={i.id} className="inbox-item">
              <InputCard input={i} projectId={project.id} canApprove={canEdit} onDone={() => inputs.reload(true)} />
              {i.status === 'pending' && !i.run_id && canEdit ? (
                <Button variant="ghost" size="sm" onClick={async () => {
                  await api.post(`/api/inputs/${i.id}/dismiss`);
                  toast('Question dismissed');
                  inputs.reload(true);
                }}>Dismiss</Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Decisions ---------------- */

function Decisions() {
  const { project } = useProject();
  const docs = useLoad(() => api.get(`/api/projects/${project.id}/documents`), [project.id]);
  const decisionsDoc = useMemo(() => docs.data?.documents.find((d) => d.kind === 'decisions'), [docs.data]);
  const doc = useLoad(() => (decisionsDoc ? api.get(`/api/documents/${decisionsDoc.id}`) : Promise.resolve(null)), [decisionsDoc?.id, decisionsDoc?.updated_at]);
  useProjectEvents(['document.updated'], () => docs.reload(true));
  if (!doc.data) return <Spinner />;
  return (
    <div className="doc-body narrow-doc">
      <Markdown text={doc.data.markdown} />
    </div>
  );
}
