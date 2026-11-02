import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRunStream } from '../../lib/useRunStream.js';
import { api } from '../../lib/api.js';
import { formatCost } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { sanitizeMarkdown } from '../../lib/sanitize.js';
import { mergeConsecutiveAssistantText, collectThoughtParagraphs, mergeEventLists } from '../../lib/mergeEvents.js';
import { findOutputFileMentions } from '../../lib/outputFileMatch.js';
import { OutputFilePreview } from './OutputFilePreview.jsx';
import { RunOutputsCard } from './RunOutputsCard.jsx';

// ── Markdown renderer ─────────────────────────────────────────────────────────

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
  return sanitizeMarkdown(String(raw));
}

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Walk a DOM subtree and wrap text nodes containing output-file paths with
 * <button data-output-file-id="..."> elements. Skips <pre> subtrees (code blocks).
 * Modifies the DOM in place — called after safe HTML is written to the container.
 *
 * @param {Element} container
 * @param {Array<{id: string, path: string, name: string}>} outputFiles
 */
function linkifyDomOutputFiles(container, outputFiles) {
  if (!outputFiles.length) return;

  /**
   * Walk child nodes of `node`, skipping <pre> subtrees.
   * @param {Node} node
   */
  function walk(node) {
    // Skip <pre> (code block) subtrees entirely
    if (node.nodeType === 1 && node.nodeName === 'PRE') return;

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        // TEXT_NODE — check for path mentions
        replaceTextNode(/** @type {Text} */ (child));
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  }

  /**
   * Replace a text node that contains at least one output-file mention with a
   * mix of text nodes and <button> elements.
   * @param {Text} textNode
   */
  function replaceTextNode(textNode) {
    const text = textNode.textContent ?? '';
    const mentions = findOutputFileMentions(text, outputFiles);
    if (!mentions.length) return;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const { start, end, file } of mentions) {
      if (start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, start)));
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'output-file-link';
      btn.dataset.outputFileId = file.id;
      btn.setAttribute('aria-label', `Preview output file: ${file.name}`);
      btn.textContent = text.slice(start, end);
      frag.appendChild(btn);
      cursor = end;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }

  walk(container);
}

/**
 * MarkdownMessage renders agent text as sanitized markdown.
 * When `outputFiles` is provided, file path mentions become clickable
 * <button> elements that open the OutputFilePreview modal.
 *
 * @param {{
 *   text: string,
 *   outputFiles?: Array<{id: string, path: string, name: string,
 *                        download_url: string, preview_url: string,
 *                        vault_file_id: string | null}>,
 *   projectId?: string,
 *   vaultFolder?: string | null,
 * }} props
 */
