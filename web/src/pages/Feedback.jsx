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
  { value: 'in_progress', label: 'In progress', tone: 'warn' },
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
  const [openId, setOpenId] = useState(null);
  const list = useLoad(() => api.get(`/api/feedback${status === 'all' ? '' : `?status=${status}`}`), [status]);
  const counts = list.data?.counts || {};
  const items = list.data?.feedback || [];
  const open = items.find((f) => f.id === openId);
  return (
    <div className="stack">
      <div className="row wrap">
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
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
                {STATUSES.map((s) => (
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
        <SendToAgent item={item} note={form.admin_note} target={target} onStarted={onChanged} />
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
  const running = item.run && ['queued', 'running', 'waiting'].includes(item.run.status);
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
        The agent works in its own copy of the repository and asks before every change. When it is done, review its changes in the run and use{' '}
        <em>Push changes</em> to open a pull request.
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
