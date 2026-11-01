import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Map trigger type to a badge variant.
 * We only have badge-info / badge-ok / badge-danger / badge-warn / badge-neutral
 * so we approximate as best we can without inventing new classes.
 */
const TRIGGER_BADGE = {
  manual:  'badge-neutral',
  cron:    'badge-info',
  interval:'badge-info',
  webhook: 'badge-warn',
  github:  'badge-info',
  jira:    'badge-info',
};

const RUN_STATUS_BADGE = {
  running: 'badge-info',
  done:    'badge-ok',
  failed:  'badge-danger',
  stopped: 'badge-neutral',
};

function TriggerBadge({ type }) {
  return (
    <span className={`badge ${TRIGGER_BADGE[type] ?? 'badge-neutral'}`}>
      {type}
    </span>
  );
}

function StatusBadge({ status }) {
  return (
    <span className={`badge ${RUN_STATUS_BADGE[status] ?? 'badge-neutral'}`}>
      {status}
    </span>
  );
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Add Spec Modal ────────────────────────────────────────────────────────────

function AddSpecModal({ projectId, onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '',
    description: '',
    triggerType: 'manual',
    goalTemplate: '',
    maxIterations: 10,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useFocusTrap();

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/loop-specs`, {
        name: form.name,
        description: form.description,
        triggerType: form.triggerType,
        goalTemplate: form.goalTemplate,
        maxIterations: Number(form.maxIterations),
      });
      onCreated(r.spec);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const overlayDismiss = useOverlayDismiss(onClose);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-spec-title"
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="add-spec-title">Add Loop Spec</h2>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <div className="dialog-body stack">
            <div className="field">
              <label htmlFor="ls-name">Name</label>
              <input
                id="ls-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My loop spec"
                required
                maxLength={200}
              />
            </div>

            <div className="field">
              <label htmlFor="ls-desc">Description</label>
              <input
                id="ls-desc"
                type="text"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional description"
              />
            </div>

            <div className="field">
              <label htmlFor="ls-trigger">Trigger type</label>
              <select
                id="ls-trigger"
                value={form.triggerType}
                onChange={(e) => setForm((f) => ({ ...f, triggerType: e.target.value }))}
              >
                <option value="manual">Manual</option>
                <option value="cron">Cron</option>
                <option value="interval">Interval</option>
                <option value="webhook">Webhook</option>
                <option value="github">GitHub</option>
                <option value="jira">Jira</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="ls-goal">Goal template</label>
              <textarea
                id="ls-goal"
                value={form.goalTemplate}
                onChange={(e) => setForm((f) => ({ ...f, goalTemplate: e.target.value }))}
                placeholder="What should the agent do? Use {{variable}} for placeholders."
                style={{ minHeight: 80, fontFamily: 'var(--mono)', fontSize: 13 }}
              />
            </div>

            <div className="field">
              <label htmlFor="ls-max">Max iterations</label>
              <input
                id="ls-max"
                type="number"
                value={form.maxIterations}
                onChange={(e) => setForm((f) => ({ ...f, maxIterations: e.target.value }))}
                min={1}
                max={50}
                style={{ width: 100 }}
              />
            </div>

            {error && (
              <p className="error-note" role="alert">{error}</p>
            )}
          </div>

          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? 'Creating…' : 'Create Spec'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Loop run history ──────────────────────────────────────────────────────────

function RunHistory({ projectId, specId }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/projects/${projectId}/loop-specs/${specId}/runs?limit=10`)
      .then((r) => setRuns(r.runs || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId, specId]);

  if (loading) return <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading runs…" />;
  if (!runs.length) return <p className="muted" style={{ fontSize: 13, padding: '8px 0' }}>No runs yet.</p>;

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {runs.map((r) => (
        <li key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
          <StatusBadge status={r.status} />
          <span>Iteration {r.iteration}</span>
          <span className="muted">{formatDate(r.started_at)}</span>
          {r.finished_at && (
            <span className="muted">→ {formatDate(r.finished_at)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Spec row ──────────────────────────────────────────────────────────────────

function SpecRow({ spec, projectId, onRunNow, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);

  const handleRunNow = async () => {
    setRunning(true);
    try {
      await onRunNow(spec.id);
    } finally {
      setRunning(false);
    }
  };

  return (
    <li style={{ borderBottom: '1px solid var(--line)', padding: '12px 0' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            {spec.is_builtin ? (
              <span title="Built-in spec" style={{ fontSize: 16 }}>🔒</span>
            ) : null}
            <span style={{ fontWeight: 600, fontSize: 15 }}>{spec.name}</span>
            <TriggerBadge type={spec.trigger_type} />
          </div>
          {spec.description && (
            <p className="muted" style={{ margin: '0 0 4px', fontSize: 13 }}>{spec.description}</p>
          )}
          {spec.last_run && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span className="muted">Last run:</span>
              <StatusBadge status={spec.last_run.status} />
              <span className="muted">{formatDate(spec.last_run.started_at)}</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleRunNow}
            disabled={running || !spec.enabled}
            title={!spec.enabled ? 'This spec is disabled' : 'Run now'}
            aria-busy={running}
          >
            {running ? '▶ Running…' : '▶ Run now'}
          </button>

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide runs' : 'Runs'}
          </button>

          {!spec.is_builtin && onDelete && (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => onDelete(spec.id)}
              title="Delete this spec"
              aria-label={`Delete spec: ${spec.name}`}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>
            Recent runs
          </h4>
          <RunHistory projectId={projectId} specId={spec.id} />

          <div style={{ marginTop: 12 }}>
            <h4 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600 }}>Goal template</h4>
            <pre style={{ background: 'var(--canvas)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>
              {spec.goal_template || '(no goal template)'}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

// ── Main LoopSpecs page ───────────────────────────────────────────────────────

export default function LoopSpecs({ projectId, user }) {
  const [specs, setSpecs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [runMsg, setRunMsg] = useState(null);
  const [runMsgKind, setRunMsgKind] = useState('ok');
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/loop-specs`);
      setSpecs(r.specs || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleRunNow = async (specId) => {
    setRunMsg(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/loop-specs/${specId}/run`, {});
      setRunMsg(`Loop run started. Workflow ID: ${r.workflow_id ?? 'N/A'}`);
      setRunMsgKind('ok');
      // Reload to update last run info
      setTimeout(() => load(), 500);
    } catch (e) {
      setRunMsg(`Error: ${e.message}`);
      setRunMsgKind('error');
    }
  };

  const handleDelete = async (specId) => {
    const ok = await requestConfirm('Delete this loop spec? This cannot be undone.', 'Delete', 'danger');
    if (!ok) return;
    try {
      await api.delete(`/api/projects/${projectId}/loop-specs/${specId}`);
      setSpecs((prev) => prev.filter((s) => s.id !== specId));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const builtins = specs.filter((s) => s.is_builtin);
  const custom = specs.filter((s) => !s.is_builtin);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Loop Specs</h1>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowModal(true)}
          >
            + Add spec
          </button>
        </div>
      </div>

      {error && (
        <p className="error-note" role="alert">{error}</p>
      )}

      {runMsg && (
        <p
          className={runMsgKind === 'ok' ? 'success-note' : 'error-note'}
          role="status"
        >
          {runMsg}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setRunMsg(null)}
            style={{ marginLeft: 12 }}
            aria-label="Dismiss message"
          >
            ✕
          </button>
        </p>
      )}

      {loading ? (
        <div className="spinner" aria-label="Loading loop specs…" />
      ) : (
        <>
          {builtins.length > 0 && (
            <section style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px' }}>
                Built-in specs
              </h2>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {builtins.map((s) => (
                  <SpecRow
                    key={s.id}
                    spec={s}
                    projectId={projectId}
                    onRunNow={handleRunNow}
                    onDelete={null}
                  />
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px' }}>
              Project specs
            </h2>
            {custom.length === 0 ? (
              <div className="empty-state">
                <p>No custom loop specs yet. Click &ldquo;+ Add spec&rdquo; to create one.</p>
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {custom.map((s) => (
                  <SpecRow
                    key={s.id}
                    spec={s}
                    projectId={projectId}
                    onRunNow={handleRunNow}
                    onDelete={handleDelete}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {showModal && (
        <AddSpecModal
          projectId={projectId}
          onClose={() => setShowModal(false)}
          onCreated={(spec) => {
            setShowModal(false);
            setSpecs((prev) => [...prev, spec]);
          }}
        />
      )}
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
