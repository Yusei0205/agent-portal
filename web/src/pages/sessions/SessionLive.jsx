import { useCallback, useEffect, useRef, useState } from 'react';
import { useRunStream } from '../../lib/useRunStream.js';
import { api } from '../../lib/api.js';
import { formatCost } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { sanitizeMarkdown } from '../../lib/sanitize.js';
import { mergeConsecutiveAssistantText } from '../../lib/mergeEvents.js';

// ── Markdown renderer ─────────────────────────────────────────────────────────

// Module-level cache so the library is only fetched once across all renders.
let _markedLib = null;
let _markedLoadPromise = null;

function loadMarked() {
  if (_markedLib) return Promise.resolve(_markedLib);
  if (_markedLoadPromise) return _markedLoadPromise;
  _markedLoadPromise = import('marked')
    .then(({ marked }) => { _markedLib = marked; return marked; })
    .catch(() => null);
  return _markedLoadPromise;
}

function renderMarkdownToHtml(text) {
  if (!_markedLib || !text) return null;
  const raw = typeof _markedLib === 'function'
    ? _markedLib(text, { gfm: true, breaks: true })
    : _markedLib.parse(text, { gfm: true, breaks: true });
  // Sanitize with DOMPurify — strips event handlers, dangerous tags/URLs,
  // and style injection.  Regex replacements are insufficient for this job.
  return sanitizeMarkdown(String(raw));
}

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Renders agent text as markdown HTML.
 * Falls back to a <pre> block while `marked` is loading or on parse error.
 */
