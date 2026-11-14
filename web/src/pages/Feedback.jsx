import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { href, navigate } from '../lib/router.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';

import { safeUrl } from '../lib/safeUrl.js';
const KINDS = [
  { value: 'bug', label: 'Something is broken' },
  { value: 'idea', label: 'Idea' },
  { value: 'question', label: 'Question' },
  { value: 'other', label: 'Other' },
];
const KIND_LABEL = { bug: 'Bug', idea: 'Idea', question: 'Question', other: 'Other' };
const STATUSES = [
  { value: 'new', label: 'New', tone: 'info' },
  { value: 'accepted', label: 'Accepted', tone: 'ok' },
  { value: 'in_progress', label: 'In progress', tone: 'info' },
  { value: 'in_review', label: 'In review', tone: 'warn' },
  { value: 'approved', label: 'Approved', tone: 'ok' },
  { value: 'fixed', label: 'Fixed', tone: 'ok' },
  { value: 'declined', label: 'Declined', tone: 'neutral' },
];
const STATUS = Object.fromEntries(STATUSES.map((s) => [s.value, s]));

// The page the person was on before opening Feedback, so the feedback can say where it came from.
let lastPage = typeof window !== 'undefined' && !window.location.hash.startsWith('#/feedback') ? window.location.hash : '';
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if (!window.location.hash.startsWith('#/feedback')) lastPage = window.location.hash;
  });
}

function StatusBadge({ status }) {
  const s = STATUS[status] || { label: status, tone: 'neutral' };
  return <span className={`badge badge-${s.tone}`}>{s.label}</span>;
}

/** Load a GET endpoint and keep it in state. */
function useLoad(path, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      setData(await api.get(path));
      setError(null);
    } catch (e) {
      setError(e.message || 'Could not load');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { setLoading(true); load(); }, [load]);
  return { data, error, loading, reload: load };
}

/**
 * Feedback: anyone sends it and follows it; admins sort it and hand it to a session on the portal's own code.
 * @param {{ user: { is_admin?: boolean }, route: { rest?: string[] } }} props
 */
export function Feedback({ user, route }) {
  const tab = route.rest?.[0] || 'send';
  const tabs = [
    { value: 'send', label: 'Send feedback' },
    { value: 'mine', label: 'Your feedback' },
  ];
  if (user.is_admin) tabs.push({ value: 'inbox', label: 'Inbox' });
  return (
    <div className="page">
      <PageHeader title="Feedback" description="Tell the portal admins what is broken, confusing or missing, and follow what happens to it here." />
      <div className="tab-bar" role="tablist">
        {tabs.map((t) => (
          <a
            key={t.value}
            role="tab"
            aria-selected={tab === t.value}
            className={`tab-btn${tab === t.value ? ' is-active' : ''}`}
            href={t.value === 'send' ? '#/feedback' : `#/feedback/${t.value}`}
            style={{ textDecoration: 'none' }}
          >
            {t.label}
          </a>
        ))}
      </div>
      {tab === 'inbox' && user.is_admin ? <AdminInbox /> : tab === 'mine' ? <Mine /> : <SendForm />}
    </div>
  );
}

function SendForm() {
  const [form, setForm] = useState({ kind: 'bug', title: '', body: '', page: lastPage });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/feedback', form);
      navigate('/feedback/mine');
    } catch (err) {
      setError(err.message || 'Could not send');
      setBusy(false);
    }
  };
  return (
    <section className="panel stack" style={{ maxWidth: 720 }}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="fb-kind">What kind of feedback?</label>
          <select id="fb-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fb-title">Summary <span className="muted small">(optional; the first line of your message is used if empty)</span></label>
          <input id="fb-title" maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="The session list does not scroll on a phone" />
        </div>
        <div className="field">
          <label htmlFor="fb-body">Details <span className="muted small">(what did you do, what did you expect, what happened?)</span></label>
          <textarea id="fb-body" rows={7} required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="fb-page">Page it is about <span className="muted small">(filled in from where you came from; clear it if it is not about a page)</span></label>
          <input id="fb-page" className="mono" maxLength={500} value={form.page} onChange={(e) => setForm({ ...form, page: e.target.value })} placeholder="#/p/…/sessions" />
        </div>
        {error && <div className="error-note" role="alert">{error}</div>}
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.body.trim()}>{busy ? 'Sending…' : 'Send feedback'}</button>
        </div>
      </form>
    </section>
  );
}

