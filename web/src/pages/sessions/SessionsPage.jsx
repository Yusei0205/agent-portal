import { useEffect, useState } from 'react';
import { useProject } from '../../lib/context.js';
import { go, href, sessionHref } from '../../lib/router.js';
import { RunView } from '../../components/run/RunViewer.jsx';
import { Empty } from '../../components/ui.jsx';
import { SessionList } from './SessionList.jsx';
import { SessionWorkspace } from './SessionWorkspace.jsx';
import { NewSessionDialog } from './NewSessionDialog.jsx';

/**
 * Sessions: the one place to start agent work and watch it.
 *   sessions                  list, nothing selected
 *   sessions/new?jiraKey=…    list with the New dialog open
 *   sessions/<workflowId>     one session (?tab=live|changes|history|settings, ?run=<runId>)
 *   sessions/run/<runId>      one single run (agent tests, ticket analyses, reviews, single runs)
 */
export function Sessions({ route }) {
  const { project, canEdit } = useProject();
  const [first, second] = route.rest;
  const isRun = first === 'run' && second;
  const isNew = first === 'new';
  const workflowId = first && !isRun && !isNew ? first : null;
  const [view, setView] = useState(isRun ? 'runs' : 'sessions');
  useEffect(() => {
    if (isRun) setView('runs');
    else if (workflowId) setView('sessions');
  }, [isRun, workflowId]);

  let detail;
  if (isRun) {
    detail = (
      <div className="ws-run">
        <RunView key={second} runId={second} />
      </div>
    );
  } else if (workflowId) {
    detail = <SessionWorkspace key={workflowId} id={workflowId} query={route.query} />;
  } else {
    detail = (
      <div className="pad-lg">
        <Empty
          icon="runs"
          title="Pick a session to follow it"
          action={
            canEdit ? (
              <a className="btn btn-primary" href={href(project.id, 'sessions', 'new')}>
                Start agent work
              </a>
            ) : null
          }
        >
          A session keeps working toward a goal on its own, run after run, and checks its own work. You see every agent it starts, review the changes and keep giving instructions.
        </Empty>
      </div>
    );
  }

  const prefill = isNew
    ? { jiraKey: route.query.get('jiraKey') || '', jiraUrl: route.query.get('jiraUrl') || '', jiraSummary: route.query.get('jiraSummary') || '', repoId: route.query.get('repoId') || '' }
    : null;

  return (
    <div className="ws-page">
      <SessionList selectedId={workflowId} selectedRunId={isRun ? second : null} view={view} onView={setView} />
      <section className="ws-main">{detail}</section>
      {isNew && canEdit ? <NewSessionDialog prefill={prefill} onClose={() => go(project.id, 'sessions')} /> : null}
    </div>
  );
}

/** Old #/p/<id>/runs/<runId> links: a session's run opens in its session, any other run as a single run. */
export function legacyRunTarget(projectId, rest, query, run) {
  if (!rest[0]) return href(projectId, 'sessions');
  if (rest[0] === 'new') return `${href(projectId, 'sessions', 'new')}${query.toString() ? `?${query}` : ''}`;
  if (run?.meta?.workflowId) return sessionHref(projectId, run.meta.workflowId, { run: run.id });
  return href(projectId, 'sessions', 'run', rest[0]);
}
