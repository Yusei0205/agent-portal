import { useContext, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { saveFromApi } from '../lib/download.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href, sessionHref } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { bytes, cx, dateTime, plural, timeAgo } from '../lib/util.js';
import { OutputLinks } from '../components/OutputLinks.jsx';
import { RunChoice, RunOptionsSection, initialRunOptions, runOptionsBody, showWarnings } from '../components/RunOptions.jsx';
import { Badge, Button, EmbeddedContext, Empty, ErrorNote, Field, Modal, Note, PageHeader, Segmented, Spinner, useUi } from '../components/ui.jsx';

const SOURCE_LABEL = { topic: 'Topic', document: 'Document', session: 'Session result', diagram: 'Diagram' };
const SOURCE_OPTIONS = [
  { value: 'topic', label: 'Topic' },
  { value: 'document', label: 'Document' },
  { value: 'session', label: 'Session result' },
  { value: 'diagram', label: 'Diagram' },
];
const BUILT_IN = 'Built-in look';

/** @param {string} projectId */
const base = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/presentations`;

/** The template a deck follows, in words: the one it used when ready, else the one that was asked for. */
function templateWords(p) {
  if (p.status === 'ready') return p.template.used || BUILT_IN;
  return p.template.requested_name || 'The default';
}

/** Generating (or waiting in the queue), ready or error. */
function StatusBadge({ p }) {
  if (p.status === 'generating') return <Badge tone="accent">{p.queued ? 'Queued' : 'Generating'}</Badge>;
  if (p.status === 'error') return <Badge tone="danger">Error</Badge>;
  return <Badge tone="ok">Ready</Badge>;
}

export function Presentations({ route }) {
  const [id] = route.rest;
  return id ? <DeckView id={id} /> : <PresentationList />;
}

function PresentationList() {
  const { project, canEdit } = useProject();
  const list = useLoad(() => api.get(base(project.id)), [project.id]);
  useProjectEvents(['presentations.updated'], () => list.reload(true));
  const [creating, setCreating] = useState(false);
  const decks = list.data?.presentations || [];

  const newButton = (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      New presentation
    </Button>
  );
  return (
    <div className="page">
      <PageHeader
        title="Presentations"
        sub="PowerPoint decks an agent writes from a topic, a document, a session result or a diagram, following your template."
        actions={canEdit ? newButton : null}
      />
      {list.error && !list.data ? <ErrorNote error={list.error} /> : null}
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.data && !decks.length ? (
        <Empty icon="file" title="No presentations yet" action={canEdit ? newButton : null}>
          {canEdit
            ? 'Choose what the deck is about: a topic you describe, a project document, the result of an earlier session or an architecture diagram. An agent plans the story, writes speaker notes on every slide and builds the .pptx. If your project or the portal has a PowerPoint template, the deck follows it. You can preview every slide before downloading.'
            : 'Nobody has made a presentation for this project yet. Editors can create them.'}
        </Empty>
      ) : decks.length ? (
        <div className="table-wrap">
          <table className="table" aria-label="Presentations">
            <thead>
              <tr>
                <th>Title</th>
                <th>Source</th>
                <th>Status</th>
                <th>Slides</th>
                <th>Template</th>
                <th>Warnings</th>
              </tr>
            </thead>
            <tbody>
              {decks.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={href(project.id, 'presentations', p.id)}>{p.title}</a>
                    <div className="muted small" title={dateTime(p.created_at)}>
                      {timeAgo(p.created_at)}
                      {p.created_by_name ? ` by ${p.created_by_name}` : ''}
                    </div>
                    {p.status === 'error' && p.error ? <div className="danger small">{p.error}</div> : null}
                    {p.status === 'generating' && p.workflow_id ? (
                      <div className="small">
                        <a href={sessionHref(project.id, p.workflow_id)}>Open the running session</a>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {SOURCE_LABEL[p.source.kind]}
                    <div className="muted small">{p.source.label}</div>
                  </td>
                  <td>
                    <StatusBadge p={p} />
                  </td>
                  <td>{p.slide_count ?? <span className="muted">-</span>}</td>
                  <td>{templateWords(p)}</td>
                  <td>{p.warnings.length ? <Badge tone="warn">{plural(p.warnings.length, 'warning')}</Badge> : <span className="muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? <NewPresentation data={list.data} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

/** A picker that loads its choices only while its source is selected. */
function useChoices(active, path, pick) {
  const { project } = useProject();
  return useLoad(() => (active ? api.get(`/api/projects/${encodeURIComponent(project.id)}/${path}`).then(pick) : Promise.resolve(null)), [project.id, active]);
}

function NewPresentation({ data, onClose }) {
  const { project } = useProject();
  const { toast } = useUi();
  const limits = data?.limits || { slidesMin: 3, slidesMax: 40, slidesDefault: 10, topicChars: 4000, audienceChars: 200, titleChars: 120 };
  const [form, setForm] = useState({ kind: 'topic', topic: '', ref: '', audience: '', slides: String(limits.slidesDefault), title: '', templateId: '' });
  const [run, setRun] = useState(() => initialRunOptions(data?.runOptions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const docs = useChoices(form.kind === 'document', 'documents', (r) => (r.documents || []).filter((d) => d.status === 'ready'));
  const sessions = useChoices(form.kind === 'session', 'workflows', (r) => (r.workflows || []).filter((w) => w.status === 'done'));
  const diagrams = useChoices(form.kind === 'diagram', 'diagrams', (r) => (r.diagrams || []).filter((d) => d.status !== 'error' && d.version > 0));
  const templates = useLoad(() => api.get(`/api/projects/${encodeURIComponent(project.id)}/templates`), [project.id]);
  const pptx = (templates.data?.templates || []).filter((t) => t.kind === 'pptx');
  const effective = data?.template;

  const choices = { document: docs, session: sessions, diagram: diagrams }[form.kind];
  const items = choices?.data || [];
  const itemLabel = (it) => it.name || it.title;
  const slidesNum = Number(form.slides);
  const slidesOk = Number.isInteger(slidesNum) && slidesNum >= limits.slidesMin && slidesNum <= limits.slidesMax;
  const sourceOk = form.kind === 'topic' ? form.topic.trim().length >= 3 : Boolean(form.ref);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e) => {
    e.preventDefault();
    if (!sourceOk || !slidesOk) return;
    setBusy(true);
    setError(null);
    try {
      const body = { slideCount: slidesNum, ...runOptionsBody(run) };
      if (form.kind === 'topic') body.topic = form.topic.trim();
      else body[{ document: 'documentId', session: 'sessionId', diagram: 'diagramId' }[form.kind]] = form.ref;
      if (form.audience.trim()) body.audience = form.audience.trim();
      if (form.title.trim()) body.title = form.title.trim();
      if (form.templateId) body.templateId = form.templateId;
      const r = await api.post(base(project.id), body);
      toast('Presentation started');
      showWarnings(toast, r.warnings);
      go(project.id, 'presentations', r.presentation.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New presentation"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-presentation-form" busy={busy} disabled={!sourceOk || !slidesOk}>
            Make the deck
          </Button>
        </>
      }
    >
      <form id="new-presentation-form" className="stack" onSubmit={submit} noValidate>
        <div className="field">
          <span className="field-label" id="pres-source-label">
            What is it about?
          </span>
          <Segmented label="Source of the deck" value={form.kind} options={SOURCE_OPTIONS} onChange={(kind) => set({ kind, ref: '' })} />
        </div>
        {form.kind === 'topic' ? (
          <Field label="Topic" hint="Describe the subject in a few sentences. The agent searches the project knowledge base for facts.">
            {(id) => <textarea id={id} className="input" rows={4} maxLength={limits.topicChars} value={form.topic} onChange={(e) => set({ topic: e.target.value })} />}
          </Field>
        ) : (
          <Field label={`Choose a ${SOURCE_LABEL[form.kind].toLowerCase()}`}>
            {(id) =>
              choices?.loading && !choices.data ? (
                <Spinner small />
              ) : choices?.error ? (
                <ErrorNote error={choices.error} />
              ) : !items.length ? (
                <Note tone="warn">
                  {form.kind === 'document'
                    ? 'This project has no converted document yet. Add one in Knowledge first.'
                    : form.kind === 'session'
                      ? 'No finished session with a result in this project yet.'
                      : 'No drawn diagram yet. Draw one on the Diagrams page first.'}
                </Note>
              ) : (
                <select id={id} className="input" value={form.ref} onChange={(e) => set({ ref: e.target.value })}>
                  <option value="">Select…</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {itemLabel(it)}
                    </option>
                  ))}
                </select>
              )
            }
          </Field>
        )}
        <Field label="Audience (optional)" hint="For example: the leadership team, or new engineers.">
          {(id) => <input id={id} className="input" maxLength={limits.audienceChars} value={form.audience} onChange={(e) => set({ audience: e.target.value })} />}
        </Field>
        <div className="row wrap">
          <Field label={`Number of slides (${limits.slidesMin} to ${limits.slidesMax})`} error={slidesOk ? null : `Enter a whole number from ${limits.slidesMin} to ${limits.slidesMax}.`}>
            {(id) => (
              <input
                id={id}
                type="number"
                className="input input-num"
                min={limits.slidesMin}
                max={limits.slidesMax}
                value={form.slides}
                aria-invalid={!slidesOk}
                onChange={(e) => set({ slides: e.target.value })}
              />
            )}
          </Field>
          <Field label="Title (optional)" hint="Leave empty to name it after the source.">
            {(id) => <input id={id} className="input" maxLength={limits.titleChars} value={form.title} onChange={(e) => set({ title: e.target.value })} />}
          </Field>
        </div>
        <Field
          label="Template"
          hint={
            effective
              ? `Without a choice the deck follows "${effective.name}" (${effective.scope === 'portal' ? 'portal default' : "this project's default"}).`
              : 'No PowerPoint template applies yet, so the built-in look is used. Upload one under Create › Templates.'
          }
        >
          {(id) => (
            <select id={id} className="input" value={form.templateId} onChange={(e) => set({ templateId: e.target.value })}>
              <option value="">{effective ? `Default: ${effective.name}` : BUILT_IN}</option>
              {pptx.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.scope === 'portal' ? 'portal' : 'project'})
                </option>
              ))}
            </select>
          )}
        </Field>
        <RunOptionsSection runOptions={data?.runOptions} value={run} onChange={setRun} />
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}

function DeckView({ id }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const d = useLoad(() => api.get(`${base(project.id)}/${encodeURIComponent(id)}`), [project.id, id]);
  useProjectEvents(['presentations.updated'], (_e, x) => {
    if (x?.id && d.data && x.id !== d.data.presentation.id) return;
    d.reload(true);
  });
  const Heading = useContext(EmbeddedContext) ? 'h2' : 'h1';
  const [busy, setBusy] = useState(null);
  const back = (
    <a className="back" href={href(project.id, 'presentations')}>
      ← Presentations
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
  const p = d.data.presentation;
  const outline = p.outline || [];
  const ready = p.status === 'ready';

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
  const download = () => act('download', () => saveFromApi(p.links.download, `${p.title.replace(/[^\w .-]+/g, '_').trim() || 'presentation'}.pptx`));
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete this presentation?',
      message: `"${p.title}" and its saved file will be deleted. The session that made it stays in Sessions.`,
      confirmLabel: 'Delete presentation',
      danger: true,
    });
    if (!ok) return;
    await act('delete', async () => {
      await api.del(`${base(project.id)}/${p.id}`);
      toast('Presentation deleted');
      go(project.id, 'presentations');
    });
  };

  return (
    <div className="page pres-page">
      {back}
      <header className="learn-head">
        <div>
          <span className="muted small">
            {SOURCE_LABEL[p.source.kind]}: {p.source.label}
          </span>
          <Heading>{p.title}</Heading>
          <div className="row tight wrap">
            <StatusBadge p={p} />
            {ready ? (
              <span className="muted small">
                {plural(p.slide_count, 'slide')}, {bytes(p.bytes)}
              </span>
            ) : null}
            <span className="muted small">Template: {templateWords(p)}</span>
            <RunChoice item={p} />
            <span className="muted small" title={dateTime(p.created_at)}>
              Started {timeAgo(p.created_at)}
              {p.created_by_name ? ` by ${p.created_by_name}` : ''}
            </span>
          </div>
        </div>
        <div className="learn-actions">
          {ready ? (
            <Button variant="primary" icon="download" busy={busy === 'download'} onClick={download}>
              Download .pptx
            </Button>
          ) : null}
          {canEdit ? (
            <Button
              variant="danger"
              icon="trash"
              busy={busy === 'delete'}
              disabled={p.generating}
              title={p.generating ? 'Still being made. Stop its session first.' : undefined}
              onClick={remove}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </header>
      <OutputLinks sessionId={p.workflow_id} vaultFiles={p.vault_files} />

      {p.generating ? (
        <Note tone="info" icon="play">
          {p.queued ? 'This deck is waiting for a free slot. ' : 'An agent is making this deck. '}
          {p.workflow_id ? <a href={sessionHref(project.id, p.workflow_id)}>Open the session “Presentation: {p.title}”</a> : null}
        </Note>
      ) : null}
      {p.status === 'error' ? <ErrorNote error={{ message: p.error || 'The deck could not be made.' }} /> : null}
      {p.status === 'ready' && p.error ? (
        <Note tone="warn" icon="alert">
          <strong>The last attempt failed.</strong> {p.error}
        </Note>
      ) : null}
      {p.status === 'error' && p.workflow_id ? (
        <p className="small">
          <a href={sessionHref(project.id, p.workflow_id)}>Open the session</a> to see what the agent did.
        </p>
      ) : null}
      {p.warnings.length ? (
        <Note tone="warn" icon="alert">
          <strong>{plural(p.warnings.length, 'warning')} from the build</strong>
          <ul className="pres-warnings">
            {p.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Note>
      ) : null}

      {ready ? <SlidePreview key={`${p.id}-${p.updated_at}`} p={p} outline={outline} /> : null}

      {outline.length ? (
        <section className="stack" aria-label="Outline">
          <h2>Outline</h2>
          <div className="table-wrap">
            <table className="table" aria-label="Slide outline">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Title</th>
                  <th>Layout</th>
                  <th>Content</th>
                  <th>Speaker notes</th>
                </tr>
              </thead>
              <tbody>
                {outline.map((s) => (
                  <tr key={s.index}>
                    <td>{s.index}</td>
                    <td>{s.title || <span className="muted">(no title)</span>}</td>
                    <td>{s.layout || <span className="muted">-</span>}</td>
                    <td className="small">{[s.bullets ? plural(s.bullets, 'bullet') : '', s.hasPicture ? 'picture' : '', s.hasTable ? 'table' : ''].filter(Boolean).join(', ') || <span className="muted">-</span>}</td>
                    <td className="small pres-notes">{s.notes || <span className="muted">No notes</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** Thumbnails of every slide and a larger view of the selected one. Drawn by the portal from the file, so approximate. */
function SlidePreview({ p, outline }) {
  const { project } = useProject();
  const pv = useLoad(() => api.get(`${base(project.id)}/${p.id}/preview`), [project.id, p.id]);
  const [picked, setPicked] = useState(1);
  const slides = pv.data?.slides || [];
  const current = slides.find((s) => s.index === picked) || slides[0];
  const notes = outline.find((o) => o.index === current?.index)?.notes;
  return (
    <section className="stack" aria-label="Slide preview">
      <h2>Preview</h2>
      {pv.loading && !pv.data ? (
        <div className="row">
          <Spinner small /> <span className="muted small">Drawing the slides…</span>
        </div>
      ) : null}
      {pv.error && !pv.data ? (
        <>
          <ErrorNote error={pv.error} />
          <div>
            <Button size="sm" icon="refresh" onClick={() => pv.reload()}>
              Try again
            </Button>
          </div>
        </>
      ) : null}
      {pv.data ? (
        <>
          <Note tone="info" icon="eye">
            <strong>Approximate preview.</strong> {pv.data.note}
            {!pv.data.png_available ? (
              <>
                {' '}
                Slides are shown as SVG drawings because PNG is not available on this server{pv.data.png_reason ? `: ${pv.data.png_reason}` : ''}.
              </>
            ) : null}
          </Note>
          {current ? (
            <figure className="pres-stage">
              <img src={current.url} alt={`Slide ${current.index}: ${current.title || 'untitled'}`} />
              <figcaption className="small">
                Slide {current.index} of {slides.length}
                {current.layout ? ` · ${current.layout}` : ''}
                {notes ? <span className="muted"> · Notes: {notes}</span> : null}
              </figcaption>
            </figure>
          ) : null}
          <ul className="pres-thumbs" aria-label="Slides">
            {slides.map((s) => (
              <li key={s.index}>
                <button
                  type="button"
                  className={cx('pres-thumb', current?.index === s.index && 'is-current')}
                  aria-pressed={current?.index === s.index}
                  aria-label={`Show slide ${s.index}: ${s.title || 'untitled'}`}
                  onClick={() => setPicked(s.index)}
                >
                  <img src={s.url} alt="" loading="lazy" />
                  <span className="small">{s.index}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
