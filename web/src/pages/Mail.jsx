/**
 * Mail: today's inbox from the mail accounts the person connected (Connect › Tools & services), a message opens in
 * full when its row is clicked, and a button starts an agent session to summarise the day's mail. The agent reads the
 * mail through the same mail tools. When the person allows drafting, the agent also saves reply drafts, which the person
 * reviews, edits (recipients included) and sends from this page; the agent never sends.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { PageHeader } from '../components/PageHeader.jsx';
import { NewSessionDialog } from './sessions/NewSessionDialog.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';

/** Local midnight of today. */
export function startOfToday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** What the agent is asked to do (exported so the wording is tested). */
export function summaryGoal(since, providers, allowDrafts = false) {
  const where = providers.length ? providers.join(' and ') : 'mail';
  return [
    `Summarise the email I received in my ${where} inbox since ${since.toLocaleString()} (today).`,
    'Use the mail tools to list those messages and read the ones that matter.',
    'Give: (1) a three-line overview, (2) messages that need a reply or action, with sender, subject and any deadline, (3) the rest grouped by topic or sender.',
    ...(allowDrafts
      ? [
        'For each message that needs a follow-up reply, save a reply draft with create_draft: put the sender in to, copy Message-ID into inReplyTo and the Thread value into threadId (both from read_message), keep the subject as "Re: …", and write the reply in my voice.',
        'Never call send_mail: I review every draft on the Mail page, adjust the recipients, and send it myself. Mention each draft you saved in the summary. Do not delete or move anything.',
      ]
      : ['This is read only: do not send, draft, delete or move anything.']),
  ].join('\n');
}

/** "A <a@b.c>, d@e.f" → ["A <a@b.c>", "d@e.f"] (commas inside quotes do not split). */
export function splitAddresses(list) {
  return (list || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((a) => a.trim()).filter(Boolean);
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
/** True for a bare address or "Name <address>". */
export function isAddress(v) {
  const m = v.match(/<([^<>]+)>\s*$/);
  return EMAIL.test((m ? m[1] : v).trim());
}

function Recipients({ label, value, onChange }) {
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const add = () => {
    const parts = text.split(/[;,]/).map((a) => a.trim()).filter(Boolean);
    if (!parts.length) return;
    if (!parts.every(isAddress)) { setBad(true); return; }
    setBad(false);
    onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setText('');
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '2.5rem minmax(0, 1fr)', gap: 8, alignItems: 'start', marginBottom: 6 }}>
      <span className="muted small" style={{ paddingTop: 6 }}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0 }}>
        {value.map((r) => (
          <span key={r} className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--line-2)', borderRadius: 999, padding: '2px 4px 2px 10px', overflowWrap: 'anywhere' }}>
            {r}
            <button type="button" aria-label={`Remove ${r}`} onClick={() => onChange(value.filter((x) => x !== r))}
              style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: '0 6px', font: 'inherit' }}>×</button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); setBad(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
          onBlur={add}
          placeholder="Add address"
          aria-label={`Add to ${label}`}
          aria-invalid={bad}
          style={{ flex: '1 1 160px', minWidth: 0 }}
        />
        {bad && <span className="error-note small" role="alert">Not an email address</span>}
      </div>
    </div>
  );
}

