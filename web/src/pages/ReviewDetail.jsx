/**
 * Code Review detail page.
 *
 * Rendered at #/p/:projectId/review/:reviewId.
 * Shows: verdict banner, merge/re-run/post actions, findings panel with
 * severity filter, reproducibility info, run log, usage & cost table,
 * and report download buttons.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../lib/api.js';
import { subscribeProject } from '../lib/events.js';
import { href, navigate } from '../lib/router.js';
import { Icon } from '../components/Icon.jsx';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';
import { formatRelative, formatDate } from '../lib/util.js';
import { useToast, ToastShelf } from '../components/Toast.jsx';

// ── Constants ──────────────────────────────────────────────────────────────────

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

const LOG_TYPE_LABEL = { llm: 'LLM', tool: 'Tool', tool_result: 'Result', error: 'Error', system: 'System' };
const LOG_TYPE_ICON  = { llm: 'builder', tool: 'builder', tool_result: 'check', error: 'warning', system: 'settings' };

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtUsd(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return '$0.0000';
  if (Math.abs(n) < 0.001) return `$${Number(n).toFixed(6)}`;
  if (Math.abs(n) < 0.1) return `$${Number(n).toFixed(4)}`;
  return `$${Number(n).toFixed(3)}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtMs(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function shortSha(sha) {
  return sha ? sha.slice(0, 8) : null;
}

function parseRunLog(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

function thresholdLabel(threshold) {
  const labels = {
    critical: 'Any finding severity is acceptable — nothing blocks merge.',
    high:     'High is the worst finding you can still merge. Critical findings block the merge.',
    medium:   'Medium is the worst finding you can still merge. Critical and High findings block the merge.',
    low:      'Low is the worst finding you can still merge. Critical, High, and Medium findings block the merge.',
    info:     'Info is the worst finding you can still merge. Any higher-severity finding blocks the merge.',
    none:     'Zero findings required — even an Info finding blocks the merge.',
  };
  return labels[threshold] ?? `Threshold: ${threshold}`;
}

// ── Severity badge ─────────────────────────────────────────────────────────────

function SevBadge({ severity }) {
  return (
    <span
      className={`badge badge-sev-${severity ?? 'info'}`}
      style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
    >
      {severity}
    </span>
  );
}

// ── Verdict banner ─────────────────────────────────────────────────────────────

function VerdictBanner({ verdict, threshold, merged }) {
  if (merged) {
    return (
      <div
        role="status"
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px',
          borderRadius: 'var(--radius)',
          background: 'var(--ok-wash)',
          border: '1px solid color-mix(in srgb, var(--ok) 35%, transparent)',
        }}
      >
        <Icon name="check" size={16} style={{ color: 'var(--ok)', flexShrink: 0 }} />
        <div>
          <span style={{ fontWeight: 700, color: 'var(--ok)' }}>Merged</span>
          <span className="muted" style={{ marginLeft: 8, fontSize: '0.84rem' }}>
            Merged {formatRelative(merged)}
          </span>
        </div>
      </div>
    );
  }

  if (!verdict) return null;

  const isMergeable = verdict.verdict === 'mergeable';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        borderRadius: 'var(--radius)',
        border: `1px solid ${isMergeable
          ? 'color-mix(in srgb, var(--ok) 35%, transparent)'
          : 'color-mix(in srgb, var(--danger) 35%, transparent)'}`,
        background: isMergeable ? 'var(--ok-wash)' : 'var(--danger-wash)',
        padding: '12px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Icon
          name={isMergeable ? 'check' : 'warning'}
          size={16}
          style={{ color: isMergeable ? 'var(--ok)' : 'var(--danger)', flexShrink: 0 }}
        />
        <span style={{ fontWeight: 700, color: isMergeable ? 'var(--ok)' : 'var(--danger)' }}>
          {isMergeable ? 'Mergeable' : 'Blocked'}
        </span>
        {verdict.worstSeverity && (
          <SevBadge severity={verdict.worstSeverity} />
        )}
        {verdict.activeFindings > 0 && (
          <span className="muted" style={{ fontSize: '0.84rem' }}>
            {verdict.activeFindings} active finding{verdict.activeFindings !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <p style={{ margin: '6px 0 0', fontSize: '0.84rem', color: isMergeable ? 'var(--ok)' : 'var(--danger)' }}>
        {verdict.reason}
      </p>
      {threshold && (
        <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: 'var(--ink-3)' }}>
          {thresholdLabel(threshold)}
        </p>
      )}
    </div>
  );
}

// ── Merge dialog ───────────────────────────────────────────────────────────────

function MergeDialog({ projectId, review, repoName, onClose, onMerged, onRerun }) {
  const [strategy, setStrategy] = useState('squash');
  const [merging, setMerging] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [errorReason, setErrorReason] = useState(null);
  const dialogRef = useRef(null);

  // Trap focus inside dialog
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
    focusable[0]?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onClose]);

  const merge = async (e) => {
    e.preventDefault();
    setMerging(true);
    setErrorMsg(null);
    setErrorReason(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/reviews/${review.id}/merge`, { strategy });
      onMerged(r);
    } catch (err) {
      // Use structured reason from parsed response body (err.data.reason) rather than
      // matching against the error message string. All 409 responses from the merge route
      // carry { error, reason } where reason is one of:
      //   not_completed | gate_blocked | stale_review | merge_conflict
      const reason = err.data?.reason ?? null;
      setErrorReason(reason);
      if (reason === 'gate_blocked') {
        setErrorMsg('The merge gate is blocking this review. Dismiss or resolve findings above the threshold to unlock merge.');
      } else if (reason === 'stale_review') {
        setErrorMsg('The PR head has moved since this review ran. Re-run the review on the latest commit, then try merging again.');
      } else if (reason === 'not_completed') {
        setErrorMsg('The review has not completed yet. Wait for it to finish before merging.');
      } else if (reason === 'merge_conflict') {
        setErrorMsg('The provider reported a merge conflict. Resolve the conflicts on the branch before merging.');
      } else {
        setErrorMsg(err.message ?? 'Merge failed');
      }
      setMerging(false);
    }
  };

  const overlayDismiss = useOverlayDismiss(onClose);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Merge pull request"
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
    >
      <div className="modal" ref={dialogRef}>
        <div className="modal-header">
          <h2>Merge pull request</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close merge dialog">
            <Icon name="x" size={16} />
          </button>
        </div>

        <form onSubmit={merge} noValidate>
          <div className="stack">
            {/* PR info */}
            <div className="card" style={{ fontSize: '0.88rem' }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {repoName && (
                  <span>
                    <Icon name="branch" size={12} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                    <strong>{repoName}</strong>
                  </span>
                )}
                {review.pr_number && (
                  <span>
                    <span className="muted">PR&nbsp;</span>
                    <strong>#{review.pr_number}</strong>
                  </span>
                )}
                <span>
                  <code style={{ fontSize: '0.85em' }}>{review.base_ref}</code>
                  {' ← '}
                  <code style={{ fontSize: '0.85em' }}>{review.head_ref}</code>
                </span>
                {review.dest_sha && review.source_sha && (
                  <span className="muted">
                    {shortSha(review.dest_sha)} ← {shortSha(review.source_sha)}
                  </span>
                )}
              </div>
            </div>

            {/* Strategy */}
            <div className="field">
              <label htmlFor="merge-strategy">Merge strategy</label>
              <select
                id="merge-strategy"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
              >
                <option value="squash">Squash and merge (recommended)</option>
                <option value="merge">Create a merge commit</option>
              </select>
            </div>

            {errorMsg && (
              <div role="alert">
                <p className="error-note" style={{ marginBottom: errorReason === 'stale_review' ? 8 : 0 }}>
                  {errorMsg}
                </p>
                {errorReason === 'stale_review' && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => { onClose(); onRerun(); }}
                  >
                    <Icon name="refresh" size={12} />
                    Re-run review
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={merging}
              aria-busy={merging}
            >
              {merging ? 'Merging…' : 'Confirm merge'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Findings panel ─────────────────────────────────────────────────────────────

function FindingsPanel({ projectId, reviewId, findings, onFindingChange, onError }) {
  const [filter, setFilter] = useState('all');
  const [copyFeedback, setCopyFeedback] = useState(null); // findingId that was just copied

  const activeCounts = SEVERITIES.reduce((acc, sev) => {
    acc[sev] = findings.filter((f) => f.severity === sev && f.accepted !== -1).length;
    return acc;
  }, {});
  const dismissedCount = findings.filter((f) => f.accepted === -1).length;
  const activeTotal = findings.filter((f) => f.accepted !== -1).length;

  const filtered = findings.filter((f) => {
    if (filter === 'dismissed') return f.accepted === -1;
    if (filter === 'all') return f.accepted !== -1;
    return f.severity === filter && f.accepted !== -1;
  });

  const copyLocation = async (finding) => {
    const text = `${finding.file_path}${finding.line_number != null ? `:${finding.line_number}` : ''}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(finding.id);
      setTimeout(() => setCopyFeedback(null), 1500);
    } catch {
      // Fallback: no-op
    }
  };

  const accept = async (finding, accepted) => {
    try {
      const r = await api.put(
        `/api/projects/${projectId}/reviews/${reviewId}/findings/${finding.id}`,
        { accepted },
      );
      onFindingChange(r.finding);
    } catch (e) {
      // Surface error via parent toast when provided; fall back to console
      if (onError) {
        onError(e.message);
      } else {
        console.error('accept finding:', e.message);
      }
    }
  };

  return (
    <section aria-label="Findings">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>
          Findings
          <span className="muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: '1rem' }}>
            ({activeTotal})
          </span>
        </h2>
      </div>

      {/* Severity filter tabs */}
      <div
        role="tablist"
        aria-label="Filter findings by severity"
        style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}
      >
        <button
          role="tab"
          type="button"
          aria-selected={filter === 'all'}
          className={`btn btn-sm${filter === 'all' ? ' btn-primary' : ''}`}
          onClick={() => setFilter('all')}
        >
          All ({activeTotal})
        </button>
        {SEVERITIES.map((sev) => activeCounts[sev] > 0 && (
          <button
            key={sev}
            role="tab"
            type="button"
            aria-selected={filter === sev}
            className={`btn btn-sm${filter === sev ? ` badge-sev-${sev}` : ''}`}
            onClick={() => setFilter(sev)}
          >
            {sev[0].toUpperCase() + sev.slice(1)} ({activeCounts[sev]})
          </button>
        ))}
        {dismissedCount > 0 && (
          <button
            role="tab"
            type="button"
            aria-selected={filter === 'dismissed'}
            className={`btn btn-sm${filter === 'dismissed' ? ' btn-primary' : ''}`}
            onClick={() => setFilter('dismissed')}
          >
            Dismissed ({dismissedCount})
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <p>{filter === 'dismissed' ? 'No dismissed findings.' : 'No findings in this category.'}</p>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {filtered.map((f) => {
            const isDismissed = f.accepted === -1;
            return (
              <li
                key={f.id}
                className={`finding-item finding-item-${f.severity ?? 'info'}${isDismissed ? ' is-dismissed' : ''}`}
                style={{ padding: '10px 14px', marginBottom: 8 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                  <SevBadge severity={f.severity} />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontFamily: 'var(--mono)', fontSize: '0.82rem', padding: '1px 6px' }}
                    onClick={() => copyLocation(f)}
                    title="Copy file:line to clipboard"
                    aria-label={`Copy location ${f.file_path}${f.line_number != null ? `:${f.line_number}` : ''}`}
                  >
                    <Icon name={copyFeedback === f.id ? 'check' : 'copy'} size={12} />
                    {f.file_path}
                    {f.line_number != null ? `:${f.line_number}` : ''}
                  </button>
                  {f.posted_at && (
                    <span className="badge badge-ok" style={{ fontSize: '0.72rem' }}>posted</span>
                  )}
                  {isDismissed && (
                    <span className="badge badge-neutral" style={{ fontSize: '0.72rem' }}>dismissed</span>
                  )}
                  {f.confidence != null && (
                    <span className="muted" style={{ fontSize: '0.78rem', marginLeft: 'auto' }}>
                      {Math.round(f.confidence * 100)}% confidence
                    </span>
                  )}
                </div>

                <p style={{ margin: '4px 0 2px', fontWeight: 600, fontSize: '0.9rem' }}>{f.title}</p>
                <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--ink-2)', lineHeight: 1.5 }}>{f.body}</p>

                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {f.accepted !== 1 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ background: 'var(--ok-wash)', borderColor: 'color-mix(in srgb, var(--ok) 40%, transparent)' }}
                      onClick={() => accept(f, 1)}
                      aria-label={`Accept finding: ${f.title}`}
                    >
                      <Icon name="check" size={12} />
                      Accept
                    </button>
                  )}
                  {f.accepted !== -1 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ background: 'var(--danger-wash)', borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }}
                      onClick={() => accept(f, -1)}
                      aria-label={`Dismiss finding: ${f.title}`}
                    >
                      <Icon name="x" size={12} />
                      Dismiss
                    </button>
                  )}
                  {f.accepted !== 0 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => accept(f, 0)}
                      aria-label={`Reset finding status: ${f.title}`}
                    >
                      Reset
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Reproducibility panel ──────────────────────────────────────────────────────

function ReproducibilityPanel({ review }) {
  const jira = review.jira_context;
  const hasJira = jira && jira.key && jira.source !== 'none';

  return (
    <section aria-label="Reproducibility">
      <h2>Reproducibility</h2>
      <div className="card">
        <div className="stack">
          {/* Commits */}
          <div>
            <div className="muted" style={{ fontSize: '0.79rem', marginBottom: 4, fontWeight: 600 }}>COMMITS REVIEWED</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.88rem' }}>
              {review.dest_sha ? (
                <span>
                  <code>{shortSha(review.dest_sha)}</code>
                  <span className="muted" style={{ marginLeft: 4, fontSize: '0.8rem' }}>{review.base_ref}</span>
                </span>
              ) : (
                <span className="muted">base: <code>{review.base_ref}</code></span>
              )}
              <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-3)' }} />
              {review.source_sha ? (
                <span>
                  <code>{shortSha(review.source_sha)}</code>
                  <span className="muted" style={{ marginLeft: 4, fontSize: '0.8rem' }}>{review.head_ref}</span>
                </span>
              ) : (
                <span className="muted">head: <code>{review.head_ref}</code></span>
              )}
            </div>
          </div>

          {/* Engine */}
          <div>
            <div className="muted" style={{ fontSize: '0.79rem', marginBottom: 4, fontWeight: 600 }}>ENGINE</div>
            {review.provider_id || review.model_id ? (
              <span style={{ fontSize: '0.88rem' }}>
                {review.provider_id && <span>{review.provider_id}</span>}
                {review.provider_id && review.model_id && <span className="muted"> · </span>}
                {review.model_id && <code style={{ fontSize: '0.85em' }}>{review.model_id}</code>}
              </span>
            ) : (
              <span className="muted" style={{ fontSize: '0.88rem' }}>Not recorded</span>
            )}
          </div>

          {/* Jira context */}
          <div>
            <div className="muted" style={{ fontSize: '0.79rem', marginBottom: 4, fontWeight: 600 }}>JIRA CONTEXT</div>
            {hasJira ? (
              <div style={{ fontSize: '0.88rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="external" size={14} />
                  <strong>{jira.key}</strong>
                  {jira.source === 'branch' && (
                    <span className="muted" style={{ fontSize: '0.8rem' }}>(from branch name)</span>
                  )}
                  {jira.source === 'explicit' && (
                    <span className="muted" style={{ fontSize: '0.8rem' }}>(explicit)</span>
                  )}
                </div>
                {jira.summary && (
                  <p style={{ margin: '4px 0 0', color: 'var(--ink-2)' }}>{jira.summary}</p>
                )}
              </div>
            ) : (
              <div style={{ fontSize: '0.88rem' }}>
                <span className="muted">No Jira context — reviewed on the diff alone.</span>
                {jira?.reason && (
                  <span className="muted" style={{ marginLeft: 6, fontSize: '0.8rem' }}>({jira.reason})</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Run log ────────────────────────────────────────────────────────────────────

function RunLog({ runLog }) {
  const [open, setOpen] = useState(false);

  if (!runLog || runLog.length === 0) {
    return (
      <section aria-label="Run log">
        <h2>Run log</h2>
        <p className="muted" style={{ fontSize: '0.84rem' }}>No log entries recorded.</p>
      </section>
    );
  }

  return (
    <section aria-label="Run log">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: open ? 10 : 0 }}>
        <h2 style={{ margin: 0 }}>Run log</h2>
        <span className="muted" style={{ fontSize: '0.84rem' }}>{runLog.length} entries</span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          {open ? 'Hide log' : 'Show log'}
        </button>
      </div>

      {open && (
        <div
          style={{
            maxHeight: 420,
            overflowY: 'auto',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            fontSize: '0.8rem',
            fontFamily: 'var(--mono)',
            background: 'var(--code-bg)',
          }}
          role="log"
          aria-label="Agent run log"
        >
          {runLog.map((entry, i) => {
            const iconName = LOG_TYPE_ICON[entry.type] ?? 'info';
            const label = LOG_TYPE_LABEL[entry.type] ?? entry.type;
            const tokens = [
              entry.input_tokens && `in:${entry.input_tokens}`,
              entry.output_tokens && `out:${entry.output_tokens}`,
              entry.cache_write_tokens && `cw:${entry.cache_write_tokens}`,
              entry.cache_read_tokens && `cr:${entry.cache_read_tokens}`,
            ].filter(Boolean).join(' ');

            return (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr auto',
                  gap: '6px 10px',
                  padding: '6px 12px',
                  borderBottom: i < runLog.length - 1 ? '1px solid var(--line-2)' : 'none',
                  alignItems: 'baseline',
                  color: entry.type === 'error' ? 'var(--danger)' : undefined,
                }}
              >
                {/* Type label */}
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    color: entry.type === 'error' ? 'var(--danger)' : 'var(--accent)',
                    minWidth: 52,
                  }}
                >
                  {label}
                </span>

                {/* Content */}
                <span style={{ color: 'var(--ink-2)', overflowWrap: 'break-word', wordBreak: 'break-all' }}>
                  {entry.name && <strong style={{ color: 'var(--ink)' }}>{entry.name} </strong>}
                  {entry.text && <span>{entry.text}</span>}
                  {entry.input && !entry.text && (
                    <span style={{ color: 'var(--ink-3)' }}>{entry.input}</span>
                  )}
                  {entry.output && !entry.text && entry.type === 'tool_result' && (
                    <span style={{ color: 'var(--ink-3)' }}>{entry.output}</span>
                  )}
                </span>

                {/* Token counts + timestamp */}
                <span style={{ textAlign: 'right', color: 'var(--ink-3)', whiteSpace: 'nowrap', fontSize: '0.72rem' }}>
                  {tokens && <span style={{ marginRight: 8 }}>{tokens}</span>}
                  {entry.ts && new Date(entry.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Cost table ─────────────────────────────────────────────────────────────────

function CostTable({ review, rateCard }) {
  const M = 1_000_000;
  const rc = rateCard ?? { inputUsd: 3, outputUsd: 15, cacheWriteUsd: 3.75, cacheReadUsd: 0.30 };

  const rows = [
    { label: 'Input (uncached)',  tokens: review.input_tokens,        rate: rc.inputUsd,      cost: (review.input_tokens / M) * rc.inputUsd },
    { label: 'Cache write',       tokens: review.cache_write_tokens,  rate: rc.cacheWriteUsd, cost: (review.cache_write_tokens / M) * rc.cacheWriteUsd },
    { label: 'Cache read',        tokens: review.cache_read_tokens,   rate: rc.cacheReadUsd,  cost: (review.cache_read_tokens / M) * rc.cacheReadUsd },
    { label: 'Output',            tokens: review.output_tokens,       rate: rc.outputUsd,     cost: (review.output_tokens / M) * rc.outputUsd },
  ];

  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const cacheSaved = (review.cache_read_tokens / M) * (rc.inputUsd - rc.cacheReadUsd);

  return (
    <section aria-label="Usage and cost">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Usage &amp; cost</h2>
        <span className="muted" style={{ fontSize: '0.82rem' }}>(estimate — all costs are approximations)</span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" aria-label="Token usage and cost breakdown">
          <thead>
            <tr>
              <th>Bucket</th>
              <th style={{ textAlign: 'right' }}>Tokens</th>
              <th style={{ textAlign: 'right' }}>Rate ($/1M)</th>
              <th style={{ textAlign: 'right' }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(row.tokens)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${row.rate.toFixed(2)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(row.cost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700, borderTop: '2px solid var(--line)' }}>
              <td>Total (estimated)</td>
              <td></td>
              <td></td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(totalCost)}</td>
            </tr>
            {cacheSaved > 0 && (
              <tr style={{ color: 'var(--ok)' }}>
                <td>Cache savings</td>
                <td></td>
                <td></td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>−{fmtUsd(cacheSaved)}</td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap', fontSize: '0.84rem', color: 'var(--ink-2)' }}>
        <span><strong>{review.llm_requests ?? 0}</strong> LLM requests</span>
        <span><strong>{review.retry_count ?? 0}</strong> retries</span>
        <span><strong>{review.tool_calls ?? 0}</strong> tool calls</span>
        <span><strong>{review.files_reviewed ?? 0}</strong> files reviewed</span>
        {review.duration_ms != null && (
          <span><strong>{fmtMs(review.duration_ms)}</strong> duration</span>
        )}
      </div>
    </section>
  );
}

// ── Post to PR result ──────────────────────────────────────────────────────────

function PostResult({ result }) {
  if (!result) return null;

  if (!result.ok) {
    return <p className="error-note" role="alert">{result.error}</p>;
  }

  if (result.failed > 0) {
    return (
      <div
        role="status"
        style={{
          background: 'var(--warn-wash)',
          border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)',
          borderRadius: 'var(--radius)',
          padding: '8px 12px',
          fontSize: '0.84rem',
          color: 'var(--warn)',
        }}
      >
        <strong>Partial success:</strong> {result.posted} posted, {result.failed} failed.
        {result.failures?.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
            {result.failures.map((f) => (
              <li key={f.findingId}>Finding {f.findingId} — HTTP {f.status}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <p
      role="status"
      style={{
        color: 'var(--ok)', background: 'var(--ok-wash)',
        border: '1px solid color-mix(in srgb, var(--ok) 30%, transparent)',
        borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: '0.84rem',
      }}
    >
      {result.message ?? `${result.posted} finding${result.posted !== 1 ? 's' : ''} posted.`}
    </p>
  );
}

// ── Main ReviewDetail component ────────────────────────────────────────────────

export default function ReviewDetail({ projectId, reviewId, user }) {
  const [review, setReview] = useState(null);
  const [findings, setFindings] = useState([]);
  const [settings, setSettings] = useState(null);
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mergeModal, setMergeModal] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState(null);
  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState(null);
  const liveTimerRef = useRef(null);
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [rr, sr, repoRes] = await Promise.all([
        api.get(`/api/projects/${projectId}/reviews/${reviewId}`),
        api.get('/api/settings/review').catch(() => null),
        api.get(`/api/projects/${projectId}/repos`).catch(() => ({ repos: [] })),
      ]);
      setReview(rr.review);
      setFindings(rr.findings ?? []);
      setSettings(sr);
      setRepos(repoRes.repos ?? []);
    } catch (e) {
      if (!silent) setError(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [projectId, reviewId]);

  useEffect(() => { load(); }, [load]);

  // ── Live updates while review is pending or running ─────────────────────────
  // Subscribe to project SSE events so the page updates without a manual refresh.
  // We also poll every 5 s as a fallback (EventSource may be blocked by proxies).
  // Both mechanisms are torn down once the review reaches a terminal state.
  useEffect(() => {
    if (!review) return;
    const isActive = review.status === 'pending' || review.status === 'running';
    if (!isActive) return;

    const scheduleReload = (delayMs = 0) => {
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = setTimeout(() => load(true), delayMs);
    };

    const unsubscribe = subscribeProject(projectId, (event) => {
      // Filter to events that relate to this review's workflow where possible.
      const wid = review.workflow_id;
      const isRelevant =
        (event.type === 'workflow.started' && (!wid || event.workflowId === wid)) ||
        (event.type === 'run.started'      && (!wid || event.workflowId === wid)) ||
        (event.type === 'run.done'         && (!wid || event.workflowId === wid)) ||
        // run-failed is emitted as a run.event before the lifecycle hook writes to DB;
        // use a short delay to give the hook time to update the review row.
        (event.type === 'run.event' && event.eventType === 'run-failed' &&
          (!wid || event.workflowId === wid));

      if (!isRelevant) return;
      const delay = event.type === 'run.event' ? 250 : 0;
      scheduleReload(delay);
    });

    // 5-second polling fallback
    const pollId = setInterval(() => load(true), 5000);

    return () => {
      unsubscribe();
      clearInterval(pollId);
      clearTimeout(liveTimerRef.current);
    };
  }, [review?.status, review?.workflow_id, projectId, load]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleMerged = (result) => {
    setMergeModal(false);
    setReview((r) => ({ ...r, merged_at: result.mergedAt, merged_by: user?.id }));
  };

  const rerun = async () => {
    setRerunning(true);
    setRerunError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/reviews/${reviewId}/rerun`, {});
      // Navigate to the new review (within the reviews/code tab)
      navigate(`/p/${projectId}/reviews/code/${r.review.id}`);
    } catch (e) {
      setRerunError(e.message);
      setRerunning(false);
    }
  };

  const postToPr = async () => {
    setPosting(true);
    setPostResult(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/reviews/${reviewId}/post`, {});
      setPostResult({ ok: true, ...r });
    } catch (e) {
      setPostResult({ ok: false, error: e.message });
    } finally {
      setPosting(false);
    }
  };

  const downloadReport = async (type) => {
    try {
      const res = await fetch(
        `/api/projects/${projectId}/reviews/${reviewId}/export/${type}`,
        { headers: { 'x-requested-with': 'agent-portal' }, credentials: 'same-origin' },
      );
      if (!res.ok) { toast(`Download failed (${res.status})`, 'error'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `review-${reviewId.slice(0, 8)}.${type}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast('Download failed: ' + e.message, 'error');
    }
  };

  const handleFindingChange = (updated) => {
    setFindings((prev) => prev.map((f) => f.id === updated.id ? updated : f));
    // Refresh verdict — reload review silently (no spinner)
    api.get(`/api/projects/${projectId}/reviews/${reviewId}`)
      .then((r) => setReview(r.review))
      .catch(() => {});
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center' }}>
        <div className="spinner" aria-label="Loading review…" />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <p className="error-note" role="alert">{error}</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => navigate(href(projectId, 'reviews', 'code'))}>
            <Icon name="chevronLeft" size={14} />
            Back to reviews
          </button>
          <button type="button" className="btn btn-primary" onClick={() => load()}>Retry</button>
        </div>
      </div>
    );
  }

  if (!review) {
    return (
      <div>
        <p className="muted">Review not found.</p>
        <button type="button" className="btn" onClick={() => navigate(href(projectId, 'reviews', 'code'))}>
          <Icon name="chevronLeft" size={14} />
          Back to reviews
        </button>
      </div>
    );
  }

  const verdict = review.verdict;
  const isAlreadyMerged = Boolean(review.merged_at);
  const canMerge = !isAlreadyMerged && review.status === 'done' && verdict?.mergeable && review.pr_number;
  const mergeDisabledReason = isAlreadyMerged
    ? 'Already merged'
    : review.status !== 'done'
    ? `Review is ${review.status} — wait for it to finish`
    : !verdict?.mergeable
    ? verdict?.reason ?? 'Blocked by merge gate'
    : !review.pr_number
    ? 'No PR number associated with this review'
    : null;

  const canPost = review.status === 'done' && review.post_mode === 'draft';
  const runLog = parseRunLog(review.run_log);

  // Derive the repo name from the repos list (same lookup the Review list page does)
  const repoName = review.repo_name ??
    (review.repo_id ? (repos.find((r) => r.id === review.repo_id)?.name ?? null) : null);

  return (
    <div style={{ maxWidth: 860 }}>
      {/* ── Back ── */}
      <div className="row" style={{ marginBottom: -4 }}>
        <a
          href={href(projectId, 'reviews', 'code')}
          className="btn btn-ghost btn-sm"
          style={{ fontSize: '0.82rem' }}
        >
          <Icon name="chevronLeft" size={13} />
          All reviews
        </a>
      </div>

      {/* ── Header ── */}
      <div className="page-head">
        <div>
          <h1 style={{ fontSize: '1.2rem', marginBottom: 4 }}>
            <code style={{ fontSize: '0.9em' }}>{review.base_ref}</code>
            {' → '}
            <code style={{ fontSize: '0.9em' }}>{review.head_ref}</code>
            {review.pr_number && (
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>PR #{review.pr_number}</span>
            )}
          </h1>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span
              className={`badge ${
                review.status === 'done'    ? 'badge-ok' :
                review.status === 'failed'  ? 'badge-danger' :
                review.status === 'running' ? 'badge-info' :
                'badge-warn'
              }`}
            >
              {review.status}
            </span>
            {review.started_at && (
              <span className="muted" style={{ fontSize: '0.82rem' }}>
                {formatRelative(review.started_at)}
              </span>
            )}
            {review.parent_review_id && (
              <span style={{ fontSize: '0.82rem', color: 'var(--ink-3)' }}>
                Re-run of{' '}
                <a href={href(projectId, 'reviews', 'code', review.parent_review_id)} style={{ color: 'var(--link)' }}>
                  {review.parent_review_id.slice(0, 8)}
                </a>
              </span>
            )}
          </div>
        </div>

        {/* ── Actions ── */}
        <div className="page-actions">
          {/* Re-run */}
          <button
            type="button"
            className="btn"
            onClick={rerun}
            disabled={rerunning || review.status === 'running' || review.status === 'pending'}
            aria-busy={rerunning}
          >
            <Icon name="refresh" size={14} />
            {rerunning ? 'Queuing…' : 'Re-run'}
          </button>

          {/* Post to PR */}
          {canPost && (
            <button
              type="button"
              className="btn"
              onClick={postToPr}
              disabled={posting}
              aria-busy={posting}
            >
              <Icon name="send" size={14} />
              {posting ? 'Posting…' : 'Post to PR'}
            </button>
          )}

          {/* Download */}
          <button
            type="button"
            className="btn"
            onClick={() => downloadReport('xlsx')}
            aria-label="Download Excel report"
          >
            <Icon name="download" size={14} />
            Excel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => downloadReport('docx')}
            aria-label="Download Word report"
          >
            <Icon name="download" size={14} />
            Word
          </button>

          {/* Merge */}
          <button
            type="button"
            className={`btn${canMerge ? ' btn-primary' : ''}`}
            onClick={() => canMerge && setMergeModal(true)}
            disabled={!canMerge}
            title={mergeDisabledReason ?? undefined}
            aria-describedby={mergeDisabledReason ? 'merge-reason' : undefined}
          >
            <Icon name="check" size={14} />
            {isAlreadyMerged ? 'Merged' : 'Merge pull request…'}
          </button>
        </div>
      </div>

      {/* ── Error/status messages ── */}
      {rerunError && <p className="error-note" role="alert">{rerunError}</p>}
      {postResult && <PostResult result={postResult} />}
      {mergeDisabledReason && !isAlreadyMerged && (
        <p id="merge-reason" className="muted" style={{ fontSize: '0.84rem' }}>
          <strong>Merge disabled:</strong> {mergeDisabledReason}
        </p>
      )}

      {/* ── Verdict banner ── */}
      <VerdictBanner
        verdict={verdict}
        threshold={settings?.mergeThreshold}
        merged={isAlreadyMerged ? review.merged_at : null}
      />

      {/* ── Findings ── */}
      <FindingsPanel
        projectId={projectId}
        reviewId={reviewId}
        findings={findings}
        onFindingChange={handleFindingChange}
        onError={(msg) => toast(msg, 'error')}
      />

      {/* ── Reproducibility ── */}
      <ReproducibilityPanel review={review} />

      {/* ── Run log ── */}
      <RunLog runLog={runLog} />

      {/* ── Cost table ── */}
      <CostTable review={review} rateCard={settings?.rateCard} />

      {/* ── Merge dialog ── */}
      {mergeModal && (
        <MergeDialog
          projectId={projectId}
          review={review}
          repoName={repoName}
          onClose={() => setMergeModal(false)}
          onMerged={handleMerged}
          onRerun={rerun}
        />
      )}
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
