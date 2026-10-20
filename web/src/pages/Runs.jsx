import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { ModelPicker } from '../components/ModelPicker.jsx';
import { ConnectionBadge } from '../components/ConnectionBadge.jsx';
import { JiraTicketPicker } from '../components/JiraTicketPicker.jsx';
import { KIND_LABEL, MODES, RunView } from '../components/run/RunViewer.jsx';
import { cx, money, timeAgo } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Segmented, Spinner } from '../components/ui.jsx';

export function Runs({ route }) {
  const { project } = useProject();
  const [filter, setFilter] = useState('all');
  const runs = useLoad(() => api.get(`/api/projects/${project.id}/runs?kind=${filter === 'all' ? 'chat,test,review' : filter}`), [project.id, filter]);
  useProjectEvents(['run.updated'], () => runs.reload(true));
  const selected = route.rest[0] && route.rest[0] !== 'new' ? route.rest[0] : null;

  // Support ?jiraKey=PAY-123&jiraUrl=...&jiraSummary=... from the Tickets page "Start a coding run" button
  const prefill = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    const key = q.get('jiraKey');
    if (!key) return null;
    return { jiraKey: key, jiraUrl: q.get('jiraUrl') || '', jiraSummary: q.get('jiraSummary') || '' };
  }, []);

  return (
    <div className="runs-page">
      <aside className="runs-list" aria-label="Runs">
        <div className="runs-list-head">
          <h1>Agent runs</h1>
          <a className="btn btn-primary btn-sm" href={href(project.id, 'runs', 'new')}>
            <Icon name="plus" size={15} />
            <span>New run</span>
          </a>
        </div>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          label="Show"
          options={[
            { value: 'all', label: 'All' },
            { value: 'chat', label: 'Runs' },
            { value: 'review', label: 'Reviews' },
            { value: 'test', label: 'Tests' },
          ]}
        />
        {runs.loading && !runs.data ? (
          <Spinner />
        ) : (
          <ul className="run-items">
            {(runs.data?.runs || []).map((r) => (
              <li key={r.id}>
                <a href={href(project.id, 'runs', r.id)} className={cx('run-item', selected === r.id && 'is-active')}>
                  <span className={cx('dot', `dot-${r.status}`)} aria-hidden="true" />
                  <span className="run-item-main">
                    <span className="run-item-title">{r.title}</span>
                    <span className="muted small">
                      {KIND_LABEL[r.kind] ?? r.kind}, {timeAgo(r.created_at)}
                      {r.meta?.kiroCredits != null ? `, ${r.meta.kiroCredits} credits` : r.cost_usd ? `, ${money(r.cost_usd)}` : ''}
                    </span>
                  </span>
                  {r.status === 'waiting' ? <Badge status="waiting" /> : null}
                </a>
              </li>
            ))}
            {runs.data && !runs.data.runs.length ? <li className="muted small pad-sm">No runs yet.</li> : null}
          </ul>
        )}
      </aside>
      <section className="runs-main">{selected ? <RunView key={selected} runId={selected} /> : <Composer prefill={prefill} />}</section>
    </div>
  );
}


/* ---------------- Start a run ---------------- */

const EXAMPLES = [
  'Design and build the refund approval flow described in the FSD',
  'Write user stories and acceptance criteria for the notifications section',
  'Map the code structure of the main repository: endpoints, services and tests',
  'Compare the TSD with the code and list what is missing',
];

