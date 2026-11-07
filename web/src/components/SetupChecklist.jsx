/**
 * "Get started": the five things that have to be true before the first session, each marked done or not, in the order
 * to do them, with a link to the place that does it. Shown on the Projects page until everything is done or it is hidden.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './Icon.jsx';

const HIDE_KEY = 'setup-checklist-hidden';
const read = () => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } };

/** Which steps are done, from what the portal already knows. `project` is the project the later steps are checked in. */
export async function loadSetupState(project) {
  const [creds, settings, git] = await Promise.all([
    api.get('/api/credentials/summary').catch(() => ({ summary: [] })),
    api.get('/api/settings').catch(() => ({})),
    api.get('/api/git-connections').catch(() => ({ connections: [] })),
  ]);
  const summary = creds.summary || [];
  const ownSignIn = summary.some((e) => (e.credentials || []).length > 0 || (e.engine === 'codex' && e.configured));
  const portalProvider = (settings.provider?.mode || 'demo') !== 'demo';
  const [repos, workflows] = project
    ? await Promise.all([
      api.get(`/api/projects/${project.id}/repos`).catch(() => ({ repos: [] })),
      api.get(`/api/projects/${project.id}/workflows?limit=1`).catch(() => ({ workflows: [] })),
    ])
    : [{ repos: [] }, { workflows: [] }];
  return {
    ai: ownSignIn || portalProvider,
    project: Boolean(project),
    git: (git.connections || []).length > 0,
    repo: (repos.repos || []).length > 0,
    session: (workflows.workflows || []).length > 0,
  };
}

/** The engines a person can sign in to; each opens the Sign-ins page at that engine. */
export const ENGINE_CHOICES = [
  { id: 'claude-code', label: 'Claude Code', href: '#/config/sign-ins?engine=claude-code' },
  { id: 'kiro', label: 'Kiro', href: '#/config/sign-ins?engine=kiro' },
  { id: 'codex', label: 'Codex', href: '#/config/sign-ins?engine=codex' },
];

export function setupSteps(project) {
  const p = project ? `#/p/${project.id}` : null;
  return [
    { id: 'ai', title: 'Sign in to an AI engine', hint: 'Choose the engine you will use, or ask an admin to set the portal AI provider for everyone.', href: null, action: '', engines: ENGINE_CHOICES },
    { id: 'project', title: 'Create a project', hint: 'A project keeps its repositories, sessions and knowledge together.', href: null, action: 'New project' },
    { id: 'git', title: 'Connect your Git host', hint: 'So the portal can clone your repositories and open pull requests.', href: '#/connect/git', action: 'Connect' },
    { id: 'repo', title: 'Add a repository', hint: 'Pick the repository the agent works on.', href: p ? `${p}/workspaces/repositories` : null, action: 'Add repository' },
    { id: 'session', title: 'Start your first session', hint: 'Describe the outcome you want. The agent starts and you follow it live.', href: p ? `${p}/sessions` : null, action: 'Open sessions' },
  ];
}

export function SetupChecklist({ project, onNewProject }) {
  const [state, setState] = useState(null);
  const [hidden, setHidden] = useState(read);
  useEffect(() => {
    let alive = true;
    loadSetupState(project).then((s) => { if (alive) setState(s); }).catch(() => {});
    return () => { alive = false; };
  }, [project?.id]);
  if (hidden || !state) return null;
  const hide = () => { try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* private mode */ } setHidden(true); };
  return <SetupChecklistView project={project} state={state} onNewProject={onNewProject} onHide={hide} />;
}

/** The checklist for a known state; nothing once every step is done. */
export function SetupChecklistView({ project, state, onNewProject, onHide }) {
  const steps = setupSteps(project);
  const done = steps.filter((s) => state[s.id]).length;
  if (done === steps.length) return null;
  const nextId = steps.find((s) => !state[s.id])?.id;
  const hide = onHide;

  return (
    <section className="card setup-checklist" aria-label="Get started" style={{ padding: 16, marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Get started <span className="muted" style={{ fontWeight: 400 }}>{done} of {steps.length} done</span></h2>
        <button type="button" className="btn btn-sm btn-ghost" onClick={hide}>Hide</button>
      </div>
      <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 10 }}>
        {steps.map((s) => {
          const ok = Boolean(state[s.id]);
          const primary = s.id === nextId ? ' btn-primary' : '';
          return (
            <li key={s.id} data-step={s.id} data-done={ok ? 'true' : 'false'} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', opacity: ok ? 0.7 : 1 }}>
              <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: '50%', flex: '0 0 20px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid var(--line, currentColor)', background: ok ? 'var(--accent)' : 'transparent', color: ok ? '#fff' : 'transparent' }}>
                <Icon name="check" size={12} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{s.title}{ok ? ' (done)' : ''}</div>
                {!ok && <div className="muted small">{s.hint}</div>}
              </div>
              {!ok && s.engines && (
                <span className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }} role="group" aria-label="Choose an AI engine">
                  {s.engines.map((e) => (
                    <a key={e.id} className={`btn btn-sm${primary}`} href={e.href}>{e.label}</a>
                  ))}
                </span>
              )}
              {!ok && !s.engines && (s.id === 'project'
                ? <button type="button" className={`btn btn-sm${primary}`} onClick={onNewProject}>{s.action}</button>
                : s.href
                  ? <a className={`btn btn-sm${primary}`} href={s.href}>{s.action}</a>
                  : <span className="muted small">Create a project first</span>)}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default SetupChecklist;
