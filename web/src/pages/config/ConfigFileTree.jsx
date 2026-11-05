/**
 * Config folder file tree with inline actions.
 * Supports: root folder node, expand/collapse dirs, new file, new folder,
 *           rename, delete, and a "starter structure" offer for empty trees.
 *
 * Accessibility:
 *  - role="tree" on the container, role="treeitem" on every row
 *  - aria-expanded on directory nodes, aria-level from depth
 *  - Roving tabindex: focused item gets tabIndex=0, others -1
 *  - Arrow keys (Up/Down/Left/Right), Enter/Space to open/close or select
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../../components/Toast.jsx';
import { agentPackFiles, PACK_AGENTS, PACK_SKILLS } from '../../lib/agent-pack/index.js';

// ── Starter file definitions ───────────────────────────────────────────────────

const CODEX_STARTER = [
  { path: 'AGENTS.md', content: '# Codex instructions\n\nDescribe your team conventions and project guidance here.\n' },
  { path: 'config.toml', content: '# Reasoning and response preferences\nmodel_reasoning_effort = "medium"\n' },
  { path: 'agents/example-agent.toml', content: 'name = "example-agent"\ndescription = "A focused assistant for your project."\ndeveloper_instructions = "Read the project instructions and complete the assigned task within the workspace."\n' },
  { path: 'skills/example/SKILL.md', content: '---\nname: example\ndescription: A reusable workflow for your project tasks.\n---\n\nWrite the workflow instructions here.\n' },
];
const KIRO_STARTER = [
  {
    path: 'agents/example-agent.json',
    content: JSON.stringify(
      {
        name: 'example-agent',
        description:
          'An example Kiro agent. Edit this to define the agent\'s role and specialisation.',
        prompt:
          'You are a helpful assistant. Edit this system prompt to define the agent\'s behaviour.',
        tools: ['read', 'write', 'shell', 'code', 'grep'],
        allowedTools: ['read', 'grep', 'code'],
      },
      null,
      2,
    ),
  },
  {
    path: 'skills/README.md',
    content:
      '# Skills\n\nPlace Kiro skill folders here. Each skill lives in its own subfolder and is loaded into sessions automatically.\n',
  },
  {
    path: 'steering/project.md',
    content:
      '# Project steering\n\nThis steering file is loaded by Kiro at the start of every session.\nUse it to encode team conventions, architecture decisions, or domain knowledge.\n',
  },
  {
    path: 'hooks/README.md',
    content:
      '# Hooks\n\nPlace Kiro hook configuration files here. Hooks automate actions triggered by session events.\nSee the Kiro CLI docs for the supported hook format.\n',
  },
  {
    path: 'settings/mcp.json',
    content: JSON.stringify({ mcpServers: {} }, null, 2),
  },
];

const CLAUDE_STARTER = [
  {
    path: 'CLAUDE.md',
    content:
      '# Project instructions\n\nThis file is loaded by Claude Code at the start of every session.\nUse it to provide project context, coding conventions, or other instructions.\n',
  },
  {
    path: 'settings.json',
    content: '{}',
  },
  {
    path: 'agents/example-subagent.md',
    content: [
      '---',
      'name: example-subagent',
      'description: >-',
      '  An example subagent. Replace this with a specific task description so',
      '  Claude knows when to delegate to it automatically.',
      'tools: Read, Grep, Glob',
      '---',
      '',
      'You are a focused assistant. Edit this system prompt to define the subagent\'s',
      'specialisation and behaviour.',
      '',
    ].join('\n'),
  },
  {
    path: 'skills/example/SKILL.md',
    content: [
      '---',
      'name: example-skill',
      'description: An example Claude Code skill. Replace this with a description of the capability.',
      '---',
      '',
      '# Example Skill',
      '',
      'Describe the capability this skill provides. Skills are loaded on demand and',
      'extend Claude\'s knowledge or behaviour for specific tasks.',
      '',
    ].join('\n'),
  },
  {
    path: 'commands/README.md',
    content:
      '# Custom slash commands\n\nPlace custom slash command Markdown files here. Each `.md` file becomes a `/command-name` available in Claude Code sessions.\n',
  },
  {
    path: 'hooks/README.md',
    content:
      '# Hooks\n\nPlace Claude Code hook configuration files here. Hooks automate actions triggered by session events.\n',
  },
];

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   folder: string,
 *   selectedPath: string|null,
 *   onSelectFile: (path: string) => void,
 *   onTreeChange: () => void,
 *   following: boolean,
 *   requestNewFile?: boolean,
 *   onNewFileRequestHandled?: () => void,
 * }} props
 */
