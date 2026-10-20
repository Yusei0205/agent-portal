import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { useLoad } from '../lib/useAsync.js';
import { go, href } from '../lib/router.js';
import { cx, money, timeAgo } from '../lib/util.js';
import { buildTree } from '../lib/tree.js';
import { AgentGraph } from '../components/AgentGraph.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Modal, Note, PageHeader, Spinner, useUi } from '../components/ui.jsx';
import { JiraTicketPicker, Timeline, useRunStream } from './Runs.jsx';
import { TicketPreview } from '../components/TicketPreview.jsx';
import { ModelPicker } from '../components/ModelPicker.jsx';
import { ConnectionBadge } from '../components/ConnectionBadge.jsx';

const STATUS = {
  running: { tone: 'accent', label: 'Running by itself' },
  done: { tone: 'ok', label: 'Ready for review' },
  paused: { tone: 'warn', label: 'Paused' },
  blocked: { tone: 'warn', label: 'Needs you' },
  failed: { tone: 'danger', label: 'Failed' },
  stopped: { tone: 'muted', label: 'Stopped' },
};

const MODELS = [
  { value: 'haiku', label: 'Haiku (fast, cheapest)' },
  { value: 'sonnet', label: 'Sonnet (balanced)' },
  { value: 'opus', label: 'Opus (deepest)' },
];

export function Sessions({ route }) {
  const id = route.rest[0];
  return id ? <SessionView id={id} /> : <SessionList />;
}

/* ---------------- The list ---------------- */

function SessionList() {
  const { project, canEdit } = useProject();
  const list = useLoad(() => api.get(`/api/projects/${project.id}/workflows`), [project.id]);
  useProjectEvents(['workflow.updated', 'workflow.deleted'], () => list.reload(true));
  const [creating, setCreating] = useState(false);
  const items = list.data?.workflows || [];
  return (
    <div className="page">
      <PageHeader
        title="Sessions"
        sub="A session keeps working toward a goal on its own, run after run, checking its own work. You review the changes and keep giving instructions."
        actions={canEdit ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New session</Button> : null}
      />
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : items.length === 0 ? (
        <Empty icon="runs" title="No sessions yet" action={canEdit ? <Button variant="primary" onClick={() => setCreating(true)}>Start a session</Button> : null}>
          Describe the goal once. The agents plan, build and check it step by step until it is done or they need you.
        </Empty>
      ) : (
        <div className="session-list">
          {items.map((w) => {
            const isKiro = w.provider === 'kiro';
            return (
              <a key={w.id} className="panel session-card" href={href(project.id, 'sessions', w.id)}>
                <div className="row between wrap">
                  <h2>{w.title}</h2>
                  <Badge tone={STATUS[w.status]?.tone}>{STATUS[w.status]?.label ?? w.status}</Badge>
                </div>
                <p className="muted small session-summary">{w.summary || w.stop_reason || w.goal}</p>
                <p className="muted small">
                  Iteration {w.iteration} ·{' '}
                  {isKiro
                    ? `${w.spent_credits ?? 0} of ${w.budget_credits ?? 20} credits`
                    : `${money(w.spent_usd, 2)} of ${money(w.budget_usd, 2)}`}{' '}
                  · updated {timeAgo(w.updated_at)}
                </p>
              </a>
            );
          })}
        </div>
      )}
      {creating ? <SessionForm onClose={() => setCreating(false)} onSaved={(w) => go(project.id, 'sessions', w.id)} /> : null}
    </div>
  );
}

/* ---------------- Create / edit ---------------- */

/**
 * Determine the effective provider for a new session: the project's connection provider
 * (loaded from /api/projects/:pid/connection). For an existing session use workflow.provider.
 */
function useProjectProvider(projectId) {
  const conn = useLoad(() => api.get(`/api/projects/${projectId}/connection`), [projectId]);
  return conn.data?.provider ?? null;
}

