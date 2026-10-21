import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useLoad } from '../../lib/useAsync.js';
import { go, href, runHref } from '../../lib/router.js';
import { cx } from '../../lib/util.js';
import { MODES } from '../../components/run/RunViewer.jsx';
import { ModelPicker } from '../../components/ModelPicker.jsx';
import { ConnectionBadge } from '../../components/ConnectionBadge.jsx';
import { JiraTicketPicker } from '../../components/JiraTicketPicker.jsx';
import { Button, ErrorNote, Field, Modal, Segmented, useUi } from '../../components/ui.jsx';

const KINDS = [
  { value: 'session', label: 'Session', hint: 'Keeps working toward the goal on its own, iteration after iteration, until it is done or needs you.' },
  { value: 'single', label: 'Single run', hint: 'One run. You choose whether edits and commands wait for your approval.' },
  { value: 'document', label: 'Document a repository', hint: 'Maps a repository and writes cited documentation into its own folder. No code changes.' },
];

/** The provider new work in this project uses (sessions keep the one they were made with). */
function useProjectProvider(projectId) {
  const conn = useLoad(() => api.get(`/api/projects/${projectId}/connection`), [projectId]);
  return conn.data?.provider ?? null;
}

/** Branches of a repository and its default branch. */
function useBranches(repoId) {
  const [b, setB] = useState({ list: [], def: '' });
  useEffect(() => {
    if (!repoId) return setB({ list: [], def: '' });
    let alive = true;
    api.get(`/api/repos/${repoId}/branches`).then((r) => alive && setB({ list: r.branches.map((x) => x.name), def: r.defaultBranch })).catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoId]);
  return b;
}

function useTeam(projectId) {
  const agents = useLoad(() => api.get(`/api/projects/${projectId}/agents`), [projectId]);
  return (agents.data?.agents || []).filter((a) => a.enabled);
}

