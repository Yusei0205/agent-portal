import { useCallback, useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import { AppContext, ProjectContext, useApp } from './lib/context.js';
import { api, emitInboxCount, setUnauthorizedHandler, sharedStream, stream } from './lib/api.js';
import { emitProjectEvent, useProjectEvents } from './lib/events.js';
import { getTheme, setTheme } from './lib/theme.js';
import { go, href, useRoute } from './lib/router.js';
import { cx, money } from './lib/util.js';
import { Icon } from './components/Icon.jsx';
import { Badge, Button, Modal, Spinner, UiProvider } from './components/ui.jsx';
import { Login, Setup, AcceptInvite, ResetPassword } from './pages/Auth.jsx';
import { Projects } from './pages/Projects.jsx';
import { Knowledge } from './pages/Knowledge.jsx';
import { Create } from './pages/Create.jsx';
import { Sessions, legacyRunTarget } from './pages/Sessions.jsx';
import { Tickets } from './pages/Tickets.jsx';
import { Review } from './pages/Review.jsx';
import { Workspaces } from './pages/Workspaces.jsx';
import { Settings } from './pages/Settings.jsx';
import { Account } from './pages/Account.jsx';
import { AwsAccounts } from './pages/AwsAccounts.jsx';
import { Connections } from './pages/Connections.jsx';
import { Integrations } from './pages/Integrations.jsx';
import { ApiAccess } from './pages/ApiAccess.jsx';
import { Vault } from './pages/Vault.jsx';
import { ProjectSetup } from './pages/ProjectSetup.jsx';
import { AdminPanel } from './pages/AdminPanel.jsx';
import { Profile } from './pages/Profile.jsx';
import { Inbox } from './pages/Inbox.jsx';

// Insights is lazy-loaded so recharts stays out of the main bundle.
const InsightsPage = lazy(() => import('./pages/Insights.jsx').then((m) => ({ default: m.Insights })));


export function App() {
  const [auth, setAuth] = useState({ loading: true });
  const load = useCallback(async () => {
    try {
      const s = await api.get('/api/auth/state');
      setAuth({ loading: false, needsSetup: s.needsSetup, user: s.user });
    } catch (e) {
      setAuth({ loading: false, error: e });
    }
  }, []);
  useEffect(() => {
    load();
    setUnauthorizedHandler(() => setAuth((a) => ({ ...a, user: null })));
  }, [load]);

  // Track the hash reactively so invite/reset links work even when the user is already signed in.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Handle accept-invite and reset-password hash routes before auth check
  const inviteMatch = hash.match(/^#\/?accept-invite\/([A-Za-z0-9_-]+)/);
  const resetMatch = hash.match(/^#\/?reset-password\/([A-Za-z0-9_-]+)/);
  // OIDC callback lands as a query param on the root (the server redirects to #/oidc-done on success)
  const oidcDone = hash.startsWith('#/oidc-done') || hash.startsWith('#oidc-done');

  let body;
  if (auth.loading) body = <div className="splash"><Spinner /></div>;
  else if (auth.error) body = <div className="splash"><p>{auth.error.message}</p></div>;
  else if (auth.needsSetup) body = <Setup onDone={load} />;
  else if (inviteMatch) body = <AcceptInvite token={inviteMatch[1]} onDone={() => { window.location.hash = '#/projects'; load(); }} />;
  else if (resetMatch) body = <ResetPassword token={resetMatch[1]} onDone={() => { window.location.hash = '#/'; load(); }} />;
  else if (!auth.user) body = <Login onDone={load} />;
  else body = <Shell user={auth.user} onSignOut={load} />;
  return <UiProvider>{body}</UiProvider>;
}

/**
 * The main-menu items visible when a project is selected.
 * Groups are identified by a `group` key instead of a `tab` key.
 */
const PROJECT_MAIN_ITEMS = [
  { tab: 'sessions', label: 'Sessions', icon: 'play' },
  { tab: 'workspaces', label: 'Workspaces', icon: 'projects' },
  // Only listed when the project has Jira connected; the page stays reachable and explains how to connect.
  { tab: 'tickets', label: 'Tickets', icon: 'inbox', needsJira: true },
  { tab: 'review', label: 'Code review', icon: 'review' },
  { tab: 'knowledge', label: 'Knowledge', icon: 'knowledge' },
  // Diagrams, documents, decks and templates are its tabs; Learn is a tab of Knowledge.
  { tab: 'create', label: 'Create', icon: 'builder' },
  { tab: 'vault', label: 'Vault', icon: 'inbox', scoped: true },
  { tab: 'insights', label: 'Insights', icon: 'chart', scoped: true },
  { tab: 'setup', label: 'Setup', icon: 'settings' },
  { group: 'portal', label: 'Portal', icon: 'lock' },
];

/**
 * Vault and Insights each appear once, in the main list. They open for the project in the menu, or for the whole
 * portal when no project is picked; the page itself has the switch between the two.
 */
const SCOPED_ITEMS = PROJECT_MAIN_ITEMS.filter((i) => i.scoped);

const PORTAL_ITEMS = [
  { tab: 'inbox', label: 'Inbox', icon: 'inbox', global: true },
  { tab: 'connections', label: 'Git connections', icon: 'branch', global: true },
  { tab: 'integrations', label: 'Integrations', icon: 'builder', global: true },
  { tab: 'aws', label: 'AWS accounts', icon: 'lock', global: true },
  { tab: 'api', label: 'API access', icon: 'lock', global: true },
  { tab: 'admin', label: 'Admin', icon: 'user', global: true, adminOnly: true },
  { tab: 'settings', label: 'Settings', icon: 'settings', global: true, adminOnly: true },
];


/**
 * Whether the menu project has Jira connected (GET /api/projects/:pid/jira). Looked up again when the project changes
 * and when you move between Setup, Tickets and the rest, which is where connecting or disconnecting happens.
 */
function useJiraConnected(projectId, route) {
  const [state, setState] = useState({ projectId: null, connected: false });
  const watch = route.tab === 'setup' || route.tab === 'tickets' ? `${route.tab}/${route.rest[0] || ''}` : '';
  useEffect(() => {
    if (!projectId) return undefined;
    let alive = true;
    api
      .get(`/api/projects/${encodeURIComponent(projectId)}/jira`)
      .then((r) => alive && setState({ projectId, connected: Boolean(r.connected) }))
      .catch(() => alive && setState({ projectId, connected: false }));
    return () => {
      alive = false;
    };
  }, [projectId, watch]);
  return state.projectId === projectId && state.connected;
}

/**
 * Navigation menu inside the rail. The Portal pages are a group that expands in place (no separate panel and no
 * Back button), so project and portal pages are one click away from each other. The group remembers whether it was
 * open, and opens by itself when one of its pages is showing.
 */
function NavMenu({ route, projectId, current, user, inboxCount, onNavigate }) {
  const onPortalPage = PORTAL_ITEMS.some((i) => i.tab === route.tab) && !route.projectId;
  const [portalOpen, setPortalOpen] = useState(() => {
    try {
      return localStorage.getItem('rail-portal-open') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (onPortalPage) setPortalOpen(true);
  }, [onPortalPage]);
  const toggle = () =>
    setPortalOpen((o) => {
      try {
        localStorage.setItem('rail-portal-open', o ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !o;
    });
  const handleLinkClick = () => onNavigate?.();
  const jiraConnected = useJiraConnected(projectId, route);
  const portalItems = PORTAL_ITEMS.filter((i) => !i.adminOnly || user.is_admin);

  const link = (key, linkHref, icon, label, isActive, badge = null, nested = false) => (
    <a key={key} href={linkHref} className={cx('rail-link', nested && 'rail-link-nested', isActive && 'is-active')} aria-current={isActive ? 'page' : undefined} onClick={handleLinkClick}>
      <Icon name={icon} />
      <span>{label}</span>
      {badge}
    </a>
  );

  const portalGroup = (
    <div key="portal" className={cx('rail-group', portalOpen && 'is-open')}>
      <button
        type="button"
        className={cx('rail-group-btn', onPortalPage && 'has-active-child')}
        aria-expanded={portalOpen}
        aria-controls="rail-portal-items"
        onClick={toggle}
      >
        <Icon name="lock" />
        <span>Portal</span>
        <Icon name="chevronRight" size={14} className={cx('rail-group-chevron', portalOpen && 'is-rotated')} aria-hidden="true" />
      </button>
      {portalOpen ? (
        <div id="rail-portal-items" className="rail-group-items" role="group" aria-label="Portal">
          {portalItems.map((item) =>
            link(
              item.tab,
              `#/${item.tab}`,
              item.icon,
              item.label,
              route.tab === item.tab && !route.projectId,
              item.tab === 'inbox' && inboxCount > 0 ? (
                <span className="rail-count" title={`${inboxCount} item${inboxCount === 1 ? '' : 's'} need your attention`}>{inboxCount}</span>
              ) : null,
              true,
            ),
          )}
        </div>
      ) : null}
    </div>
  );

  if (!projectId) {
    return (
      <div className="rail-nav-wrap">
        <nav className="rail-nav" aria-label="Pages">
          {link('projects', '#/projects', 'projects', 'Projects', route.tab === 'projects')}
          {SCOPED_ITEMS.map((item) => link(item.tab, `#/${item.tab}`, item.icon, item.label, route.tab === item.tab))}
          {portalGroup}
        </nav>
      </div>
    );
  }
  // Wait for the project list so badges (open questions, approvals) can show.
  if (!current) return <div className="rail-nav-wrap" />;
  return (
    <div className="rail-nav-wrap">
      <nav className="rail-nav" aria-label="Pages">
        {PROJECT_MAIN_ITEMS.map((item) => {
          if (item.group) return portalGroup;
          if (item.needsJira && !jiraConnected) return null;
          const badge =
            item.tab === 'knowledge' && current.open_questions ? (
              <span className="rail-count" title="Team questions waiting">{current.open_questions}</span>
            ) : item.tab === 'sessions' && current.pending_approvals ? (
              <span className="rail-count" title="Waiting for your permission">{current.pending_approvals}</span>
            ) : null;
          // Vault and Insights stay highlighted on their portal-wide page too: it is the same page, with the scope switched.
          const active = item.scoped ? route.tab === item.tab : Boolean(route.projectId) && route.tab === item.tab;
          return link(item.tab, href(projectId, item.tab), item.icon, item.label, active, badge);
        })}
      </nav>
    </div>
  );
}

// ─── Keyboard shortcuts help dialog ──────────────────────────────────────────

const SHORTCUTS = [
  { key: 'Alt + I', description: 'Open Inbox' },
  { key: 'Alt + N', description: 'New session (when in a project)' },
  { key: '?', description: 'Show this help dialog' },
];

function KeyboardShortcutsDialog({ onClose, projectId }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <table className="table compact" aria-label="Keyboard shortcuts">
        <thead>
          <tr><th>Key</th><th>Action</th></tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.key}>
              <td><kbd className="mono small">{s.key}</kbd></td>
              <td>{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small" style={{ marginTop: '0.75rem' }}>
        Shortcuts never fire while you are typing in an input, textarea, or select.
      </p>
    </Modal>
  );
}

function Shell({ user, onSignOut }) {
  const route = useRoute();
  const [projects, setProjects] = useState(null);
  const [meta, setMeta] = useState({ provider: 'demo', prices: null, models: [] });
  const [spend, setSpend] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  const loadProjects = useCallback(async () => {
    const r = await api.get('/api/projects');
    setProjects(r.projects);
  }, []);
  const loadMeta = useCallback(async () => {
    const [m, s] = await Promise.all([api.get('/api/meta'), api.get('/api/settings')]);
    setMeta(m);
    setSpend(s.usage?.monthUsd ?? null);
  }, []);
  useEffect(() => {
    loadProjects();
    loadMeta();
  }, [loadProjects, loadMeta]);
  useEffect(() => setNavOpen(false), [route.tab, route.projectId]);

  // Live inbox count via SSE
  useEffect(() => {
    // Get initial count
    api.get('/api/inbox?filter=needs_you').then((r) => setInboxCount(r.needs_you ?? 0)).catch(() => {});
    const close = sharedStream('/api/inbox/events', {
      'inbox.count': (data) => {
        setInboxCount(data.needs_you ?? 0);
        emitInboxCount(data);
      },
    });
    return close;
  }, []);

  // Keyboard shortcuts — never fire while the user is typing in an input
  useEffect(() => {
    const isTyping = (e) => {
      const tag = e.target?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;
    };
    const handler = (e) => {
      if (isTyping(e)) return;
      // Alt+I → open Inbox
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === 'i') {
        e.preventDefault();
        window.location.hash = '#/inbox';
      }
      // Alt+N → open New session (if in a project)
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === 'n') {
        e.preventDefault();
        if (route.projectId) {
          window.location.hash = `#/p/${route.projectId}/sessions/new`;
        } else {
          window.location.hash = '#/projects';
        }
      }
      // ? → show keyboard shortcut help
      if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === '?') {
        e.preventDefault();
        setShowShortcutsHelp((v) => !v);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [route.projectId]);

  const ctx = useMemo(() => ({ user, projects, reloadProjects: loadProjects, meta, reloadMeta: loadMeta }), [user, projects, loadProjects, meta, loadMeta]);

  return (
    <AppContext.Provider value={ctx}>
      <div className={cx('shell', navOpen && 'nav-open')}>
        <a className="skip" href="#main">Skip to content</a>
        <Rail route={route} user={user} projects={projects} meta={meta} spend={spend} inboxCount={inboxCount} onSignOut={onSignOut} onNavigate={() => setNavOpen(false)} />
        <div className="topbar">
          <button className="icon-btn" aria-label="Menu" onClick={() => setNavOpen((v) => !v)}>
            <Icon name="menu" />
          </button>
          <span className="topbar-title">Agent Portal</span>
        </div>
        {showShortcutsHelp ? (
          <KeyboardShortcutsDialog onClose={() => setShowShortcutsHelp(false)} projectId={route.projectId} />
        ) : null}
        <main id="main" className="main" tabIndex={-1}>
          {route.projectId ? (
            <ProjectScope key={route.projectId} projectId={route.projectId} route={route} />
          ) : route.tab === 'settings' ? (
            <Settings />
          ) : route.tab === 'aws' ? (
            <AwsAccounts />
          ) : route.tab === 'connections' ? (
            <Connections />
          ) : route.tab === 'integrations' ? (
            <Integrations />
          ) : route.tab === 'api' ? (
            <ApiAccess />
          ) : route.tab === 'vault' ? (
            <Vault />
          ) : route.tab === 'account' ? (
            <Profile />
          ) : route.tab === 'admin' ? (
            <AdminPanel />
          ) : route.tab === 'inbox' ? (
            <Inbox />
          ) : route.tab === 'insights' ? (
            <Suspense fallback={<div className="pad"><Spinner /></div>}>
              <InsightsPage />
            </Suspense>
          ) : (
            <Projects />
          )}
        </main>
      </div>
    </AppContext.Provider>
  );
}

/** Live readout of what the agents in this project are doing. */
function AgentActivity({ projectId }) {
  const [counts, setCounts] = useState({ working: 0, waiting: 0 });
  const timer = useRef(null);
  const load = useCallback(async () => {
    try {
      const r = await api.get(`/api/projects/${projectId}/runs?limit=30`);
      const runs = r.runs || [];
      setCounts({
        working: runs.filter((x) => x.status === 'running' || x.status === 'queued').length,
        waiting: runs.filter((x) => x.status === 'waiting').length,
      });
    } catch {
      /* the readout is optional */
    }
  }, [projectId]);
  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
  }, [load]);
  // Run updates arrive in bursts; look again once they settle.
  useProjectEvents(['run.updated'], () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, 400);
  });
  const text = counts.waiting ? `${counts.waiting} need${counts.waiting === 1 ? 's' : ''} you` : counts.working ? `${counts.working} agent${counts.working === 1 ? '' : 's'} working` : 'Agents idle';
  return (
    <div className={cx('rail-activity', counts.waiting ? 'needs-you' : counts.working ? 'is-active' : '')} role="status" aria-live="polite">
      <span className="pulse-dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

/** Quick switch between the HUD look and the standard look. */
function LookSwitch() {
  const [theme, setT] = useState(getTheme());
  useEffect(() => {
    const sync = () => setT(getTheme());
    window.addEventListener('portal-look', sync);
    return () => window.removeEventListener('portal-look', sync);
  }, []);
  const hud = theme === 'hud';
  return (
    <button type="button" className="look-switch" aria-pressed={hud} onClick={() => setTheme(hud ? 'standard' : 'hud')} title="Switch between the HUD and standard look">
      <span aria-hidden="true">◈</span>
      <span>{hud ? 'HUD look: on' : 'HUD look: off'}</span>
    </button>
  );
}

function Rail({ route, user, projects, meta, spend, inboxCount, onSignOut, onNavigate }) {
  // Portal pages (Inbox, AWS accounts, Settings…) have no project in their address. The menu keeps showing the last
  // project you were in, so its pages stay one click away instead of the menu dropping back to "All projects".
  const [lastProject, setLastProject] = useState(() => {
    try {
      return localStorage.getItem('rail-last-project') || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (!route.projectId) return;
    setLastProject(route.projectId);
    try {
      localStorage.setItem('rail-last-project', route.projectId);
    } catch {
      /* private mode */
    }
  }, [route.projectId]);
  const onProjectsPage = route.tab === 'projects' && !route.projectId;
  const known = (id) => (projects || []).some((p) => p.id === id && !p.archived);
  const menuProject = route.projectId || (!onProjectsPage && known(lastProject) ? lastProject : null);
  const current = projects?.find((p) => p.id === menuProject);
  const signOut = async () => {
    await api.post('/api/auth/logout');
    onSignOut();
  };
  return (
    <aside className="rail" aria-label="Main navigation">
      <a className="brand" href="#/projects">
        <img src="/favicon.svg" alt="" width="26" height="26" />
        <span>Agent Portal</span>
      </a>
      <div className="switcher">
        <label className="switcher-label" htmlFor="project-switch">
          Project
        </label>
        <select
          id="project-switch"
          className="input switcher-select"
          value={menuProject || ''}
          onChange={(e) => (e.target.value ? go(e.target.value, route.projectId ? route.tab : 'knowledge') : go(null, 'projects'))}
        >
          <option value="">All projects</option>
          {(projects || []).filter((p) => !p.archived || p.id === menuProject).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <NavMenu
        route={route}
        projectId={menuProject}
        current={current}
        user={user}
        inboxCount={inboxCount}
        onNavigate={onNavigate}
      />
      <div className="rail-foot">
        {current ? <AgentActivity projectId={current.id} /> : null}
        <LookSwitch />
        <div className="rail-status">
          <Badge tone={meta.provider === 'demo' ? 'warn' : 'accent'}>
            {meta.provider === 'demo' ? 'Demo mode' : meta.provider === 'bedrock' ? 'Amazon Bedrock' : meta.provider === 'kiro' ? 'Kiro CLI' : 'Anthropic API'}
          </Badge>
          {spend !== null && meta.provider !== 'demo' && meta.provider !== 'kiro' ? <span className="muted small">{money(spend, 2)} this month</span> : null}
        </div>
        <div className="rail-user">
          <a href="#/account" className="rail-user-name" title="Your account">
            <Icon name="user" size={16} />
            <span>{user.name}</span>
          </a>
          <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
            <Icon name="logout" size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Sends an old #/p/<id>/runs/... link to where that run now lives under Sessions. */
function LegacyRuns({ projectId, route }) {
  const runId = route.rest[0] && route.rest[0] !== 'new' ? route.rest[0] : null;
  useEffect(() => {
    let alive = true;
    const send = (run) => alive && window.location.replace(legacyRunTarget(projectId, route.rest, route.query, run));
    if (runId) api.get(`/api/runs/${runId}`).then((r) => send(r.run), () => send(null));
    else send(null);
    return () => {
      alive = false;
    };
  }, [projectId, runId, route.rest, route.query]);
  return <div className="pad"><Spinner /></div>;
}

function ProjectScope({ projectId, route }) {
  const { reloadProjects } = useApp();
  const [state, setState] = useState({ loading: true });
  const timer = useRef(null);
  const load = useCallback(async () => {
    try {
      const r = await api.get(`/api/projects/${projectId}`);
      setState({ loading: false, ...r });
    } catch (error) {
      setState({ loading: false, error });
    }
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const refreshSoon = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        load();
        reloadProjects();
      }, 300);
    };
    const handlers = {};
    for (const ev of [
      'run.updated',
      'run.activity',
      'workflow.updated',
      'workflow.deleted',
      'input.created',
      'input.resolved',
      'document.updated',
      'document.deleted',
      'repo.updated',
      'repo.deleted',
      'repo.progress',
      'workspace.updated',
      'review.updated',
      'learn.updated',
      'learn.progress',
      'diagrams.updated',
      'presentations.updated',
      'generated-docs.updated',
      'builder.updated',
      'members.updated',
      'project.updated',
    ]) {
      handlers[ev] = (data) => {
        emitProjectEvent(ev, data);
        if (['input.created', 'input.resolved', 'members.updated', 'project.updated', 'document.updated'].includes(ev)) refreshSoon();
      };
    }
    const close = sharedStream(`/api/projects/${projectId}/stream`, handlers);
    return () => {
      close();
      clearTimeout(timer.current);
    };
  }, [projectId, load, reloadProjects]);

  if (state.loading) return <div className="pad"><Spinner /></div>;
  if (state.error) {
    return (
      <div className="pad">
        <h1>Project not available</h1>
        <p>{state.error.message}</p>
        <a href="#/projects">Back to projects</a>
      </div>
    );
  }
  const access = state.project.access;
  const value = { ...state, canEdit: access === 'editor' || access === 'owner', isOwner: access === 'owner', reload: load };
  let page;
  switch (route.tab) {
    case 'create':
      page = <Create route={route} />;
      break;
    case 'vault':
      page = <Vault projectId={projectId} />;
      break;
    case 'tickets':
      page = <Tickets />;
      break;
    case 'sessions':
      page = <Sessions route={route} />;
      break;
    case 'runs':
      // The Agent runs page is now part of Sessions; old links land in the right place there.
      page = <LegacyRuns projectId={projectId} route={route} />;
      break;
    case 'review':
      page = <Review route={route} />;
      break;
    case 'workspaces':
      page = <Workspaces />;
      break;
    // Repositories, Agents and skills, Configuration and Team are tabs of the setup hub; old links redirect there.
    case 'setup':
      page = <ProjectSetup route={route} />;
      break;
    case 'insights':
      page = (
        <Suspense fallback={<div className="pad"><Spinner /></div>}>
          <InsightsPage projectId={projectId} />
        </Suspense>
      );
      break;
    default:
      page = <Knowledge route={route} />;
  }
  return <ProjectContext.Provider value={value}>{page}</ProjectContext.Provider>;
}
