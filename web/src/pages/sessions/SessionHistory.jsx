import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx, timeAgo } from '../../lib/util.js';
import { PushReviewLink } from './SessionChanges.jsx';

/* ---------------- History ---------------- */

export function History({ events, link, canEdit }) {
  const { project } = useProject();
  // Load repos lazily so we can resolve repo by name for older push events that lack repoId.
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const repoList = repos.data?.repos || [];

  if (!events.length) return <p className="muted small">Nothing yet.</p>;
  // "Iteration N started" is replaced by that iteration's result once there is one.
  const reported = new Set(events.filter((e) => e.kind === 'iteration' && e.data.state).map((e) => e.run_id));
  const shown = events.filter((e) => !(e.kind === 'iteration' && !e.data.state && !e.data.failed && reported.has(e.run_id) && /started$/.test(e.body)));
  return (
    <ol className="wf-history">
      {[...shown].reverse().map((e) => (
        <li key={e.id} className={cx('wf-event', `wf-${e.kind}`, e.kind === 'check' && (e.data.ok ? 'wf-pass' : 'wf-fail'))}>
          <span className="wf-when muted small">{timeAgo(e.created_at)}</span>
          {e.kind === 'human' ? (
            <div className="wf-body">
              <strong>{e.data.by || 'A teammate'} said</strong>
              <p>{e.body}</p>
              <span className="muted small">{e.consumed ? 'Read by the agents' : 'Waiting for the next step'}</span>
            </div>
          ) : e.kind === 'check' ? (
            <div className="wf-body">
              <strong>{e.body}</strong> <code className="small">{e.data.command}</code>
              {e.data.output ? (
                <details>
                  <summary className="small">Output</summary>
                  <pre className="prompt-box">{e.data.output}</pre>
                </details>
              ) : null}
            </div>
          ) : e.kind === 'push' ? (
            <div className="wf-body">
              <strong>{e.body}</strong>
              {(e.data.results || []).length > 1 || (e.data.results || []).some((r) => !r.ok || r.pr) ? (
                <ul className="plain-list small">
                  {e.data.results.map((r) => (
                    <li key={r.repo}>
                      {r.repo}: {r.ok ? (
                        <>
                          pushed <code>{(r.commit || '').slice(0, 10)}</code>
                          {r.pr ? (
                            <>
                              {' · '}
                              <a href={r.pr} target="_blank" rel="noreferrer">pull request</a>
                              {canEdit ? (
                                <>
                                  {' · '}
                                  <PushReviewLink
                                    pr={r.pr}
                                    repoId={r.repoId}
                                    prNumber={r.prNumber}
                                    repoName={r.repo}
                                    repoList={repoList}
                                    projectId={project.id}
                                    branch={e.data.branch}
                                  />
                                </>
                              ) : null}
                            </>
                          ) : canEdit ? (
                            <>
                              {' · '}
                              <PushReviewLink
                                repoId={r.repoId}
                                repoName={r.repo}
                                repoList={repoList}
                                projectId={project.id}
                                branch={e.data.branch}
                              />
                            </>
                          ) : null}
                        </>
                      ) : <span className="danger">{r.error}</span>}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : e.kind === 'iteration' ? (
            <div className="wf-body">
              {e.data.state ? (
                <strong>
                  Iteration {e.data.iteration}: {e.data.state === 'done' ? 'reports done' : e.data.state === 'blocked' ? 'blocked' : 'continues'}
                </strong>
              ) : null}
              <p>{e.body}</p>
              {e.data.next ? <p className="muted small">Next: {e.data.next}</p> : null}
              {e.run_id ? (
                <a className="small" href={link({ run: e.run_id })}>
                  See its agents
                </a>
              ) : null}
            </div>
          ) : (
            <div className="wf-body">
              <span>{e.body}</span>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