function DraftCard({ draft, onChanged, requestConfirm }) {
  const [to, setTo] = useState(() => splitAddresses(draft.to));
  const [cc, setCc] = useState(() => splitAddresses(draft.cc));
  const [bcc, setBcc] = useState(() => splitAddresses(draft.bcc));
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const edit = () => ({ to: to.join(', '), cc: cc.join(', '), bcc: bcc.join(', '), subject, body });
  const run = async (fn) => {
    setBusy(true); setNote(null);
    try { await fn(); } catch (e) { setNote(e.message || 'Something went wrong'); } finally { setBusy(false); }
  };
  const url = `/api/mail/drafts/${encodeURIComponent(draft.id)}`;
  const save = () => run(async () => { await api.put(url, edit()); setNote('Saved'); });
  const send = () => run(async () => {
    if (!to.length) { setNote('Add at least one recipient before sending.'); return; }
    const all = [...to.map((r) => `To: ${r}`), ...cc.map((r) => `Cc: ${r}`), ...bcc.map((r) => `Bcc: ${r}`)].join('\n');
    if (!await requestConfirm(`Send this email now?\n\n${all}\n\nSubject: ${subject}`, 'Send', 'primary')) return;
    await api.put(url, edit());
    await api.post(`${url}/send`);
    onChanged(draft.id, 'Email sent.');
  });
  const discard = () => run(async () => {
    if (!await requestConfirm('Discard this draft? It is deleted from Gmail.', 'Discard', 'danger')) return;
    await api.delete(url);
    onChanged(draft.id, 'Draft discarded (deleted from Gmail).');
  });

  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ margin: '0 0 12px', padding: '8px 12px', borderLeft: '3px solid var(--line-2)', overflowWrap: 'anywhere' }}>
        <div className="muted small">Replying to</div>
        {draft.replyingTo ? (
          <>
            <div><strong>{draft.replyingTo.subject}</strong></div>
            <div className="muted small">{senderName(draft.replyingTo.from)}{draft.replyingTo.date ? ` · ${draft.replyingTo.date}` : ''}</div>
            {draft.replyingTo.snippet && <div className="muted small" style={{ marginTop: 4 }}>{draft.replyingTo.snippet}</div>}
          </>
        ) : (
          <div className="muted small">The original message could not be found (the agent did not link this draft to one).</div>
        )}
      </div>
      <Recipients label="To" value={to} onChange={setTo} />
      <Recipients label="Cc" value={cc} onChange={setCc} />
      <Recipients label="Bcc" value={bcc} onChange={setBcc} />
      <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" style={{ width: '100%', margin: '6px 0' }} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" rows={8} style={{ width: '100%', resize: 'vertical' }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>Send</button>
        <button type="button" className="btn" onClick={save} disabled={busy}>Save changes</button>
        <button type="button" className="btn btn-danger" onClick={discard} disabled={busy}>Discard</button>
        {note && <span className="muted small" role="status">{note}</span>}
      </div>
    </div>
  );
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
    <div
      className="mail-detail"
      style={{
        background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 10,
        padding: '14px 16px', margin: '4px 0 12px', boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
      }}
    >
      <dl className="muted small" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: '0 0 12px', paddingBottom: 12, borderBottom: '1px solid var(--line-2)' }}>
        <dt>From</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{m.from}</dd>
        <dt>To</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{m.to}</dd>
        {m.cc && (<><dt>Cc</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{m.cc}</dd></>)}
        <dt>Date</dt><dd style={{ margin: 0 }}>{m.date}</dd>
        {m.attachments.length > 0 && (<><dt>Attachments</dt><dd style={{ margin: 0 }}>{m.attachments.join(', ')}</dd></>)}
      </dl>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, fontFamily: 'inherit', fontSize: '0.9rem', lineHeight: 1.5, maxHeight: '60vh', overflow: 'auto' }}>
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
  const [drafts, setDrafts] = useState([]);
  const [draftError, setDraftError] = useState(null);
  const [draftNotice, setDraftNotice] = useState(null);
  const { confirmState, requestConfirm } = useConfirm();
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

  const allowSend = data?.allowSend === true;

  const loadDrafts = useCallback(async () => {
    setDraftError(null);
    try { setDrafts((await api.get('/api/mail/drafts')).drafts ?? []); }
    catch (e) { setDraftError(e.message || 'Could not load drafts'); }
  }, []);

  const draftGone = useCallback((id, message) => {
    setDrafts((list) => list.filter((d) => d.id !== id)); // gone at once; the list is re-read below
    setDraftNotice(message);
    loadDrafts();
  }, [loadDrafts]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (allowSend) loadDrafts(); else setDrafts([]); }, [allowSend, loadDrafts]);

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
      <PageHeader title="Mail" description="Today's inbox from the mail accounts you connected. Click a message to read it. Nothing is sent without your review.">
        <button type="button" className="btn" onClick={() => { load(); if (allowSend) loadDrafts(); }} disabled={loading}>Refresh</button>
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
      {!loading && accounts.length > 0 && (
        <section aria-label="Follow-up drafts" style={{ marginTop: 20 }}>
          <h2 style={{ marginBottom: 6 }}>Follow-up drafts</h2>
          {draftNotice && <p className="muted small" role="status">{draftNotice}</p>}
          {!allowSend ? (
            <p className="muted small">
              Turn on “Let agents draft and send email as me” under <a href="#/connect/tools">Connect › Tools &amp; services</a> and the summary will also draft replies here for you to review.
            </p>
          ) : draftError ? (
            <p className="error-note" role="alert">{draftError}</p>
          ) : drafts.length === 0 ? (
            <p className="muted small">No drafts yet. Summarise mail and any reply the agent drafts shows up here. Nothing is sent until you press Send.</p>
          ) : (
            drafts.map((d) => <DraftCard key={d.id} draft={d} onChanged={draftGone} requestConfirm={requestConfirm} />)
          )}
        </section>
      )}
      {!loading && accounts.length > 0 && <p className="muted small">{total} message{total === 1 ? '' : 's'} today (up to 50 per account).</p>}

      {dialog && (
        <NewSessionDialog
          project={project}
          repos={repos}
          workspaces={workspaces}
          onClose={() => setDialog(false)}
          initialGoal={summaryGoal(since, accounts.map((a) => a.provider), allowSend)}
        />
      )}
      <ConfirmDialog state={confirmState} />
    </div>
  );
}
