import { useContext, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href, sessionHref } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, dateTime, plural, timeAgo } from '../lib/util.js';
import { Markdown } from '../components/Markdown.jsx';
import { RefreshControl, RunChoice, RunOptionsSection, initialRunOptions, runOptionsBody, showWarnings } from '../components/RunOptions.jsx';
import { Badge, Button, EmbeddedContext, Empty, ErrorNote, Field, Modal, Note, PageHeader, Spinner, useUi } from '../components/ui.jsx';

const KIND_HINT = {
  system_context: 'The system as a box among the people and systems around it.',
  components: 'The main parts inside the system and how they call each other.',
  data_flow: 'How data moves from where it comes in to where it is stored.',
};

/** @param {string} projectId */
const base = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/diagrams`;

/** Status of a diagram in words: generating, ready or error, plus the stale flag. */
function DiagramBadges({ d }) {
  return (
    <span className="row tight wrap">
      {d.status === 'generating' ? <Badge tone="accent">Generating</Badge> : d.status === 'error' ? <Badge tone="danger">Error</Badge> : <Badge tone="ok">Ready</Badge>}
      {d.stale && d.status !== 'generating' ? <Badge tone="warn">Stale: code has changed</Badge> : null}
    </span>
  );
}

/** The error of a failed refresh when an older version is still current, else null. */
function failedRefresh(d) {
  return d.status === 'ready' && d.error ? d.error : null;
}

export function Diagrams({ route }) {
  const [id] = route.rest;
  return id ? <DiagramView id={id} versionParam={route.query.get('v')} /> : <DiagramList />;
}

function DiagramList() {
  const { project, canEdit } = useProject();
  const { toast } = useUi();
  const list = useLoad(() => api.get(base(project.id)), [project.id]);
  useProjectEvents(['diagrams.updated'], () => list.reload(true));
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const diagrams = list.data?.diagrams || [];
  const staleCount = diagrams.filter((d) => d.stale && d.status !== 'generating').length;

  const refreshStale = async (body) => {
    setBusy(true);
    try {
      const r = await api.post(`${base(project.id)}/refresh-stale`, body);
      showWarnings(toast, r.warnings);
      const parts = [`${plural(r.started.length, 'diagram')} started`];
      if (r.skipped.length) parts.push(`${r.skipped.length} skipped (${r.skipped[0].reason})`);
      toast(parts.join(', '), r.started.length ? 'ok' : 'danger');
      list.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  const newButton = (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      New diagram
    </Button>
  );
  return (
    <div className="page">
      <PageHeader
        title="Diagrams"
        sub="Architecture pictures an agent draws from your repositories and redraws when the code changes."
        actions={
          canEdit ? (
            <>
              {staleCount ? (
                <RefreshControl
                  label={`Refresh all stale (${staleCount})`}
                  busy={busy}
                  runOptions={list.data?.runOptions}
                  note="The plain button reuses the choice saved with each diagram. Pick one here to use it for every stale diagram in this refresh; it replaces what each had saved."
                  onRefresh={refreshStale}
                />
              ) : null}
              {newButton}
            </>
          ) : null
        }
      />
      {list.error && !list.data ? <ErrorNote error={list.error} /> : null}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data && !diagrams.length ? (
        <Empty icon="builder" title="No diagrams yet" action={canEdit ? newButton : null}>
          {canEdit
            ? 'Pick a repository and the kind of picture you want: a system context, the components inside it, or how data flows. An agent reads the code and draws it, cites the files it used, and keeps every version. When the code moves on, the diagram is marked stale so you can redraw it.'
            : 'Nobody has drawn a diagram for this project yet. Editors can create them from the project repositories.'}
        </Empty>
      ) : diagrams.length ? (
        <div className="table-wrap">
          <table className="table" aria-label="Diagrams">
            <thead>
              <tr>
                <th>Title</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Version</th>
                <th>Last generated</th>
              </tr>
            </thead>
            <tbody>
              {diagrams.map((d) => (
                <tr key={d.id}>
                  <td>
                    <a href={href(project.id, 'diagrams', d.id)}>{d.title}</a>
                    <div className="muted small">{d.repos.map((r) => r.name).join(', ')}</div>
                    {failedRefresh(d) ? <div className="danger small">Last refresh failed, previous version kept</div> : null}
                    {d.status === 'error' && d.error ? <div className="danger small">{d.error}</div> : null}
                  </td>
                  <td>{d.kind_label}</td>
                  <td>
                    <DiagramBadges d={d} />
                  </td>
                  <td>{d.version ? `v${d.version}` : '-'}</td>
                  <td>{d.generated_at ? <span title={dateTime(d.generated_at)}>{timeAgo(d.generated_at)}</span> : <span className="muted">Not yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? <NewDiagram kinds={list.data?.kinds || []} limits={list.data?.limits} runOptions={list.data?.runOptions} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function NewDiagram({ kinds, limits, runOptions, onClose }) {
  const { project } = useProject();
  const { toast } = useUi();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const [form, setForm] = useState({ kind: kinds[0]?.id || 'system_context', repoIds: [], title: '', focus: '' });
  const [run, setRun] = useState(() => initialRunOptions(runOptions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const repoList = repos.data?.repos || [];
  const maxRepos = limits?.repos || 8;
  const toggle = (id) =>
    setForm((f) => ({ ...f, repoIds: f.repoIds.includes(id) ? f.repoIds.filter((x) => x !== id) : f.repoIds.length < maxRepos ? [...f.repoIds, id] : f.repoIds }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.repoIds.length) return;
    setBusy(true);
    setError(null);
    try {
      const body = { kind: form.kind, repoIds: form.repoIds, ...runOptionsBody(run) };
      if (form.title.trim()) body.title = form.title.trim();
      if (form.focus.trim()) body.focus = form.focus.trim();
      const r = await api.post(base(project.id), body);
      toast('Drawing started');
      showWarnings(toast, r.warnings);
      go(project.id, 'diagrams', r.diagram.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New diagram"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-diagram-form" busy={busy} disabled={!form.repoIds.length}>
            Draw it
          </Button>
        </>
      }
    >
      <form id="new-diagram-form" className="stack" onSubmit={submit} noValidate>
        <fieldset className="field">
          <legend className="field-label">Kind</legend>
          <div className="kind-pick">
            {kinds.map((k) => (
              <label key={k.id} className={cx('choice', form.kind === k.id && 'is-checked')}>
                <input type="radio" name="diagram-kind" checked={form.kind === k.id} onChange={() => setForm({ ...form, kind: k.id })} />
                <span>
                  <strong>{k.label}</strong> <span className="muted">{KIND_HINT[k.id]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field">
          <legend className="field-label">Repositories (up to {maxRepos})</legend>
          {repos.loading && !repos.data ? (
            <Spinner small />
          ) : !repoList.length ? (
            <Note tone="warn">
              This project has no repository yet. <a href={href(project.id, 'setup', 'repos')}>Connect one</a> first.
            </Note>
          ) : (
            repoList.map((r) => {
              const ready = r.status === 'ready';
              return (
                <label key={r.id} className={cx('choice', form.repoIds.includes(r.id) && 'is-checked', !ready && 'is-disabled')}>
                  <input type="checkbox" checked={form.repoIds.includes(r.id)} disabled={!ready} onChange={() => toggle(r.id)} />
                  <span>
                    <strong>{r.name}</strong> {!ready ? <span className="muted">(not ready: {r.status})</span> : null}
                  </span>
                </label>
              );
            })
          )}
        </fieldset>
        <Field label="Title (optional)" hint="Leave empty to name it after the kind and repositories.">
          {(id) => <input id={id} className="input" maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}
        </Field>
        <Field label="Focus (optional)" hint="For example: only the payment flow, or leave out the admin screens.">
          {(id) => <textarea id={id} className="input" rows={3} maxLength={limits?.focusChars || 1000} value={form.focus} onChange={(e) => setForm({ ...form, focus: e.target.value })} />}
        </Field>
        <RunOptionsSection runOptions={runOptions} value={run} onChange={setRun} />
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}

function RenameDiagram({ diagram, onClose, onDone }) {
  const { project } = useProject();
  const [title, setTitle] = useState(diagram.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${base(project.id)}/${diagram.id}`, { title: title.trim() });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Rename diagram"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="rename-diagram-form" busy={busy} disabled={!title.trim()}>
            Rename
          </Button>
        </>
      }
    >
      <form id="rename-diagram-form" className="stack" onSubmit={submit} noValidate>
        <Field label="Title">{(id) => <input id={id} className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <p className="muted small">The file name in the project repository stays the same.</p>
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}

