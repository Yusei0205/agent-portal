/**
 * IdeWorkspace — IDE-like session workspace.
 *
 * Layout:
 *   Header
 *   ┌─────────────────────────────────────────────────────┐
 *   │ Activity Bar │ Sidebar │ Editor │ Agent Panel       │
 *   ├─────────────────────────────────────────────────────┤
 *   │ (activity)   │            Terminal                  │
 *   └─────────────────────────────────────────────────────┘
 *   Status Bar
 *   Composer
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { subscribeProject } from '../../lib/events.js';
import { registerHandler, registerShortcuts } from '../../lib/shortcuts.js';
import { Icon } from '../../components/Icon.jsx';
import { SessionLive } from './SessionLive.jsx';
import { IdeHeader } from './IdeHeader.jsx';
import { IdeExplorer } from './IdeExplorer.jsx';
import { IdeEditor } from './IdeEditor.jsx';
import { IdeSourceControl } from './IdeSourceControl.jsx';
import { IdeTerminal } from './IdeTerminal.jsx';
import { IdeBrowser } from './IdeBrowser.jsx';
import { IdeAgents } from './IdeAgents.jsx';
import { IdeSessionPanel } from './IdeSessionPanel.jsx';
import { IdeStatusBar } from './IdeStatusBar.jsx';

// Pre-register workspace shortcuts so the palette / sheet always knows them
registerShortcuts([
  { id: 'ws_save',    keys: 'Ctrl S',       label: 'Save file',           group: 'Workspace' },
  { id: 'ws_term',    keys: 'Ctrl `',        label: 'Toggle terminal',     group: 'Workspace' },
  { id: 'ws_explore', keys: 'Ctrl Shift E', label: 'Toggle explorer',     group: 'Workspace' },
  { id: 'ws_source',  keys: 'Ctrl Shift G', label: 'Toggle source control', group: 'Workspace' },
  { id: 'ws_editor',  keys: 'Ctrl Shift B', label: 'Toggle editor panel', group: 'Workspace' },
]);

// ── Local storage helpers ────────────────────────────────────────────────────

const LS_KEY = 'ide_layout';

function loadLayout() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveLayout(layout) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
}

// ── Resize hooks ──────────────────────────────────────────────────────────────

/**
 * Horizontal resize hook (X axis).
 * onEnd receives the final clamped size so persist callbacks don't close over stale state.
 */
function useResize(initial, min, max, onEnd) {
  const [size, setSize] = useState(initial);
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startPos.current = e.clientX;
    startSize.current = size;

    let lastSize = size;
    const onMove = (ev) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startPos.current;
      lastSize = Math.min(max, Math.max(min, startSize.current + delta));
      setSize(lastSize);
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (onEnd) onEnd(lastSize); // pass final size so caller doesn't use stale closure
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [size, min, max, onEnd]);

  return [size, setSize, onMouseDown];
}

/**
 * Vertical resize hook (Y axis — drag up to grow).
 * onEnd receives the final clamped size.
 */
function useResizeY(initial, min, max, onEnd) {
  const [size, setSize] = useState(initial);
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startPos.current = e.clientY;
    startSize.current = size;

    let lastSize = size;
    const onMove = (ev) => {
      if (!dragging.current) return;
      const delta = startPos.current - ev.clientY; // drag up = bigger terminal
      lastSize = Math.min(max, Math.max(min, startSize.current + delta));
      setSize(lastSize);
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (onEnd) onEnd(lastSize); // pass final size
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [size, min, max, onEnd]);

  return [size, setSize, onMouseDown];
}

// ── Activity bar button ───────────────────────────────────────────────────────

