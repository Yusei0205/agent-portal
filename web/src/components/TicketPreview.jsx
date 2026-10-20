import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useAsync.js';
import { timeAgo } from '../lib/util.js';
import { Icon } from './Icon.jsx';
import { Markdown } from './Markdown.jsx';
import { Badge, ErrorNote, Spinner } from './ui.jsx';

const TONE = { new: 'muted', indeterminate: 'accent', done: 'ok' };

/** A Jira ticket read inside the portal: status, description, related tickets, attachments and comments. */
export function TicketPreview({ projectId, ticketKey }) {
  const detail = useLoad(() => api.get(`/api/projects/${projectId}/jira/issues/${encodeURIComponent(ticketKey)}`), [projectId, ticketKey]);
  const [showComments, setShowComments] = useState(false);
  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error) return <ErrorNote error={detail.error} />;
  const t = detail.data?.issue;
  if (!t) return null;
  return (
    <div className="ticket-preview stack" aria-label={`Ticket ${t.key}`}>
      <div className="stack" style={{ gap: '0.4rem' }}>
        <div className="row between wrap">
          <strong>{t.summary}</strong>
          <a className="small" href={t.url} target="_blank" rel="noopener noreferrer">
            Open in Jira <Icon name="external" size={13} />
          </a>
        </div>
        <div className="row tight wrap small">
          <Badge tone={TONE[t.status.category] || 'muted'}>{t.status.name}</Badge>
          {t.type ? <span className="muted">{t.type}</span> : null}
          {t.priority ? <span className="muted">{t.priority} priority</span> : null}
          <span className="muted">{t.assignee ? `Assigned to ${t.assignee}` : 'Unassigned'}</span>
          {t.reporter ? <span className="muted">Reported by {t.reporter}</span> : null}
        </div>
        {t.labels.length || t.components.length ? (
          <div className="row tight wrap">
            {t.components.map((c) => <Badge key={`c${c}`} tone="accent">{c}</Badge>)}
            {t.labels.map((l) => <Badge key={l} tone="muted">{l}</Badge>)}
          </div>
        ) : null}
      </div>
      <div className="ticket-body">{t.description ? <Markdown text={t.description} /> : <p className="muted small">No description.</p>}</div>
      {t.parent || t.links.length || t.subtasks.length || t.attachments.length ? (
        <ul className="plain-list small">
          {t.parent ? <li><span className="muted">parent</span> <code>{t.parent.key}</code> {t.parent.summary}</li> : null}
          {t.links.map((l, i) => (
            <li key={`l${i}`}><span className="muted">{l.relation}</span> <code>{l.key}</code> {l.summary} <Badge tone="muted">{l.status}</Badge></li>
          ))}
          {t.subtasks.map((s) => (
            <li key={s.key}><span className="muted">sub-task</span> <code>{s.key}</code> {s.summary} <Badge tone="muted">{s.status}</Badge></li>
          ))}
          {t.attachments.length ? <li className="muted">Attachments: {t.attachments.map((a) => a.filename).join(', ')} (the agents see names only)</li> : null}
        </ul>
      ) : null}
      {t.comments.length ? (
        <div className="stack" style={{ gap: '0.3rem' }}>
          <button type="button" className="linkish small" onClick={() => setShowComments((v) => !v)}>
            {showComments ? 'Hide' : 'Show'} {t.comments.length} comment{t.comments.length === 1 ? '' : 's'}{showComments ? ' (newest first)' : ''}
          </button>
          {showComments
            ? [...t.comments].reverse().map((c, i) => (
                <div key={i} className="ticket-comment">
                  <span className="muted small">{c.author}, {timeAgo(c.created)}</span>
                  <Markdown text={c.body} />
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}
