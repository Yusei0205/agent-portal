import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';
import { AiChoicePicker } from '../components/AiChoicePicker.jsx';
import { PageHeader, SectionHead } from '../components/PageHeader.jsx';

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
    cron: '0 9 * * 1-5',
    everyMinutes: 60,
    maxPerHour: 3,
    engine: 'claude-code',
    maxFailures: 3,
    wallClockMinutes: '',
    checks: '',
  });
  const [ai, setAi] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useFocusTrap();

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // One command per line; "name: command" names a step, otherwise the command itself is the name.
      const checks = form.checks.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = /^([\w .-]{1,40}):\s+(.+)$/.exec(l);
        return m ? { step: m[1].trim(), cmd: m[2] } : { step: l.slice(0, 40), cmd: l };
      });
      const triggerConfig = { engine: form.engine, maxPerHour: Number(form.maxPerHour) || 3 };
      if (form.triggerType === 'cron') triggerConfig.cron = form.cron;
      if (form.triggerType === 'interval') triggerConfig.everyMinutes = Number(form.everyMinutes);
      if (ai.credentialId) triggerConfig.credentialId = ai.credentialId;
      if (ai.model) triggerConfig.model = ai.model;
      const stopConfig = { maxConsecutiveFailures: Number(form.maxFailures) || 3 };
      if (Number(form.wallClockMinutes) > 0) stopConfig.wallClockMinutes = Number(form.wallClockMinutes);
      if (checks.length) stopConfig.checks = checks;
      const r = await api.post(`/api/projects/${projectId}/loop-specs`, {
        name: form.name,
        description: form.description,
        triggerType: form.triggerType,
        goalTemplate: form.goalTemplate,
        maxIterations: Number(form.maxIterations),
        triggerConfig,
        stopConfig,
      });
      onCreated(r.spec, r.webhookSecret);
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

            {form.triggerType === 'cron' && (
              <div className="field">
                <label htmlFor="ls-cron">Cron (minute hour day month weekday, UTC)</label>
                <input id="ls-cron" type="text" value={form.cron} style={{ fontFamily: 'var(--mono)' }}
                  onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))} />
                <p className="field-hint">For example <code>0 9 * * 1-5</code> is 09:00 UTC on weekdays. Not more often than every few minutes.</p>
              </div>
            )}
            {form.triggerType === 'interval' && (
              <div className="field">
                <label htmlFor="ls-every">Every (minutes, at least 5)</label>
                <input id="ls-every" type="number" min={5} value={form.everyMinutes} style={{ width: 120 }}
                  onChange={(e) => setForm((f) => ({ ...f, everyMinutes: e.target.value }))} />
              </div>
            )}
            {form.triggerType === 'webhook' && (
              <p className="field-hint">A secret and the address to call are shown once, after you create the spec.</p>
            )}
            {['github', 'jira'].includes(form.triggerType) && (
              <p className="field-hint">This kind does not start sessions yet. Use a webhook to start one from {form.triggerType === 'jira' ? 'Jira' : 'GitHub'}.</p>
            )}

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
              <label htmlFor="ls-engine">Agent</label>
              <select id="ls-engine" value={form.engine} onChange={(e) => setForm((f) => ({ ...f, engine: e.target.value }))}>
                <option value="claude-code">Claude Code</option>
                <option value="kiro">Kiro</option>
                <option value="demo">Demo (no AI)</option>
              </select>
            </div>
            {form.engine !== 'demo' && <AiChoicePicker onChange={setAi} idPrefix="ls-ai" />}

            <div className="field">
              <label htmlFor="ls-checks">Checks after each iteration (optional)</label>
              <textarea id="ls-checks" value={form.checks} placeholder={'tests: npm test\nlint: npm run lint'}
                onChange={(e) => setForm((f) => ({ ...f, checks: e.target.value }))}
                style={{ minHeight: 60, fontFamily: 'var(--mono)', fontSize: 13 }} />
              <p className="field-hint">One command per line, run by the agent runner after each iteration. Commands the agent could not run are refused.</p>
            </div>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div className="field">
                <label htmlFor="ls-fail">Stop after failures in a row</label>
                <input id="ls-fail" type="number" min={1} max={10} value={form.maxFailures} style={{ width: 100 }}
                  onChange={(e) => setForm((f) => ({ ...f, maxFailures: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="ls-wall">Stop after (minutes)</label>
                <input id="ls-wall" type="number" min={0} value={form.wallClockMinutes} placeholder="no limit" style={{ width: 120 }}
                  onChange={(e) => setForm((f) => ({ ...f, wallClockMinutes: e.target.value }))} />
              </div>
              {form.triggerType !== 'manual' && (
                <div className="field">
                  <label htmlFor="ls-perhour">Most starts per hour</label>
                  <input id="ls-perhour" type="number" min={1} max={60} value={form.maxPerHour} style={{ width: 100 }}
                    onChange={(e) => setForm((f) => ({ ...f, maxPerHour: e.target.value }))} />
                </div>
              )}
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

            {form.triggerType !== 'manual' && (
              <p className="field-hint">Sessions started by a trigger run as you, as long as you can edit this project. They never trust all tools: a tool that needs approval waits in the inbox.</p>
            )}

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

function WebhookSecretPanel({ projectId, secretInfo, onClose }) {
  const url = `${window.location.origin}/api/hooks/loop-specs/${secretInfo.specId}`;
  return (
    <div className="dialog-overlay" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="hook-title">
        <div className="dialog-head"><h2 className="dialog-title" id="hook-title">Webhook for {secretInfo.name}</h2></div>
        <div className="dialog-body stack">
          <p>Copy the secret now. It is not shown again (you can make a new one from the spec).</p>
          <div className="field"><label>Address (POST)</label><input readOnly value={url} onFocus={(e) => e.target.select()} /></div>
          <div className="field"><label>Secret</label><input readOnly value={secretInfo.secret} onFocus={(e) => e.target.select()} style={{ fontFamily: 'var(--mono)' }} /></div>
          <p className="field-hint">
            Send the JSON body with the header <code>x-portal-signature: sha256=&lt;HMAC-SHA256 of the body, keyed with the secret&gt;</code>.
            Values in the body can be used in the goal template, for example <code>{'{{issue.key}}'}</code>.
          </p>
        </div>
        <div className="dialog-foot"><button type="button" className="btn btn-primary" onClick={onClose}>I have copied it</button></div>
      </div>
    </div>
  );
}

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
  const [secretInfo, setSecretInfo] = useState(null);
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
      <PageHeader title="Loop specs" description="Reusable loop sessions: the goal, the checks that decide when it is done, and what starts it (by hand, on a schedule, or from a webhook).">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowModal(true)}
        >
          <Icon name="plus" size={14} />
          Add spec
        </button>
      </PageHeader>

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
          onCreated={(spec, secret) => {
            setShowModal(false);
            setSpecs((prev) => [...prev, spec]);
            if (secret) setSecretInfo({ specId: spec.id, name: spec.name, secret });
          }}
        />
      )}
      {secretInfo && <WebhookSecretPanel projectId={projectId} secretInfo={secretInfo} onClose={() => setSecretInfo(null)} />}
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
