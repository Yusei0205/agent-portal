import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { go, href, previousPage } from '../lib/router.js';
import { useAction, useLoad } from '../lib/useAsync.js';
import { timeAgo } from '../lib/util.js';
import { Badge, Button, Empty, ErrorNote, Field, Modal, Note, PageHeader, Segmented, Spinner, Tabs, useUi } from '../components/ui.jsx';

const KINDS = [
  { value: 'bug', label: 'Something is broken' },
  { value: 'idea', label: 'Idea' },
  { value: 'question', label: 'Question' },
  { value: 'other', label: 'Other' },
];
const KIND_LABEL = { bug: 'Bug', idea: 'Idea', question: 'Question', other: 'Other' };
const STATUSES = [
  { value: 'new', label: 'New', tone: 'accent' },
  { value: 'accepted', label: 'Accepted', tone: 'ok' },
  { value: 'in_progress', label: 'In progress', tone: 'accent' },
  { value: 'in_review', label: 'In review', tone: 'warn' },
  { value: 'approved', label: 'Approved', tone: 'ok' },
  { value: 'fixed', label: 'Fixed', tone: 'ok' },
  { value: 'declined', label: 'Declined', tone: 'muted' },
];
const STATUS = Object.fromEntries(STATUSES.map((s) => [s.value, s]));

