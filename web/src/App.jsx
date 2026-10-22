import { useCallback, useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import { AppContext, ProjectContext, useApp } from './lib/context.js';
import { api, setUnauthorizedHandler, stream } from './lib/api.js';
import { emitProjectEvent, useProjectEvents } from './lib/events.js';
import { getTheme, setTheme } from './lib/theme.js';
import { go, href, useRoute } from './lib/router.js';
import { cx, money } from './lib/util.js';
import { Icon } from './components/Icon.jsx';
import { Badge, Button, Modal, Spinner, UiProvider } from './components/ui.jsx';
import { Login, Setup, AcceptInvite, ResetPassword } from './pages/Auth.jsx';
import { Projects } from './pages/Projects.jsx';
import { ProjectSettings } from './pages/ProjectSettings.jsx';
import { Knowledge } from './pages/Knowledge.jsx';
import { Learn } from './pages/Learn.jsx';
import { Sessions, legacyRunTarget } from './pages/Sessions.jsx';
import { Tickets } from './pages/Tickets.jsx';
import { Review } from './pages/Review.jsx';
import { Repos } from './pages/Repos.jsx';
import { Workspaces } from './pages/Workspaces.jsx';
import { Configuration } from './pages/Configuration.jsx';
import { Builder } from './pages/Builder.jsx';
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
  { tab: 'tickets', label: 'Tickets', icon: 'inbox' },
  { tab: 'review', label: 'Code review', icon: 'review' },
  { tab: 'knowledge', label: 'Knowledge', icon: 'knowledge' },
  { tab: 'learn', label: 'Learn', icon: 'learn' },
  { tab: 'setup', label: 'Setup', icon: 'settings' },
  { group: 'portal', label: 'Portal', icon: 'lock' },
];

const PROJECT_SETUP_ITEMS = [
  { tab: 'repos', label: 'Repositories', icon: 'repos' },
  { tab: 'builder', label: 'Agents and skills', icon: 'builder' },
  { tab: 'config', label: 'Configuration', icon: 'settings' },
  { tab: 'team', label: 'Project and team', icon: 'user' },
  { tab: 'insights', label: 'Project insights', icon: 'chart', projectScoped: true },
];

const PORTAL_ITEMS = [
  { tab: 'inbox', label: 'Inbox', icon: 'inbox', global: true },
  { tab: 'connections', label: 'Git connections', icon: 'branch', global: true },
  { tab: 'integrations', label: 'Integrations', icon: 'builder', global: true },
  { tab: 'aws', label: 'AWS accounts', icon: 'lock', global: true },
  { tab: 'vault', label: 'Vault', icon: 'inbox', global: true },
  { tab: 'api', label: 'API access', icon: 'lock', global: true },
  { tab: 'insights', label: 'All insights', icon: 'chart', global: true },
  { tab: 'admin', label: 'Admin', icon: 'user', global: true, adminOnly: true },
  { tab: 'settings', label: 'Settings', icon: 'settings', global: true, adminOnly: true },
];

/** Which group (if any) does a given tab belong to for the drill-down nav? */
function groupForTab(tab) {
  if (PORTAL_ITEMS.some((i) => i.tab === tab)) return 'portal';
  return null;
}

/**
 * Drill-down navigation menu inside the rail.
 *
 * Props:
 *   route        – current route from useRoute()
 *   projectId    – the current project ID (or null)
 *   current      – the current project object (or null)
 *   user         – the authenticated user
 *   onNavigate   – called when a leaf link is clicked (closes mobile nav)
 */
