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
import { navigate } from '../../lib/router.js';
import { reviewHandoffHref } from '../../lib/pullRequestCard.js';
import { registerHandler, registerShortcuts } from '../../lib/shortcuts.js';
import { Icon } from '../../components/Icon.jsx';
import { AttachmentPicker } from '../../components/AttachmentPicker.jsx';
import { SessionLive } from './SessionLive.jsx';
import { IdeHeader } from './IdeHeader.jsx';
import { IdeExplorer } from './IdeExplorer.jsx';
import { IdeEditor } from './IdeEditor.jsx';
import { IdeSourceControl } from './IdeSourceControl.jsx';
import { IdeTerminal } from './IdeTerminal.jsx';
import { IdeBrowser } from './IdeBrowser.jsx';
import { IdeAgents } from './IdeAgents.jsx';
import { resolveConversationPath } from '../../lib/conversationFiles.js';
import { IdeSessionPanel } from './IdeSessionPanel.jsx';
import { IdeStatusBar } from './IdeStatusBar.jsx';
import { IdeOutputs } from './IdeOutputs.jsx';
import { OutputFilePreview } from './OutputFilePreview.jsx';

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
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Clamp persisted sidebar/editor widths to sensible bounds for the current
    // viewport.  A value saved on a wide desktop could leave almost no room for
    // the agent panel on a narrow screen.  The CSS mobile overrides also guard
    // against this, but JavaScript clamping prevents the flash of a mis-sized
    // layout before the first paint.
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    if (parsed.sidebarW != null) {
      parsed.sidebarW = Math.max(140, Math.min(parsed.sidebarW, Math.floor((vw - 40) * 0.45)));
    }
    if (parsed.editorW != null) {
      parsed.editorW = Math.max(200, Math.min(parsed.editorW, Math.floor((vw - 40) * 0.6)));
    }
    return parsed;
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

function ActivityBtn({ icon, label, active, onClick, badge, flash }) {
  return (
    <button
      type="button"
      className={`ide-activity-btn${active ? ' is-active' : ''}${flash && !active ? ' ide-activity-btn--flash' : ''}`}
      onClick={onClick}
      aria-label={badge ? `${label} (${badge})` : label}
      aria-pressed={active}
      title={label}
    >
      <Icon name={icon} size={17} />
      {badge > 0 && (
        <span className="ide-activity-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>
      )}
    </button>
  );
}

// ── Composer localStorage keys / resize ──────────────────────────────────────

const LS_COMPOSER_HEIGHT = 'ide_composer_height';

/** Smallest composer height: one text line (32px) plus the composer's 16px padding. */
const COMPOSER_MIN_H = 48;

/** Clamp a composer height: one line minimum, max 70 % of the viewport. */
function clampComposerH(h) {
  return Math.min(Math.floor(window.innerHeight * 0.7), Math.max(COMPOSER_MIN_H, h));
}

function loadComposerH() {
  try {
    const raw = localStorage.getItem(LS_COMPOSER_HEIGHT);
    if (!raw) return null;
    const h = Number(raw);
    return isNaN(h) ? null : clampComposerH(h);
  } catch { return null; }
}

function saveComposerH(h) {
  try {
    if (h == null) { localStorage.removeItem(LS_COMPOSER_HEIGHT); }
    else           { localStorage.setItem(LS_COMPOSER_HEIGHT, String(h)); }
  } catch { /* ignore */ }
}

// ── Composer bar ──────────────────────────────────────────────────────────────

/**
 * True when the text is a "/name" command, as the server reads it (server/workflows/session-commands.ts):
 * a message that starts with a path, such as "/src/app.ts fails", is an ordinary message.
 */
export function isSlashCommand(text) {
  return /^\/[A-Za-z0-9][\w.-]{0,63}(?::[A-Za-z0-9][\w.-]{0,63}){0,3}(?:\s|$)/.test(text.trim());
}

/** What the command menu shows next to a command that is not one of the portal's own. */
const COMMAND_SOURCE_LABEL = { command: 'your command', skill: 'skill' };

