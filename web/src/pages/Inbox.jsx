/**
 * Inbox — cross-project view of everything that needs a human.
 *
 * Items:
 *  - waiting    : agent questions / approvals (answer inline)
 *  - push_ready : push requests (review changes link, allow/decline inline)
 *  - plan_pending: plan approvals (view/edit/approve inline)
 *  - escalation : blocked sessions (reply to unblock)
 *  - done       : recently done sessions with PR link and Code review hand-off
 *
 * Live updates via GET /api/inbox/events SSE stream.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onInboxCount } from '../lib/api.js';
import { go, href, sessionHref } from '../lib/router.js';
import { cx, timeAgo } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Badge, Button, Empty, ErrorNote, Field, PageHeader, Spinner, useUi } from '../components/ui.jsx';
import { useApp } from '../lib/context.js';

// ─── Browser notification support ─────────────────────────────────────────────

function useInboxNotifications(items, prevCount) {
  const { toast } = useUi();

  // Request permission only when the user explicitly clicks a button
  const requestPermission = useCallback(async () => {
    if (!('Notification' in window)) {
      toast('Browser notifications are not supported in this browser', 'warn');
      return;
    }
    if (Notification.permission === 'granted') {
      toast('Browser notifications are already enabled', 'ok');
      return;
    }
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      toast('Browser notifications enabled — you will be notified when items enter your Inbox', 'ok');
    } else {
      toast('Browser notifications were not enabled', 'warn');
    }
  }, [toast]);

  const notifEnabled = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const notifSupported = 'Notification' in window;

  return { requestPermission, notifEnabled, notifSupported };
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

const FILTER_OPTIONS = [
  { value: 'needs_you', label: 'Needs you' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
];

function FilterBar({ filter, project, projects, onFilter, onProject }) {
  return (
    <div className="inbox-filters" role="search" aria-label="Filter inbox">
      <div className="inbox-filter-group">
        <label className="field-label" htmlFor="inbox-filter-mode">Show</label>
        <div className="segmented segmented-sm" role="tablist" aria-label="Inbox filter">
          {FILTER_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="tab"
              aria-selected={filter === o.value}
              className={cx(filter === o.value && 'is-active')}
              onClick={() => onFilter(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="inbox-filter-group">
        <label className="field-label" htmlFor="inbox-project">Project</label>
        <select
          id="inbox-project"
          className="input input-sm"
          value={project || ''}
          onChange={(e) => onProject(e.target.value || null)}
        >
          <option value="">All projects</option>
          {(projects || []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ─── Kind labels ──────────────────────────────────────────────────────────────

const KIND_BADGE = {
  waiting: { label: 'Needs you', tone: 'warn' },
  push_ready: { label: 'Push ready', tone: 'accent' },
  plan_pending: { label: 'Plan ready', tone: 'accent' },
  escalation: { label: 'Blocked', tone: 'danger' },
  done: { label: 'Done', tone: 'ok' },
};

// ─── Individual inbox card ────────────────────────────────────────────────────

/**
 * A waiting (question / approval) card with inline answer field.
 */
