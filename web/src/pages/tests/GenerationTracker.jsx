/**
 * GenerationTracker — reusable progress tracker for script and case-set generation jobs.
 *
 * Each job:
 *   { id, kind: 'generate'|'refine'|'case-set', description,
 *     status: 'pending'|'running'|'done'|'failed'|'cancelled',
 *     error, warnings, progress, startedAt, createdAt,
 *     traceUrl?: string }  ← optional; when set, a "Show steps" toggle appears
 *
 * progress (script): { phase, message, percent, stepsSoFar }
 * progress (case-set): { phase, message, percent, categoriesTotal, categoriesDone, casesSoFar }
 *
 * Props:
 *   jobs           - array of job objects
 *   onDismiss(id)  - dismiss a failed job
 *   onCancel(id)   - cancel a running job
 *   onOpenCasesDialog() - open the "Generate test cases" dialog (script failed hint)
 *   projectId      - string (optional) — used to compute traceUrl when job.traceUrl is absent
 *   tpId           - string (optional) — test-project id
 *
 * Exports: GenerationTracker, StepTimeline (for use in CaseSetViewer finished-state panel)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import './tests-cases.css';

// ── Phase definitions ─────────────────────────────────────────────────────────

const SCRIPT_PHASES  = ['preparing', 'calling', 'parsing', 'saving'];
const SCRIPT_LABELS  = { preparing: 'Preparing', calling: 'Calling model', parsing: 'Parsing', saving: 'Saving' };

const CASE_PHASES = ['queued', 'context', 'outline', 'cases', 'saving'];
const CASE_LABELS = { queued: 'Queued', context: 'Reading specs', outline: 'Planning categories', cases: 'Writing test cases', saving: 'Saving' };

function phasesFor(kind) {
  return kind === 'case-set'
    ? { phases: CASE_PHASES, labels: CASE_LABELS }
    : { phases: SCRIPT_PHASES, labels: SCRIPT_LABELS };
}

function phaseIdx(phases, phase) {
  if (phase === 'done') return phases.length;          // past the last step — all done
  if (phase === 'retrying') return phases.indexOf('calling'); // same step as calling
  const i = phases.indexOf(phase);
  return i === -1 ? 0 : i;
}

function phaseLabel(kind, phase, progress) {
  if (kind === 'case-set' && phase === 'cases' && progress) {
    const { categoriesDone, categoriesTotal, casesSoFar } = progress;
    if (categoriesTotal) {
      return `Writing test cases (${categoriesDone || 0}/${categoriesTotal}, ${casesSoFar || 0} so far)`;
    }
    if (casesSoFar) return `Writing test cases (${casesSoFar} so far)`;
  }
  if (kind !== 'case-set' && phase === 'retrying') return 'Retrying model call';
  const { labels } = phasesFor(kind);
  return labels[phase] || phase;
}

// ── Elapsed timer ──────────────────────────────────────────────────────────────

function useElapsed(startedAt, createdAt) {
  const [elapsed, setElapsed] = useState(() => {
    const ts = startedAt || createdAt;
    if (!ts) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  });

  useEffect(() => {
    const ts = startedAt || createdAt;
    if (!ts) return;
    const origin = new Date(ts).getTime();
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - origin) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt, createdAt]);

  return elapsed;
}

function fmtElapsed(s) {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function ElapsedBadge({ startedAt, createdAt }) {
  const sec = useElapsed(startedAt, createdAt);
  return (
    <span
      data-testid="elapsed-timer"
      style={{ fontSize: '0.75rem', color: 'var(--ink-3)', flexShrink: 0 }}
      aria-label={`Elapsed: ${fmtElapsed(sec)}`}
    >
      {fmtElapsed(sec)}
    </span>
  );
}

// ── Phase stepper ─────────────────────────────────────────────────────────────

function PhaseStepper({ kind, phase, failed }) {
  const { phases, labels } = phasesFor(kind);
  const cur = phaseIdx(phases, phase);

  return (
    <div className="gen-phase-stepper" role="list" aria-label="Generation phases">
      {phases.map((p, i) => {
        const isDone   = !failed && i < cur;
        const isActive = i === cur;
        const cls = [
          'gen-phase-step',
          isDone   ? 'done'   : '',
          isActive ? 'active' : '',
          isActive && failed ? 'failed' : '',
        ].filter(Boolean).join(' ');

        return (
          <div key={p} className={cls} role="listitem">
            <div className="gen-phase-dot" aria-hidden="true" />
            <span className="gen-phase-label">{labels[p]}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Duration formatter ────────────────────────────────────────────────────────

function fmtDuration(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

// ── Copy button (no external deps) ───────────────────────────────────────────

function CopyButton({ text, label = 'Copy', size = 12, style: extraStyle }) {
  const [done, setDone] = useState(false);
  const handle = async (e) => {
    e.stopPropagation();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch { return; }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button
      type="button"
      className="btn-icon"
      onClick={handle}
      aria-label={done ? 'Copied!' : label}
      title={done ? 'Copied!' : label}
      style={{ width: 22, height: 22, ...extraStyle }}
    >
      <Icon name={done ? 'check' : 'copy'} size={size} />
    </button>
  );
}

// ── Step detail helper ────────────────────────────────────────────────────────

function stepDetailText(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const parts = [];
  if (detail.categoriesDone != null && detail.categoriesTotal != null) {
    parts.push(`${detail.categoriesDone}/${detail.categoriesTotal} categories`);
  }
  if (detail.casesSoFar != null) parts.push(`${detail.casesSoFar} cases`);
  if (detail.attempt != null) parts.push(`attempt ${detail.attempt}`);
  if (detail.category) parts.push(String(detail.category));
  if (detail.message) parts.push(String(detail.message));
  return parts.join(' · ');
}

// ── Step dot ─────────────────────────────────────────────────────────────────

function StepDot({ status }) {
  const cls = {
    ok:      'trace-step-dot-ok',
    failed:  'trace-step-dot-failed',
    retry:   'trace-step-dot-retry',
    skipped: 'trace-step-dot-skipped',
    running: 'trace-step-dot-running',
    pending: 'trace-step-dot-pending',
  }[status] || 'trace-step-dot-pending';
  return <div className={`trace-step-dot ${cls}`} aria-hidden="true" />;
}

// ── Single step item ──────────────────────────────────────────────────────────

function StepItem({ step }) {
  const [expanded, setExpanded] = useState(false);
  const key = step.id ?? step.seq;

  const detail = stepDetailText(step.detail);
  const dur    = fmtDuration(step.durationMs);
  const hasExpandable = !!(
    step.prompt || step.output || step.error
  );

  return (
    <li className="trace-step" aria-label={`Step: ${step.label}`}>
      <StepDot status={step.status} />

      <div className="trace-step-body">
        <div className="trace-step-header">
          <span className="trace-step-label">{step.label || step.kind || `Step ${step.seq}`}</span>
          {detail && <span className="trace-step-detail">{detail}</span>}
          {dur && <span className="trace-step-duration">{dur}</span>}
          {hasExpandable && (
            <button
              type="button"
              className="trace-step-expand-btn"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              aria-controls={`trace-step-body-${key}`}
            >
              {expanded ? 'hide' : 'details'}
              <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={10} />
            </button>
          )}
        </div>

        {step.status === 'failed' && step.error && !expanded && (
          <div className="trace-step-error">{step.error}</div>
        )}

        {expanded && (
          <div id={`trace-step-body-${key}`} className="trace-code-section">
            {/* Error */}
            {step.error && (
              <div>
                <div className="trace-code-label">Error</div>
                <div className="trace-step-error" style={{ marginTop: 2 }}>{step.error}</div>
              </div>
            )}

            {/* Prompt */}
            {step.prompt && (
              <div>
                <div className="trace-code-label">Prompt</div>
                {typeof step.prompt === 'object' ? (
                  <>
                    {step.prompt.system && (
                      <div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--ink-3)', marginBottom: 2 }}>System</div>
                        <div style={{ position: 'relative' }}>
                          <pre className="trace-code-block">{step.prompt.system}</pre>
                          <CopyButton
                            text={step.prompt.system}
                            label="Copy system prompt"
                            size={10}
                            style={{ position: 'absolute', top: 4, right: 4 }}
                          />
                        </div>
                      </div>
                    )}
                    {step.prompt.user && (
                      <div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--ink-3)', marginBottom: 2 }}>User</div>
                        <div style={{ position: 'relative' }}>
                          <pre className="trace-code-block">{step.prompt.user}</pre>
                          <CopyButton
                            text={step.prompt.user}
                            label="Copy user prompt"
                            size={10}
                            style={{ position: 'absolute', top: 4, right: 4 }}
                          />
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ position: 'relative' }}>
                    <pre className="trace-code-block">{String(step.prompt)}</pre>
                    <CopyButton
                      text={String(step.prompt)}
                      label="Copy prompt"
                      size={10}
                      style={{ position: 'absolute', top: 4, right: 4 }}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Output */}
            {step.output && (
              <div>
                <div className="trace-code-label">
                  Output
                  {step.truncated && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--warn)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                      {' '}(truncated)
                    </span>
                  )}
                  <CopyButton text={step.output} label="Copy output" size={10} />
                </div>
                <pre className="trace-code-block">{step.output}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// ── Step timeline ─────────────────────────────────────────────────────────────
// Exported so CaseSetViewer can reuse it for finished/failed case sets.

export function StepTimeline({ steps, running }) {
  if (!steps || steps.length === 0) return null;
  return (
    <>
      {/* Live region for screen readers — announces current step while job runs */}
      {running && (
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}
        >
          {(() => {
            const runningStep = steps.find((s) => s.status === 'running');
            const doneCount   = steps.filter((s) => s.status === 'ok').length;
            return runningStep
              ? `Running: ${runningStep.label}`
              : `${doneCount} of ${steps.length} steps complete`;
          })()}
        </div>
      )}
      <ol
        className="trace-timeline"
        aria-label="Generation steps"
        style={{ position: 'relative' }}
      >
        {steps.map((step, i) => (
          <StepItem key={step.id ?? step.seq ?? i} step={step} />
        ))}
      </ol>
    </>
  );
}

