/**
 * IDE Status bar — shows agent, tokens, cost, tool approval mode.
 * Fetches from GET /api/projects/:pid/workflows/:wid/status-bar (handle 404 gracefully).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api.js';

function formatCostSmall(usd) {
  if (usd == null) return '—';
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatCreditsSmall(credits) {
  if (credits == null) return '—';
  if (credits > 0 && credits < 0.01) return '<0.01';
  return credits.toFixed(2);
}

function formatTokens(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const SWITCHABLE = new Set(['kiro', 'claude-code', 'codex']);

/**
 * The model chip. In a Kiro, Claude Code or Codex session it opens a list of the models the session can use;
 * choosing one is the same as typing "/model <name>" (the portal checks access and records the change in the chat).
 */
function ModelChip({ projectId, workflowId, engine, credentialId, model, onChanged }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);
  const switchable = SWITCHABLE.has(engine);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // The status bar clips whatever is inside it (overflow: hidden), so the list is drawn on the page itself
  // and placed just above the chip. It follows the chip when the window is resized or scrolled.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 248)), bottom: Math.max(8, window.innerHeight - r.top + 6) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  // The list depends on the session's sign-in, so it is loaded when the picker opens, not with the bar.
  useEffect(() => {
    if (!open) return;
    setModels(null); setError(null);
    const qs = credentialId ? `?credentialId=${encodeURIComponent(credentialId)}` : '';
    api.get(`/api/engines/${encodeURIComponent(engine)}/models${qs}`)
      .then((d) => { setModels(d.models ?? []); if (!(d.models ?? []).length && d.error) setError(d.error); })
      .catch((e) => setError(e.message || 'Could not load models'));
  }, [open, engine, credentialId]);

  const choose = async (id) => {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/projects/${projectId}/workflows/${workflowId}/message`, { message: `/model ${id}` });
      setOpen(false);
      onChanged?.();
    } catch (e) { setError(e.message || 'Could not switch the model'); }
    finally { setBusy(false); }
  };

  if (!switchable) {
    return <span className="ide-status-chip ide-status-model" title="Model"><span className="ide-status-key">model</span> {model}</span>;
  }
  return (
    <span className="ide-status-pick" ref={rootRef}>
      <button
        type="button"
        className="ide-status-chip ide-status-model ide-status-chip-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change the model for the next message"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ide-status-key">model</span> {model || 'default'} <span aria-hidden="true">▾</span>
      </button>
      {open && pos && createPortal(
        <div className="ide-status-menu" ref={menuRef} role="listbox" aria-label="Models" style={{ left: pos.left, bottom: pos.bottom }}>
          {models === null && !error && <div className="ide-status-menu-note">Loading models…</div>}
          {error && <div className="ide-status-menu-note ide-status-menu-error" role="alert">{error}</div>}
          {models && models.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === model}
              className={`ide-status-menu-item${m.id === model ? ' is-current' : ''}`}
              disabled={busy}
              onClick={() => (m.id === model ? setOpen(false) : choose(m.id))}
            >
              <span>{m.label && m.label !== m.id ? m.label : m.id}</span>
              {m.label && m.label !== m.id && <span className="ide-status-menu-id">{m.id}</span>}
            </button>
          ))}
          {models && models.length > 0 && (
            <button type="button" className="ide-status-menu-item ide-status-menu-default" disabled={busy} onClick={() => choose('default')}>
              Use the engine default
            </button>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}

/**
 * @param {{
 *   projectId: string,
 *   workflowId: string,
 *   engine?: string,   — the session's engine; the bar reloads when it changes
 *   credentialId?: string | null,  — the session's sign-in, which decides the models it can use
 *   onModelChanged?: () => void,   — called after the model was switched, so the chat shows the confirmation
 * }} props
 */
export function IdeStatusBar({ projectId, workflowId, engine, credentialId, onModelChanged }) {
  const [bar, setBar] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/api/projects/${projectId}/workflows/${workflowId}/status-bar`);
      setBar(data);
    } catch {
      // 404 = endpoint not built yet, or no data — show minimal bar
      setBar(null);
    }
  }, [projectId, workflowId, engine]); // engine: reload at once when the session is switched to another engine

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const isKiro   = bar?.engine === 'kiro';
  const turn     = bar?.thisTurn;
  const session  = bar?.thisSession;
  const noTokens = isKiro || (!turn?.inputTokens && !session?.inputTokens);
  const approvalMode = bar?.toolApprovalMode;

  const engineLabel = bar?.engine === 'kiro' ? 'KIRO' : bar?.engine === 'claude-code' ? 'CLAUDE' : (bar?.engine ? String(bar.engine).toUpperCase() : null);

  return (
    <div className="ide-status-bar" aria-label="Status bar" role="status">
      {engineLabel && <span className="ide-status-engine">{engineLabel}</span>}
      {(bar?.model || SWITCHABLE.has(bar?.engine)) && (
        <ModelChip
          projectId={projectId}
          workflowId={workflowId}
          engine={bar.engine ?? engine}
          credentialId={credentialId}
          model={bar.model ?? ''}
          onChanged={() => { load(); onModelChanged?.(); }}
        />
      )}
      {typeof bar?.contextPercent === 'number' && (
        <span className="ide-status-chip ide-status-ctx" title={`${bar.contextPercent}% of the model's context window is in use`}>
          <span className="ide-status-key">ctx</span> {bar.contextPercent}%
          <span className="ide-status-meter" aria-hidden="true">
            <span
              className={`ide-status-meter-fill${bar.contextPercent >= 85 ? ' is-high' : bar.contextPercent >= 65 ? ' is-mid' : ''}`}
              style={{ width: `${Math.max(2, Math.min(100, bar.contextPercent))}%` }}
            />
          </span>
        </span>
      )}
      {bar?.agent && (
        <span className="ide-status-chip" title="Agent"><span className="ide-status-key">agent</span> {bar.agent}</span>
      )}
      {!noTokens && (
        <span className="ide-status-chip" title="Tokens this turn">
          <span className="ide-status-key">tokens</span> {formatTokens(turn?.inputTokens ?? null)} in / {formatTokens(turn?.outputTokens ?? null)} out
        </span>
      )}
      {bar?.usageUnit === 'credits' ? (
        // Kiro bills in credits, not dollars
        <span className="ide-status-chip" title="Kiro credits used this turn and in total">
          <span className="ide-status-key">credits</span> {formatCreditsSmall(turn?.credits ?? null)} · {formatCreditsSmall(session?.credits ?? null)} total
          {session?.costUsd > 0 && <> + {formatCostSmall(session.costUsd)} on another engine</>}
        </span>
      ) : (
        <span className="ide-status-chip" title="Cost this turn and in total">
          <span className="ide-status-key">cost</span> {formatCostSmall(turn?.costUsd ?? null)} · {formatCostSmall(session?.costUsd ?? null)} total
          {/* A session switched from Kiro keeps the credits it used there */}
          {session?.credits > 0 && <> + {formatCreditsSmall(session.credits)} Kiro credits</>}
        </span>
      )}
      <span className="ide-status-spacer" />
      {approvalMode && (
        <span className={`ide-status-pill${approvalMode === 'trust-all' ? ' ide-status-pill--warn' : ''}`}>
          {approvalMode === 'trust-all' ? 'trust all tools' : 'ask before tool use'}
        </span>
      )}
    </div>
  );
}
