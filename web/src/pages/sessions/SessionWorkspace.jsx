import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp, useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { useLoad, useAction } from '../../lib/useAsync.js';
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
import { Badge, Button, Empty, ErrorNote, Field, Modal, Note, Progress, Spinner, Tabs, useUi } from '../../components/ui.jsx';
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
            <LiveTab key={runId} runId={runId} isLatest={runId === w.last_run_id} runs={runs} link={link} asked={askedFor(w, data.data.events, runId)} />
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
  const [delegating, setDelegating] = useState(false);
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
            <Button icon="plus" onClick={() => setDelegating(true)} title="Hand a task of this session to a separate session with its own working copy and branch">
              Delegate a task
            </Button>
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
        {w.engine ? <span className="chip-static small" title="The engine this session runs on">{w.engine === 'kiro' ? 'Kiro' : 'Claude Code'}</span> : null}
        <span className="chip-static mono small">{w.model}</span>
        {(w.integration_list || []).map((i) => (
          <a key={i.id} className="chip-static small" href="#/integrations" title={i.allow_writes ? 'Writes allowed' : 'Read-only'}>
            {i.name}
            {i.kind !== 'browser' && !i.allow_writes ? ' · read-only' : ''}
          </a>
        ))}
        {w.push_mode && w.push_mode !== 'never' ? (
          <span className="chip-static small" title="Whether the agents may ask the portal to push">
            agent pushes: <strong>{w.push_mode === 'ask' ? 'ask me' : 'allowed'}</strong>
          </span>
        ) : null}
        {w.trust_tools ? (
          <span className="chip-static small chip-warn" title="Commands and edits run without asking. Deploys, terraform apply and deleting files outside the working copy stay blocked.">
            trusts all tools
          </span>
        ) : null}
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
      {w.parent || w.children?.length ? (
        <div className="row tight wrap ws-family">
          {w.parent ? (
            <a className="chip-static small" href={href(project.id, 'sessions', w.parent.id)}>
              ↰ delegated by <strong>{w.parent.title}</strong>
            </a>
          ) : null}
          {w.children?.length ? <span className="muted small">Delegated sessions:</span> : null}
          {(w.children || []).map((c) => (
            <a key={c.id} className={cx('chip-static small ws-child', `ws-child-${c.status}`)} href={href(project.id, 'sessions', c.id)} title={c.summary || c.status}>
              <span className={cx('dot', `dot-${c.status === 'running' ? 'running' : c.status === 'done' ? 'completed' : c.status === 'blocked' ? 'waiting' : c.status}`)} aria-hidden="true" />
              {c.title}
              <span className="muted">· {c.status === 'running' ? 'working' : c.status}</span>
            </a>
          ))}
        </div>
      ) : null}
      {w.pending_push && canEdit ? <PushRequestCard w={w} reload={reload} /> : null}
      {!w.repos?.length && !w.playground && ['blocked', 'done', 'stopped', 'failed'].includes(w.status) && canEdit ? (
        <RescuePushCard w={w} reload={reload} />
      ) : null}
      {w.status === 'done' ? (
        <Note tone="success" icon="check">
          The agents report the goal is met{w.verify_command ? ' and your check passes' : ''}. Review the Changes, push them, or tell the agents what to improve below.
        </Note>
      ) : ['paused', 'blocked', 'failed', 'stopped'].includes(w.status) && w.stop_reason ? (
        <Note tone="info" icon="alert">
          {w.stop_reason}
        </Note>
      ) : null}
      {delegating ? <DelegateDialog w={w} onClose={() => setDelegating(false)} onDone={reload} /> : null}
    </header>
  );
}

