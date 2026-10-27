import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const TRIGGER_COLORS = {
  manual: '#6b7280',
  cron: '#7c3aed',
  interval: '#0891b2',
  webhook: '#d97706',
  github: '#1d4ed8',
  jira: '#0052cc',
};

const RUN_STATUS_COLORS = {
  running: '#2563eb',
  done: '#16a34a',
  failed: '#dc2626',
  stopped: '#6b7280',
};

function TriggerBadge({ type }) {
  return (
    <span
      style={{
        background: TRIGGER_COLORS[type] ?? '#6b7280',
        color: '#fff',
        borderRadius: 4,
        padding: '1px 8px',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {type}
    </span>
  );
}

function StatusBadge({ status }) {
  return (
    <span
      style={{
        background: RUN_STATUS_COLORS[status] ?? '#6b7280',
        color: '#fff',
        borderRadius: 4,
        padding: '1px 8px',
        fontSize: 12,
        fontWeight: 600,
      }}
    >
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

  const field = (label, key, type = 'text', props = {}) => (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>{label}</span>
      {type === 'textarea' ? (
        <textarea
          value={form[key]}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, boxSizing: 'border-box', minHeight: 80, fontFamily: 'monospace', fontSize: 13 }}
          {...props}
        />
      ) : (
        <input
          type={type}
          value={form[key]}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
          style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4, boxSizing: 'border-box' }}
          {...props}
        />
      )}
    </label>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add loop spec"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: '#fff', borderRadius: 8, padding: 24, width: 480, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>Add Loop Spec</h2>
        <form onSubmit={submit}>
          {field('Name', 'name', 'text', { required: true, placeholder: 'My loop spec' })}
          {field('Description', 'description', 'text', { placeholder: 'Optional description' })}

          <label style={{ display: 'block', marginBottom: 12 }}>
            <span style={{ fontWeight: 500, display: 'block', marginBottom: 4 }}>Trigger type</span>
            <select
              value={form.triggerType}
              onChange={(e) => setForm((f) => ({ ...f, triggerType: e.target.value }))}
              style={{ width: '100%', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}
            >
              <option value="manual">Manual</option>
              <option value="cron">Cron</option>
              <option value="interval">Interval</option>
              <option value="webhook">Webhook</option>
              <option value="github">GitHub</option>
              <option value="jira">Jira</option>
            </select>
          </label>

          {field('Goal template', 'goalTemplate', 'textarea', { placeholder: 'What should the agent do? Use {{variable}} for placeholders.' })}

          {field('Max iterations', 'maxIterations', 'number', { min: 1, max: 50 })}

          {error && <p style={{ color: '#dc2626', margin: '8px 0', fontSize: 14 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: 4, background: '#fff', cursor: 'pointer' }}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', opacity: loading ? 0.7 : 1 }}
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

  if (loading) return <div style={{ padding: '8px 0', color: '#6b7280', fontSize: 13 }}>Loading runs…</div>;
  if (!runs.length) return <div style={{ padding: '8px 0', color: '#6b7280', fontSize: 13 }}>No runs yet.</div>;

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {runs.map((r) => (
        <li key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
          <StatusBadge status={r.status} />
          <span>Iteration {r.iteration}</span>
          <span style={{ color: '#9ca3af' }}>{formatDate(r.started_at)}</span>
          {r.finished_at && (
            <span style={{ color: '#9ca3af' }}>→ {formatDate(r.finished_at)}</span>
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
    <li style={{ borderBottom: '1px solid #f3f4f6', padding: '12px 0' }}>
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
            <p style={{ margin: '0 0 4px', fontSize: 13, color: '#6b7280' }}>{spec.description}</p>
          )}
          {spec.last_run && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#9ca3af' }}>
              <span>Last run:</span>
              <StatusBadge status={spec.last_run.status} />
              <span>{formatDate(spec.last_run.started_at)}</span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          <button
            onClick={handleRunNow}
            disabled={running || !spec.enabled}
            title={!spec.enabled ? 'This spec is disabled' : 'Run now'}
            style={{
              padding: '5px 12px', fontSize: 13, background: '#2563eb', color: '#fff',
              border: 'none', borderRadius: 4, cursor: spec.enabled ? 'pointer' : 'not-allowed',
              opacity: running || !spec.enabled ? 0.6 : 1,
            }}
          >
            {running ? '▶ Running…' : '▶ Run now'}
          </button>

          <button
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            style={{ padding: '5px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff', cursor: 'pointer' }}
          >
            {expanded ? 'Hide runs' : 'Runs'}
          </button>

          {!spec.is_builtin && onDelete && (
            <button
              onClick={() => onDelete(spec.id)}
              title="Delete this spec"
              style={{ padding: '5px 10px', fontSize: 13, color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 4, background: '#fff', cursor: 'pointer' }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: '#374151' }}>
            Recent runs
          </h4>
          <RunHistory projectId={projectId} specId={spec.id} />

          <div style={{ marginTop: 12 }}>
            <h4 style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: '#374151' }}>Goal template</h4>
            <pre style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 4, padding: '8px 12px', fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>
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
      // Reload to update last run info
      setTimeout(() => load(), 500);
    } catch (e) {
      setRunMsg(`Error: ${e.message}`);
    }
  };

  const handleDelete = async (specId) => {
    if (!confirm('Delete this loop spec? This cannot be undone.')) return;
    try {
      await api.delete(`/api/projects/${projectId}/loop-specs/${specId}`);
      setSpecs((prev) => prev.filter((s) => s.id !== specId));
    } catch (e) {
      alert(e.message);
    }
  };

  const builtins = specs.filter((s) => s.is_builtin);
  const custom = specs.filter((s) => !s.is_builtin);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Loop Specs</h1>
        <button
          onClick={() => setShowModal(true)}
          style={{
            padding: '8px 16px', background: '#2563eb', color: '#fff',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 500,
          }}
        >
          + Add spec
        </button>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 4, padding: '8px 12px', marginBottom: 16, color: '#dc2626' }}>
          {error}
        </div>
      )}

      {runMsg && (
        <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 4, padding: '8px 12px', marginBottom: 16, color: '#166534', fontSize: 14 }}>
          {runMsg}
          <button onClick={() => setRunMsg(null)} style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#166534' }}>✕</button>
        </div>
      )}

      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading loop specs…</p>
      ) : (
        <>
          {builtins.length > 0 && (
            <section style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px', color: '#374151' }}>
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
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px', color: '#374151' }}>
              Project specs
            </h2>
            {custom.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: 14 }}>No custom loop specs yet. Click "+ Add spec" to create one.</p>
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
    </div>
  );
}
