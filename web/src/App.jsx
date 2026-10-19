import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppContext, ProjectContext, useApp } from './lib/context.js';
import { api, setUnauthorizedHandler, stream } from './lib/api.js';
import { emitProjectEvent } from './lib/events.js';
import { go, href, useRoute } from './lib/router.js';
import { cx, money } from './lib/util.js';
import { Icon } from './components/Icon.jsx';
import { Badge, Spinner, UiProvider } from './components/ui.jsx';
import { Login, Setup } from './pages/Auth.jsx';
import { Projects } from './pages/Projects.jsx';
import { ProjectSettings } from './pages/ProjectSettings.jsx';
import { Knowledge } from './pages/Knowledge.jsx';
import { Learn } from './pages/Learn.jsx';
import { Runs } from './pages/Runs.jsx';
import { Review } from './pages/Review.jsx';
import { Repos } from './pages/Repos.jsx';
import { Builder } from './pages/Builder.jsx';
import { Settings } from './pages/Settings.jsx';
import { Account } from './pages/Account.jsx';


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

  let body;
  if (auth.loading) body = <div className="splash"><Spinner /></div>;
  else if (auth.error) body = <div className="splash"><p>{auth.error.message}</p></div>;
  else if (auth.needsSetup) body = <Setup onDone={load} />;
  else if (!auth.user) body = <Login onDone={load} />;
  else body = <Shell user={auth.user} onSignOut={load} />;
  return <UiProvider>{body}</UiProvider>;
}

const PROJECT_NAV = [
  { tab: 'knowledge', label: 'Knowledge', icon: 'knowledge' },
  { tab: 'learn', label: 'Learn', icon: 'learn' },
  { tab: 'runs', label: 'Agent runs', icon: 'runs' },
  { tab: 'review', label: 'Code review', icon: 'review' },
  { tab: 'repos', label: 'Repositories', icon: 'repos' },
  { tab: 'builder', label: 'Agents and skills', icon: 'builder' },
  { tab: 'team', label: 'Project and team', icon: 'user' },
];

function Shell({ user, onSignOut }) {
  const route = useRoute();
  const [projects, setProjects] = useState(null);
  const [meta, setMeta] = useState({ provider: 'demo', prices: null, models: [] });
  const [spend, setSpend] = useState(null);
  const [navOpen, setNavOpen] = useState(false);

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

  const ctx = useMemo(() => ({ user, projects, reloadProjects: loadProjects, meta, reloadMeta: loadMeta }), [user, projects, loadProjects, meta, loadMeta]);

  return (
    <AppContext.Provider value={ctx}>
      <div className={cx('shell', navOpen && 'nav-open')}>
        <a className="skip" href="#main">Skip to content</a>
        <Rail route={route} user={user} projects={projects} meta={meta} spend={spend} onSignOut={onSignOut} />
        <div className="topbar">
          <button className="icon-btn" aria-label="Menu" onClick={() => setNavOpen((v) => !v)}>
            <Icon name="menu" />
          </button>
          <span className="topbar-title">Agent Portal</span>
        </div>
        <main id="main" className="main" tabIndex={-1}>
          {route.projectId ? (
            <ProjectScope key={route.projectId} projectId={route.projectId} route={route} />
          ) : route.tab === 'settings' ? (
            <Settings />
          ) : route.tab === 'account' ? (
            <Account />
          ) : (
            <Projects />
          )}
        </main>
      </div>
    </AppContext.Provider>
  );
}

function Rail({ route, user, projects, meta, spend, onSignOut }) {
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
      <nav className="rail-nav">
        {current ? (
          PROJECT_NAV.map((n) => (
            <a key={n.tab} href={href(current.id, n.tab)} className={cx('rail-link', route.tab === n.tab && 'is-active')} aria-current={route.tab === n.tab ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
              {n.tab === 'knowledge' && current.open_questions ? (
                <span className="rail-count" title="Open questions">
                  {current.open_questions}
                </span>
              ) : null}
            </a>
          ))
        ) : (
          <a href="#/projects" className={cx('rail-link', route.tab === 'projects' && 'is-active')}>
            <Icon name="projects" />
            <span>Projects</span>
          </a>
        )}
      </nav>
      <div className="rail-foot">
        {user.is_admin ? (
          <a href="#/settings" className={cx('rail-link', route.tab === 'settings' && 'is-active')}>
            <Icon name="settings" />
            <span>Settings</span>
          </a>
        ) : null}
        <div className="rail-status">
          <Badge tone={meta.provider === 'demo' ? 'warn' : 'accent'}>{meta.provider === 'demo' ? 'Demo mode' : meta.provider === 'bedrock' ? 'Amazon Bedrock' : 'Anthropic API'}</Badge>
          {spend !== null && meta.provider !== 'demo' ? <span className="muted small">{money(spend, 2)} this month</span> : null}
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
      'input.created',
      'input.resolved',
      'document.updated',
      'document.deleted',
      'repo.updated',
      'repo.deleted',
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
    case 'runs':
      page = <Runs route={route} />;
      break;
    case 'review':
      page = <Review route={route} />;
      break;
    case 'repos':
      page = <Repos />;
      break;
    case 'builder':
      page = <Builder route={route} />;
      break;
    case 'team':
      page = <ProjectSettings />;
      break;
    default:
      page = <Knowledge route={route} />;
  }
  return <ProjectContext.Provider value={value}>{page}</ProjectContext.Provider>;
}
