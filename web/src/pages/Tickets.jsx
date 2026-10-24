import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href, runHref } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, money, timeAgo } from '../lib/util.js';
import { useSortable } from '../lib/useSortable.js';
import { Icon } from '../components/Icon.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { ModelPicker } from '../components/ModelPicker.jsx';
import { ConnectionBadge } from '../components/ConnectionBadge.jsx';
import { SortHeader } from '../components/SortHeader.jsx';
import { Badge, Button, Empty, ErrorNote, Field, PageHeader, Segmented, Spinner, useUi } from '../components/ui.jsx';

const AUTO_REFRESH_MS = 3 * 60 * 1000;
const TONE = { new: 'muted', indeterminate: 'accent', done: 'ok' };
const MODELS = [
  { value: 'haiku', label: 'Haiku (fast, cheapest)' },
  { value: 'sonnet', label: 'Sonnet (balanced)' },
  { value: 'opus', label: 'Opus (deepest)' },
];

/** After the Atlassian sign-in the server sends the browser back with ?jira=connected or ?jira=error. Show it once. */
export function useJiraReturn(onDone) {
  const { toast } = useUi();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const flag = q.get('jira');
    if (!flag) return;
    const clean = new URL(window.location.href);
    clean.searchParams.delete('jira');
    clean.searchParams.delete('reason');
    window.history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
    if (flag === 'connected') toast('Jira connected');
    else toast(q.get('reason') || 'Could not connect to Jira', 'danger');
    onDone?.();
  }, []);
}

/** Send the browser to Atlassian to approve access for this project, then back to this page. */
export function connectJira(projectId) {
  window.location.href = `/api/projects/${encodeURIComponent(projectId)}/jira/connect?return=${encodeURIComponent(window.location.hash)}`;
}

/* ------------------------------------------------------------------ */

export function Tickets() {
  const { project } = useProject();
  const { user } = useApp();
  const status = useLoad(() => api.get(`/api/projects/${project.id}/jira`), [project.id]);
  const mapping = status;
  useJiraReturn(() => status.reload(true));
  const canConnect = Boolean(status.data?.canConnect);

  let body;
  if (status.loading && !status.data) body = <Spinner />;
  else if (status.error) body = <ErrorNote error={status.error} />;
  else if (!status.data.configured) {
    body = (
      <Empty icon="inbox" title="Jira is not set up for this project">
        {canConnect ? (
          <>
            Each project has its own Jira. <a href={href(project.id, 'setup', 'jira')}>Open Project setup › Jira</a> to add this project’s Atlassian app and connect.
          </>
        ) : (
          'A project owner needs to set up and connect Jira for this project, under Project setup › Jira.'
        )}
      </Empty>
    );
  } else if (!status.data.connected) {
    body = (
      <Empty icon="inbox" title="Connect this project to Jira" action={canConnect ? <Button variant="primary" onClick={() => connectJira(project.id)}>Connect Jira</Button> : null}>
        {canConnect
          ? 'Sign in with the Atlassian account that can see this project’s Jira board. Everyone on this project then reads tickets through it, so use an account with the access you want to share. The portal never sees your password.'
          : 'A project owner needs to connect this project to its Jira. Everyone on the project then shares that connection.'}
      </Empty>
    );
  } else if (mapping.loading && !mapping.data) body = <Spinner />;
  else if (!mapping.data?.mapping) body = <LinkProject canEdit={canConnect} onSaved={() => mapping.reload(true)} />;
  else body = <TicketBoard status={status.data} mapping={mapping.data.mapping} onEditMapping={() => mapping.reload(true)} onDisconnected={() => status.reload(true)} />;

  return (
    <div className="page wide">
      <PageHeader title="Tickets" sub="Pick a Jira ticket and let the agents analyze it against this project’s repository." />
      {body}
    </div>
  );
}

/* ---------------- Link the portal project to a Jira project ---------------- */