/** The agents asked the portal to push: show what and where, and let a person allow or decline it. */
function PushRequestCard({ w, reload }) {
  const { toast } = useUi();
  const req = w.pending_push;
  const changes = useLoad(() => api.get(`/api/runs/${req.runId}/changes`), [req.runId]);
  const [message, setMessage] = useState(req.message || '');
  const [pr, setPr] = useState(Boolean(req.pr));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const counts = changes.data?.repos ?? [];
  const files = counts.reduce((n, r) => n + r.changed, 0);
  const act = async (what) => {
    setBusy(what);
    try {
      if (what === 'allow') {
        const r = await api.post(`/api/workflows/${w.id}/push/allow`, { message: message || undefined, pr });
        const failed = r.push.results.filter((x) => !x.ok);
        toast(r.push.ok ? `Pushed to ${req.branch}` : `Nothing was pushed: ${failed.map((x) => x.error).join('; ')}`, r.push.ok ? 'ok' : 'danger');
      } else {
        await api.post(`/api/workflows/${w.id}/push/deny`, { reason });
        toast('Push declined; the agents were told why');
      }
      reload();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="note note-warn push-request" aria-label="Push waiting for you">
      <div className="stack">
        <strong>
          The agents ask to push {changes.data ? `${files} changed file${files === 1 ? '' : 's'}` : 'their changes'} to <code>{req.branch}</code>
          {counts.length > 1 ? ` in ${counts.filter((c) => c.changed).length} repositories` : ''}.
        </strong>
        {counts.length > 1 ? (
          <span className="small">
            {counts.map((c) => `${c.name}: ${c.changed ? `${c.changed} file${c.changed === 1 ? '' : 's'}` : 'no changes'}`).join(' · ')}
          </span>
        ) : null}
        <a className="small" href={`#/p/${w.project_id}/sessions/${w.id}?tab=changes`}>
          Review the changes first
        </a>
        <div className="row wrap">
          <Field label="Commit message">{(id) => <input id={id} className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Agent Portal: …" />}</Field>
          <label className="row tight small push-pr">
            <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} /> Open a draft pull request (GitHub)
          </label>
        </div>
        <div className="row wrap">
          <Button variant="primary" icon="branch" busy={busy === 'allow'} disabled={Boolean(busy)} onClick={() => act('allow')}>
            Allow push
          </Button>
          <input className="input input-sm push-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not? (optional, sent to the agents)" aria-label="Reason for declining" />
          <Button variant="danger-ghost" busy={busy === 'deny'} disabled={Boolean(busy)} onClick={() => act('deny')}>
            Decline
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Base-like branch names that shouldn't be used as the new push branch. */
const BASE_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'staging', 'production', 'release', 'trunk']);

/**
 * Shown when a session has no repositories and is blocked/done/stopped: lets the user push
 * one of its working copies to a repository they choose, or just attach a repository.
 */
function RescuePushCard({ w, reload }) {
  const { project } = useProject();
  const { toast } = useUi();

  // Working copies: handle both { copies: [...] } and a bare array.
  const copies = useLoad(() => api.get(`/api/workflows/${w.id}/working-copies`), [w.id]);
  const rawCopiesAll = copies.data
    ? Array.isArray(copies.data) ? copies.data : (copies.data.copies || [])
    : [];
  // A4: dedupe by path to avoid duplicate option keys.
  const rawCopies = rawCopiesAll.filter((c, i, arr) => arr.findIndex((x) => x.path === c.path) === i);

  // Connected repos for the project.
  const reposLoad = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const readyRepos = (reposLoad.data?.repos || []).filter((r) => r.status === 'ready');

  // Pick the newest copy whose repoId is set, else the newest copy overall.
  const defaultCopy = rawCopies.find((c) => c.repoId) ?? rawCopies[0] ?? null;

  const [selectedPath, setSelectedPath] = useState('');
  const [repoId, setRepoId] = useState('');
  const [branch, setBranch] = useState('');
  const [message, setMessage] = useState('');
  const [openPr, setOpenPr] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // When copies load, pre-fill from the best copy.
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !rawCopies.length) return;
    const c = defaultCopy;
    if (!c) return;
    setSelectedPath(c.path);
    setRepoId(c.repoId || (readyRepos[0]?.id ?? ''));
    // Prefill branch only if the copy's branch isn't a base/shared branch.
    const isSafe = c.branch && !BASE_BRANCHES.has(c.branch.toLowerCase());
    setBranch(isSafe ? c.branch : '');
    setPrefilled(true);
  }, [rawCopies.length, readyRepos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the selected copy changes, update repoId and branch.
  const handleCopyChange = useCallback((path) => {
    setSelectedPath(path);
    const c = rawCopies.find((x) => x.path === path);
    if (!c) return;
    setRepoId(c.repoId || (readyRepos[0]?.id ?? ''));
    const isSafe = c.branch && !BASE_BRANCHES.has(c.branch.toLowerCase());
    setBranch(isSafe ? c.branch : '');
  }, [rawCopies, readyRepos]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCopy = rawCopies.find((c) => c.path === selectedPath) ?? defaultCopy;
  const needsMessage = Boolean(selectedCopy?.dirty);

  const pushAction = useAction();
  const attachAction = useAction();

  const handlePush = async () => {
    await pushAction.run(async () => {
      const r = await api.post(`/api/workflows/${w.id}/push-copy`, {
        path: selectedCopy.path,
        repoId,
        branch: branch || undefined,
        message: message || undefined,
        pr: openPr || undefined,
      });
      const results = r.push?.results || [];
      const failed = results.filter((x) => !x.ok);
      if (r.push?.ok) {
        // pr is a URL string (same shape as history entries), not an object.
        const prUrl = results.find((x) => x.pr);
        toast(
          prUrl
            ? `Pushed — draft pull request at ${prUrl.pr}`
            : `Pushed to ${branch || 'new branch'}`,
          'ok',
        );
      } else {
        toast(failed.map((x) => x.error).join('; ') || 'Push failed', 'danger');
      }
      reload();
    });
  };

  // A3: post only { repoId } — branch is the new branch name and must not be sent as base branch.
  const handleAttach = async () => {
    await attachAction.run(async () => {
      await api.post(`/api/workflows/${w.id}/attach-repo`, { repoId });
      toast('Repository attached');
      reload();
    });
  };

  if (dismissed) return null;

  const canPush = Boolean(selectedCopy && repoId && (!needsMessage || message.trim()));
  // Attach only requires a repo; no working copy needed.
  const canAttach = Boolean(repoId);

  return (
    <section className="note note-info push-request" aria-label="Push this work to a repository">
      <div className="stack">
        <div className="row between wrap">
          <strong>Push this work to a repository</strong>
          <button type="button" className="icon-btn" onClick={() => setDismissed(true)} aria-label="Dismiss">
            <Icon name="x" size={15} />
          </button>
        </div>

        {/* A2: repo picker and Attach always visible, regardless of working copies */}
        <div className="row wrap">
          <Field label="Target repository">
            {(id) => (
              <select
                id={id}
                className="input"
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
                aria-required="true"
              >
                <option value="">Choose a repository…</option>
                {readyRepos.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="New branch name" hint="Leave empty and the server will derive one.">
            {(id) => (
              <input
                id={id}
                className="input mono"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="agent/feature-name (derived if empty)"
              />
            )}
          </Field>
        </div>

        {copies.loading ? (
          <p className="muted small">Loading working copies…</p>
        ) : rawCopies.length > 0 ? (
          <>
            {rawCopies.length > 1 ? (
              <Field label="Working copy">
                {(id) => (
                  <select id={id} className="input" value={selectedPath} onChange={(e) => handleCopyChange(e.target.value)}>
                    {rawCopies.map((c) => (
                      <option key={c.path} value={c.path}>
                        {c.repoName ? `${c.repoName} · ` : ''}{c.branch || 'unknown branch'}{c.dirty ? ' · uncommitted changes' : ''}
                        {c.subject ? ` — ${c.subject.slice(0, 60)}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : selectedCopy ? (
              <p className="small muted">
                {selectedCopy.repoName ? <><strong>{selectedCopy.repoName}</strong> · </> : null}
                {selectedCopy.branch ? <><code>{selectedCopy.branch}</code>{selectedCopy.subject ? ` — ${selectedCopy.subject.slice(0, 80)}` : ''}</> : 'No branch yet'}
                {selectedCopy.dirty ? ' · uncommitted changes' : ''}
              </p>
            ) : null}
            <Field
              label={needsMessage ? 'Commit message (required — there are uncommitted changes)' : 'Commit message (optional)'}
              error={needsMessage && !message.trim() ? 'Required when there are uncommitted changes' : undefined}
            >
              {(id) => (
                <input
                  id={id}
                  className="input"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Agent Portal: …"
                  aria-required={needsMessage}
                />
              )}
            </Field>
            <label className="row tight small push-pr">
              <input type="checkbox" checked={openPr} onChange={(e) => setOpenPr(e.target.checked)} />
              Open a draft pull request (GitHub)
            </label>
            <a className="small" href={`#/p/${w.project_id}/sessions/${w.id}?tab=changes`}>
              Review changes first
            </a>
          </>
        ) : (
          <p className="muted small">No working copies found. Use "Attach repository only" to connect this session to a repository.</p>
        )}

        {pushAction.error ? <ErrorNote error={pushAction.error} onClose={() => pushAction.setError(null)} /> : null}
        {attachAction.error ? <ErrorNote error={attachAction.error} onClose={() => attachAction.setError(null)} /> : null}
        <div className="row wrap">
          {rawCopies.length > 0 ? (
            <Button
              variant="primary"
              icon="branch"
              busy={pushAction.busy}
              disabled={!canPush || attachAction.busy}
              onClick={handlePush}
            >
              Push
            </Button>
          ) : null}
          <Button
            variant="ghost"
            busy={attachAction.busy}
            disabled={!canAttach || pushAction.busy}
            onClick={handleAttach}
            title="Attach the repository to this session without pushing"
          >
            Attach repository only
          </Button>
        </div>
        {!readyRepos.length && !reposLoad.loading ? (
          <p className="muted small">
            No repositories connected. <a href={href(project.id, 'repos')}>Connect one on the Repositories page.</a>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Hand a task of this session to a separate session. */
function DelegateDialog({ w, onClose, onDone }) {
  const { project } = useProject();
  const { toast } = useUi();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/workflows/${w.id}/delegate`, { title: title || undefined, goal });
      toast(`Started "${r.workflow.title}"`);
      onDone();
      onClose();
      go(project.id, 'sessions', r.workflow.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title="Delegate a task"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="play" busy={busy} disabled={!goal.trim()} onClick={start}>
            Start delegated session
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">
          A separate session takes the task, with its own working copy and branch of the same repositories, the same integrations, engine and limits. This session sees how it is doing and what it reports.
        </p>
        <Field label="Title (optional)">{(id) => <input id={id} className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Frontend: show the refund limit" />}</Field>
        <Field label="Task" hint="Everything the delegated session needs to know: it does not see this session's conversation.">
          {(id) => <textarea id={id} className="input" rows={6} value={goal} onChange={(e) => setGoal(e.target.value)} autoFocus />}
        </Field>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

/* ---------------- Live ---------------- */

/** The agents of one run of the session, live, with what the selected one is doing. */
/**
 * What people asked for, as they typed it: the session's goal, and the instructions an iteration picked up (those sent
 * after the previous iteration started and before this one did). Instructions not picked up yet are listed as waiting.
 */
function askedFor(w, events, runId) {
  const starts = events.filter((e) => e.kind === 'iteration' && /started$/.test(e.body) && e.run_id);
  const at = starts.findIndex((e) => e.run_id === runId);
  const human = events.filter((e) => e.kind === 'human');
  const from = at > 0 ? starts[at - 1].id : 0;
  const to = at >= 0 ? starts[at].id : Infinity;
  return {
    goal: w.goal,
    messages: human.filter((e) => e.id > from && e.id < to),
    waiting: runId === w.last_run_id ? human.filter((e) => !e.consumed) : [],
  };
}

function AskedCard({ asked }) {
  const msg = (e) => (
    <li key={e.id} className="ws-asked-msg">
      <span className="muted small">
        {e.data?.by || 'A teammate'} · {timeAgo(e.created_at)}
      </span>
      <p className="ws-asked-text">{e.body}</p>
    </li>
  );
  return (
    <section className="panel ws-asked" aria-label="What was asked">
      <details open={asked.messages.length === 0}>
        <summary className="small">
          <strong>Goal</strong>
        </summary>
        <p className="ws-asked-text">{asked.goal}</p>
      </details>
      {asked.messages.length ? (
        <>
          <h3 className="small">Your message{asked.messages.length === 1 ? '' : 's'} for this iteration</h3>
          <ul className="plain-list stack">{asked.messages.map(msg)}</ul>
        </>
      ) : null}
      {asked.waiting.length ? (
        <>
          <h3 className="small">Waiting for the next iteration</h3>
          <ul className="plain-list stack">{asked.waiting.map(msg)}</ul>
        </>
      ) : null}
    </section>
  );
}

function LiveTab({ runId, isLatest, runs, link, asked }) {
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
      {asked ? <AskedCard asked={asked} /> : null}
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
          ) : e.kind === 'push' ? (
            <div className="wf-body">
              <strong>{e.body}</strong>
              {(e.data.results || []).length > 1 || (e.data.results || []).some((r) => !r.ok || r.pr) ? (
                <ul className="plain-list small">
                  {e.data.results.map((r) => (
                    <li key={r.repo}>
                      {r.repo}: {r.ok ? <>pushed <code>{(r.commit || '').slice(0, 10)}</code>{r.pr ? <> · <a href={r.pr} target="_blank" rel="noreferrer">pull request</a></> : null}</> : <span className="danger">{r.error}</span>}
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
