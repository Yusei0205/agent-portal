import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { Button, IconButton, Modal } from '../../components/ui.jsx';

/* ---------------- Folder utilities ---------------- */

/** Build a tree from a flat list of folder paths. */
export function buildFolderTree(allFolders) {
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

/* --- Breadcrumb --- */
export function Breadcrumb({ folder, onNavigate }) {
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
export function FolderTree({ root, selectedFolder, onSelect, dropTarget, onDragOver, onDragLeave, onDrop, onNewFolder, onRename, onDelete }) {
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
export function commonFolder(paths) {
  const parts = paths.map((p) => (p ? p.split('/') : []));
  if (!parts.length) return '';
  let i = 0;
  while (parts.every((p) => p[i] !== undefined && p[i] === parts[0][i])) i++;
  return parts[0].slice(0, i).join('/');
}

/* --- Modals --- */

export function FolderPickerModal({ title, folders, currentFolder, onPick, onClose }) {
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

export function NewFolderModal({ parentPath, existingFolders, onDone, onClose }) {
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

export function RenameFolderModal({ folderPath, existingFolders, onDone, onClose }) {
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
export function cleanFolderPath(raw) {
  return raw
    .replace(/[\u0000-\u001f]/g, '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
    .slice(0, 200);
}