function Composer({ prefill }) {
  const { project, canEdit } = useProject();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const jiraStatus = useLoad(() => api.get(`/api/projects/${project.id}/jira`), [project.id]);
  const [form, setForm] = useState({ prompt: '', repoId: '', branch: '', permissionMode: 'default', model: 'sonnet' });
  // "Document a repository": the agent reads the repo's copy in place and writes only to its own run folder.
  const [kind, setKind] = useState('task');
  const [doc, setDoc] = useState({ repoId: '', scope: '', output: 'markdown-word' });
  const isDoc = kind === 'document';
  const chooseKind = (k) => {
    setKind(k);
    // Writing documents to the run folder is safe, so default to not asking for every file.
    setForm((f) => ({ ...f, permissionMode: k === 'document' ? 'acceptEdits' : 'default' }));
  };
  const [branches, setBranches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Jira ticket selection state
  const [jiraTicket, setJiraTicket] = useState(null);

  // Prefill from Tickets page "Start a coding run" button
  useEffect(() => {
    if (prefill?.jiraKey) {
      setJiraTicket({ key: prefill.jiraKey, summary: prefill.jiraSummary || prefill.jiraKey, status: null, url: prefill.jiraUrl || null });
      // Clear the query params so a reload doesn't re-prefill
      const clean = new URL(window.location.href);
      clean.searchParams.delete('jiraKey');
      clean.searchParams.delete('jiraUrl');
      clean.searchParams.delete('jiraSummary');
      clean.searchParams.delete('repoId');
      window.history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
      // Also pre-select the repo if provided
      const q = new URLSearchParams(window.location.search);
      const repoId = prefill.repoId || q.get('repoId');
      if (repoId) setForm((f) => ({ ...f, repoId }));
    }
  }, [prefill]);

  useEffect(() => {
    if (!form.repoId) return setBranches([]);
    api.get(`/api/repos/${form.repoId}/branches`).then((r) => {
      setBranches(r.branches);
      setForm((f) => ({ ...f, branch: f.branch || r.defaultBranch }));
    });
  }, [form.repoId]);
  const readyRepos = (repos.data?.repos || []).filter((r) => r.status === 'ready');

  // Show the Jira picker only when Jira is connected AND mapped
  const jiraReady = Boolean(jiraStatus.data?.connected && jiraStatus.data?.mapping);

  if (!canEdit) {
    return (
      <div className="pad-lg">
        <Empty icon="runs" title="Pick a run to follow it">You have view access, so you can watch runs and answer questions, but not start runs.</Empty>
      </div>
    );
  }

  // Instruction is optional when a Jira ticket is selected
  const promptRequired = !jiraTicket;
  const promptEmpty = !form.prompt.trim();

  const start = async (e) => {
    e?.preventDefault();
    if (!isDoc && promptRequired && promptEmpty) return;
    setBusy(true);
    setError(null);
    try {
      let body;
      if (isDoc) {
        body = { document: { repoId: doc.repoId, scope: doc.scope, output: doc.output }, model: form.model, permissionMode: form.permissionMode };
      } else if (jiraTicket) {
        body = {
          jiraKey: jiraTicket.key,
          prompt: form.prompt.trim() || undefined,
          repoId: form.repoId || undefined,
          branch: form.repoId ? form.branch : undefined,
          model: form.model,
          permissionMode: form.permissionMode,
        };
      } else {
        body = { ...form, repoId: form.repoId || undefined, branch: form.repoId ? form.branch : undefined };
      }
      const { run } = await api.post(`/api/projects/${project.id}/runs`, body);
      go(project.id, 'runs', run.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="composer" onSubmit={start}>
      <h2>What should the agents do?</h2>
      <div className="row tight wrap" style={{ marginBottom: 4 }}>
        <span className="muted small">Connection:</span>
        <ConnectionBadge projectId={project.id} />
      </div>
      <Segmented
        value={kind}
        onChange={chooseKind}
        label="Kind of run"
        options={[
          { value: 'task', label: 'Free task' },
          { value: 'document', label: 'Document a repository' },
        ]}
      />
      {isDoc ? (
        <div className="stack">
          <p className="muted">The agent maps the repository's code and writes cited documentation. It reads a fresh copy of the repository and writes only to its own run folder, so no code changes.</p>
          <div className="composer-grid">
            <Field label="Repository" hint={readyRepos.length ? 'Uses the default branch.' : 'Connect and sync a repository on the Repositories page first.'}>
              {(id) => (
                <select id={id} className="input" value={doc.repoId} onChange={(e) => setDoc({ ...doc, repoId: e.target.value })}>
                  <option value="">Choose a repository…</option>
                  {readyRepos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Output" hint="Word and PowerPoint use the make-documents skill.">
              {(id) => (
                <select id={id} className="input" value={doc.output} onChange={(e) => setDoc({ ...doc, output: e.target.value })}>
                  <option value="markdown">Markdown files</option>
                  <option value="word">Word document</option>
                  <option value="markdown-word">Markdown and Word</option>
                  <option value="slides">PowerPoint overview</option>
                </select>
              )}
            </Field>
          </div>
          <Field label="Focus (optional)" hint="Leave empty to cover the whole repository.">
            {(id) => (
              <textarea
                id={id}
                className="input"
                rows={3}
                value={doc.scope}
                onChange={(e) => setDoc({ ...doc, scope: e.target.value })}
                placeholder="For example: the Lambda functions, the DynamoDB tables and how a payment flows through them"
              />
            )}
          </Field>
        </div>
      ) : (
        <>
          <p className="muted">The main agent reads the project documents and decisions first, asks you when something is unclear, and hands parts of the work to the project's role agents.</p>

          {/* Jira ticket picker — only when connected and mapped */}
          {jiraReady ? (
            <Field
              label="Jira ticket (optional)"
              hint={jiraTicket ? 'The agent receives the full ticket as context. The instruction below becomes optional.' : 'Pick a ticket and the agent receives its details as context.'}
            >
              {() => (
                <JiraTicketPicker
                  projectId={project.id}
                  value={jiraTicket}
                  onChange={setJiraTicket}
                />
              )}
            </Field>
          ) : jiraStatus.data && !jiraStatus.data.connected ? (
            <p className="muted small">
              <a href={href(project.id, 'team')}>Connect Jira</a> to pick a ticket from your board.
            </p>
          ) : null}

          <Field
            label={jiraTicket ? 'Instruction (optional)' : 'Task for the agents'}
            hint={jiraTicket ? 'Leave empty to implement or fix what the ticket describes. Add a short note to focus or restrict the agent.' : undefined}
          >
            {(id) => (
              <textarea
                id={id}
                className="input composer-input"
                rows={6}
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder={
                  jiraTicket
                    ? `Optional: add a short instruction, e.g. "fix this, add unit tests"`
                    : 'Describe the task. Mention the feature, the outcome you want, and anything the agents must not change.'
                }
                aria-required={!jiraTicket}
                aria-label={jiraTicket ? 'Optional instruction for the agents' : 'Task for the agents'}
                autoFocus={!jiraTicket}
              />
            )}
          </Field>
          {!jiraTicket ? (
            <div className="chips">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" className="chip" onClick={() => setForm({ ...form, prompt: x })}>
                  {x}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
      <div className="composer-grid">
        {!isDoc ? (
        <Field label="Repository" hint={readyRepos.length ? 'The run gets its own working copy of this branch.' : 'Connect one on the Repositories page to let agents change code.'}>
          {(id) => (
            <select id={id} className="input" value={form.repoId} onChange={(e) => setForm({ ...form, repoId: e.target.value, branch: '' })}>
              <option value="">No repository (documents only)</option>
              {readyRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        ) : null}
        {!isDoc && form.repoId ? (
          <Field label="Branch">
            {(id) => (
              <select id={id} className="input" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <Field label="Model">{(id) => <ModelPicker id={id} value={form.model} projectId={project.id} onChange={(model) => setForm({ ...form, model })} />}</Field>
      </div>
      <fieldset className="mode-pick">
        <legend className="field-label">Changes</legend>
        {MODES.map((m) => (
          <label key={m.value} className={cx('choice', form.permissionMode === m.value && 'is-checked')}>
            <input type="radio" name="mode" checked={form.permissionMode === m.value} onChange={() => setForm({ ...form, permissionMode: m.value })} />
            <span>
              <strong>{m.label}</strong> <span className="muted">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" type="submit" icon="play" busy={busy} disabled={isDoc ? !doc.repoId : (promptRequired && promptEmpty)}>
          {isDoc ? 'Start documentation run' : 'Start run'}
        </Button>
      </div>
    </form>
  );
}
