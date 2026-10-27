import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { subscribeProject } from '../../lib/events.js';
import { formatCost, formatDate } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { WorkspaceHeader } from '../../components/WorkspaceHeader.jsx';
import { SessionLive } from './SessionLive.jsx';
import { SessionChanges } from './SessionChanges.jsx';

const TABS = ['live', 'changes', 'activity', 'context', 'settings'];

// ── Activity tab ───────────────────────────────────────────────────────────────

function RunStatusDot({ status }) {
  const cls =
    status === 'running' ? 'dot-running'
    : status === 'failed' ? 'dot-failed'
    : status === 'pending' ? 'dot-pending'
    : 'dot-stopped';
  return <span className={`dot ${cls}`} style={{ flexShrink: 0 }} title={status} aria-label={status} />;
}

function ActivityTab({ runs }) {
  if (!runs || runs.length === 0) {
    return (
      <div className="ws-placeholder" style={{ flex: 1 }}>
        <Icon name="play" size={32} />
        <p>No runs yet</p>
        <p className="small muted">Start the session to see activity.</p>
      </div>
    );
  }

  return (
    <div style={{ overflow: 'auto', flex: 1 }}>
      <table className="data-table" aria-label="Run history">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Started</th>
            <th scope="col">Duration</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const started = r.started_at ? formatDate(r.started_at) : '—';
            const durationMs =
              r.started_at && r.finished_at
                ? new Date(r.finished_at) - new Date(r.started_at)
                : null;
            const duration = durationMs != null ? `${(durationMs / 1000).toFixed(1)}s` : '—';
            const cost = r.cost_usd != null ? formatCost(r.cost_usd) : '—';
            return (
              <tr key={r.id}>
                <td>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <RunStatusDot status={r.status} />
                    {r.status}
                  </span>
                </td>
                <td>{started}</td>
                <td>{duration}</td>
                <td>{cost}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Context tab ────────────────────────────────────────────────────────────────

function ContextTab({ workflow }) {
  if (!workflow) return null;
  const repoIds = workflow.repo_ids || [];

  return (
    <div style={{ overflow: 'auto', flex: 1, padding: '16px 20px', display: 'grid', gap: 16, alignContent: 'start' }}>
      <section>
        <h3 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-3)', marginBottom: 6 }}>
          Goal
        </h3>
        <p style={{ fontSize: '0.875rem', lineHeight: 1.5 }}>{workflow.goal}</p>
      </section>

      <section>
        <h3 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-3)', marginBottom: 6 }}>
          Engine
        </h3>
        <span
          className={
            workflow.engine === 'kiro'
              ? 'badge badge-engine-kiro'
              : workflow.engine === 'claude-code'
              ? 'badge badge-engine-claude'
              : 'badge'
          }
        >
          {workflow.engine || 'demo'}
        </span>
      </section>

      {repoIds.length > 0 && (
        <section>
          <h3 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-3)', marginBottom: 6 }}>
            Repositories
          </h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {repoIds.map((id) => (
              <li key={id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="branch" size={14} style={{ color: 'var(--ink-3)' }} />
                <span style={{ fontSize: '0.84rem', fontFamily: 'var(--mono)' }}>{id}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {workflow.lead_agent && (
        <section>
          <h3 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-3)', marginBottom: 6 }}>
            Lead agent
          </h3>
          <span style={{ fontSize: '0.875rem', fontFamily: 'var(--mono)' }}>{workflow.lead_agent}</span>
        </section>
      )}

      <section>
        <h3 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-3)', marginBottom: 6 }}>
          Trust all tools
        </h3>
        <span style={{ fontSize: '0.875rem' }}>{workflow.trust_tools ? 'Yes' : 'No'}</span>
      </section>
    </div>
  );
}

// ── Settings tab ───────────────────────────────────────────────────────────────

function SettingsTab({ workflow, projectId, onSaved }) {
  const [trustTools, setTrustTools] = useState(workflow?.trust_tools ?? false);
  const [maxIterations, setMaxIterations] = useState(workflow?.max_iterations ?? 10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  // Sync when workflow prop changes
  useEffect(() => {
    if (workflow) {
      setTrustTools(workflow.trust_tools ?? false);
      setMaxIterations(workflow.max_iterations ?? 10);
    }
  }, [workflow]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.put(`/api/projects/${projectId}/workflows/${workflow.id}`, {
        trustTools,
        maxIterations: Number(maxIterations),
      });
      setSaved(true);
      if (onSaved) onSaved();
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ overflow: 'auto', flex: 1, padding: '16px 20px', display: 'grid', gap: 16, alignContent: 'start', maxWidth: 480 }}>
      <div className="field">
        <label className="choice" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={trustTools}
            onChange={(e) => setTrustTools(e.target.checked)}
          />
          <span>
            <strong>Trust all tools</strong>{' '}
            <span className="muted">Agent may run commands without asking first.</span>
          </span>
        </label>
      </div>

      <div className="field" style={{ maxWidth: 180 }}>
        <label htmlFor="ws-max-iters">Max iterations</label>
        <input
          id="ws-max-iters"
          type="number"
          min={1}
          max={100}
          value={maxIterations}
          onChange={(e) => setMaxIterations(e.target.value)}
        />
      </div>

      {error && (
        <div className="error-note" role="alert">
          {error}
        </div>
      )}

      <div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={busy}
        >
          {busy ? (
            <>
              <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
              Saving…
            </>
          ) : saved ? (
            <>
              <Icon name="check" size={14} />
              Saved
            </>
          ) : (
            'Save settings'
          )}
        </button>
      </div>
    </div>
  );
}

// ── Composer bar ───────────────────────────────────────────────────────────────

function ComposerBar({ workflow, projectId, latestRunStatus, onSent }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showCommands] = useState(false);
  const isRunning = latestRunStatus === 'running' || latestRunStatus === 'pending';

  const enginePlaceholder =
    workflow?.engine === 'kiro'
      ? 'Ask Kiro to change something…'
      : workflow?.engine === 'claude-code'
      ? 'Ask Claude to change something…'
      : 'Send a message…';

  const send = async () => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isRunning) {
        await api.post(
          `/api/projects/${projectId}/workflows/${workflow.id}/message`,
          { message: text },
        );
      } else {
        await api.post(
          `/api/projects/${projectId}/workflows/${workflow.id}/message`,
          { message: text },
        );
        // Also start a new run if not currently running
        await api.post(
          `/api/projects/${projectId}/workflows/${workflow.id}/start`,
        );
      }
      setMessage('');
      if (onSent) onSent();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="ws-composer" aria-label="Send message to session">
      {error && (
        <div className="error-note" style={{ margin: '0 0 6px' }} role="alert">
          {error}
        </div>
      )}
      <div className="ws-composer-row">
        {/* Attach (placeholder) */}
        <button
          type="button"
          className="btn-icon"
          title="Attach file (coming soon)"
          aria-label="Attach file"
          disabled
        >
          <Icon name="attach" size={16} />
        </button>

        {/* Input */}
        <input
          type="text"
          className="ws-composer-input"
          placeholder={enginePlaceholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || !workflow}
          aria-label="Message"
        />

        {/* Send */}
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={send}
          disabled={busy || !message.trim() || !workflow}
          aria-label="Send message"
          title="Send (Ctrl+Enter)"
        >
          {busy ? (
            <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
          ) : (
            <Icon name="send" size={14} />
          )}
        </button>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

/**
 * Session workspace (right panel).
 *
 * @param {{
 *   id: string,
 *   project: { id: string, name: string },
 * }} props
 */
export function SessionWorkspace({ id, project }) {
  const [data, setData] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('live');
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [wData, rData] = await Promise.all([
        api.get(`/api/projects/${project.id}/workflows/${id}`),
        api.get(`/api/projects/${project.id}/workflows/${id}/runs`),
      ]);
      setData(wData);
      setRuns(rData.runs || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [id, project.id]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setRuns([]);
    load();
  }, [load]);

  // Real-time updates via project SSE
  useEffect(() => {
    const unsubscribe = subscribeProject(project.id, (event) => {
      if (
        (event.type === 'workflow.updated' && event.id === id) ||
        event.type === 'run.updated'
      ) {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => load(), 300);
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(timerRef.current);
    };
  }, [project.id, id, load]);

  if (loading && !data) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
        <div className="spinner" aria-label="Loading session…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-note" style={{ margin: 24 }} role="alert">
        {error}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={load}
          style={{ marginLeft: 8 }}
        >
          Retry
        </button>
      </div>
    );
  }

  const workflow = data?.workflow;
  const latestRun = data?.latestRun;
  const latestRunId = latestRun?.id ?? null;
  const latestRunStatus = latestRun?.status ?? null;

  const tab = TABS.includes(activeTab) ? activeTab : 'live';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Header */}
      <WorkspaceHeader
        title={workflow?.goal || `Session ${id.slice(0, 8)}`}
        status={workflow?.status}
        engine={workflow?.engine}
        project={project.name}
      />

      {/* Tab bar */}
      <nav
        className="ws-tabs"
        role="tablist"
        aria-label="Session tabs"
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--line)',
          padding: '0 4px',
          flexShrink: 0,
          overflowX: 'auto',
        }}
      >
        {[
          { id: 'live',     label: 'Live' },
          { id: 'changes',  label: 'Changes' },
          { id: 'activity', label: 'Activity' },
          { id: 'context',  label: 'Context' },
          { id: 'settings', label: 'Settings' },
        ].map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`tab-panel-${t.id}`}
            id={`tab-${t.id}`}
            onClick={() => setActiveTab(t.id)}
            style={{
              padding: '8px 14px',
              fontSize: '0.84rem',
              fontWeight: tab === t.id ? 650 : 500,
              border: 'none',
              borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'transparent',
              color: tab === t.id ? 'var(--ink)' : 'var(--ink-2)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* Tab panels */}
      <div
        id={`tab-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      >
        {tab === 'live' && (
          <SessionLive
            runId={latestRunId}
            workflowId={id}
            projectId={project.id}
          />
        )}

        {tab === 'changes' && (
          <SessionChanges runId={latestRunId} />
        )}

        {tab === 'activity' && (
          <ActivityTab runs={runs} />
        )}

        {tab === 'context' && (
          <ContextTab workflow={workflow} />
        )}

        {tab === 'settings' && (
          <SettingsTab
            workflow={workflow}
            projectId={project.id}
            onSaved={load}
          />
        )}
      </div>

      {/* Composer bar — always visible */}
      <ComposerBar
        workflow={workflow}
        projectId={project.id}
        latestRunStatus={latestRunStatus}
        onSent={load}
      />
    </div>
  );
}