function MarkdownMessage({ text }) {
  const [html, setHtml] = useState(() => renderMarkdownToHtml(text));

  useEffect(() => {
    if (!text) { setHtml(''); return; }
    const rendered = renderMarkdownToHtml(text);
    if (rendered !== null) {
      setHtml(rendered);
      return;
    }
    // marked not yet loaded — load it then render
    let cancelled = false;
    loadMarked().then(() => {
      if (!cancelled) setHtml(renderMarkdownToHtml(text) ?? _escapeHtml(text));
    });
    return () => { cancelled = true; };
  }, [text]);

  if (html === null) {
    // Fallback while marked loads
    return <pre className="live-text-block">{text}</pre>;
  }
  return (
    <div
      className="live-markdown-body"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Transcript normalisation ────────────────────────────────────────────────

/**
 * The /transcript endpoint returns events with shape:
 *   { src, id, kind, payload, run_id, created_at }
 *
 * RunEvent expects `type` (not `kind`), and for workflow events (src='w')
 * the payload is a raw string rather than a JSON object.
 * This function normalises both so RunEvent can render all events uniformly.
 */
function normaliseTranscriptEvent(ev) {
  return {
    ...ev,
    // Normalise kind → type (transcript uses 'kind'; SSE stream uses 'type')
    type: ev.type ?? ev.kind,
    // Workflow events (src='w') have a string body; wrap it so RunEvent can
    // read payload.text / payload.body consistently.
    payload:
      typeof ev.payload === 'string'
        ? { text: ev.payload, body: ev.payload }
        : ev.payload ?? {},
  };
}

// ── Slash-command event ───────────────────────────────────────────────────────

function SlashCommandEvent({ event }) {
  const cmd    = event.payload?.command || event.payload?.text || '';
  const result = event.payload?.result || event.payload?.output || '';
  const user   = event.payload?.user || 'user';
  return (
    <div className="live-slash-command" role="log" aria-label={`Slash command: ${cmd}`}>
      <Icon name="slash" size={13} aria-hidden="true" />
      <span>
        <strong>{user}</strong> ran the command{' '}
        <span className="live-slash-command-label">{cmd}</span>
      </span>
      {result && (
        <pre className="live-slash-command-result">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>
      )}
    </div>
  );
}

// ── Event renderers ────────────────────────────────────────────────────────────

/**
 * Render a single run event based on its type.
 */
function RunEvent({ event, workflowId, projectId, runId, onResolved, agentName = 'Agent' }) {
  const { type, payload } = event;

  // User / human message — stored in p6_workflow_events with kind='human'.
  // Transcript events normalise kind→type before reaching here; payload may
  // be a string (raw body from workflow events) or an object.
  if (type === 'human') {
    const text = typeof payload === 'string'
      ? payload
      : (payload?.text ?? payload?.body ?? payload?.message ?? '');
    if (!text) return null;
    return (
      <div className="live-event live-human-message" role="log" aria-label="Your message">
        <div className="live-user-message-wrap">
          <span className="live-message-label live-message-label--user" aria-hidden="true">You</span>
          <div className="live-user-bubble">{text}</div>
        </div>
      </div>
    );
  }

  if (type === 'slash-command' || type === 'workflow.command') {
    return <SlashCommandEvent event={event} />;
  }

  if (type === 'assistant-text') {
    const text = payload.text || payload.content || '';
    if (!text) return null;
    return (
      <div className="live-event live-agent-message" role="log" aria-live="polite">
        <span className="live-message-label live-message-label--agent" aria-hidden="true">{agentName}</span>
        <div className="live-agent-bubble" aria-label="Agent output">
          <MarkdownMessage text={text} />
        </div>
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
        projectId={projectId}
        runId={runId}
        onResolved={onResolved}
      />
    );
  }

  // child-result — a delegated child session finished
  if (type === 'child-result' || event.kind === 'child-result') {
    const data = payload?.childTitle !== undefined ? payload : (
      (() => { try { return JSON.parse(payload?.body ?? event.body ?? '{}'); } catch { return {}; } })()
    );
    const childTitle  = payload?.childTitle ?? data?.childTitle ?? 'Child session';
    const childStatus = payload?.status ?? data?.status ?? 'done';
    const summary     = payload?.summary ?? data?.summary ?? payload?.body ?? event.body ?? '';
    const statusColor = childStatus === 'done' ? 'var(--ok)' : 'var(--danger)';
    return (
      <div
        className="live-event"
        style={{
          border: '1px solid color-mix(in srgb, var(--ok) 30%, transparent)',
          background: 'var(--ok-wash)',
          borderRadius: 'var(--radius)',
          margin: '8px 12px',
          padding: '8px 12px',
        }}
        role="log"
        aria-label={`Child session finished: ${childTitle}`}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: summary ? 4 : 0 }}>
          <Icon name="check" size={14} style={{ color: statusColor, flexShrink: 0 }} />
          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
            Child session &ldquo;{childTitle}&rdquo; finished:{' '}
            <span style={{ color: statusColor }}>{childStatus}</span>
          </span>
        </div>
        {summary && (
          <pre style={{ margin: 0, fontSize: '0.8rem', whiteSpace: 'pre-wrap', color: 'var(--ink-2)', paddingLeft: 22 }}>
            {summary}
          </pre>
        )}
      </div>
    );
  }

  // subagent-nudge — reminder to delegate when many subagents running
  if (type === 'subagent-nudge') {
    const msg = payload?.message || payload?.text || 'Consider delegating heavy work to child sessions.';
    return (
      <div
        className="live-event"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '6px 12px',
          fontSize: '0.8rem',
          color: 'var(--ink-3)',
          margin: '4px 8px',
          background: 'var(--canvas-2)',
          borderRadius: 'var(--radius)',
        }}
        role="note"
        aria-label="Subagent nudge"
      >
        <Icon name="agents" size={13} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>{msg}</span>
      </div>
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

function ApprovalCard({ event, workflowId, projectId, runId, onResolved }) {
  const payload = event.payload;
  const inputId = payload.inputId || payload.id || event.id;
  const description = payload.description || payload.command || payload.tool || 'Approval required';
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [resolutionLabel, setResolutionLabel] = useState('');

  const resolve = async (response, allowAll = false) => {
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/workflows/${workflowId}/runs/${runId}/input`, {
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
 *   workflow?: object | null,
 * }} props
 */
export function SessionLive({ runId, workflowId, projectId, workflow }) {
  const { events, connected, error } = useRunStream(runId);
  const scrollRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const userScrolled = useRef(false);

  // Transcript paging — load earlier turns
  const [earlierEvents, setEarlierEvents] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [loadedInitialTranscript, setLoadedInitialTranscript] = useState(false);

  // Derive a human-readable agent label from the workflow engine field.
  const agentName = workflow?.engine === 'kiro' ? 'Kiro'
    : workflow?.engine === 'claude-code' ? 'Claude'
    : (workflow?.engine ? String(workflow.engine) : 'Agent');

  // Merge consecutive assistant-text events so they render as one bubble.
  const displayEvents = mergeConsecutiveAssistantText(events);
  // The live stream (useRunStream) replays every event of the current run, so
  // drop that run's events from the transcript page to avoid showing them twice.
  const displayEarlierEvents = mergeConsecutiveAssistantText(
    earlierEvents.filter((e) => !(runId && e.run_id && e.run_id === runId)),
  );
  // The first message is stored as the workflow goal, not as a 'human' event.
  // Show it as the opening user bubble once the oldest page is loaded.
  const goalText = typeof workflow?.goal === 'string' ? workflow.goal.trim() : '';
  const showGoal = Boolean(goalText) && loadedInitialTranscript && !nextCursor;

  // Load the initial page of the transcript once
  useEffect(() => {
    if (!workflowId || !projectId || loadedInitialTranscript) return;
    setLoadedInitialTranscript(true);
    api.get(`/api/projects/${projectId}/workflows/${workflowId}/transcript?limit=50`)
      .then((data) => {
        if (data.events && data.events.length > 0) {
          // Transcript events use 'kind' (not 'type') and workflow events
          // (src='w') carry a raw string payload instead of a JSON object.
          // Normalise both so RunEvent can render them uniformly.
          const normalised = data.events.map(normaliseTranscriptEvent);
          setEarlierEvents(normalised.reverse()); // newest-first → oldest first
          setNextCursor(data.nextCursor ?? null);
        }
      })
      .catch(() => { /* endpoint not ready yet — ignore */ });
  }, [workflowId, projectId, loadedInitialTranscript]);

  const loadEarlier = async () => {
    if (!nextCursor || loadingEarlier) return;
    setLoadingEarlier(true);
    // Preserve scroll position
    const el = scrollRef.current;
    const scrollBottom = el ? el.scrollHeight - el.scrollTop : 0;

    try {
      const data = await api.get(
        `/api/projects/${projectId}/workflows/${workflowId}/transcript?limit=50&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setEarlierEvents((prev) => [...(data.events ?? []).map(normaliseTranscriptEvent).reverse(), ...prev]);
      setNextCursor(data.nextCursor ?? null);
      // Restore scroll position to avoid jumping
      if (el) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - scrollBottom;
        });
      }
    } catch { /* ignore */ }
    finally { setLoadingEarlier(false); }
  };

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
        {/* Load earlier turns */}
        {nextCursor && (
          <div className="ide-load-more">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={loadEarlier}
              disabled={loadingEarlier}
              aria-label="Load earlier turns"
            >
              {loadingEarlier
                ? <span className="spinner" style={{ width: 12, height: 12 }} />
                : <Icon name="chevron-up" size={13} />}
              {loadingEarlier ? 'Loading…' : '↑ Load earlier turns'}
            </button>
          </div>
        )}

        {/* Opening message (the session goal) */}
        {showGoal && (
          <div className="live-event live-human-message" role="log" aria-label="User message">
            <div className="live-user-bubble">{goalText}</div>
          </div>
        )}

        {/* Earlier (paged) events */}
        {displayEarlierEvents.map((e, i) => (
          <RunEvent
            key={e.id ?? `earlier-${i}`}
            event={e}
            workflowId={workflowId}
            projectId={projectId}
            runId={e.run_id ?? runId}
            agentName={agentName}
            onResolved={undefined}
          />
        ))}

        {events.length === 0 && connected && earlierEvents.length === 0 && (
          <div className="ws-placeholder" style={{ padding: '32px 16px', color: 'var(--ink-3)' }}>
            <div className="spinner" style={{ width: 20, height: 20 }} aria-label="Waiting for agent output…" />
            <p style={{ marginTop: 8 }}>Waiting for agent output…</p>
          </div>
        )}

        {displayEvents.map((e, i) => (
          <RunEvent
            key={e.id ?? i}
            event={e}
            workflowId={workflowId}
            projectId={projectId}
            runId={runId}
            agentName={agentName}
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
