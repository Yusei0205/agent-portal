import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useLoad } from '../../lib/useAsync.js';
import { Icon } from '../Icon.jsx';
import { Button, ErrorNote, Field, Modal, Toggle, useUi } from '../ui.jsx';

/**
 * Commit a run's working copies to a new branch and optionally open draft pull requests. A run on several
 * repositories pushes the same branch name to each repository that is ticked, one after the other.
 */
export function PushDialog({ run, onClose }) {
  const { toast } = useUi();
  const meta = run.meta || {};
  const jiraKey = meta.jiraKey;
  const jiraSummary = meta.jiraSummary;
  const multi = Array.isArray(meta.repos) && meta.repos.length > 1;
  const targets = multi ? meta.repos : [{ repoId: run.repo_id, name: '', branch: run.branch }];

  // Build Jira-aware defaults (mirrors server logic)
  const defaultBranch = meta.workBranch
    ? meta.workBranch
    : jiraKey
    ? `agent/${jiraKey.toLowerCase()}-${(jiraSummary || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`
    : `agent/${run.id.slice(2, 12).toLowerCase()}`;
  const defaultMessage = jiraKey ? `${jiraKey}: ${jiraSummary || run.title}` : `Agent Portal: ${run.title}`;

  const [branch, setBranch] = useState(defaultBranch);
  const [message, setMessage] = useState(defaultMessage);
  const [createPr, setCreatePr] = useState(false);
  const [prBase, setPrBase] = useState(run.branch || '');
  const branchList = useLoad(() => (run.repo_id && !multi ? api.get(`/api/repos/${run.repo_id}/branches`) : Promise.resolve(null)), [run.repo_id, multi]);
  const [prTitle, setPrTitle] = useState(jiraKey ? `${jiraKey}: ${jiraSummary || run.title}` : run.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const repo = useLoad(() => (run.repo_id ? api.get(`/api/projects/${run.project_id}/repos`) : Promise.resolve(null)), [run.repo_id]);
  const providerOf = (id) => repo.data?.repos.find((r) => r.id === id)?.provider;

  // Several repositories: tick the ones with changes; untouched ones have nothing to push.
  const changes = useLoad(() => (multi ? api.get(`/api/runs/${run.id}/changes`) : Promise.resolve(null)), [run.id, multi]);
  const [picked, setPicked] = useState(() => new Set(targets.map((t) => t.repoId)));
  useEffect(() => {
    if (changes.data?.repos) setPicked(new Set(changes.data.repos.filter((r) => r.changed > 0).map((r) => r.repoId)));
  }, [changes.data]);
  const changedOf = (id) => changes.data?.repos?.find((r) => r.repoId === id)?.changed;
  const chosen = targets.filter((t) => picked.has(t.repoId));
  const isGithub = chosen.some((t) => providerOf(t.repoId) === 'github');

  const push = async () => {
    setBusy(true);
    setError(null);
    const results = [];
    for (const t of chosen) {
      try {
        const body = { branch, message, createPr: createPr && providerOf(t.repoId) === 'github' };
        if (multi) body.repoId = t.repoId;
        if (body.createPr) {
          body.prTitle = prTitle;
          // One repository: the pull request goes where you choose. Several: each into its own starting branch.
          if (!multi && prBase) body.base = prBase;
        }
        results.push({ ...(await api.post(`/api/runs/${run.id}/push`, body)), name: t.name });
      } catch (e) {
        results.push({ name: t.name, error: e.message });
      }
    }
    setBusy(false);
    if (!multi && results[0]?.error) return setError(new Error(results[0].error));
    setDone(results);
    const ok = results.filter((r) => !r.error).length;
    toast(ok === results.length ? `Pushed to ${branch}` : `Pushed ${ok} of ${results.length} repositories`, ok === results.length ? 'ok' : 'danger');
  };

  return (
    <Modal
      title="Push the run's changes"
      onClose={onClose}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={!chosen.length} onClick={push}>
              {multi ? `Commit and push ${chosen.length} ${chosen.length === 1 ? 'repository' : 'repositories'}` : 'Commit and push'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <ul className="push-results">
          {done.map((r, i) => (
            <li key={i} className={r.error ? 'danger' : undefined}>
              <Icon name={r.error ? 'x' : 'check'} size={14} />
              <span>
                {multi ? <strong>{r.name}: </strong> : null}
                {r.error ? (
                  r.error
                ) : (
                  <>
                    Pushed commit <code>{r.commit?.slice(0, 10)}</code> to <code>{r.branch}</code>.
                    {r.pr ? (
                      <>
                        {' '}
                        Draft pull request:{' '}
                        <a href={r.pr.url} target="_blank" rel="noreferrer">
                          #{r.pr.number}
                        </a>
                      </>
                    ) : null}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="stack">
          <p className="muted">
            {multi
              ? 'The changes in each ticked repository are committed and pushed to the same new branch name. No starting branch is ever pushed to.'
              : "All changes in the run's working copy are committed and pushed to a new branch. The default branch is never pushed to."}
          </p>
          {jiraKey ? (
            <div className="row tight wrap jira-bar small" style={{ marginBottom: 4 }}>
              <a href={meta.jiraUrl} target="_blank" rel="noopener noreferrer" className="badge badge-accent">
                Jira {jiraKey} <Icon name="external" size={12} />
              </a>
              <span className="muted">{jiraSummary}</span>
            </div>
          ) : null}
          {multi ? (
            <fieldset className="push-repos">
              <legend className="field-label">Repositories</legend>
              {targets.map((t) => {
                const n = changedOf(t.repoId);
                return (
                  <label key={t.repoId} className="choice">
                    <input
                      type="checkbox"
                      checked={picked.has(t.repoId)}
                      onChange={(e) =>
                        setPicked((p) => {
                          const next = new Set(p);
                          e.target.checked ? next.add(t.repoId) : next.delete(t.repoId);
                          return next;
                        })
                      }
                    />
                    <span>
                      <strong>{t.name}</strong>{' '}
                      <span className="muted small">
                        from <code>{t.branch}</code>
                        {n === undefined ? '' : n ? ` · ${n} changed file${n === 1 ? '' : 's'}` : ' · no changes'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          <Field label="Branch">{(id) => <input id={id} className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />}</Field>
          <Field label="Commit message">{(id) => <textarea id={id} className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
          {isGithub ? (
            <>
              <Toggle checked={createPr} onChange={setCreatePr} label={multi ? 'Open a draft pull request in each GitHub repository' : 'Open a draft pull request on GitHub'} />
              {createPr ? (
                <>
                  <Field label="Pull request title">{(id) => <input id={id} className="input" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />}</Field>
                  {multi ? (
                    <p className="muted small">Each pull request goes into the branch that repository's work started from.</p>
                  ) : (
                    <Field label="Open the pull request into" hint="The branch you want these changes reviewed against and merged into later.">
                      {(id) => (
                        <select id={id} className="input mono" value={prBase} onChange={(e) => setPrBase(e.target.value)}>
                          <option value="">Default branch{branchList.data?.defaultBranch ? ` (${branchList.data.defaultBranch})` : ''}</option>
                          {(branchList.data?.branches || []).filter((b) => b.name !== branch).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
                        </select>
                      )}
                    </Field>
                  )}
                </>
              ) : null}
            </>
          ) : null}
          <ErrorNote error={error} />
        </div>
      )}
    </Modal>
  );
}