function LeadField({ team, value, onChange }) {
  return (
    <Field label="Lead agent" hint={team.length ? 'A lead plans the work, hands tasks to the other agents of this project and checks what they return.' : 'No agents in this project yet. Add some under Agents and skills and a lead can delegate to them.'}>
      {(id) => (
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Default (the main agent decides)</option>
          {team.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
              {a.description ? ` — ${a.description.slice(0, 60)}` : ''}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function LimitFields({ f, set, kiro }) {
  return (
    <div className="row wrap">
      {kiro ? (
        <Field label="Budget (Kiro credits)" hint="It pauses when this is spent.">
          {(id) => <input id={id} type="number" min="1" step="1" className="input input-sm" value={f.budgetCredits} onChange={set('budgetCredits')} />}
        </Field>
      ) : (
        <Field label="Budget (USD)" hint="It pauses when this is spent.">
          {(id) => <input id={id} type="number" min="0.1" step="0.5" className="input input-sm" value={f.budgetUsd} onChange={set('budgetUsd')} />}
        </Field>
      )}
      <Field label="Iterations before pausing" hint="Per start; it asks you before going further.">
        {(id) => <input id={id} type="number" min="1" max="50" className="input input-sm" value={f.maxIterations} onChange={set('maxIterations')} />}
      </Field>
    </div>
  );
}

/** Start a session, a single run or a documentation run. */
export function NewSessionDialog({ prefill, onClose }) {
  const { project } = useProject();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const jira = useLoad(() => api.get(`/api/projects/${project.id}/jira`), [project.id]);
  const jiraReady = Boolean(jira.data?.connected && jira.data?.mapping);
  const kiro = useProjectProvider(project.id) === 'kiro';
  const team = useTeam(project.id);
  const ready = (repos.data?.repos || []).filter((r) => r.status === 'ready');

  const [kind, setKind] = useState('session');
  const [f, setF] = useState({
    goal: '',
    repoId: prefill?.repoId || '',
    branch: '',
    model: 'sonnet',
    budgetUsd: 5,
    budgetCredits: 20,
    maxIterations: 8,
    leadAgent: '',
    permissionMode: 'default',
    docScope: '',
    docOutput: 'markdown-word',
  });
  const [ticket, setTicket] = useState(prefill?.jiraKey ? { key: prefill.jiraKey, summary: prefill.jiraSummary || prefill.jiraKey, status: null, url: prefill.jiraUrl || null } : null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const branches = useBranches(f.repoId);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const isDoc = kind === 'document';
  const canStart = isDoc ? Boolean(f.repoId) : Boolean(f.goal.trim() || ticket);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'session') {
        const { workflow } = await api.post(`/api/projects/${project.id}/workflows`, {
          goal: f.goal,
          repoId: f.repoId || undefined,
          branch: f.repoId ? f.branch : undefined,
          model: f.model,
          budgetUsd: kiro ? undefined : Number(f.budgetUsd),
          budgetCredits: kiro ? Number(f.budgetCredits) : undefined,
          maxIterations: Number(f.maxIterations),
          leadAgent: f.leadAgent,
          jiraKey: ticket?.key || undefined,
        });
        go(project.id, 'sessions', workflow.id);
      } else {
        const body = isDoc
          ? { document: { repoId: f.repoId, scope: f.docScope, output: f.docOutput }, model: f.model, permissionMode: 'acceptEdits' }
          : {
              prompt: f.goal.trim() || undefined,
              jiraKey: ticket?.key || undefined,
              repoId: f.repoId || undefined,
              branch: f.repoId ? f.branch || branches.def : undefined,
              model: f.model,
              permissionMode: f.permissionMode,
            };
        const { run } = await api.post(`/api/projects/${project.id}/runs`, body);
        window.location.hash = runHref(project.id, run.id);
      }
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const kindInfo = KINDS.find((k) => k.value === kind);
  return (
    <Modal
      wide
      title="Start agent work"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="play" busy={busy} disabled={!canStart} onClick={start}>
            {kind === 'session' ? 'Start session' : isDoc ? 'Start documentation run' : 'Start run'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row between wrap">
          <Segmented value={kind} onChange={setKind} label="Kind of work" options={KINDS.map(({ value, label }) => ({ value, label }))} />
          <span className="row tight">
            <span className="muted small">Connection:</span>
            <ConnectionBadge projectId={project.id} />
          </span>
        </div>
        <p className="muted small">{kindInfo.hint}</p>

        {isDoc ? (
          <>
            <div className="row wrap">
              <Field label="Repository" hint={ready.length ? 'Uses the default branch.' : 'Connect and sync a repository on the Repositories page first.'}>
                {(id) => (
                  <select id={id} className="input" value={f.repoId} onChange={set('repoId')}>
                    <option value="">Choose a repository…</option>
                    {ready.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Output" hint="Word and PowerPoint use the make-documents skill.">
                {(id) => (
                  <select id={id} className="input" value={f.docOutput} onChange={set('docOutput')}>
                    <option value="markdown">Markdown files</option>
                    <option value="word">Word document</option>
                    <option value="markdown-word">Markdown and Word</option>
                    <option value="slides">PowerPoint overview</option>
                  </select>
                )}
              </Field>
            </div>
            <Field label="Focus (optional)" hint="Leave empty to cover the whole repository.">
              {(id) => <textarea id={id} className="input" rows={3} value={f.docScope} onChange={set('docScope')} placeholder="For example: the Lambda functions, the DynamoDB tables and how a payment flows through them" />}
            </Field>
          </>
        ) : (
          <>
            {jiraReady ? (
              <Field label="Jira ticket (optional)" hint={ticket ? 'The agents read the full ticket. The goal below becomes optional.' : 'Pick a ticket and the agents work on it.'}>
                {() => <JiraTicketPicker projectId={project.id} value={ticket} onChange={setTicket} />}
              </Field>
            ) : null}
            <Field label={ticket ? 'Goal (optional)' : 'Goal'} hint="What should be true when this is done? Mention the outcome and anything the agents must not change.">
              {(id) => (
                <textarea
                  id={id}
                  className="input"
                  rows={5}
                  value={f.goal}
                  onChange={set('goal')}
                  autoFocus
                  aria-required={!ticket}
                  placeholder="Fix the refund limit bug in RLP-2683 and add tests for amounts around 500"
                />
              )}
            </Field>
            <div className="row wrap">
              <Field label="Repository (optional)" hint={kind === 'session' ? 'The agents change a working copy on a new branch they name. Nothing is pushed until you do it.' : 'The run gets its own working copy of this branch.'}>
                {(id) => (
                  <select id={id} className="input" value={f.repoId} onChange={(e) => setF({ ...f, repoId: e.target.value, branch: '' })}>
                    <option value="">No repository (documents only)</option>
                    {ready.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Base branch" hint="Work starts from this branch, and a pull request goes into it. It is never pushed to directly.">
                {(id) => (
                  <select id={id} className="input mono" value={f.branch} disabled={!f.repoId} onChange={set('branch')}>
                    <option value="">{f.repoId ? `Default branch${branches.def ? ` (${branches.def})` : ''}` : 'Pick a repository first'}</option>
                    {branches.list.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            {kind === 'single' ? (
              <fieldset className="mode-pick">
                <legend className="field-label">Changes</legend>
                {MODES.map((m) => (
                  <label key={m.value} className={cx('choice', f.permissionMode === m.value && 'is-checked')}>
                    <input type="radio" name="mode" checked={f.permissionMode === m.value} onChange={() => setF({ ...f, permissionMode: m.value })} />
                    <span>
                      <strong>{m.label}</strong> <span className="muted">{m.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </>
        )}

        <details className="ws-more" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
          <summary>More options</summary>
          <div className="stack">
            <Field label="Model" hint="Pick a tier or any model your provider offers, or paste a model ID.">
              {(id) => <ModelPicker id={id} value={f.model} projectId={project.id} onChange={(model) => setF((cur) => ({ ...cur, model }))} />}
            </Field>
            {kind === 'session' ? (
              <>
                <LeadField team={team} value={f.leadAgent} onChange={(leadAgent) => setF((cur) => ({ ...cur, leadAgent }))} />
                <LimitFields f={f} set={set} kiro={kiro} />
              </>
            ) : null}
          </div>
        </details>
        {!ready.length && !isDoc ? (
          <p className="muted small">
            To let agents change code, <a href={href(project.id, 'repos')}>connect a repository</a>.
          </p>
        ) : null}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

/** A session's goal, lead, model and limits, edited in place. */
export function SessionSettings({ workflow, canEdit, onSaved }) {
  const { project } = useProject();
  const { toast } = useUi();
  const team = useTeam(project.id);
  const kiro = workflow.provider === 'kiro';
  const initial = () => ({
    goal: workflow.goal,
    model: workflow.model,
    budgetUsd: workflow.budget_usd,
    budgetCredits: workflow.budget_credits ?? 20,
    maxIterations: workflow.max_iterations,
    leadAgent: workflow.lead_agent ?? '',
  });
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial()), [workflow.id, workflow.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/workflows/${workflow.id}`, {
        ...f,
        budgetUsd: kiro ? undefined : Number(f.budgetUsd),
        budgetCredits: kiro ? Number(f.budgetCredits) : undefined,
        maxIterations: Number(f.maxIterations),
      });
      toast('Settings saved');
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!canEdit) {
    return (
      <div className="stack">
        <h3 className="small">Goal</h3>
        <p className="prompt-box">{workflow.goal}</p>
      </div>
    );
  }
  return (
    <div className="stack ws-settings">
      <Field label="Goal" hint="The agents re-read this before every iteration.">
        {(id) => <textarea id={id} className="input" rows={5} value={f.goal} onChange={set('goal')} />}
      </Field>
      <LeadField team={team} value={f.leadAgent} onChange={(leadAgent) => setF((cur) => ({ ...cur, leadAgent }))} />
      <Field label="Model">{(id) => <ModelPicker id={id} value={f.model} projectId={project.id} onChange={(model) => setF((cur) => ({ ...cur, model }))} />}</Field>
      <LimitFields f={f} set={set} kiro={kiro} />
      {workflow.rules ? (
        <>
          <h3 className="small">Standing rules</h3>
          <p className="prompt-box">{workflow.rules}</p>
        </>
      ) : null}
      {workflow.verify_command ? (
        <>
          <h3 className="small">Check command</h3>
          <p className="mono small">{workflow.verify_command}</p>
        </>
      ) : null}
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" busy={busy} disabled={!f.goal.trim()} onClick={save}>
          Save settings
        </Button>
      </div>
    </div>
  );
}
