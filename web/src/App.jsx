import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './lib/api.js';
import { useRoute, href, navigate } from './lib/router.js';
import { Icon } from './components/Icon.jsx';
import { Login } from './pages/Auth.jsx';
import SetupWizard from './pages/setup/SetupWizard.jsx';
import { SessionsShell } from './pages/sessions/SessionsShell.jsx';
import Settings from './pages/settings/Settings.jsx';
import { Projects } from './pages/Projects.jsx';
import { ProjectHub } from './pages/hub/ProjectHub.jsx';
import { Inbox } from './pages/Inbox.jsx';
import { Create } from './pages/Create.jsx';
import { Knowledge } from './pages/Knowledge.jsx';
import { Vault } from './pages/Vault.jsx';
import { Insights } from './pages/Insights.jsx';
import { AdminPanel } from './pages/AdminPanel.jsx';
import Review from './pages/Review.jsx';
import LoopSpecs from './pages/LoopSpecs.jsx';
import { Workspaces } from './pages/Workspaces.jsx';
import { ApiAccess } from './pages/ApiAccess.jsx';
import { Connections } from './pages/Connections.jsx';
import { Integrations } from './pages/Integrations.jsx';
import { AwsAccounts } from './pages/AwsAccounts.jsx';

// ── Navigation structure ──────────────────────────────────────────────────────

const PROJECT_MAIN_ITEMS = [
  { tab: 'sessions',    label: 'Sessions',    icon: 'play' },
  { tab: 'workspaces',  label: 'Workspaces',  icon: 'projects' },
  { tab: 'tickets',     label: 'Tickets',     icon: 'inbox',    needsJira: true },
  { tab: 'review',      label: 'Code review', icon: 'review' },
  { tab: 'knowledge',   label: 'Knowledge',   icon: 'knowledge' },
  { tab: 'create',      label: 'Create',      icon: 'builder' },
  { tab: 'vault',       label: 'Vault',       icon: 'inbox',    scoped: true },
  { tab: 'insights',    label: 'Insights',    icon: 'chart',    scoped: true },
  { tab: 'setup',       label: 'Setup',       icon: 'settings' },
  { group: 'portal',    label: 'Portal',      icon: 'lock' },
];

const PORTAL_ITEMS = [
  { tab: 'inbox',        label: 'Inbox',           icon: 'inbox',    global: true },
  { tab: 'connections',  label: 'Git connections', icon: 'branch',   global: true },
  { tab: 'integrations', label: 'Integrations',    icon: 'builder',  global: true },
  { tab: 'aws',          label: 'AWS accounts',    icon: 'lock',     global: true },
  { tab: 'api',          label: 'API access',      icon: 'lock',     global: true },
  { tab: 'admin',        label: 'Admin',           icon: 'user',     global: true, adminOnly: true },
  { tab: 'settings',     label: 'Settings',        icon: 'settings', global: true, adminOnly: true },
];

// Pages that come in later phases — show placeholder for now
const PAGE_LABELS = {
  sessions:     'Sessions',
  workspaces:   'Workspaces',
  tickets:      'Tickets',
  review:       'Code review',
  knowledge:    'Knowledge',
  create:       'Create',
  vault:        'Vault',
  insights:     'Insights',
  setup:        'Setup',
  projects:     'Projects',
  inbox:        'Inbox',
  connections:  'Git connections',
  integrations: 'Integrations',
  aws:          'AWS accounts',
  api:          'API access',
  admin:        'Admin',
  settings:     'Settings',
};

// ── Shell ─────────────────────────────────────────────────────────────────────

function Placeholder({ tab }) {
  const label = PAGE_LABELS[tab] || tab;
  return (
    <div className="page">
      <h1>{label}</h1>
      <p className="muted">Coming soon.</p>
    </div>
  );
}

