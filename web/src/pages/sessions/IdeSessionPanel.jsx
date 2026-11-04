/**
 * IdeSessionPanel — Activity, Context, and Settings views for the session.
 *
 * Re-homes the views that existed in the old SessionWorkspace before the IDE
 * refactor (Activity = run history, Context = attached context items,
 * Settings = goal / trust-tools / max-iterations).
 *
 * PUT /api/projects/:pid/workflows/:wid is used to persist settings changes.
 * Both "type" (run events) and "kind" (workflow events) fields are handled
 * defensively so the component works against old and new backend shapes.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { formatRelative } from '../../lib/util.js';
import { TicketPreview } from '../../components/TicketPreview.jsx';

// ── Activity tab ──────────────────────────────────────────────────────────────

function ActivityPanel({ workflowId, projectId }) {
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(
        `/api/projects/${projectId}/workflows/${workflowId}`,
      );
      // Defensive: handle both old shape (data.events) and new shape (no events)
      const evts = data.events ?? data.workflow?.events ?? [];
      setEvents(Array.isArray(evts) ? evts : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [workflowId, projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <div className="spinner" style={{ margin: '0 auto' }} aria-label="Loading activity…" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="error-note" style={{ margin: 8 }} role="alert">
        {error}
        <button type="button" className="btn btn-sm btn-ghost" onClick={load} style={{ marginLeft: 6 }}>
          Retry
        </button>
      </div>
    );
  }
  if (!events || events.length === 0) {
    return (
      <div className="ws-placeholder" style={{ padding: '24px 12px', textAlign: 'center' }}>
        <Icon name="history" size={28} />
        <p style={{ fontSize: '0.84rem', marginTop: 6 }}>No activity yet</p>
        <p style={{ fontSize: '0.75rem', opacity: 0.65 }}>Events appear once the session starts</p>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div
        style={{
          padding: '4px 8px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <span style={{ flex: 1, fontSize: '0.73rem', color: 'var(--ink-3)' }}>
          {events.length} event{events.length !== 1 ? 's' : ''}
        </span>
        <button
          type="button"
          className="btn-icon"
          title="Refresh"
          aria-label="Refresh activity"
          style={{ width: 22, height: 22 }}
          onClick={load}
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <ol aria-label="Activity events" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {[...events].reverse().map((ev, i) => {
          // Support both type (run events) and kind (workflow events)
          const kind = ev.type ?? ev.kind ?? 'unknown';
          const body = ev.body ?? ev.payload?.text ?? ev.payload?.content ?? '';
          const when = ev.created_at ?? ev.timestamp ?? '';
          return (
            <li
              key={ev.id ?? i}
              style={{
                padding: '6px 10px',
                borderBottom: '1px solid var(--line)',
                fontSize: '0.78rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: body ? 2 : 0,
                }}
              >
                <span
                  style={{
                    fontSize: '0.68rem',
                    color: 'var(--ink-3)',
                    fontFamily: 'var(--mono)',
                    background: 'var(--canvas)',
                    padding: '1px 4px',
                    borderRadius: 3,
                  }}
                >
                  {kind}
                </span>
                {when && (
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: '0.67rem',
                      color: 'var(--ink-3)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatRelative(when)}
                  </span>
                )}
              </div>
              {body ? (
                <p style={{ margin: 0, wordBreak: 'break-word', color: 'var(--ink)' }}>
                  {String(body).slice(0, 200)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ── Context tab ───────────────────────────────────────────────────────────────

/**
 * The repositories attached to this session. The agent gets a shallow copy of each under repos/<name>/ at the
 * start of its next message. Repositories are added to the portal project first (Repositories page).
 */
