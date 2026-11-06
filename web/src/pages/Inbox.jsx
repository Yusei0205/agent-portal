import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { href } from '../lib/router.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { PageHeader, SectionHead } from '../components/PageHeader.jsx';

// ── Helpers ────────────────────────────────────────────────────────────────────

function groupByType(items) {
  const groups = {
    approval: [],
    question: [],
    blocked: [],
    push: [],
    'review-ready': [],
  };
  for (const item of items) {
    const key = item.type in groups ? item.type : 'blocked';
    groups[key].push(item);
  }
  const result = [];
  if (groups.approval.length) result.push({ key: 'approval', label: 'Approvals', items: groups.approval });
  if (groups.question.length) result.push({ key: 'question', label: 'Questions', items: groups.question });
  if (groups.blocked.length) result.push({ key: 'blocked', label: 'Blocked sessions', items: groups.blocked });
  if (groups.push.length) result.push({ key: 'push', label: 'Pending pushes', items: groups.push });
  if (groups['review-ready'].length) result.push({ key: 'review-ready', label: 'Review ready', items: groups['review-ready'] });
  return result;
}

function payloadSummary(item) {
  const p = item.payload;
  if (!p || typeof p !== 'object') return null;
  if (p.description) return String(p.description).slice(0, 200);
  if (p.command) return `Command: ${String(p.command).slice(0, 160)}`;
  if (p.message) return String(p.message).slice(0, 200);
  if (p.question) return String(p.question).slice(0, 200);
  return null;
}

/** What the agent wants to do: the tool, and the part of its input a person decides on. */
function approvalContext(item) {
  const p = item.payload || {};
  const input = p.toolInput && typeof p.toolInput === 'object' ? p.toolInput : {};
  const main =
    input.command ?? input.cmd ?? input.url ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? null;
  const detail = input.description ?? null;
  let text = main != null ? String(main) : '';
  if (!text) {
    const rest = Object.entries(input).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
    text = rest;
  }
  return {
    tool: p.toolName ? String(p.toolName) : 'Tool call',
    detail: detail ? String(detail) : '',
    text: text.length > 1200 ? text.slice(0, 1200) + '…' : text,
  };
}

// ── Item renderers ─────────────────────────────────────────────────────────────

