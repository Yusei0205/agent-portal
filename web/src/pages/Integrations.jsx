import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { href } from '../lib/router.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';

/**
 * Integrations — everything an agent can use in a session, in one place.
 *
 *  - "Connected services" lists the sign-ins the portal already has (Jira, Git hosts, model sign-ins) with their
 *    status and a link to where each is managed, so nothing needs to be entered twice.
 *  - "MCP servers" are the remote servers added here. Every enabled one is given to the sessions of the project; its
 *    secret headers never come back to the browser and tools that change things stay hidden unless writes are allowed.
 */

// ── Connected services ────────────────────────────────────────────────────────

function useServiceStatus(projectId) {
  const [jira, setJira] = useState(null);
  const [git, setGit] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (projectId) {
      api.get(`/api/projects/${projectId}/jira`).then((r) => { if (!cancelled) setJira(r); }).catch(() => { if (!cancelled) setJira({ error: true }); });
    }
    api.get('/api/git-connections').then((r) => { if (!cancelled) setGit(r.connections || []); }).catch(() => { if (!cancelled) setGit([]); });
    return () => { cancelled = true; };
  }, [projectId]);

  return { jira, git };
}

function ServiceRow({ icon, title, detail, status, tone, to, action }) {
  return (
    <div className="integration-service">
      <span className="integration-service-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>
      <div className="integration-service-body">
        <strong>{title}</strong>
        <span className="muted small">{detail}</span>
      </div>
      <span className={`badge ${tone}`}>{status}</span>
      <a className="btn btn-sm" href={to}>{action}</a>
    </div>
  );
}

function ConnectedServices({ projectId }) {
  const { jira, git } = useServiceStatus(projectId);

  const jiraRow = !projectId
    ? { status: 'Open a project', tone: 'badge-neutral', detail: 'Jira is connected per project, under Tickets.' }
    : jira === null
      ? { status: 'Checking…', tone: 'badge-neutral', detail: 'Search and read Jira issues and Confluence pages.' }
      : jira.connected
        ? { status: 'Connected', tone: 'badge-ok', detail: `${jira.site?.name || jira.site?.url || 'Jira'}${jira.account?.email ? ` · ${jira.account.email}` : ''}` }
        : { status: 'Not connected', tone: 'badge-warn', detail: 'Sign in with Atlassian or add an API token.' };

  const gitCount = git ? git.length : null;

  return (
    <section className="integration-group" aria-labelledby="int-services">
      <h2 id="int-services">Connected services</h2>
      <p className="muted small">Sign-ins the portal already holds. They are managed on their own pages; this is the overview.</p>
      <div className="integration-services">
        <ServiceRow
          icon="ticket"
          title="Jira & Confluence"
          detail={jiraRow.detail}
          status={jiraRow.status}
          tone={jiraRow.tone}
          to={projectId ? href(projectId, 'tickets') : '#/projects'}
          action="Manage"
        />
        <ServiceRow
          icon="branch"
          title="Git hosts"
          detail="GitHub, Bitbucket, CodeCommit and other Git servers; used to clone repositories into sessions."
          status={gitCount === null ? 'Checking…' : gitCount === 0 ? 'None added' : `${gitCount} connected`}
          tone={gitCount ? 'badge-ok' : 'badge-neutral'}
          to="#/connections/git"
          action="Manage"
        />
        <ServiceRow
          icon="key"
          title="AWS & model sign-ins"
          detail="Claude, Kiro and Amazon Bedrock sign-ins that run the agents."
          status="Credentials"
          tone="badge-neutral"
          to="#/credentials"
          action="Manage"
        />
      </div>
    </section>
  );
}

// ── Add / edit form ───────────────────────────────────────────────────────────

