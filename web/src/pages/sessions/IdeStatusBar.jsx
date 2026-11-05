/**
 * IDE Status bar — shows agent, tokens, cost, tool approval mode.
 * Fetches from GET /api/projects/:pid/workflows/:wid/status-bar (handle 404 gracefully).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

function formatCostSmall(usd) {
  if (usd == null) return '—';
  if (usd < 0.01) return '<$0.01';
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

/**
 * @param {{
 *   projectId: string,
 *   workflowId: string,
 * }} props
 */
export function IdeStatusBar({ projectId, workflowId }) {
  const [bar, setBar] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/api/projects/${projectId}/workflows/${workflowId}/status-bar`);
      setBar(data);
    } catch {
      // 404 = endpoint not built yet, or no data — show minimal bar
      setBar(null);
    }
  }, [projectId, workflowId]);

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
      {bar?.model && (
        <span className="ide-status-chip ide-status-model" title="Model"><span className="ide-status-key">model</span> {bar.model}</span>
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
        </span>
      ) : (
        <span className="ide-status-chip" title="Cost this turn and in total">
          <span className="ide-status-key">cost</span> {formatCostSmall(turn?.costUsd ?? null)} · {formatCostSmall(session?.costUsd ?? null)} total
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
