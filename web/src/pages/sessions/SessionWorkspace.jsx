import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp, useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { useLoad } from '../../lib/useAsync.js';
import { useRunStream } from '../../lib/useRunStream.js';
import { buildTree } from '../../lib/tree.js';
import { go, href, sessionHref } from '../../lib/router.js';
import { cx, money, timeAgo } from '../../lib/util.js';
import { AgentView } from '../../components/AgentCanvas.jsx';
import { ConnectionBadge } from '../../components/ConnectionBadge.jsx';
import { InputCard } from '../../components/InputCard.jsx';
import { TicketPreview } from '../../components/TicketPreview.jsx';
import { Timeline } from '../../components/run/Timeline.jsx';
import { Changes } from '../../components/run/Changes.jsx';
import { CONTEXT_ICON, CONTEXT_KIND_LABEL, ContextChips, ContextPicker, sendFiles } from '../../components/ContextPicker.jsx';
import { Icon } from '../../components/Icon.jsx';
import { PushDialog } from '../../components/run/PushDialog.jsx';
import { Badge, Button, Empty, ErrorNote, Note, Progress, Spinner, Tabs, useUi } from '../../components/ui.jsx';
import { SessionSettings } from './NewSessionDialog.jsx';
import { budgetOf, statusOf } from './status.js';

const TABS = ['live', 'changes', 'history', 'context', 'settings'];

