import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './lib/api.js';
import { useRoute, href, navigate, navigateReplace } from './lib/router.js';
import { Icon } from './components/Icon.jsx';
import { registerShortcuts, registerHandler, triggerShortcut, isEditingField } from './lib/shortcuts.js';
import { AppHeader } from './components/AppHeader.jsx';
import { CommandPalette } from './components/CommandPalette.jsx';
import { ShortcutsSheet } from './components/ShortcutsSheet.jsx';
import { getTemplate, getActiveTemplateId, fetchAndApplyTheme } from './lib/theme.js';
import { subscribeGlobal } from './lib/events.js';
import { Rail, DEFAULT_RAIL_W, MIN_RAIL_W, MAX_RAIL_W } from './components/Rail.jsx';
import { Login, AcceptInvite } from './pages/Auth.jsx';
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
import ReviewDetail from './pages/ReviewDetail.jsx';
import LoopSpecs from './pages/LoopSpecs.jsx';
import { Workspaces } from './pages/Workspaces.jsx';
import { ApiAccess } from './pages/ApiAccess.jsx';
import { Integrations } from './pages/Integrations.jsx';
import { Credentials } from './pages/Credentials.jsx';
import { Configuration } from './pages/Configuration.jsx';
import { ConnectionsPage } from './pages/ConnectionsPage.jsx';
import { ReviewsPage } from './pages/ReviewsPage.jsx';
import { TestsPage } from './pages/tests/TestsPage.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { Tickets } from './pages/Tickets.jsx';

// ── Shortcut definitions (registered once at module load) ─────────────────────

registerShortcuts([
  // Global
  { id: 'cmd_palette',        keys: 'Ctrl K',       label: 'Command palette',       description: 'Search pages and actions',    group: 'Global'   },
  { id: 'shortcuts_sheet',    keys: '?',            label: 'Keyboard shortcuts',    description: 'Show all key bindings',       group: 'Global'   },
  // Navigate — project context
  { id: 'goto_sessions',      keys: 'g s',          label: 'Go to Sessions',        group: 'Navigate' },
  { id: 'goto_workspaces',    keys: 'g w',          label: 'Go to Workspaces',      group: 'Navigate' },
  { id: 'goto_reviews',       keys: 'g r',          label: 'Go to Reviews',         group: 'Navigate' },
  { id: 'goto_knowledge',     keys: 'g k',          label: 'Go to Knowledge',       group: 'Navigate' },
  { id: 'goto_vault_proj',    keys: 'g v',          label: 'Go to Vault',           group: 'Navigate' },
  { id: 'goto_insights',      keys: 'g l',          label: 'Go to Insights',        group: 'Navigate' },
  { id: 'goto_create',        keys: 'g c',          label: 'Go to Create',          group: 'Navigate' },
  { id: 'goto_integrations_p',keys: 'g i',          label: 'Go to Integrations',    group: 'Navigate' },
  { id: 'goto_tests',         keys: 'g h',          label: 'Go to Tests',           group: 'Navigate' },
  // Navigate — portal (always available)
  { id: 'goto_projects',      keys: 'g p',          label: 'Go to Projects',        group: 'Navigate' },
  { id: 'goto_inbox',         keys: 'g b',          label: 'Go to Inbox',           group: 'Navigate' },
  { id: 'goto_connections',   keys: 'g n',          label: 'Go to Connections',     group: 'Navigate' },
  { id: 'goto_integrations',  keys: 'g j',          label: 'Go to Integrations',    group: 'Navigate' },
  { id: 'goto_api',           keys: 'g e',          label: 'Go to API access',      group: 'Navigate' },
  { id: 'goto_users',         keys: 'g m',          label: 'Go to Users',           group: 'Navigate' },
  { id: 'goto_settings',      keys: 'g t',          label: 'Go to Settings',        group: 'Navigate' },
  { id: 'goto_credentials',   keys: 'g y',          label: 'Go to Credentials',     group: 'Navigate' },
  { id: 'goto_config',        keys: 'g x',          label: 'Go to Configuration',   group: 'Navigate' },
  { id: 'goto_dashboard',     keys: 'g d',          label: 'Go to Dashboard',        group: 'Navigate' },
]);

