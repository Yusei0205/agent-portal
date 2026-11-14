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

const meterClass = (pct) => (pct >= 85 ? ' is-high' : pct >= 65 ? ' is-mid' : '');

/** "in 2h 10m", "in 3d 4h", or "now" for a Unix-seconds reset time. */
function formatReset(unixSeconds) {
  if (!unixSeconds) return null;
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const formatAmount = (n) => (n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2));

function Meter({ pct }) {
  return (
    <span className="ide-status-meter" aria-hidden="true">
      <span className={`ide-status-meter-fill${meterClass(pct)}`} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </span>
  );
}

/** One row of the usage panel: a label, a value and an optional meter. */
function UsageRow({ label, value, pct, hint }) {
  return (
    <div className="ide-usage-row">
      <span className="ide-usage-label">{label}</span>
      <span className="ide-usage-value">{value}</span>
      {typeof pct === 'number' && <Meter pct={pct} />}
      {hint && <span className="ide-usage-hint">{hint}</span>}
    </div>
  );
}

/**
 * The "usage" button and its panel: what this session has used (this turn, in total) and what is left of the plan it runs
 * on (5-hour and weekly windows, Kiro credits). The plan part is omitted, with the reason, when the engine cannot report it.
 */
function UsageButton({ bar, limits }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), bottom: Math.max(8, window.innerHeight - r.top + 6) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  const credits = bar?.usageUnit === 'credits';
  const turn = bar?.thisTurn;
  const session = bar?.thisSession;
  const fmt = credits ? formatCreditsSmall : formatCostSmall;
  const pick = (u) => (credits ? u?.credits : u?.costUsd) ?? null;
  const showTokens = bar?.engine !== 'kiro' && (session?.inputTokens || turn?.inputTokens);

  return (
    <span className="ide-status-pick" ref={rootRef}>
      <button
        type="button"
        className="ide-status-chip ide-status-chip-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Usage of this session and what is left of your plan"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ide-status-key">usage</span> <span aria-hidden="true">▾</span>
      </button>
      {open && pos && createPortal(
        <div className="ide-status-menu ide-usage-panel" ref={menuRef} role="dialog" aria-label="Usage" style={{ left: pos.left, bottom: pos.bottom }}>
          <div className="ide-usage-head">This session</div>
          <UsageRow label={credits ? 'Credits this turn' : 'Cost this turn'} value={fmt(pick(turn))} />
          <UsageRow label={credits ? 'Credits in total' : 'Cost in total'} value={fmt(pick(session))} />
          {showTokens && (
            <UsageRow label="Tokens in total" value={`${formatTokens(session?.inputTokens ?? null)} in / ${formatTokens(session?.outputTokens ?? null)} out`} />
          )}
          {typeof bar?.contextPercent === 'number' && (
            <UsageRow label="Context window" value={`${bar.contextPercent}% used`} pct={bar.contextPercent} />
          )}

          <div className="ide-usage-head">{limits?.plan ? `Your plan · ${limits.plan}` : 'Your plan'}</div>
          {limits === undefined && <div className="ide-status-menu-note">Loading…</div>}
          {limits === null && <div className="ide-status-menu-note">This session's sign-in has no plan limits.</div>}
          {limits?.credits && (
            <UsageRow
              label="Credits left"
              value={limits.credits.limit != null && limits.credits.remaining != null
                ? `${formatAmount(limits.credits.remaining)} of ${formatAmount(limits.credits.limit)}`
                : formatAmount(limits.credits.remaining)}
              hint={limits.credits.resetsAt ? `resets ${formatReset(limits.credits.resetsAt)}` : null}
            />
          )}
          {limits?.windows?.map((w) => (
            <UsageRow
              key={w.id}
              label={`${w.label} limit`}
              value={`${Math.round(100 - w.usedPercent)}% left`}
              pct={w.usedPercent}
              hint={`${Math.round(w.usedPercent)}% used${w.resetsAt ? ` · resets ${formatReset(w.resetsAt)}` : ''}`}
            />
          ))}
          {limits && limits.note && (
            <div className={`ide-status-menu-note${limits.available ? '' : ' ide-usage-unavailable'}`}>{limits.note}</div>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}

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

  // What is left of the plan: undefined while loading, null when the engine has none. It is a call to the provider, so it
  // is asked less often than the bar and again when the session is switched.
  const [limits, setLimits] = useState(undefined);
  useEffect(() => {
    let live = true;
    const loadLimits = () => api.get(`/api/projects/${projectId}/workflows/${workflowId}/limits`)
      .then((d) => { if (live) setLimits(d.limits ?? null); })
      .catch(() => { if (live) setLimits((prev) => (prev === undefined ? null : prev)); });
    setLimits(undefined);
    loadLimits();
    const t = setInterval(loadLimits, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [projectId, workflowId, engine]);

  const isKiro   = bar?.engine === 'kiro';
  const turn     = bar?.thisTurn;
  const session  = bar?.thisSession;
  const noTokens = isKiro || (!turn?.inputTokens && !session?.inputTokens);
  const approvalMode = bar?.toolApprovalMode;

  const engineLabel = bar?.engine === 'kiro' ? 'KIRO' : bar?.engine === 'claude-code' ? 'CLAUDE' : (bar?.engine ? String(bar.engine).toUpperCase() : null);

  return (
    <div className="ide-status-bar" aria-label="Status bar" role="status">
      <div className="ide-status-row">
      {engineLabel && <span className="ide-status-engine">{engineLabel}</span>}
      {bar?.signIn && (
        <span
          className={`ide-status-signin ide-status-signin--${bar.signIn.kind}`}
          title={`Runs on: ${bar.signIn.detail}`}
        >
          {bar.signIn.label}
        </span>
      )}
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
      {/* Plan limits and credits get a row of their own, so they are never cut off on a long first row. */}
      {bar && (
        <div className="ide-status-row ide-status-row--usage" aria-label="Usage">
      {limits?.available && limits.credits?.remaining != null && (
        <span className="ide-status-chip" title={`Credits left on your ${limits.plan ?? ''} account`.replace('  ', ' ')}>
          <span className="ide-status-key">left</span> {formatAmount(limits.credits.remaining)}{limits.credits.limit != null && <> / {formatAmount(limits.credits.limit)}</>}
        </span>
      )}
      {limits?.available && limits.windows.slice(0, 4).map((w) => (
        <span
          key={w.id}
          className="ide-status-chip ide-status-ctx"
          title={`${Math.round(100 - w.usedPercent)}% of your ${w.label.toLowerCase()} limit is left${w.resetsAt ? `; resets ${formatReset(w.resetsAt)}` : ''}`}
        >
          <span className="ide-status-key">{w.label.toLowerCase()}</span> {Math.round(100 - w.usedPercent)}% left
          <Meter pct={w.usedPercent} />
        </span>
      ))}
      {bar && <UsageButton bar={bar} limits={limits} />}
        </div>
      )}
    </div>
  );
}
