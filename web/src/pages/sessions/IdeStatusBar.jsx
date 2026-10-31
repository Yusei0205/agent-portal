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

  return (
    <div className="ide-status-bar" aria-label="Status bar" role="status">
      {bar?.agent && (
        <div className="ide-status-item">
          <span>Agent: {bar.agent}</span>
        </div>
      )}
      {bar?.model && (
        <div className="ide-status-item ide-status-model" title="Model">
          <span>{bar.model}</span>
        </div>
      )}
      <div className="ide-status-item" title={noTokens ? (isKiro ? 'Kiro does not report token counts' : undefined) : undefined}>
        <span>
          Tokens:{' '}
          {noTokens
            ? '—'
            : `${formatTokens(turn?.inputTokens ?? null)} in / ${formatTokens(turn?.outputTokens ?? null)} out`}
        </span>
      </div>
      <div className="ide-status-item">
        <span>
          Cost: {formatCostSmall(turn?.costUsd ?? null)} this turn ·{' '}
          {formatCostSmall(session?.costUsd ?? null)} total
        </span>
      </div>
      {approvalMode && (
        <div className="ide-status-item">
          <span>{approvalMode === 'trust-all' ? 'Trust all tools' : 'Ask before tool use'}</span>
        </div>
      )}
    </div>
  );
}