// Navigation is defined in Rail.jsx (NAV_SECTIONS).

// ── Shell ─────────────────────────────────────────────────────────────────────

function Placeholder({ tab }) {
  // Capitalise first letter and replace hyphens with spaces as a fallback label
  const label = tab ? tab.charAt(0).toUpperCase() + tab.slice(1).replace(/-/g, ' ') : 'Page';
  return (
    <div className="page">
      <h1>{label}</h1>
      <p className="muted">Coming soon.</p>
    </div>
  );
}


// Rail component lives in web/src/components/Rail.jsx

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
  // Rail width (expanded mode) — persisted in localStorage
  const [railWidth, setRailWidth] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem('rail-w') || '', 10);
      return isNaN(v) ? DEFAULT_RAIL_W : Math.min(MAX_RAIL_W, Math.max(MIN_RAIL_W, v));
    } catch {
      return DEFAULT_RAIL_W;
    }
  });
  const [paletteOpen, setPaletteOpen]   = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const inboxPollRef = useRef(null);
  // Ticket pre-fill for New Session dialog — set when user clicks
  // "Start session with this ticket" on the Tickets page.
  const [newSessionTicket, setNewSessionTicket] = useState(null);

  // Refs to keep key handler stale-closure-free
  const routeRef         = useRef(route);
  const userRef          = useRef(user);
  const paletteOpenRef   = useRef(paletteOpen);
  const shortcutsOpenRef = useRef(shortcutsOpen);
  const navOpenRef       = useRef(navOpen);
  routeRef.current         = route;
  userRef.current          = user;
  paletteOpenRef.current   = paletteOpen;
  shortcutsOpenRef.current = shortcutsOpen;
  navOpenRef.current       = navOpen;

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

  // Subscribe to portal-level SSE — live theme refresh
  useEffect(() => {
    const unsub = subscribeGlobal((event) => {
      if (event?.type === 'theme.changed') {
        fetchAndApplyTheme();
      }
    });
    return unsub;
  }, []);

  // Sync browser tab title and favicon with active template brand
  useEffect(() => {
    const onThemeChanged = () => {
      const tmpl = getTemplate(getActiveTemplateId());
      const productName = tmpl?.brand?.productName;
      if (productName) {
        document.title = productName;
      }
      // Update favicon using faviconSvg (or logoSvg) from the template
      const svgSrc = tmpl?.brand?.faviconSvg || tmpl?.brand?.logoSvg;
      if (svgSrc) {
        const link = document.querySelector("link[rel='icon']");
        if (link) link.href = `data:image/svg+xml,${encodeURIComponent(svgSrc)}`;
      }
    };
    onThemeChanged(); // Run once on mount
    document.addEventListener('portal-theme-changed', onThemeChanged);
    return () => document.removeEventListener('portal-theme-changed', onThemeChanged);
  }, []);

  useEffect(() => {
    setNavOpen(false);
  }, [route.tab, route.projectId]);

  // ── Sign-out (shared by Rail and AppHeader) ───────────────────────────────
  const handleSignOut = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* best effort */ }
    onSignOut();
  }, [onSignOut]);

  // ── New session with pre-filled ticket (from Tickets page) ────────────────
  const handleNewSession = useCallback((ticket) => {
    setNewSessionTicket(ticket);
    navigate(`/p/${routeRef.current.projectId}/sessions`);
  }, []);

  // ── Shortcut handlers ─────────────────────────────────────────────────────
  useEffect(() => {
    const unPalette   = registerHandler('cmd_palette',     () => setPaletteOpen(true));
    const unShortcuts = registerHandler('shortcuts_sheet', () => setShortcutsOpen(true));
    return () => { unPalette(); unShortcuts(); };
  }, []);

  // ── Global keyboard handler ───────────────────────────────────────────────
  useEffect(() => {
    let firstKey     = null;
    let firstKeyTime = 0;
    const G_TIMEOUT  = 1500; // ms — window for second key of a sequence

    const onKeyDown = (e) => {
      // Never intercept while typing in a field
      if (isEditingField(e.target)) return;

      // Esc always closes open overlays from anywhere on the page,
      // even if focus is outside the dialog (e.g. on .shell).
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey) {
        if (paletteOpenRef.current)   { setPaletteOpen(false);   return; }
        if (shortcutsOpenRef.current) { setShortcutsOpen(false); return; }
        // Close mobile nav drawer
        if (navOpenRef.current) { setNavOpen(false); return; }
      }

      // Let the palette / shortcuts dialogs handle their own keys
      if (paletteOpenRef.current || shortcutsOpenRef.current) return;

      // Suppress global shortcuts while any modal dialog is open (but still
      // let Esc bubble above so we can close dialogs with the g+key handler
      // doesn't accidentally fire while a dialog is in view).
      const hasOpenDialog = Boolean(
        document.querySelector('[role="dialog"][aria-modal="true"]'),
      );
      if (hasOpenDialog) return;

      const key = e.key.toLowerCase();
      const now = Date.now();

      // Ctrl+K / Cmd+K → open command palette
      if ((e.ctrlKey || e.metaKey) && key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setPaletteOpen(true);
        firstKey = null;
        return;
      }

      // Workspace shortcuts — route through the registry so IDE components
      // only need to registerHandler (no duplicate raw listeners anywhere)
      if (e.ctrlKey || e.metaKey) {
        if (key === 's' && !e.shiftKey && !e.altKey) {
          e.preventDefault(); triggerShortcut('ws_save'); return;
        }
        if (key === '`' && !e.shiftKey && !e.altKey) {
          e.preventDefault(); triggerShortcut('ws_term'); return;
        }
        if (e.shiftKey && e.key === 'E' && !e.altKey) {
          e.preventDefault(); triggerShortcut('ws_explore'); return;
        }
        if (e.shiftKey && e.key === 'G' && !e.altKey) {
          e.preventDefault(); triggerShortcut('ws_source'); return;
        }
      }

      // ? → open shortcuts sheet
      // Match e.key==='?' directly (produced by Shift+/ on US layout) or the
      // Shift+/ combination for non-US / headless layouts where e.key may be '/'.
      if ((e.key === '?' || (e.shiftKey && e.key === '/')) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShortcutsOpen(true);
        firstKey = null;
        return;
      }

      // Begin two-key sequence: g + <letter>
      if (key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        firstKey     = 'g';
        firstKeyTime = now;
        return;
      }

      // Resolve two-key sequence
      if (firstKey === 'g' && now - firstKeyTime < G_TIMEOUT && !e.ctrlKey && !e.metaKey && !e.altKey) {
        firstKey = null;
        const pid = routeRef.current.projectId;
        const u   = userRef.current;
        switch (key) {
          case 's': navigate(pid ? `/p/${pid}/sessions`      : '/projects');      break;
          case 'w': navigate(pid ? `/p/${pid}/workspaces`    : '/projects');      break;
          case 'r': if (pid) navigate(`/p/${pid}/reviews/code`);                  break;
          case 'k': if (pid) navigate(`/p/${pid}/knowledge`);                     break;
          case 'v': navigate(pid ? `/p/${pid}/vault`         : '/projects');      break;
          case 'l': if (pid) navigate(`/p/${pid}/insights`);                      break;
          case 'c': if (pid) navigate(`/p/${pid}/create`);                        break;
          case 'i': navigate(pid ? `/p/${pid}/integrations` : '/integrations');  break;
          case 'h': if (pid) navigate(`/p/${pid}/tests`);                         break;
          case 'p': navigate('/projects');                                         break;
          case 'b': navigate('/inbox');                                            break;
          case 'n': navigate('/connections/git');                                  break;
          case 'j': navigate('/integrations');                                     break;
          case 'e': navigate('/api');                                              break;
          case 'm': if (u?.is_admin) navigate('/users');                          break;
          case 't': navigate('/settings');                                         break;
          case 'y': navigate('/credentials');                                      break;
          case 'x': navigate('/config');                                           break;
          case 'd': navigate('/dashboard');                                        break;
          default:  break;
        }
        return;
      }

      firstKey = null;
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []); // empty — refs keep values current

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

  // Handle rail width change from separator drag / keyboard
  const handleRailWidthChange = useCallback((w, persist) => {
    setRailWidth(w);
    document.documentElement.style.setProperty('--rail-w', `${w}px`);
    if (persist) {
      try { localStorage.setItem('rail-w', String(w)); } catch {}
    }
  }, []);

  // Apply persisted rail width on mount
  useEffect(() => {
    document.documentElement.style.setProperty('--rail-w', `${railWidth}px`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── URL redirects for old routes ─────────────────────────────────────────
  // All redirects use navigateReplace so they replace the history entry,
  // preventing a back-button loop where the user can never escape the old URL.
  useEffect(() => {
    const { tab, projectId, rest } = route;

    // /aws (removed page) → /connections/git
    if (!projectId && tab === 'aws') {
      navigateReplace('/connections/git');
      return;
    }
    // /connections (bare, no sub-tab) → /connections/git
    if (!projectId && tab === 'connections' && (!rest || rest.length === 0)) {
      navigateReplace('/connections/git');
      return;
    }
    // /reviews (old portal-level dashboard, no project) → last project's reviews or projects
    if (!projectId && tab === 'reviews') {
      let lastPid = '';
      try { lastPid = localStorage.getItem('rail-last-project') || ''; } catch { /* */ }
      if (lastPid) {
        navigateReplace(`/p/${lastPid}/reviews/dashboard`);
      } else {
        navigateReplace('/projects');
      }
      return;
    }
    // /admin → /users
    if (!projectId && tab === 'admin') {
      navigateReplace('/users');
      return;
    }
    // /p/:pid/review (list) → /p/:pid/reviews/code (preserve query params)
    if (projectId && tab === 'review' && (!rest || rest.length === 0)) {
      const qs = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : '';
      navigateReplace(`/p/${projectId}/reviews/code${qs ? `?${qs}` : ''}`);
      return;
    }
    // /p/:pid/review/:id → /p/:pid/reviews/code/:id
    if (projectId && tab === 'review' && rest && rest.length > 0) {
      navigateReplace(`/p/${projectId}/reviews/code/${rest[0]}`);
      return;
    }
    // /p/:pid/branchscans (list) → /p/:pid/reviews/branch-scans
    if (projectId && tab === 'branchscans' && (!rest || rest.length === 0)) {
      navigateReplace(`/p/${projectId}/reviews/branch-scans`);
      return;
    }
    // /p/:pid/branchscans/:id → /p/:pid/reviews/branch-scans/:id
    if (projectId && tab === 'branchscans' && rest && rest.length > 0) {
      navigateReplace(`/p/${projectId}/reviews/branch-scans/${rest[0]}`);
      return;
    }
    // /projects/:pid/tickets (OAuth callback) → /p/:pid/tickets (preserve query string)
    if (!projectId && tab === 'projects' && rest && rest.length >= 2 && rest[1] === 'tickets') {
      const rawHash = window.location.hash;
      const qs = rawHash.includes('?') ? rawHash.slice(rawHash.indexOf('?')) : '';
      navigateReplace(`/p/${encodeURIComponent(rest[0])}/tickets${qs}`);
      return;
    }
  }, [route]);

  // Resolve project object for pages that need it
  const currentProject = projects?.find((p) => p.id === route.projectId) ?? null;

  // navProjectId — the "currently selected" project for portal-scoped pages
  // (mirrors Rail's logic: prefer route.projectId, fall back to localStorage)
  const navProjectId = route.projectId || (() => {
    try { return localStorage.getItem('rail-last-project') || ''; } catch { return ''; }
  })();

  // Decide what to render in the main area
  const isSessionsRoute   = route.projectId && route.tab === 'sessions';
  const isProjectsRoute   = !route.projectId && route.tab === 'projects';
  const isDashboardRoute  = !route.projectId && route.tab === 'dashboard';
  const isSetupRoute      = route.projectId && route.tab === 'setup';
  const isSettingsRoute   = !route.projectId && route.tab === 'settings';
  const isInboxRoute      = !route.projectId && route.tab === 'inbox';
  const isCreateRoute     = route.projectId && route.tab === 'create';
  const isKnowledgeRoute  = route.projectId && route.tab === 'knowledge';
  const isVaultRoute      = route.projectId && route.tab === 'vault';
  const isInsightsRoute   = route.tab === 'insights';
  const isUsersRoute      = !route.projectId && route.tab === 'users';
  const isLoopSpecsRoute  = route.projectId && route.tab === 'loop-specs';
  const isWorkspacesRoute = route.projectId && route.tab === 'workspaces';
  const isApiRoute        = !route.projectId && route.tab === 'api';
  const isConnectionsRoute = !route.projectId && route.tab === 'connections' && route.rest?.length > 0;
  const isIntegrationsRoute = route.tab === 'integrations';
  const isCredentialsRoute = !route.projectId && route.tab === 'credentials';
  const isConfigRoute      = !route.projectId && route.tab === 'config';
  const isTestsRoute       = route.projectId && route.tab === 'tests';
  const isReviewsRoute     = route.projectId && route.tab === 'reviews';
  const isTicketsRoute     = route.projectId && route.tab === 'tickets';

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
        onSignOut={handleSignOut}
        onNavigate={() => setNavOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        railWidth={railWidth}
        onRailWidthChange={handleRailWidthChange}
      />

      {/* Mobile drawer backdrop */}
      {navOpen && (
        <div
          className="drawer-backdrop"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') setNavOpen(false); }}
        />
      )}

      {/* Right column: topbar (mobile) + app header + main */}
      <div className="shell-right">
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
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
            <button
              type="button"
              className="btn-icon"
              aria-label="Command palette"
              onClick={() => setPaletteOpen(true)}
            >
              <Icon name="search" size={16} />
            </button>
          </div>
        </div>

        {/* App header — breadcrumb, palette trigger, theme, account */}
        <AppHeader
          route={route}
          user={user}
          projects={projects}
          inboxCount={inboxCount}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onSignOut={handleSignOut}
        />

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
              initialDialogTicket={newSessionTicket}
              onInitialDialogConsumed={() => setNewSessionTicket(null)}
            />
          ) : isProjectsRoute ? (
            <Projects user={user} onProjectsChange={loadProjects} />
          ) : isDashboardRoute ? (
            <Dashboard user={user} projects={projects} />
          ) : isSetupRoute ? (
            <ProjectHub projectId={route.projectId} user={user} initialTab={route.rest?.[0]} />
          ) : isSettingsRoute ? (
            <Settings user={user} />
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
          ) : isUsersRoute ? (
            <AdminPanel user={user} />
          ) : isLoopSpecsRoute ? (
            <LoopSpecs projectId={route.projectId} />
          ) : isWorkspacesRoute ? (
            <Workspaces projectId={route.projectId} />
          ) : isApiRoute ? (
            <ApiAccess />
          ) : isConnectionsRoute ? (
            <ConnectionsPage subTab={route.rest?.[0] || 'git'} user={user} projectId={navProjectId} projects={projects} />
          ) : isIntegrationsRoute ? (
            <Integrations projectId={route.projectId} />
          ) : isCredentialsRoute ? (
            <Credentials user={user} />
          ) : isConfigRoute ? (
            <Configuration user={user} />
          ) : isTestsRoute ? (
            <TestsPage projectId={route.projectId} route={route} />
          ) : isReviewsRoute ? (
            <ReviewsPage projectId={route.projectId} route={route} user={user} />
          ) : isTicketsRoute ? (
            <Tickets projectId={route.projectId} route={route} onNewSession={handleNewSession} />
          ) : (
            <Placeholder tab={route.tab} />
          )}
        </main>
      </div>

      {/* Global overlays */}
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenShortcuts={() => { setPaletteOpen(false); setShortcutsOpen(true); }}
        route={route}
        user={user}
      />
      <ShortcutsSheet
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
    </div>
  );
}

// ── App root ─────────────────────────────────────────────────────────────────

export function App() {
  const [auth, setAuth] = useState({ loading: true });

  const load = useCallback(async () => {
    try {
      const s = await api.get('/api/auth/state');
      setAuth({ loading: false, needsSetup: s.needsSetup, user: s.user, googleEnabled: Boolean(s.googleEnabled) });
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
    if (window.location.hash.startsWith('#/accept-invite')) {
      return <AcceptInvite onDone={() => { window.location.hash = '#/'; load(); }} />;
    }
    return <Login onDone={load} googleEnabled={auth.googleEnabled} />;
  }

  return <Shell user={auth.user} onSignOut={load} />;
}