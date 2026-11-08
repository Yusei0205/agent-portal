/**
 * Mail: today's inbox from the mail accounts the person connected (Connect › Tools & services), and a button that
 * starts an agent session to summarise it. The agent reads the mail through the same mail tools; nothing is sent.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { NewSessionDialog } from './sessions/NewSessionDialog.jsx';

/** Local midnight of today. */
export function startOfToday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** What the agent is asked to do (exported so the wording is tested). */
export function summaryGoal(since, providers) {
  const where = providers.length ? providers.join(' and ') : 'mail';
  return [
    `Summarise the email I received in my ${where} inbox since ${since.toLocaleString()} (today).`,
    'Use the mail tools to list those messages and read the ones that matter.',
    'Give: (1) a three-line overview, (2) messages that need a reply or action, with sender, subject and any deadline, (3) the rest grouped by topic or sender.',
    'This is read only: do not send, draft, delete or move anything.',
  ].join('\n');
}

function when(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

export default function Mail({ projectId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [project, setProject] = useState({ id: projectId, name: '' });
  const [repos, setRepos] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const since = startOfToday();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get(`/api/mail/today?since=${encodeURIComponent(startOfToday().toISOString())}`));
    } catch (e) {
      setError(e.message || 'Could not load mail');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openSummary = async () => {
    // The session dialog needs the project's repositories and workspaces.
    const [p, r, w] = await Promise.all([
      api.get(`/api/projects/${projectId}`).catch(() => null),
      api.get(`/api/projects/${projectId}/repos`).catch(() => null),
      api.get(`/api/projects/${projectId}/workspaces`).catch(() => null),
    ]);
    if (p?.project) setProject(p.project);
    setRepos(r?.repos ?? []);
    setWorkspaces(w?.workspaces ?? []);
    setDialog(true);
  };

  const accounts = data?.accounts ?? [];
  const total = accounts.reduce((n, a) => n + a.messages.length, 0);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Mail</h1>
        <p className="muted">Today's inbox from the mail accounts you connected. Read only.</p>
      </div>

      <div className="actions-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn" onClick={load} disabled={loading}>Refresh</button>
        <button type="button" className="btn btn-primary" onClick={openSummary} disabled={loading || accounts.length === 0}>
          Summarise mail
        </button>
      </div>

      {loading ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}><div className="spinner" aria-label="Loading mail…" /></div>
      ) : error ? (
        <p className="error-note" role="alert">{error}</p>
      ) : accounts.length === 0 ? (
        <div className="empty-state">
          <p>No mail account connected.</p>
          <p className="muted small" style={{ marginTop: 6 }}>
            Connect Gmail under <a href="#/connect/tools">Connect › Tools &amp; services</a>.
          </p>
        </div>
      ) : (
        accounts.map((a) => (
          <section key={`${a.provider}:${a.email}`} aria-label={`${a.provider} ${a.email}`}>
            <h2 style={{ textTransform: 'capitalize' }}>{a.provider} <span className="muted small">{a.email}</span></h2>
            {a.error ? (
              <p className="error-note" role="alert">{a.error}</p>
            ) : a.messages.length === 0 ? (
              <p className="muted">Nothing received today.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {a.messages.map((m) => (
                  <li key={m.id} style={{ borderBottom: '1px solid var(--line-2)', padding: '10px 0' }}>
                    <div className="row wrap" style={{ gap: 10 }}>
                      <strong style={{ fontWeight: m.unread ? 700 : 500 }}>{m.subject}</strong>
                      <span className="muted small">{m.from}</span>
                      <span className="muted small push">{when(m.date)}</span>
                    </div>
                    {m.snippet && <p className="muted small" style={{ margin: '4px 0 0' }}>{m.snippet}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
      {!loading && accounts.length > 0 && <p className="muted small">{total} message{total === 1 ? '' : 's'} today (up to 50 per account).</p>}

      {dialog && (
        <NewSessionDialog
          project={project}
          repos={repos}
          workspaces={workspaces}
          onClose={() => setDialog(false)}
          initialGoal={summaryGoal(since, accounts.map((a) => a.provider))}
        />
      )}
    </div>
  );
}