function ActivityBtn({ icon, label, active, onClick }) {
  return (
    <button
      type="button"
      className={`ide-activity-btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

// ── Composer bar ──────────────────────────────────────────────────────────────

function ComposerBar({ workflow, projectId, onSent, idleStopped, onDismissIdle }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);
  const isRunning = workflow?.status === 'running' || workflow?.status === 'pending';

  const enginePlaceholder =
    workflow?.engine === 'kiro'
      ? 'Ask Kiro to change something… (Ctrl+Enter to send)'
      : workflow?.engine === 'claude-code'
      ? 'Ask Claude to change something… (Ctrl+Enter to send)'
      : 'Send a message… (Ctrl+Enter)';

  const showSlashHint = message.startsWith('/');

  const send = async () => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    if (idleStopped && onDismissIdle) onDismissIdle();
    try {
      const res = await api.post(
        `/api/projects/${projectId}/workflows/${workflow.id}/message`,
        { message: text },
      );
      // Only call /start if the session is not running and was not resumed by the
      // /message endpoint itself (avoid double-start on idempotent /start).
      if (!isRunning && !res?.resumed) {
        await api.post(
          `/api/projects/${projectId}/workflows/${workflow.id}/start`,
        ).catch(() => {});
      }
      setMessage('');
      if (onSent) onSent();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-composer">
      {idleStopped && (
        <div className="ide-idle-banner" role="alert">
          <Icon name="idle-stop" size={15} />
          <span className="ide-idle-banner-msg">
            Session stopped — idle for {idleStopped} minutes. Send a message to resume.
          </span>
          <button
            type="button"
            className="btn-icon"
            aria-label="Dismiss"
            onClick={onDismissIdle}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      {error && (
        <div className="error-note" style={{ margin: '0 0 6px' }} role="alert">
          {error}
        </div>
      )}
      {showSlashHint && (
        <div
          className="ide-slash-hint"
          role="status"
          aria-live="polite"
          style={{
            fontSize: '0.75rem',
            color: 'var(--ink-3)',
            padding: '2px 10px',
            borderTop: '1px solid var(--line)',
          }}
        >
          Commands starting with / are passed to the engine. /clear starts the next turn fresh.
        </div>
      )}
      <div className="ws-composer-row">
        <button
          type="button"
          className="btn-icon"
          title="Attach file (coming soon)"
          aria-label="Attach file"
          disabled
        >
          <Icon name="attach" size={16} />
        </button>
        <input
          type="text"
          className="ws-composer-input"
          placeholder={enginePlaceholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
          disabled={busy || !workflow}
          aria-label="Message"
        />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={send}
          disabled={busy || !message.trim() || !workflow}
          aria-label="Send (Ctrl+Enter)"
          title="Send (Ctrl+Enter)"
        >
          {busy
            ? <span className="spinner" style={{ width: 14, height: 14 }} />
            : <Icon name="send" size={14} />}
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * @param {{
 *   id: string,
 *   project: { id: string, name: string },
 * }} props
 */
export function IdeWorkspace({ id, project }) {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [title, setTitle]       = useState(null); // inline rename override
  const [idleStopped, setIdleStopped] = useState(null); // minutes, or null
  const timerRef = useRef(null);

  // ── Panel state ──────────────────────────────────────────────────────────

  const savedLayout = loadLayout();

  const [sidebarPanel, setSidebarPanel] = useState(savedLayout.sidebarPanel ?? null);
  const [terminalOpen, setTerminalOpen] = useState(savedLayout.terminalOpen ?? false);
  // Editor panel: collapsed by default (false). Auto-expands when a file is opened.
  const [editorPanelOpen, setEditorPanelOpen] = useState(savedLayout.editorPanelOpen ?? false);

  // Persist callbacks accept the final size from onEnd so there are no stale-closure bugs.
  const persistSidebar  = useCallback((w) => saveLayout({ ...loadLayout(), sidebarW: w }), []);
  const persistTerminal = useCallback((h) => saveLayout({ ...loadLayout(), terminalH: h }), []);
  const persistEditorW  = useCallback((w) => saveLayout({ ...loadLayout(), editorW: w }), []);

  const [sidebarW, setSidebarW, onSidebarDrag] = useResize(
    savedLayout.sidebarW ?? 240, 140, 520, persistSidebar,
  );
  // Fix #1 & #2: terminal uses the Y-axis hook; onEnd receives final height.
  const [terminalH, setTerminalH, onTerminalDrag] = useResizeY(
    savedLayout.terminalH ?? 200, 80, 500, persistTerminal,
  );

  // Editor panel width — used when editorPanelOpen is true.
  const [editorW, setEditorW, onEditorDrag] = useResize(
    savedLayout.editorW ?? 460, 200, 800, persistEditorW,
  );

  // Open file tracking (passed from explorer to editor)
  const [openFile, setOpenFile] = useState(null);

  // Persist panel visibility on change
  useEffect(() => {
    saveLayout({ ...loadLayout(), sidebarPanel, terminalOpen, editorPanelOpen });
  }, [sidebarPanel, terminalOpen, editorPanelOpen]);

  // Auto-expand editor panel when a file is opened from the explorer
  useEffect(() => {
    if (openFile) setEditorPanelOpen(true);
  // openFile object reference changes on every file-open, which is what we want.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFile]);

  // ── Data loading ─────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    try {
      const wData = await api.get(
        `/api/projects/${project.id}/workflows/${id}`,
      );
      setData(wData);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [id, project.id]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setTitle(null);
    setIdleStopped(null);
    load();
  }, [load]);

  // SSE project events
  useEffect(() => {
    const unsub = subscribeProject(project.id, (event) => {
      if (event.type === 'workflow.renamed' && event.workflowId === id) {
        setTitle(event.title);
      }
      if (event.type === 'workflow.idle-stopped' && event.workflowId === id) {
        setIdleStopped(event.timeoutMinutes ?? '?');
        load();
      }
      if (
        (event.type === 'workflow.updated' && event.id === id) ||
        event.type === 'run.updated'
      ) {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(load, 300);
      }
    });
    return () => { unsub(); clearTimeout(timerRef.current); };
  }, [project.id, id, load]);

  // ── Keyboard shortcuts — via registry only (no duplicate raw listeners) ────

  useEffect(() => {
    const unExplore  = registerHandler('ws_explore', () => setSidebarPanel((p) => p === 'explorer' ? null : 'explorer'));
    const unSource   = registerHandler('ws_source',  () => setSidebarPanel((p) => p === 'source'   ? null : 'source'));
    const unTerm     = registerHandler('ws_term',    () => setTerminalOpen((o) => !o));
    const unEditor   = registerHandler('ws_editor',  () => setEditorPanelOpen((o) => !o));
    // ws_save handler is registered in IdeEditor; no need to re-register here.
    return () => { unExplore(); unSource(); unTerm(); unEditor(); };
  }, []);

  // ── Error / loading states ────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
        <div className="spinner" aria-label="Loading session…" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="error-note" style={{ margin: 24 }} role="alert">
        {error}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={load}
          style={{ marginLeft: 8 }}
        >
          Retry
        </button>
      </div>
    );
  }

  const workflow      = data?.workflow ?? null;
  const latestRun     = data?.latestRun ?? null;
  const latestRunId   = latestRun?.id ?? null;
  const displayTitle  = title ?? workflow?.title ?? workflow?.goal ?? `Session ${id.slice(0, 8)}`;

  return (
    <div className="ide-workspace" aria-label="Session workspace">
      {/* Header */}
      <IdeHeader
        workflow={workflow ? { ...workflow, title: displayTitle } : null}
        projectId={project.id}
        onStopped={load}
        onRenamed={(t) => setTitle(t)}
        onOpenBrowser={() => setSidebarPanel((p) => p === 'browser' ? null : 'browser')}
        onDelegated={() => setSidebarPanel('agents')}
      />

      {/* Body */}
      <div className="ide-body">
        {/* Activity bar */}
        <nav className="ide-activity-bar" aria-label="Activity bar">
          <ActivityBtn
            icon="explorer"
            label="Explorer (Ctrl+Shift+E)"
            active={sidebarPanel === 'explorer'}
            onClick={() => setSidebarPanel((p) => p === 'explorer' ? null : 'explorer')}
          />
          <ActivityBtn
            icon="source-control"
            label="Source Control (Ctrl+Shift+G)"
            active={sidebarPanel === 'source'}
            onClick={() => setSidebarPanel((p) => p === 'source' ? null : 'source')}
          />
          <ActivityBtn
            icon="browser"
            label="Browser"
            active={sidebarPanel === 'browser'}
            onClick={() => setSidebarPanel((p) => p === 'browser' ? null : 'browser')}
          />
          <ActivityBtn
            icon="agents"
            label="Agents activity"
            active={sidebarPanel === 'agents'}
            onClick={() => setSidebarPanel((p) => p === 'agents' ? null : 'agents')}
          />
          {/* Session panel — Activity / Context / Settings (re-homed from old SessionWorkspace) */}
          <ActivityBtn
            icon="history"
            label="Session (Activity, Context, Settings)"
            active={sidebarPanel === 'session'}
            onClick={() => setSidebarPanel((p) => p === 'session' ? null : 'session')}
          />
          <ActivityBtn
            icon="terminal"
            label="Toggle terminal (Ctrl+`)"
            active={terminalOpen}
            onClick={() => setTerminalOpen((o) => !o)}
          />
        </nav>

        {/* Sidebar */}
        {sidebarPanel && (
          <aside
            className="ide-sidebar"
            style={{ width: sidebarW }}
            aria-label={
              sidebarPanel === 'explorer' ? 'Explorer' :
              sidebarPanel === 'source'   ? 'Source control' :
              sidebarPanel === 'browser'  ? 'Browser' :
              sidebarPanel === 'agents'   ? 'Agents activity' :
              sidebarPanel === 'session'  ? 'Session' :
              'Sidebar'
            }
          >
            <div className="ide-panel-header">
              <span className="ide-panel-header-title">
                {sidebarPanel === 'explorer' ? 'Explorer' :
                 sidebarPanel === 'source'   ? 'Source Control' :
                 sidebarPanel === 'browser'  ? 'Browser' :
                 sidebarPanel === 'agents'   ? 'Agents Activity' :
                 sidebarPanel === 'session'  ? 'Session' :
                 'Panel'}
              </span>
              <div className="ide-panel-header-actions">
                <button
                  type="button"
                  className="btn-icon"
                  style={{ width: 22, height: 22 }}
                  aria-label="Close panel"
                  title="Close panel"
                  onClick={() => setSidebarPanel(null)}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            </div>

            {sidebarPanel === 'explorer' && workflow && (
              <IdeExplorer
                workflowId={id}
                onFileOpen={(file) => {
                  setOpenFile({ ...file, key: `${file.scope}:${file.path}` });
                }}
              />
            )}
            {sidebarPanel === 'source' && (
              <IdeSourceControl workflowId={id} />
            )}
            {sidebarPanel === 'browser' && (
              <IdeBrowser workflowId={id} />
            )}
            {sidebarPanel === 'agents' && (
              <IdeAgents workflowId={id} projectId={project.id} />
            )}
            {sidebarPanel === 'session' && (
              <IdeSessionPanel
                workflow={workflow}
                workflowId={id}
                projectId={project.id}
              />
            )}

            {/* Resize handle */}
            <div
              className="ide-resize-handle-x"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              tabIndex={0}
              onMouseDown={onSidebarDrag}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') setSidebarW((w) => Math.min(520, w + 10));
                if (e.key === 'ArrowLeft')  setSidebarW((w) => Math.max(140, w - 10));
              }}
            />
          </aside>
        )}

        {/* Main content */}
        <div className="ide-main">
          <div className="ide-main-row">
            {/* Editor panel — conditionally rendered; auto-expands on file open */}
            {editorPanelOpen && (
              <div
                className="ide-editor-area"
                style={{ width: editorW }}
                aria-label="Editor"
              >
                <IdeEditor
                  workflowId={id}
                  openFile={openFile}
                  onFileOpened={() => {}}
                />
                {/* Resize handle on right edge of editor area */}
                <div
                  className="ide-resize-handle-x"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize editor panel"
                  tabIndex={0}
                  onMouseDown={onEditorDrag}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowRight') setEditorW((w) => Math.min(800, w + 10));
                    if (e.key === 'ArrowLeft')  setEditorW((w) => Math.max(200, w - 10));
                  }}
                />
              </div>
            )}

            {/* Thin strip — always visible — toggles the editor panel */}
            <button
              type="button"
              className="ide-editor-toggle-strip"
              onClick={() => setEditorPanelOpen((o) => !o)}
              aria-label={editorPanelOpen ? 'Collapse editor panel' : 'Expand editor panel (Ctrl+Shift+B)'}
              aria-expanded={editorPanelOpen}
              title={editorPanelOpen ? 'Collapse editor panel (Ctrl+Shift+B)' : 'Expand editor panel (Ctrl+Shift+B)'}
            >
              <Icon name={editorPanelOpen ? 'chevronLeft' : 'chevronRight'} size={12} />
            </button>

            {/* Agent conversation panel — takes all remaining width */}
            <div
              className="ide-agent-panel"
              style={{ flex: 1, minWidth: 280, borderLeft: 'none' }}
              aria-label="Agent conversation"
            >
              <SessionLive
                runId={latestRunId}
                workflowId={id}
                projectId={project.id}
                workflow={workflow}
              />
            </div>
          </div>

          {/* Terminal panel */}
          {terminalOpen && (
            <div
              className="ide-terminal-panel"
              style={{ height: terminalH }}
              aria-label="Terminal"
            >
              {/* Resize handle at top — uses Y-axis drag (fix #1) */}
              <div
                className="ide-resize-handle-y"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize terminal"
                tabIndex={0}
                onMouseDown={onTerminalDrag}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp')   setTerminalH((h) => Math.min(500, h + 10));
                  if (e.key === 'ArrowDown') setTerminalH((h) => Math.max(80, h - 10));
                }}
              />
              <div className="ide-panel-header" style={{ paddingTop: 8 }}>
                <span className="ide-panel-header-title">Terminal</span>
                <div className="ide-panel-header-actions">
                  <button
                    type="button"
                    className="btn-icon"
                    style={{ width: 22, height: 22 }}
                    aria-label="Close terminal"
                    onClick={() => setTerminalOpen(false)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              </div>
              <IdeTerminal workflowId={id} height={terminalH - 32} />
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <IdeStatusBar projectId={project.id} workflowId={id} />

      {/* Composer */}
      <ComposerBar
        workflow={workflow}
        projectId={project.id}
        onSent={load}
        idleStopped={idleStopped}
        onDismissIdle={() => setIdleStopped(null)}
      />
    </div>
  );
}