function MarkdownMessage({ text, outputFiles = [], projectId, vaultFolder }) {
  const [html, setHtml] = useState(() => renderMarkdownToHtml(text));
  const containerRef = useRef(null);
  const [previewFile, setPreviewFile] = useState(null);

  useEffect(() => {
    if (!text) { setHtml(''); return; }
    const rendered = renderMarkdownToHtml(text);
    if (rendered !== null) { setHtml(rendered); return; }
    let cancelled = false;
    loadMarked().then(() => {
      if (!cancelled) setHtml(renderMarkdownToHtml(text) ?? _escapeHtml(text));
    });
    return () => { cancelled = true; };
  }, [text]);

  // After the HTML is written to the DOM, linkify output-file path mentions.
  // We run this inside a layout effect (useEffect) so the DOM is already updated.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !outputFiles.length) return;
    linkifyDomOutputFiles(container, outputFiles);
  // Re-run whenever HTML or outputFiles list changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, outputFiles]);

  const handleClick = useCallback((e) => {
    const btn = e.target.closest('[data-output-file-id]');
    if (!btn) return;
    e.preventDefault();
    const fileId = btn.dataset.outputFileId;
    const file = outputFiles.find((f) => f.id === fileId);
    if (file) setPreviewFile(file);
  }, [outputFiles]);

  return (
    <>
      {html === null
        ? <pre className="live-text-block">{text}</pre>
        : (
          <div
            ref={containerRef}
            className="live-markdown-body"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={outputFiles.length ? handleClick : undefined}
          />
        )
      }
      {previewFile && (
        <OutputFilePreview
          file={previewFile}
          projectId={projectId ?? ''}
          vaultFolder={vaultFolder ?? null}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </>
  );
}

// ── Event pre-processing ──────────────────────────────────────────────────────

/**
 * Pair tool-start / tool-end events by toolCallId (new protocol) or tool name
 * (older protocol).  Each tool-start gets an `_end` property; matched tool-end
 * events are removed from the returned array so RunEvent never sees them.
 */
function pairToolEvents(events) {
  const result = [];
  const pendingById   = new Map(); // toolCallId → result-array index
  const pendingByName = new Map(); // toolName   → [result-array index] (FIFO)

  for (const ev of events) {
    if (ev.type === 'tool-start') {
      const callId = ev.payload?.toolCallId;
      const name   = ev.payload?.toolName || ev.payload?.tool || ev.payload?.name;
      const idx    = result.length;
      result.push({ ...ev, _end: null });
      if (callId) {
        pendingById.set(callId, idx);
      } else if (name) {
        if (!pendingByName.has(name)) pendingByName.set(name, []);
        pendingByName.get(name).push(idx);
      }
    } else if (ev.type === 'tool-end') {
      const callId = ev.payload?.toolCallId;
      const name   = ev.payload?.toolName || ev.payload?.tool || ev.payload?.name;
      if (callId && pendingById.has(callId)) {
        const idx = pendingById.get(callId);
        result[idx] = { ...result[idx], _end: ev };
        pendingById.delete(callId);
      } else if (name && pendingByName.has(name) && pendingByName.get(name).length > 0) {
        const arr = pendingByName.get(name);
        const idx = arr.shift();
        result[idx] = { ...result[idx], _end: ev };
        if (arr.length === 0) pendingByName.delete(name);
      }
      // Unmatched tool-end: silently drop (already shown via start row)
    } else {
      result.push(ev);
    }
  }

  return result;
}

/**
 * Derive whether to show the activity indicator, Kiro-chat style:
 *   - before the agent has done anything → "Thinking…"
 *   - while a tool is running → no indicator (the tool row has its own spinner)
 *   - after a tool finishes, until the next text or tool → "Working…"
 *   - once text streams, or the run ends → nothing
 * Walk backwards to find the most recent meaningful signal.
 */
function computeThinkingMeta(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const t  = ev.type;
    const at = new Date(ev.created_at || Date.now()).getTime();
    if (t === 'run-complete' || t === 'run-failed') {
      return { isThinking: false, startTime: null, label: null };
    }
    if (t === 'status' && ev.payload?.state === 'idle') {
      return { isThinking: false, startTime: null, label: null };
    }
    if (t === 'assistant-text') {
      return { isThinking: false, startTime: null, label: null };
    }
    if (t === 'tool-start') {
      // Paired by pairToolEvents: _end is null while the tool is still running.
      if (!ev._end) return { isThinking: false, startTime: null, label: null };
      return { isThinking: true, startTime: new Date(ev._end.created_at || Date.now()).getTime(), label: 'Working…' };
    }
    if (t === 'plan' || t === 'browser-navigate') {
      return { isThinking: true, startTime: at, label: 'Working…' };
    }
    if (t === 'status' && ev.payload?.state === 'thinking') {
      return { isThinking: true, startTime: at, label: 'Thinking…' };
    }
    if (t === 'human') {
      return { isThinking: true, startTime: at, label: 'Thinking…' };
    }
  }
  return { isThinking: false, startTime: null, label: null };
}

// ── Transcript normalisation ──────────────────────────────────────────────────

function normaliseTranscriptEvent(ev) {
  return {
    ...ev,
    type: ev.type ?? ev.kind,
    payload:
      typeof ev.payload === 'string'
        ? { text: ev.payload, body: ev.payload }
        : ev.payload ?? {},
  };
}

// ── useElapsed hook ───────────────────────────────────────────────────────────

function useElapsed(startTime) {
  const [elapsed, setElapsed] = useState(() =>
    startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
  );
  useEffect(() => {
    if (!startTime) { setElapsed(0); return; }
    setElapsed(Math.floor((Date.now() - startTime) / 1000));
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [startTime]);
  return elapsed;
}

// ── Thinking indicator ────────────────────────────────────────────────────────

function ThinkingIndicator({ startTime, thoughts, agentName, label = 'Thinking…' }) {
  const elapsed = useElapsed(startTime);
  const [open, setOpen] = useState(false);

  return (
    <div
      className="live-event live-thinking"
      role="status"
      aria-live="polite"
      aria-label={`${agentName ?? 'Agent'}: ${label} ${elapsed > 0 ? elapsed + 's' : ''}`}
    >
      <div className="live-thinking-row">
        <span className="live-thinking-dots" aria-hidden="true">
          <span /><span /><span />
        </span>
        <span>{label}</span>
        {elapsed > 0 && (
          <span className="live-thinking-elapsed" aria-hidden="true">{elapsed}s</span>
        )}
        {thoughts.length > 0 && (
          <button
            type="button"
            className="live-thinking-toggle"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? 'Hide reasoning' : 'Show reasoning'}
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} aria-hidden="true" />
            {open ? 'Hide reasoning' : 'Reasoning'}
          </button>
        )}
      </div>
      {open && thoughts.length > 0 && (
        <div className="live-thoughts" aria-label="Agent reasoning">
          {thoughts.map((t, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <p key={i} className="live-thought-text">{t}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Pending message bubble ────────────────────────────────────────────────────

function PendingMessageBubble({ msg, onRetry }) {
  const { text, status, error } = msg;
  return (
    <div className="live-pending-message" aria-label="Your message">
      <div className="live-pending-message-wrap">
        <span className="live-message-label live-message-label--user" aria-hidden="true">You</span>
        <div className={`live-user-bubble${status === 'sending' ? ' live-user-bubble--sending' : ''}`}>
          {text}
        </div>
        {status === 'sending' && (
          <span className="live-pending-label" aria-live="polite">Sending…</span>
        )}
        {status === 'error' && (
          <div className="live-pending-error" role="alert">
            <span>{error || 'Failed to send'}</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onRetry(msg.clientId)}
              aria-label="Retry sending message"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tool call row ─────────────────────────────────────────────────────────────

function ToolCallRow({ event }) {
  const [expanded, setExpanded] = useState(false);
  const payload  = event.payload ?? {};
  const endPayload = event._end?.payload ?? null;

  const toolName = payload.toolName || payload.tool || payload.name || 'Tool';
  const rawInput = payload.toolInput ?? payload.input ?? payload.command ?? payload.path ?? '';
  const inputStr = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
  const preview  = inputStr.slice(0, 80);

  const isPending = !event._end;
  const failed    = endPayload?.status === 'failed';

  let statusIcon;
  if (isPending) {
    statusIcon = <span className="spinner" aria-label="In progress" />;
  } else if (failed) {
    statusIcon = <span className="live-tool-status-fail" aria-label="Failed">✗</span>;
  } else {
    statusIcon = <span className="live-tool-status-ok" aria-label="Completed">✓</span>;
  }

  const output = endPayload?.output ?? endPayload?.result ?? null;

  return (
    <div className="live-event live-tool-call" aria-label={`Tool: ${toolName}`}>
      <button
        type="button"
        className="live-tool-call-row"
        onClick={() => setExpanded((o) => !o)}
        aria-expanded={expanded}
      >
        <span className="live-tool-status-icon">{statusIcon}</span>
        <span className="live-tool-name">{toolName}</span>
        {!expanded && preview && (
          <span className="live-tool-arg muted">{preview}</span>
        )}
        <Icon
          name={expanded ? 'chevronDown' : 'chevronRight'}
          size={12}
          style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--ink-3)' }}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div>
          {inputStr && (
            <pre className="live-tool-result">{inputStr}</pre>
          )}
          {output !== null && output !== undefined && (
            <pre className="live-tool-result">
              {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Slash command event ───────────────────────────────────────────────────────

function SlashCommandEvent({ event }) {
  const cmd    = event.payload?.command || event.payload?.text || '';
  const result = event.payload?.result  || event.payload?.output || '';
  const user   = event.payload?.user    || 'user';
  return (
    <div className="live-slash-command" role="log" aria-label={`Slash command: ${cmd}`}>
      <Icon name="slash" size={13} aria-hidden="true" />
      <span>
        <strong>{user}</strong> ran the command{' '}
        <span className="live-slash-command-label">{cmd}</span>
      </span>
      {result && (
        <pre className="live-slash-command-result">
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Expandable tool result (legacy — standalone tool-end fallback) ─────────────

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

// ── Approval card ─────────────────────────────────────────────────────────────

function ApprovalCard({ event, workflowId, projectId, runId, onResolved }) {
  const payload     = event.payload;
  const inputId     = payload.inputId || payload.id || event.id;
  const inputHash   = payload.inputHash || null;
  const description = payload.description || payload.command || payload.tool || 'Approval required';
  const [busy, setBusy]           = useState(false);
  const [resolved, setResolved]   = useState(false);
  const [resolutionLabel, setResolutionLabel] = useState('');
  const [error, setError]         = useState('');

  const resolve = async (response, allowAll = false) => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/projects/${projectId}/workflows/${workflowId}/runs/${runId}/input`, {
        inputId,
        response,
        allowAll,
        inputHash,
      });
      setResolved(true);
      setResolutionLabel(response === 'approve' ? (allowAll ? 'Approved all' : 'Approved') : 'Denied');
      if (onResolved) onResolved();
    } catch (e) {
      setError(e?.message || 'Could not submit. Please try again.');
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
      {error && (
        <div className="live-approval-error" role="alert">
          {error}
          {' '}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      <div className="live-approval-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => resolve('approve')} disabled={busy}>
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
        <button type="button" className="btn btn-sm btn-danger" onClick={() => resolve('deny')} disabled={busy}>
          Deny
        </button>
      </div>
    </div>
  );
}

// ── Event renderers ────────────────────────────────────────────────────────────

/**
 * Render a single run event.  The `event` object may have an `_end` property
 * (added by pairToolEvents) for tool-start events.
 */
function RunEvent({ event, workflowId, projectId, runId, onResolved, agentName = 'Agent', outputFiles = [], vaultFolder }) {
  const { type, payload } = event;

  // ── Human message ────────────────────────────────────────────────────────
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

  // ── Slash command ────────────────────────────────────────────────────────
  if (type === 'slash-command' || type === 'workflow.command') {
    return <SlashCommandEvent event={event} />;
  }

  // ── Assistant text ────────────────────────────────────────────────────────
  if (type === 'assistant-text') {
    const text = payload.text || payload.content || '';
    if (!text) return null;
    return (
      <div className="live-event live-agent-message" role="log" aria-live="polite">
        <span className="live-message-label live-message-label--agent" aria-hidden="true">{agentName}</span>
        <div className="live-agent-bubble" aria-label="Agent output">
          <MarkdownMessage
            text={text}
            outputFiles={outputFiles}
            projectId={projectId}
            vaultFolder={vaultFolder}
          />
        </div>
      </div>
    );
  }

  // ── Agent thought — shown in ThinkingIndicator, not inline ──────────────
  if (type === 'agent-thought') return null;

  // ── Tool start (with paired end via _end) ────────────────────────────────
  if (type === 'tool-start') {
    return <ToolCallRow event={event} />;
  }

  // ── Tool end — merged into tool-start above; standalone fallback ─────────
  if (type === 'tool-end') {
    const toolName = payload.toolName || payload.tool || payload.name || 'Tool';
    const result   = payload.result ?? payload.output ?? '';
    return <ExpandableToolResult toolName={toolName} result={result} />;
  }

  // ── Tool blocked ─────────────────────────────────────────────────────────
  if (type === 'tool-blocked') {
    const reason = payload.reason || payload.command || 'Blocked';
    return (
      <div className="live-event live-tool-blocked" role="alert" aria-label="Blocked tool call">
        🚫 <strong>Blocked:</strong> {reason}
      </div>
    );
  }

  // ── Approval request ─────────────────────────────────────────────────────
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

  // ── Plan checklist ────────────────────────────────────────────────────────
  if (type === 'plan') {
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (!entries.length) return null;
    return (
      <div className="live-event live-plan" aria-label="Agent plan">
        <div className="live-plan-header">Plan</div>
        <ul className="live-plan-list" role="list">
          {entries.map((entry, i) => {
            const st = entry.status || 'pending';
            const icon = st === 'done' ? '✓' : st === 'failed' ? '✗' : '○';
            return (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i} className={`live-plan-item live-plan-item--${st}`}>
                <span className="live-plan-check" aria-hidden="true">{icon}</span>
                <span>{entry.content}</span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  // ── Browser navigate (visible row in chat) ────────────────────────────────
  if (type === 'browser-navigate') {
    const url = payload.url || '';
    return (
      <div className="live-event live-tool-start" aria-label={`Browser: navigate to ${url}`}>
        <Icon name="browser" size={13} aria-hidden="true" />
        <span className="live-tool-name">Browser:</span>
        <span className="live-tool-arg muted" title={url}>
          navigating to {url.length > 60 ? `${url.slice(0, 60)}…` : url}
        </span>
      </div>
    );
  }

  // ── Browser screenshot — shown in browser panel, not chat ────────────────
  if (type === 'browser-screenshot') return null;

  // ── Status with text (informational message) ─────────────────────────────
  if (type === 'status') {
    if (payload.state) return null; // handled by ThinkingIndicator
    const text = payload.text || '';
    if (!text) return null;
    return (
      <div className="live-event live-status-text" role="status" aria-live="polite">
        {text}
      </div>
    );
  }

  // ── Child session result ──────────────────────────────────────────────────
  if (type === 'child-result' || event.kind === 'child-result') {
    const data = payload?.childTitle !== undefined ? payload : (
      (() => { try { return JSON.parse(payload?.body ?? event.body ?? '{}'); } catch { return {}; } })()
    );
    const childTitle  = payload?.childTitle ?? data?.childTitle ?? 'Child session';
    const childStatus = payload?.status     ?? data?.status     ?? 'done';
    const summary     = payload?.summary    ?? data?.summary    ?? payload?.body ?? event.body ?? '';
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

  // ── Subagent nudge ────────────────────────────────────────────────────────
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

  // ── Run complete ──────────────────────────────────────────────────────────
  if (type === 'run-complete') {
    const duration = payload.duration_ms ? `${(payload.duration_ms / 1000).toFixed(1)}s` : null;
    const cost     = payload.cost_usd != null ? formatCost(payload.cost_usd) : null;
    return (
      <div className="live-event live-run-complete" role="status" aria-label="Run complete">
        <Icon name="check" size={16} />
        Done{duration ? ` in ${duration}` : ''}{cost ? ` · ${cost}` : ''}
      </div>
    );
  }

  // ── Run failed ────────────────────────────────────────────────────────────
  if (type === 'run-failed') {
    const msg = payload.error || payload.message || 'Run failed';
    return (
      <div className="live-event live-run-failed" role="alert" aria-label="Run failed">
        <Icon name="warning" size={16} />
        {msg}
      </div>
    );
  }

  // Ignore cost-update
  return null;
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
 *   runId:           string | null | undefined,
 *   workflowId:      string,
 *   projectId:       string,
 *   workflow?:       object | null,
 *   pendingMessages?: Array<{clientId:string,text:string,status:string,error?:string}>,
 *   onRemovePending?: (clientId:string) => void,
 *   onRetryPending?:  (clientId:string) => void,
 *   onBrowserEvent?:  (event:object)   => void,
 *   outputFiles?:    Array<object>,
 *   vaultFolder?:    string | null,
 * }} props
 */
export function SessionLive({
  runId,
  workflowId,
  projectId,
  workflow,
  pendingMessages = [],
  onRemovePending,
  onRetryPending,
  onBrowserEvent,
  outputFiles = [],
  vaultFolder = null,
}) {
  const { events, connected, error } = useRunStream(runId);

  const scrollRef      = useRef(null);
  const [autoScroll, setAutoScroll]   = useState(true);
  const userScrolled   = useRef(false);

  // Preview state for RunOutputsCard clicks in the chat feed.
  // { file: object, files: Array<object> } — files enables prev/next navigation.
  const [chatPreviewFile, setChatPreviewFile] = useState(null);

  // Transcript paging
  const [earlierEvents, setEarlierEvents]             = useState([]);
  const [nextCursor, setNextCursor]                   = useState(null);
  const [loadingEarlier, setLoadingEarlier]           = useState(false);
  const [loadedInitialTranscript, setLoadedInitialTranscript] = useState(false);
  // True once we have loaded the oldest page (nextCursor became null).
  // The goal bubble is only shown when we know there is no earlier history.
  const [reachedStart, setReachedStart]               = useState(false);

  // Ref that always mirrors current `events` — readable inside effects on runId
  // change before useRunStream resets its state.
  const latestEventsRef = useRef(events);
  latestEventsRef.current = events;

  // Track which browser events have already been forwarded to the parent
  const notifiedBrowserEventsRef = useRef(/** @type {Set<string>} */ (new Set()));

  // Track which pending messages have been consumed by matching human events
  const matchedPendingRef = useRef(/** @type {Set<string>} */ (new Set()));

  // ── Derived values ──────────────────────────────────────────────────────

  const agentName = workflow?.engine === 'kiro'         ? 'Kiro'
    : workflow?.engine === 'claude-code' ? 'Claude'
    : (workflow?.engine ? String(workflow.engine) : 'Agent');

  // Pair tool-start/tool-end before merging assistant-text
  const pairedEvents       = pairToolEvents(events);
  const displayEvents      = mergeConsecutiveAssistantText(pairedEvents);

  // Earlier events from transcript — filter out current run's events (already in stream)
  const pairedEarlierEvents   = pairToolEvents(
    earlierEvents.filter((e) => !(runId && e.run_id && e.run_id === runId)),
  );
  const displayEarlierEvents = mergeConsecutiveAssistantText(pairedEarlierEvents);

  const goalText = typeof workflow?.goal === 'string' ? workflow.goal.trim() : '';
  // Show the goal bubble only once we know there is no earlier history (i.e.
  // the oldest page has been loaded).  This prevents the bubble from
  // disappearing or flickering when a session has more than one page of events.
  const showGoal = Boolean(goalText) && loadedInitialTranscript && reachedStart;

  // Reasoning paragraphs from the current stream (streamed chunks joined as sent)
  const agentThoughts = collectThoughtParagraphs(events);

  // Determine activity state (Kiro-chat style: Thinking → tool rows → Working → text)
  const { isThinking: streamThinking, startTime: streamThinkingStart, label: streamLabel } =
    computeThinkingMeta(displayEvents);

  // A just-sent message shows "Thinking…" until the stream reports any activity
  // newer than the send. After that, the stream decides (tool rows have their own
  // spinners, so no extra indicator is shown while a tool runs).
  const pendingActive = pendingMessages.find((m) => m.status === 'sending' || m.status === 'sent');
  const lastStreamAt = displayEvents.length
    ? new Date(displayEvents[displayEvents.length - 1].created_at || 0).getTime()
    : 0;
  const pendingAwaitingActivity = Boolean(pendingActive) && lastStreamAt < (pendingActive.sentAt ?? 0);
  const isThinking = pendingAwaitingActivity || streamThinking;
  const thinkingLabel = pendingAwaitingActivity ? 'Thinking…' : (streamLabel ?? 'Thinking…');

  // Start time for the indicator's elapsed counter
  const thinkingStartTime = pendingAwaitingActivity
    ? (pendingActive.sentAt ?? Date.now())
    : streamThinkingStart;

  // Dedup: skip human events from the stream that match a pending message
  // (the pending bubble is already visible)
  const pendingTextsMap = {};
  for (const m of pendingMessages) {
    if (m.status !== 'error') {
      pendingTextsMap[m.text] = (pendingTextsMap[m.text] || 0) + 1;
    }
  }
  const dedupedDisplayEvents = displayEvents.filter((e) => {
    if (e.type !== 'human') return true;
    const text = e.payload?.text || e.payload?.body || e.payload?.message || '';
    if (pendingTextsMap[text] > 0) {
      pendingTextsMap[text]--;
      return false; // suppress — pending bubble is already shown
    }
    return true;
  });

  // ── New-run handling: when runId changes, persist current events ─────────

  const prevRunIdRef = useRef(runId);
  useEffect(() => {
    const prevRunId = prevRunIdRef.current;
    prevRunIdRef.current = runId;

    if (prevRunId && prevRunId !== runId) {
      // 1. Merge the completed run's full stream events into earlierEvents so they
      //    survive the stream reset that follows.
      if (latestEventsRef.current.length > 0) {
        const toSave = latestEventsRef.current;
        setEarlierEvents((prev) => mergeEventLists(prev, toSave));
      }

      // 2. Re-fetch the newest transcript page to pick up any new
      //    p6_workflow_events entries (e.g. a human follow-up that triggered
      //    this new run).  mergeEventLists deduplicates by src+id, so there
      //    will be no duplicates with events already in earlierEvents.
      if (workflowId && projectId) {
        api.get(
          `/api/projects/${projectId}/workflows/${workflowId}/transcript?limit=50`,
        ).then((data) => {
          // Only take workflow events (src 'w': human follow-ups, commands).
          // Run events are already covered by the saved stream copy above, and
          // the transcript coalesces streamed text into one event keyed by the
          // first chunk's id, so merging it with per-chunk stream events would
          // duplicate the previous answer.
          const normalised = (data.events ?? [])
            .filter((e) => e.src === 'w')
            .map(normaliseTranscriptEvent)
            .reverse();
          if (normalised.length > 0) {
            setEarlierEvents((prev) => mergeEventLists(prev, normalised));
          }
        }).catch(() => {}); // non-critical: transcript is a best-effort overlay
      }
    }

    // Reset browser-notification tracker for the new run
    notifiedBrowserEventsRef.current = new Set();
  // workflowId and projectId are stable for the lifetime of this component
  // mount.  runId is the only value that triggers a meaningful re-run.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, workflowId, projectId]);

  // ── Browser events: notify parent ────────────────────────────────────────

  useEffect(() => {
    if (!onBrowserEvent) return;
    for (const ev of events) {
      if (ev.type !== 'browser-navigate' && ev.type !== 'browser-screenshot') continue;
      const key = ev.id ?? `${ev.type}-${ev.created_at}`;
      if (notifiedBrowserEventsRef.current.has(key)) continue;
      notifiedBrowserEventsRef.current.add(key);
      onBrowserEvent(ev);
    }
  }, [events, onBrowserEvent]);

  // ── Pending message deduplication: remove once human event confirms send ─

  useEffect(() => {
    if (!onRemovePending || !pendingMessages.length) return;
    const active = pendingMessages.filter(
      (m) => m.status !== 'error' && !matchedPendingRef.current.has(m.clientId),
    );
    if (!active.length) return;

    for (const ev of events) {
      if (ev.type !== 'human') continue;
      const text = ev.payload?.text || ev.payload?.body || ev.payload?.message || '';
      const match = active.find((m) => m.text === text);
      if (match) {
        matchedPendingRef.current.add(match.clientId);
        onRemovePending(match.clientId);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, pendingMessages]);

  // ── Transcript loading ────────────────────────────────────────────────────

  useEffect(() => {
    if (!workflowId || !projectId || loadedInitialTranscript) return;
    setLoadedInitialTranscript(true);

    // Server max is 200 raw events per page, but consecutive streamed
    // assistant-text chunks are coalesced server-side, so each page typically
    // covers many turns.  We auto-load up to MAX_AUTO_PAGES pages so the full
    // history is visible without the user having to click "Load earlier turns".
    // Beyond this cap the "Load earlier" button lets them go further.
    const PAGE_LIMIT = 200;
    const MAX_AUTO_PAGES = 20;

    let cancelled = false;

    (async () => {
      try {
        let accEvents = [];
        let cursor = null;
        let fetchedPages = 0;

        while (fetchedPages < MAX_AUTO_PAGES) {
          const url =
            `/api/projects/${projectId}/workflows/${workflowId}/transcript?limit=${PAGE_LIMIT}` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

          // eslint-disable-next-line no-await-in-loop
          const data = await api.get(url);
          if (cancelled) return;

          fetchedPages++;

          // Server returns newest-first; reverse each page to oldest-first before
          // prepending to the accumulator (which already holds newer events).
          const normalised = (data.events ?? []).map(normaliseTranscriptEvent).reverse();
          accEvents = [...normalised, ...accEvents];
          cursor = data.nextCursor ?? null;

          if (!cursor) {
            // Reached the very beginning of the session — goal bubble can show.
            setReachedStart(true);
            break;
          }
        }

        if (!cancelled && accEvents.length > 0) {
          setEarlierEvents(accEvents);
          setNextCursor(cursor);
        } else if (!cancelled && accEvents.length === 0) {
          // Empty session (no events yet): still mark start reached so the
          // goal bubble shows immediately.
          setReachedStart(true);
        }
      } catch { /* ignore — transcript is non-critical */ }
    })();

    return () => { cancelled = true; };
  // runId is intentionally NOT in deps: this effect runs once per session mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, projectId, loadedInitialTranscript]);

  const loadEarlier = async () => {
    if (!nextCursor || loadingEarlier) return;
    setLoadingEarlier(true);
    const el          = scrollRef.current;
    const scrollBottom = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const data = await api.get(
        `/api/projects/${projectId}/workflows/${workflowId}/transcript?limit=50&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setEarlierEvents((prev) => mergeEventLists(
        (data.events ?? []).map(normaliseTranscriptEvent).reverse(),
        prev,
      ));
      const newCursor = data.nextCursor ?? null;
      setNextCursor(newCursor);
      if (!newCursor) {
        // Reached the very beginning — show the goal bubble.
        setReachedStart(true);
      }
      if (el) {
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - scrollBottom; });
      }
    } catch { /* ignore */ }
    finally { setLoadingEarlier(false); }
  };

  // ── Auto-scroll ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, pendingMessages, isThinking, autoScroll]);

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

  // ── Empty / error states ──────────────────────────────────────────────────

  if (!runId && !pendingMessages.length) {
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
    <div
      className="live-panel"
      style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}
    >
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
        role="log"
        aria-live="polite"
        aria-label="Agent conversation"
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

        {/* Opening message (session goal) */}
        {showGoal && (
          <div className="live-event live-human-message" role="log" aria-label="User message">
            <div className="live-user-bubble">{goalText}</div>
          </div>
        )}

        {/* Earlier (paged transcript) events */}
        {displayEarlierEvents.map((e, i) => {
          const key           = e.id ?? `earlier-${i}`;
          const isTerminal    = e.type === 'run-complete' || e.type === 'run-failed';
          const eventRunId    = e.run_id ?? null;
          const runFiles      = isTerminal && eventRunId
            ? outputFiles.filter((f) => f.run_id === eventRunId)
            : [];
          return (
            <React.Fragment key={key}>
              <RunEvent
                event={e}
                workflowId={workflowId}
                projectId={projectId}
                runId={e.run_id ?? runId}
                agentName={agentName}
                outputFiles={outputFiles}
                vaultFolder={vaultFolder}
                onResolved={undefined}
              />
              {runFiles.length > 0 && (
                <RunOutputsCard
                  files={runFiles}
                  workflowId={workflowId}
                  projectId={projectId}
                  vaultFolder={vaultFolder}
                  onPreview={(f, fs) => setChatPreviewFile({ file: f, files: fs })}
                />
              )}
            </React.Fragment>
          );
        })}

        {/* Waiting state — stream connected but nothing yet */}
        {events.length === 0 && connected && earlierEvents.length === 0 && !pendingMessages.length && (
          <div className="ws-placeholder" style={{ padding: '32px 16px', color: 'var(--ink-3)' }}>
            <div className="spinner" style={{ width: 20, height: 20 }} aria-label="Waiting for agent output…" />
            <p style={{ marginTop: 8 }}>Waiting for agent output…</p>
          </div>
        )}

        {/* Current run events (deduped against pending messages) */}
        {dedupedDisplayEvents.map((e, i) => {
          const key        = e.id ?? i;
          const isTerminal = e.type === 'run-complete' || e.type === 'run-failed';
          const runFiles   = isTerminal && runId
            ? outputFiles.filter((f) => f.run_id === runId)
            : [];
          return (
            <React.Fragment key={key}>
              <RunEvent
                event={e}
                workflowId={workflowId}
                projectId={projectId}
                runId={runId}
                agentName={agentName}
                outputFiles={outputFiles}
                vaultFolder={vaultFolder}
                onResolved={undefined}
              />
              {runFiles.length > 0 && (
                <RunOutputsCard
                  files={runFiles}
                  workflowId={workflowId}
                  projectId={projectId}
                  vaultFolder={vaultFolder}
                  onPreview={(f, fs) => setChatPreviewFile({ file: f, files: fs })}
                />
              )}
            </React.Fragment>
          );
        })}

        {/* Pending (optimistic) user messages */}
        {pendingMessages.map((msg) => (
          <PendingMessageBubble
            key={msg.clientId}
            msg={msg}
            onRetry={onRetryPending ?? (() => {})}
          />
        ))}

        {/* Thinking indicator */}
        {isThinking && (
          <ThinkingIndicator
            startTime={thinkingStartTime}
            thoughts={agentThoughts}
            agentName={agentName}
            label={thinkingLabel}
          />
        )}
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

      {/* Preview dialog — opened from RunOutputsCard file rows */}
      {chatPreviewFile && (
        <OutputFilePreview
          key={chatPreviewFile.file.id}
          file={chatPreviewFile.file}
          files={chatPreviewFile.files}
          projectId={projectId}
          vaultFolder={vaultFolder}
          onClose={() => setChatPreviewFile(null)}
        />
      )}
    </div>
  );
}
