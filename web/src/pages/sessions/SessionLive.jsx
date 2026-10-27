import { useCallback, useEffect, useRef, useState } from 'react';
import { useRunStream } from '../../lib/useRunStream.js';
import { api } from '../../lib/api.js';
import { formatCost } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';

// ── Event renderers ────────────────────────────────────────────────────────────

/**
 * Render a single run event based on its type.
 */
function RunEvent({ event, workflowId, runId, onResolved }) {
  const { type, payload } = event;

  if (type === 'assistant-text') {
    return (
      <div className="live-event live-assistant-text" role="log" aria-live="polite">
        <pre className="live-text-block" aria-label="Agent output">
          {payload.text || payload.content || ''}
        </pre>
      </div>
    );
  }

  if (type === 'tool-start') {
    const toolName = payload.tool || payload.name || 'Tool';
    const toolArg = payload.command || payload.path || payload.input || '';
    return (
      <div className="live-event live-tool-start" aria-label={`Tool call: ${toolName}`}>
        <span className="live-tool-name">{toolName}:</span>
        <span className="live-tool-arg muted">{typeof toolArg === 'string' ? toolArg : JSON.stringify(toolArg)}</span>
      </div>
    );
  }

  if (type === 'tool-end') {
    const toolName = payload.tool || payload.name || 'Tool';
    const result = payload.result ?? payload.output ?? '';
    return (
      <ExpandableToolResult toolName={toolName} result={result} />
    );
  }

  if (type === 'tool-blocked') {
    const reason = payload.reason || payload.command || 'Blocked';
    return (
      <div className="live-event live-tool-blocked" role="alert" aria-label="Blocked tool call">
        🚫 <strong>Blocked:</strong> {reason}
      </div>
    );
  }

  if (type === 'approval-request') {
    return (
      <ApprovalCard
        event={event}
        workflowId={workflowId}
        runId={runId}
        onResolved={onResolved}
      />
    );
  }

  if (type === 'run-complete') {
    const duration = payload.duration_ms ? `${(payload.duration_ms / 1000).toFixed(1)}s` : null;
    const cost = payload.cost_usd != null ? formatCost(payload.cost_usd) : null;
    return (
      <div className="live-event live-run-complete" role="status" aria-label="Run complete">
        <Icon name="check" size={16} />
        Done{duration ? ` in ${duration}` : ''}{cost ? ` · ${cost}` : ''}
      </div>
    );
  }

  if (type === 'run-failed') {
    const msg = payload.error || payload.message || 'Run failed';
    return (
      <div className="live-event live-run-failed" role="alert" aria-label="Run failed">
        <Icon name="warning" size={16} />
        {msg}
      </div>
    );
  }

  // Ignore cost-update — shown as a floating pill below
  return null;
}

