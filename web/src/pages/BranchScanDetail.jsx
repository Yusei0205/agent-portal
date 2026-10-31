/**
 * Branch Scan Detail page (F9).
 * Rendered at #/p/:pid/reviews/branch-scans/:sid
 *
 * States: Estimating → Estimate ready → Queued → Fetching → Reviewing → Completed/Failed
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SCAN_STEPS = [
  { key: 'estimating',     label: 'Estimating' },
  { key: 'estimate_ready', label: 'Estimate ready' },
  { key: 'queued',         label: 'Queued' },
  { key: 'fetching',       label: 'Fetching' },
  { key: 'reviewing',      label: 'Reviewing' },
  { key: 'completed',      label: 'Completed' },
];

const STEP_ORDER = SCAN_STEPS.map((s) => s.key);

/**
 * Token-based severity colours — used for the filter-button borders only.
 * Finding items use the .finding-item-* CSS classes (defined in components.css).
 */
const SEVERITY_COLORS = {
  critical: 'var(--danger)',
  high:     'color-mix(in srgb, var(--danger) 55%, var(--warn))',
  medium:   'var(--warn)',
  low:      'var(--ok)',
  info:     'var(--info)',
};

function stepIndex(status) {
  if (status === 'failed') return -1;
  return STEP_ORDER.indexOf(status);
}

function SeverityBadge({ severity }) {
  return (
    <span
      className={`badge badge-sev-${severity ?? 'info'}`}
      style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}
    >
      {severity}
    </span>
  );
}

