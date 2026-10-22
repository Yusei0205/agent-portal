/**
 * Stage 4 — Project Setup Hub
 *
 * Single hub page that replaces the scattered 'Project setup' rail entries.
 * Each readiness item opens an inline side sheet — no page navigation needed.
 *
 * Sections:
 *   readiness  – GET /api/projects/:pid/readiness  (live via SSE)
 *   sub-tabs   – Connection & provider | Repositories | Agents & skills | Team & members | Jira | Configuration | Budget
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { useLoad, useAction } from '../lib/useAsync.js';
import { href, go } from '../lib/router.js';
import { cx } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Badge, Button, ErrorNote, Field, Modal, Note, PageHeader, Spinner, useUi } from '../components/ui.jsx';

// ─── Readiness panel ────────────────────────────────────────────────────────

const STATUS_ICON = { ok: '✅', warn: '⚠️', missing: '❌' };
const STATUS_TONE = { ok: 'ok', warn: 'warn', missing: 'danger' };

function ReadinessPanel({ projectId, onFix }) {
  const r = useLoad(() => api.get(`/api/projects/${projectId}/readiness`), [projectId]);
  // Refresh when SSE signals a project change
  useProjectEvents(['repo.updated', 'project.updated', 'workflow.updated'], () => r.reload(true));

  if (r.loading && !r.data) return <div className="panel"><Spinner /></div>;
  if (r.error) return <div className="panel"><ErrorNote error={r.error} /></div>;
  const { items = [], ready } = r.data || {};

  return (
    <section className="panel readiness-panel" aria-label="Project readiness">
      <div className="row between">
        <h2>Ready to run? {ready ? <Badge tone="ok">Yes</Badge> : <Badge tone="warn">Not yet</Badge>}</h2>
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => r.reload(true)} aria-label="Refresh readiness" />
      </div>
      <table className="table readiness-table" aria-label="Readiness checklist">
        <tbody>
          {items.map((item) => (
            <tr key={item.key} className={cx('readiness-row', `readiness-${item.status}`)}>
              <td className="readiness-icon" aria-label={item.status}>{STATUS_ICON[item.status]}</td>
              <td className="readiness-label">{item.label}</td>
              <td className="readiness-msg muted small">{item.message}</td>
              <td className="readiness-action">
                {item.status !== 'ok' && onFix ? (
                  <Button size="sm" variant="ghost" onClick={() => onFix(item)}>
                    {item.status === 'missing' ? 'Add' : 'Fix'}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ready ? (
        <p className="muted small">All required items are set up. You can start a session.</p>
      ) : (
        <p className="muted small">Fix the items above to start a real session. Demo mode works with anything.</p>
      )}
    </section>
  );
}

// ─── Settings precedence helper ─────────────────────────────────────────────

/**
 * Shows the three-level precedence for a multi-level setting.
 * portalValue  – what Settings has
 * projectValue – what this project has (or null = inherit)
 * sessionHint  – label for the session-override column (or null)
 */
