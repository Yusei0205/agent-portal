import { useEffect, useId, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useLoad } from '../../lib/useAsync.js';
import { go, href, runHref } from '../../lib/router.js';
import { cx } from '../../lib/util.js';
import { MODES } from '../../components/run/RunViewer.jsx';
import { ModelPicker } from '../../components/ModelPicker.jsx';
import { ConnectionBadge } from '../../components/ConnectionBadge.jsx';
import { JiraTicketPicker } from '../../components/JiraTicketPicker.jsx';
import { ContextChips, ContextPicker, sendFiles } from '../../components/ContextPicker.jsx';
import { IntegrationPicker } from '../Integrations.jsx';
import { PUSH_MODES } from './status.js';
import { Icon } from '../../components/Icon.jsx';
import { Button, ErrorNote, Field, Modal, Segmented, useUi } from '../../components/ui.jsx';

const ENGINE_LABEL = { anthropic: 'Anthropic API', bedrock: 'Amazon Bedrock', kiro: 'Kiro CLI', demo: 'Demo' };

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

/** Whether the agents may ask the portal to push their changes to the session's new branch. */
function PushModeField({ value, onChange }) {
  const mode = PUSH_MODES.find((m) => m.value === value) ?? PUSH_MODES[0];
  return (
    <Field label="Agent pushes" hint={`${mode.hint} Only ever to the session's own new branch, never to the base or shared branches like main.`}>
      {(id) => (
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          {PUSH_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}



/**
 * "Trust all tools" toggle: commands and edits run without approval prompts.
 * Shown in New session dialog and session Settings.
 */
function TrustToolsField({ value, onChange, hasRepos }) {
  const uid = useId();
  const id = `trust-tools-${uid}`;
  const hint = hasRepos
    ? "Commands and edits run without asking. The agent can push to this session's own new branch (never to dev-sg, main or other shared branches) using the repository's credentials, which it never sees. Deploys, terraform apply and deleting files outside the working copy stay blocked."
    : "Commands and edits run without asking. The agent can push to this session's own new branch (never to dev-sg, main or other shared branches) using the repository's credentials, which it never sees. Deploys, terraform apply and deleting files outside the working copy stay blocked. This session has no repository, so it can't push.";
  return (
    <div className="field">
      <div className="row tight">
        <input
          id={id}
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={`${id}-hint`}
        />
        <label htmlFor={id} className="field-label" style={{ marginBottom: 0, cursor: 'pointer' }}>
          Trust all tools
        </label>
      </div>
      <p id={`${id}-hint`} className="field-hint">{hint}</p>
    </div>
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

/** The repositories a session or run works in: one row each, with the branch its working copy starts from. */
export function RepoRows({ rows, setRows, ready, session }) {
  const update = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => setRows((rs) => rs.filter((_, j) => j !== i));
  const used = new Set(rows.map((r) => r.repoId).filter(Boolean));
  const free = ready.filter((r) => !used.has(r.id));
  return (
    <fieldset className="repo-rows">
      <legend className="field-label">Repositories (optional)</legend>
      {rows.length ? (
        <ul className="repo-rows-list">
          {rows.map((row, i) => (
            <RepoRow key={i} row={row} options={ready.filter((r) => r.id === row.repoId || !used.has(r.id))} onChange={(p) => update(i, p)} onRemove={() => remove(i)} index={i} />
          ))}
        </ul>
      ) : (
        <p className="muted small">No repository: the agents work with the project documents only.</p>
      )}
      <div className="row between wrap">
        <span className="muted small">
          {rows.length > 1
            ? 'Each repository gets its own working copy. The changes go to one new branch name in every repository; pushing follows the Agent pushes setting.'
            : session
              ? 'The agents change a working copy on a new branch they name. Pushing follows the Agent pushes setting.'
              : 'The run gets its own working copy of the base branch.'}
        </span>
        <Button size="sm" icon="plus" disabled={!free.length} onClick={() => setRows((rs) => [...rs, { repoId: free[0].id, branch: '' }])} title={free.length ? undefined : ready.length ? 'Every repository is already added' : 'Connect a repository on the Repositories page first'}>
          Add repository
        </Button>
      </div>
    </fieldset>
  );
}

function RepoRow({ row, options, onChange, onRemove, index }) {
  const branches = useBranches(row.repoId);
  return (
    <li className="repo-row">
      <select className="input" aria-label={`Repository ${index + 1}`} value={row.repoId} onChange={(e) => onChange({ repoId: e.target.value, branch: '' })}>
        {options.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <select className="input mono" aria-label={`Base branch for repository ${index + 1}`} title="Work starts from this branch, and a pull request goes into it. It is never pushed to directly." value={row.branch} onChange={(e) => onChange({ branch: e.target.value })}>
        <option value="">{`Default branch${branches.def ? ` (${branches.def})` : ''}`}</option>
        {branches.list.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Remove repository ${index + 1}`} title="Remove">
        <Icon name="x" size={15} />
      </button>
    </li>
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
  // '' follows the project's connection; 'claude' or 'kiro' picks the engine for this work.
  const engines = useLoad(() => api.get(`/api/projects/${project.id}/engines`), [project.id]);
  const [engine, setEngine] = useState('');
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
    pushMode: 'never',
  });
  const [ticket, setTicket] = useState(prefill?.jiraKey ? { key: prefill.jiraKey, summary: prefill.jiraSummary || prefill.jiraKey, status: null, url: prefill.jiraUrl || null } : null);
  const [playground, setPlayground] = useState(false);
  const [trustTools, setTrustTools] = useState(false);
  const [more, setMore] = useState(false);
  const [context, setContext] = useState([]);
  const [picking, setPicking] = useState(false);
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Repositories to work in, each with the branch its working copy starts from ('' = its default branch).
  const [rows, setRows] = useState(() => (prefill?.repoId ? [{ repoId: prefill.repoId, branch: '' }] : []));
  // A workspace fills in the repositories; they can still be changed for this one session.
  const workspaces = useLoad(() => api.get(`/api/projects/${project.id}/workspaces`), [project.id]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [integrations, setIntegrations] = useState([]);
  const pickWorkspace = (id) => {
    setWorkspaceId(id);
    const w = (workspaces.data?.workspaces || []).find((x) => x.id === id);
    if (w) {
      setRows(w.repos.filter((r) => r.status !== 'missing').map((r) => ({ repoId: r.repoId, branch: r.branch })));
      setIntegrations(w.integrations);
    }
  };
  useEffect(() => {
    if (prefill?.workspaceId && workspaces.data && !workspaceId) pickWorkspace(prefill.workspaceId);
  }, [workspaces.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = rows.filter((r) => r.repoId).map(({ repoId, branch }) => ({ repoId, branch: branch || undefined }));
  const hasRepos = chosen.length > 0 || Boolean(workspaceId);
  // New sessions start with the portal's default for agent pushes (Settings › Agent defaults).
  // When repos are chosen, default to 'ask'; the server mirrors this behaviour.
  const [pushTouched, setPushTouched] = useState(false);
  useEffect(() => {
    if (!pushTouched && engines.data?.pushMode) {
      // Use the server/settings default push mode (from /api/projects/:id/engines → pushMode)
      // whenever the user hasn't manually chosen a value yet.
      setF((cur) => ({ ...cur, pushMode: engines.data.pushMode }));
    }
  }, [engines.data?.pushMode, hasRepos, pushTouched]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const isDoc = kind === 'document';
  const isSingle = kind === 'single';
  // Sessions require either repos/workspace or the Playground checkbox.
  // Single runs and document runs have their own repo requirements.
  const sessionReady = hasRepos || playground;
  const canStart = isDoc
    ? Boolean(f.repoId)
    : isSingle
    ? Boolean(f.goal.trim() || ticket)
    : Boolean((f.goal.trim() || ticket) && sessionReady);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'session') {
        // With files the session starts paused, gets its files, then starts, so the first iteration sees them all.
        const files = context.filter((c) => c.kind === 'file');
        const { workflow } = await api.post(`/api/projects/${project.id}/workflows`, {
          context: context.filter((c) => c.kind !== 'file').map(({ kind: k, ref, title, body }) => ({ kind: k, ref, title, body })),
          start: files.length ? false : undefined,
          goal: f.goal,
          repos: chosen,
          playground: chosen.length === 0 && !workspaceId ? true : undefined,
          workspaceId: workspaceId || undefined,
          pushMode: f.pushMode,
          trustTools: trustTools || undefined,
          integrations,
          engine: engine || undefined,
          model: f.model,
          budgetUsd: kiro ? undefined : Number(f.budgetUsd),
          budgetCredits: kiro ? Number(f.budgetCredits) : undefined,
          maxIterations: Number(f.maxIterations),
          leadAgent: f.leadAgent,
          jiraKey: ticket?.key || undefined,
        });
        if (files.length) {
          try {
            await sendFiles(workflow.id, files);
            await api.post(`/api/workflows/${workflow.id}/resume`);
          } catch (e) {
            toast(`The session was created but not started: ${e.message}`, 'danger');
          }
        }
        go(project.id, 'sessions', workflow.id);
      } else {
        const body = isDoc
          ? { document: { repoId: f.repoId, scope: f.docScope, output: f.docOutput }, model: f.model, permissionMode: 'acceptEdits' }
          : {
              prompt: f.goal.trim() || undefined,
              jiraKey: ticket?.key || undefined,
              repos: chosen,
              integrations,
              engine: engine || undefined,
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
        {engines.data && engines.data.default !== 'demo' ? (
          <div className="row tight wrap engine-pick">
            <span className="field-label">Engine</span>
            <Segmented
              size="sm"
              value={engine}
              onChange={(e) => {
                setEngine(e);
                setF((cur) => ({ ...cur, model: 'sonnet' }));
              }}
              label="Engine"
              options={[
                { value: '', label: `Project default (${ENGINE_LABEL[engines.data.default] ?? engines.data.default})` },
                ...(engines.data.claude ? [{ value: 'claude', label: `Claude Code (${ENGINE_LABEL[engines.data.claude]})` }] : []),
                { value: 'kiro', label: 'Kiro' },
              ]}
            />
          </div>
        ) : null}

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
            {workspaces.data?.workspaces?.length ? (
              <Field label="Workspace (optional)" hint="Fills in the repositories below; you can still change them for this one.">
                {(id) => (
                  <select id={id} className="input" value={workspaceId} onChange={(e) => pickWorkspace(e.target.value)}>
                    <option value="">No workspace: pick repositories yourself</option>
                    {workspaces.data.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} · {w.repos.length} repo{w.repos.length === 1 ? '' : 's'}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            <RepoRows rows={rows} setRows={setRows} ready={ready} session={kind === 'session'} />
            {kind === 'session' && !hasRepos ? (
              <label className="choice">
                <input
                  type="checkbox"
                  checked={playground}
                  onChange={(e) => setPlayground(e.target.checked)}
                />
                <span>
                  <strong>Playground</strong>{' '}
                  <span className="muted">No repository — the agents work with project documents only and can't push changes.</span>
                </span>
              </label>
            ) : null}
            {kind === 'session' ? (
              <div className="ctx-field">
                <div className="row between wrap">
                  <span className="field-label">Context for the agents (optional)</span>
                  <Button size="sm" icon="plus" onClick={() => setPicking(true)}>
                    Add context
                  </Button>
                </div>
                {context.length ? (
                  <ContextChips items={context} onRemove={(i) => setContext((c) => c.filter((_, j) => j !== i))} />
                ) : (
                  <p className="muted small">Documents, files, notes, links or earlier work the agents should read first.</p>
                )}
              </div>
            ) : null}
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
              {(id) => <ModelPicker id={id} value={f.model} projectId={project.id} engine={engine || undefined} onChange={(model) => setF((cur) => ({ ...cur, model }))} />}
            </Field>
            {!isDoc ? (
              <Field label={`Integrations${integrations.length ? ` (${integrations.length})` : ''}`} hint="MCP tools the agents may use in this work: Jira, AWS, a browser… Read-only unless writes are allowed.">
                {() => <IntegrationPicker value={integrations} onChange={setIntegrations} />}
              </Field>
            ) : null}
            {kind === 'session' ? (
              <>
                <LeadField team={team} value={f.leadAgent} onChange={(leadAgent) => setF((cur) => ({ ...cur, leadAgent }))} />
                <LimitFields f={f} set={set} kiro={kiro} />
                {hasRepos ? <PushModeField value={f.pushMode} onChange={(pushMode) => (setPushTouched(true), setF((cur) => ({ ...cur, pushMode })))} /> : null}
                <TrustToolsField value={trustTools} onChange={setTrustTools} hasRepos={hasRepos} />
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
      {picking ? <ContextPicker projectId={project.id} onAdd={(item) => setContext((c) => [...c, item])} onClose={() => setPicking(false)} /> : null}
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
    pushMode: workflow.push_mode ?? 'never',
    trustTools: workflow.trust_tools ?? false,
  });
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial()), [workflow.id, workflow.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  // Repositories can be attached or changed while the session is not running.
  const repoList = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const ready = (repoList.data?.repos || []).filter((r) => r.status === 'ready');
  const initialRows = () => (workflow.repos || []).map((r) => ({ repoId: r.repoId, branch: r.branch || '' }));
  const [rows, setRows] = useState(initialRows);
  useEffect(() => setRows(initialRows()), [workflow.id, workflow.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = workflow.status === 'running';
  const repoKey = (list) => JSON.stringify(list.filter((r) => r.repoId).map((r) => [r.repoId, r.branch || '']));
  const reposChanged = repoKey(rows) !== repoKey(initialRows());
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
        trustTools: f.trustTools,
        ...(reposChanged ? { repos: rows.filter((r) => r.repoId).map(({ repoId, branch }) => ({ repoId, branch: branch || undefined })) } : {}),
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
      {running ? (
        workflow.repos?.length ? null : <p className="muted small">Pause or stop the session to attach a repository.</p>
      ) : (
        <>
          <RepoRows rows={rows} setRows={setRows} ready={ready} session />
          {reposChanged ? <p className="muted small">The next iteration starts on fresh working copies of these repositories; the progress summary carries over.</p> : null}
        </>
      )}
      {rows.some((r) => r.repoId) ? <PushModeField value={f.pushMode} onChange={(pushMode) => setF((cur) => ({ ...cur, pushMode }))} /> : null}
      <TrustToolsField value={f.trustTools} onChange={(trustTools) => setF((cur) => ({ ...cur, trustTools }))} hasRepos={rows.some((r) => r.repoId)} />
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