function fmtUsd(n) {
  if (n == null) return '—';
  return `$${Number(n).toFixed(4)}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Status stepper ────────────────────────────────────────────────────────────
// Uses .stepper / .stepper-step / .stepper-dot / .stepper-connector / .stepper-label
// CSS classes from components.css — all colours are theme tokens.

function StatusStepper({ status }) {
  const currentIdx = stepIndex(status);
  const failed = status === 'failed';

  return (
    <div
      role="list"
      aria-label="Scan progress"
      className="stepper"
    >
      {SCAN_STEPS.map((step, idx) => {
        const done   = !failed && currentIdx > idx;
        const active = !failed && currentIdx === idx;

        return (
          <div key={step.key} role="listitem" style={{ display: 'flex', alignItems: 'center' }}>
            <div className="stepper-step">
              <div
                className={`stepper-dot${done ? ' is-done' : active ? ' is-active' : ''}`}
                aria-current={active ? 'step' : undefined}
              >
                {done && '✓'}
                {active && (
                  <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2, margin: 0 }} />
                )}
              </div>
              <span className={`stepper-label${active ? ' is-active' : ''}`}>
                {step.label}
              </span>
            </div>
            {idx < SCAN_STEPS.length - 1 && (
              <div
                className={`stepper-connector${done ? ' is-done' : ''}`}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
      {failed && (
        <div role="listitem" style={{ display: 'flex', alignItems: 'center' }}>
          <div className="stepper-step" style={{ marginLeft: 8 }}>
            <div className="stepper-dot is-failed" aria-label="Failed">✕</div>
            <span className="stepper-label is-failed">Failed</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Estimate card ─────────────────────────────────────────────────────────────

function EstimateCard({ scan }) {
  if (scan.estimated_files == null) return null;

  return (
    <div
      role="region"
      aria-label="Scan estimate"
      className="card"
      style={{ marginBottom: 16 }}
    >
      <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Estimate</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
        {[
          { label: 'Files',     value: scan.estimated_files?.toLocaleString() ?? '—' },
          { label: 'Tokens',    value: fmtTokens(scan.estimated_tokens) },
          { label: 'Est. cost', value: fmtUsd(scan.estimated_cost_usd) },
          { label: 'Est. time', value: scan.estimated_minutes != null ? `~${Math.ceil(scan.estimated_minutes)} min` : '—' },
        ].map(({ label, value }) => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
            <div className="muted" style={{ fontSize: 12 }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Budget confirm ────────────────────────────────────────────────────────────

function BudgetConfirm({ scan, projectId, onConfirmed }) {
  const [budget, setBudget] = useState(
    scan.budget_tokens
      ? String(scan.budget_tokens)
      : scan.estimated_tokens
      ? String(Math.ceil(scan.estimated_tokens * 1.1)) // 10% headroom default
      : '',
  );
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  const confirm = async (e) => {
    e.preventDefault();
    const tokens = parseInt(budget, 10);
    if (!tokens || tokens < 1) { setError('Enter a valid token budget.'); return; }
    setConfirming(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/scans/${scan.id}/confirm`, { budgetTokens: tokens });
      onConfirmed(r.scan);
    } catch (e) {
      setError(e.message);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="Confirm scan budget"
      style={{
        background: 'var(--info-wash)',
        border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)',
        borderRadius: 'var(--radius)',
        padding: '14px 16px',
        marginBottom: 16,
      }}
    >
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Confirm budget to start</h3>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Set the maximum number of tokens this scan may use. The scan will stop when this limit is reached and can be resumed.
      </p>
      <form onSubmit={confirm} noValidate style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="scan-budget">Token budget</label>
          <input
            id="scan-budget"
            type="number"
            min="1000"
            step="1000"
            value={budget}
            onChange={(e) => { setBudget(e.target.value); setError(null); }}
            style={{ width: 160 }}
            aria-describedby="scan-budget-hint"
          />
          <p className="field-hint" id="scan-budget-hint">
            {scan.estimated_tokens ? `Estimated: ${fmtTokens(scan.estimated_tokens)}` : ''}
          </p>
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={confirming}
          style={{ marginBottom: 22 }}
        >
          {confirming ? 'Starting…' : 'Confirm and start'}
        </button>
      </form>
      {error && <p className="error-note" role="alert" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────
// Uses .progress-track / .progress-fill / .progress-fill.is-danger from components.css

function ProgressSection({ scan }) {
  if (!scan.files_total) return null;

  const pct = Math.min(100, Math.round((scan.files_done / scan.files_total) * 100));
  const budgetPct = scan.budget_tokens
    ? Math.min(100, Math.round((scan.tokens_used / scan.budget_tokens) * 100))
    : null;

  return (
    <div
      role="region"
      aria-label="Scan progress"
      className="card"
      style={{ marginBottom: 16 }}
    >
      <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Progress</h3>
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span>Files reviewed</span>
          <span><strong>{scan.files_done}</strong> / {scan.files_total}</span>
        </div>
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Files progress"
          className="progress-track"
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {budgetPct != null && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span>Token budget</span>
            <span><strong>{fmtTokens(scan.tokens_used)}</strong> / {fmtTokens(scan.budget_tokens)}</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={budgetPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Token budget progress"
            className="progress-track"
          >
            <div
              className={`progress-fill${budgetPct > 85 ? ' is-danger' : ''}`}
              style={{ width: `${budgetPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Findings viewer ───────────────────────────────────────────────────────────

function FindingsViewer({ projectId, reviewId }) {
  const [findings, setFindings]     = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [severityFilter, setSeverityFilter] = useState('all');
  const { toast, toasts, removeToast } = useToast();

  const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

  const load = useCallback(async () => {
    if (!reviewId) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/reviews/${reviewId}/findings`);
      setFindings(r.findings || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, reviewId]);

  useEffect(() => { load(); }, [load]);

  const accept = async (fid, accepted) => {
    try {
      await api.put(`/api/projects/${projectId}/reviews/${reviewId}/findings/${fid}`, { accepted });
      setFindings((prev) => prev.map((f) => f.id === fid ? { ...f, accepted } : f));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  if (!reviewId) return <p className="muted">Findings will appear after the scan starts reviewing.</p>;
  if (loading) return <div className="spinner" aria-label="Loading findings…" />;
  if (error) return (
    <div>
      <p className="error-note" role="alert">{error}</p>
      <button type="button" className="btn btn-sm" onClick={load}>Retry</button>
    </div>
  );

  const filtered = severityFilter === 'all'
    ? findings
    : findings.filter((f) => f.severity === severityFilter);

  // Group by file
  const byFile = {};
  for (const f of filtered) {
    const fp = f.file_path || '(general)';
    if (!byFile[fp]) byFile[fp] = [];
    byFile[fp].push(f);
  }
  const fileKeys = Object.keys(byFile).sort();

  return (
    <div>
      {/* Severity filter */}
      {findings.length > 0 && (
        <div role="group" aria-label="Filter by severity" style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn-sm${severityFilter === 'all' ? ' btn-primary' : ''}`}
            onClick={() => setSeverityFilter('all')}
            aria-pressed={severityFilter === 'all'}
          >
            All ({findings.length})
          </button>
          {SEVERITIES.map((sev) => {
            const count = findings.filter((f) => f.severity === sev).length;
            if (!count) return null;
            return (
              <button
                key={sev}
                type="button"
                className={`btn btn-sm${severityFilter === sev ? ' btn-primary' : ''}`}
                style={severityFilter !== sev ? { borderColor: SEVERITY_COLORS[sev], color: SEVERITY_COLORS[sev] } : {}}
                onClick={() => setSeverityFilter(sev)}
                aria-pressed={severityFilter === sev}
              >
                {sev} ({count})
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="muted">{findings.length === 0 ? 'No findings yet.' : 'No findings match the selected filter.'}</p>
      ) : (
        fileKeys.map((fp) => (
          <details key={fp} style={{ marginBottom: 10 }} open>
            <summary
              style={{
                cursor: 'pointer', fontWeight: 600, fontSize: 13,
                padding: '6px 8px', background: 'var(--canvas)',
                borderRadius: 4, border: '1px solid var(--line)',
                fontFamily: 'var(--mono)',
              }}
            >
              {fp}
              <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                ({byFile[fp].length} finding{byFile[fp].length !== 1 ? 's' : ''})
              </span>
            </summary>
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
              {byFile[fp].map((f) => (
                <li
                  key={f.id}
                  className={`finding-item finding-item-${f.severity ?? 'info'}${f.accepted === -1 ? ' is-dismissed' : ''}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <SeverityBadge severity={f.severity} />
                    {f.line_number && (
                      <code style={{ fontSize: 12, color: 'var(--ink-2)' }}>line {f.line_number}</code>
                    )}
                    {f.posted_at && (
                      <span style={{ fontSize: 11, color: 'var(--ok)' }}>✓ posted</span>
                    )}
                  </div>
                  <p style={{ margin: '4px 0', fontWeight: 500, fontSize: 14 }}>{f.title}</p>
                  <p style={{ margin: '4px 0', fontSize: 13, color: 'var(--ink-2)' }}>{f.body}</p>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    {f.accepted !== 1 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ background: 'var(--ok-wash)', borderColor: 'color-mix(in srgb, var(--ok) 35%, transparent)' }}
                        onClick={() => accept(f.id, 1)}
                        aria-label="Accept finding"
                      >
                        ✓ Accept
                      </button>
                    )}
                    {f.accepted !== -1 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ background: 'var(--danger-wash)', borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)' }}
                        onClick={() => accept(f.id, -1)}
                        aria-label="Dismiss finding"
                      >
                        ✕ Dismiss
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        ))
      )}
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

// ── Main detail page ───────────────────────────────────────────────────────────

export default function BranchScanDetail({ projectId, scanId, user }) {
  const [scan, setScan]       = useState(null);
  const [repoName, setRepoName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [resuming, setResuming] = useState(false);
  const isAdmin = Boolean(user?.is_admin);
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/api/projects/${projectId}/scans/${scanId}`);
      setScan(r.scan);
      if (r.scan.repo_id) {
        api.get(`/api/projects/${projectId}/repos`)
          .then((res) => {
            const found = (res.repos || []).find((repo) => repo.id === r.scan.repo_id);
            if (found) setRepoName(found.name);
          })
          .catch(() => {});
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, scanId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 4 seconds while scan is running
  useEffect(() => {
    const ACTIVE = ['estimating', 'queued', 'fetching', 'reviewing'];
    if (!scan || !ACTIVE.includes(scan.status)) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [scan?.status, load]);

  const handleConfirmed = (updatedScan) => {
    setScan(updatedScan);
  };

  const resume = async () => {
    setResuming(true);
    try {
      const r = await api.post(`/api/projects/${projectId}/scans/${scanId}/resume`, {});
      setScan(r.scan);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setResuming(false);
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <div className="spinner" aria-label="Loading scan…" />
      </div>
    );
  }

  if (error) {
    return (
      <>
        <p className="error-note" role="alert">{error}</p>
        <button type="button" className="btn" onClick={load}>Retry</button>
      </>
    );
  }

  if (!scan) {
    return <p className="muted">Scan not found.</p>;
  }

  const canResume = scan.status === 'failed' || (scan.status === 'estimate_ready' && scan.budget_tokens != null);
  const needsBudget = scan.status === 'estimate_ready' && scan.budget_tokens == null;

  return (
    <>
      {/* Back link */}
      <a
        href={`#/p/${encodeURIComponent(projectId)}/reviews/branch-scans`}
        className="btn btn-ghost btn-sm"
        style={{ fontSize: '0.82rem', marginBottom: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Icon name="chevronLeft" size={13} />
        All branch scans
      </a>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            Branch scan
            {scan.branch ? (
              <>
                {' — '}
                <code style={{ background: 'var(--canvas)', padding: '2px 6px', borderRadius: 3, fontSize: 16 }}>
                  {scan.branch}
                </code>
              </>
            ) : null}
          </h1>
          {repoName && <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>Repository: {repoName}</p>}
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
            Created {formatRelative(scan.created_at)}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {canResume && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={resume}
              disabled={resuming}
              aria-label="Resume scan"
            >
              {resuming ? 'Resuming…' : 'Resume scan'}
            </button>
          )}
        </div>
      </div>

      {/* Stepper */}
      <StatusStepper status={scan.status} />

      {/* Failure reason */}
      {scan.status === 'failed' && scan.fail_reason && (
        <div
          role="alert"
          className="error-note"
          style={{ marginBottom: 16, fontSize: 14 }}
        >
          <strong>Scan failed:</strong> {scan.fail_reason}
        </div>
      )}

      {/* Estimate card */}
      <EstimateCard scan={scan} />

      {/* Budget confirm */}
      {needsBudget && (
        <BudgetConfirm
          scan={scan}
          projectId={projectId}
          onConfirmed={handleConfirmed}
        />
      )}

      {/* Progress */}
      {['fetching', 'reviewing', 'completed'].includes(scan.status) && (
        <ProgressSection scan={scan} />
      )}

      {/* Findings */}
      {scan.review_id && (
        <section aria-label="Scan findings">
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Findings</h2>
          <FindingsViewer
            projectId={projectId}
            reviewId={scan.review_id}
          />
        </section>
      )}

      {/* No findings yet */}
      {!scan.review_id && ['estimating', 'estimate_ready', 'queued'].includes(scan.status) && (
        <p className="muted" style={{ marginTop: 16 }}>
          Findings will appear here once the scan starts reviewing files.
        </p>
      )}
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </>
  );
}