export function PrecedenceTable({ setting, portalValue, projectValue, sessionHint, portalHref, projectHref }) {
  const effective = projectValue ?? portalValue;
  return (
    <div className="precedence-wrap" role="region" aria-label={`${setting} precedence`}>
      <p className="field-hint precedence-hint">
        Effective value: <strong>{effective || '—'}</strong>
        {projectValue && projectValue !== portalValue ? ' (project override)' : portalValue ? ' (portal default)' : ''}
      </p>
      <table className="table precedence-table compact">
        <thead>
          <tr>
            <th>Portal default</th>
            <th>Project override</th>
            {sessionHint ? <th>Session override</th> : null}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              {portalHref ? <a href={portalHref}>{portalValue || <span className="muted">Not set</span>}</a> : (portalValue || <span className="muted">Not set</span>)}
            </td>
            <td>
              {projectHref ? (
                <a href={projectHref}>{projectValue || <span className="muted">Inherits portal</span>}</a>
              ) : (
                projectValue || <span className="muted">Inherits portal</span>
              )}
            </td>
            {sessionHint ? <td><span className="muted">{sessionHint}</span></td> : null}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Fix sheet ───────────────────────────────────────────────────────────────

/**
 * Thin wrapper that renders a sheet for a given readiness fix key.
 * The actual form is rendered via a lookup table — this lets each section
 * live independently without this file importing every sub-page.
 */
function FixSheet({ item, onClose, projectId, onSaved }) {
  const sheetRef = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    sheetRef.current?.querySelector('input, textarea, select, button')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);

  const title = FIX_TITLES[item?.key] ?? item?.label ?? 'Fix';
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet" ref={sheetRef}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={17} />
          </button>
        </header>
        <div className="sheet-body">
          <FixContent fixKey={item?.key} projectId={projectId} onSaved={onSaved} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}

const FIX_TITLES = {
  provider: 'Model provider & Kiro',
  aws: 'AWS account',
  git_connection: 'Git connections',
  repository: 'Add repository',
  lead_agent: 'Lead agent & defaults',
  budget: 'Budget',
  jira: 'Jira',
};

function FixContent({ fixKey, projectId, onSaved, onClose }) {
  switch (fixKey) {
    case 'provider':
      return <ProviderFix projectId={projectId} onSaved={onSaved} onClose={onClose} />;
    case 'aws':
      return <AwsFix projectId={projectId} onSaved={onSaved} onClose={onClose} />;
    case 'git_connection':
      return <GitConnectionFix projectId={projectId} onSaved={onSaved} onClose={onClose} />;
    case 'repository':
      return <RepositoryFix projectId={projectId} onSaved={onSaved} onClose={onClose} />;
    case 'lead_agent':
      return <LeadAgentFix projectId={projectId} onSaved={onSaved} onClose={onClose} />;
    case 'budget':
      return <BudgetFix projectId={projectId} onSaved={onSaved} onClose={onClose} />;
    case 'jira':
      return <JiraFix projectId={projectId} onSaved={onSaved} onClose={onClose} />;
    default:
      return <p className="muted">Navigate to the correct settings section.</p>;
  }
}

// ─── Fix: Provider ───────────────────────────────────────────────────────────
function ProviderFix({ projectId, onSaved, onClose }) {
  return (
    <div className="stack">
      <Note tone="info">
        The model provider is set in{' '}
        <a href="#/settings" onClick={onClose}>
          Settings › Model provider
        </a>
        . Each project can also override the provider under <em>Connection &amp; provider</em> below.
      </Note>
      <p className="muted small">
        After switching the provider in Settings, come back here and the readiness panel will update automatically.
      </p>
      <div className="row">
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
        <a className="btn btn-default" href="#/settings" onClick={onClose}>
          Go to Settings
        </a>
      </div>
    </div>
  );
}

// ─── Fix: AWS ─────────────────────────────────────────────────────────────────
function AwsFix({ projectId, onSaved, onClose }) {
  const cfg = useLoad(() => api.get(`/api/projects/${projectId}/aws`), [projectId]);
  const conns = useLoad(() => api.get('/api/aws/connections'), []);
  const [connectionId, setConnectionId] = useState('');
  const act = useAction();
  const { toast } = useUi();
  useEffect(() => {
    if (cfg.data) setConnectionId(cfg.data.connectionId || '');
  }, [cfg.data]);
  const connections = conns.data?.connections || [];
  const save = () => act.run(async () => {
    await api.put(`/api/projects/${projectId}/aws`, {
      auth: connectionId ? 'connection' : 'inherit',
      connectionId: connectionId || undefined,
    });
    toast('AWS account saved');
    onSaved();
    onClose();
  });
  if (cfg.loading && !cfg.data) return <Spinner />;
  return (
    <div className="stack">
      <p className="muted small">Pick an AWS account for this project's CodeCommit and Bedrock use. AWS accounts are managed on the <a href="#/aws" onClick={onClose}>AWS accounts</a> page.</p>
      <Field label="AWS account">
        {(id) => (
          <select id={id} className="input" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">Use portal default from Settings</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.account ? ` · ${c.account}` : ''}</option>
            ))}
          </select>
        )}
      </Field>
      {!connections.length ? (
        <Note tone="info">No AWS accounts yet. <a href="#/aws" onClick={onClose}>Add one</a> first.</Note>
      ) : null}
      <ErrorNote error={act.error} />
      <div className="row">
        <Button variant="primary" busy={act.busy} onClick={save}>Save</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

