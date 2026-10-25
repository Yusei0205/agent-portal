import { useContext, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href, sessionHref } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, dateTime, plural, timeAgo } from '../lib/util.js';
import { DiagramStyleFields, diagramStyleBody, initialStyle, rememberStyle, useApplyDetectedCloud, useDetectedCloud } from '../components/DiagramStyle.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { MermaidViewer } from '../components/MermaidViewer.jsx';
import { OutputLinks } from '../components/OutputLinks.jsx';
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

/** "Icon · AWS" or "Mermaid": how a diagram is drawn. */
export function styleBadgeText(d) {
  return d.style === 'icon' ? `Icon · ${d.cloud_label || d.cloud || 'draw.io'}` : 'Mermaid';
}

function StyleBadge({ d }) {
  return (
    <Badge tone={d.style === 'icon' ? 'accent' : 'muted'}>
      <span data-testid="style-badge">{styleBadgeText(d)}</span>
    </Badge>
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
                <th>Style</th>
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
                    {d.density?.dense ? <div className="warn small">Very dense diagram (about {d.density.nodes} nodes): hard to read, consider splitting it</div> : null}
                    {d.status === 'error' && d.session_id ? (
                      <div className="small">
                        <a href={sessionHref(project.id, d.session_id)}>Open the session</a>
                      </div>
                    ) : null}
                  </td>
                  <td>{d.kind_label}</td>
                  <td>
                    <StyleBadge d={d} />
                  </td>
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
      {creating ? <NewDiagram data={list.data} kinds={list.data?.kinds || []} limits={list.data?.limits} runOptions={list.data?.runOptions} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function NewDiagram({ data, kinds, limits, runOptions, onClose }) {
  const { project } = useProject();
  const { toast } = useUi();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const [form, setForm] = useState({ kind: kinds[0]?.id || 'system_context', repoIds: [], title: '', focus: '' });
  const [run, setRun] = useState(() => initialRunOptions(runOptions));
  const [look, setLook] = useState(() => initialStyle(project.id, data));
  const detect = useDetectedCloud(project.id, form.repoIds, look.style === 'icon');
  const cloudPicked = useApplyDetectedCloud(detect, look, setLook);
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
      const body = { kind: form.kind, repoIds: form.repoIds, ...diagramStyleBody(look), ...runOptionsBody(run) };
      if (form.title.trim()) body.title = form.title.trim();
      if (form.focus.trim()) body.focus = form.focus.trim();
      const r = await api.post(base(project.id), body);
      rememberStyle(project.id, look);
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
        <DiagramStyleFields data={data} value={look} onChange={setLook} what="diagram" detect={detect} onCloudPicked={cloudPicked} name="new-diagram-style" />
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

/** The cloud's name for a code ("aws" -> "AWS"), from the list's `clouds`. */
function cloudWord(code, clouds) {
  if (!code) return '';
  return clouds?.find((c) => c.id === code)?.label || code;
}

/** The picture of an icon diagram (SVG from the server's draw.io renderer). If it cannot be loaded, the server's reason is shown. */
function IconPicture({ url, alt, onFull }) {
  const [problem, setProblem] = useState(null);
  useEffect(() => setProblem(null), [url]);
  const failed = async () => {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      const body = await res.json().catch(() => null);
      setProblem(body?.error || `The picture could not be loaded (${res.status}).`);
    } catch (e) {
      setProblem(e.message);
    }
  };
  if (problem) return <ErrorNote error={{ message: problem }} />;
  return (
    <div className="icon-picture">
      <Button size="sm" className="icon-picture-full" onClick={onFull} title="Open this diagram at full size, with zoom and panning">
        Full size
      </Button>
      <img src={url} alt={alt} onError={failed} data-testid="icon-picture" />
    </div>
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
  const [fullSize, setFullSize] = useState(false);
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

  const { diagram, versions, export: exp, exportIcon: expIcon } = d.data;
  const clouds = list.data?.clouds;
  const showingOld = Boolean(older && old.data);
  const shown = showingOld ? old.data.version : diagram;
  const shownVersion = showingOld ? older : diagram.version;
  const mermaid = showingOld ? old.data.version.mermaid : older ? '' : diagram.mermaid;
  const format = showingOld ? old.data.version.format : diagram.format;
  const isIcon = format === 'drawio';
  const drawio = showingOld ? old.data.version.drawio : older ? '' : diagram.drawio;
  const hasBody = isIcon ? Boolean(drawio) : Boolean(mermaid);
  const shownStyle = showingOld ? old.data.version.style : diagram.style;
  const shownCloud = showingOld ? old.data.version.cloud : diagram.cloud;
  const exportUrl = (fmt) => `${base(project.id)}/${diagram.id}/export?format=${fmt}&version=${shownVersion}`;
  const canPicture = Boolean(expIcon?.svg);
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
            <StyleBadge d={diagram} />
            {diagram.style === 'icon' ? (
              <span className="muted small" data-testid="style-words">
                Style: {diagram.style_label}; cloud: {diagram.cloud_label || cloudWord(diagram.cloud, clouds)}
              </span>
            ) : null}
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
            <RefreshControl
              busy={busy === 'refresh'}
              disabled={generating}
              runOptions={list.data?.runOptions}
              stored={diagram}
              styleOptions={{ projectId: project.id, data: list.data, stored: { style: diagram.style, cloud: diagram.cloud }, what: 'diagram' }}
              onRefresh={refresh}
            />
            <Button icon="edit" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button variant="danger" icon="trash" busy={busy === 'delete'} onClick={remove}>
              Delete
            </Button>
          </div>
        ) : null}
      </header>
      <OutputLinks sessionId={diagram.session_id} vaultFiles={diagram.vault_files} />

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
      {diagram.density?.dense && !older ? (
        <Note tone="warn" icon="alert">
          <strong>Very dense diagram.</strong>{' '}
          {isIcon
            ? `About ${diagram.density.icons} icons and ${diagram.density.edges} connections is hard to read. Use Full size on the picture to zoom, or ask the agent in its session to leave out the minor parts or to draw a smaller diagram.`
            : `About ${diagram.density.nodes} nodes in ${diagram.density.lines} lines is hard to read. Use Full size on the picture to zoom, or ask the agent in its session to group the parts into subgraphs or to draw a smaller diagram.`}
        </Note>
      ) : null}
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

      {isIcon && hasBody ? (
        <section className="panel stack" aria-label="Diagram">
          {canPicture ? (
            <IconPicture url={exportUrl('svg')} alt={`${diagram.title}, version ${shownVersion}: ${shown.description || 'icon diagram'}`} onFull={() => setFullSize(true)} />
          ) : (
            <Note tone="info" icon="eye">
              <strong>No preview picture on this server.</strong> {expIcon?.previewReason || 'The picture renderer is not available'}. The diagram is stored and can be downloaded as a .drawio file; open it in draw.io to see it. Documents and decks that use it get a placeholder instead of the picture.
            </Note>
          )}
          <div className="row wrap">
            <Button size="sm" icon="download" busy={busy === 'drawio'} onClick={() => download('drawio')}>
              Export .drawio
            </Button>
            <Button size="sm" icon="download" busy={busy === 'png'} disabled={!expIcon?.png} title={expIcon?.png ? undefined : expIcon?.previewReason || undefined} onClick={() => download('png')}>
              Export PNG
            </Button>
            <Button size="sm" icon="download" busy={busy === 'svg'} disabled={!expIcon?.svg} title={expIcon?.svg ? undefined : expIcon?.previewReason || undefined} onClick={() => download('svg')}>
              Export SVG
            </Button>
          </div>
          <p className="muted small">The .drawio file opens in draw.io or diagrams.net (File, Open from device) where you can edit it.</p>
          {canPicture ? null : (
            <p className="muted small" data-testid="export-reason">
              PNG and SVG export are not available on this server: {expIcon?.previewReason || 'no picture renderer'}.
            </p>
          )}
        </section>
      ) : mermaid ? (
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

      {hasBody ? (
        <section className="stack" aria-label="Description">
          <h2>Description</h2>
          {isIcon && diagram.density && !older ? (
            <p className="muted small" data-testid="density-note">
              {diagram.density.icons} {diagram.density.icons === 1 ? 'icon' : 'icons'}, {diagram.density.edges} {diagram.density.edges === 1 ? 'connection' : 'connections'}
              {diagram.density.dense ? ' (very dense)' : ''}
              {shownStyle === 'icon' && shownCloud ? `; drawn with the ${cloudWord(shownCloud, clouds)} icons` : ''}.
            </p>
          ) : null}
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
                  <span className="muted small">{v.style === 'icon' ? `Icon · ${cloudWord(v.cloud, clouds)}` : 'Mermaid'}</span>
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
      {fullSize ? <MermaidViewer src={exportUrl('svg')} title="Diagram" onClose={() => setFullSize(false)} /> : null}
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