/** One session: what its agents are doing now, what changed, what happened, and a box to steer it. */
export function SessionWorkspace({ id, query }) {
  const { project, canEdit } = useProject();
  const data = useLoad(() => api.get(`/api/workflows/${id}`), [id]);
  const timer = useRef(null);
  useProjectEvents(['workflow.updated', 'workflow.deleted'], (event, payload) => {
    if (payload?.id && payload.id !== id) return;
    if (event === 'workflow.deleted') return go(project.id, 'sessions');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => data.reload(true), 250);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const w = data.data?.workflow;
  if (data.error) return <div className="pad-lg"><ErrorNote error={data.error} /></div>;
  if (!w) return <div className="pad-lg"><Spinner /></div>;

  const tab = TABS.includes(query.get('tab')) ? query.get('tab') : 'live';
  // The run shown in Live: one picked from the iteration strip or history, else the latest.
  const runs = data.data.runs || [];
  const runId = runs.some((r) => r.id === query.get('run')) ? query.get('run') : w.last_run_id;
  const link = (params) => sessionHref(project.id, w.id, params);

  return (
    <div className="ws-detail">
      <SessionHeader w={w} canEdit={canEdit} reload={() => data.reload(true)} />
      <Tabs
        value={tab}
        tabs={[
          { value: 'live', label: 'Live', href: link({}) },
          { value: 'changes', label: 'Changes', href: link({ tab: 'changes' }) },
          { value: 'history', label: 'History', href: link({ tab: 'history' }), count: data.data.events.filter((e) => e.kind === 'human' && !e.consumed).length || undefined },
          { value: 'context', label: 'Context', href: link({ tab: 'context' }), count: w.context_count || undefined },
          { value: 'settings', label: 'Settings', href: link({ tab: 'settings' }) },
        ]}
      />
      <div className="ws-body">
        {tab === 'live' ? (
          runId ? (
            <LiveTab key={runId} runId={runId} isLatest={runId === w.last_run_id} runs={runs} link={link} />
          ) : (
            <Empty icon="runs" title="Nothing has run yet">{w.status === 'running' ? 'The first iteration is starting…' : 'Resume the session or send it an instruction to start.'}</Empty>
          )
        ) : tab === 'changes' ? (
          <ChangesTab w={w} canEdit={canEdit} />
        ) : tab === 'history' ? (
          <History events={data.data.events} link={link} />
        ) : tab === 'context' ? (
          <ContextTab w={w} canEdit={canEdit} />
        ) : (
          <div className="stack-lg">
            {w.jira_key ? (
              <details className="panel" open>
                <summary>Jira ticket {w.jira_key}</summary>
                <TicketPreview projectId={project.id} ticketKey={w.jira_key} />
              </details>
            ) : null}
            <SessionSettings workflow={w} canEdit={canEdit} onSaved={() => data.reload(true)} />
          </div>
        )}
      </div>
      <Composer workflow={w} canEdit={canEdit} onSent={() => data.reload(true)} />
    </div>
  );
}

/* ---------------- Header ---------------- */

function SessionHeader({ w, canEdit, reload }) {
  const { project } = useProject();
  const { toast, confirm } = useUi();
  const [busy, setBusy] = useState('');
  const st = statusOf(w);
  const running = w.status === 'running';
  const burst = w.iteration - w.burst_start;
  const b = budgetOf(w);
  const call = (name, path) => async () => {
    setBusy(name);
    try {
      await api.post(`/api/workflows/${w.id}/${path}`);
      reload();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy('');
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Delete session', message: 'Delete this session and its history? Its runs are kept.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/workflows/${w.id}`);
      go(project.id, 'sessions');
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  return (
    <header className="ws-head">
      <div className="ws-head-top">
        <div className="ws-head-title">
          <Badge tone={st.tone}>{st.label}</Badge>
          <h1>{w.title}</h1>
        </div>
        {canEdit ? (
          <div className="page-actions">
            {running ? (
              <Button icon="stop" busy={busy === 'pause'} onClick={call('pause', 'pause')}>
                Pause after this step
              </Button>
            ) : (
              <Button variant="primary" icon="play" busy={busy === 'resume'} onClick={call('resume', 'resume')}>
                Resume
              </Button>
            )}
            {running ? (
              <Button variant="danger-ghost" busy={busy === 'stop'} onClick={call('stop', 'stop')}>
                Stop now
              </Button>
            ) : (
              <Button variant="ghost" icon="trash" onClick={remove} aria-label="Delete session">
                Delete
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <div className="ws-meters">
        <div className="ws-meter">
          <span className="muted small">
            Iteration {w.iteration} · {burst} of {w.max_iterations} since the last start
          </span>
          <Progress value={(burst / Math.max(1, w.max_iterations)) * 100} label="Iterations used since the last start" />
        </div>
        <div className="ws-meter">
          <span className="muted small">{b.unit === 'credits' ? `${b.spent} of ${b.total} Kiro credits` : `${money(b.spent, 2)} of ${money(b.total, 2)}`}</span>
          <Progress value={(b.spent / Math.max(0.01, b.total)) * 100} label="Budget used" />
        </div>
      </div>
      <div className="row tight wrap ws-chips">
        <ConnectionBadge projectId={project.id} />
        <span className="chip-static mono small">{w.model}</span>
        {(w.integration_list || []).map((i) => (
          <a key={i.id} className="chip-static small" href="#/integrations" title={i.allow_writes ? 'Writes allowed' : 'Read-only'}>
            {i.name}
            {i.kind !== 'browser' && !i.allow_writes ? ' · read-only' : ''}
          </a>
        ))}
        {w.workspace ? (
          <a className="chip-static small" href={href(project.id, 'workspaces')} title="The workspace this session started from">
            workspace <strong>{w.workspace.name}</strong>
          </a>
        ) : null}
        {(w.repos?.length ? w.repos : []).map((r) => (
          <span key={r.repoId} className="chip-static small" title={`${r.name}: the agents work on a new branch, and a pull request goes into ${r.branch}`}>
            {w.repos.length > 1 ? <strong>{r.name}</strong> : null}
            <code>{w.work_branch || 'new branch, named by the agents'}</code> → <code>{r.branch || 'default branch'}</code>
          </span>
        ))}
        {w.lead_agent ? (
          <span className="chip-static small">
            led by <code>{w.lead_agent}</code>
          </span>
        ) : null}
        {w.jira_key ? (
          <a className="chip-static small" href={w.jira_url || undefined} target="_blank" rel="noopener noreferrer">
            Jira {w.jira_key}
          </a>
        ) : null}
      </div>
      {w.status === 'done' ? (
        <Note tone="success" icon="check">
          The agents report the goal is met{w.verify_command ? ' and your check passes' : ''}. Review the Changes, push them, or tell the agents what to improve below.
        </Note>
      ) : ['paused', 'blocked', 'failed', 'stopped'].includes(w.status) && w.stop_reason ? (
        <Note tone="info" icon="alert">
          {w.stop_reason}
        </Note>
      ) : null}
    </header>
  );
}

/* ---------------- Live ---------------- */

/** The agents of one run of the session, live, with what the selected one is doing. */
function LiveTab({ runId, isLatest, runs, link }) {
  const { meta } = useApp();
  const { project, canEdit, reload: reloadProject } = useProject();
  const data = useRunStream(runId);
  const [selected, setSelected] = useState('main');
  const run = data.run;
  const tree = useMemo(() => buildTree(data.events, { prices: meta.prices, runStatus: run?.status }), [data.events, meta.prices, run?.status]);
  if (data.error) return <ErrorNote error={data.error} />;
  if (!run) return <Spinner />;
  const node = tree.nodes.get(selected) || tree.root;
  const pending = data.inputs.filter((i) => i.status === 'pending');
  return (
    <div className="stack">
      {pending.length ? (
        <section className="pending" aria-label="Waiting for you">
          {pending.map((i) => (
            <InputCard key={i.id} input={i} projectId={project.id} canApprove={canEdit} compact onDone={() => { data.reload(); reloadProject(); }} />
          ))}
        </section>
      ) : null}
      <IterationStrip runs={runs} current={runId} link={link} />
      {!isLatest ? <Note tone="info" icon="alert">You are looking at an earlier iteration. <a href={link({})}>Back to the latest</a></Note> : null}
      <div className="ws-live">
        <div className="ws-graph">
          <AgentView tree={tree} selected={selected} onSelect={setSelected} live={['queued', 'running', 'waiting'].includes(run.status)} />
        </div>
        <section className="panel ws-inspector" aria-label="Selected agent">
          <h2>{node.kind === 'main' ? 'Main agent' : node.label}</h2>
          <p className="muted small">
            {node.status} · {node.toolCount} tool{node.toolCount === 1 ? '' : 's'}
            {node.cost ? ` · ≈${money(node.cost)}` : ''}
          </p>
          <Timeline node={node} tree={tree} onSelect={setSelected} inputs={data.inputs} />
        </section>
      </div>
    </div>
  );
}

const iterationOf = (title) => Number(/iteration (\d+)/.exec(title || '')?.[1] ?? 0);

/** One chip per iteration; the chosen one is shown above. */
function IterationStrip({ runs, current, link }) {
  if (runs.length < 2) return null;
  const ordered = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (
    <nav className="ws-iters" aria-label="Iterations">
      {ordered.map((r, i) => (
        <a key={r.id} href={link({ run: r.id })} className={cx('ws-iter', `ws-iter-${r.status}`, r.id === current && 'is-active')} aria-current={r.id === current ? 'true' : undefined} title={`${r.title} · ${r.status}`}>
          {iterationOf(r.title) || i + 1}
        </a>
      ))}
    </nav>
  );
}

/* ---------------- Changes ---------------- */

/** Every iteration resumes the same working copy, so the latest run's changes are the session's changes. */
function ChangesTab({ w, canEdit }) {
  const run = useLoad(() => (w.last_run_id ? api.get(`/api/runs/${w.last_run_id}`) : Promise.resolve(null)), [w.last_run_id, w.updated_at]);
  const [pushing, setPushing] = useState(false);
  if (!w.last_run_id) return <Empty icon="file" title="No changes yet">Changes appear here after the first iteration.</Empty>;
  if (run.error) return <ErrorNote error={run.error} />;
  const r = run.data?.run;
  if (!r) return <Spinner />;
  const active = ['queued', 'running', 'waiting'].includes(r.status);
  return (
    <div className="stack">
      <div className="row between wrap">
        <p className="muted small">{r.worktree ? (r.meta?.repos?.length > 1 ? `All changes the session made so far, across ${r.meta.repos.length} repositories.` : 'All changes the session made in its working copy so far.') : 'Files the session wrote to its run folder.'}</p>
        {canEdit && r.worktree ? (
          <Button icon="branch" disabled={active} title={active ? 'Wait for the current iteration to finish' : undefined} onClick={() => setPushing(true)}>
            Push changes
          </Button>
        ) : null}
      </div>
      <Changes run={r} />
      {pushing ? <PushDialog run={r} onClose={() => setPushing(false)} /> : null}
    </div>
  );
}

/* ---------------- History ---------------- */

function History({ events, link }) {
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

/* ---------------- Composer ---------------- */

function Composer({ workflow, canEdit, onSent }) {
  const { project } = useProject();
  const { toast } = useUi();
  const [text, setText] = useState('');
  const [attached, setAttached] = useState([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!canEdit) return null;
  const running = workflow.status === 'running';
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      // Files first, so the instruction and everything attached to it reach the same iteration.
      const context = await sendFiles(workflow.id, attached);
      await api.post(`/api/workflows/${workflow.id}/messages`, { body: text, context });
      setText('');
      setAttached([]);
      toast(running ? 'Queued for the next step' : 'Instruction sent; the session is running again');
      onSent();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="ws-composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <ContextChips items={attached} onRemove={(i) => setAttached((a) => a.filter((_, j) => j !== i))} />
      <textarea
        className="input"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
        aria-label="Instruction for the agents"
        placeholder={running ? 'Added to the next step. For example: also cover the case where the amount is exactly 500.' : 'Tell the agents what to improve or do next. This starts the session again.'}
      />
      <div className="ws-composer-actions">
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setPicking(true)} title="Attach documents, files, notes or links to this instruction">
          Attach context
        </Button>
        <span className="muted small push">Ctrl+Enter to send</span>
        <Button type="submit" variant="primary" busy={busy} disabled={!text.trim()}>
          {running ? 'Queue instruction' : 'Send and continue'}
        </Button>
      </div>
      {picking ? <ContextPicker projectId={project.id} excludeSessionId={workflow.id} onAdd={(item) => setAttached((a) => [...a, item])} onClose={() => setPicking(false)} /> : null}
    </form>
  );
}

/* ---------------- Context ---------------- */

/** Everything the agents were given to read, who added it, and a way to add or remove items. */
function ContextTab({ w, canEdit }) {
  const { project } = useProject();
  const { toast } = useUi();
  const ctx = useLoad(() => api.get(`/api/workflows/${w.id}/context`), [w.id, w.context_count]);
  const [picking, setPicking] = useState(false);
  const add = async (item) => {
    try {
      if (item.kind === 'file') await sendFiles(w.id, [item]);
      else await api.post(`/api/workflows/${w.id}/context`, { kind: item.kind, ref: item.ref, title: item.title, body: item.body });
      ctx.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  const remove = async (c) => {
    try {
      await api.del(`/api/workflows/${w.id}/context/${c.id}`);
      ctx.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  if (ctx.error) return <ErrorNote error={ctx.error} />;
  if (!ctx.data) return <Spinner />;
  const items = ctx.data.context;
  return (
    <div className="stack">
      <div className="row between wrap">
        <p className="muted small">The agents read this before every iteration. Items added since the last iteration are pointed out to them as new.</p>
        {canEdit ? (
          <Button icon="plus" onClick={() => setPicking(true)}>
            Add context
          </Button>
        ) : null}
      </div>
      {!items.length ? (
        <Empty icon="knowledge" title="No context yet">
          Attach documents, files, notes, links or earlier work so the agents start from what you already know.
        </Empty>
      ) : (
        <ul className="ctx-list">
          {items.map((c) => (
            <li key={c.id} className="ctx-item">
              <Icon name={CONTEXT_ICON[c.kind] ?? 'file'} size={17} />
              <div className="ctx-item-main">
                <strong>{c.title}</strong>
                <span className="muted small">
                  {CONTEXT_KIND_LABEL[c.kind] ?? c.kind}
                  {c.path ? (
                    <>
                      {' · '}
                      <code>{c.path}</code>
                    </>
                  ) : null}
                  {c.kind === 'url' ? (
                    <>
                      {' · '}
                      <a href={c.ref} target="_blank" rel="noopener noreferrer">
                        {c.ref}
                      </a>
                    </>
                  ) : null}
                  {' · '}added by {c.created_by_name || 'someone'} {timeAgo(c.created_at)}
                  {c.seen ? '' : ' · not read yet'}
                </span>
                {c.body ? <p className="ctx-item-body">{c.body}</p> : null}
              </div>
              {canEdit ? (
                <Button size="sm" variant="ghost" icon="trash" onClick={() => remove(c)} aria-label={`Remove ${c.title}`}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {picking ? <ContextPicker projectId={project.id} excludeSessionId={w.id} onAdd={add} onClose={() => setPicking(false)} /> : null}
    </div>
  );
}
