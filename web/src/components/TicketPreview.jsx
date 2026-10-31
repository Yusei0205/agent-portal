/**
 * TicketPreview — full detail view for a single Jira ticket.
 *
 * Fetches from GET /api/projects/:pid/jira/issues/:key and renders:
 *   - Status badge, type, priority, assignee, reporter
 *   - Labels
 *   - Description (markdown, sanitised)
 *   - Attachment names
 *   - Collapsible comments (markdown, sanitised)
 *   - Optional "Start session with this ticket" primary button
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from './Icon.jsx';
import { Markdown } from './Markdown.jsx';

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function statusBadgeClass(statusCategory) {
  if (statusCategory === 'done') return 'badge badge-ok';
  if (statusCategory === 'indeterminate') return 'badge badge-info';
  return 'badge';
}

/**
 * @param {{
 *   projectId:       string,
 *   ticketKey:       string,
 *   onStartSession?: (ticket: object) => void,
 * }} props
 */
export function TicketPreview({ projectId, ticketKey, onStartSession }) {
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [showComments, setShowComments] = useState(false);

  const load = useCallback(async () => {
    if (!ticketKey) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(
        `/api/projects/${projectId}/jira/issues/${encodeURIComponent(ticketKey)}`,
      );
      setData(r.ticket ?? null);
    } catch (e) {
      setError(e.message || 'Could not load ticket');
    } finally {
      setLoading(false);
    }
  }, [projectId, ticketKey]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return (
      <div style={{ padding: '16px', textAlign: 'center' }}>
        <div className="spinner" style={{ margin: '0 auto' }} aria-label="Loading ticket…" />
      </div>
    );
  }
  if (error) {
    return (
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
    );
  }
  if (!data) return null;

  const t = data;
  const statusCategory =
    typeof t.status === 'object' ? t.status?.category : null;
  const statusName =
    typeof t.status === 'object' ? t.status?.name : t.status;

  return (
    <div
      className="ticket-preview stack"
      aria-label={`Ticket ${t.key}`}
    >
      {/* Heading row */}
      <div className="stack" style={{ gap: '0.4rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <strong style={{ flex: 1 }}>{t.summary}</strong>
          {t.url && (
            <a
              className="small"
              href={t.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ whiteSpace: 'nowrap' }}
            >
              Open in Jira <Icon name="external" size={13} />
            </a>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {statusName && (
            <span className={statusBadgeClass(statusCategory)}>
              {statusName}
            </span>
          )}
          {t.type && <span className="muted small">{t.type}</span>}
          {t.priority && (
            <span className="muted small">{t.priority} priority</span>
          )}
          {t.assignee && (
            <span className="muted small">Assigned to {t.assignee}</span>
          )}
          {t.reporter && (
            <span className="muted small">Reported by {t.reporter}</span>
          )}
        </div>

        {t.labels && t.labels.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {t.labels.map((l) => (
              <span key={l} className="badge">
                {l}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Description — prefer pre-rendered markdown, fall back to plain text */}
      <div className="ticket-body">
        {(t.descriptionMarkdown ?? t.description) ? (
          <Markdown text={t.descriptionMarkdown ?? t.description} />
        ) : (
          <p className="muted small">No description.</p>
        )}
      </div>

      {/* Attachments */}
      {t.attachments && t.attachments.length > 0 && (
        <p className="muted small">
          Attachments:{' '}
          {t.attachments
            .map(
              (a) =>
                `${a.filename}${a.size ? ` (${formatBytes(a.size)})` : ''}`,
            )
            .join(', ')}
        </p>
      )}

      {/* Comments */}
      {t.comments && t.comments.length > 0 && (
        <div className="stack" style={{ gap: '0.3rem' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ alignSelf: 'flex-start' }}
            aria-expanded={showComments}
            onClick={() => setShowComments((v) => !v)}
          >
            {showComments ? 'Hide' : 'Show'} {t.comments.length} comment
            {t.comments.length === 1 ? '' : 's'}
          </button>
          {showComments &&
            [...t.comments].reverse().map((c, i) => (
              /* eslint-disable-next-line react/no-array-index-key */
              <div key={i} className="ticket-comment">
                <span className="muted small">
                  {c.author}, {formatRelative(c.created)}
                </span>
                <Markdown text={c.bodyMarkdown || c.body || ''} />
              </div>
            ))}
        </div>
      )}

      {/* Primary CTA */}
      {onStartSession && (
        <button
          type="button"
          className="btn btn-primary"
          style={{ alignSelf: 'flex-start', marginTop: 4 }}
          onClick={() => onStartSession(t)}
          aria-label={`Start session with ticket ${t.key}`}
        >
          <Icon name="play" size={14} />
          Start session with this ticket
        </button>
      )}
    </div>
  );
}