export function ComposerBar({
  workflow,
  projectId,
  onSent,
  idleStopped,
  onDismissIdle,
  onOptimisticSend,
  onSendSuccess,
  onSendError,
  onCommandDone,
}) {
  const [message, setMessage] = useState('');
  const [attachmentIds, setAttachmentIds] = useState([]);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [attachmentReset, setAttachmentReset] = useState(0);
  const attachmentInputRef = useRef(null);
  const attachmentsChanged = useCallback((ids, uploading) => { setAttachmentIds(ids); setAttachmentsBusy(uploading); }, []);
  const [commands, setCommands] = useState(null);
  const [menuIdx, setMenuIdx]   = useState(0);
  const [busy, setBusy]       = useState(false);
  // Resume state — shown when workflow.resumable and not running
  const [resuming, setResuming]       = useState(false);
  const [resumeError, setResumeError] = useState(null);
  // null = auto-grow with content; number = manually set height in pixels
  const [composerH, setComposerH] = useState(() => loadComposerH());
  const textareaRef = useRef(null);
  const composerRef = useRef(null);
  const rowRef      = useRef(null); // the input row: the height the person drags is this row's, not the whole box
  const isDragging  = useRef(false);
  const dragStartY  = useRef(0);
  const dragStartH  = useRef(0);

  const isRunning = workflow?.status === 'running' || workflow?.status === 'pending';

  // The repositories are cloned into the session's storage in the background: say so, and hold the message box until
  // that is done (a message sent meanwhile would only wait for it). A preparation stuck for over 6 minutes is ignored.
  const repoKey = Array.isArray(workflow?.repo_ids) ? workflow.repo_ids.join(',') : '';
  const [cloning, setCloning] = useState(false);
  const [prep, setPrep] = useState(null);
  useEffect(() => {
    if (!workflow?.id || !repoKey) { setCloning(false); setPrep(null); return undefined; }
    let cancelled = false;
    let timer = null;
    let wasRunning = false;
    const tick = async () => {
      try {
        const d = await api.get(`/api/projects/${projectId}/workflows/${workflow.id}/repo-prep`);
        if (cancelled) return;
        const p = d.prep;
        // A server instance that has not seen the status yet answers with nothing: keep waiting, do not unlock.
        if (!p && wasRunning) { timer = setTimeout(tick, 3000); return; }
        const live = p?.state === 'running' && Date.now() - new Date(p.at).getTime() < 17 * 60_000;
        wasRunning = Boolean(live);
        setCloning(Boolean(live));
        setPrep(p ?? null);
        if (live) timer = setTimeout(tick, 3000);
      } catch {
        if (!cancelled) setCloning(false);
      }
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [workflow?.id, repoKey, projectId]);

  // Progress panel: while cloning, and the outcome afterwards (a result stays for a little, or until dismissed).
  const [dismissed, setDismissed] = useState(false);
  const items = prep?.items ?? [];
  const total = items.length || repoKey.split(',').filter(Boolean).length;
  const doneCount = items.filter((i) => i.state === 'done').length;
  const failedCount = items.filter((i) => i.state === 'failed').length;
  const overallPct = items.length
    ? Math.round(items.reduce((a, i) => a + (i.state === 'done' ? 100 : (typeof i.percent === 'number' ? i.percent : 0)), 0) / items.length)
    : 0;
  const recentlyFinished = prep && prep.state !== 'running' && Date.now() - new Date(prep.at).getTime() < 3 * 60_000;
  const showPanel = !dismissed && (cloning || (recentlyFinished && (prep.state === 'done' || prep.state === 'failed') && items.length > 0));
  useEffect(() => { setDismissed(false); }, [workflow?.id, cloning]);
  useEffect(() => {
    if (!prep || prep.state !== 'done' || cloning) return undefined;
    const t = setTimeout(() => setDismissed(true), 25_000);
    return () => clearTimeout(t);
  }, [prep?.state, prep?.at, cloning]);

  const enginePlaceholder =
    workflow?.engine === 'kiro'
      ? 'Ask Kiro to change something…'
      : workflow?.engine === 'claude-code'
      ? 'Ask Claude to change something…'
      : 'Send a message…';

  // Command menu: opens while a "/command" is being typed (no space yet). Names that start with what was typed
  // come first, then names that contain it.
  const typedCommand = message.startsWith('/') && !/\s/.test(message) ? message.slice(1).toLowerCase() : null;
  const menuItems = typedCommand === null || !commands
    ? []
    : [
      ...commands.filter((c) => c.name.startsWith(typedCommand)),
      ...(typedCommand ? commands.filter((c) => !c.name.startsWith(typedCommand) && c.name.includes(typedCommand)) : []),
    ];
  const showMenu = menuItems.length > 0;
  const showSlashHint = isSlashCommand(message) && !showMenu;

  // The session's commands: the portal's, /init and /review, and the owner's own commands and skills.
  useEffect(() => { setCommands(null); }, [workflow?.id, workflow?.engine]);
  // Fetched as soon as the session is known, not on the first "/" keystroke, so the menu is ready when it is typed.
  useEffect(() => {
    if (commands || !workflow?.id) return;
    api.get(`/api/projects/${projectId}/workflows/${workflow.id}/commands`)
      .then((d) => setCommands(d.commands ?? []))
      .catch(() => setCommands([]));
  }, [commands, projectId, workflow?.id]);

  useEffect(() => { setMenuIdx(0); }, [typedCommand]);

  const pickCommand = (c) => {
    // Commands whose usage has no argument placeholder (e.g. "/help") send immediately.
    // Commands that expect an argument (e.g. "/model <name>") fill the box so the user can complete it.
    if (c.usage === `/${c.name}`) {
      send(`/${c.name}`);
    } else {
      setMessage(`/${c.name} `);
      textareaRef.current?.focus();
    }
  };

  // Auto-resize textarea height when in auto-grow mode
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (composerH !== null) {
      el.style.height = ''; // manual mode: CSS (flex) drives the height
    } else {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [message, composerH]);

  // Clamp the persisted height whenever the viewport resizes
  useEffect(() => {
    const onResize = () => setComposerH((h) => (h == null ? null : clampComposerH(h)));
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── Drag-handle pointer events (pointer capture → no text selection) ─────

  const onHandlePointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    isDragging.current = true;
    dragStartY.current = e.clientY;
    // Start from measured height when still in auto-grow mode
    dragStartH.current = composerH !== null
      ? composerH
      : (rowRef.current?.offsetHeight ?? 48);
  };

  const onHandlePointerMove = (e) => {
    if (!isDragging.current) return;
    const delta = dragStartY.current - e.clientY; // drag up → taller
    setComposerH(clampComposerH(dragStartH.current + delta));
  };

  const onHandlePointerUp = (e) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const delta = dragStartY.current - e.clientY;
    const newH  = clampComposerH(dragStartH.current + delta);
    setComposerH(newH);
    saveComposerH(newH);
  };

  // Drag interrupted (touch cancel, capture lost): keep and save the height reached so far.
  const onHandlePointerCancel = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setComposerH((h) => { saveComposerH(h); return h; });
  };

  // Double-click the handle → reset to auto-grow and clear saved height
  const onHandleDoubleClick = () => {
    setComposerH(null);
    saveComposerH(null);
  };

  // Keyboard resize: Arrow ±16 px (Shift ±64 px), Home → min, End → max
  const onHandleKeyDown = (e) => {
    const SMALL = 16;
    const LARGE = 64;
    const maxH  = Math.floor(window.innerHeight * 0.7);
    let handled = true;
    if (e.key === 'ArrowUp') {
      const step    = e.shiftKey ? LARGE : SMALL;
      const current = composerH ?? (rowRef.current?.offsetHeight ?? 48);
      const newH    = clampComposerH(current + step);
      setComposerH(newH);
      saveComposerH(newH);
    } else if (e.key === 'ArrowDown') {
      if (composerH != null) {
        const step = e.shiftKey ? LARGE : SMALL;
        const newH = clampComposerH(composerH - step);
        setComposerH(newH);
        saveComposerH(newH);
      }
    } else if (e.key === 'Home') {
      setComposerH(COMPOSER_MIN_H);
      saveComposerH(COMPOSER_MIN_H);
    } else if (e.key === 'End') {
      setComposerH(maxH);
      saveComposerH(maxH);
    } else {
      handled = false;
    }
    if (handled) e.preventDefault();
  };

  const handleResume = async () => {
    if (resuming || !workflow) return;
    setResuming(true);
    setResumeError(null);
    try {
      await api.post(`/api/projects/${projectId}/workflows/${workflow.id}/resume`, {});
      if (onSent) onSent();
      textareaRef.current?.focus();
    } catch (e) {
      setResumeError(e.message);
    } finally {
      setResuming(false);
    }
  };

  const send = async (textOverride) => {
    // send is also the Send button's click handler, so only a string is a command picked from the menu.
    const text = (typeof textOverride === 'string' ? textOverride : message).trim() || (attachmentIds.length ? 'Please read the attached files.' : '');
    if (!text || busy || attachmentsBusy) return;
    const sentAttachments = [...attachmentIds];
    const isSlash = isSlashCommand(text);
    if (isSlash && sentAttachments.length) {
      setResumeError('Send attachments with a message, not a slash command.');
      return;
    }
    const clientId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Optimistic: show bubble immediately + clear composer (commands show their answer instead)
    if (!isSlash && onOptimisticSend) onOptimisticSend(clientId, text, sentAttachments);
    setMessage('');
    // Reset textarea to one line after send
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setBusy(true);
    setResumeError(null);

    if (idleStopped && onDismissIdle) onDismissIdle();
    try {
      const res = await api.post(
        `/api/projects/${projectId}/workflows/${workflow.id}/message`,
        { message: text, attachmentIds: sentAttachments },
      );
      setAttachmentIds([]);
      setAttachmentReset(n => n + 1);
      if (res?.handled) {
        // The portal answered a command itself: show the answer, nothing runs.
        if (onCommandDone) onCommandDone();
        return;
      }
      if (isSlash && onOptimisticSend) onOptimisticSend(clientId, text);
      // Always ask the server to start: it does nothing when a run is already going. The page's own idea of
      // "running" can be out of date right after a run ends, and skipping the start left the message unanswered.
      if (!res?.resumed) {
        await api.post(
          `/api/projects/${projectId}/workflows/${workflow.id}/start`,
        ).catch((e) => {
          if (e?.status !== 409 && !isRunning) setResumeError(`Your message was saved, but the run did not start: ${e?.message || 'unknown error'}`);
        });
      }
      if (onSendSuccess) onSendSuccess(clientId);
      if (onSent) onSent();
    } catch (e) {
      if (onSendError) onSendError(clientId, e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e) => {
    // Skip during IME composition (Chinese, Japanese, Korean, etc.)
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (showMenu) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenuIdx((i) => (i + 1) % menuItems.length); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setMenuIdx((i) => (i - 1 + menuItems.length) % menuItems.length); return; }
      if (e.key === 'Escape')    { e.preventDefault(); setMessage(''); return; }
      const picked = menuItems[Math.min(menuIdx, menuItems.length - 1)];
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && picked.name !== typedCommand)) {
        e.preventDefault();
        pickCommand(picked);
        return;
      }
    }
    // Ctrl/Cmd+Enter → send (preserves old habit)
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
      return;
    }
    // Plain Enter (no Shift) → send
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }
    // Shift+Enter → new line (textarea default behaviour, no preventDefault)
  };

  const maxH         = Math.floor(window.innerHeight * 0.7);
  const ariaValueNow = composerH ?? (rowRef.current?.offsetHeight ?? 48);

  return (
    <div
      ref={composerRef}
      className={`ws-composer${composerH !== null ? ' ws-composer--manual' : ''}`}
    >
      {/* Drag handle — top edge. Drag up to grow, drag down to shrink.
          Double-click resets to auto-grow. */}
      <div
        className="ws-composer-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize message box"
        aria-valuenow={ariaValueNow}
        aria-valuemin={COMPOSER_MIN_H}
        aria-valuemax={maxH}
        tabIndex={0}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
        onLostPointerCapture={onHandlePointerCancel}
        onDoubleClick={onHandleDoubleClick}
        onKeyDown={onHandleKeyDown}
      />
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
      {resumeError && !(workflow?.resumable && !isRunning) && (
        <div className="error-note" role="alert" style={{ margin: '4px 8px' }}>{resumeError}</div>
      )}
      {workflow?.stop_reason === 'awaiting_message' && !isRunning && (
        <div className="ide-idle-banner" role="status">
          <span className="ide-idle-banner-msg">Ready. Send a message to continue this conversation.</span>
        </div>
      )}
      {workflow?.resumable && !isRunning && (
        <div className="ide-idle-banner" role="status">
          <span className="ide-idle-banner-msg">
            Reopen this conversation. The AI waits until you send a message.
          </span>
          {resumeError && (
            <span role="alert" style={{ fontSize: '0.78rem', color: 'var(--danger)', marginLeft: 4 }}>
              {resumeError}
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={handleResume}
            disabled={resuming}
            aria-label={`Resume session${workflow.title ? ': ' + workflow.title : ''}`}
            style={{ marginLeft: 'auto', flexShrink: 0 }}
          >
            {resuming ? 'Opening\u2026' : 'Resume'}
          </button>
        </div>
      )}
      {showMenu && (
        <ul className="ide-slash-menu" role="listbox" aria-label="Commands"
          style={{ listStyle: 'none', margin: 0, padding: '4px 0', borderTop: '1px solid var(--line)', maxHeight: 220, overflowY: 'auto' }}>
          {menuItems.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === menuIdx}
              onMouseDown={(e) => { e.preventDefault(); pickCommand(c); }}
              onMouseEnter={() => setMenuIdx(i)}
              style={{ display: 'flex', gap: 12, padding: '4px 12px', cursor: 'pointer', fontSize: '0.8rem',
                background: i === menuIdx ? 'var(--bg-3, rgba(127,127,127,.15))' : 'transparent' }}>
              <code style={{ minWidth: 150 }}>{c.usage}</code>
              <span style={{ color: 'var(--ink-3)', flex: 1, minWidth: 0 }}>{c.description}</span>
              {COMMAND_SOURCE_LABEL[c.source] && (
                <span style={{ color: 'var(--ink-3)', fontSize: '0.7rem', flexShrink: 0 }}>{COMMAND_SOURCE_LABEL[c.source]}</span>
              )}
            </li>
          ))}
        </ul>
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
          Type /help to see this session's commands, including your own commands and skills from Agent setup.
        </div>
      )}
      {showPanel && (
        <div className={`clone-panel${prep?.state === 'done' ? ' is-done' : ''}${prep?.state === 'failed' ? ' is-failed' : ''}`} role="status" aria-live="polite">
          <div className="clone-panel-head">
            <span className="clone-panel-title">
              {cloning && `Checking out ${total} ${total === 1 ? 'repository' : 'repositories'} · ${doneCount} of ${total} done`}
              {!cloning && prep?.state === 'done' && `✓ ${total === 1 ? 'Repository' : 'Repositories'} ready · ${doneCount} of ${total}`}
              {!cloning && prep?.state === 'failed' && `✗ ${failedCount || 'Some'} of ${total} could not be checked out`}
            </span>
            {cloning && <span className="clone-panel-pct">{overallPct}%</span>}
            {!cloning && <button type="button" className="btn-icon" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(true)} style={{ width: 22, height: 22 }}>×</button>}
          </div>
          {cloning && <div className="clone-bar clone-bar-total" data-state="working" data-known="yes"><i style={{ width: `${Math.max(2, overallPct)}%` }} /></div>}
          {items.map((i, n) => (
            <div key={i.name} className="clone-row">
              <div className="clone-row-line">
                <strong>{i.name}/</strong>
                <span className="muted">
                  {i.text}{i.detail ? ` · ${i.detail}` : ''}{items.length > 1 ? ` · repo ${n + 1} of ${items.length}` : ''}
                </span>
                {(i.state === 'working' && typeof i.percent === 'number') && <span className="clone-row-pct">{i.percent}%</span>}
                {i.state === 'done' && <span className="clone-row-pct">100%</span>}
              </div>
              <div className="clone-bar" data-state={i.state} data-known={typeof i.percent === 'number' ? 'yes' : 'no'}>
                <i style={i.state === 'working' && typeof i.percent === 'number' ? { width: `${Math.max(2, i.percent)}%` } : undefined} />
              </div>
            </div>
          ))}
          {!cloning && prep?.state === 'failed' && prep?.message && <div className="muted" style={{ fontSize: '0.76rem' }}>{prep.message}</div>}
          {cloning && <div className="muted" style={{ fontSize: '0.74rem', paddingTop: 2 }}>You can type once the repositories are ready. Git only reports the file total near the end (checking out files); before that the count is of objects.</div>}
        </div>
      )}
      <AttachmentPicker key={workflow?.id + '-' + attachmentReset} projectId={projectId}
        fileInputRef={attachmentInputRef} hideTrigger onAttachmentsChange={attachmentsChanged}
        disabled={busy || !workflow || cloning} maxFileBytes={2 * 1024 * 1024} maxTotalBytes={8 * 1024 * 1024} />
      {attachmentIds.length > 0 && <span className="field-hint">Up to 5 files · 2 MB each · 8 MB total</span>}
      <div className={`ws-composer-row${composerH !== null && composerH <= 56 ? ' ws-composer-row--compact' : ''}`} ref={rowRef} style={composerH !== null ? { height: composerH } : undefined}>
        <button
          type="button"
          className="btn-icon"
          title="Attach images or documents (up to 2 MB each)"
          aria-label="Attach file"
          onClick={() => attachmentInputRef.current?.click()}
          disabled={busy || !workflow || cloning || attachmentIds.length >= 5}
        >
          <Icon name="attach" size={16} />
        </button>
        <span className="ws-composer-prompt" aria-hidden="true">&gt;</span>
        <textarea
          ref={textareaRef}
          rows={1}
          className="ws-composer-input"
          placeholder={cloning ? 'Cloning the repositories…' : enginePlaceholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!workflow || cloning}
          data-paste-files="true"
          aria-label="Message"
        />
        <div className="ws-composer-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={send}
            disabled={busy || attachmentsBusy || (!message.trim() && !attachmentIds.length) || !workflow || cloning}
            aria-label="Send (Enter)"
            title="Send (Enter)"
          >
            {busy
              ? <span className="spinner" style={{ width: 14, height: 14 }} />
              : <Icon name="send" size={14} />}
          </button>
        </div>
      </div>
      <div className="ws-composer-hints" aria-hidden="true">
        <span><kbd>↵</kbd> send</span>
        <span><kbd>⇧</kbd><kbd>↵</kbd> new line</span>
        <span><kbd>/</kbd> commands</span>
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

  // Optimistic send — messages sent but not yet confirmed by the stream
  const [pendingMessages, setPendingMessages] = useState([]);
  // Bumped when a /command was answered, so the chat re-reads the saved conversation
  const [commandTick, setCommandTick] = useState(0);

  // Browser panel live state (updated from stream events)
  const [browserLiveData, setBrowserLiveData] = useState(null);
  const [browserPopped, setBrowserPopped] = useState(false); // pop-out to main area
  const browserAutoOpenedRef = useRef(false);
  // Ref used by handleRemovePending to avoid double-removal
  const matchedPendingRef = useRef(new Set());

  // Output files state
  const [outputFiles, setOutputFiles] = useState([]);
  const [outputFilesLoading, setOutputFilesLoading] = useState(false);
  const [outputVaultFolder, setOutputVaultFolder] = useState(null);
  // File being previewed via the Outputs panel "eye" button
  const [previewOutputFile, setPreviewOutputFile] = useState(null);
  // Briefly true after output-files.updated fires — flashes the Outputs activity button.
  const [outputsHighlight, setOutputsHighlight] = useState(false);
  const outputsHighlightTimer = useRef(null);

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

  // Clamp sidebarW whenever the viewport resizes so a value saved from a
  // wide desktop session can't leave the chat invisible on a narrow screen.
  useEffect(() => {
    const clamp = () => {
      const maxW = Math.max(140, Math.floor((window.innerWidth - 40) * 0.45));
      setSidebarW((w) => (w > maxW ? maxW : w));
    };
    window.addEventListener('resize', clamp, { passive: true });
    return () => window.removeEventListener('resize', clamp);
  }, []);

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

  // Fetch session output files
  const loadOutputFiles = useCallback(async () => {
    setOutputFilesLoading(true);
    try {
      const res = await api.get(`/api/workflows/${encodeURIComponent(id)}/output-files`);
      setOutputFiles(res.files ?? []);
      setOutputVaultFolder(res.vaultFolder ?? null);
    } catch {
      // Non-fatal: outputs panel shows empty state
    } finally {
      setOutputFilesLoading(false);
    }
  }, [id]);

  // Optimistic-send handlers
  const handleOptimisticSend = useCallback((clientId, text, attachmentIds = []) => {
    setPendingMessages((prev) => [
      ...prev,
      { clientId, text, attachmentIds, status: 'sending', sentAt: Date.now() },
    ]);
  }, []);

  const handleSendSuccess = useCallback((clientId) => {
    setPendingMessages((prev) =>
      prev.map((m) => m.clientId === clientId ? { ...m, status: 'sent' } : m),
    );
  }, []);

  const handleSendError = useCallback((clientId, errMsg) => {
    setPendingMessages((prev) =>
      prev.map((m) =>
        m.clientId === clientId ? { ...m, status: 'error', error: errMsg } : m,
      ),
    );
  }, []);

  const handleRemovePending = useCallback((clientId) => {
    setPendingMessages((prev) => prev.filter((m) => m.clientId !== clientId));
    matchedPendingRef.current?.delete(clientId);
  }, []);

  // Retry a failed pending message
  const handleRetryPending = useCallback(async (clientId) => {
    const msg = pendingMessages.find((m) => m.clientId === clientId);
    if (!msg) return;
    const wf = data?.workflow;
    if (!wf) return;

    setPendingMessages((prev) =>
      prev.map((m) =>
        m.clientId === clientId ? { ...m, status: 'sending', error: undefined } : m,
      ),
    );
    try {
      const res = await api.post(
        `/api/projects/${project.id}/workflows/${wf.id}/message`,
        { message: msg.text, attachmentIds: msg.attachmentIds ?? [] },
      );
      if (!res?.resumed) {
        await api.post(`/api/projects/${project.id}/workflows/${wf.id}/start`).catch(() => {});
      }
      setPendingMessages((prev) =>
        prev.map((m) => m.clientId === clientId ? { ...m, status: 'sent' } : m),
      );
      load();
    } catch (e) {
      setPendingMessages((prev) =>
        prev.map((m) =>
          m.clientId === clientId ? { ...m, status: 'error', error: e.message } : m,
        ),
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMessages, data, project.id, load]);

  // Browser event handler — updates live browser state and auto-opens panel once
  const handleBrowserEvent = useCallback((ev) => {
    setBrowserLiveData((prev) => {
      if (ev.type === 'browser-navigate') {
        return { ...prev, url: ev.payload?.url || prev?.url, recordedAt: new Date().toISOString() };
      }
      if (ev.type === 'browser-screenshot') {
        return {
          ...prev,
          url:              ev.payload?.url || prev?.url,
          screenshotBase64: ev.payload?.screenshotBase64 || prev?.screenshotBase64,
          recordedAt:       new Date().toISOString(),
        };
      }
      return prev;
    });
    // Open browser panel once on first browser event for this page visit
    if (!browserAutoOpenedRef.current) {
      browserAutoOpenedRef.current = true;
      setSidebarPanel('browser');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setTitle(null);
    setIdleStopped(null);
    load();
    loadOutputFiles();
  }, [load, loadOutputFiles]);

  // SSE project events
  useEffect(() => {
    const unsub = subscribeProject(project.id, (event) => {
      const reviewHref = reviewHandoffHref(event, id, project.id);
      if (reviewHref) { navigate(reviewHref); return; }
      if (event.type === 'workflow.renamed' && event.workflowId === id) {
        setTitle(event.title);
      }
      if (event.type === 'workflow.idle-stopped' && event.workflowId === id) {
        setIdleStopped(event.timeoutMinutes ?? '?');
        load();
      }
      if (
        (event.type === 'workflow.updated' && (event.workflowId ?? event.id) === id) ||
        event.type === 'run.updated'
      ) {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(load, 300);
        // Also refresh output files when a run completes / updates
        loadOutputFiles();
      }
      // Refresh transcript when a command result arrives in another tab
      if (event.type === 'workflow.command-result' && event.workflowId === id) {
        setCommandTick((k) => k + 1);
      }
      // Refresh output files when the backend signals new outputs for this workflow
      if (event.type === 'output-files.updated' && event.workflowId === id) {
        loadOutputFiles();
        // Briefly highlight the Outputs activity button — don't steal focus.
        setOutputsHighlight(true);
        clearTimeout(outputsHighlightTimer.current);
        outputsHighlightTimer.current = setTimeout(() => setOutputsHighlight(false), 2000);
      }
    });
    return () => { unsub(); clearTimeout(timerRef.current); clearTimeout(outputsHighlightTimer.current); };
  }, [project.id, id, load, loadOutputFiles]);

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
        onEngineSwitched={() => { load(); setCommandTick((t) => t + 1); }}
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
          {/* Outputs panel — session artifacts */}
          <ActivityBtn
            icon="outputs"
            label="Outputs"
            active={sidebarPanel === 'outputs'}
            badge={outputFiles.length}
            flash={outputsHighlight}
            onClick={() => setSidebarPanel((p) => p === 'outputs' ? null : 'outputs')}
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
              sidebarPanel === 'outputs'  ? 'Outputs' :
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
                 sidebarPanel === 'outputs'  ? 'Outputs' :
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
            {sidebarPanel === 'browser' && !browserPopped && (
              <IdeBrowser
                workflowId={id}
                projectId={project.id}
                liveData={browserLiveData}
                onPopOut={() => setBrowserPopped(true)}
              />
            )}
            {sidebarPanel === 'browser' && browserPopped && (
              <div className="idb-sidebar-popped-note">
                <Icon name="external" size={16} />
                <p>Browser is open in the main area</p>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setBrowserPopped(false)}
                >
                  Collapse
                </button>
              </div>
            )}
            {sidebarPanel === 'agents' && (
              <IdeAgents workflowId={id} projectId={project.id} workflow={workflow} />
            )}
            {sidebarPanel === 'outputs' && (
              <IdeOutputs
                outputFiles={outputFiles}
                loading={outputFilesLoading}
                workflowId={id}
                projectId={project.id}
                vaultFolder={outputVaultFolder}
                onPreview={(file) => setPreviewOutputFile(file)}
              />
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
        <div className="ide-main" style={{ position: 'relative' }}>
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
              style={{ flex: 1, borderLeft: 'none' }}
              aria-label="Agent conversation"
            >
              <SessionLive
                onOpenWorkspaceFile={async (path, line) => {
                  const resolved = await resolveConversationPath(api, id, path);
                  setOpenFile({ scope: 'work', path: resolved, name: resolved.split('/').pop(), ext: '.' + resolved.split('.').pop(), line, key: `work:${resolved}` });
                }}
                runId={latestRunId}
                workflowId={id}
                projectId={project.id}
                workflow={workflow}
                pendingMessages={pendingMessages}
                refreshKey={commandTick}
                onRemovePending={handleRemovePending}
                onRetryPending={handleRetryPending}
                onBrowserEvent={handleBrowserEvent}
                outputFiles={outputFiles}
                vaultFolder={outputVaultFolder}
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
              <IdeTerminal workflowId={id} engine={workflow?.engine} height={terminalH - 32} />
            </div>
          )}

          {/* Browser pop-out overlay — rendered in the main area */}
          {browserPopped && (
            <div className="idb-main-overlay" aria-label="Browser (expanded)">
              <IdeBrowser
                workflowId={id}
                projectId={project.id}
                liveData={browserLiveData}
                onPopIn={() => setBrowserPopped(false)}
                isPopped
              />
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <IdeStatusBar
        projectId={project.id}
        workflowId={id}
        engine={workflow?.engine}
        credentialId={workflow?.credential_id ?? null}
        onModelChanged={() => { load(); setCommandTick((k) => k + 1); }}
      />

      {/* Composer */}
      <ComposerBar
        workflow={workflow}
        projectId={project.id}
        onSent={load}
        idleStopped={idleStopped}
        onDismissIdle={() => setIdleStopped(null)}
        onOptimisticSend={handleOptimisticSend}
        onSendSuccess={handleSendSuccess}
        onSendError={handleSendError}
        onCommandDone={() => { load(); setCommandTick((k) => k + 1); }}
      />

      {/* Output file preview modal (opened from Outputs panel) */}
      {previewOutputFile && (
        <OutputFilePreview
          key={previewOutputFile.id}
          file={previewOutputFile}
          files={outputFiles}
          projectId={project.id}
          vaultFolder={outputVaultFolder}
          onClose={() => setPreviewOutputFile(null)}
        />
      )}
    </div>
  );
}