function DiagramView({ id, versionParam }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const d = useLoad(() => api.get(`${base(project.id)}/${encodeURIComponent(id)}`), [project.id, id]);
  const wanted = Number(versionParam) || null;
  const older = wanted && wanted !== d.data?.diagram?.version ? wanted : null;
  const old = useLoad(() => (older ? api.get(`${base(project.id)}/${encodeURIComponent(id)}/versions/${older}`) : Promise.resolve(null)), [project.id, id, older]);
  useProjectEvents(['diagrams.updated'], (_e, x) => {
    if (x?.id && d.data && x.id !== d.data.diagram.id) return;
    d.reload(true);
  });
  const list = useLoad(() => api.get(base(project.id)), [project.id]);
  const Heading = useContext(EmbeddedContext) ? 'h2' : 'h1';
  const [busy, setBusy] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const back = (
    <a className="back" href={href(project.id, 'diagrams')}>
      ← Diagrams
    </a>
  );
  if (d.error && !d.data) {
    return (
      <div className="page">
        {back}
        <ErrorNote error={d.error} />
      </div>
    );
  }
  if (!d.data) {
    return (
      <div className="page">
        {back}
        <Spinner />
      </div>
    );
  }

  const { diagram, versions, export: exp } = d.data;
  const showingOld = Boolean(older && old.data);
  const shown = showingOld ? old.data.version : diagram;
  const shownVersion = showingOld ? older : diagram.version;
  const mermaid = showingOld ? old.data.version.mermaid : older ? '' : diagram.mermaid;
  const generating = diagram.status === 'generating';
  const failed = failedRefresh(diagram);

  const act = async (name, fn) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(null);
    }
  };
  const refresh = (body) =>
    act('refresh', async () => {
      const r = await api.post(`${base(project.id)}/${diagram.id}/refresh`, body);
      toast('Redrawing started');
      showWarnings(toast, r.warnings);
      d.reload(true);
    });
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete this diagram?',
      message: `"${diagram.title}" and its ${plural(versions.length, 'version')} will be deleted, and its files removed from the project repository.`,
      confirmLabel: 'Delete diagram',
      danger: true,
    });
    if (!ok) return;
    await act('delete', async () => {
      await api.del(`${base(project.id)}/${diagram.id}`);
      toast('Diagram deleted');
      go(project.id, 'diagrams');
    });
  };
  // Download through fetch so a failure (no PNG renderer, a diagram it cannot draw) shows as a message, not as a saved error file.
  const download = (format) =>
    act(format, async () => {
      const res = await fetch(`${base(project.id)}/${diagram.id}/export?format=${format}&version=${shownVersion}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Export failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${diagram.slug}${shownVersion === diagram.version ? '' : `-v${shownVersion}`}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

  return (
    <div className="page diagram-page">
      {back}
      <header className="learn-head">
        <div>
          <span className="muted small">{diagram.kind_label}</span>
          <Heading>{diagram.title}</Heading>
          <div className="row tight wrap">
            <DiagramBadges d={diagram} />
            {diagram.version ? <span className="muted small">Version {diagram.version}</span> : null}
            <RunChoice item={diagram} />
            {diagram.generated_at ? (
              <span className="muted small" title={dateTime(diagram.generated_at)}>
                Generated {timeAgo(diagram.generated_at)}
              </span>
            ) : null}
          </div>
        </div>
        {canEdit ? (
          <div className="learn-actions">
            <RefreshControl busy={busy === 'refresh'} disabled={generating} runOptions={list.data?.runOptions} stored={diagram} onRefresh={refresh} />
            <Button icon="edit" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button variant="danger" icon="trash" busy={busy === 'delete'} onClick={remove}>
              Delete
            </Button>
          </div>
        ) : null}
      </header>

      {generating ? (
        <Note tone="info" icon="play">
          An agent is drawing this diagram.{' '}
          {diagram.workflow_id ? <a href={sessionHref(project.id, diagram.workflow_id)}>Open the session “Diagram: {diagram.title}”</a> : null}
        </Note>
      ) : null}
      {failed ? (
        <Note tone="warn" icon="alert">
          <strong>Last refresh failed, previous version kept.</strong> {failed}
        </Note>
      ) : null}
      {diagram.status === 'error' ? <ErrorNote error={{ message: diagram.error || 'The diagram could not be drawn.' }} /> : null}
      {diagram.stale && !generating ? (
        <Note tone="warn" icon="alert">
          The code in {diagram.repos.length === 1 ? 'the repository' : 'one of the repositories'} has changed since this was drawn.
          {canEdit ? ' Refresh to redraw it.' : ' An editor can redraw it.'}
        </Note>
      ) : null}
      {older ? (
        <Note tone="info" icon="eye" action={<a href={href(project.id, 'diagrams', diagram.id)}>Back to the latest (v{diagram.version})</a>}>
          You are looking at version {older}. Older versions are read-only.
        </Note>
      ) : null}
      {older && old.error ? <ErrorNote error={old.error} /> : null}
      {older && !old.data && !old.error ? <Spinner /> : null}

      {mermaid ? (
        <section className="panel stack" aria-label="Diagram">
          <Markdown key={`${diagram.id}-${shownVersion}`} text={'```mermaid\n' + mermaid + '\n```'} />
          <div className="row wrap">
            <Button size="sm" icon="download" busy={busy === 'png'} disabled={!exp.png} title={exp.png ? undefined : exp.pngReason} onClick={() => download('png')}>
              Export PNG
            </Button>
            <Button size="sm" icon="download" busy={busy === 'mmd'} onClick={() => download('mmd')}>
              Export .mmd
            </Button>
          </div>
          {!exp.png ? <p className="muted small">PNG export is not available on this server: {exp.pngReason}. The .mmd file is plain Mermaid text.</p> : null}
        </section>
      ) : !generating && !older && diagram.status !== 'error' ? (
        <Empty icon="builder" title="Nothing drawn yet">
          This diagram has no version yet.
        </Empty>
      ) : null}

      {mermaid ? (
        <section className="stack" aria-label="Description">
          <h2>Description</h2>
          <p className="reading">{shown.description || 'No description.'}</p>
          {shown.citations?.length ? (
            <div>
              <h3>Source files cited</h3>
              <ul className="diagram-cites">
                {shown.citations.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <h3>Drawn from</h3>
            <ul className="diagram-cites">
              {(shown.sources || []).map((s) => (
                <li key={s.repoId}>
                  {s.name} <span className="muted">({s.branch})</span> <code title={s.sha}>{String(s.sha).slice(0, 8)}</code>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {versions.length ? (
        <section className="stack" aria-label="Version history">
          <h2>Version history</h2>
          <ul className="diagram-versions">
            {versions.map((v) => {
              const isShown = v.version === shownVersion;
              const link = href(project.id, 'diagrams', diagram.id);
              return (
                <li key={v.version} className={cx(isShown && 'is-shown')}>
                  <strong>v{v.version}</strong>
                  {v.version === diagram.version ? <Badge tone="ok">Latest</Badge> : null}
                  <span className="muted small" title={dateTime(v.created_at)}>
                    {timeAgo(v.created_at)}
                    {v.created_by_name ? ` by ${v.created_by_name}` : ''}
                  </span>
                  {isShown ? <span className="muted small">Viewing</span> : <a href={v.version === diagram.version ? link : `${link}?v=${v.version}`}>View</a>}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {renaming ? (
        <RenameDiagram
          diagram={diagram}
          onClose={() => setRenaming(false)}
          onDone={() => {
            setRenaming(false);
            toast('Renamed');
            d.reload(true);
          }}
        />
      ) : null}
    </div>
  );
}
