import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useLoad } from '../../lib/useAsync.js';
import { Icon } from '../Icon.jsx';
import { Button, ErrorNote, Field, Modal, Toggle, useUi } from '../ui.jsx';

/** Commit a run's working copy to a new branch and optionally open a draft pull request. */
export function PushDialog({ run, onClose }) {
  const { toast } = useUi();
  const meta = run.meta || {};
  const jiraKey = meta.jiraKey;
  const jiraSummary = meta.jiraSummary;

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
  const branchList = useLoad(() => (run.repo_id ? api.get(`/api/repos/${run.repo_id}/branches`) : Promise.resolve(null)), [run.repo_id]);
  const [prTitle, setPrTitle] = useState(jiraKey ? `${jiraKey}: ${jiraSummary || run.title}` : run.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const repo = useLoad(() => (run.repo_id ? api.get(`/api/projects/${run.project_id}/repos`) : Promise.resolve(null)), [run.repo_id]);
  const isGithub = repo.data?.repos.find((r) => r.id === run.repo_id)?.provider === 'github';
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
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const body = { branch, message, createPr };
                  if (createPr && isGithub) {
                    body.prTitle = prTitle;
                    if (prBase) body.base = prBase;
                  }
                  const r = await api.post(`/api/runs/${run.id}/push`, body);
                  setDone(r);
                  toast(`Pushed to ${r.branch}`);
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Commit and push
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="stack">
          <p>
            Pushed commit <code>{done.commit?.slice(0, 10)}</code> to <code>{done.branch}</code>.
          </p>
          {done.pr ? (
            <p>
              Draft pull request: <a href={done.pr.url} target="_blank" rel="noreferrer">#{done.pr.number}</a>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <p className="muted">All changes in the run's working copy are committed and pushed to a new branch. The default branch is never pushed to.</p>
          {jiraKey ? (
            <div className="row tight wrap jira-bar small" style={{ marginBottom: 4 }}>
              <a href={meta.jiraUrl} target="_blank" rel="noopener noreferrer" className="badge badge-accent">
                Jira {jiraKey} <Icon name="external" size={12} />
              </a>
              <span className="muted">{jiraSummary}</span>
            </div>
          ) : null}
          <Field label="Branch">{(id) => <input id={id} className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />}</Field>
          <Field label="Commit message">{(id) => <textarea id={id} className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
          {isGithub ? (
            <>
              <Toggle checked={createPr} onChange={setCreatePr} label="Open a draft pull request on GitHub" />
              {createPr ? (
                <>
                  <Field label="Pull request title">{(id) => <input id={id} className="input" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />}</Field>
                  <Field label="Open the pull request into" hint="The branch you want these changes reviewed against and merged into later.">
                    {(id) => (
                      <select id={id} className="input mono" value={prBase} onChange={(e) => setPrBase(e.target.value)}>
                        <option value="">Default branch{branchList.data?.defaultBranch ? ` (${branchList.data.defaultBranch})` : ''}</option>
                        {(branchList.data?.branches || []).filter((b) => b.name !== branch).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
                      </select>
                    )}
                  </Field>
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