// ── Single job row ─────────────────────────────────────────────────────────────

function JobRow({ job, onDismiss, onCancel, onOpenCasesDialog, projectId, tpId, onRetry }) {
  const kind     = job.kind || 'generate';
  const rawPhase = job.progress?.phase;
  const phase    = (!rawPhase || rawPhase === 'queued') ? 'preparing' : rawPhase;
  const percent  = job.progress?.percent;
  const message  = job.progress?.message || '';
  const failed   = job.status === 'failed';
  const running  = job.status === 'pending' || job.status === 'running';
  const label    = phaseLabel(kind, phase, job.progress);
  const isZero   = failed && (/0 step/i.test(job.error || '') || /no usable steps/i.test(job.error || ''));

  const kindLabel = kind === 'case-set' ? 'Test case generation'
    : kind === 'refine' ? 'Refinement'
    : 'Generation';

  // Compute trace URL: prefer explicit job.traceUrl, fall back to computed
  const traceUrl = job.traceUrl || (
    projectId && tpId
      ? (kind === 'case-set'
          ? `/api/projects/${projectId}/tests/${tpId}/case-sets/${job.id}/trace`
          : `/api/projects/${projectId}/tests/${tpId}/generations/${job.id}/trace`)
      : null
  );

  // ── Retry state ───────────────────────────────────────────────────────────
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    if (retrying || !onRetry) return;
    setRetrying(true);
    try {
      await onRetry(job);
      // Component will unmount on success (job replaced); no need to reset
    } catch {
      setRetrying(false);
    }
  };

  // ── Trace steps state ──────────────────────────────────────────────────────
  const [showSteps, setShowSteps] = useState(false);
  const [steps, setSteps]         = useState([]);
  const [stepsLoading, setStepsLoading] = useState(false);
  const pollRef = useRef(null);

  const fetchSteps = useCallback(async () => {
    if (!traceUrl) return;
    try {
      const data = await api.get(traceUrl);
      setSteps(data.steps || []);
    } catch {
      // Ignore — trace may not be available yet
    }
  }, [traceUrl]);

  // Start / stop trace polling based on showSteps + job state
  useEffect(() => {
    if (!showSteps || !traceUrl) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    // Immediate fetch
    setStepsLoading(true);
    fetchSteps().finally(() => setStepsLoading(false));

    if (running) {
      pollRef.current = setInterval(fetchSteps, 2000);
    }
    return () => {
      clearInterval(pollRef.current);
      pollRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSteps, running, traceUrl]);

  // When job transitions from running → done/failed while steps are shown, do one final fetch
  useEffect(() => {
    if (showSteps && !running && traceUrl) {
      fetchSteps();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  return (
    <div
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? undefined : 'polite'}
      style={{
        padding: '10px 14px',
        borderRadius: 'var(--radius)',
        border: `1px solid ${failed
          ? 'color-mix(in srgb, var(--danger, #dc2626) 30%, transparent)'
          : 'color-mix(in srgb, var(--accent, #6366f1) 25%, transparent)'}`,
        background: failed
          ? 'color-mix(in srgb, var(--danger, #dc2626) 8%, var(--canvas))'
          : 'color-mix(in srgb, var(--accent, #6366f1) 8%, var(--canvas))',
        fontSize: '0.84rem',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {failed
          ? <Icon name="warning" size={14} style={{ color: 'var(--danger)', flexShrink: 0 }} aria-hidden="true" />
          : <span className="spinner" style={{ width: 13, height: 13, flexShrink: 0 }} aria-hidden="true" />}
        <span style={{ flex: 1, minWidth: 0, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {failed
            ? `${kindLabel} failed`
            : `${kind === 'case-set' ? 'Generating test cases' : kind === 'refine' ? 'Refining' : 'Generating'}${job.description ? ` \u2014 ${job.description}` : '\u2026'}`}
        </span>
        {running && <ElapsedBadge startedAt={job.startedAt} createdAt={job.createdAt} />}

        {/* Show steps toggle (only when traceUrl is available) */}
        {traceUrl && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowSteps((s) => !s)}
            aria-expanded={showSteps}
            aria-label={showSteps ? 'Hide generation steps' : 'Show generation steps'}
            style={{ padding: '2px 8px', fontSize: '0.78rem', flexShrink: 0 }}
          >
            <Icon name="clock" size={11} />
            {' '}{showSteps ? 'Hide' : 'Show'} steps
          </button>
        )}

        {running && onCancel && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onCancel(job.id)}
            aria-label={`Cancel ${kindLabel.toLowerCase()}`}
            style={{ padding: '2px 8px', fontSize: '0.78rem', flexShrink: 0 }}
          >
            Cancel
          </button>
        )}
        {failed && onRetry && job.retryable !== false && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleRetry}
            disabled={retrying}
            aria-label={`Retry ${kindLabel.toLowerCase()}`}
            style={{ padding: '2px 8px', fontSize: '0.78rem', flexShrink: 0 }}
          >
            {retrying ? 'Retrying\u2026' : 'Retry'}
          </button>
        )}
        {failed && onDismiss && (
          <button
            type="button"
            className="btn-icon"
            onClick={() => onDismiss(job.id)}
            aria-label="Dismiss"
            style={{ flexShrink: 0 }}
          >
            <Icon name="x" size={13} />
          </button>
        )}
      </div>

      {/* Phase stepper while running */}
      {running && (
        <PhaseStepper kind={kind} phase={phase} failed={false} />
      )}

      {/* Progress bar + message */}
      {running && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div
            className="gen-progress-bar"
            role="progressbar"
            aria-valuenow={percent != null ? percent : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={percent != null ? `${percent}% complete` : 'Running…'}
          >
            <div
              className={`gen-progress-fill${percent == null ? ' indeterminate' : ''}`}
              style={percent != null ? { width: `${percent}%` } : undefined}
            />
          </div>
          {(message || label) && (
            <span style={{ fontSize: '0.77rem', color: 'var(--ink-2)' }} aria-live="polite">
              {message || label}
            </span>
          )}
        </div>
      )}

      {/* Error + warnings + hint */}
      {failed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ color: 'var(--danger)' }}>{job.error || 'Unknown error'}</span>
          {isZero && kind !== 'case-set' && onOpenCasesDialog && (
            <span style={{ fontSize: '0.8rem', color: 'var(--ink-2)' }}>
              Got 0 steps?{' '}
              <button
                type="button"
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent, #6366f1)', cursor: 'pointer', fontSize: 'inherit', textDecoration: 'underline' }}
                onClick={onOpenCasesDialog}
              >
                Generate test cases instead
              </button>
            </span>
          )}
          {Array.isArray(job.warnings) && job.warnings.length > 0 && (
            <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: '0.79rem', color: 'var(--ink-2)' }}>
              {job.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Steps trace panel */}
      {showSteps && (
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8, marginTop: 2 }}>
          {stepsLoading && steps.length === 0
            ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-3)', fontSize: '0.8rem' }}>
                <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" />
                Loading steps…
              </div>
            : steps.length === 0
              ? <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ink-3)' }}>No steps recorded yet.</p>
              : <StepTimeline steps={steps} running={running} />
          }
        </div>
      )}
    </div>
  );
}

// ── Exported component ─────────────────────────────────────────────────────────

export function GenerationTracker({ jobs, onDismiss, onCancel, onOpenCasesDialog, projectId, tpId, onRetry }) {
  const visible = (jobs || []).filter(
    (j) => j.status === 'pending' || j.status === 'running' || j.status === 'failed',
  );
  if (visible.length === 0) return null;

  return (
    <div
      aria-label="Generation progress"
      style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}
    >
      {visible.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          onDismiss={onDismiss}
          onCancel={onCancel}
          onOpenCasesDialog={onOpenCasesDialog}
          onRetry={onRetry}
          projectId={projectId}
          tpId={tpId}
        />
      ))}
    </div>
  );
}
