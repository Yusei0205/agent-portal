/**
 * Mail: today's inbox from the mail accounts the person connected (Connect › Tools & services), a message opens in
 * full when its row is clicked, and a button starts an agent session to summarise the day's mail. The agent reads the
 * mail through the same mail tools; nothing is sent.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.jsx';
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

/** "Name <a@b.c>" → "Name"; a bare address stays as it is. */
function senderName(from) {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return m ? m[1] : from;
}

function MessageDetail({ provider, id }) {
  const [state, setState] = useState({ loading: true, message: null, error: null });
  useEffect(() => {
    let live = true;
    api.get(`/api/mail/${provider}/${encodeURIComponent(id)}`)
      .then((r) => { if (live) setState({ loading: false, message: r.message, error: null }); })
      .catch((e) => { if (live) setState({ loading: false, message: null, error: e.message || 'Could not open this message' }); });
    return () => { live = false; };
  }, [provider, id]);

  if (state.loading) return <div className="spinner" style={{ width: 18, height: 18, margin: '10px 0' }} aria-label="Loading message…" />;
  if (state.error) return <p className="error-note" role="alert">{state.error}</p>;
  const m = state.message;
  return (
    <div className="mail-detail" style={{ padding: '10px 0 4px' }}>
      <dl className="muted small" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: '0 0 10px' }}>
        <dt>From</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{m.from}</dd>
        <dt>To</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{m.to}</dd>
        {m.cc && (<><dt>Cc</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{m.cc}</dd></>)}
        <dt>Date</dt><dd style={{ margin: 0 }}>{m.date}</dd>
        {m.attachments.length > 0 && (<><dt>Attachments</dt><dd style={{ margin: 0 }}>{m.attachments.join(', ')}</dd></>)}
      </dl>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, fontFamily: 'inherit', fontSize: '0.9rem', maxHeight: '60vh', overflow: 'auto' }}>
        {m.text || '(no text)'}
      </pre>
    </div>
  );
}

export default function Mail({ projectId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [open, setOpen] = useState(null); // `${provider}:${id}`
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
    <div className="page">
      <PageHeader title="Mail" description="Today's inbox from the mail accounts you connected. Click a message to read it. Read only.">
        <button type="button" className="btn" onClick={load} disabled={loading}>Refresh</button>
        <button type="button" className="btn btn-primary" onClick={openSummary} disabled={loading || accounts.length === 0}>
          Summarise mail
        </button>
      </PageHeader>

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
          <section key={`${a.provider}:${a.email}`} aria-label={`${a.provider} ${a.email}`} style={{ minWidth: 0 }}>
            <h2 style={{ marginBottom: 6 }}>
              <span style={{ textTransform: 'capitalize' }}>{a.provider}</span>{' '}
              <span className="muted small" style={{ textTransform: 'none' }}>{a.email}</span>
            </h2>
            {a.error ? (
              <p className="error-note" role="alert">{a.error}</p>
            ) : a.messages.length === 0 ? (
              <p className="muted">Nothing received today.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {a.messages.map((m) => {
                  const key = `${a.provider}:${m.id}`;
                  const isOpen = open === key;
                  return (
                    <li key={m.id} style={{ borderBottom: '1px solid var(--line-2)' }}>
                      <button
                        type="button"
                        onClick={() => setOpen(isOpen ? null : key)}
                        aria-expanded={isOpen}
                        style={{
                          display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '2px 12px', width: '100%',
                          textAlign: 'left', background: 'none', border: 0, color: 'inherit', font: 'inherit',
                          padding: '10px 4px', cursor: 'pointer',
                        }}
                      >
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <strong style={{ fontWeight: m.unread ? 700 : 500 }}>{m.subject}</strong>
                          <span className="muted small"> — {senderName(m.from)}</span>
                        </span>
                        <span className="muted small">{when(m.date)}</span>
                        {m.snippet && !isOpen && (
                          <span className="muted small" style={{ gridColumn: '1 / -1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {m.snippet}
                          </span>
                        )}
                      </button>
                      {isOpen && <MessageDetail provider={a.provider} id={m.id} />}
                    </li>
                  );
                })}
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
