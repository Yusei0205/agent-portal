import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';

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

// ── Item renderers ─────────────────────────────────────────────────────────────

function ApprovalItem({ item, onResolved }) {
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [resolutionLabel, setResolutionLabel] = useState('');

  const resolve = async (response) => {
    setBusy(true);
    try {
      await api.post(`/api/inbox/${item.id}/resolve`, { response });
      setResolved(true);
      setResolutionLabel(response === 'approve' ? 'Approved' : 'Denied');
      if (onResolved) onResolved();
    } catch (e) {
      alert(e.message);
      setBusy(false);
    }
  };

  const summary = payloadSummary(item);

  return (
    <div className={`inbox-item${resolved ? ' inbox-item-resolved' : ''}`}>
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
      {summary && <p className="inbox-item-body">{summary}</p>}
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
            Approve
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => resolve('deny')}
            disabled={busy}
          >
            Deny
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
      alert(e.message);
      setBusy(false);
    }
  };

  const summary = payloadSummary(item);

  return (
    <div className={`inbox-item${resolved ? ' inbox-item-resolved' : ''}`}>
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
  const summary = payloadSummary(item);

  const dismiss = async () => {
    setBusy(true);
    try {
      await api.post(`/api/inbox/${item.id}/resolve`, { response: 'dismissed' });
      setResolved(true);
      if (onResolved) onResolved();
    } catch (e) {
      alert(e.message);
      setBusy(false);
    }
  };

  return (
    <div className={`inbox-item${resolved ? ' inbox-item-resolved' : ''}`}>
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

function InboxItem({ item, onResolved }) {
  if (item.type === 'approval') return <ApprovalItem item={item} onResolved={onResolved} />;
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
      <div className="page-head">
        <h1>Inbox {total > 0 && <span className="muted" style={{ fontWeight: 400, fontSize: '0.9em' }}>({total})</span>}</h1>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={load}
            title="Refresh inbox"
            aria-label="Refresh inbox"
          >
            <Icon name="refresh" size={15} />
            Refresh
          </button>
        </div>
      </div>

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