function LinkProject({ canEdit, onSaved, initial }) {
  const { project } = useProject();
  const { toast } = useUi();
  const [form, setForm] = useState({ projectKey: initial?.projectKey ?? '', jql: initial?.jql ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/projects/${project.id}/jira`, form);
      toast('Jira project linked');
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!canEdit && !initial) return <Empty icon="inbox" title="This project is not linked to Jira yet">Ask a project owner to choose the Jira project.</Empty>;
  return (
    <section className="panel stack" style={{ maxWidth: 640 }}>
      <h2>Which Jira project does this portal project work on?</h2>
      <Field label="Jira project key" hint="The letters before the number in a ticket, like RLP in RLP-123.">
        {(id) => <input id={id} className="input mono input-sm" value={form.projectKey} placeholder="RLP" onChange={(e) => setForm({ ...form, projectKey: e.target.value.toUpperCase() })} />}
      </Field>
      <Field label="Extra JQL (optional)" hint="Narrow the list, for example: component = Payments. Leave ORDER BY out.">
        {(id) => <input id={id} className="input mono" value={form.jql} placeholder="component = Payments" onChange={(e) => setForm({ ...form, jql: e.target.value })} />}
      </Field>
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" busy={busy} disabled={!form.projectKey.trim()} onClick={save}>
          Save
        </Button>
        {initial ? (
          <Button variant="ghost" onClick={onSaved}>
            Cancel
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/* ---------------- The ticket list and the selected ticket ---------------- */

function seenKey(projectId) {
  return `jira-seen:${projectId}`;
}

function readSeen(projectId) {
  try {
    return JSON.parse(localStorage.getItem(seenKey(projectId)) || 'null');
  } catch {
    return null;
  }
}

function writeSeen(projectId, v) {
  try {
    localStorage.setItem(seenKey(projectId), JSON.stringify(v));
  } catch {
    /* "updated since you looked" is a convenience; losing it is fine */
  }
}

function TicketBoard({ status, mapping, onEditMapping, onDisconnected }) {
  const { project, canEdit } = useProject();
  const canConnect = Boolean(status.canConnect);
  const { toast, confirm } = useUi();
  const [scope, setScope] = useState('mine');
  const [statusFilter, setStatusFilter] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(null);
  const [pages, setPages] = useState({ list: [], next: null, siteUrl: '', loadedAt: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [seen, setSeen] = useState(() => readSeen(project.id));
  const statuses = useLoad(() => api.get(`/api/projects/${project.id}/jira/statuses`).catch(() => ({ statuses: [] })), [project.id, mapping.projectKey]);

  const TICKET_COLS = [
    { key: 'ticket',   label: 'Ticket',   accessor: 'key',                    type: 'text' },
    { key: 'status',   label: 'Status',   accessor: (i) => i.status?.name || '', type: 'text' },
    { key: 'assignee', label: 'Assignee', accessor: 'assignee',               type: 'text' },
    { key: 'priority', label: 'Priority', accessor: 'priority',               type: 'text' },
    { key: 'updated',  label: 'Updated',  accessor: 'updated',                type: 'date' },
  ];
  const { sorted: sortedTickets, sortKey: tSortKey, sortDir: tSortDir, toggle: tToggle } = useSortable(
    pages.list,
    { columns: TICKET_COLS, storageKey: `sort:tickets:${project.id}` }
  );

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const query = useMemo(() => `scope=${scope}&status=${encodeURIComponent(statusFilter)}&q=${encodeURIComponent(q)}`, [scope, statusFilter, q]);
  const loadId = useRef(0);
  const load = useCallback(
    async ({ more = false, quiet = false } = {}) => {
      const id = ++loadId.current;
      if (!quiet) setLoading(true);
      try {
        const next = more ? `&next=${encodeURIComponent(pages.next)}` : '';
        const r = await api.get(`/api/projects/${project.id}/jira/issues?${query}${next}`);
        if (id !== loadId.current) return;
        setError(null);
        setPages((p) => ({ list: more ? [...p.list, ...r.issues] : r.issues, next: r.next, siteUrl: r.siteUrl, loadedAt: Date.now() }));
        // The first time we ever see this list, treat everything as already seen, so only later changes are flagged.
        setSeen((cur) => {
          if (cur) return cur;
          const base = Object.fromEntries(r.issues.map((i) => [i.key, i.updated]));
          writeSeen(project.id, base);
          return base;
        });
      } catch (e) {
        if (id === loadId.current) setError(e);
        if (e.status === 401 || e.status === 409) onDisconnected();
      } finally {
        if (id === loadId.current && !quiet) setLoading(false);
      }
    },
    [project.id, query, pages.next, onDisconnected],
  );

  useEffect(() => {
    setPages({ list: [], next: null, siteUrl: '', loadedAt: null });
    load();
  }, [query, mapping.projectKey]);

  // Pick up Jira changes on their own: every few minutes while the tab is visible, and when you come back to it.
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && load({ quiet: true });
    const timer = setInterval(tick, AUTO_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  const changed = (i) => seen && seen[i.key] && seen[i.key] !== i.updated;
  const markSeen = (i) => {
    setSeen((cur) => {
      const n = { ...(cur || {}), [i.key]: i.updated };
      writeSeen(project.id, n);
      return n;
    });
  };
  const open = (i) => {
    setSelected(i.key);
    markSeen(i);
  };
  const changedCount = pages.list.filter(changed).length;

  if (editing) return <LinkProject canEdit={canConnect} initial={mapping} onSaved={() => { setEditing(false); onEditMapping(); }} />;

  return (
    <div className="stack-lg">
      <div className="row between wrap">
        <div className="row tight wrap muted small">
          <span>
            {status.account?.name || 'Shared Jira account'} on{' '}
            {canConnect && status.sites.length > 1 ? (
              <select
                className="input input-sm"
                aria-label="Jira site"
                value={status.sites.find((s) => s.url === status.site?.url)?.cloudId ?? ''}
                onChange={async (e) => {
                  try {
                    await api.post(`/api/projects/${project.id}/jira/site`, { cloudId: e.target.value });
                    onDisconnected();
                  } catch (err) {
                    toast(err.message, 'danger');
                  }
                }}
              >
                {status.sites.map((s) => (
                  <option key={s.cloudId} value={s.cloudId}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              status.site?.name
            )}
          </span>
          <span>·</span>
          <span>
            Project <code>{mapping.projectKey}</code>
            {mapping.jql ? <> where <code>{mapping.jql}</code></> : null}
          </span>
          {canConnect ? (
            <>
              <button type="button" className="linkish" onClick={() => setEditing(true)}>
                Change
              </button>
              <span>·</span>
              <button
                type="button"
                className="linkish"
                onClick={async () => {
                  if (!(await confirm({ title: 'Disconnect Jira', message: 'Remove this project’s Jira connection? Nobody on the project can read tickets until an owner connects again.', confirmLabel: 'Disconnect' }))) return;
                  await api.del(`/api/projects/${project.id}/jira/connection`);
                  toast('Jira disconnected');
                  onDisconnected();
                }}
              >
                Disconnect
              </button>
            </>
          ) : null}
        </div>
        <div className="row tight">
          {pages.loadedAt ? <span className="muted small">Updated {timeAgo(new Date(pages.loadedAt).toISOString())}</span> : null}
          <Button size="sm" icon="refresh" busy={loading} onClick={() => load()}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="row wrap">
        <Segmented
          value={scope}
          onChange={setScope}
          label="Which tickets"
          options={[
            { value: 'mine', label: 'Assigned to me' },
            { value: 'open', label: 'All open' },
            { value: 'all', label: 'Everything' },
          ]}
        />
        <select className="input input-sm" aria-label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Any status</option>
          {(statuses.data?.statuses || []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input className="input input-md" type="search" placeholder="Search tickets or type a key" aria-label="Search tickets" value={text} onChange={(e) => setText(e.target.value)} />
        {changedCount ? <Badge tone="warn">{changedCount} changed since you looked</Badge> : null}
      </div>

      <ErrorNote error={error} />

      <div className={cx('tickets-layout', selected && 'has-detail')}>
        <div className="stack">
          {loading && !pages.list.length ? (
            <Spinner />
          ) : !pages.list.length && !error ? (
            <Empty icon="inbox" title="No tickets match">
              Try “Everything”, a different status, or a different search.
            </Empty>
          ) : (
            <table className="table tickets-table">
              <thead>
                <tr>
                  <SortHeader col={TICKET_COLS[0]} sortKey={tSortKey} sortDir={tSortDir} onSort={tToggle} />
                  <SortHeader col={TICKET_COLS[1]} sortKey={tSortKey} sortDir={tSortDir} onSort={tToggle} />
                  <SortHeader col={TICKET_COLS[2]} sortKey={tSortKey} sortDir={tSortDir} onSort={tToggle} />
                  <SortHeader col={TICKET_COLS[3]} sortKey={tSortKey} sortDir={tSortDir} onSort={tToggle} />
                  <SortHeader col={TICKET_COLS[4]} sortKey={tSortKey} sortDir={tSortDir} onSort={tToggle} />
                </tr>
              </thead>
              <tbody>
                {sortedTickets.map((i) => (
                  <tr key={i.key} className={cx('ticket-row', selected === i.key && 'is-selected')} onClick={() => open(i)}>
                    <td>
                      <button type="button" className="ticket-pick" onClick={(e) => { e.stopPropagation(); open(i); }} aria-label={`Open ${i.key}`}>
                        <strong className="mono">{i.key}</strong>
                        <span>{i.summary}</span>
                      </button>
                    </td>
                    <td>
                      <Badge tone={TONE[i.status.category] || 'muted'}>{i.status.name}</Badge>
                    </td>
                    <td className="muted">{i.assignee || '—'}</td>
                    <td className="muted">{i.priority || '—'}</td>
                    <td className="muted">
                      {changed(i) ? <span className="changed-dot" title="Changed since you last opened it" aria-label="Changed since you last opened it" /> : null}
                      {timeAgo(i.updated)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {pages.next ? (
            <div className="stack">
              <div className="row">
                <Button size="sm" busy={loading} onClick={() => load({ more: true })}>
                  Load more
                </Button>
              </div>
              <p className="sort-page-hint">Sorts the tickets loaded on this page.</p>
            </div>
          ) : null}
        </div>
        {selected ? <TicketDetail key={selected} ticketKey={selected} siteUrl={pages.siteUrl} onClose={() => setSelected(null)} /> : null}
      </div>
    </div>
  );
}

/* ---------------- One ticket: details, analysis form, earlier analyses ---------------- */

function TicketDetail({ ticketKey, siteUrl, onClose }) {
  const { project, canEdit } = useProject();
  const { toast } = useUi();
  const detail = useLoad(() => api.get(`/api/projects/${project.id}/jira/issues/${ticketKey}`), [project.id, ticketKey]);
  const runs = useLoad(() => api.get(`/api/projects/${project.id}/jira/issues/${ticketKey}/runs`), [project.id, ticketKey]);
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  useProjectEvents(['run.updated'], () => runs.reload(true));
  const ready = (repos.data?.repos || []).filter((r) => r.status === 'ready');
  const [form, setForm] = useState({ repoId: '', notes: '', model: 'sonnet' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showComments, setShowComments] = useState(false);
  useEffect(() => {
    if (!form.repoId && ready.length) setForm((f) => ({ ...f, repoId: ready[0].id }));
  }, [ready.length]);

  const analyze = async () => {
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.post(`/api/projects/${project.id}/jira/issues/${ticketKey}/analyze`, form);
      toast(`Analysis of ${ticketKey} started`);
      window.location.hash = runHref(project.id, run.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const t = detail.data?.issue;
  return (
    <aside className="panel ticket-detail stack" aria-label={`Ticket ${ticketKey}`}>
      <div className="row between">
        <h2 className="mono">{ticketKey}</h2>
        <div className="row tight">
          <a className="btn btn-ghost btn-sm" href={t?.url || `${siteUrl}/browse/${ticketKey}`} target="_blank" rel="noopener noreferrer">
            Open in Jira <Icon name="external" size={14} />
          </a>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close ticket">
            Close
          </Button>
        </div>
      </div>
      {detail.loading && !t ? (
        <Spinner />
      ) : detail.error ? (
        <ErrorNote error={detail.error} />
      ) : t ? (
        <>
          <div className="stack" style={{ gap: '0.4rem' }}>
            <strong>{t.summary}</strong>
            <div className="row tight wrap small">
              <Badge tone={TONE[t.status.category] || 'muted'}>{t.status.name}</Badge>
              {t.type ? <span className="muted">{t.type}</span> : null}
              {t.priority ? <span className="muted">{t.priority} priority</span> : null}
              <span className="muted">{t.assignee ? `Assigned to ${t.assignee}` : 'Unassigned'}</span>
            </div>
            {t.labels.length ? <div className="row tight wrap">{t.labels.map((l) => <Badge key={l} tone="muted">{l}</Badge>)}</div> : null}
          </div>
          <div className="ticket-body">{t.description ? <Markdown text={t.description} /> : <p className="muted small">No description.</p>}</div>
          {t.links.length || t.subtasks.length || t.attachments.length ? (
            <ul className="plain-list small">
              {t.links.map((l, i) => (
                <li key={`l${i}`}>
                  <span className="muted">{l.relation}</span> <code>{l.key}</code> {l.summary} <Badge tone="muted">{l.status}</Badge>
                </li>
              ))}
              {t.subtasks.map((s) => (
                <li key={s.key}>
                  <span className="muted">sub-task</span> <code>{s.key}</code> {s.summary} <Badge tone="muted">{s.status}</Badge>
                </li>
              ))}
              {t.attachments.length ? <li className="muted">Attachments: {t.attachments.map((a) => a.filename).join(', ')} (the agents see names only)</li> : null}
            </ul>
          ) : null}
          {t.comments.length ? (
            <div className="stack" style={{ gap: '0.3rem' }}>
              <button type="button" className="linkish small" onClick={() => setShowComments((v) => !v)}>
                {showComments ? 'Hide' : 'Show'} {t.comments.length} comment{t.comments.length === 1 ? '' : 's'}
              </button>
              {showComments
                ? [...t.comments].reverse().map((c, i) => (
                    <div key={i} className="ticket-comment">
                      <span className="muted small">
                        {c.author}, {timeAgo(c.created)}
                      </span>
                      <Markdown text={c.body} />
                    </div>
                  ))
                : null}
            </div>
          ) : null}

          <hr className="rule" />
          <h3>Analyze with agents</h3>
          {canEdit ? (
            ready.length ? (
              <div className="stack">
                <p className="muted small">The agents read this ticket and a fresh copy of the repository, then write an impact analysis: affected code, approach, risks, test plan and open questions. Nothing is changed.</p>
                <Field label="Repository">
                  {(id) => (
                    <select id={id} className="input" value={form.repoId} onChange={(e) => setForm({ ...form, repoId: e.target.value })}>
                      {ready.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="Extra context (optional)" hint="Where to look, or what you already know.">
                  {(id) => <textarea id={id} className="input" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="For example: the limit check is in refund.py" />}
                </Field>
                <Field label="Model">{(id) => <ModelPicker id={id} value={form.model} projectId={project.id} onChange={(model) => setForm({ ...form, model })} />}</Field>
                <ErrorNote error={error} />
                <div className="row">
                  <Button variant="primary" icon="play" busy={busy} disabled={!form.repoId} onClick={analyze}>
                    Analyze {ticketKey}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="muted small">
                Connect and sync a repository on the <a href={href(project.id, 'repos')}>Repositories</a> page first.
              </p>
            )
          ) : (
            <p className="muted small">You have view access. Ask a project editor to start an analysis.</p>
          )}

          {runs.data?.runs?.length ? (
            <div className="stack" style={{ gap: '0.4rem' }}>
              <h3>Earlier analyses</h3>
              <ul className="plain-list small">
                {runs.data.runs.map((r) => (
                  <li key={r.id}>
                    <a href={runHref(project.id, r.id)}>{timeAgo(r.created_at)}</a> <Badge status={r.status} />
                    {r.comment ? (
                      <>
                        {' '}
                        <a href={r.comment.url} target="_blank" rel="noopener noreferrer">
                          posted to Jira
                        </a>
                      </>
                    ) : null}
                    {r.meta?.kiroCredits != null ? <span className="muted"> {r.meta.kiroCredits} credits</span> : r.cost_usd ? <span className="muted"> {money(r.cost_usd)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <hr className="rule" />
          <h3>Start a coding run</h3>
          {canEdit ? (
            ready.length ? (
              <div className="stack">
                <p className="muted small">Open the Agent runs composer with this ticket pre-selected. Pick a repository and the agent will implement or fix what the ticket describes.</p>
                <div className="row tight wrap">
                  <span className="muted small">Connection:</span>
                  <ConnectionBadge projectId={project.id} />
                </div>
                <Field label="Repository">
                  {(id) => (
                    <select id={id} className="input" value={form.repoId} onChange={(e) => setForm({ ...form, repoId: e.target.value })}>
                      {ready.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <div className="row">
                  <Button
                    variant="default"
                    icon="play"
                    disabled={!form.repoId}
                    onClick={() => {
                      const params = new URLSearchParams({
                        jiraKey: t.key,
                        jiraUrl: t.url || '',
                        jiraSummary: t.summary || '',
                        repoId: form.repoId,
                      });
                      window.location.hash = href(project.id, 'sessions', 'new') + '?' + params.toString();
                    }}
                  >
                    Start coding run for {t.key}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="muted small">
                Connect and sync a repository on the <a href={href(project.id, 'repos')}>Repositories</a> page first.
              </p>
            )
          ) : (
            <p className="muted small">You have view access. Ask a project editor to start a coding run.</p>
          )}
        </>
      ) : null}
    </aside>
  );
}

/* ---------------- On a run's page: the ticket it came from, and a "Post to Jira" button ---------------- */

export function JiraRunBar({ run }) {
  const { canEdit } = useProject();
  const { toast, confirm } = useUi();
  const [comment, setComment] = useState(run.meta?.jiraComment ?? null);
  const [busy, setBusy] = useState(false);
  const key = run.meta?.jiraKey;
  if (!key) return null;
  const post = async (again) => {
    if (!(await confirm({ title: again ? 'Post again' : 'Post to Jira', message: `Add this analysis as a comment on ${key}? Everyone who can see the ticket will see it.`, confirmLabel: 'Post comment' }))) return;
    setBusy(true);
    try {
      const r = await api.post(`/api/runs/${run.id}/jira-comment`, again ? { again: true } : {});
      setComment(r.comment);
      toast(`Posted to ${key}`);
    } catch (e) {
      if (e.status === 409 && /already posted/.test(e.message)) return post(true);
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row tight wrap jira-bar small">
      <a href={run.meta.jiraUrl} target="_blank" rel="noopener noreferrer" className="badge badge-accent">
        Jira {key} <Icon name="external" size={12} />
      </a>
      {run.status === 'completed' && canEdit ? (
        comment ? (
          <>
            <a href={comment.url} target="_blank" rel="noopener noreferrer">
              Posted to Jira
            </a>
            <button type="button" className="linkish" disabled={busy} onClick={() => post(true)}>
              Post again
            </button>
          </>
        ) : (
          <Button size="sm" busy={busy} onClick={() => post(false)}>
            Post analysis to Jira
          </Button>
        )
      ) : null}
    </div>
  );
}

/* ---------------- The project's Jira app and connection, shown under Project setup › Jira ---------------- */

export function JiraConnection() {
  const { project } = useProject();
  const { toast, confirm } = useUi();
  const info = useLoad(() => api.get(`/api/projects/${project.id}/jira`), [project.id]);
  const app = useLoad(() => (info.data?.canConnect ? api.get(`/api/projects/${project.id}/jira/app`) : Promise.resolve(null)), [project.id, info.data?.canConnect]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useJiraReturn(() => info.reload(true));
  useEffect(() => {
    if (app.data) setForm({ clientId: app.data.clientId, clientSecret: '', redirectUri: app.data.redirectUri });
  }, [app.data]);
  const d = info.data;
  if (!d) {
    return (
      <section className="panel">
        <h2>Jira</h2>
        {info.error ? <ErrorNote error={info.error} /> : <Spinner />}
      </section>
    );
  }
  const reloadAll = () => Promise.all([info.reload(true), app.reload(true)]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/projects/${project.id}/jira/app`, form);
      toast('Jira app saved');
      await reloadAll();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel stack">
      <div className="row between">
        <h2>Jira</h2>
        {d.connected ? <Badge tone="ok">Connected</Badge> : d.configured ? <Badge tone="warn">Not connected</Badge> : <Badge tone="warn">Not set up</Badge>}
      </div>
      <p className="muted small">
        This project has its own Jira: its own Atlassian app and its own sign-in. Everyone on the project reads tickets through the account connected here, and other projects are not affected.
      </p>
      {d.connected ? (
        <dl className="kv">
          <div><dt>Account</dt><dd>{d.account?.name || 'Connected'}{d.account?.email ? ` (${d.account.email})` : ''}</dd></div>
          <div><dt>Site</dt><dd>{d.site?.name}</dd></div>
          <div><dt>Jira project</dt><dd>{d.mapping ? <code>{d.mapping.projectKey}</code> : 'not chosen yet'}</dd></div>
        </dl>
      ) : null}
      {d.canConnect && form && app.data ? (
        <>
          <details open={!d.configured}>
            <summary>{d.configured ? 'Atlassian app for this project' : 'Step 1: register this project’s Atlassian app (about 3 minutes)'}</summary>
            <ol className="small stack" style={{ paddingLeft: '1.2rem', gap: '0.3rem' }}>
              <li>
                Open <a href="https://developer.atlassian.com/console/myapps/" target="_blank" rel="noopener noreferrer">developer.atlassian.com/console/myapps</a> while signed in to the Atlassian account for this project, choose <strong>Create → OAuth 2.0 integration</strong> and name it “Agent Portal”.
              </li>
              <li>
                Under <strong>Permissions</strong> add <strong>Jira API</strong> and configure these scopes:{' '}
                {app.data.scopes.filter((x) => x !== 'offline_access').map((x) => <code key={x}>{x} </code>)}
              </li>
              <li>
                Under <strong>Authorization</strong> add <strong>OAuth 2.0 (3LO)</strong> and set the callback URL to exactly: <code>{form.redirectUri}</code>{' '}
                <button type="button" className="linkish" onClick={() => navigator.clipboard?.writeText(form.redirectUri).then(() => toast('Copied'))}>Copy</button>
              </li>
              <li>Under <strong>Settings</strong> copy the <strong>Client ID</strong> and <strong>Secret</strong> into the boxes below.</li>
            </ol>
          </details>
          <div className="row wrap">
            <Field label="Client ID">{(id) => <input id={id} className="input mono" value={form.clientId} autoComplete="off" onChange={(e) => setForm({ ...form, clientId: e.target.value.trim() })} />}</Field>
            <Field label={app.data.secretSet ? 'Client secret (saved; type to replace)' : 'Client secret'}>
              {(id) => <input id={id} type="password" className="input mono" value={form.clientSecret} autoComplete="off" placeholder={app.data.secretSet ? '••••••••' : ''} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} />}
            </Field>
          </div>
          <Field label="Callback URL" hint="Must match the one registered with Atlassian. If you reach the portal through another address, use that address here and there.">
            {(id) => <input id={id} className="input mono" value={form.redirectUri} onChange={(e) => setForm({ ...form, redirectUri: e.target.value.trim() })} />}
          </Field>
          <ErrorNote error={error} />
        </>
      ) : !d.canConnect ? (
        <p className="small">{d.connected ? 'A project owner manages this connection.' : 'A project owner needs to set up and connect Jira for this project.'}</p>
      ) : null}
      <div className="row wrap">
        {d.canConnect && form ? (
          <Button variant={d.configured ? 'default' : 'primary'} busy={busy} disabled={!form.clientId || (!app.data?.secretSet && !form.clientSecret)} onClick={save}>
            Save Jira app
          </Button>
        ) : null}
        {d.canConnect && d.configured ? (
          <Button variant="primary" onClick={() => connectJira(project.id)}>
            {d.connected ? 'Reconnect' : 'Step 2: connect Jira'}
          </Button>
        ) : null}
        {d.connected ? <Button onClick={() => go(project.id, 'tickets')}>Open tickets</Button> : null}
        {d.canConnect && d.connected ? (
          <Button
            variant="danger-ghost"
            onClick={async () => {
              if (!(await confirm({ title: 'Disconnect Jira', message: 'Remove this project’s Jira connection? Nobody on the project can read tickets until an owner connects again.', confirmLabel: 'Disconnect' }))) return;
              try {
                await api.del(`/api/projects/${project.id}/jira/connection`);
                toast('Jira disconnected');
                await reloadAll();
              } catch (e) {
                toast(e.message, 'danger');
              }
            }}
          >
            Disconnect
          </Button>
        ) : null}
        {d.canConnect && d.configured ? (
          <Button
            variant="danger-ghost"
            onClick={async () => {
              if (!(await confirm({ title: 'Remove the Jira app', message: 'This project will lose its Jira connection and the saved Atlassian app details.', confirmLabel: 'Remove', danger: true }))) return;
              try {
                await api.del(`/api/projects/${project.id}/jira/app`);
                setForm(null);
                await reloadAll();
              } catch (e) {
                toast(e.message, 'danger');
              }
            }}
          >
            Remove app
          </Button>
        ) : null}
      </div>
    </section>
  );
}
