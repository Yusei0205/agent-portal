import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { href } from '../lib/router.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { PageHeader, SectionHead } from '../components/PageHeader.jsx';

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

function GmailRow() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(() => {
    const h = window.location.hash;
    if (!h.includes('?')) return null;
    const q = new URLSearchParams(h.slice(h.indexOf('?') + 1));
    return q.get('gmail') ? { ok: q.get('gmail') === 'connected', text: q.get('msg') || '' } : null;
  });
  const load = useCallback(() => {
    api.get('/api/gmail/status').then(setSt).catch(() => setSt({ available: false }));
  }, []);
  useEffect(() => {
    load();
    if (msg && window.location.hash.includes('?')) history.replaceState(null, '', window.location.hash.split('?')[0]);
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const setSend = async (allowSend) => {
    setBusy(true);
    try { await api.put('/api/gmail/settings', { allowSend }); load(); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true);
    try { await api.delete('/api/gmail/connection'); setMsg({ ok: true, text: 'Gmail disconnected.' }); load(); } finally { setBusy(false); }
  };

  const status = st === null ? 'Checking…' : !st.available ? 'Not set up' : st.connected ? 'Connected' : 'Not connected';
  const tone = st?.connected ? 'badge-ok' : st && !st.available ? 'badge-neutral' : 'badge-warn';
  const detail = st?.connected
    ? `Search and read mail${st.email ? ` · ${st.email}` : ''}`
    : st && !st.available
      ? 'Ask an admin to set up the Google client first (docs/deployment/google-sign-in.md).'
      : 'Let agents search and read your Gmail, and draft replies.';

  return (
    <>
      <div className="integration-service">
        <span className="integration-service-icon" aria-hidden="true"><Icon name="inbox" size={16} /></span>
        <div className="integration-service-body">
          <strong>Gmail</strong>
          <span className="muted small">{detail}</span>
        </div>
        <span className={`badge ${tone}`}>{status}</span>
        {st?.connected ? (
          <button type="button" className="btn btn-sm" onClick={disconnect} disabled={busy}>Disconnect</button>
        ) : (
          <a className={`btn btn-sm${st?.available ? ' btn-primary' : ''}`} href={st?.available ? '/api/gmail/connect' : undefined} aria-disabled={!st?.available}>
            Connect Gmail
          </a>
        )}
      </div>
      {st?.connected && (
        <label className="integration-service-sub">
          <input type="checkbox" checked={st.allowSend} disabled={busy} onChange={(e) => setSend(e.target.checked)} />
          <span>
            Let agents draft and send email as me
            <span className="muted small"> — save drafts and send messages. Off by default; agents can always read.</span>
          </span>
        </label>
      )}
      {msg && <p className={msg.ok ? 'success-note' : 'error-note'} role="status">{msg.text}</p>}
    </>
  );
}

function GoogleWorkspaceRow() {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(() => {
    const h = window.location.hash;
    if (!h.includes('?')) return null;
    const q = new URLSearchParams(h.slice(h.indexOf('?') + 1));
    return q.get('google') ? { ok: q.get('google') === 'connected', text: q.get('msg') || '' } : null;
  });
  const load = useCallback(() => {
    api.get('/api/google/status').then(setSt).catch(() => setSt({ available: false }));
  }, []);
  useEffect(() => {
    load();
    // Drop the result from the address once it has been shown, so a refresh does not repeat it.
    if (msg && window.location.hash.includes('?')) history.replaceState(null, '', window.location.hash.split('?')[0]);
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const setWrites = async (allowWrites) => {
    setBusy(true);
    try { await api.put('/api/google/settings', { allowWrites }); load(); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true);
    try { await api.delete('/api/google/connection'); setMsg({ ok: true, text: 'Google disconnected.' }); load(); } finally { setBusy(false); }
  };

  const status = st === null ? 'Checking…' : !st.available ? 'Not set up' : st.connected ? 'Connected' : 'Not connected';
  const tone = st?.connected ? 'badge-ok' : st && !st.available ? 'badge-neutral' : 'badge-warn';
  const detail = st?.connected
    ? `Drive, Docs, Sheets and Slides${st.email ? ` · ${st.email}` : ''}`
    : st && !st.available
      ? 'Ask an admin to set up the Google client first (docs/deployment/google-sign-in.md).'
      : 'Let agents search Drive and read Docs, Sheets and Slides as you.';

  return (
    <>
      <div className="integration-service">
        <span className="integration-service-icon" aria-hidden="true"><Icon name="knowledge" size={16} /></span>
        <div className="integration-service-body">
          <strong>Google Workspace</strong>
          <span className="muted small">{detail}</span>
        </div>
        <span className={`badge ${tone}`}>{status}</span>
        {st?.connected ? (
          <button type="button" className="btn btn-sm" onClick={disconnect} disabled={busy}>Disconnect</button>
        ) : (
          <a className={`btn btn-sm${st?.available ? ' btn-primary' : ''}`} href={st?.available ? '/api/google/connect' : undefined} aria-disabled={!st?.available}>
            Connect Google
          </a>
        )}
      </div>
      {st?.connected && (
        <label className="integration-service-sub">
          <input type="checkbox" checked={st.allowWrites} disabled={busy} onChange={(e) => setWrites(e.target.checked)} />
          <span>
            Let agents edit my files
            <span className="muted small"> — create Docs, add text, and change Sheet cells. Off by default; agents can always read.</span>
          </span>
        </label>
      )}
      {msg && <p className={msg.ok ? 'success-note' : 'error-note'} role="status">{msg.text}</p>}
    </>
  );
}

function ConnectedServices({ projectId }) {
  const { jira } = useServiceStatus(projectId);

  const jiraRow = !projectId
    ? { status: 'Open a project', tone: 'badge-neutral', detail: 'Jira is connected per project, under Tickets.' }
    : jira === null
      ? { status: 'Checking…', tone: 'badge-neutral', detail: 'Search and read Jira issues and Confluence pages.' }
      : jira.connected
        ? { status: 'Connected', tone: 'badge-ok', detail: `${jira.site?.name || jira.site?.url || 'Jira'}${jira.account?.email ? ` · ${jira.account.email}` : ''}` }
        : { status: 'Not connected', tone: 'badge-warn', detail: 'Sign in with Atlassian or add an API token.' };

  return (
    <section className="integration-group" aria-labelledby="int-services">
      <h2 id="int-services">Connected services</h2>
      <p className="muted small">Services agents can use. Git connections are in the other tab of Connect; agent sign-ins are under Agent setup.</p>
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
        <GoogleWorkspaceRow />
        <GmailRow />
      </div>
    </section>
  );
}

// ── Add / edit form ───────────────────────────────────────────────────────────

/** Well-known remote MCP servers: picking one fills in the address and the header; the person adds only the token. */
export const MCP_PRESETS = [
  {
    id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', header: 'Authorization',
    hint: 'Value: "Bearer " followed by a GitHub personal access token. Use a fine-grained token with only the repositories and permissions you need. For read-only tools use https://api.githubcopilot.com/mcp/readonly.',
  },
  {
    id: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', header: 'Authorization',
    hint: 'Current documentation for libraries. A key is optional but raises the rate limit: value "Bearer " followed by a key from context7.com/dashboard. You can remove the header row to use it without a key.',
  },
  {
    id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth',
    hint: 'Linear issues, projects and cycles. No token needed: you sign in with Linear when a session starts, from a card in the session. Leave "Allow writes" off for read-only search and reads.',
  },
  {
    id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', header: 'Authorization',
    hint: 'Value: "Sentry-Bearer " followed by a Sentry User Auth Token (read scopes: org:read, project:read, event:read). Plain "Bearer" does not work on this server. Add /your-org to the URL to limit it to one organisation.',
  },
  {
    id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v2/mcp', auth: 'oauth',
    hint: 'Jira and Confluence (Atlassian Rovo MCP v2). No token needed: you sign in with Atlassian when a session starts, from a card in the session. Leave "Allow writes" off for read-only search and reads.',
  },
  {
    id: 'atlassian-v1', name: 'Atlassian v1', url: 'https://mcp.atlassian.com/v1/mcp', header: 'Authorization',
    hint: 'Deprecated: Atlassian moves v1 to v2 on 1 March 2027. Value: "Basic " followed by base64 of "your-email:API-token". An Atlassian org admin must allow API-token authentication.',
  },
];

function IntegrationModal({ projectId, integration, onClose, onSave }) {
  const editing = Boolean(integration);
  const [presetHint, setPresetHint]   = useState('');
  const [name, setName]               = useState(integration?.name ?? '');
  const [url, setUrl]                 = useState(integration?.url ?? '');
  const [headers, setHeaders]         = useState(
    integration?.headerNames?.length
      ? integration.headerNames.map((n) => ({ name: n, value: '', stored: true }))
      : [{ name: 'Authorization', value: '', stored: false }],
  );
  const [auth, setAuth]                 = useState(integration?.auth ?? 'headers');
  const [personal, setPersonal]       = useState(integration?.personal ?? false);
  const [allowWrites, setAllowWrites] = useState(integration?.allowWrites ?? false);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState(null);

  const usePreset = (p) => {
    setName(p.name);
    setUrl(p.url);
    setAuth(p.auth === 'oauth' ? 'oauth' : 'headers');
    setHeaders([{ name: p.header || 'Authorization', value: '', stored: false }]);
    setPresetHint(p.hint);
  };

  const setHeader = (i, patch) => setHeaders((hs) => hs.map((h, j) => (j === i ? { ...h, ...patch } : h)));

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!/^https:\/\//i.test(url.trim())) { setError('Server URL must start with https://'); return; }
    const cfg = {
      url: url.trim(),
      auth,
      headers: auth === 'oauth' ? [] : headers.filter((h) => h.name.trim() && (h.stored || h.value)).map((h) => ({ name: h.name.trim(), value: h.value })),
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

            {!editing && (
              <div className="field">
                <span className="field-label">Start from</span>
                <div className="row wrap" style={{ gap: 6 }}>
                  {MCP_PRESETS.map((p) => (
                    <button key={p.id} type="button" className="btn btn-sm" onClick={() => usePreset(p)}>{p.name}</button>
                  ))}
                </div>
                {presetHint && <p className="field-hint" role="status">{presetHint}</p>}
              </div>
            )}

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

            {auth === 'oauth' && (
              <p className="field-hint" role="status">
                No secret needed. You sign in when a session starts: a card in the session walks you through it.
              </p>
            )}

            {auth !== 'oauth' && (
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
            )}

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
      <PageHeader
        title="Integrations"
        description="Services the agent can use in a session: Jira and Confluence, your Git hosts, model sign-ins, and any MCP server. Secrets are write-only and are only handed to a session when it starts."
      >
        {projectId && (
          <button type="button" className="btn btn-primary" onClick={() => setModal('new')}>
            <Icon name="plus" size={14} /> New MCP server
          </button>
        )}
      </PageHeader>

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