function ApprovalItem({ item, onResolved }) {
  const isPush = item.type === 'push';
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [resolutionLabel, setResolutionLabel] = useState('');
  const { toast, toasts, removeToast } = useToast();

  const resolve = async (response) => {
    setBusy(true);
    try {
      const inputHash = item.payload?.inputHash ?? null;
      await api.post(`/api/inbox/${item.id}/resolve`, { response, inputHash });
      setResolved(true);
      setResolutionLabel(response === 'approve' ? (isPush ? 'Pull request creation requested' : 'Approved') : (isPush ? 'Declined' : 'Denied'));
      if (onResolved) onResolved();
    } catch (e) {
      toast(e.message, 'error');
      setBusy(false);
      if (onResolved) onResolved();
    }
  };

  const ctx = isPush
    ? { tool: item.payload?.title || 'Open a pull request?', detail: '', text: item.payload?.body || 'Approve to push the session changes and create a pull request.' }
    : approvalContext(item);

  return (
    <div className={`inbox-item${resolved ? ' inbox-item-resolved' : ''}`}>
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div className="inbox-item-meta">
        {item.project_name && (
          <span className="badge">{item.project_name}</span>
        )}
        {isPush && item.project_id && item.workflow_id ? (
          <a className="inbox-item-session" href={href(item.project_id, 'sessions', item.workflow_id)}>Open session</a>
        ) : item.workflow_goal ? (
          <span className="inbox-item-session" title={item.workflow_goal}>
            {item.workflow_goal.length > 50 ? item.workflow_goal.slice(0, 49) + '…' : item.workflow_goal}
          </span>
        ) : item.workflow_id ? (
          <a className="inbox-item-session" href={`/projects/${item.project_id}/sessions/${item.workflow_id}`}>Open session</a>
        ) : null}
        <span className="muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', fontSize: '0.78rem' }}>
          {formatRelative(item.created_at)}
        </span>
      </div>
      <p className="inbox-item-body"><strong>{ctx.tool}</strong>{isPush ? '' : ' wants to run'}{ctx.detail ? ` — ${ctx.detail}` : ''}</p>
      {ctx.text && (
        <pre className="inbox-item-code" style={{ margin: '6px 0 10px', padding: '8px 10px', borderRadius: 6, background: 'rgba(0,0,0,0.25)', fontSize: '0.78rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflow: 'auto' }}>{ctx.text}</pre>
      )}
      {resolved ? (
        <div className="inbox-item-resolved-note">
          <Icon name="check" size={14} />
          {resolutionLabel}
        </div>
      ) : (
        <div className="inbox-item-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => resolve('approve')}
            disabled={busy}
          >
            {isPush ? 'Approve and create pull request' : 'Approve'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => resolve(isPush ? 'decline' : 'deny')}
            disabled={busy}
          >
            {isPush ? 'Decline' : 'Deny'}
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionItem({ item, onResolved }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const { toast, toasts, removeToast } = useToast();

  const question = item.payload?.question || payloadSummary(item) || 'Answer required';

  const submit = async () => {
    const text = answer.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/inbox/${item.id}/resolve`, { response: text });
      setResolved(true);
      if (onResolved) onResolved();
    } catch (e) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };

  const summary = payloadSummary(item);

  return (
    <div className={`inbox-item${resolved ? ' inbox-item-resolved' : ''}`}>
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div className="inbox-item-meta">
        {item.project_name && (
          <span className="badge">{item.project_name}</span>
        )}
        {item.workflow_goal && (
          <span className="inbox-item-session" title={item.workflow_goal}>
            {item.workflow_goal.length > 50 ? item.workflow_goal.slice(0, 49) + '…' : item.workflow_goal}
          </span>
        )}
        <span className="muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', fontSize: '0.78rem' }}>
          {formatRelative(item.created_at)}
        </span>
      </div>
      <p className="inbox-item-body">{summary || question}</p>
      {resolved ? (
        <div className="inbox-item-resolved-note">
          <Icon name="check" size={14} />
          Answered
        </div>
      ) : (
        <div className="inbox-item-answer-row">
          <input
            type="text"
            placeholder="Type your answer…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            aria-label="Answer to agent question"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={submit}
            disabled={!answer.trim() || busy}
          >
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

function GenericItem({ item, onResolved }) {
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const { toast, toasts, removeToast } = useToast();
  const summary = payloadSummary(item);

  const dismiss = async () => {
    setBusy(true);
    try {
      await api.post(`/api/inbox/${item.id}/resolve`, { response: 'dismissed' });
      setResolved(true);
      if (onResolved) onResolved();
    } catch (e) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };

  return (
    <div className={`inbox-item${resolved ? ' inbox-item-resolved' : ''}`}>
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div className="inbox-item-meta">
        {item.project_name && <span className="badge">{item.project_name}</span>}
        {item.workflow_goal && (
          <span className="inbox-item-session" title={item.workflow_goal}>
            {item.workflow_goal.length > 50 ? item.workflow_goal.slice(0, 49) + '…' : item.workflow_goal}
          </span>
        )}
        <span className="muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', fontSize: '0.78rem' }}>
          {formatRelative(item.created_at)}
        </span>
      </div>
      {summary && <p className="inbox-item-body">{summary}</p>}
      {resolved ? (
        <div className="inbox-item-resolved-note">
          <Icon name="check" size={14} />
          Dismissed
        </div>
      ) : (
        <div className="inbox-item-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={dismiss}
            disabled={busy}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export function InboxItem({ item, onResolved }) {
  if (item.type === 'approval' || item.type === 'push') return <ApprovalItem item={item} onResolved={onResolved} />;
  if (item.type === 'question') return <QuestionItem item={item} onResolved={onResolved} />;
  return <GenericItem item={item} onResolved={onResolved} />;
}

// ── Main page ──────────────────────────────────────────────────────────────────

/**
 * Inbox page — lists all items that need a person.
 */
export function Inbox() {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get('/api/inbox?limit=100');
      setItems(data.items || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = items ? groupByType(items) : [];
  const total = items?.length ?? 0;

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      {/* Page header */}
      <PageHeader title={total > 0 ? `Inbox (${total})` : 'Inbox'} description="Approvals and notifications that are waiting for you.">
        <button
          type="button"
          className="btn"
          onClick={load}
          title="Refresh inbox"
          aria-label="Refresh inbox"
        >
          <Icon name="refresh" size={15} />
          Refresh
        </button>
      </PageHeader>

      {loading && !items && (
        <div style={{ padding: '32px 0', textAlign: 'center' }}>
          <div className="spinner" style={{ margin: '0 auto' }} aria-label="Loading inbox…" />
        </div>
      )}

      {error && (
        <div className="error-note" role="alert">
          {error}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={load}
            style={{ marginLeft: 8 }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && groups.length === 0 && (
        <div className="ws-placeholder" style={{ padding: '48px 0' }}>
          <Icon name="inbox" size={40} />
          <p>Inbox is empty</p>
          <p className="small muted">Approvals, questions and blocked sessions appear here.</p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h2 style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--ink-3)', marginBottom: 8, fontWeight: 650 }}>
            {g.label}{' '}
            <span style={{ fontWeight: 400 }}>{g.items.length}</span>
          </h2>
          <div className="stack" style={{ gap: 8 }}>
            {g.items.map((item) => (
              <InboxItem key={item.id} item={item} onResolved={load} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
