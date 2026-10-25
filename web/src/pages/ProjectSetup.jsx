/**
 * Project Setup Hub
 *
 * The one place to set a project up. Each section is a tab with its own address, #/p/<id>/setup/<section>:
 *   overview | connection | repos | agents | team | jira | config | budget
 * Older addresses such as #/p/<id>/repos and #/p/<id>/builder redirect here (see lib/router.js). Templates moved to the
 * Create page; #/p/<id>/setup/templates redirects there.
 *
 * The readiness panel (GET /api/projects/:pid/readiness, live via SSE) stays on top; its Add / Fix buttons open the
 * tab that fixes the item.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { useLoad, useAction } from '../lib/useAsync.js';
import { href } from '../lib/router.js';
import { cx } from '../lib/util.js';
import { Badge, Button, EmbeddedContext, ErrorNote, Field, Note, PageHeader, Spinner, Tabs, useUi } from '../components/ui.jsx';

// The tabs are other pages shown in place; loading them on demand keeps the hub itself light.
const Connection = lazy(() => import('./ProjectSettings.jsx').then((m) => ({ default: m.Connection })));
const ProjectSettings = lazy(() => import('./ProjectSettings.jsx').then((m) => ({ default: m.ProjectSettings })));
const Repos = lazy(() => import('./Repos.jsx').then((m) => ({ default: m.Repos })));
const Builder = lazy(() => import('./Builder.jsx').then((m) => ({ default: m.Builder })));
const Configuration = lazy(() => import('./Configuration.jsx').then((m) => ({ default: m.Configuration })));
const JiraConnection = lazy(() => import('./Tickets.jsx').then((m) => ({ default: m.JiraConnection })));

// ─── Readiness panel ────────────────────────────────────────────────────────

const STATUS_ICON = { ok: '✅', warn: '⚠️', missing: '❌' };

/** Which tab fixes each readiness item. */
const FIX_TAB = {
  provider: 'connection',
  aws: 'connection',
  repository: 'repos',
  lead_agent: 'team',
  budget: 'budget',
  jira: 'jira',
};

function fixHref(projectId, key) {
  // Git connections are shared by every project, so they are managed on the portal page.
  if (key === 'git_connection') return '#/connections';
  return href(projectId, 'setup', FIX_TAB[key] || '');
}

function ReadinessPanel({ projectId, canFix }) {
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
                {item.status !== 'ok' && canFix ? (
                  <a className="btn btn-primary btn-sm" href={fixHref(projectId, item.key)}>
                    {item.status === 'missing' ? 'Add' : 'Fix'}
                  </a>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {ready ? (
        <div className="readiness-ok-row">
          <span className="muted small">All required items are set up.</span>
          <a className="btn btn-primary btn-sm" href={href(projectId, 'sessions')}>Start a session →</a>
        </div>
      ) : (
        <p className="muted small">Fix the items above to start a real session. Demo mode works with anything.</p>
      )}
    </section>
  );
}

// ─── Budget ───────────────────────────────────────────────────────────────────

function BudgetTab({ projectId }) {
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
  });
  return (
    <section className="panel stack">
      <h2>Budget</h2>
      {portalCap ? (
        <Note tone="info">Portal monthly cap: ${portalCap}. A project cap applies in addition.</Note>
      ) : (
        <Note tone="warn">No portal cap set. Add one in <a href="#/settings">Settings</a>.</Note>
      )}
      <Field label="Monthly cap for this project (USD)" hint="Empty = inherits portal cap.">
        {(id) => (
          <input id={id} type="number" min={0} step={1} className="input input-num" value={cap} onChange={(e) => setCap(e.target.value)} />
        )}
      </Field>
      <ErrorNote error={act.error} />
      <div className="row">
        <Button variant="primary" busy={act.busy} onClick={save}>Save</Button>
      </div>
    </section>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────────────

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

const OVERVIEW_HINT = {
  connection: 'which model provider and AWS account this project uses',
  repos: 'the code agents read and change',
  agents: 'roles, agents and skills for Claude Code and Kiro',
  team: 'project details, defaults for new work, members and access',
  jira: 'this project’s Jira site and ticket mapping',
  config: 'the project’s .claude and .kiro files, edited directly',
  budget: 'the monthly spend cap',
};

/** The route a page shown inside a tab sees: the part of the address after the section, with the same query. */
function embeddedRoute(route) {
  return { ...route, rest: route.rest.slice(1) };
}

/** What each tab is for. The tabs above are the way in, so this lists them without repeating the links. */
function SetupOverview() {
  const { project } = useProject();
  return (
    <>
    <dl className="kv setup-overview">
      {SETUP_TABS.filter((t) => t.value !== 'overview').map((t) => (
        <div key={t.value}>
          <dt>{t.label}</dt>
          <dd>{OVERVIEW_HINT[t.value]}</dd>
        </div>
      ))}
    </dl>
    <p className="muted small">
      Diagrams, documents and decks are on the <a href={href(project.id, 'create', 'diagrams')}>Create</a> page. The Word and PowerPoint templates they follow are under <a href={href(project.id, 'create', 'templates')}>Create › Templates</a>.
    </p>
    </>
  );
}

function SetupTabContent({ tab, projectId, route }) {
  switch (tab) {
    case 'connection':
      return <Connection />;
    case 'repos':
      return <Repos />;
    case 'agents':
      return <Builder route={embeddedRoute(route)} />;
    case 'team':
      return <ProjectSettings />;
    case 'jira':
      return <JiraConnection />;
    case 'config':
      return <Configuration route={embeddedRoute(route)} />;
    case 'budget':
      return <BudgetTab projectId={projectId} />;
    default:
      return <SetupOverview />;
  }
}

// ─── Main Setup Hub ──────────────────────────────────────────────────────────

export function ProjectSetup({ route }) {
  const { project, isOwner, canEdit } = useProject();
  const requested = route.rest[0] || route.query.get('section') || 'overview';
  const current = SETUP_TABS.find((t) => t.value === requested) || SETUP_TABS[0];

  return (
    <div className="page wide">
      <PageHeader title="Project setup" sub="Everything needed to run sessions, in one place." />

      <ReadinessPanel projectId={project.id} canFix={isOwner || canEdit} />

      <Tabs
        value={current.value}
        tabs={SETUP_TABS.map((t) => ({ ...t, href: href(project.id, 'setup', t.value === 'overview' ? '' : t.value) }))}
      />

      <div className="hub-body" role="region" aria-label={current.label}>
        <EmbeddedContext.Provider value>
          <Suspense fallback={<Spinner />}>
            <SetupTabContent tab={current.value} projectId={project.id} route={route} />
          </Suspense>
        </EmbeddedContext.Provider>
      </div>
    </div>
  );
}