function ExpandableToolResult({ toolName, result }) {
  const [open, setOpen] = useState(false);
  const preview =
    typeof result === 'string'
      ? result.slice(0, 120)
      : JSON.stringify(result).slice(0, 120);

  return (
    <div className="live-event live-tool-end">
      <button
        type="button"
        className="live-tool-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
        <span className="live-tool-name">{toolName}</span>
        {!open && <span className="muted live-tool-preview">{preview}</span>}
      </button>
      {open && (
        <pre className="live-tool-result">
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ApprovalCard({ event, workflowId, runId, onResolved }) {
  const payload = event.payload;
  const inputId = payload.inputId || payload.id || event.id;
  const description = payload.description || payload.command || payload.tool || 'Approval required';
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [resolutionLabel, setResolutionLabel] = useState('');

  const resolve = async (response, allowAll = false) => {
    setBusy(true);
    try {
      await api.post(`/api/projects/${workflowId}/workflows/${runId}/runs/${runId}/input`, {
        inputId,
        response,
        allowAll,
      });
      setResolved(true);
      setResolutionLabel(response === 'approve' ? (allowAll ? 'Approved all' : 'Approved') : 'Denied');
      if (onResolved) onResolved();
    } catch {
      setBusy(false);
    }
  };

  if (resolved) {
    return (
      <div className="live-event live-approval-resolved" aria-label="Approval resolved">
        <Icon name="check" size={14} />
        {resolutionLabel}: {description}
      </div>
    );
  }

  return (
    <div className="live-event live-approval-card" role="group" aria-label="Approval request">
      <div className="live-approval-desc">
        <Icon name="warning" size={14} />
        <strong>Approval required:</strong> {description}
      </div>
      <div className="live-approval-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => resolve('approve')}
          disabled={busy}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => resolve('approve', true)}
          disabled={busy}
          title="Approve this and all similar future requests"
        >
          Approve all
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={() => resolve('deny')}
          disabled={busy}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

// ── Running cost pill ──────────────────────────────────────────────────────────

function CostPill({ events }) {
  const last = [...events].reverse().find((e) => e.type === 'cost-update');
  if (!last) return null;
  const cost = last.payload?.cost_usd ?? last.payload?.total_usd;
  if (cost == null) return null;
  return (
    <div className="live-cost-pill" aria-label={`Running cost: ${formatCost(cost)}`}>
      {formatCost(cost)}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

/**
 * Live agent output pane.
 *
 * @param {{
 *   runId: string | null | undefined,
 *   workflowId: string,
 *   projectId: string,
 * }} props
 */
export function SessionLive({ runId, workflowId, projectId }) {
  const { events, connected, error } = useRunStream(runId);
  const scrollRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const userScrolled = useRef(false);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, autoScroll]);

  // Pause auto-scroll when user scrolls up
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && !userScrolled.current) {
      userScrolled.current = true;
      setAutoScroll(false);
    } else if (atBottom) {
      userScrolled.current = false;
      setAutoScroll(true);
    }
  }, []);

  if (!runId) {
    return (
      <div className="ws-placeholder" style={{ flex: 1 }}>
        <div className="ws-placeholder-icon">
          <Icon name="play" size={48} />
        </div>
        <p>Start a run to see live output</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-note" style={{ margin: 16 }} role="alert">
        {error}
      </div>
    );
  }

  return (
    <div className="live-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      {/* Connection indicator */}
      {runId && (
        <div
          className="live-connection-status"
          style={{
            padding: '4px 12px',
            fontSize: '0.75rem',
            borderBottom: '1px solid var(--line-2)',
            color: 'var(--ink-3)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}
        >
          <span
            className={`dot ${connected ? 'dot-running' : 'dot-stopped'}`}
            style={{ width: 6, height: 6 }}
            aria-hidden="true"
          />
          {connected ? 'Live' : 'Connecting…'}
        </div>
      )}

      {/* Event stream */}
      <div
        ref={scrollRef}
        className="live-scroll"
        onScroll={onScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}
        aria-live="polite"
        aria-label="Agent output"
        aria-atomic="false"
        aria-relevant="additions"
      >
        {events.length === 0 && connected && (
          <div className="ws-placeholder" style={{ padding: '32px 16px', color: 'var(--ink-3)' }}>
            <div className="spinner" style={{ width: 20, height: 20 }} aria-label="Waiting for agent output…" />
            <p style={{ marginTop: 8 }}>Waiting for agent output…</p>
          </div>
        )}

        {events.map((e, i) => (
          <RunEvent
            key={e.id ?? i}
            event={e}
            workflowId={workflowId}
            runId={runId}
            onResolved={undefined}
          />
        ))}
      </div>

      {/* Running cost overlay */}
      <CostPill events={events} />

      {/* Resume auto-scroll button */}
      {!autoScroll && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setAutoScroll(true);
            userScrolled.current = false;
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          style={{
            position: 'absolute',
            bottom: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 2,
          }}
          aria-label="Scroll to latest output"
        >
          <Icon name="chevronDown" size={14} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