function WaitingCard({ item, onDone }) {
  const { toast } = useUi();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      // Post answer as a workflow instruction
      await api.post(`/api/workflows/${item.workflowId}/messages`, { body: answer });
      toast('Answer sent', 'ok');
      setOpen(false);
      setAnswer('');
      onDone();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx('inbox-card', item.isOverdue && 'inbox-overdue')} role="article" aria-label={`Waiting: ${item.sessionTitle}`}>
      <div className="inbox-card-head">
        <Badge tone={KIND_BADGE.waiting.tone}>{item.isOverdue ? '⏰ Overdue' : KIND_BADGE.waiting.label}</Badge>
        <span className="inbox-project">{item.projectName}</span>
        <span className="muted small">{timeAgo(item.createdAt)}</span>
      </div>
      <div className="inbox-card-title">
        <a href={sessionHref(item.projectId, item.workflowId, { tab: 'history' })}>
          {item.sessionTitle}
        </a>
      </div>
      {item.detail ? <p className="inbox-detail">{item.detail}</p> : null}
      <div className="inbox-card-actions">
        <Button size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Cancel' : 'Answer'}
        </Button>
        <a className="btn btn-ghost btn-sm" href={sessionHref(item.projectId, item.workflowId, { tab: 'history' })}>
          Open session
        </a>
      </div>
      {open ? (
        <div className="inbox-answer-wrap">
          <Field label="Your answer">
            {(id) => (
              <textarea
                id={id}
                className="input"
                rows={3}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Type your answer…"
                aria-describedby={`${id}-hint`}
                autoFocus
              />
            )}
          </Field>
          <p id="inbox-answer-hint" className="field-hint">
            The agent will continue from where it is.
          </p>
          <div className="row tight">
            <Button variant="primary" size="sm" busy={busy} onClick={send}>Send answer</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A push-ready card with allow / decline inline actions.
 */
function PushCard({ item, onDone }) {
  const { toast } = useUi();
  const [busy, setBusy] = useState('');

  const act = async (what) => {
    setBusy(what);
    try {
      if (what === 'allow') {
        const r = await api.post(`/api/workflows/${item.workflowId}/push/allow`, {});
        toast(r.push?.ok ? 'Pushed successfully' : 'Push completed with warnings', r.push?.ok ? 'ok' : 'warn');
      } else {
        await api.post(`/api/workflows/${item.workflowId}/push/deny`, {});
        toast('Push declined', 'ok');
      }
      onDone();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="inbox-card" role="article" aria-label={`Push ready: ${item.sessionTitle}`}>
      <div className="inbox-card-head">
        <Badge tone={KIND_BADGE.push_ready.tone}>{KIND_BADGE.push_ready.label}</Badge>
        <span className="inbox-project">{item.projectName}</span>
        <span className="muted small">{timeAgo(item.createdAt)}</span>
      </div>
      <div className="inbox-card-title">
        <a href={sessionHref(item.projectId, item.workflowId, { tab: 'changes' })}>
          {item.sessionTitle}
        </a>
      </div>
      {item.detail ? <p className="inbox-detail">{item.detail}</p> : null}
      <div className="inbox-card-actions">
        <Button variant="primary" size="sm" busy={busy === 'allow'} onClick={() => act('allow')}>Push</Button>
        <Button variant="danger" size="sm" busy={busy === 'decline'} onClick={() => act('decline')}>Decline</Button>
        <a className="btn btn-ghost btn-sm" href={sessionHref(item.projectId, item.workflowId, { tab: 'changes' })}>
          Review changes
        </a>
      </div>
    </div>
  );
}

/**
 * A plan-pending card with view/edit/approve inline.
 */
function PlanCard({ item, onDone }) {
  const { toast } = useUi();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState('');
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    try {
      await api.post(`/api/workflows/${item.workflowId}/approve-plan`, { planEdit: edit });
      toast('Plan approved — session will carry on', 'ok');
      setOpen(false);
      onDone();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inbox-card" role="article" aria-label={`Plan ready: ${item.sessionTitle}`}>
      <div className="inbox-card-head">
        <Badge tone={KIND_BADGE.plan_pending.tone}>{KIND_BADGE.plan_pending.label}</Badge>
        <span className="inbox-project">{item.projectName}</span>
        <span className="muted small">{timeAgo(item.createdAt)}</span>
      </div>
      <div className="inbox-card-title">
        <a href={sessionHref(item.projectId, item.workflowId)}>
          {item.sessionTitle}
        </a>
      </div>
      {item.detail ? <p className="inbox-detail">{item.detail}</p> : null}
      <div className="inbox-card-actions">
        <Button size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Cancel' : 'View and approve'}
        </Button>
        <a className="btn btn-ghost btn-sm" href={sessionHref(item.projectId, item.workflowId)}>
          Open session
        </a>
      </div>
      {open ? (
        <div className="inbox-answer-wrap">
          <Field label="Edits to the plan (optional)">
            {(id) => (
              <textarea
                id={id}
                className="input"
                rows={3}
                value={edit}
                onChange={(e) => setEdit(e.target.value)}
                placeholder="Leave empty to approve as-is, or type your changes…"
                autoFocus
              />
            )}
          </Field>
          <div className="row tight">
            <Button variant="primary" size="sm" busy={busy} onClick={approve}>Approve plan</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * An escalation (blocked) card with reply-to-unblock inline.
 */
function EscalationCard({ item, onDone }) {
  const { toast } = useUi();
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/workflows/${item.workflowId}/messages`, { body: reply });
      toast('Instruction sent — the session will resume', 'ok');
      setOpen(false);
      setReply('');
      onDone();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    try {
      await api.post(`/api/workflows/${item.workflowId}/dismiss-escalation`, {});
      toast('Dismissed', 'ok');
      onDone();
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  return (
    <div className="inbox-card inbox-escalation" role="article" aria-label={`Blocked: ${item.sessionTitle}`}>
      <div className="inbox-card-head">
        <Badge tone={KIND_BADGE.escalation.tone}>{KIND_BADGE.escalation.label}</Badge>
        <span className="inbox-project">{item.projectName}</span>
        <span className="muted small">{timeAgo(item.createdAt)}</span>
      </div>
      <div className="inbox-card-title">
        <a href={sessionHref(item.projectId, item.workflowId)}>
          {item.sessionTitle}
        </a>
      </div>
      {item.detail ? <p className="inbox-detail">{item.detail}</p> : null}
      <div className="inbox-card-actions">
        <Button size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Cancel' : 'Reply to unblock'}
        </Button>
        <Button variant="ghost" size="sm" onClick={dismiss}>Dismiss</Button>
        <a className="btn btn-ghost btn-sm" href={sessionHref(item.projectId, item.workflowId)}>
          Open session
        </a>
      </div>
      {open ? (
        <div className="inbox-answer-wrap">
          <Field label="Instructions for the agent">
            {(id) => (
              <textarea
                id={id}
                className="input"
                rows={3}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Tell the agent what to do next…"
                autoFocus
              />
            )}
          </Field>
          <div className="row tight">
            <Button variant="primary" size="sm" busy={busy} onClick={send}>Send and resume</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A running card — just a status update, no action required.
 */
function RunningCard({ item }) {
  const isQueued = item.kind === 'queued';
  return (
    <div className={cx('inbox-card', isQueued ? 'inbox-queued' : 'inbox-running')} role="article" aria-label={`${isQueued ? 'Queued' : 'Running'}: ${item.sessionTitle}`}>
      <div className="inbox-card-head">
        <Badge status={isQueued ? 'queued' : 'running'}>{isQueued ? 'Queued' : 'Running'}</Badge>
        <span className="inbox-project">{item.projectName}</span>
        <span className="muted small">{timeAgo(item.createdAt)}</span>
      </div>
      <div className="inbox-card-title">
        <a href={sessionHref(item.projectId, item.workflowId)}>
          {item.sessionTitle}
        </a>
      </div>
      {item.detail ? <p className="inbox-detail">{item.detail}</p> : null}
      <div className="inbox-card-actions">
        <a className="btn btn-ghost btn-sm" href={sessionHref(item.projectId, item.workflowId)}>
          Open session
        </a>
      </div>
    </div>
  );
}

/**
 * A done card with PR link and Code review hand-off.
 */
function DoneCard({ item }) {
  // Build the code review link: prefer PR number, fall back to branch, fall back to plain review page.
  let reviewHref;
  if (item.prUrl) {
    // Extract PR number from the URL if it's a GitHub PR URL (e.g. https://github.com/owner/repo/pull/42)
    const prMatch = item.prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prMatch ? prMatch[1] : null;
    if (prNumber && item.repoId) {
      reviewHref = `#/p/${item.projectId}/review?repo=${encodeURIComponent(item.repoId)}&pr=${prNumber}`;
    } else if (item.repoId) {
      reviewHref = `#/p/${item.projectId}/review?repo=${encodeURIComponent(item.repoId)}`;
    } else {
      reviewHref = `#/p/${item.projectId}/review`;
    }
  } else if (item.workBranch && item.repoId) {
    reviewHref = `#/p/${item.projectId}/review?repo=${encodeURIComponent(item.repoId)}&branch=${encodeURIComponent(item.workBranch)}`;
  } else if (item.repoId) {
    reviewHref = `#/p/${item.projectId}/review?repo=${encodeURIComponent(item.repoId)}`;
  } else {
    reviewHref = `#/p/${item.projectId}/review`;
  }

  return (
    <div className="inbox-card inbox-done" role="article" aria-label={`Done: ${item.sessionTitle}`}>
      <div className="inbox-card-head">
        <Badge tone={KIND_BADGE.done.tone}>{KIND_BADGE.done.label}</Badge>
        <span className="inbox-project">{item.projectName}</span>
        <span className="muted small">{timeAgo(item.createdAt)}</span>
      </div>
      <div className="inbox-card-title">
        <a href={sessionHref(item.projectId, item.workflowId)}>
          {item.sessionTitle}
        </a>
      </div>
      {item.detail ? <p className="inbox-detail muted">{item.detail}</p> : null}
      <div className="inbox-card-actions">
        {item.prUrl ? (
          <a className="btn btn-primary btn-sm" href={item.prUrl} target="_blank" rel="noopener noreferrer">
            Open PR ↗
          </a>
        ) : null}
        <a className="btn btn-ghost btn-sm" href={reviewHref}>
          Code review
        </a>
        <a className="btn btn-ghost btn-sm" href={sessionHref(item.projectId, item.workflowId)}>
          Open session
        </a>
      </div>
    </div>
  );
}

function InboxCard({ item, onDone }) {
  switch (item.kind) {
    case 'waiting': return <WaitingCard item={item} onDone={onDone} />;
    case 'push_ready': return <PushCard item={item} onDone={onDone} />;
    case 'plan_pending': return <PlanCard item={item} onDone={onDone} />;
    case 'escalation': return <EscalationCard item={item} onDone={onDone} />;
    case 'done': return <DoneCard item={item} />;
    case 'queued': return <RunningCard item={item} />;
    default: return <RunningCard item={item} />;
  }
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function Inbox() {
  const { projects } = useApp();
  const [filter, setFilter] = useState('needs_you');
  const [project, setProject] = useState(null);
  const [items, setItems] = useState(null);
  const [needsYou, setNeedsYou] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const prevNeedsYou = useRef(0);
  const { toast } = useUi();
  const { requestPermission, notifEnabled, notifSupported } = useInboxNotifications();

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (project) params.set('project', project);
      params.set('filter', filter);
      const r = await api.get(`/api/inbox?${params}`);
      setItems(r.items);
      setNeedsYou(r.needs_you ?? 0);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [filter, project]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // SSE badge updates + browser notifications
  useEffect(() => {
    // The count comes from the app's one shared inbox stream; no second connection here.
    const close = onInboxCount((data) => {
        const newCount = data.needs_you ?? 0;
        const prev = prevNeedsYou.current;
        prevNeedsYou.current = newCount;
        setNeedsYou(newCount);
        // Browser notification when count increases
        if (newCount > prev && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('Agent Portal Inbox', {
            body: `${newCount} item${newCount === 1 ? '' : 's'} need${newCount === 1 ? 's' : ''} your attention`,
            icon: '/favicon.svg',
          });
        }
        // Refresh list silently when count changes
        load();
    });
    return () => {
      close();
    };
  }, [load]);

  // In-app toast when new items arrive (even without notification permission)
  useEffect(() => {
    prevNeedsYou.current = needsYou;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = items
    ? {
        needs_you: items.filter((i) => ['waiting', 'push_ready', 'plan_pending', 'escalation'].includes(i.kind)),
        running: items.filter((i) => i.kind === 'running' || i.kind === 'queued'),
        done: items.filter((i) => i.kind === 'done'),
      }
    : { needs_you: [], running: [], done: [] };

  const visibleItems = filter === 'needs_you'
    ? grouped.needs_you
    : filter === 'running'
      ? grouped.running
      : filter === 'done'
        ? grouped.done
        : items ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Inbox"
        sub={needsYou > 0 ? `${needsYou} item${needsYou === 1 ? '' : 's'} need${needsYou === 1 ? 's' : ''} you` : 'Nothing waiting for you right now'}
        actions={
          notifSupported && !notifEnabled ? (
            <Button variant="default" size="sm" onClick={requestPermission} title="Get browser notifications when items arrive">
              Enable notifications
            </Button>
          ) : null
        }
      />
      <div className="toolbar">
        <FilterBar
          filter={filter}
          project={project}
          projects={projects}
          onFilter={setFilter}
          onProject={setProject}
        />
      </div>
      {loading ? (
        <div className="pad"><Spinner /></div>
      ) : error ? (
        <ErrorNote error={error} onClose={() => setError(null)} />
      ) : visibleItems.length === 0 ? (
        <Empty icon="inbox" title={filter === 'needs_you' ? 'Nothing needs you right now' : `No ${filter} items`}>
          {filter === 'needs_you'
            ? 'When agents have questions, push requests, or plan approvals, they appear here.'
            : filter === 'done'
              ? 'Completed sessions from the last 24 hours will show here.'
              : 'All active sessions appear here.'}
        </Empty>
      ) : (
        <div className="inbox-list" aria-live="polite" aria-label="Inbox items">
          {visibleItems.map((item, i) => (
            <InboxCard key={`${item.kind}-${item.workflowId}-${i}`} item={item} onDone={load} />
          ))}
        </div>
      )}
    </div>
  );
}
