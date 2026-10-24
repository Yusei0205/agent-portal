import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { go, href } from '../../lib/router.js';
import { cx, money } from '../../lib/util.js';
import { ConnectionBadge } from '../../components/ConnectionBadge.jsx';
import { Badge, Button, ErrorNote, Field, Modal, Note, Progress, useUi } from '../../components/ui.jsx';
import { budgetOf, statusOf } from './status.js';
import { PushRequestCard, RescuePushCard } from './SessionBanners.jsx';

/* ---------------- Header ---------------- */

export function SessionHeader({ w, canEdit, reload, leads }) {
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
        {(() => {
          // Always show the engine chip: use the explicit engine value or fall back to the provider.
          const engineLabel = w.engine === 'kiro' ? 'Kiro' : w.engine === 'claude' ? 'Claude Code' : w.provider === 'kiro' ? 'Kiro' : 'Claude Code';
          return <span className="chip-static small" title="The engine this session runs on">{engineLabel}</span>;
        })()}
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
            {(() => {
              const lead = leads?.find((l) => l.name === w.lead_agent);
              if (!lead) return null;
              return <span className="muted"> ({lead.kind === 'kiro' ? 'Kiro agent' : 'Claude Code agent'})</span>;
            })()}
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