function StatusBadge({ status }) {
  const s = STATUS[status] || { label: status, tone: 'muted' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Feedback({ route }) {
  const { user } = useApp();
  const tab = route.rest[0] || 'send';
  const tabs = [
    { value: 'send', label: 'Send feedback', href: href(null, 'feedback') },
    { value: 'mine', label: 'Your feedback', href: href(null, 'feedback', 'mine') },
  ];
  if (user.is_admin) tabs.push({ value: 'inbox', label: 'Inbox', href: href(null, 'feedback', 'inbox') });
  return (
    <div className="page">
      <PageHeader title="Feedback" sub="Tell the portal admins what is broken, confusing or missing, and follow what happens to it here." />
      <Tabs tabs={tabs} value={tab} />
      {tab === 'inbox' && user.is_admin ? <Inbox /> : tab === 'mine' ? <Mine /> : <SendForm />}
    </div>
  );
}

function SendForm() {
  const { toast } = useUi();
  const [form, setForm] = useState({ kind: 'bug', title: '', body: '', page: previousPage() });
  const act = useAction();
  const submit = (e) => {
    e.preventDefault();
    act
      .run(async () => {
        await api.post('/api/feedback', form);
        toast('Thanks, your feedback was sent');
        go(null, 'feedback', 'mine');
      })
      .catch(() => {});
  };
  return (
    <section className="panel narrow-panel">
      <form className="stack" onSubmit={submit}>
        <Field label="What kind of feedback?">
          <Segmented label="Kind" value={form.kind} onChange={(kind) => setForm({ ...form, kind })} options={KINDS} />
        </Field>
        <Field label="Summary" hint="One line. Optional; the first line of your message is used if you leave it empty.">
          {(id) => <input id={id} className="input" maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Run tree does not scroll on a phone" />}
        </Field>
        <Field label="Details" hint="What did you do, what did you expect, and what happened instead?">
          {(id) => <textarea id={id} className="input" rows={7} required value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />}
        </Field>
        <Field label="Page it is about" hint="Filled in with the page you came from. Clear it if it is not about a page.">
          {(id) => <input id={id} className="input mono" maxLength={500} value={form.page} onChange={(e) => setForm({ ...form, page: e.target.value })} placeholder="#/p/…/runs" />}
        </Field>
        <ErrorNote error={act.error} />
        <div className="row">
          <Button type="submit" variant="primary" busy={act.busy} disabled={!form.body.trim()}>
            Send feedback
          </Button>
        </div>
      </form>
    </section>
  );
}

function Mine() {
  const list = useLoad(() => api.get('/api/feedback/mine'), []);
  if (list.loading && !list.data) return <div className="pad"><Spinner /></div>;
  if (list.error) return <ErrorNote error={list.error} />;
  const items = list.data.feedback;
  if (!items.length) {
    return (
      <Empty icon="inbox" title="No feedback yet" action={<a className="btn btn-default" href={href(null, 'feedback')}>Send feedback</a>}>
        Anything you send shows up here with its status.
      </Empty>
    );
  }
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Feedback</th>
            <th>Type</th>
            <th>Status</th>
            <th>Sent</th>
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr key={f.id}>
              <td>
                <strong>{f.title}</strong>
                {f.pr_url ? (
                  <div className="small">
                    <a href={f.pr_url} target="_blank" rel="noreferrer">See the change</a>
                  </div>
                ) : null}
              </td>
              <td>{KIND_LABEL[f.kind]}</td>
              <td>
                <StatusBadge status={f.status} />
              </td>
              <td className="muted small">{timeAgo(f.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Inbox() {
  const [status, setStatus] = useState('new');
  // Land on what needs a decision when there is something waiting.
  const [picked, setPicked] = useState(false);
  const [openId, setOpenId] = useState(null);
  const list = useLoad(() => api.get(`/api/feedback${status === 'all' ? '' : `?status=${status}`}`), [status]);
  const counts = list.data?.counts || {};
  const items = list.data?.feedback || [];
  const open = items.find((f) => f.id === openId);
  useEffect(() => {
    if (picked || !list.data) return;
    setPicked(true);
    if (list.data.counts.in_review && status === 'new') setStatus('in_review');
  }, [list.data, picked, status]);
  const choose = (v) => {
    setPicked(true);
    setStatus(v);
  };
  return (
    <div className="stack">
      <div className="row wrap">
        <Segmented
          label="Status"
          value={status}
          onChange={choose}
          options={[...STATUSES.map((s) => ({ value: s.value, label: s.label, count: counts[s.value] })), { value: 'all', label: 'All' }]}
        />
      </div>
      {!list.data?.target ? (
        <Note tone="info">
          <span>
          To let agents work on feedback, create a project for the portal itself, connect the portal's own repository under its <em>Repositories</em>, then
          use <em>Send to agent</em> on any item. The repository you pick is remembered.
          </span>
        </Note>
      ) : null}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : !items.length ? (
        <Empty icon="inbox" title="Nothing here">No feedback with this status.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Feedback</th>
                <th>From</th>
                <th>Type</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <td>
                    <button className="linkish" onClick={() => setOpenId(f.id)}>
                      {f.title}
                    </button>
                  </td>
                  <td>{f.user_name || 'Deleted user'}</td>
                  <td>{KIND_LABEL[f.kind]}</td>
                  <td>
                    <StatusBadge status={f.status} />
                  </td>
                  <td>{f.run ? <Badge status={f.run.status} /> : <span className="muted small">None</span>}</td>
                  <td className="muted small">{timeAgo(f.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open ? <Detail item={open} target={list.data.target} onClose={() => setOpenId(null)} onChanged={() => list.reload(true)} /> : null}
    </div>
  );
}

function Detail({ item, target, onClose, onChanged }) {
  const { toast } = useUi();
  const [form, setForm] = useState({ status: item.status, admin_note: item.admin_note || '', pr_url: item.pr_url || '' });
  const save = useAction();
  const dirty = form.status !== item.status || form.admin_note !== (item.admin_note || '') || form.pr_url !== (item.pr_url || '');
  const doSave = () =>
    save
      .run(async () => {
        await api.patch(`/api/feedback/${item.id}`, form);
        toast('Saved');
        onChanged();
      })
      .catch(() => {});
  return (
    <Modal
      wide
      title={item.title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" busy={save.busy} disabled={!dirty} onClick={doSave}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack-lg">
        <section className="stack">
          <p className="muted small">
            {KIND_LABEL[item.kind]} from {item.user_name || 'a deleted user'}, {timeAgo(item.created_at)}
            {item.page ? (
              <>
                {' '}· about {/^#\//.test(item.page) ? <a href={item.page}>{item.page}</a> : <code>{item.page}</code>}
              </>
            ) : null}
          </p>
          <div className="feedback-body">{item.body}</div>
        </section>
        <section className="stack">
          <Field label="Status">
            {(id) => (
              <select id={id} className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                {STATUSES.filter((s) => s.value === item.status || !['in_review', 'approved'].includes(s.value)).map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Your note" hint="Not shown to the person who sent it. When you send this to an agent, the note is added to its instructions.">
            {(id) => <textarea id={id} className="input" rows={3} value={form.admin_note} onChange={(e) => setForm({ ...form, admin_note: e.target.value })} />}
          </Field>
          <Field label="Pull request" hint="Filled in automatically when the agent's changes are pushed with a pull request. The sender sees this link.">
            {(id) => <input id={id} className="input mono" value={form.pr_url} onChange={(e) => setForm({ ...form, pr_url: e.target.value })} placeholder="https://github.com/…/pull/12" />}
          </Field>
          <ErrorNote error={save.error} />
        </section>
        {item.status === 'in_review' ? <ReviewChanges item={item} onDone={onChanged} /> : null}
        {item.decided_at && item.status !== 'in_review' ? (
          <p className="muted small">
            {STATUS[item.status]?.label || item.status} by {item.decided_by_name || 'an admin'}, {timeAgo(item.decided_at)}
            {item.decision_note ? `: “${item.decision_note}”` : ''}
          </p>
        ) : null}
        {item.handin_error ? <HandInProblem item={item} onDone={onChanged} /> : null}
        {item.status !== 'in_review' ? <SendToAgent item={item} note={form.admin_note} target={target} onStarted={onChanged} /> : null}
      </div>
    </Modal>
  );
}

function SendToAgent({ item, note, target, onStarted }) {
  const { projects, meta } = useApp();
  const { toast } = useUi();
  const [projectId, setProjectId] = useState(target?.projectId || item.project_id || '');
  const [repoId, setRepoId] = useState(target?.repoId || '');
  const [branch, setBranch] = useState(target?.branch || '');
  const [model, setModel] = useState('sonnet');
  const [mode, setMode] = useState('default');
  const repos = useLoad(() => (projectId ? api.get(`/api/projects/${projectId}/repos`) : Promise.resolve({ repos: [] })), [projectId]);
  const readyRepos = (repos.data?.repos || []).filter((r) => r.status === 'ready');
  useEffect(() => {
    if (repos.data && !readyRepos.some((r) => r.id === repoId)) setRepoId(readyRepos[0]?.id || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.data]);
  const act = useAction();
  const running = item.run?.active;
  const start = () =>
    act
      .run(async () => {
        const r = await api.post(`/api/feedback/${item.id}/agent`, { repoId, branch: branch.trim() || undefined, model, permissionMode: mode, note });
        toast('Agent run started');
        onStarted();
        go(r.run.project_id, 'runs', r.run.id);
      })
      .catch(() => {});

  return (
    <section className="panel stack">
      <h3>Send to agent</h3>
      {item.run ? (
        <p className="row tight wrap">
          <span>Latest run:</span>
          <Badge status={item.run.status} />
          <a href={href(item.run.project_id, 'runs', item.run.id)}>Open the run</a>
        </p>
      ) : null}
      <p className="muted small">
        The agent works in its own copy of the repository and asks before every change. When it finishes, the portal pushes its changes to a
        branch, opens a pull request and runs a code review. Nothing is merged until you approve it here.
      </p>
      <div className="two-col">
        <Field label="Project">
          {(id) => (
            <select id={id} className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Choose…</option>
              {(projects || []).filter((p) => !p.archived).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Repository with the portal's code" hint={projectId && repos.data && !readyRepos.length ? 'This project has no ready repository yet.' : undefined}>
          {(id) => (
            <select id={id} className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)} disabled={!readyRepos.length}>
              {readyRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Start from branch" hint="Leave empty for the repository's default branch.">
          {(id) => <input id={id} className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />}
        </Field>
        <Field label="Model">
          {(id) => (
            <select id={id} className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {(meta.models?.length ? meta.models : ['haiku', 'sonnet', 'opus']).map((m) => (
                <option key={m} value={m}>
                  {m[0].toUpperCase() + m.slice(1)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field label="How it works">
        <Segmented
          label="Permission mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'default', label: 'Ask before changes' },
            { value: 'plan', label: 'Plan first' },
          ]}
        />
      </Field>
      <ErrorNote error={act.error} />
      <div className="row">
        <Button variant="primary" icon="play" busy={act.busy} disabled={!repoId || running} onClick={start}>
          {item.run ? 'Start a new run' : 'Start agent run'}
        </Button>
        {running ? <span className="muted small">An agent is already working on this.</span> : null}
      </div>
    </section>
  );
}

function HandInProblem({ item, onDone }) {
  const { toast } = useUi();
  const act = useAction();
  const retry = () =>
    act
      .run(async () => {
        await api.post(`/api/feedback/${item.id}/submit`);
        toast('Sent for review');
        onDone();
      })
      .catch(() => {});
  return (
    <div className="stack">
      <Note tone="warn">
        <span>{item.handin_error}</span>
      </Note>
      {item.run && !item.run.active ? (
        <div className="row">
          <Button icon="refresh" busy={act.busy} onClick={retry}>
            Submit for review again
          </Button>
        </div>
      ) : null}
      <ErrorNote error={act.error} />
    </div>
  );
}

function ReviewChanges({ item, onDone }) {
  const { toast, confirm } = useUi();
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction();
  const review = item.review;
  const pid = item.run?.project_id;
  const merges = Boolean(item.pr_number);

  const approve = async () => {
    let force = false;
    if (review?.status === 'running' || review?.serious) {
      const ok = await confirm({
        title: 'Approve anyway?',
        message: review.status === 'running' ? 'The code review has not finished yet.' : `The code review found ${review.serious} serious issue${review.serious === 1 ? '' : 's'}.`,
        confirmLabel: merges ? 'Approve and merge' : 'Approve',
        danger: true,
      });
      if (!ok) return;
      force = true;
    }
    await act
      .run(async () => {
        const r = await api.post(`/api/feedback/${item.id}/approve`, { force });
        toast(r.feedback.status === 'fixed' ? 'Approved and merged' : `Approved. Merge branch ${item.branch} to release it.`);
        onDone();
      })
      .catch(() => {});
  };
  const sendBack = () =>
    act
      .run(async () => {
        const r = await api.post(`/api/feedback/${item.id}/request-changes`, { comment });
        toast('Sent back to the agent');
        onDone();
        go(r.run.project_id, 'runs', r.run.id);
      })
      .catch(() => {});
  const reject = async () => {
    const ok = await confirm({
      title: 'Reject these changes?',
      message: merges ? 'The pull request is closed and the feedback is marked declined.' : 'The feedback is marked declined. The branch is kept.',
      confirmLabel: 'Reject',
      danger: true,
    });
    if (!ok) return;
    await act
      .run(async () => {
        await api.post(`/api/feedback/${item.id}/reject`, { reason });
        toast('Rejected');
        onDone();
      })
      .catch(() => {});
  };

  return (
    <section className="panel stack review-panel">
      <h3>Review the changes</h3>
      <p className="muted small">The agent has finished. Check what it changed, then approve it, send it back with comments, or reject it.</p>
      <ul className="review-links small">
        {item.pr_url ? (
          <li>
            Pull request:{' '}
            <a href={item.pr_url} target="_blank" rel="noreferrer">
              #{item.pr_number || ''} on GitHub
            </a>
          </li>
        ) : null}
        {item.branch ? (
          <li>
            Branch: <code>{item.branch}</code>
          </li>
        ) : null}
        {item.run ? (
          <li>
            <a href={href(pid, 'runs', item.run.id)}>The agent's run</a>, with its summary and <em>Files and changes</em>
          </li>
        ) : null}
        {review ? (
          <li>
            <a href={href(review.project_id, 'review', review.id)}>Code review</a>{' '}
            <Badge status={review.status} />{' '}
            {review.status === 'done' ? (
              <span className={review.serious ? 'danger' : 'muted'}>
                {review.open_findings ? `${review.open_findings} finding${review.open_findings === 1 ? '' : 's'}${review.serious ? `, ${review.serious} serious` : ''}` : 'No findings'}
              </span>
            ) : null}
          </li>
        ) : null}
      </ul>
      {review?.summary ? <p className="small">{review.summary}</p> : null}
      <div className="row wrap">
        <Button variant="primary" icon="check" busy={act.busy} onClick={approve}>
          {merges ? 'Approve and merge' : 'Approve'}
        </Button>
      </div>
      <Field label="Request changes" hint="The agent continues in the same working copy with your comments and the open review findings, then it comes back here.">
        {(id) => <textarea id={id} className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Also handle tablets, and add a test." />}
      </Field>
      <div className="row wrap">
        <Button icon="edit" busy={act.busy} disabled={!comment.trim()} onClick={sendBack}>
          Send back to the agent
        </Button>
      </div>
      <Field label="Reject" hint={merges ? 'Closes the pull request. Your reason is posted on it.' : 'Optional reason, kept with the feedback.'}>
        {(id) => <input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not something we want to change" />}
      </Field>
      <div className="row wrap">
        <Button variant="danger" icon="x" busy={act.busy} onClick={reject}>
          Reject changes
        </Button>
      </div>
      <ErrorNote error={act.error} />
    </section>
  );
}