function IntegrationModal({ projectId, integration, onClose, onSave }) {
  const editing = Boolean(integration);
  const [name, setName]               = useState(integration?.name ?? '');
  const [url, setUrl]                 = useState(integration?.url ?? '');
  const [headers, setHeaders]         = useState(
    integration?.headerNames?.length
      ? integration.headerNames.map((n) => ({ name: n, value: '', stored: true }))
      : [{ name: 'Authorization', value: '', stored: false }],
  );
  const [personal, setPersonal]       = useState(integration?.personal ?? false);
  const [allowWrites, setAllowWrites] = useState(integration?.allowWrites ?? false);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState(null);

  const setHeader = (i, patch) => setHeaders((hs) => hs.map((h, j) => (j === i ? { ...h, ...patch } : h)));

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!/^https:\/\//i.test(url.trim())) { setError('Server URL must start with https://'); return; }
    const cfg = {
      url: url.trim(),
      headers: headers.filter((h) => h.name.trim() && (h.stored || h.value)).map((h) => ({ name: h.name.trim(), value: h.value })),
      personal,
      allowWrites,
    };
    setSaving(true);
    setError(null);
    try {
      const r = editing
        ? await api.put(`/api/projects/${projectId}/integrations/${integration.id}`, { name: name.trim(), config: cfg })
        : await api.post(`/api/projects/${projectId}/integrations`, { name: name.trim(), type: 'http', config: cfg });
      onSave(r.integration);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={editing ? 'Edit MCP server' : 'Add MCP server'}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <h2>{editing ? 'Edit MCP server' : 'Add an MCP server'}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="stack integration-form">
            <p className="muted small">A remote MCP server (streamable HTTP). The agent gets its tools in every session of this project.</p>

            <div className="field">
              <label htmlFor="int-name">Name</label>
              <input id="int-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sentry" autoFocus />
              <p className="field-hint">Shown here and used as the tool prefix the agent sees.</p>
            </div>

            <div className="field">
              <label htmlFor="int-url">Server URL</label>
              <input id="int-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
              <p className="field-hint">https:// only.</p>
            </div>

            <fieldset className="field">
              <legend>Secret headers</legend>
              <p className="field-hint">
                Sent with every request, for example <code>Authorization: Bearer …</code>. Values are stored encrypted and are never shown again.
              </p>
              {headers.map((h, i) => (
                <div className="row" key={i} style={{ marginBottom: 6 }}>
                  <input
                    type="text"
                    aria-label={`Header ${i + 1} name`}
                    value={h.name}
                    onChange={(e) => setHeader(i, { name: e.target.value })}
                    placeholder="Authorization"
                    disabled={h.stored}
                  />
                  <input
                    type="password"
                    aria-label={`Header ${i + 1} value`}
                    value={h.value}
                    onChange={(e) => setHeader(i, { value: e.target.value })}
                    placeholder={h.stored ? 'Saved — leave blank to keep' : 'Value'}
                    autoComplete="off"
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="btn-icon" aria-label={`Remove header ${i + 1}`} onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
              {headers.length < 10 && (
                <button type="button" className="btn btn-sm" onClick={() => setHeaders((hs) => [...hs, { name: '', value: '', stored: false }])}>
                  <Icon name="plus" size={12} /> Add header
                </button>
              )}
            </fieldset>

            <fieldset className="field">
              <legend>Who can use it</legend>
              <label className="row" style={{ gap: 8 }}>
                <input type="radio" name="int-who" checked={!personal} onChange={() => setPersonal(false)} />
                <span><strong>Project</strong> <span className="muted small">— sessions of everyone in this project get it.</span></span>
              </label>
              <label className="row" style={{ gap: 8 }}>
                <input type="radio" name="int-who" checked={personal} onChange={() => setPersonal(true)} />
                <span><strong>Only me</strong> <span className="muted small">— only your own sessions get it; others cannot see it.</span></span>
              </label>
            </fieldset>

            <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} />
              <span>
                <strong>Allow writes</strong>
                <span className="muted small" style={{ display: 'block' }}>
                  Off: tools that do not say they are read-only (or whose names do not start with get, list, search, read…) are hidden and refused.
                </span>
              </span>
            </label>

            {error && <p className="error-note" role="alert">{error}</p>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving and testing…' : 'Save and test'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function health(intg) {
  if (!intg.enabled) return { label: 'Off', tone: 'badge-neutral' };
  if (!intg.lastTest) return { label: 'Not tested', tone: 'badge-neutral' };
  return intg.lastTest.ok ? { label: 'OK', tone: 'badge-ok' } : { label: 'Needs attention', tone: 'badge-danger' };
}

function McpCard({ intg, testing, onTest, onEdit, onToggle, onDelete }) {
  const h = health(intg);
  const remote = intg.type === 'http';
  return (
    <article className="integration-card" aria-label={intg.name}>
      <header className="integration-card-head">
        <div>
          <h3>{intg.name}</h3>
          <span className="muted small">{remote ? 'Remote MCP server' : `Legacy ${intg.type} entry`}</span>
        </div>
        <span className={`badge ${h.tone}`} role="status">{h.label}</span>
      </header>

      {remote ? (
        <dl className="integration-facts">
          <div><dt>Server</dt><dd>{hostOf(intg.url)}</dd></div>
          <div><dt>Who</dt><dd>{intg.personal ? 'Only me' : 'Project'}</dd></div>
          <div><dt>Access</dt><dd>{intg.allowWrites ? 'Writes allowed' : 'Read-only'}</dd></div>
          <div><dt>Headers</dt><dd>{intg.headerNames.length ? intg.headerNames.join(', ') : 'none'}</dd></div>
        </dl>
      ) : (
        <p className="muted small">This older entry type is not given to sessions. Remove it and add the server as an MCP server above.</p>
      )}

      {remote && intg.lastTest && (
        <p className={`small ${intg.lastTest.ok ? 'muted' : 'danger'}`}>
          {intg.lastTest.message} <span className="muted">· tested {formatRelative(intg.lastTest.at)}</span>
        </p>
      )}

      <footer className="integration-card-actions">
        {remote && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => onTest(intg)} disabled={testing} aria-label={`Test ${intg.name}`}>
              {testing ? 'Testing…' : 'Test'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onEdit(intg)} aria-label={`Edit ${intg.name}`}>Edit</button>
            <button
              type="button"
              className={`btn btn-sm ${intg.enabled ? '' : 'btn-ghost'}`}
              onClick={() => onToggle(intg)}
              aria-pressed={intg.enabled}
              aria-label={intg.enabled ? `Turn off ${intg.name}` : `Turn on ${intg.name}`}
            >
              {intg.enabled ? 'On' : 'Off'}
            </button>
          </>
        )}
        <button type="button" className="btn-icon" title="Delete" aria-label={`Delete ${intg.name}`} onClick={() => onDelete(intg)}>
          <Icon name="trash" size={14} />
        </button>
      </footer>
    </article>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function Integrations({ projectId }) {
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [modal, setModal]     = useState(null); // null | 'new' | { integration }
  const [testing, setTesting] = useState({});
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    if (!projectId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/integrations`);
      setIntegrations(r.integrations || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const replace = (saved) => setIntegrations((prev) => (prev.some((i) => i.id === saved.id) ? prev.map((i) => (i.id === saved.id ? saved : i)) : [...prev, saved]));

  const toggle = async (intg) => {
    try {
      const r = await api.put(`/api/projects/${projectId}/integrations/${intg.id}`, { enabled: !intg.enabled });
      replace(r.integration);
    } catch (e) { toast(e.message, 'error'); }
  };

  const test = async (intg) => {
    setTesting((t) => ({ ...t, [intg.id]: true }));
    try {
      await api.post(`/api/projects/${projectId}/integrations/${intg.id}/test`);
      await load();
    } catch (e) { toast(e.message, 'error'); } finally {
      setTesting((t) => ({ ...t, [intg.id]: false }));
    }
  };

  const remove = async (intg) => {
    if (!await requestConfirm(`Remove "${intg.name}"? Sessions will no longer get its tools.`, 'Remove', 'danger')) return;
    try {
      await api.delete(`/api/projects/${projectId}/integrations/${intg.id}`);
      setIntegrations((prev) => prev.filter((i) => i.id !== intg.id));
    } catch (e) { toast(e.message, 'error'); }
  };

  const remote = integrations.filter((i) => i.type === 'http');
  const stats = {
    project: remote.filter((i) => !i.personal).length,
    mine: remote.filter((i) => i.personal).length,
    healthy: remote.filter((i) => i.enabled && i.lastTest?.ok).length,
    attention: remote.filter((i) => i.enabled && i.lastTest && !i.lastTest.ok).length,
  };

  return (
    <div className="page">
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div className="page-head">
        <h1>Integrations</h1>
        <div className="page-actions">
          {projectId && (
            <button type="button" className="btn btn-primary" onClick={() => setModal('new')}>
              <Icon name="plus" size={14} /> New MCP server
            </button>
          )}
        </div>
      </div>
      <p className="muted">
        Services the agent can use in a session: Jira and Confluence, your Git hosts, model sign-ins, and any MCP server.
        Secrets are write-only and are only handed to a session when it starts.
      </p>

      <ConnectedServices projectId={projectId} />

      <section className="integration-group" aria-labelledby="int-mcp">
        <h2 id="int-mcp">MCP servers</h2>
        {!projectId && <div className="card"><p className="muted">Open a project to add MCP servers to it.</p></div>}
        {projectId && loading && <p className="muted">Loading…</p>}
        {projectId && error && <p className="error-note" role="alert">{error}</p>}

        {projectId && !loading && !error && (
          <>
            <div className="integration-stats" aria-label="Summary">
              <div className="stat-tile"><span className="muted small">Project</span><strong>{stats.project}</strong></div>
              <div className="stat-tile"><span className="muted small">Only me</span><strong>{stats.mine}</strong></div>
              <div className="stat-tile"><span className="muted small">Healthy</span><strong>{stats.healthy}</strong></div>
              <div className="stat-tile"><span className="muted small">Need attention</span><strong>{stats.attention}</strong></div>
            </div>

            {integrations.length === 0 ? (
              <div className="card">
                <p className="muted">No MCP servers yet. Add one with “New MCP server”: a URL and, if it needs one, a secret header such as Authorization.</p>
              </div>
            ) : (
              <div className="integration-cards">
                {integrations.map((intg) => (
                  <McpCard
                    key={intg.id}
                    intg={intg}
                    testing={Boolean(testing[intg.id])}
                    onTest={test}
                    onEdit={(i) => setModal({ integration: i })}
                    onToggle={toggle}
                    onDelete={remove}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {modal && (
        <IntegrationModal
          projectId={projectId}
          integration={modal === 'new' ? null : modal.integration}
          onClose={() => setModal(null)}
          onSave={(saved) => { replace(saved); setModal(null); }}
        />
      )}
    </div>
  );
}

export default Integrations;