// ─── Fix: Git connection ─────────────────────────────────────────────────────
function GitConnectionFix({ projectId, onSaved, onClose }) {
  return (
    <div className="stack">
      <Note tone="info">
        Git connections (shared sign-ins for GitHub, Bitbucket, CodeCommit, and other Git servers) are managed on the{' '}
        <a href="#/connections" onClick={onClose}>
          Git connections
        </a>{' '}
        page. After adding one, come back here and add a repository using that connection.
      </Note>
      <div className="row">
        <a className="btn btn-primary" href="#/connections" onClick={onClose}>
          Go to Git connections
        </a>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

// ─── Fix: Repository ─────────────────────────────────────────────────────────
function RepositoryFix({ projectId, onSaved, onClose }) {
  const { toast } = useUi();
  const conns = useLoad(() => api.get('/api/git-connections'), []);
  const [mode, setMode] = useState('direct'); // 'direct' | 'connection'
  const [form, setForm] = useState({ provider: 'git', url: '', name: '', token: '', username: '', connectionId: '', awsConnectionId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const connections = conns.data?.connections || [];

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'connection'
        ? { connectionId: form.connectionId, name: form.name }
        : { provider: form.provider, url: form.url, name: form.name, token: form.token || undefined, username: form.username || undefined };
      await api.post(`/api/projects/${projectId}/repos`, body);
      toast('Repository connected — cloning…');
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={save} noValidate>
      <div className="row tight" role="group" aria-label="Repository type">
        <button type="button" className={cx('btn btn-sm', mode === 'direct' && 'btn-primary')} onClick={() => setMode('direct')}>Direct URL</button>
        <button type="button" className={cx('btn btn-sm', mode === 'connection' && 'btn-primary')} onClick={() => setMode('connection')}>Via a connection</button>
      </div>
      {mode === 'direct' ? (
        <>
          <Field label="Repository type">
            {(id) => (
              <select id={id} className="input" value={form.provider} onChange={set('provider')}>
                <option value="git">Other Git (HTTPS / SSH)</option>
                <option value="github">GitHub</option>
                <option value="codecommit">AWS CodeCommit</option>
              </select>
            )}
          </Field>
          <Field label="Repository address">
            {(id) => <input id={id} className="input mono" value={form.url} onChange={set('url')} placeholder="https://github.com/owner/repo" required />}
          </Field>
          <Field label="Display name (optional)">
            {(id) => <input id={id} className="input" value={form.name} onChange={set('name')} placeholder="Leave blank to use the repo name" />}
          </Field>
          {(form.provider === 'github' || form.provider === 'git') ? (
            <Field label="Token (optional)" hint="Stored encrypted. Leave blank to use the portal's default GitHub token.">
              {(id) => <input id={id} type="password" className="input mono" value={form.token} onChange={set('token')} autoComplete="off" />}
            </Field>
          ) : null}
        </>
      ) : (
        <>
          {!connections.length ? (
            <Note tone="warn">No git connections yet. <a href="#/connections" onClick={onClose}>Add one</a> first.</Note>
          ) : (
            <Field label="Git connection">
              {(id) => (
                <select id={id} className="input" value={form.connectionId} onChange={set('connectionId')} required>
                  <option value="">Choose a connection…</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} · {c.provider}</option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field label="Repository URL">
            {(id) => <input id={id} className="input mono" value={form.url} onChange={set('url')} placeholder="https://github.com/owner/repo" required />}
          </Field>
          <Field label="Display name (optional)">
            {(id) => <input id={id} className="input" value={form.name} onChange={set('name')} />}
          </Field>
        </>
      )}
      <ErrorNote error={error} />
      <div className="row">
        <Button type="submit" variant="primary" busy={busy}>Connect and clone</Button>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

// ─── Fix: Lead agent ─────────────────────────────────────────────────────────
function LeadAgentFix({ projectId, onSaved, onClose }) {
  const { toast } = useUi();
  const agents = useLoad(() => api.get(`/api/projects/${projectId}/agents`), [projectId]);
  const defaults = useLoad(() => api.get(`/api/projects/${projectId}/defaults`), [projectId]);
  const [leadAgent, setLeadAgent] = useState('');
  const act = useAction();
  useEffect(() => {
    if (defaults.data) setLeadAgent(defaults.data.default_lead_agent || '');
  }, [defaults.data]);
  const agentList = agents.data?.agents || [];
  const save = () => act.run(async () => {
    await api.put(`/api/projects/${projectId}/defaults`, { default_lead_agent: leadAgent || null });
    toast('Lead agent saved');
    onSaved();
    onClose();
  });
  return (
    <div className="stack">
      <p className="muted small">The lead agent coordinates the session. If none is set, agents self-organise.</p>
      {agents.loading ? <Spinner /> : (
        <Field label="Lead agent">
          {(id) => (
            <select id={id} className="input" value={leadAgent} onChange={(e) => setLeadAgent(e.target.value)}>
              <option value="">None — agents self-organise</option>
              {agentList.map((a) => (
                <option key={a.name} value={a.name}>{a.name}</option>
              ))}
            </select>
          )}
        </Field>
      )}
      <ErrorNote error={act.error} />
      <div className="row">
        <Button variant="primary" busy={act.busy} onClick={save}>Save</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

// ─── Fix: Budget ─────────────────────────────────────────────────────────────
function BudgetFix({ projectId, onSaved, onClose }) {
  const { toast } = useUi();
  const proj = useLoad(() => api.get(`/api/projects/${projectId}`), [projectId]);
  const settings = useLoad(() => api.get('/api/settings'), []);
  const [cap, setCap] = useState('');
  const act = useAction();
  useEffect(() => {
    if (proj.data) setCap(proj.data.project?.monthly_budget_usd ?? '');
  }, [proj.data]);
  const portalCap = settings.data?.budget?.monthlyUsd;
  const save = () => act.run(async () => {
    await api.patch(`/api/projects/${projectId}`, { monthly_budget_usd: cap === '' ? null : Number(cap) });
    toast('Budget saved');
    onSaved();
    onClose();
  });
  return (
    <div className="stack">
      {portalCap ? (
        <Note tone="info">Portal monthly cap: ${portalCap}. A project cap applies in addition.</Note>
      ) : (
        <Note tone="warn">No portal cap set. Add one in <a href="#/settings" onClick={onClose}>Settings</a>.</Note>
      )}
      <Field label="Monthly cap for this project (USD)" hint="Empty = inherits portal cap.">
        {(id) => (
          <input id={id} type="number" min={0} step={1} className="input input-num" value={cap} onChange={(e) => setCap(e.target.value)} />
        )}
      </Field>
      <ErrorNote error={act.error} />
      <div className="row">
        <Button variant="primary" busy={act.busy} onClick={save}>Save</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

// ─── Fix: Jira ────────────────────────────────────────────────────────────────
function JiraFix({ projectId, onSaved, onClose }) {
  return (
    <div className="stack">
      <Note tone="info">
        Configure Jira on the <a href={href(projectId, 'tickets')} onClick={onClose}>Tickets</a> page under <em>Jira connection</em>.
      </Note>
      <div className="row">
        <a className="btn btn-primary" href={href(projectId, 'tickets')} onClick={onClose}>Go to Tickets</a>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

// ─── Sub-section tabs ────────────────────────────────────────────────────────

const SETUP_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'connection', label: 'Connection & provider' },
  { value: 'repos', label: 'Repositories' },
  { value: 'agents', label: 'Agents & skills' },
  { value: 'team', label: 'Team & members' },
  { value: 'jira', label: 'Jira' },
  { value: 'config', label: 'Configuration' },
  { value: 'budget', label: 'Budget' },
];

// ─── Main Setup Hub ──────────────────────────────────────────────────────────

export function ProjectSetup({ route }) {
  const { project, isOwner, canEdit } = useProject();
  const [activeSheet, setActiveSheet] = useState(null); // ReadinessItem | null
  const [tab, setTab] = useState(() => route?.query?.get('section') || 'overview');

  const handleFix = (item) => setActiveSheet(item);
  const handleClose = () => setActiveSheet(null);
  const handleSaved = () => {
    setActiveSheet(null);
    // sections reload via SSE
  };

  return (
    <div className="page">
      <PageHeader
        title="Project setup"
        sub="Everything needed to run sessions — all in one place."
      />

      {/* Readiness panel always at the top */}
      <ReadinessPanel projectId={project.id} onFix={isOwner || canEdit ? handleFix : null} />

      {/* Settings precedence reminder */}
      <div className="panel precedence-reminder">
        <h3>Settings precedence</h3>
        <p className="muted small">
          <strong>Portal default</strong> (Settings) →{' '}
          <strong>Project override</strong> (here) →{' '}
          <strong>Session override</strong> (launcher / workspace)
        </p>
        <p className="muted small">
          A setting at a lower level wins over higher levels. To see what applies, check each section below.
        </p>
      </div>

      {/* Sub-navigation tabs */}
      <nav className="tabs" aria-label="Setup sections">
        {SETUP_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            className={cx('tab', tab === t.value && 'is-active')}
            aria-pressed={tab === t.value}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* Tab content */}
      <SetupTabContent tab={tab} projectId={project.id} onFix={handleFix} />

      {/* Fix sheet overlay */}
      {activeSheet ? (
        <FixSheet
          item={activeSheet}
          projectId={project.id}
          onClose={handleClose}
          onSaved={handleSaved}
        />
      ) : null}
    </div>
  );
}

function SetupTabContent({ tab, projectId, onFix }) {
  switch (tab) {
    case 'overview':
      return <SetupOverview projectId={projectId} onFix={onFix} />;
    case 'connection':
      return <SetupConnection projectId={projectId} />;
    case 'repos':
      return <SetupRepos projectId={projectId} onAddRepo={() => onFix({ key: 'repository', label: 'Repository', status: 'missing' })} />;
    case 'agents':
      return <SetupAgents projectId={projectId} />;
    case 'team':
      return <SetupTeam projectId={projectId} />;
    case 'jira':
      return <SetupJira projectId={projectId} />;
    case 'config':
      return <SetupConfig projectId={projectId} />;
    case 'budget':
      return <SetupBudget projectId={projectId} />;
    default:
      return null;
  }
}

// ─── Overview tab ─────────────────────────────────────────────────────────────

function SetupOverview({ projectId, onFix }) {
  return (
    <div className="stack">
      <Note tone="info">
        Use the sections above to configure each aspect of the project.
        The <strong>Readiness panel</strong> at the top always shows what's still needed before you can start a session.
        Click <strong>Add</strong> or <strong>Fix</strong> on any item to configure it right here — no navigating away.
      </Note>
      <div className="setup-quicklinks">
        {SETUP_TABS.filter((t) => t.value !== 'overview').map((t) => (
          <div key={t.value} className="panel setup-quicklink">
            <strong>{t.label}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Connection tab ──────────────────────────────────────────────────────────

function SetupConnection({ projectId }) {
  // Lazy-import the Connection component from ProjectSettings to avoid duplication
  const [Component, setComponent] = useState(null);
  useEffect(() => {
    import('./ProjectSettings.jsx').then((m) => setComponent(() => m.Connection));
  }, []);
  if (!Component) return <Spinner />;
  return <Component />;
}

// ─── Repos tab ────────────────────────────────────────────────────────────────

function SetupRepos({ projectId, onAddRepo }) {
  const [Component, setComponent] = useState(null);
  useEffect(() => {
    import('./Repos.jsx').then((m) => setComponent(() => m.Repos));
  }, []);
  if (!Component) return <Spinner />;
  return (
    <div>
      <div className="row between" style={{ marginBottom: '1rem' }}>
        <Button variant="primary" icon="plus" onClick={onAddRepo}>Connect a repository</Button>
      </div>
      <Component inline />
    </div>
  );
}

// ─── Agents tab ───────────────────────────────────────────────────────────────

function SetupAgents({ projectId }) {
  const [Component, setComponent] = useState(null);
  useEffect(() => {
    import('./Builder.jsx').then((m) => setComponent(() => m.Builder));
  }, []);
  if (!Component) return <Spinner />;
  return <Component />;
}

// ─── Team tab ────────────────────────────────────────────────────────────────

function SetupTeam({ projectId }) {
  const [Component, setComponent] = useState(null);
  useEffect(() => {
    import('./ProjectSettings.jsx').then((m) => setComponent(() => m.ProjectSettings));
  }, []);
  if (!Component) return <Spinner />;
  return <Component />;
}

// ─── Jira tab ────────────────────────────────────────────────────────────────

function SetupJira({ projectId }) {
  const [Component, setComponent] = useState(null);
  useEffect(() => {
    // JiraConnection is exported from Tickets.jsx
    import('./Tickets.jsx').then((m) => setComponent(() => m.JiraConnection));
  }, []);
  if (!Component) return <Spinner />;
  return <Component />;
}

// ─── Configuration tab ───────────────────────────────────────────────────────

function SetupConfig({ projectId }) {
  const [Component, setComponent] = useState(null);
  useEffect(() => {
    import('./Configuration.jsx').then((m) => setComponent(() => m.Configuration));
  }, []);
  if (!Component) return <Spinner />;
  return <Component />;
}

// ─── Budget tab ───────────────────────────────────────────────────────────────

function SetupBudget({ projectId }) {
  return <BudgetFix projectId={projectId} onSaved={() => {}} onClose={() => {}} />;
}