function NavMenu({ route, projectId, user, inboxCount, onNavigate }) {
  const onPortalPage =
    PORTAL_ITEMS.some((i) => i.tab === route.tab) && !route.projectId;
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

  const togglePortal = () =>
    setPortalOpen((o) => {
      try {
        localStorage.setItem('rail-portal-open', o ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !o;
    });

  const portalItems = PORTAL_ITEMS.filter(
    (i) => !i.adminOnly || user.is_admin,
  );

  const NavLink = ({ tab, linkHref, icon, label, active, badge, nested }) => (
    <a
      href={linkHref}
      className={`rail-link${nested ? ' rail-link-nested' : ''}${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
    >
      <Icon name={icon} size={16} />
      <span>{label}</span>
      {badge}
    </a>
  );

  const portalGroup = (
    <div key="portal">
      <button
        type="button"
        className={`rail-group-btn${onPortalPage ? ' has-active-child' : ''}`}
        aria-expanded={portalOpen}
        onClick={togglePortal}
      >
        <Icon name="lock" size={16} />
        <span>Portal</span>
        <Icon
          name="chevronRight"
          size={13}
          className={`rail-group-chevron${portalOpen ? ' is-rotated' : ''}`}
        />
      </button>
      {portalOpen && (
        <div className="rail-group-items" role="group" aria-label="Portal">
          {portalItems.map((item) => (
            <NavLink
              key={item.tab}
              tab={item.tab}
              linkHref={`#/${item.tab}`}
              icon={item.icon}
              label={item.label}
              active={route.tab === item.tab && !route.projectId}
              badge={
                item.tab === 'inbox' && inboxCount > 0 ? (
                  <span className="rail-count">{inboxCount}</span>
                ) : null
              }
              nested
            />
          ))}
        </div>
      )}
    </div>
  );

  if (!projectId) {
    return (
      <div className="rail-nav-wrap">
        <nav className="rail-nav" aria-label="Pages">
          <NavLink
            tab="projects"
            linkHref="#/projects"
            icon="projects"
            label="Projects"
            active={route.tab === 'projects'}
          />
          {portalGroup}
        </nav>
      </div>
    );
  }

  return (
    <div className="rail-nav-wrap">
      <nav className="rail-nav" aria-label="Pages">
        {PROJECT_MAIN_ITEMS.map((item, i) => {
          if (item.group) return portalGroup;
          if (item.needsJira) return null; // Jira integration handled later
          const isActive = item.scoped
            ? route.tab === item.tab
            : Boolean(route.projectId) && route.tab === item.tab;
          return (
            <NavLink
              key={item.tab}
              tab={item.tab}
              linkHref={href(projectId, item.tab)}
              icon={item.icon}
              label={item.label}
              active={isActive}
            />
          );
        })}
      </nav>
    </div>
  );
}