function SessionForm({ workflow, onClose, onSaved }) {
  const { project } = useProject();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);

  // For a new session, find out the project's effective provider to decide budget field.
  // For an existing session, use workflow.provider directly.
  const projectProvider = useProjectProvider(project.id);
  const effectiveProvider = workflow ? workflow.provider : projectProvider;
  const isKiro = effectiveProvider === 'kiro';

  const [f, setF] = useState({
    goal: workflow?.goal ?? '',
    repoId: workflow?.repo_id ?? '',
    branch: workflow?.branch ?? '',
    model: workflow?.model ?? 'sonnet',
    budgetUsd: workflow?.budget_usd ?? 5,
    budgetCredits: workflow?.budget_credits ?? 20,
    maxIterations: workflow?.max_iterations ?? 8,
    leadAgent: workflow?.lead_agent ?? '',
  });
  const agents = useLoad(() => api.get(`/api/projects/${project.id}/agents`), [project.id]);
  const team = (agents.data?.agents || []).filter((a) => a.enabled);
  const [branches, setBranches] = useState({ list: [], def: '' });
  useEffect(() => {
    if (!f.repoId) return setBranches({ list: [], def: '' });
    let alive = true;
    api.get(`/api/repos/${f.repoId}/branches`).then((r) => alive && setBranches({ list: r.branches.map((b) => b.name), def: r.defaultBranch })).catch(() => {});
    return () => { alive = false; };
  }, [f.repoId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ticket, setTicket] = useState(null);
  const jira = useLoad(() => api.get(`/api/projects/${project.id}/jira`), [project.id]);
  const jiraReady = Boolean(jira.data?.connected && jira.data?.mapping);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const ready = (repos.data?.repos || []).filter((r) => r.status === 'ready');
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...f,
        budgetUsd: isKiro ? undefined : Number(f.budgetUsd),
        budgetCredits: isKiro ? Number(f.budgetCredits) : undefined,
        maxIterations: Number(f.maxIterations),
        jiraKey: ticket?.key || undefined,
      };
      if (workflow) {
        delete body.jiraKey;
        delete body.repoId;
        delete body.branch;
        const r = await api.put(`/api/workflows/${workflow.id}`, body);
        onSaved(r.workflow);
      } else {
        const r = await api.post(`/api/projects/${project.id}/workflows`, body);
        onSaved(r.workflow);
      }
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={workflow ? 'Session settings' : 'New session'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!f.goal.trim() && !ticket} onClick={save}>{workflow ? 'Save' : 'Start session'}</Button>
        </>
      }
    >
      <div className="stack">
        {/* Connection badge so the user knows which provider will be used */}
        <div className="row tight wrap">
          <span className="muted small">Connection:</span>
          <ConnectionBadge projectId={project.id} />
        </div>

        {!workflow && jiraReady ? (
          <Field label="Jira ticket (optional)" hint={ticket ? 'The agents read the full ticket, and read it again before every iteration so new comments are picked up. The goal below becomes optional.' : 'Pick a ticket and the session works on it.'}>
            {() => <JiraTicketPicker projectId={project.id} value={ticket} onChange={setTicket} />}
          </Field>
        ) : null}
        <Field label={ticket ? 'Goal (optional)' : 'Goal'} hint="What should be true when this is done? Be specific; the agents work from this alone.">
          {(id) => <textarea id={id} className="input" rows={5} value={f.goal} onChange={set('goal')} placeholder="Fix the refund limit bug in RLP-2683 and add tests for amounts around 500" />}
        </Field>
        {!workflow ? (
          <div className="row wrap">
            <Field label="Repository (optional)" hint="The agents change a working copy on a new branch they name. Nothing is pushed until you do it.">
              {(id) => (
                <select id={id} className="input" value={f.repoId} onChange={(e) => setF({ ...f, repoId: e.target.value, branch: '' })}>
                  <option value="">No repository</option>
                  {ready.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              )}
            </Field>
            <Field label="Branch to work from and open the pull request into" hint="The new branch is created from this one. It is never pushed to directly.">
              {(id) => (
                <select id={id} className="input mono" value={f.branch} disabled={!f.repoId} onChange={set('branch')}>
                  <option value="">{f.repoId ? `Default branch${branches.def ? ` (${branches.def})` : ''}` : 'Pick a repository first'}</option>
                  {branches.list.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
            </Field>
          </div>
        ) : null}
        <Field label="Lead agent (optional)" hint={team.length ? 'A lead plans the work, hands tasks to the other agents of this project and checks what they return. Leave it on default and the main agent decides who to use.' : 'No agents in this project yet. Add some under Agents and skills and a lead can delegate to them.'}>
          {(id) => (
            <select id={id} className="input" value={f.leadAgent} onChange={set('leadAgent')}>
              <option value="">Default (the main agent decides)</option>
              {team.map((a) => <option key={a.name} value={a.name}>{a.name}{a.description ? ` — ${a.description.slice(0, 60)}` : ''}</option>)}
            </select>
          )}
        </Field>
        <div className="row wrap">
          <Field label="Model" hint="Pick a tier or any model your provider offers, or paste a model ID.">
            {(id) => <ModelPicker id={id} value={f.model} projectId={project.id} onChange={(model) => setF((cur) => ({ ...cur, model }))} />}
          </Field>
          {isKiro ? (
            <Field label="Budget (Kiro credits)" hint="It pauses when this is spent.">
              {(id) => <input id={id} type="number" min="1" step="1" className="input input-sm" value={f.budgetCredits} onChange={set('budgetCredits')} />}
            </Field>
          ) : (
            <Field label="Budget (USD)" hint="It pauses when this is spent.">
              {(id) => <input id={id} type="number" min="0.1" step="0.5" className="input input-sm" value={f.budgetUsd} onChange={set('budgetUsd')} />}
            </Field>
          )}
          <Field label="Iterations before pausing" hint="Per start; it asks you before going further.">{(id) => <input id={id} type="number" min="1" max="50" className="input input-sm" value={f.maxIterations} onChange={set('maxIterations')} />}</Field>
        </div>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

/* ---------------- One session ---------------- */

function SessionView({ id }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const data = useLoad(() => api.get(`/api/workflows/${id}`), [id]);
  const timer = useRef(null);
  useProjectEvents(['workflow.updated', 'workflow.deleted'], (event, payload) => {
    if (payload?.id && payload.id !== id) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => data.reload(true), 250);
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState('');
  const w = data.data?.workflow;
  if (data.error) return <div className="page"><ErrorNote error={data.error} /></div>;
  if (!w) return <div className="page"><Spinner /></div>;

  const isKiro = w.provider === 'kiro';

  const call = (name, path, body) => async () => {
    setBusy(name);
    try {
      await api.post(`/api/workflows/${id}/${path}`, body);
      await data.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy('');
    }
  };
  const st = STATUS[w.status] ?? { tone: 'muted', label: w.status };
  const running = w.status === 'running';
  const burst = w.iteration - w.burst_start;

  return (
    <div className="page wide stack-lg">
      <PageHeader
        title={w.title}
        sub={<a href={href(project.id, 'sessions')}>← All sessions</a>}
        actions={
          canEdit ? (
            <>
              {running ? <Button icon="stop" busy={busy === 'pause'} onClick={call('pause', 'pause')}>Pause after this step</Button> : <Button variant="primary" icon="play" busy={busy === 'resume'} onClick={call('resume', 'resume')}>Resume</Button>}
              {running ? <Button variant="danger-ghost" busy={busy === 'stop'} onClick={call('stop', 'stop')}>Stop now</Button> : null}
              <Button icon="edit" onClick={() => setEditing(true)}>Settings</Button>
              {!running ? (
                <Button
                  variant="ghost"
                  icon="trash"
                  onClick={async () => {
                    if (!(await confirm({ title: 'Delete session', message: 'Delete this session and its history? The runs it made stay in Agent runs.', confirmLabel: 'Delete', danger: true }))) return;
                    await api.del(`/api/workflows/${id}`);
                    go(project.id, 'sessions');
                  }}
                >
                  Delete
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <div className="row wrap session-facts">
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="muted small">Iteration {w.iteration} ({burst} of {w.max_iterations} since the last start)</span>
        {isKiro ? (
          <span className="muted small">{w.spent_credits ?? 0} of {w.budget_credits ?? 20} credits</span>
        ) : (
          <span className="muted small">{money(w.spent_usd, 2)} of {money(w.budget_usd, 2)}</span>
        )}
        <span className="muted small">{w.model}</span>
        {/* Connection badge */}
        <ConnectionBadge projectId={project.id} />
        {w.repo_id ? <span className="muted small">from <code>{w.branch || 'the default branch'}</code> into a new branch <code>{w.work_branch || 'the agents will name'}</code></span> : null}
        {w.jira_key ? <a className="small" href={w.jira_url || undefined} target="_blank" rel="noopener noreferrer">Jira {w.jira_key}</a> : null}
        {w.lead_agent ? <span className="muted small">led by <code>{w.lead_agent}</code></span> : null}
        {w.last_run_id ? <a className="small" href={href(project.id, 'runs', w.last_run_id)}>Open the latest run</a> : null}
      </div>

      {w.status === 'done' ? (
        <Note tone="success" icon="check" action={w.last_run_id ? <a className="btn btn-sm" href={href(project.id, 'runs', w.last_run_id)}>Review changes</a> : null}>
          The agents report the goal is met{w.verify_command ? ' and your check passes' : ''}. Review the changes, then tell them what to improve below, or push them from the run.
        </Note>
      ) : ['paused', 'blocked', 'failed', 'stopped'].includes(w.status) && w.stop_reason ? (
        <Note tone="info" icon="alert">{w.stop_reason}</Note>
      ) : null}

      {w.jira_key ? (
        <details className="panel" open>
          <summary>Jira ticket {w.jira_key}</summary>
          <TicketPreview projectId={project.id} ticketKey={w.jira_key} />
        </details>
      ) : null}

      {w.last_run_id ? <LiveGraph key={w.last_run_id} runId={w.last_run_id} /> : null}

      <section className="panel stack">
        <h2>Instruct this session</h2>
        <Composer workflow={w} canEdit={canEdit} onSent={() => data.reload(true)} />
      </section>

      <section className="panel stack">
        <h2>History</h2>
        <History events={data.data.events} projectId={project.id} />
      </section>

      <details className="panel">
        <summary>Goal and rules</summary>
        <h3 className="small">Goal</h3>
        <p className="prompt-box">{w.goal}</p>
        {w.rules ? <><h3 className="small">Standing rules</h3><p className="prompt-box">{w.rules}</p></> : null}
        {w.verify_command ? <><h3 className="small">Check command</h3><p className="mono small">{w.verify_command}</p></> : null}
      </details>

      {editing ? <SessionForm workflow={w} onClose={() => setEditing(false)} onSaved={() => data.reload(true)} /> : null}
    </div>
  );
}

/** The agents of the session's latest run, live. */
function LiveGraph({ runId }) {
  const { meta } = useApp();
  const data = useRunStream(runId);
  const [selected, setSelected] = useState('main');
  const run = data.run;
  const tree = useMemo(() => buildTree(data.events, { prices: meta.prices, runStatus: run?.status }), [data.events, meta.prices, run?.status]);
  if (data.error) return <ErrorNote error={data.error} />;
  if (!run) return <Spinner />;
  const node = tree.nodes.get(selected) || tree.root;
  return (
    <div className="stack">
      <AgentGraph tree={tree} selected={selected} onSelect={setSelected} />
      <details className="panel" open={run.status === 'running'}>
        <summary>{node.kind === 'main' ? 'What the main agent is doing' : `What ${node.label} is doing`}</summary>
        <Timeline node={node} tree={tree} onSelect={setSelected} inputs={data.inputs} />
      </details>
    </div>
  );
}

function Composer({ workflow, canEdit, onSent }) {
  const { toast } = useUi();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!canEdit) return <p className="muted small">Only editors can instruct a session.</p>;
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/api/workflows/${workflow.id}/messages`, { body: text });
      setText('');
      toast(workflow.status === 'running' ? 'Queued for the next step' : 'Instruction sent; the session is running again');
      onSent();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <textarea
        className="input"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Instruction"
        placeholder={workflow.status === 'running' ? 'Added to the next step. For example: also cover the case where the amount is exactly 500.' : 'Tell it what to improve or do next. This starts it again.'}
      />
      <div className="row">
        <Button variant="primary" busy={busy} disabled={!text.trim()} onClick={send}>{workflow.status === 'running' ? 'Queue instruction' : 'Send and continue'}</Button>
      </div>
    </>
  );
}

function History({ events, projectId }) {
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
              {e.data.output ? <details><summary className="small">Output</summary><pre className="prompt-box">{e.data.output}</pre></details> : null}
            </div>
          ) : e.kind === 'iteration' ? (
            <div className="wf-body">
              {e.data.state ? <strong>Iteration {e.data.iteration}: {e.data.state === 'done' ? 'reports done' : e.data.state === 'blocked' ? 'blocked' : 'continues'}</strong> : null}
              <p>{e.body}</p>
              {e.data.next ? <p className="muted small">Next: {e.data.next}</p> : null}
              {e.run_id ? <a className="small" href={href(projectId, 'runs', e.run_id)}>Open the run</a> : null}
            </div>
          ) : (
            <div className="wf-body"><span>{e.body}</span></div>
          )}
        </li>
      ))}
    </ol>
  );
}
