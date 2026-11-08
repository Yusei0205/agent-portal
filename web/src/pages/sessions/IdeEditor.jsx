/**
 * IDE Editor panel.
 * Lazy-loads CodeMirror on first file open.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { registerHandler } from '../../lib/shortcuts.js';
import { Icon } from '../../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';

// ── Lazy CodeMirror loader ────────────────────────────────────────────────────

let _editorMod = null;
let _loadingMod = null;

function loadEditorModule() {
  if (_editorMod) return Promise.resolve(_editorMod);
  if (_loadingMod) return _loadingMod;
  _loadingMod = import('./codemirror-editor.jsx').then((m) => {
    _editorMod = m;
    return m;
  });
  return _loadingMod;
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

/**
 * Each tab is rendered as two sibling <button> elements inside a wrapper <div>
 * (display: flex) so the close button is a real interactive element, not a
 * <span role="button"> nested inside another <button> (invalid HTML).
 */
function TabBar({ tabs, activeIdx, onActivate, onClose }) {
  const [hoverIdx, setHoverIdx] = useState(-1);

  if (tabs.length === 0) return null;

  return (
    <div className="ide-editor-tabs" role="tablist" aria-label="Open files">
      {tabs.map((tab, idx) => {
        const showClose = idx === activeIdx || idx === hoverIdx;
        return (
          <div
            key={tab.key}
            className="ide-editor-tab-wrap"
            style={{ display: 'flex', alignItems: 'stretch', position: 'relative' }}
            onMouseEnter={() => setHoverIdx(idx)}
            onMouseLeave={() => setHoverIdx(-1)}
          >
            <button
              type="button"
              role="tab"
              aria-selected={idx === activeIdx}
              className={`ide-editor-tab${idx === activeIdx ? ' is-active' : ''}`}
              onClick={() => onActivate(idx)}
              title={tab.path}
              style={{ paddingRight: 4 }}
            >
              {tab.dirty && (
                <span className="ide-editor-tab-dirty" aria-label="Unsaved changes" />
              )}
              <span className="ide-editor-tab-name">{tab.name}</span>
            </button>
            {/* Close button is a sibling, not nested inside the tab button */}
            <button
              type="button"
              className="ide-editor-tab-close"
              aria-label={`Close ${tab.name}`}
              tabIndex={0}
              style={{ opacity: showClose ? 1 : 0, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-3)' }}
              onClick={() => onClose(idx)}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * @param {{
 *   workflowId: string,
 *   openFile: { scope: string, path: string, name: string, ext: string } | null,
 *   onFileOpened: () => void,
 * }} props
 */
export function IdeEditor({ workflowId, openFile, onFileOpened }) {
  const [tabs, setTabs]           = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [EditorComponent, setEditorComponent] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [staleBanner, setStaleBanner] = useState(null);
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState(null); // non-409 or non-stale 409 errors
  const { confirmState, requestConfirm } = useConfirm();

  // Load CodeMirror lazily when a file is first opened
  useEffect(() => {
    if (!openFile || EditorComponent) return;
    loadEditorModule()
      .then((m) => setEditorComponent(() => m.CodeMirrorEditor))
      .catch((e) => setLoadError(e.message));
  }, [openFile, EditorComponent]);

  // Open a file — fetch content and add tab
  useEffect(() => {
    if (!openFile) return;
    const key = `${openFile.scope}:${openFile.path}`;
    const existingTab = tabs.findIndex(tab => tab.key === key);
    if (existingTab >= 0) {
      setActiveIdx(existingTab);
      setTabs(previous => previous.map((tab, i) => i === existingTab ? { ...tab, line: openFile.line } : tab));
      onFileOpened?.();
      return;
    }
    setTabs((prev) => {
      const existing = prev.findIndex((t) => t.key === key);
      if (existing >= 0) {
        setActiveIdx(existing);
        return prev.map((tab, i) => i === existing ? { ...tab, line: openFile.line } : tab);
      }
      const newTab = {
        key,
        name:    openFile.name,
        path:    openFile.path,
        scope:   openFile.scope,
        ext:     openFile.ext,
        line:    openFile.line,
        content: '',
        token:   null,
        loading: true,
        dirty:   false,
        error:   null,
      };
      const nextTabs = [...prev, newTab];
      setActiveIdx(nextTabs.length - 1);
      return nextTabs;
    });

    // Load content async
    api.get(
      `/api/workflows/${workflowId}/ide/file?scope=${openFile.scope}&path=${encodeURIComponent(openFile.path)}`,
    )
      .then((data) => {
        setTabs((prev) => prev.map((t) =>
          t.key === key
            ? {
                ...t,
                loading:  false,
                content:  data.content ?? '',
                token:    data.token ?? null,
                readOnly: data.tooLarge || data.readOnly === true || openFile.scope === 'vault' || openFile.scope === 'vault:team',
              }
            : t,
        ));
      })
      .catch((e) => {
        setTabs((prev) => prev.map((t) =>
          t.key === key ? { ...t, loading: false, error: e.message } : t,
        ));
      });

    if (onFileOpened) onFileOpened();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFile?.key ?? openFile?.path, openFile?.line, workflowId]);

  const activeTab = tabs[activeIdx] ?? null;

  const handleChange = useCallback((value) => {
    setTabs((prev) => prev.map((t, i) =>
      i === activeIdx ? { ...t, content: value, dirty: true } : t,
    ));
  }, [activeIdx]);

  // Keep a stable ref to active tab + idx so the shortcut handler doesn't get stale
  const activeTabRef  = useRef(activeTab);
  const activeIdxRef  = useRef(activeIdx);
  activeTabRef.current = activeTab;
  activeIdxRef.current = activeIdx;

  const handleSave = useCallback(async () => {
    const tab = activeTabRef.current;
    const idx = activeIdxRef.current;
    if (!tab || tab.readOnly || !tab.dirty) return;
    setSaving(true);
    setStaleBanner(null);
    setSaveError(null);
    try {
      const res = await api.put(`/api/workflows/${workflowId}/ide/file`, {
        scope:   tab.scope,
        path:    tab.path,
        content: tab.content,
        token:   tab.token,
      });
      setTabs((prev) => prev.map((t, i) =>
        i === idx ? { ...t, dirty: false, token: res.token } : t,
      ));
    } catch (e) {
      if (e.status === 409) {
        // Distinguish stale-token conflicts from other 409s
        if (e.data?.code === 'stale_token' || e.data?.token) {
          // File was modified externally — offer reload or overwrite
          setStaleBanner({ newToken: e.data?.token ?? null });
        } else {
          // Some other conflict (e.g. locked file)
          setSaveError(`Save conflict: ${e.data?.error ?? e.message}`);
        }
      } else {
        // Network error, 5xx, etc.
        setSaveError(e.message || 'Save failed. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }, [workflowId]);

  // Register Ctrl+S through the shortcut registry — no duplicate raw listener
  useEffect(() => {
    const unSave = registerHandler('ws_save', handleSave);
    return unSave;
  }, [handleSave]);

  // Stale: reload
  const handleReload = useCallback(async () => {
    const tab = activeTabRef.current;
    const idx = activeIdxRef.current;
    if (!tab) return;
    setStaleBanner(null);
    try {
      const data = await api.get(
        `/api/workflows/${workflowId}/ide/file?scope=${tab.scope}&path=${encodeURIComponent(tab.path)}`,
      );
      setTabs((prev) => prev.map((t, i) =>
        i === idx ? { ...t, content: data.content ?? '', token: data.token ?? null, dirty: false } : t,
      ));
    } catch { /* ignore — user can retry manually */ }
  }, [workflowId]);

  // Stale: overwrite
  const handleOverwrite = useCallback(async () => {
    const tab = activeTabRef.current;
    const idx = activeIdxRef.current;
    if (!tab || !staleBanner) return;
    setStaleBanner(null);
    setSaving(true);
    try {
      const res = await api.put(`/api/workflows/${workflowId}/ide/file`, {
        scope:   tab.scope,
        path:    tab.path,
        content: tab.content,
        // Omit token to force overwrite
      });
      setTabs((prev) => prev.map((t, i) =>
        i === idx ? { ...t, dirty: false, token: res.token } : t,
      ));
    } catch (e) {
      setSaveError(e.message || 'Overwrite failed');
    } finally {
      setSaving(false);
    }
  }, [workflowId, staleBanner]);

  const handleCloseTab = useCallback(async (idx) => {
    const tab = tabs[idx];
    if (tab?.dirty) {
      const ok = await requestConfirm(`Discard unsaved changes to "${tab.name}"?`, 'Discard', 'danger');
      if (!ok) return;
    }
    setTabs((prev) => prev.filter((_, i) => i !== idx));
    setActiveIdx((prev) => Math.max(0, prev >= idx ? prev - 1 : prev));
  }, [tabs, requestConfirm]);

  if (tabs.length === 0) {
    return (
      <div className="ide-editor-panel">
        <div className="ide-editor-empty">
          <Icon name="file" size={36} />
          <p>Open a file from the Explorer</p>
          <p style={{ fontSize: '0.78rem', opacity: 0.7 }}>
            Ctrl+S to save · Ctrl+Shift+E to toggle explorer
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ide-editor-panel">
      <TabBar
        tabs={tabs}
        activeIdx={activeIdx}
        onActivate={setActiveIdx}
        onClose={handleCloseTab}
      />

      <div className="ide-editor-content">
        {/* Stale-token banner */}
        {staleBanner && (
          <div className="ide-stale-banner" role="alert">
            <Icon name="warning" size={15} />
            <span className="ide-stale-banner-msg">
              File changed externally. Reload to see the latest or overwrite with your version.
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={handleReload}
            >
              Reload
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={handleOverwrite}
              disabled={saving}
            >
              {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : 'Overwrite'}
            </button>
          </div>
        )}

        {/* General save error banner (non-stale errors) */}
        {saveError && (
          <div className="ide-stale-banner" role="alert" style={{ background: 'var(--danger-wash)', borderColor: 'var(--danger)' }}>
            <Icon name="warning" size={15} />
            <span className="ide-stale-banner-msg">{saveError}</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setSaveError(null)}
            >
              Dismiss
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              Retry
            </button>
          </div>
        )}

        {/* Active tab content */}
        {activeTab?.loading ? (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
            <div className="spinner" aria-label="Loading file…" />
          </div>
        ) : activeTab?.error ? (
          <div className="error-note" style={{ margin: 16 }} role="alert">
            {activeTab.error}
          </div>
        ) : activeTab && EditorComponent ? (
          <EditorComponent
            key={activeTab.key}
            content={activeTab.content}
            ext={activeTab.ext}
            initialLine={activeTab.line}
            readOnly={activeTab.readOnly}
            onChange={handleChange}
            onSave={handleSave}
          />
        ) : activeTab && !EditorComponent ? (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
            {loadError
              ? <div className="error-note">{loadError}</div>
              : <div className="spinner" aria-label="Loading editor…" />}
          </div>
        ) : null}

        {/* Save indicator */}
        {saving && (
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              right: 12,
              fontSize: '0.75rem',
              color: 'var(--ink-3)',
            }}
          >
            Saving…
          </div>
        )}
      </div>
      <ConfirmDialog state={confirmState} />
    </div>
  );
}