function RepositoriesSection({ workflow, projectId }) {
  const [repos, setRepos]   = useState(null);          // every repository of the project
  const [attached, setAttached] = useState(Array.isArray(workflow?.repo_ids) ? workflow.repo_ids : []);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);
  const [pick, setPick]     = useState('');
  const [prep, setPrep]     = useState(null);          // how far getting the repositories ready has got

  // Follow the preparation (the portal clones the repositories into the session's storage in the background).
  useEffect(() => {
    if (attached.length === 0) { setPrep(null); return undefined; }
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const d = await api.get(`/api/projects/${projectId}/workflows/${workflow.id}/repo-prep`);
        if (cancelled) return;
        setPrep(d.prep ?? null);
        if (d.prep?.state === 'running') timer = setTimeout(tick, 3000);
      } catch { /* the status line is optional */ }
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [attached.join(','), projectId, workflow?.id]);

  useEffect(() => {
    let cancelled = false;
    api.get(`/api/projects/${projectId}/repos`)
      .then((d) => { if (!cancelled) setRepos(d.repos ?? d ?? []); })
      .catch(() => { if (!cancelled) setRepos([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  const save = async (ids) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.patch(`/api/projects/${projectId}/workflows/${workflow.id}`, { repoIds: ids });
      const next = r?.workflow?.repo_ids;
      setAttached(Array.isArray(next) ? next : ids);
      setPick('');
    } catch (e) {
      setError(e.message || 'Could not update the repositories');
    } finally {
      setBusy(false);
    }
  };

  const byId = new Map((repos ?? []).map((r) => [r.id, r]));
  const available = (repos ?? []).filter((r) => !attached.includes(r.id));

  return (
    <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-3)', marginBottom: 6 }}>
        Repositories
      </div>
      {attached.length === 0 && (
        <p className="muted" style={{ fontSize: '0.76rem', margin: '0 0 6px' }}>
          None attached. Add one to give the agent its code.
        </p>
      )}
      {attached.map((id) => (
        <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', padding: '2px 0' }}>
          <Icon name="branch" size={13} />
          <span style={{ flex: 1, wordBreak: 'break-word' }}>{byId.get(id)?.name ?? id}</span>
          <button
            type="button"
            className="btn-icon"
            aria-label={`Remove ${byId.get(id)?.name ?? 'repository'}`}
            disabled={busy}
            onClick={() => save(attached.filter((x) => x !== id))}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      {repos !== null && available.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <select
            className="input"
            aria-label="Repository to add"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            style={{ flex: 1, minWidth: 0, fontSize: '0.8rem' }}
          >
            <option value="">Add a repository…</option>
            {available.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !pick}
            onClick={() => save([...attached, pick])}
          >
            Add
          </button>
        </div>
      )}
      {repos !== null && repos.length === 0 && (
        <p className="muted" style={{ fontSize: '0.74rem', margin: '6px 0 0' }}>
          This project has no repositories yet. Add them from the Repositories page first.
        </p>
      )}
      {attached.length > 0 && (
        <p className="muted" style={{ fontSize: '0.72rem', margin: '6px 0 0' }}>
          {prep?.state === 'running' && 'Getting the repositories ready…'}
          {prep?.state === 'done' && `Ready: ${(prep.repos ?? []).join(', ') || 'repositories'} under repos/. The workspace is saved after each message and comes back when the session is resumed.`}
          {prep?.state === 'failed' && <span style={{ color: 'var(--danger, #c0392b)' }}>Could not prepare: {prep.message}</span>}
          {!prep && <>The agent gets a copy under <code>repos/&lt;name&gt;/</code> from its next message.</>}
        </p>
      )}
      {error && <div className="error-note" role="alert" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}


/**
 * The MCP integrations this session gets. By default a session gets every integration the project has switched on
 * (Integrations page); "Choose" limits it to the ticked ones, and nothing ticked means no MCP tools at all.
 * The agent picks the change up from its next message.
 */
function IntegrationsSection({ workflow, projectId }) {
  const [items, setItems]   = useState(null);                       // the project's remote MCP integrations
  const [chosen, setChosen] = useState(Array.isArray(workflow?.integration_ids) ? workflow.integration_ids : null);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get(`/api/projects/${projectId}/integrations`)
      .then((d) => { if (!cancelled) setItems((d.integrations ?? []).filter((i) => i.type === 'http')); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  const save = async (ids) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.patch(`/api/projects/${projectId}/workflows/${workflow.id}`, { integrationIds: ids });
      const next = r?.workflow?.integration_ids;
      setChosen(Array.isArray(next) ? next : null);
    } catch (e) {
      setError(e.message || 'Could not update the integrations');
    } finally {
      setBusy(false);
    }
  };

  if (items === null) return null;
  if (items.length === 0) {
    return (
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-3)', marginBottom: 6 }}>
          Integrations
        </div>
        <p className="muted" style={{ fontSize: '0.76rem', margin: 0 }}>
          No MCP servers in this project yet. Add one under Connect › Tools & services.
        </p>
      </div>
    );
  }

  const custom = chosen !== null;
  const defaultCount = items.filter((i) => i.enabled).length;
  const on = (i) => (custom ? chosen.includes(i.id) : i.enabled);

  return (
    <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-3)', marginBottom: 6 }}>
        Integrations
      </div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem', padding: '2px 0' }}>
        <input type="radio" name={`int-mode-${workflow.id}`} checked={!custom} disabled={busy} onChange={() => save(null)} />
        <span>Project default <span className="muted">({defaultCount} on)</span></span>
      </label>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem', padding: '2px 0' }}>
        <input
          type="radio"
          name={`int-mode-${workflow.id}`}
          checked={custom}
          disabled={busy}
          onChange={() => save(items.filter((i) => i.enabled).map((i) => i.id))}
        />
        <span>Choose for this session</span>
      </label>
      <div style={{ marginTop: 4 }}>
        {items.map((i) => (
          <label key={i.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem', padding: '2px 0 2px 18px', opacity: !custom && !i.enabled ? 0.55 : 1 }}>
            <input
              type="checkbox"
              checked={on(i)}
              disabled={busy || !custom}
              onChange={(e) => save(e.target.checked ? [...chosen, i.id] : chosen.filter((x) => x !== i.id))}
            />
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{i.name}</span>
            <span className="muted" style={{ fontSize: '0.7rem' }}>
              {!i.enabled && !custom ? 'off' : i.lastTest && !i.lastTest.ok ? 'needs attention' : i.allowWrites ? 'writes' : 'read-only'}
            </span>
          </label>
        ))}
      </div>
      <p className="muted" style={{ fontSize: '0.72rem', margin: '6px 0 0' }}>
        The agent gets these tools from its next message.
      </p>
      {error && <div className="error-note" role="alert" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}

function ContextPanel({ workflowId }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(`/api/workflows/${workflowId}/context`);
      setItems(data.context ?? data.items ?? []);
    } catch (e) {
      if (e.status === 404) {
        setItems([]); // endpoint may not be present in all deployments
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <div className="spinner" style={{ margin: '0 auto' }} aria-label="Loading context…" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="error-note" style={{ margin: 8 }} role="alert">
        {error}
        <button type="button" className="btn btn-sm btn-ghost" onClick={load} style={{ marginLeft: 6 }}>
          Retry
        </button>
      </div>
    );
  }
  if (!items || items.length === 0) {
    return (
      <div className="ws-placeholder" style={{ padding: '24px 12px', textAlign: 'center' }}>
        <Icon name="knowledge" size={28} />
        <p style={{ fontSize: '0.84rem', marginTop: 6 }}>No context items</p>
        <p style={{ fontSize: '0.75rem', opacity: 0.65 }}>
          Attach documents, files or notes to give the agents context
        </p>
      </div>
    );
  }

  return (
    <ul
      aria-label="Context items"
      style={{ margin: 0, padding: 0, listStyle: 'none', overflow: 'auto', flex: 1 }}
    >
      {items.map((c) => (
        <li
          key={c.id}
          style={{
            padding: '6px 10px',
            borderBottom: '1px solid var(--line)',
            fontSize: '0.78rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="file" size={13} />
            <strong style={{ wordBreak: 'break-word', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.title ?? c.ref ?? c.kind}
            </strong>
          </div>
          {c.body ? (
            <p
              style={{
                margin: '2px 0 0 18px',
                fontSize: '0.74rem',
                color: 'var(--ink-3)',
                wordBreak: 'break-word',
              }}
            >
              {String(c.body).slice(0, 150)}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ── Settings tab ──────────────────────────────────────────────────────────────

function SettingsPanel({ workflow, projectId }) {
  const wid = workflow?.id;

  const [goal, setGoal]         = useState(workflow?.goal ?? '');
  const [trustTools, setTrust]  = useState(workflow?.trust_tools ?? false);
  const [maxIter, setMaxIter]   = useState(workflow?.max_iterations ?? 10);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState(null);
  const [saved, setSaved]       = useState(false);

  // Reset fields when the workflow changes
  useEffect(() => {
    setGoal(workflow?.goal ?? '');
    setTrust(workflow?.trust_tools ?? false);
    setMaxIter(workflow?.max_iterations ?? 10);
    setSaved(false);
    setError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow?.id, workflow?.updated_at]);

  const save = async (e) => {
    e.preventDefault();
    if (!wid) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch(`/api/projects/${projectId}/workflows/${wid}`, {
        goal,
        trustTools,
        maxIterations: Number(maxIter),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message ?? 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  if (!workflow) return null;

  return (
    <form
      onSubmit={save}
      noValidate
      style={{
        padding: '10px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'auto',
        flex: 1,
      }}
    >
      <div>
        <label
          htmlFor="sess-goal"
          style={{ fontSize: '0.78rem', color: 'var(--ink-2)', display: 'block', marginBottom: 4 }}
        >
          Goal
        </label>
        <textarea
          id="sess-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
          style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontSize: '0.82rem' }}
          className="input"
          aria-describedby="sess-goal-hint"
        />
        <span id="sess-goal-hint" style={{ fontSize: '0.73rem', color: 'var(--ink-3)' }}>
          Agents re-read this before every iteration.
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          id="sess-trust"
          checked={trustTools}
          onChange={(e) => setTrust(e.target.checked)}
        />
        <label htmlFor="sess-trust" style={{ fontSize: '0.82rem' }}>
          Trust tools (auto-approve all tool calls)
        </label>
      </div>

      <div>
        <label
          htmlFor="sess-maxiter"
          style={{ fontSize: '0.78rem', color: 'var(--ink-2)', display: 'block', marginBottom: 4 }}
        >
          Max iterations
        </label>
        <input
          type="number"
          id="sess-maxiter"
          value={maxIter}
          onChange={(e) => setMaxIter(e.target.value)}
          min={1}
          max={100}
          style={{ width: 80, fontSize: '0.82rem' }}
          className="input"
        />
      </div>

      {error && (
        <div className="error-note" style={{ padding: '4px 8px', fontSize: '0.8rem' }} role="alert">
          {error}
        </div>
      )}
      {saved && (
        <div style={{ color: 'var(--ok)', fontSize: '0.8rem' }} role="status">
          ✓ Saved
        </div>
      )}

      <button
        type="submit"
        className="btn btn-sm btn-primary"
        disabled={busy}
        style={{ alignSelf: 'flex-start' }}
      >
        {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : 'Save settings'}
      </button>

      {/* Jira ticket attached to this session */}
      {workflow?.jira_key && (
        <JiraSection workflow={workflow} />
      )}
    </form>
  );
}

/**
 * Collapsible Jira ticket strip shown in the session Settings panel.
 */
function JiraSection({ workflow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="session-jira-strip">
        <Icon name="ticket" size={14} aria-hidden="true" />
        <span className="session-jira-strip-key">{workflow.jira_key}</span>
        {workflow.jira_summary && (
          <span style={{ flex: 1, fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {workflow.jira_summary}
          </span>
        )}
        {workflow.jira_url && (
          <a
            href={workflow.jira_url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-icon"
            aria-label={`Open ${workflow.jira_key} in Jira`}
            title="Open in Jira"
          >
            <Icon name="external" size={13} />
          </a>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Hide' : 'Details'}
        </button>
      </div>
      {expanded && (
        <div
          className="card"
          style={{ padding: 12, maxHeight: 280, overflowY: 'auto', fontSize: '0.83rem' }}
        >
          <TicketPreview
            projectId={workflow.project_id}
            ticketKey={workflow.jira_key}
          />
        </div>
      )}
    </div>
  );
}

// ── Session info panel ────────────────────────────────────────────────────────

const SESSION_TABS = [
  { id: 'activity', label: 'Activity' },
  { id: 'context',  label: 'Context'  },
  { id: 'settings', label: 'Settings' },
];

/**
 * @param {{
 *   workflow:   object | null,
 *   workflowId: string,
 *   projectId:  string,
 * }} props
 */
export function IdeSessionPanel({ workflow, workflowId, projectId }) {
  const [tab, setTab] = useState('activity');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Tab bar */}
      <div
        className="ide-session-tabs"
        role="tablist"
        aria-label="Session information"
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--line)',
          flexShrink: 0,
        }}
      >
        {SESSION_TABS.map((t) => (
          <button
            key={t.id}
            id={`sess-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`sess-panel-${t.id}`}
            className={`ide-session-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1,
              padding: '6px 8px',
              border: 'none',
              background: 'transparent',
              fontSize: '0.75rem',
              cursor: 'pointer',
              color: tab === t.id ? 'var(--accent)' : 'var(--ink-3)',
              borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              fontWeight: tab === t.id ? 650 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Panels */}
      <div
        id="sess-panel-activity"
        role="tabpanel"
        aria-labelledby="sess-tab-activity"
        hidden={tab !== 'activity'}
        style={{ flex: 1, overflow: 'hidden', display: tab === 'activity' ? 'flex' : 'none', flexDirection: 'column' }}
      >
        {tab === 'activity' && (
          <ActivityPanel workflowId={workflowId} projectId={projectId} />
        )}
      </div>
      <div
        id="sess-panel-context"
        role="tabpanel"
        aria-labelledby="sess-tab-context"
        hidden={tab !== 'context'}
        style={{ flex: 1, overflow: 'hidden', display: tab === 'context' ? 'flex' : 'none', flexDirection: 'column' }}
      >
        {tab === 'context' && (
          <>
            <RepositoriesSection workflow={workflow} projectId={projectId} />
            <IntegrationsSection workflow={workflow} projectId={projectId} />
            <ContextPanel workflowId={workflowId} />
          </>
        )}
      </div>
      <div
        id="sess-panel-settings"
        role="tabpanel"
        aria-labelledby="sess-tab-settings"
        hidden={tab !== 'settings'}
        style={{ flex: 1, overflow: 'hidden', display: tab === 'settings' ? 'flex' : 'none', flexDirection: 'column' }}
      >
        {tab === 'settings' && (
          <SettingsPanel workflow={workflow} projectId={projectId} />
        )}
      </div>
    </div>
  );
}