function Mine() {
  const list = useLoad('/api/feedback/mine', []);
  if (list.loading && !list.data) return <div className="spinner" aria-label="Loading…" />;
  if (list.error) return <div className="error-note" role="alert">{list.error}</div>;
  const items = list.data.feedback;
  if (!items.length) {
    return (
      <div className="ws-placeholder" style={{ padding: '40px 0' }}>
        <Icon name="inbox" size={36} />
        <p>No feedback yet</p>
        <p className="small muted">Anything you send shows up here with its status.</p>
      </div>
    );
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table" style={{ minWidth: 520 }}>
        <thead><tr><th>Feedback</th><th>Type</th><th>Status</th><th>Sent</th></tr></thead>
        <tbody>
          {items.map((f) => (
            <tr key={f.id}>
              <td>
                <strong>{f.title}</strong>
                {f.pr_url ? <div className="small"><a href={safeUrl(f.pr_url)} target="_blank" rel="noreferrer">See the change</a></div> : null}
              </td>
              <td>{KIND_LABEL[f.kind]}</td>
              <td><StatusBadge status={f.status} /></td>
              <td className="muted small">{formatRelative(f.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminInbox() {
  const [status, setStatus] = useState('new');
  const [picked, setPicked] = useState(false);
  const [openId, setOpenId] = useState(null);
  const list = useLoad(`/api/feedback${status === 'all' ? '' : `?status=${status}`}`, [status]);
  const counts = list.data?.counts || {};
  const items = list.data?.feedback || [];
  const open = items.find((f) => f.id === openId);

  // Land on what needs a decision when something is waiting.
  useEffect(() => {
    if (picked || !list.data) return;
    setPicked(true);
    if (list.data.counts.in_review && status === 'new') setStatus('in_review');
  }, [list.data, picked, status]);

  const choose = (v) => { setPicked(true); setStatus(v); };
  const options = [...STATUSES.map((s) => ({ value: s.value, label: s.label, count: counts[s.value] })), { value: 'all', label: 'All' }];

  return (
    <div className="stack">
      <div className="actions-row" role="group" aria-label="Status">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`btn btn-sm ${status === o.value ? 'btn-primary' : 'btn-outline'}`}
            aria-pressed={status === o.value}
            onClick={() => choose(o.value)}
          >
            {o.label}{o.count ? ` ${o.count}` : ''}
          </button>
        ))}
      </div>
      {list.data && !list.data.target ? (
        <p className="muted small">
          To let an agent work on feedback, add the portal's own repository to a project (Workspaces → Repositories), then use <em>Send to agent</em> on any
          item and pick that repository. It is remembered for next time.
        </p>
      ) : null}
      {list.loading && !list.data ? (
        <div className="spinner" aria-label="Loading…" />
      ) : list.error ? (
        <div className="error-note" role="alert">{list.error}</div>
      ) : !items.length ? (
        <div className="ws-placeholder" style={{ padding: '32px 0' }}><p>Nothing here</p><p className="small muted">No feedback with this status.</p></div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ minWidth: 640 }}>
            <thead><tr><th>Feedback</th><th>From</th><th>Type</th><th>Status</th><th>Change</th><th>Sent</th></tr></thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <td><button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpenId(f.id)}>{f.title}</button></td>
                  <td>{f.user_name || 'Deleted user'}</td>
                  <td>{KIND_LABEL[f.kind]}</td>
                  <td><StatusBadge status={f.status} /></td>
                  <td>{f.pr_url ? <a href={safeUrl(f.pr_url)} target="_blank" rel="noreferrer">Pull request</a> : f.workflow_id ? <span className="muted small">Session running</span> : <span className="muted small">None</span>}</td>
                  <td className="muted small">{formatRelative(f.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open ? <Detail item={open} target={list.data.target} onClose={() => setOpenId(null)} onChanged={list.reload} /> : null}
    </div>
  );
}

function Detail({ item, target, onClose, onChanged }) {
  const { confirmState, requestConfirm } = useConfirm();
  const [form, setForm] = useState({ status: item.status, admin_note: item.admin_note || '', pr_url: item.pr_url || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const dirty = form.status !== item.status || form.admin_note !== (item.admin_note || '') || form.pr_url !== (item.pr_url || '');

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); await onChanged(); } catch (e) { setError(e.message || 'Something went wrong'); } finally { setBusy(false); }
  };
  const save = () => run(() => api.patch(`/api/feedback/${item.id}`, form));
  const approve = () => run(() => api.post(`/api/feedback/${item.id}/approve`, {}));
  const reject = async () => {
    const ok = await requestConfirm('Reject these changes? The feedback is marked declined. Close the pull request on the git host yourself.', 'Reject', 'danger');
    if (ok) run(() => api.post(`/api/feedback/${item.id}/reject`, { reason }));
  };
  const pr = item.pr;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label={item.title}>
        <div className="modal-header">
          <h2>{item.title}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="stack-lg">
          <section className="stack">
            <p className="muted small">
              {KIND_LABEL[item.kind]} from {item.user_name || 'a deleted user'}, {formatRelative(item.created_at)}
              {item.page ? <>{' '}· about {/^#\//.test(item.page) ? <a href={item.page}>{item.page}</a> : <code>{item.page}</code>}</> : null}
            </p>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: '12px 14px', maxHeight: 280, overflowY: 'auto' }}>{item.body}</div>
          </section>

          <section className="stack">
            <div className="field">
              <label htmlFor="fb-status">Status</label>
              <select id="fb-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="fb-note">Your note <span className="muted small">(not shown to the sender; added to the agent's instructions when you send it to one)</span></label>
              <textarea id="fb-note" rows={3} value={form.admin_note} onChange={(e) => setForm({ ...form, admin_note: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="fb-pr">Pull request <span className="muted small">(filled in when the session opens one; the sender sees this link)</span></label>
              <input id="fb-pr" className="mono" value={form.pr_url} onChange={(e) => setForm({ ...form, pr_url: e.target.value })} placeholder="https://github.com/…/pull/12" />
            </div>
            <div><button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</button></div>
          </section>

          {item.workflow_id ? (
            <section className="panel stack">
              <h3>The agent's session</h3>
              <p className="small">
                <a href={href(item.project_id, 'sessions', item.workflow_id)}>Open the session</a>
                {pr ? <span className="muted"> · pull request {pr.state.replace('-', ' ')}{pr.error ? `: ${pr.error}` : ''}</span> : <span className="muted"> · no pull request yet. Open the session, and use its pull request button when the agent is done.</span>}
              </p>
              {item.status === 'in_review' ? (
                <>
                  <p className="muted small">
                    Check the change{item.pr_url ? <> on <a href={safeUrl(item.pr_url)} target="_blank" rel="noreferrer">the pull request</a></> : null}. Approving records your decision here;
                    merge the pull request on the git host. To ask for changes, write to the agent in its session.
                  </p>
                  <div className="actions-row"><button type="button" className="btn btn-primary" onClick={approve} disabled={busy}>Approve</button></div>
                  <div className="field">
                    <label htmlFor="fb-reason">Reject <span className="muted small">(optional reason, kept with the feedback)</span></label>
                    <input id="fb-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not something we want to change" />
                  </div>
                  <div><button type="button" className="btn btn-danger" onClick={reject} disabled={busy}>Reject changes</button></div>
                </>
              ) : null}
            </section>
          ) : null}

          {item.decided_at && item.status !== 'in_review' ? (
            <p className="muted small">
              {STATUS[item.status]?.label || item.status} by {item.decided_by_name || 'an admin'}, {formatRelative(item.decided_at)}
              {item.decision_note ? `: “${item.decision_note}”` : ''}
            </p>
          ) : null}

          <SendToAgent item={item} note={form.admin_note} target={target} onStarted={onChanged} />
          {error && <div className="error-note" role="alert">{error}</div>}
        </div>
      </div>
      <ConfirmDialog state={confirmState} />
    </div>
  );
}

function SendToAgent({ item, note, target, onStarted }) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(target?.projectId || item.project_id || '');
  const [repoId, setRepoId] = useState(target?.repoId || item.repo_id || '');
  const [repos, setRepos] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/projects').then((r) => setProjects(r.projects || [])).catch(() => setProjects([]));
  }, []);
  useEffect(() => {
    let live = true;
    setRepos(null);
    if (!projectId) { setRepos([]); return undefined; }
    api.get(`/api/projects/${projectId}/repos`)
      .then((r) => { if (live) setRepos(r.repos || []); })
      .catch(() => { if (live) setRepos([]); });
    return () => { live = false; };
  }, [projectId]);
  useEffect(() => {
    if (repos && !repos.some((r) => r.id === repoId)) setRepoId(repos[0]?.id || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { prompt } = await api.post(`/api/feedback/${item.id}/prompt`, { note });
      // An ordinary session on that repository. It asks before changes (trustTools stays off).
      const { workflow } = await api.post(`/api/projects/${projectId}/workflows`, { goal: prompt, repoIds: [repoId] });
      await api.post(`/api/projects/${projectId}/workflows/${workflow.id}/start`);
      await api.patch(`/api/feedback/${item.id}`, { workflow_id: workflow.id, project_id: projectId, repo_id: repoId });
      await api.put('/api/feedback/target', { repoId });
      await onStarted();
      navigate(href(projectId, 'sessions', workflow.id));
    } catch (e) {
      setError(e.message || 'Could not start the session');
      setBusy(false);
    }
  };

  return (
    <section className="panel stack">
      <h3>Send to agent</h3>
      <p className="muted small">
        Starts a session on the repository below with the feedback and your note. It asks before every change. When the agent finishes, open the session's
        pull request there; the pull request and its code review then show up here for you to approve.
      </p>
      <div className="two-col">
        <div className="field">
          <label htmlFor="fb-proj">Project</label>
          <select id="fb-proj" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Choose…</option>
            {projects.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fb-repo">Repository with the portal's code</label>
          <select id="fb-repo" value={repoId} onChange={(e) => setRepoId(e.target.value)} disabled={!repos?.length}>
            {(repos || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {projectId && repos && !repos.length ? <span className="muted small">This project has no repository yet.</span> : null}
        </div>
      </div>
      {error && <div className="error-note" role="alert">{error}</div>}
      <div className="actions-row">
        <button type="button" className="btn btn-primary" disabled={busy || !repoId || !projectId} onClick={start}>
          {busy ? 'Starting…' : item.workflow_id ? 'Start a new session' : 'Start agent session'}
        </button>
        {item.workflow_id ? <span className="muted small">This replaces the session linked above.</span> : null}
      </div>
    </section>
  );
}
