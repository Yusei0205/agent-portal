/**
 * PullRequestCards: one card per repository, driven by the latest
 * `pull-request` event for that repository.
 */

import { useState } from 'react';
import { Icon } from '../../components/Icon.jsx';
import { api } from '../../lib/api.js';
import { sessionPullRequestCards, describePullRequest } from '../../lib/pullRequestCard.js';

function Card({ event, workflowId, projectId }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const d = describePullRequest(event, { projectId });

  const create = async () => {
    setBusy(true);
    setMsg('');
    try {
      await api.post(`/api/sessions/${encodeURIComponent(workflowId)}/pull-request`, { repoId: event.repoId });
    } catch (err) {
      setMsg(err?.message || 'Could not start the pull request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="run-outputs-card" role="region" aria-label={`Pull request: ${event.repo ?? ''}`}>
      <div className="run-outputs-card-header">
        <Icon name="file" size={13} aria-hidden="true" />
        <span>{d.title}</span>
        <span className={`badge badge-${d.tone}`} style={{ marginLeft: 'auto' }}>{event.state}</span>
      </div>
      {(d.detail || msg) && (
        <div style={{ padding: '8px 12px', display: 'grid', gap: 4, overflowWrap: 'anywhere' }}>
          {d.detail && <span>{d.detail}</span>}
          {msg && <span className="error-note" role="alert">{msg}</span>}
        </div>
      )}
      {d.actions.length > 0 && (
        <div className="run-outputs-card-footer">
          {d.actions.map((a) => (a.kind === 'link' ? (
            <a
              key={a.label}
              className="btn btn-sm btn-ghost"
              href={a.href}
              {...(/^https?:/i.test(a.href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >{a.label}</a>
          ) : (
            <button key={a.label} type="button" className="btn btn-sm" onClick={create} disabled={busy}>
              {busy ? 'Working…' : a.label}
            </button>
          )))}
        </div>
      )}
    </div>
  );
}

export function PullRequestCards({ events, workflowId, projectId }) {
  const states = sessionPullRequestCards(events);
  if (!states.length) return null;
  return states.map((ev) => (
    <Card key={ev.repo ?? ev.repoId} event={ev} workflowId={workflowId} projectId={projectId} />
  ));
}
