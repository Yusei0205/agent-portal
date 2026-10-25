import { useContext, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { saveFromApi } from '../lib/download.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href, sessionHref } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { bytes, cx, dateTime, plural, timeAgo } from '../lib/util.js';
import { OutputLinks } from '../components/OutputLinks.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { RefreshControl, RunChoice, RunOptionsSection, initialRunOptions, runOptionsBody, showWarnings } from '../components/RunOptions.jsx';
import { Badge, Button, EmbeddedContext, Empty, ErrorNote, Field, Modal, Note, PageHeader, Spinner, Toggle, useUi } from '../components/ui.jsx';

const BUILT_IN = 'Built-in look';
const TYPE_HINT = {
  overview: 'What the system is, who uses it and how the parts fit together.',
  architecture: 'Components, data flow, dependencies and the design choices behind them.',
  api: 'Endpoints, inputs, outputs and errors, written from the code.',
  runbook: 'How to run, deploy, monitor and fix the system.',
  'user-guide': 'How a person uses the product, step by step.',
};

/** @param {string} projectId */
const base = (projectId) => `/api/projects/${encodeURIComponent(projectId)}/generated-docs`;

/** The template a document follows, in words: the one its current version used, else the one that was asked for. */
function templateWords(d) {
  if (d.version > 0) return d.template.used || BUILT_IN;
  return d.template.requested_name || 'The default';
}

/** The error of a failed rewrite when an older version is still current, else null. */
function failedRewrite(d) {
  return d.status === 'ready' && d.error ? d.error : null;
}

/** Generating (or queued), ready or error, plus the stale flag with its reasons in words. */
function DocBadges({ d }) {
  return (
    <span className="row tight wrap">
      {d.status === 'generating' ? <Badge tone="accent">{d.queued ? 'Queued' : 'Generating'}</Badge> : d.status === 'error' ? <Badge tone="danger">Error</Badge> : <Badge tone="ok">Ready</Badge>}
      {d.stale && d.status !== 'generating' ? <Badge tone="warn">Stale: sources changed</Badge> : null}
    </span>
  );
}

/** Plain-language list of why a document is stale. */
function StaleReasons({ reasons }) {
  if (!reasons.length) return null;
  return (
    <ul className="gdoc-reasons small">
      {reasons.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

export function GeneratedDocs({ route }) {
  const [id] = route.rest;
  return id ? <DocView id={id} versionParam={route.query.get('v')} /> : <DocList />;
}

function DocList() {
  const { project, canEdit } = useProject();
  const { toast } = useUi();
  const list = useLoad(() => api.get(base(project.id)), [project.id]);
  useProjectEvents(['generated-docs.updated'], () => list.reload(true));
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const docs = list.data?.documents || [];
  const staleCount = docs.filter((d) => d.stale && d.status !== 'generating').length;

  const refreshStale = async (body) => {
    setBusy(true);
    try {
      const r = await api.post(`${base(project.id)}/refresh-stale`, body);
      showWarnings(toast, r.warnings);
      const parts = [`${plural(r.started.length, 'document')} started`];
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
      New document
    </Button>
  );
  return (
    <div className="page">
      <PageHeader
        title="Generated docs"
        sub="Word and Markdown documents an agent writes from your repositories, knowledge and diagrams, with citations to the code. Not to be confused with the uploaded files in Knowledge."
        actions={
          canEdit ? (
            <>
              {staleCount ? (
                <RefreshControl
                  label={`Refresh all stale (${staleCount})`}
                  busy={busy}
                  runOptions={list.data?.runOptions}
                  note="The plain button reuses the choice saved with each document. Pick one here to use it for every stale document in this refresh; it replaces what each had saved."
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
      ) : list.data && !docs.length ? (
        <Empty icon="file" title="No generated documents yet" action={canEdit ? newButton : null}>
          {canEdit
            ? 'Choose the kind of document (overview, architecture, API reference, runbook or user guide) and what it is written from: repositories, the project knowledge, the decisions log and architecture diagrams. An agent reads the code and writes it, cites the files and lines it used, and builds a Word file that follows your template. When the sources change, the document is marked stale so you can rewrite it.'
            : 'Nobody has generated a document for this project yet. Editors can create them from the project repositories.'}
        </Empty>
      ) : docs.length ? (
        <div className="table-wrap">
          <table className="table" aria-label="Generated documents">
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Status</th>
                <th>Version</th>
                <th>Template</th>
                <th>Warnings</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>
                    <a href={href(project.id, 'documents', d.id)}>{d.title}</a>
                    <div className="muted small" title={dateTime(d.created_at)}>
                      {timeAgo(d.created_at)}
                      {d.created_by_name ? ` by ${d.created_by_name}` : ''}
                    </div>
                    {d.stale && d.status !== 'generating' ? <StaleReasons reasons={d.stale_reasons} /> : null}
                    {failedRewrite(d) ? <div className="danger small">Last rewrite failed, previous version kept</div> : null}
                    {d.status === 'error' && d.error ? <div className="danger small">{d.error}</div> : null}
                    {d.status === 'generating' && d.workflow_id ? (
                      <div className="small">
                        <a href={sessionHref(project.id, d.workflow_id)}>Open the running session</a>
                      </div>
                    ) : null}
                  </td>
                  <td>{d.type_label}</td>
                  <td>
                    <DocBadges d={d} />
                  </td>
                  <td>{d.version ? `v${d.version}` : <span className="muted">-</span>}</td>
                  <td>{templateWords(d)}</td>
                  <td>{d.warnings.length ? <Badge tone="warn">{plural(d.warnings.length, 'warning')}</Badge> : <span className="muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? <NewDocument data={list.data} runOptions={list.data?.runOptions} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

/** The Word templates the project can use, and the one that applies when none is chosen. */
function useWordTemplates() {
  const { project } = useProject();
  const templates = useLoad(() => api.get(`/api/projects/${encodeURIComponent(project.id)}/templates`), [project.id]);
  return { loading: templates.loading && !templates.data, list: (templates.data?.templates || []).filter((t) => t.kind === 'docx') };
}

function TemplateSelect({ value, onChange, effective, options }) {
  return (
    <Field
      label="Word template"
      hint={
        effective
          ? `Without a choice the document follows "${effective.name}" (${effective.scope === 'portal' ? 'portal default' : "this project's default"}).`
          : 'No Word template applies yet, so the built-in look is used. Upload one under Create › Templates.'
      }
    >
      {(id) => (
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{effective ? `Default: ${effective.name}` : BUILT_IN}</option>
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.scope === 'portal' ? 'portal' : 'project'})
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function NewDocument({ data, runOptions, onClose }) {
  const { project } = useProject();
  const { toast } = useUi();
  const limits = data?.limits || { titleChars: 120, audienceChars: 200, repos: 8, diagrams: 10 };
  const types = data?.types || [];
  const repos = useLoad(() => api.get(`/api/projects/${encodeURIComponent(project.id)}/repos`), [project.id]);
  const diagrams = useLoad(() => api.get(`/api/projects/${encodeURIComponent(project.id)}/diagrams`), [project.id]);
  const tpl = useWordTemplates();
  const [run, setRun] = useState(() => initialRunOptions(runOptions));
  const [form, setForm] = useState({ type: types[0]?.id || 'overview', repoIds: [], includeKnowledge: true, includeDecisions: true, diagramIds: [], audience: '', title: '', templateId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const readyRepos = (repos.data?.repos || []).filter((r) => r.status === 'ready');
  const otherRepos = (repos.data?.repos || []).filter((r) => r.status !== 'ready');
  const drawn = (diagrams.data?.diagrams || []).filter((g) => g.status !== 'error' && g.version > 0);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const pick = (key, id, max) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : f[key].length < max ? [...f[key], id] : f[key] }));
  const sourceOk = form.repoIds.length > 0 || form.includeKnowledge || form.includeDecisions || form.diagramIds.length > 0;

  const submit = async (e) => {
    e.preventDefault();
    if (!sourceOk) return;
    setBusy(true);
    setError(null);
    try {
      const body = { type: form.type, repoIds: form.repoIds, includeKnowledge: form.includeKnowledge, includeDecisions: form.includeDecisions, diagramIds: form.diagramIds, ...runOptionsBody(run) };
      if (form.audience.trim()) body.audience = form.audience.trim();
      if (form.title.trim()) body.title = form.title.trim();
      if (form.templateId) body.templateId = form.templateId;
      const r = await api.post(base(project.id), body);
      toast('Document started');
      showWarnings(toast, r.warnings);
      go(project.id, 'documents', r.document.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New document"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-gdoc-form" busy={busy} disabled={!sourceOk}>
            Write it
          </Button>
        </>
      }
    >
      <form id="new-gdoc-form" className="stack" onSubmit={submit} noValidate>
        <fieldset className="field">
          <legend className="field-label">Type</legend>
          <div className="kind-pick">
            {types.map((t) => (
              <label key={t.id} className={cx('choice', form.type === t.id && 'is-checked')}>
                <input type="radio" name="gdoc-type" checked={form.type === t.id} onChange={() => set({ type: t.id })} />
                <span>
                  <strong>{t.label}</strong> <span className="muted">{TYPE_HINT[t.id]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field">
          <legend className="field-label">Repositories (up to {limits.repos})</legend>
          {repos.loading && !repos.data ? (
            <Spinner small />
          ) : repos.error ? (
            <ErrorNote error={repos.error} />
          ) : !readyRepos.length ? (
            <Note tone="info">
              No repository is ready yet. <a href={href(project.id, 'setup', 'repos')}>Connect or sync one</a>, or write from the knowledge, decisions or diagrams below.
            </Note>
          ) : (
            readyRepos.map((r) => (
              <label key={r.id} className={cx('choice', form.repoIds.includes(r.id) && 'is-checked')}>
                <input type="checkbox" checked={form.repoIds.includes(r.id)} onChange={() => pick('repoIds', r.id, limits.repos)} />
                <span>
                  <strong>{r.name}</strong>
                </span>
              </label>
            ))
          )}
          {otherRepos.length ? <p className="field-hint">Not offered because they are not ready: {otherRepos.map((r) => r.name).join(', ')}.</p> : null}
        </fieldset>
        <fieldset className="field">
          <legend className="field-label">Also use</legend>
          <div className="stack">
            <Toggle checked={form.includeKnowledge} onChange={(v) => set({ includeKnowledge: v })} label="Project knowledge (the converted documents)" />
            <Toggle checked={form.includeDecisions} onChange={(v) => set({ includeDecisions: v })} label="Decisions log" />
          </div>
        </fieldset>
        <fieldset className="field">
          <legend className="field-label">Diagrams (optional, up to {limits.diagrams})</legend>
          {diagrams.loading && !diagrams.data ? (
            <Spinner small />
          ) : !drawn.length ? (
            <p className="field-hint">
              No drawn diagram yet. Draw one on the <a href={href(project.id, 'diagrams')}>Diagrams</a> page to place it in a document.
            </p>
          ) : (
            drawn.map((g) => (
              <label key={g.id} className={cx('choice', form.diagramIds.includes(g.id) && 'is-checked')}>
                <input type="checkbox" checked={form.diagramIds.includes(g.id)} onChange={() => pick('diagramIds', g.id, limits.diagrams)} />
                <span>
                  <strong>{g.title}</strong> <span className="muted">v{g.version}</span>
                </span>
              </label>
            ))
          )}
          {form.diagramIds.length && data?.word && !data.word.diagrams ? (
            <Note tone="warn" icon="alert">
              In the Word file, diagrams stay as code blocks: {data.word.diagramsReason}. They are drawn in the on-screen view.
            </Note>
          ) : null}
        </fieldset>
        {!sourceOk ? <Note tone="warn">Choose at least one source: a repository, the knowledge, the decisions log or a diagram.</Note> : null}
        <div className="row wrap">
          <Field label="Audience (optional)" hint="For example: new engineers, or the operations team.">
            {(id) => <input id={id} className="input" maxLength={limits.audienceChars} value={form.audience} onChange={(e) => set({ audience: e.target.value })} />}
          </Field>
          <Field label="Title (optional)" hint="Leave empty to name it after the type and repositories.">
            {(id) => <input id={id} className="input" maxLength={limits.titleChars} value={form.title} onChange={(e) => set({ title: e.target.value })} />}
          </Field>
        </div>
        <TemplateSelect value={form.templateId} onChange={(templateId) => set({ templateId })} effective={data?.template} options={tpl.list} />
        <RunOptionsSection runOptions={runOptions} value={run} onChange={setRun} />
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}

function RegenerateDialog({ doc, effective, runOptions, onClose, onDone }) {
  const { project } = useProject();
  const tpl = useWordTemplates();
  const [run, setRun] = useState(() => initialRunOptions(runOptions, doc));
  const [form, setForm] = useState({ audience: doc.audience || '', title: doc.title, templateId: doc.template.requested_id || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`${base(project.id)}/${doc.id}/regenerate`, { audience: form.audience.trim(), title: form.title.trim(), templateId: form.templateId || null, ...runOptionsBody(run) });
      onDone(r);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Regenerate document"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="regen-gdoc-form" busy={busy} disabled={!form.title.trim()}>
            Rewrite it
          </Button>
        </>
      }
    >
      <form id="regen-gdoc-form" className="stack" onSubmit={submit} noValidate>
        <p className="muted small">The agent rewrites the document from the same sources, brought up to date. The result is saved as version {doc.version + 1}; older versions stay.</p>
        <Field label="Title">{(id) => <input id={id} className="input" maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
        <Field label="Audience (optional)">{(id) => <input id={id} className="input" maxLength={200} value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} />}</Field>
        <TemplateSelect value={form.templateId} onChange={(templateId) => setForm({ ...form, templateId })} effective={effective} options={tpl.list} />
        <RunOptionsSection runOptions={runOptions} value={run} onChange={setRun} />
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}

/** What the sources of one version were, and how they compare with now (diagram versions) or with the stale reasons. */
function SourcesPanel({ shown, doc }) {
  const s = shown.sources;
  return (
    <div className="stack">
      <h3>Written from</h3>
      <ul className="diagram-cites">
        {s.repos.map((r) => (
          <li key={r.id}>
            {r.name} <span className="muted">({r.branch})</span> <code title={r.commit || undefined}>{String(r.commit || 'no checkout').slice(0, 8)}</code>
          </li>
        ))}
        {s.knowledge ? (
          <li>
            Knowledge: {plural(s.knowledge.documents, 'document')}
            {s.knowledge.names.length ? <span className="muted"> ({s.knowledge.names.join(', ')})</span> : null}
          </li>
        ) : null}
        {s.decisions ? <li>Decisions log</li> : null}
        {s.diagrams.map((g) => {
          const now = doc.diagrams.find((x) => x.id === g.id);
          const newer = now && !now.removed && now.current_version !== null && now.current_version !== g.version;
          return (
            <li key={g.id}>
              Diagram “{g.title}” <code>v{g.version}</code>
              {now?.removed ? <span className="warn small"> (removed since)</span> : newer ? <span className="warn small"> (now v{now.current_version})</span> : <span className="muted small"> (current)</span>}
            </li>
          );
        })}
        {!s.repos.length && !s.knowledge && !s.decisions && !s.diagrams.length ? <li className="muted">No sources recorded.</li> : null}
      </ul>
    </div>
  );
}

function CitationsPanel({ citations }) {
  const items = citations.items || [];
  return (
    <section className="stack" aria-label="Citations">
      <h2>Citations</h2>
      <p className="muted small">
        {citations.total
          ? `${citations.total - citations.unresolved} of ${citations.total} cited locations resolve against the repository snapshot the document was written from.`
          : 'This version cites no source files.'}
      </p>
      {items.length ? (
        <ul className="gdoc-cites">
          {items.map((c, i) => (
            <li key={`${c.text}-${i}`} className={cx(!c.ok && 'is-bad')}>
              {c.ok ? <Badge tone="ok">Resolved</Badge> : <Badge tone="danger">Unresolved</Badge>}
              <code>{c.text}</code>
              {!c.ok && c.reason ? <span className="muted small">{c.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DocView({ id, versionParam }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const d = useLoad(() => api.get(`${base(project.id)}/${encodeURIComponent(id)}`), [project.id, id]);
  const wanted = Number(versionParam) || null;
  const older = wanted && wanted !== d.data?.document?.version ? wanted : null;
  const old = useLoad(() => (older ? api.get(`${base(project.id)}/${encodeURIComponent(id)}/versions/${older}`) : Promise.resolve(null)), [project.id, id, older]);
  const list = useLoad(() => api.get(base(project.id)), [project.id]);
  useProjectEvents(['generated-docs.updated'], (_e, x) => {
    list.reload(true);
    if (x?.id && d.data && x.id !== d.data.document.id) return;
    d.reload(true);
  });
  const Heading = useContext(EmbeddedContext) ? 'h2' : 'h1';
  const [busy, setBusy] = useState(null);
  const [regenerating, setRegenerating] = useState(false);
  const back = (
    <a className="back" href={href(project.id, 'documents')}>
      ← Generated docs
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

  const doc = d.data.document;
  const word = d.data.word;
  const showingOld = Boolean(older && old.data);
  const shown = showingOld ? old.data.version : doc.current;
  const shownVersion = showingOld ? older : doc.version;
  const markdown = showingOld ? old.data.version.markdown : older ? '' : doc.markdown;
  const generating = doc.generating;
  const failed = failedRewrite(doc);
  const staleNow = doc.stale && !generating;
  const fileBase = `${doc.title.replace(/[^\w .-]+/g, '_').trim().slice(0, 80) || 'document'}${shownVersion === doc.version ? '' : `-v${shownVersion}`}`;
  const wordLink = shown?.links?.word;

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
  // Downloads go through fetch so a refusal (a version with no Word file) shows as a message, not as a saved error file.
  const download = (format) =>
    act(format, () => saveFromApi(format === 'docx' ? wordLink : shown.links.markdown, `${fileBase}.${format === 'docx' ? 'docx' : 'md'}`));
  const refreshStale = (body) =>
    act('refresh', async () => {
      const r = await api.post(`${base(project.id)}/refresh-stale`, body);
      showWarnings(toast, r.warnings);
      toast(r.started.length ? `${plural(r.started.length, 'document')} started` : r.skipped[0]?.reason || 'Nothing to refresh', r.started.length ? 'ok' : 'danger');
      d.reload(true);
    });
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete this document?',
      message: `"${doc.title}" and its ${plural(doc.versions.length, 'version')}, with their Word files, will be deleted. The sessions that wrote it stay in Sessions.`,
      confirmLabel: 'Delete document',
      danger: true,
    });
    if (!ok) return;
    await act('delete', async () => {
      await api.del(`${base(project.id)}/${doc.id}`);
      toast('Document deleted');
      go(project.id, 'documents');
    });
  };

  const showWordNote = doc.diagrams.length > 0 && word && !word.diagrams;
  return (
    <div className="page gdoc-page">
      {back}
      <header className="learn-head">
        <div>
          <span className="muted small">{doc.type_label}</span>
          <Heading>{doc.title}</Heading>
          <div className="row tight wrap">
            <DocBadges d={doc} />
            {doc.version ? <span className="muted small">Version {doc.version}</span> : null}
            {doc.version ? <span className="muted small">Template: {templateWords(doc)}</span> : null}
            <RunChoice item={doc} />
            {doc.generated_at ? (
              <span className="muted small" title={dateTime(doc.generated_at)}>
                Generated {timeAgo(doc.generated_at)}
              </span>
            ) : null}
            {doc.version ? <span className="muted small">{bytes(doc.bytes)}</span> : null}
          </div>
        </div>
        <div className="learn-actions">
          {shown ? (
            <>
              <Button variant="primary" icon="download" busy={busy === 'docx'} disabled={!wordLink} title={wordLink ? undefined : 'This version has no Word file'} onClick={() => download('docx')}>
                Download Word
              </Button>
              <Button icon="download" busy={busy === 'md'} onClick={() => download('md')}>
                Download Markdown
              </Button>
            </>
          ) : null}
          {canEdit ? (
            <>
              {list.data && list.data.documents.filter((x) => x.stale && x.status !== 'generating').length ? (
                <RefreshControl
                  label={`Refresh all stale (${list.data.documents.filter((x) => x.stale && x.status !== 'generating').length})`}
                  busy={busy === 'refresh'}
                  runOptions={list.data.runOptions}
                  note="The plain button reuses the choice saved with each document. Pick one here to use it for every stale document in this refresh; it replaces what each had saved."
                  onRefresh={refreshStale}
                />
              ) : null}
              <Button icon="refresh" disabled={generating} title={generating ? 'Still being written' : undefined} onClick={() => setRegenerating(true)}>
                Regenerate
              </Button>
              <Button variant="danger" icon="trash" busy={busy === 'delete'} disabled={generating} title={generating ? 'Still being written. Stop its session first.' : undefined} onClick={remove}>
                Delete
              </Button>
            </>
          ) : null}
        </div>
      </header>
      <OutputLinks sessionId={doc.workflow_id} vaultFiles={doc.vault_files} />

      {generating ? (
        <Note tone="info" icon="play">
          {doc.queued ? 'This document is waiting for a free slot. ' : 'An agent is writing this document. '}
          {doc.workflow_id ? <a href={sessionHref(project.id, doc.workflow_id)}>Open the session “Document: {doc.title}”</a> : null}
        </Note>
      ) : null}
      {failed ? (
        <Note tone="warn" icon="alert">
          <strong>Last rewrite failed, previous version kept.</strong> {failed}
        </Note>
      ) : null}
      {doc.status === 'error' ? <ErrorNote error={{ message: doc.error || 'The document could not be written.' }} /> : null}
      {doc.status === 'error' && doc.workflow_id ? (
        <p className="small">
          <a href={sessionHref(project.id, doc.workflow_id)}>Open the session</a> to see what the agent did.
        </p>
      ) : null}
      {staleNow ? (
        <Note tone="warn" icon="alert">
          <strong>Stale.</strong> The sources changed since this was written{canEdit ? '. Regenerate to bring it up to date.' : '. An editor can regenerate it.'}
          <StaleReasons reasons={doc.stale_reasons} />
        </Note>
      ) : null}
      {showWordNote ? (
        <Note tone="info" icon="file">
          In the Word file, diagrams stay as code blocks: {word.diagramsReason}. They are drawn in the view below.
        </Note>
      ) : null}
      {older ? (
        <Note tone="info" icon="eye" action={<a href={href(project.id, 'documents', doc.id)}>Back to the latest (v{doc.version})</a>}>
          You are looking at version {older}. Older versions are read-only.
        </Note>
      ) : null}
      {showingOld && !wordLink ? (
        <Note tone="warn" icon="alert">
          This version has no Word file (it could not be built, or it was written before Word files were kept). Download the Markdown instead.
        </Note>
      ) : null}
      {older && old.error ? <ErrorNote error={old.error} /> : null}
      {older && !old.data && !old.error ? <Spinner /> : null}

      {shown?.warnings?.length ? (
        <Note tone="warn" icon="alert">
          <strong>{plural(shown.warnings.length, 'warning')} from the build</strong>
          <ul className="pres-warnings">
            {shown.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Note>
      ) : null}

      {markdown ? (
        <section className="panel gdoc-body" aria-label="Document">
          <Markdown key={`${doc.id}-${shownVersion}`} text={markdown} />
        </section>
      ) : !generating && !older && doc.status !== 'error' ? (
        <Empty icon="file" title="Nothing written yet">
          This document has no version yet.
        </Empty>
      ) : null}

      {shown ? <CitationsPanel citations={shown.citations} /> : null}
      {shown ? (
        <section className="stack" aria-label="Sources">
          <h2>Sources</h2>
          <SourcesPanel shown={shown} doc={doc} />
        </section>
      ) : null}

      {doc.versions.length ? (
        <section className="stack" aria-label="Version history">
          <h2>Version history</h2>
          <ul className="diagram-versions">
            {doc.versions.map((v) => {
              const isShown = v.version === shownVersion;
              const link = href(project.id, 'documents', doc.id);
              return (
                <li key={v.version} className={cx(isShown && 'is-shown')}>
                  <strong>v{v.version}</strong>
                  {v.version === doc.version ? <Badge tone="ok">Latest</Badge> : null}
                  <span className="muted small" title={dateTime(v.created_at)}>
                    {timeAgo(v.created_at)}
                    {v.created_by_name ? ` by ${v.created_by_name}` : ''}
                  </span>
                  <span className="muted small">
                    {v.template_used || BUILT_IN}
                    {v.warnings.length ? `, ${plural(v.warnings.length, 'warning')}` : ''}
                    {v.has_word ? '' : ', no Word file'}
                  </span>
                  {isShown ? <span className="muted small">Viewing</span> : <a href={v.version === doc.version ? link : `${link}?v=${v.version}`}>View</a>}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {regenerating ? (
        <RegenerateDialog
          doc={doc}
          effective={list.data?.template}
          runOptions={list.data?.runOptions}
          onClose={() => setRegenerating(false)}
          onDone={(r) => {
            setRegenerating(false);
            toast('Rewrite started');
            showWarnings(toast, r?.warnings);
            go(project.id, 'documents', doc.id);
            d.reload(true);
          }}
        />
      ) : null}
    </div>
  );
}