function Rail({ route, user, projects, inboxCount, onSignOut, onNavigate, collapsed, onToggleCollapse }) {
  const [projectId, setProjectId] = useState(() => route.projectId || '');

  // Keep the switcher in sync with the URL
  useEffect(() => {
    if (route.projectId) setProjectId(route.projectId);
  }, [route.projectId]);

  const switchProject = (e) => {
    const pid = e.target.value;
    setProjectId(pid);
    if (pid) {
      navigate(`/p/${pid}/sessions`);
    } else {
      navigate('/projects');
    }
  };

  const signOut = async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // best effort
    }
    onSignOut();
  };

  return (
    <aside className="rail" aria-label="Navigation">
      <a href="#/projects" className="brand" aria-label="Agent Portal home">
        <img
          src="/favicon.svg"
          width={22}
          height={22}
          alt=""
          className="brand-icon"
        />
        {!collapsed && <span>Agent Portal</span>}
      </a>

      {!collapsed && (
        <div className="switcher">
          <div className="switcher-label">Project</div>
          <select
            className="switcher-select"
            value={projectId}
            onChange={switchProject}
            aria-label="Switch project"
          >
            <option value="">— all projects —</option>
            {(projects || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <NavMenu
        route={route}
        projectId={route.projectId}
        user={user}
        inboxCount={inboxCount}
        onNavigate={onNavigate}
      />

      <div className="rail-foot">
        <button
          type="button"
          className="rail-collapse-btn"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={15} />
          {!collapsed && <span>Collapse</span>}
        </button>
        <div className="rail-user">
          <a href="#/account" className="rail-user-name">
            <Icon name="user" size={15} />
            <span className="rail-foot-name">{user.name || user.email}</span>
          </a>
          <button
            type="button"
            className="btn-icon"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
          >
            <Icon name="logout" size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Shell({ user, onSignOut }) {
  const route = useRoute();
  const [projects, setProjects] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('rail-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const inboxPollRef = useRef(null);

  const loadProjects = useCallback(async () => {
    try {
      const r = await api.get('/api/projects');
      setProjects(r.projects || []);
    } catch {
      setProjects([]);
    }
  }, []);

  const loadInboxCount = useCallback(async () => {
    try {
      const r = await api.get('/api/inbox/count');
      setInboxCount(r.count ?? 0);
    } catch {
      // non-fatal — just don't update the badge
    }
  }, []);

  useEffect(() => {
    loadProjects();
    loadInboxCount();
    // Poll inbox count every 30 seconds
    inboxPollRef.current = setInterval(loadInboxCount, 30_000);
    return () => clearInterval(inboxPollRef.current);
  }, [loadProjects, loadInboxCount]);

  useEffect(() => {
    setNavOpen(false);
  }, [route.tab, route.projectId]);

  const toggleCollapse = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem('rail-collapsed', next ? '1' : '0');
      } catch {
        /* private mode */
      }
      return next;
    });
  };

  // Resolve project object for pages that need it
  const currentProject = projects?.find((p) => p.id === route.projectId) ?? null;

  // Decide what to render in the main area
  const isSessionsRoute = route.projectId && route.tab === 'sessions';
  const isProjectsRoute = !route.projectId && route.tab === 'projects';
  const isSetupRoute = route.projectId && route.tab === 'setup';
  const isSettingsRoute = !route.projectId && route.tab === 'settings';
  const isInboxRoute = !route.projectId && route.tab === 'inbox';
  const isCreateRoute = route.projectId && route.tab === 'create';
  const isKnowledgeRoute = route.projectId && route.tab === 'knowledge';
  const isVaultRoute = route.projectId && route.tab === 'vault';
  const isInsightsRoute = route.tab === 'insights';
  const isAdminRoute = !route.projectId && route.tab === 'admin';
  const isReviewRoute = route.projectId && route.tab === 'review';
  const isLoopSpecsRoute = route.projectId && route.tab === 'loop-specs';
  const isWorkspacesRoute = route.projectId && route.tab === 'workspaces';
  const isApiRoute = !route.projectId && route.tab === 'api';
  const isConnectionsRoute = !route.projectId && route.tab === 'connections';
  const isIntegrationsRoute = !route.projectId && route.tab === 'integrations';
  const isAwsRoute = !route.projectId && route.tab === 'aws';

  return (
    <div
      className={`shell${collapsed ? ' rail-collapsed' : ''}${navOpen ? ' nav-open' : ''}`}
    >
      <a className="skip" href="#main">
        Skip to content
      </a>

      <Rail
        route={route}
        user={user}
        projects={projects}
        inboxCount={inboxCount}
        onSignOut={onSignOut}
        onNavigate={() => setNavOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
      />

      {/* Mobile topbar */}
      <div className="topbar">
        <button
          type="button"
          className="btn-icon"
          aria-label="Menu"
          onClick={() => setNavOpen((v) => !v)}
        >
          <Icon name="menu" />
        </button>
        <span className="topbar-title">Agent Portal</span>
      </div>

      <main
        id="main"
        className={`main${isSessionsRoute ? ' full-height' : ''}`}
        tabIndex={-1}
      >
        {isSessionsRoute ? (
          <SessionsShell
            projectId={route.projectId}
            project={currentProject}
            route={route}
          />
        ) : isProjectsRoute ? (
          <Projects user={user} onProjectsChange={loadProjects} />
        ) : isSetupRoute ? (
          <ProjectHub projectId={route.projectId} user={user} />
        ) : isSettingsRoute ? (
          <Settings />
        ) : isInboxRoute ? (
          <Inbox />
        ) : isCreateRoute ? (
          <Create projectId={route.projectId} />
        ) : isKnowledgeRoute ? (
          <Knowledge projectId={route.projectId} />
        ) : isVaultRoute ? (
          <Vault projectId={route.projectId} user={user} />
        ) : isInsightsRoute ? (
          <Insights projectId={route.projectId || null} user={user} />
        ) : isAdminRoute ? (
          <AdminPanel user={user} />
        ) : isReviewRoute ? (
          <Review projectId={route.projectId} />
        ) : isLoopSpecsRoute ? (
          <LoopSpecs projectId={route.projectId} />
        ) : isWorkspacesRoute ? (
          <Workspaces projectId={route.projectId} />
        ) : isApiRoute ? (
          <ApiAccess />
        ) : isConnectionsRoute ? (
          <Connections />
        ) : isIntegrationsRoute ? (
          <Integrations projectId={route.projectId} />
        ) : isAwsRoute ? (
          <AwsAccounts projectId={route.projectId} />
        ) : (
          <Placeholder tab={route.tab} />
        )}
      </main>
    </div>
  );
}

// ── App root ─────────────────────────────────────────────────────────────────

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
  }, [load]);

  if (auth.loading) {
    return (
      <div className="splash">
        <div className="spinner" aria-label="Loading…" />
      </div>
    );
  }

  if (auth.error) {
    return (
      <div className="splash">
        <p className="muted">Could not reach the server. Please refresh.</p>
      </div>
    );
  }

  if (auth.needsSetup) {
    return <SetupWizard onDone={load} />;
  }

  if (!auth.user) {
    return <Login onDone={load} />;
  }

  return <Shell user={auth.user} onSignOut={load} />;
}
