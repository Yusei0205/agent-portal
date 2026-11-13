/**
 * IDE workspace header — title, inline rename, engine badge, stop button, more menu.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { SwitchEngineDialog } from './SwitchEngineDialog.jsx';
import { sessionTitle, hasOwnTitle, SHORT_TITLE_MAX } from '../../lib/session-title.js';

// ── Delegate-a-task dialog ────────────────────────────────────────────────────

/**
 * @param {{
 *   workflowId: string,
 *   projectId: string,
 *   engine: string,
 *   onClose: () => void,
 *   onDelegated: () => void,
 * }} props
 */
function DelegateDialog({ workflowId, projectId, engine, onClose, onDelegated }) {
  const [task, setTask]           = useState('');
  const [title, setTitle]         = useState('');
  const [leadAgent, setLeadAgent] = useState('');
  const [agents, setAgents]       = useState(null);
  const [settings, setSettings]   = useState(null);
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState(null);
  const taskRef = useRef(null);
  const trapRef = useFocusTrap();

  // Load delegation settings + available agents
  useEffect(() => {
    Promise.all([
      api.get('/api/admin/delegation').catch(() => null),
      engine && engine !== 'demo'
        ? api.get(`/api/user-config/agents?engine=${encodeURIComponent(engine)}`).catch(() => ({ agents: [] }))
        : Promise.resolve({ agents: [] }),
    ]).then(([s, a]) => {
      setSettings(s);
      setAgents(a?.agents || []);
    });
  }, [engine]);

  useEffect(() => { taskRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const delegationDisabled  = settings !== null && !settings.enabled;
  const disabledReason      = delegationDisabled
    ? 'Delegation is disabled by the portal administrator.'
    : null;

  const submit = async () => {
    if (!task.trim() || busy || delegationDisabled) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/projects/${projectId}/workflows/${workflowId}/delegate`, {
        task: task.trim(),
        title: title.trim() || undefined,
        leadAgent: leadAgent.trim() || undefined,
      });
      onDelegated();
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to delegate task');
      setBusy(false);
    }
  };

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
        aria-labelledby="delegate-dialog-title"
        style={{ maxWidth: 520 }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="delegate-dialog-title">Delegate a task</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="dialog-body stack">
          {disabledReason && (
            <div className="error-note" role="alert">{disabledReason}</div>
          )}

          {settings && !delegationDisabled && (
            <p className="muted" style={{ fontSize: '0.82rem' }}>
              A child session will be created with the same engine and workspace.
              Max {settings.maxRunningPerParent} running per parent, {settings.maxRunningPerUser} per user.
            </p>
          )}

          <div className="field">
            <label htmlFor="del-task">Task <span aria-hidden="true">*</span></label>
            <textarea
              id="del-task"
              ref={taskRef}
              rows={4}
              maxLength={8000}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe what the child session should accomplish…"
              aria-required="true"
              disabled={delegationDisabled}
            />
            <span className="field-hint" aria-live="polite">{task.length}/8000</span>
          </div>

          <div className="field">
            <label htmlFor="del-title">Title <span className="muted">(optional)</span></label>
            <input
              id="del-title"
              type="text"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short name for this child session"
              disabled={delegationDisabled}
            />
          </div>

          {agents !== null && agents.length > 0 && (
            <div className="field">
              <label htmlFor="del-agent">Lead agent <span className="muted">(optional)</span></label>
              <select
                id="del-agent"
                value={leadAgent}
                onChange={(e) => setLeadAgent(e.target.value)}
                disabled={delegationDisabled}
              >
                <option value="">Inherit from parent</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          {error && <div className="error-note" role="alert">{error}</div>}
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!task.trim() || busy || delegationDisabled}
          >
            {busy ? (
              <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Delegating…</>
            ) : (
              <>Delegate task</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main header ───────────────────────────────────────────────────────────────

/**
 * @param {{
 *   workflow: object | null,
 *   projectId: string,
 *   onStopped: () => void,
 *   onRenamed: (title: string) => void,
 *   onOpenBrowser: () => void,
 *   onDelegated?: () => void,
 *   onEngineSwitched?: (workflow: object) => void,
 *   integrationCount?: number,
 * }} props
 */
export function IdeHeader({
  workflow,
  projectId,
  onStopped,
  onRenamed,
  onOpenBrowser,
  onDelegated,
  onEngineSwitched,
  integrationCount = 0,
}) {
  const [renaming, setRenaming]       = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy]   = useState(false);
  const [renameError, setRenameError]   = useState('');
  const [stopping, setStopping]       = useState(false);
  const [menuOpen, setMenuOpen]       = useState(false);
  const [showDelegate, setShowDelegate] = useState(false);
  const [showSwitch, setShowSwitch]     = useState(false);
  const menuRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const startRename = () => {
    setRenameValue(sessionTitle(workflow));
    setRenameError('');
    setRenaming(true);
    setMenuOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const submitRename = async (e) => {
    e?.preventDefault();
    const title = renameValue.trim();
    if (!title || !workflow || title === sessionTitle(workflow)) { setRenaming(false); return; }
    setRenameBusy(true);
    setRenameError('');
    try {
      await api.patch(`/api/projects/${projectId}/workflows/${workflow.id}`, { title });
      onRenamed(title);
      setRenaming(false);
    } catch (err) {
      setRenameError(err?.message || 'Could not save the title.');
    } finally {
      setRenameBusy(false);
    }
  };

  const handleStop = async () => {
    if (!workflow) return;
    setStopping(true);
    setMenuOpen(false);
    try {
      await api.post(`/api/projects/${projectId}/workflows/${workflow.id}/cancel`);
      if (onStopped) onStopped();
    } catch { /* ignore */ }
    finally { setStopping(false); }
  };

  const openDelegate = () => {
    setMenuOpen(false);
    setShowDelegate(true);
  };

  const isRunning    = workflow?.status === 'running' || workflow?.status === 'pending';
  const title        = sessionTitle(workflow);
  const ownTitle     = hasOwnTitle(workflow);
  const engineLabel  = workflow?.engine === 'codex' ? 'Codex' : workflow?.engine === 'kiro' ? 'kiro' : workflow?.engine === 'claude-code' ? 'claude' : workflow?.engine ?? 'demo';
  const engineClass  = workflow?.engine === 'kiro' ? 'badge badge-engine-kiro' : workflow?.engine === 'claude-code' ? 'badge badge-engine-claude' : 'badge';

  return (
    <>
      <div className="ide-header" aria-label="Session header">
        <div className="ide-header-title-wrap">
          {renaming ? (
            <form className="ide-header-rename-form" onSubmit={submitRename} aria-label="Rename session">
              <input
                ref={inputRef}
                className="ide-header-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => !renameBusy && setRenaming(false)}
                onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(false); }}
                aria-label="Session title"
                placeholder="Short title"
                maxLength={SHORT_TITLE_MAX}
                disabled={renameBusy}
              />
              {renameError && <span className="error-note" role="alert" style={{ fontSize: '0.75rem' }}>{renameError}</span>}
              <button type="submit" className="btn btn-sm btn-primary" disabled={renameBusy} aria-label="Save name" onMouseDown={(e) => e.preventDefault()}>
                {renameBusy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="check" size={12} />}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(false)} aria-label="Cancel rename">
                <Icon name="x" size={12} />
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                className="ide-header-title ide-header-title-btn"
                onClick={startRename}
                title={ownTitle ? `${title}
Click to change the title` : 'Click to give this session a short title'}
                aria-label={`Session title: ${title}. Click to change it`}
              >
                <span className="ide-header-title-text">{title}</span>
                <Icon name="rename" size={12} />
              </button>
              {workflow?.engine && <span className={engineClass} style={{ fontSize: '0.69rem' }}>{engineLabel}</span>}
            </>
          )}
        </div>

        <div className="ide-header-actions">
          {/* Integrations count */}
          {integrationCount > 0 && (
            <span
              className="badge"
              style={{ fontSize: '0.72rem', cursor: 'default' }}
              title={`${integrationCount} integration${integrationCount !== 1 ? 's' : ''}`}
            >
              {integrationCount} MCP
            </span>
          )}

          {/* Browser button */}
          <button
            type="button"
            className="btn-icon"
            onClick={onOpenBrowser}
            aria-label="Toggle browser panel"
            title="Browser"
          >
            <Icon name="browser" size={15} />
          </button>

          {/* Stop button */}
          {isRunning && (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={handleStop}
              disabled={stopping}
              aria-label="Stop session"
              title="Stop session"
            >
              {stopping ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="stop" size={13} />}
              Stop
            </button>
          )}

          {/* More menu */}
          <div style={{ position: 'relative' }} ref={menuRef}>
            <button
              type="button"
              className="btn-icon"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="More session actions"
              title="More session actions"
            >
              <Icon name="more-horiz" size={15} />
            </button>
            {menuOpen && (
              <div
                className="account-menu-dropdown"
                role="menu"
                aria-label="Session actions"
                style={{ right: 0, minWidth: 200 }}
              >
                <button type="button" role="menuitem" className="account-menu-item" onClick={startRename}>
                  <Icon name="rename" size={14} />
                  Rename session
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="account-menu-item"
                  onClick={openDelegate}
                >
                  <Icon name="agents" size={14} />
                  Delegate a task…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="account-menu-item"
                  onClick={() => { setMenuOpen(false); setShowSwitch(true); }}
                  disabled={isRunning}
                  title={isRunning ? 'Stop the session, or wait for the turn to end, first' : 'Continue this session on another engine'}
                >
                  <Icon name="refresh" size={14} />
                  Switch engine…
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Switch engine dialog */}
      {showSwitch && workflow && (
        <SwitchEngineDialog
          workflow={workflow}
          projectId={projectId}
          onClose={() => setShowSwitch(false)}
          onSwitched={(w) => { if (onEngineSwitched) onEngineSwitched(w); }}
        />
      )}

      {/* Delegate dialog */}
      {showDelegate && workflow && (
        <DelegateDialog
          workflowId={workflow.id}
          projectId={projectId}
          engine={workflow.engine || 'demo'}
          onClose={() => setShowDelegate(false)}
          onDelegated={() => {
            if (onDelegated) onDelegated();
          }}
        />
      )}
    </>
  );
}