export function ConfigFileTree({
  folder,
  selectedPath,
  onSelectFile,
  onTreeChange,
  following,
  requestNewFile,
  onNewFileRequestHandled,
}) {
  const [entries, setEntries] = useState([]);
  const [expandedDirs, setExpandedDirs] = useState(new Set());
  const [dirEntries, setDirEntries] = useState({}); // path → entries[]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [renamingPath, setRenamingPath] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [focusedPath, setFocusedPath] = useState(null); // for roving tabindex
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [addingStarter, setAddingStarter] = useState(false);
  const [addingPack, setAddingPack] = useState(false);
  const renameRef = useRef(null);
  const newFileRef = useRef(null);
  const newFolderRef = useRef(null);
  const treeRef = useRef(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const loadDir = async (path = '') => {
    try {
      const encodedPath = path ? `?path=${encodeURIComponent(path)}` : '';
      const { entries: es } = await api.get(`/api/user-config/${folder}/tree${encodedPath}`);
      return es || [];
    } catch {
      return [];
    }
  };

  const loadRoot = async () => {
    setLoading(true);
    setError(null);
    try {
      const { entries: es } = await api.get(`/api/user-config/${folder}/tree`);
      setEntries(es || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRoot(); }, [folder]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (renamingPath) renameRef.current?.focus();
  }, [renamingPath]);

  // Honour external "show new file" requests (e.g. from the editor's empty state button).
  useEffect(() => {
    if (requestNewFile) {
      setShowNewFile(true);
      setShowNewFolder(false);
      onNewFileRequestHandled?.();
    }
  }, [requestNewFile, onNewFileRequestHandled]);

  const toggleDir = async (path) => {
    if (expandedDirs.has(path)) {
      setExpandedDirs((s) => { const n = new Set(s); n.delete(path); return n; });
    } else {
      setExpandedDirs((s) => new Set([...s, path]));
      if (!dirEntries[path]) {
        const es = await loadDir(path);
        setDirEntries((d) => ({ ...d, [path]: es }));
      }
    }
  };

  const handleNewFile = async (e) => {
    e.preventDefault();
    if (!newFileName.trim()) return;
    const path = newFileName.trim();
    try {
      await api.post(`/api/user-config/${folder}/file`, { path, content: '' });
      setNewFileName('');
      setShowNewFile(false);
      await loadRoot();
      onSelectFile(path);
      onTreeChange();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const handleNewFolder = async (e) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      await api.post(`/api/user-config/${folder}/folder`, { path: newFolderName.trim() });
      setNewFolderName('');
      setShowNewFolder(false);
      await loadRoot();
      onTreeChange();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const handleDelete = async (entry) => {
    if (!await requestConfirm(`Delete "${entry.name}"?`, 'Delete', 'danger')) return;
    try {
      const encodedPath = encodeURIComponent(entry.path);
      if (entry.type === 'file') {
        await api.delete(`/api/user-config/${folder}/file?path=${encodedPath}`);
      } else {
        await api.delete(`/api/user-config/${folder}/folder?path=${encodedPath}`);
      }
      await loadRoot();
      if (selectedPath === entry.path) onSelectFile(null);
      onTreeChange();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const startRename = (entry) => {
    setRenamingPath(entry.path);
    setRenameValue(entry.name);
  };

  const commitRename = async (entry) => {
    const from = entry.path;
    const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/') + 1) : '';
    const to = dir + renameValue.trim();
    if (to === from || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    try {
      await api.patch(`/api/user-config/${folder}/rename`, { from, to });
      setRenamingPath(null);
      await loadRoot();
      if (selectedPath === from) onSelectFile(to);
      onTreeChange();
    } catch (e) {
      toast(e.message, 'error');
      setRenamingPath(null);
    }
  };

  // ── Starter structure ──────────────────────────────────────────────────────

  const handleAddStarter = async () => {
    const starterFiles = folder === 'kiro' ? KIRO_STARTER : folder === 'claude' ? CLAUDE_STARTER : folder === 'codex' ? CODEX_STARTER : null;
    if (!starterFiles) return;

    setAddingStarter(true);
    let firstFile = null;
    for (const { path, content } of starterFiles) {
      try {
        await api.post(`/api/user-config/${folder}/file`, { path, content });
        if (!firstFile) firstFile = path;
      } catch (e) {
        // 409 = already exists — skip silently; other errors are reported
        if (!(e instanceof ApiError && e.status === 409)) {
          toast(`Could not create ${path}: ${e.message}`, 'error');
        }
      }
    }
    await loadRoot();
    onTreeChange();
    if (firstFile) onSelectFile(firstFile);
    setAddingStarter(false);
  };

  // ── Agent pack: a lead agent, specialists and their skills ─────────────────

  const handleAddPack = async () => {
    const files = agentPackFiles(folder);
    if (!files) return;
    const ok = await requestConfirm(
      `Add the agent pack to .${folder}? It adds ${PACK_AGENTS.length} agents (${PACK_AGENTS.map((a) => a.name).join(', ')}) `
      + `and ${PACK_SKILLS.length} skills. Files you already have are kept as they are.`,
      'Add agent pack',
    );
    if (!ok) return;
    setAddingPack(true);
    let added = 0;
    let kept = 0;
    let failed = 0;
    for (const { path, content } of files) {
      try {
        await api.post(`/api/user-config/${folder}/file`, { path, content });
        added++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) kept++;
        else { failed++; toast(`Could not create ${path}: ${e.message}`, 'error'); }
      }
    }
    await loadRoot();
    onTreeChange();
    if (added) onSelectFile(folder === 'kiro' ? 'agents/lead-orchestrator.json' : folder === 'codex' ? 'agents/lead-orchestrator.toml' : 'agents/lead-orchestrator.md');
    setAddingPack(false);
    toast(
      `Agent pack: ${added} file${added === 1 ? '' : 's'} added`
      + (kept ? `, ${kept} you already had kept` : '')
      + (failed ? `, ${failed} failed` : '')
      + '. Pick an agent under Lead agent when you start a session.',
      failed ? 'error' : 'ok',
      8000,
    );
  };

  // ── Keyboard navigation ────────────────────────────────────────────────────

  const handleTreeKeyDown = useCallback((e) => {
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
      const path = next.getAttribute('data-path');
      if (path) setFocusedPath(path);
    } else {
      e.preventDefault();
      const prev = treeitems[idx - 1] ?? treeitems[treeitems.length - 1];
      prev.focus();
      const path = prev.getAttribute('data-path');
      if (path) setFocusedPath(path);
    }
  }, []);

  // ── Render entry ───────────────────────────────────────────────────────────

  const renderEntry = (entry, depth = 0) => {
    const isDir = entry.type === 'dir';
    const isExpanded = expandedDirs.has(entry.path);
    const isActive = selectedPath === entry.path;
    const isRenaming = renamingPath === entry.path;
    const isFocused = focusedPath === entry.path || (focusedPath === null && depth === 0 && entry === entries[0]);

    const handleKeyDown = (e) => {
      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (isDir) {
            toggleDir(entry.path);
          } else if (!isRenaming) {
            onSelectFile(entry.path);
          }
          break;
        case 'ArrowRight':
          if (isDir && !isExpanded) {
            e.preventDefault();
            toggleDir(entry.path);
          }
          break;
        case 'ArrowLeft':
          if (isDir && isExpanded) {
            e.preventDefault();
            setExpandedDirs((s) => { const n = new Set(s); n.delete(entry.path); return n; });
          }
          break;
        // ArrowUp/Down handled at tree container
        default:
          break;
      }
    };

    return (
      <div key={entry.path}>
        <div
          className={`config-tree-entry${isActive ? ' is-active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          role="treeitem"
          aria-expanded={isDir ? isExpanded : undefined}
          aria-selected={isActive}
          aria-level={depth + 1}
          aria-label={`${isDir ? 'Directory' : 'File'}: ${entry.name}`}
          data-path={entry.path}
          tabIndex={isFocused ? 0 : -1}
          onFocus={() => setFocusedPath(entry.path)}
          onClick={() => {
            setFocusedPath(entry.path);
            if (isDir) {
              toggleDir(entry.path);
            } else if (!isRenaming) {
              onSelectFile(entry.path);
            }
          }}
          onKeyDown={handleKeyDown}
        >
          <span aria-hidden="true" style={{ flexShrink: 0 }}>
            {isDir ? (
              <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={13} />
            ) : (
              <Icon name="file" size={13} />
            )}
          </span>
          {isRenaming ? (
            <input
              ref={renameRef}
              className="config-tree-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => commitRename(entry)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(entry); }
                if (e.key === 'Escape') { e.preventDefault(); setRenamingPath(null); }
              }}
              aria-label="Rename file"
            />
          ) : (
            <span className="entry-name">{entry.name}</span>
          )}
          {!following && !isRenaming && (
            <span className="entry-actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="btn-icon"
                style={{ width: 20, height: 20 }}
                onClick={() => startRename(entry)}
                aria-label={`Rename ${entry.name}`}
                title="Rename"
                tabIndex={-1}
              >
                <Icon name="edit" size={11} />
              </button>
              <button
                type="button"
                className="btn-icon"
                style={{ width: 20, height: 20 }}
                onClick={() => handleDelete(entry)}
                aria-label={`Delete ${entry.name}`}
                title="Delete"
                tabIndex={-1}
              >
                <Icon name="trash" size={11} />
              </button>
            </span>
          )}
        </div>
        {isDir && isExpanded && (
          <div role="group" aria-label={`Contents of ${entry.name}`}>
            {(dirEntries[entry.path] || []).map((child) => renderEntry(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="config-tree-body" style={{ padding: 12 }}>
        <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading files…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="config-tree-body" style={{ padding: 10, fontSize: '0.8rem', color: 'var(--danger)' }}>
        {error}
      </div>
    );
  }

  const hasStarter = folder === 'kiro' || folder === 'claude' || folder === 'codex';
  const isEmpty = entries.length === 0;

  return (
    <>
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />

      {/* Header: "Files" label + New File / New Folder buttons */}
      <div className="config-tree-header">
        <span>Files</span>
        {!following && (
          <span className="config-tree-header-actions">
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => { setShowNewFile(true); setShowNewFolder(false); }}
              aria-label="New file"
              title="New file"
            >
              <Icon name="file-plus" size={12} />
              New File
            </button>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() => { setShowNewFolder(true); setShowNewFile(false); }}
              aria-label="New folder"
              title="New folder"
            >
              <Icon name="folder-plus" size={12} />
              New Folder
            </button>
            {hasStarter && (
              <button
                type="button"
                className="btn btn-xs"
                onClick={handleAddPack}
                disabled={addingPack}
                aria-label="Add agent pack"
                title="Add a lead agent, backend, frontend, infra, security, slide and documentation agents, with their skills"
              >
                {addingPack
                  ? <span className="spinner" style={{ width: 11, height: 11 }} aria-hidden="true" />
                  : <Icon name="agents" size={12} />}
                Agent pack
              </button>
            )}
          </span>
        )}
      </div>

      {/* Inline new-file form */}
      {showNewFile && (
        <form onSubmit={handleNewFile} style={{ padding: '4px 8px', display: 'flex', gap: 4 }}>
          <input
            ref={newFileRef}
            type="text"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            placeholder="path/to/file.json"
            autoFocus
            style={{ flex: 1, fontSize: '0.82rem', minHeight: 26, padding: '2px 6px' }}
            aria-label="New file path"
            onKeyDown={(e) => { if (e.key === 'Escape') { setShowNewFile(false); setNewFileName(''); } }}
          />
          <button type="submit" className="btn btn-sm btn-primary" style={{ padding: '2px 7px' }}>Add</button>
          <button type="button" className="btn btn-sm" style={{ padding: '2px 7px' }} onClick={() => { setShowNewFile(false); setNewFileName(''); }}>✕</button>
        </form>
      )}

      {/* Inline new-folder form */}
      {showNewFolder && (
        <form onSubmit={handleNewFolder} style={{ padding: '4px 8px', display: 'flex', gap: 4 }}>
          <input
            ref={newFolderRef}
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="folder-name"
            autoFocus
            style={{ flex: 1, fontSize: '0.82rem', minHeight: 26, padding: '2px 6px' }}
            aria-label="New folder name"
            onKeyDown={(e) => { if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName(''); } }}
          />
          <button type="submit" className="btn btn-sm btn-primary" style={{ padding: '2px 7px' }}>Add</button>
          <button type="button" className="btn btn-sm" style={{ padding: '2px 7px' }} onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}>✕</button>
        </form>
      )}

      {/* Root folder label */}
      <div className="config-tree-root-node" aria-hidden="true">
        <Icon name="explorer" size={13} />
        <span>.{folder}</span>
      </div>

      {/* Tree body */}
      <div
        ref={treeRef}
        className="config-tree-body"
        role="tree"
        aria-label={`${folder} file tree`}
        onKeyDown={handleTreeKeyDown}
      >
        {isEmpty ? (
          <div className="config-tree-empty">
            <p className="config-tree-empty-text">
              {following ? 'No files in the team default yet.' : 'No files yet.'}
            </p>
            {!following && hasStarter && (
              addingStarter ? (
                <div className="config-tree-starter-busy" role="status" aria-live="polite">
                  <div className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
                  Creating starter files…
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleAddStarter}
                  aria-label={`Add starter file structure for .${folder}`}
                >
                  <Icon name="sparkles" size={13} />
                  Add starter files
                </button>
              )
            )}
          </div>
        ) : (
          entries.map((e) => renderEntry(e))
        )}
      </div>
    </>
  );
}