function NavMenu({ route, projectId, current, user, inboxCount, onNavigate }) {
  // Which group is open: null = main menu, 'setup' | 'portal' = submenu
  const initialGroup = projectId ? groupForTab(route.tab) : (PORTAL_ITEMS.some((i) => i.tab === route.tab) ? 'portal' : null);
  const [openGroup, setOpenGroup] = useState(initialGroup);

  // When the route changes (navigation, refresh), re-sync to the correct panel.
  useEffect(() => {
    if (projectId) {
      setOpenGroup(groupForTab(route.tab));
    } else {
      setOpenGroup(PORTAL_ITEMS.some((i) => i.tab === route.tab) ? 'portal' : null);
    }
  }, [route.tab, projectId]);

  const backRef = useRef(null);
  const groupBtnRefs = useRef({});

  const openSub = (group) => {
    setOpenGroup(group);
    // Move focus to Back button after the panel slides in.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => backRef.current?.focus());
    });
  };

  const closeSub = () => {
    const prev = openGroup;
    setOpenGroup(null);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => groupBtnRefs.current[prev]?.focus());
    });
  };

  const handleLinkClick = () => {
    onNavigate?.();
  };

  const showSub = openGroup !== null;

  const subItems = PORTAL_ITEMS.filter((i) => !i.adminOnly || user.is_admin);
  const subLabel = 'Portal';
  const subId = 'rail-sub';

  if (!projectId) {
    // No project selected: Projects + Portal group
    return (
      <div className="rail-nav-wrap">
        <div className={cx('rail-panels', showSub && 'show-sub')} role="presentation">
          {/* Main panel */}
          <div className="rail-panel" inert={showSub ? true : undefined} aria-hidden={showSub ? true : undefined}>
            <nav className="rail-nav" aria-label="Pages">
              <a
                href="#/projects"
                className={cx('rail-link', route.tab === 'projects' && 'is-active')}
                aria-current={route.tab === 'projects' ? 'page' : undefined}
                onClick={handleLinkClick}
              >
                <Icon name="projects" />
                <span>Projects</span>
              </a>
              <button
                ref={(el) => { groupBtnRefs.current['portal'] = el; }}
                type="button"
                className={cx('rail-group-btn', PORTAL_ITEMS.some((i) => i.tab === route.tab) && 'has-active-child')}
                aria-haspopup="menu"
                aria-expanded={openGroup === 'portal'}
                aria-controls="rail-sub"
                onClick={() => openSub('portal')}
              >
                <Icon name="lock" />
                <span>Portal ›</span>
                <Icon name="chevronRight" size={14} className="rail-group-chevron" aria-hidden="true" />
              </button>
            </nav>
          </div>

          {/* Portal submenu */}
          <div className="rail-panel" inert={!showSub ? true : undefined} aria-hidden={!showSub ? true : undefined}>
            <nav
              id="rail-sub"
              className="rail-nav"
              aria-label="Portal settings"
            >
              <button
                ref={showSub ? backRef : null}
                type="button"
                className="rail-back-btn"
                onClick={closeSub}
              >
                <Icon name="chevronRight" size={14} className="icon-flip-h" aria-hidden="true" />
                Back
              </button>
              <div className="rail-sub-label" aria-hidden="true">Portal</div>
              {PORTAL_ITEMS.filter((i) => !i.adminOnly || user.is_admin).map((item) => {
                const linkHref = `#/${item.tab}`;
                const isActive = route.tab === item.tab && !route.projectId;
                return (
                  <a
                    key={item.tab}
                    href={linkHref}
                    className={cx('rail-link', isActive && 'is-active')}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={handleLinkClick}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                    {item.tab === 'inbox' && inboxCount > 0 ? (
                      <span className="rail-count" title={`${inboxCount} item${inboxCount === 1 ? '' : 's'} need your attention`}>{inboxCount}</span>
                    ) : null}
                  </a>
                );
              })}
            </nav>
          </div>
        </div>
      </div>
    );
  }

  // Project selected — wait for the project list to resolve before rendering links
  // that need current (e.g. open_questions badge). Use projectId (always from the
  // URL) as the href fallback so navigation still works before /api/projects loads.
  if (!current) {
    return <div className="rail-nav-wrap" />;
  }

  return (
    <div className="rail-nav-wrap">
      <div className={cx('rail-panels', showSub && 'show-sub')} role="presentation">
        {/* Main panel */}
        <div className="rail-panel" inert={showSub ? true : undefined} aria-hidden={showSub ? true : undefined}>
          <nav className="rail-nav" aria-label="Pages">
            {PROJECT_MAIN_ITEMS.map((item) => {
              if (item.group) {
                // Determine if any child of this group is active
                const childActive = PORTAL_ITEMS.some((c) => c.tab === route.tab) && !route.projectId;
                return (
                  <button
                    key={item.group}
                    ref={(el) => { groupBtnRefs.current[item.group] = el; }}
                    type="button"
                    className={cx('rail-group-btn', childActive && 'has-active-child')}
                    aria-haspopup="menu"
                    aria-expanded={openGroup === item.group}
                    aria-controls="rail-sub"
                    onClick={() => openSub(item.group)}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label} ›</span>
                    <Icon name="chevronRight" size={14} className="rail-group-chevron" aria-hidden="true" />
                  </button>
                );
              }

              // Regular link — use projectId (always available from route) so links
              // work before /api/projects resolves and current is still undefined.
              const linkHref = href(projectId, item.tab);
              const isActive = route.tab === item.tab;
              return (
                <a
                  key={item.tab}
                  href={linkHref}
                  className={cx('rail-link', isActive && 'is-active')}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={handleLinkClick}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {item.tab === 'knowledge' && current.open_questions ? (
                    <span className="rail-count" title="Open questions">{current.open_questions}</span>
                  ) : null}
                  {item.tab === 'sessions' && current.pending_approvals ? (
                    <span className="rail-count" title="Waiting for your permission">{current.pending_approvals}</span>
                  ) : null}
                </a>
              );
            })}
          </nav>
        </div>

        {/* Submenu panel — Portal only */}
        <div className="rail-panel" inert={!showSub ? true : undefined} aria-hidden={!showSub ? true : undefined}>
          <nav
            id={subId}
            className="rail-nav"
            aria-label={subLabel}
          >
            <button
              ref={showSub ? backRef : null}
              type="button"
              className="rail-back-btn"
              onClick={closeSub}
            >
              <Icon name="chevronRight" size={14} className="icon-flip-h" aria-hidden="true" />
              Back
            </button>
            <div className="rail-sub-label" aria-hidden="true">{subLabel}</div>
            {subItems.map((item) => {
              const linkHref = `#/${item.tab}`;
              const isActive = route.tab === item.tab && !route.projectId;
              return (
                <a
                  key={item.tab}
                  href={linkHref}
                  className={cx('rail-link', isActive && 'is-active')}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={handleLinkClick}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {item.tab === 'inbox' && inboxCount > 0 ? (
                    <span className="rail-count" title={`${inboxCount} item${inboxCount === 1 ? '' : 's'} need your attention`}>{inboxCount}</span>
                  ) : null}
                </a>
              );
            })}
          </nav>
        </div>
      </div>
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
    const close = stream('/api/inbox/events', {
      'inbox.count': (data) => setInboxCount(data.needs_you ?? 0),
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
  const current = projects?.find((p) => p.id === route.projectId);
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
          value={route.projectId || ''}
          onChange={(e) => (e.target.value ? go(e.target.value, route.projectId ? route.tab : 'knowledge') : go(null, 'projects'))}
        >
          <option value="">All projects</option>
          {(projects || []).filter((p) => !p.archived || p.id === route.projectId).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <NavMenu
        route={route}
        projectId={route.projectId}
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
      'builder.updated',
      'members.updated',
      'project.updated',
    ]) {
      handlers[ev] = (data) => {
        emitProjectEvent(ev, data);
        if (['input.created', 'input.resolved', 'members.updated', 'project.updated', 'document.updated'].includes(ev)) refreshSoon();
      };
    }
    const close = stream(`/api/projects/${projectId}/stream`, handlers);
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
    case 'learn':
      page = <Learn route={route} />;
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
    case 'repos':
      page = <Repos />;
      break;
    case 'workspaces':
      page = <Workspaces />;
      break;
    case 'config':
      page = <Configuration route={route} />;
      break;
    case 'builder':
      page = <Builder route={route} />;
      break;
    case 'team':
      page = <ProjectSettings />;
      break;
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
