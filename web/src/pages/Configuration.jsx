/**
 * Configuration page (F5) — personal ~/.kiro, ~/.claude, ~/.aws editor.
 *
 * Three tabs per config folder. Each shows:
 *   - Team-default status card (following / customised + reset)
 *   - File tree with new file, new folder, rename, delete, and starter structure
 *   - Code editor (lazy CodeMirror) with JSON validation
 *   - Import Zip / Export Zip (top right)
 *   - Admin: Publish as team default
 *
 * AWS tab shows a warning about credentials at rest.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { ConfigStatus } from './config/ConfigStatus.jsx';
import { ConfigFileTree } from './config/ConfigFileTree.jsx';
import { ConfigEditor } from './config/ConfigEditor.jsx';

const TABS = [
  {
    id: 'kiro',
    label: 'Kiro (~/.kiro)',
    description:
      'Agents, skills, steering, hooks and settings Kiro CLI loads, including MCP servers in settings/mcp.json.',
  },
  {
    id: 'claude',
    label: 'Claude Code (~/.claude)',
    description:
      'CLAUDE.md, settings.json, agents, skills and commands that Claude Code loads, plus your MCP servers from ~/.claude.json.',
  },
  {
    id: 'aws',
    label: 'AWS (~/.aws)',
    description:
      'AWS config and credentials files used by engines and tools that need AWS access in your sessions.',
  },
];

function AwsWarning() {
  return (
    <div
      style={{
        background: 'var(--warn-wash)',
        border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)',
        borderRadius: 'var(--radius)',
        padding: '10px 14px',
        marginBottom: 12,
        fontSize: '0.84rem',
        color: 'var(--warn)',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
      }}
      role="note"
    >
      <Icon name="warning" size={15} style={{ flexShrink: 0 }} />
      <span>
        Keys stored here are plaintext in zip exports — handle with care. For engine
        sign-ins, <a href="#/credentials" style={{ color: 'inherit', textDecoration: 'underline' }}>Credentials</a>{' '}
        is the safer place.
      </span>
    </div>
  );
}

function ImportZipButton({ folder, onImported }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      await fetch(`/api/user-config/${folder}/import`, {
        method: 'POST',
        headers: { 'x-requested-with': 'agent-portal' },
        credentials: 'same-origin',
        body: formData,
      }).then(async (res) => {
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `Import failed (${res.status})`);
        }
      });
      onImported?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <label
        className="btn"
        style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
        aria-label={`Import zip to ${folder} config`}
      >
        <Icon name="upload" size={14} />
        {busy ? 'Importing…' : 'Import Zip'}
        <input
          type="file"
          accept=".zip"
          style={{ display: 'none' }}
          onChange={handleChange}
          disabled={busy}
          aria-hidden="true"
        />
      </label>
      {error && (
        <span className="error-note" role="alert" style={{ fontSize: '0.82rem' }}>
          {error}
        </span>
      )}
    </div>
  );
}

function ExportZipButton({ folder }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/user-config/${folder}/export`, {
        headers: { 'x-requested-with': 'agent-portal' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${folder}-config.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        className="btn"
        onClick={handleExport}
        disabled={busy}
        aria-label={`Export ${folder} config as zip`}
      >
        <Icon name="zip-download" size={14} />
        {busy ? 'Exporting…' : 'Export Zip'}
      </button>
      {error && (
        <span className="error-note" role="alert" style={{ fontSize: '0.82rem' }}>
          {error}
        </span>
      )}
    </div>
  );
}

function ConfigTab({ folder, user, treeRefreshBump }) {
  const [status, setStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [selectedFile, setSelectedFile] = useState(null);
  const [treeKey, setTreeKey] = useState(0);
  const [newFileRequested, setNewFileRequested] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const s = await api.get(`/api/user-config/${folder}/status`);
      setStatus(s);
    } catch {
      // non-fatal
    } finally {
      setLoadingStatus(false);
    }
  }, [folder]);

  useEffect(() => {
    loadStatus();
    setSelectedFile(null);
    setTreeKey((k) => k + 1);
    setNewFileRequested(false);
  }, [folder, loadStatus]);

  // Respond to external refresh request (after import)
  useEffect(() => {
    if (treeRefreshBump > 0) {
      setTreeKey((k) => k + 1);
      loadStatus();
      setSelectedFile(null);
    }
  }, [treeRefreshBump, loadStatus]);

  const handleTreeChange = useCallback(() => {
    setTreeKey((k) => k + 1);
    loadStatus();
  }, [loadStatus]);

  const isFollowing = status?.following && !!status?.teamVersion;

  return (
    <div>
      {folder === 'aws' && <AwsWarning />}

      {!loadingStatus && status && (
        <ConfigStatus
          folder={folder}
          status={status}
          user={user}
          onStatusChange={() => { loadStatus(); setTreeKey((k) => k + 1); }}
        />
      )}

      <div className="config-layout">
        <div className="config-tree-pane">
          <ConfigFileTree
            key={treeKey}
            folder={folder}
            selectedPath={selectedFile}
            onSelectFile={setSelectedFile}
            onTreeChange={handleTreeChange}
            following={isFollowing}
            requestNewFile={newFileRequested}
            onNewFileRequestHandled={() => setNewFileRequested(false)}
          />
        </div>

        <div className="config-editor-pane">
          <ConfigEditor
            folder={folder}
            filePath={selectedFile}
            following={isFollowing}
            onFileSaved={loadStatus}
            onRequestNewFile={() => setNewFileRequested(true)}
          />
        </div>
      </div>
    </div>
  );
}

export function Configuration({ user }) {
  const [tab, setTab] = useState('kiro');
  const [treeRefreshBump, setTreeRefreshBump] = useState(0);

  const activeTabDef = TABS.find((t) => t.id === tab);

  const handleImported = useCallback(() => {
    setTreeRefreshBump((k) => k + 1);
  }, []);

  return (
    <div className="page">
      {/* Page header: title + subtitle on left, zip buttons on right */}
      <div className="config-page-header">
        <div className="config-page-title">
          <h1>Configuration</h1>
          <p className="muted">
            Your own .kiro, .claude and .aws folders, as the engines and their tools see them in
            every session you start. Changes apply to sessions started or resumed afterwards.
          </p>
        </div>
        <div className="config-page-header-actions">
          <ImportZipButton folder={tab} onImported={handleImported} />
          <ExportZipButton folder={tab} />
        </div>
      </div>

      {/* Tab row with inline description */}
      <div className="config-tabs-row">
        <div className="tab-bar" role="tablist" aria-label="Configuration folders">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              className={`tab-btn${tab === t.id ? ' is-active' : ''}`}
              aria-selected={tab === t.id}
              aria-controls={`cfg-panel-${t.id}`}
              id={`cfg-tab-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {activeTabDef && (
          <p className="config-tab-desc" aria-live="polite">
            {activeTabDef.description}
          </p>
        )}
      </div>

      <div
        role="tabpanel"
        id={`cfg-panel-${tab}`}
        aria-labelledby={`cfg-tab-${tab}`}
        className="tab-panel"
      >
        <ConfigTab
          key={tab}
          folder={tab}
          user={user}
          treeRefreshBump={treeRefreshBump}
        />
      </div>
    </div>
  );
}

export default Configuration;
