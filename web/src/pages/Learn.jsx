import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, plural, timeAgo } from '../lib/util.js';
import { useSortable } from '../lib/useSortable.js';
import { Icon } from '../components/Icon.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { SortHeader } from '../components/SortHeader.jsx';
import { Badge, Button, Empty, ErrorNote, Field, IconButton, Modal, Note, PageHeader, Progress, Segmented, Spinner, Tabs, Toggle, useUi } from '../components/ui.jsx';

const KINDS = [
  { value: 'overview', label: 'System overview', hint: 'What the system does, who uses it, how the parts fit.' },
  { value: 'feature', label: 'Feature guide', hint: 'Steps, business rules, and how it is built.' },
  { value: 'glossary', label: 'Glossary', hint: 'Every term in plain words and in code.' },
  { value: 'faq', label: 'FAQ', hint: 'The questions newcomers ask most.' },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));
const AUDIENCE = { business: 'Everyone', technical: 'Engineers' };

export function Learn({ route }) {
  const { project, canEdit } = useProject();
  const [sub, id, mode] = route.rest;
  if (sub === 'doc' && id) return <LearnDocView id={id} />;
  if (sub === 'quiz' && id) return mode === 'take' || !canEdit ? <TakeQuiz id={id} /> : <QuizEditor id={id} />;
  if (sub === 'path' && id) return <PathView id={id} />;
  const tab = ['quizzes', 'paths', 'progress'].includes(sub) ? sub : 'docs';
  return (
    <div className="page">
      <PageHeader title="Learn" sub="Documentation and quizzes written from the project documents, in plain language for everyone and in detail for engineers." />
      <Tabs
        value={tab}
        tabs={[
          { value: 'docs', label: 'Documents', href: href(project.id, 'learn') },
          { value: 'quizzes', label: 'Quizzes', href: href(project.id, 'learn', 'quizzes') },
          { value: 'paths', label: 'Onboarding paths', href: href(project.id, 'learn', 'paths') },
          ...(canEdit ? [{ value: 'progress', label: 'Team progress', href: href(project.id, 'learn', 'progress') }] : []),
        ]}
      />
      {tab === 'docs' ? <DocList /> : tab === 'quizzes' ? <QuizList /> : tab === 'paths' ? <PathList /> : <TeamProgress />}
    </div>
  );
}

function StatusBadges({ item }) {
  return (
    <span className="row tight">
      <Badge status={item.status} />
      {item.stale ? <Badge tone="warn">Sources changed</Badge> : null}
    </span>
  );
}

// SourcePicker — grouped, collapsible, tri-state tree of source documents.
// Value/onChange contract: array of doc ids (unchanged).
function SourcePicker({ value, onChange }) {
  const { project } = useProject();
  const docs = useLoad(() => api.get(`/api/projects/${project.id}/documents`), [project.id]);
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const repoList = repos.data?.repos || [];
  const repoName = (id) => repoList.find((r) => r.id === id)?.name;

  // All ready documents
  const list = useMemo(() => (docs.data?.documents || []).filter((d) => d.status === 'ready'), [docs.data]);
  const uploadDocs = useMemo(() => list.filter((d) => d.kind === 'upload'), [list]);
  const decisionDoc = useMemo(() => list.find((d) => d.kind === 'decisions'), [list]);

  // Seed value when data first arrives
  useEffect(() => {
    if (docs.data && value === null) onChange(uploadDocs.map((d) => d.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.data]);

  // Group-by mode — same auto rule as Knowledge page
  const [groupBy, setGroupBy] = useState(() => {
    try { return localStorage.getItem('kb-group-by') || 'auto'; } catch { return 'auto'; }
  });
  const setGroupBySaved = (v) => {
    setGroupBy(v);
    try { localStorage.setItem('kb-group-by', v); } catch { /* ok */ }
  };

  const [filter, setFilter] = useState('');
  // collapsed: Set of group keys. Default: collapse all groups when there are many (>= 3 groups or > 8 upload docs)
  const [collapsed, setCollapsed] = useState(null); // null = not yet initialised

  const mode = groupBy !== 'auto' ? groupBy : list.some((d) => d.repo_id) ? 'repo' : 'folder';

  const groupKey = (d) => (mode === 'repo' ? d.repo_id || '' : mode === 'folder' ? d.folder || '' : '');
  const groupLabel = (key) =>
    mode === 'repo'
      ? key ? repoName(key) || 'Removed repository' : 'No repository'
      : key || 'No folder';

  // Build groups from upload docs only
  const groups = useMemo(() => {
    const map = new Map();
    for (const d of uploadDocs) {
      const k = groupKey(d);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(d);
    }
    const arr = [];
    for (const [key, docs] of map) {
      docs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      arr.push({ key, docs });
    }
    // Untagged first, then A-Z
    arr.sort((a, b) => a.key === '' ? -1 : b.key === '' ? 1 : groupLabel(a.key).localeCompare(groupLabel(b.key), undefined, { sensitivity: 'base' }));
    return arr;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadDocs, mode, repoList]);

  const hasGroups = mode !== 'none' && groups.length > 1;

  // Initialise collapsed state when groups are ready
  const collapsedSet = useMemo(() => {
    if (collapsed !== null) return collapsed;
    // Default: collapse when >= 3 groups or > 8 upload docs
    if (hasGroups && (groups.length >= 3 || uploadDocs.length > 8)) {
      return new Set(groups.map((g) => g.key));
    }
    return new Set();
  }, [collapsed, groups, hasGroups, uploadDocs.length]);

  const toggleCollapse = (key) => {
    const next = new Set(collapsedSet);
    next.has(key) ? next.delete(key) : next.add(key);
    setCollapsed(next);
  };

  // Filter text
  const filterLc = filter.trim().toLowerCase();
  const matchDoc = (d) => !filterLc || d.name.toLowerCase().includes(filterLc);

  const sel = value || [];
  const selSet = useMemo(() => new Set(sel), [sel]);

  // Toggle a single doc
  const toggleDoc = (id) =>
    onChange(selSet.has(id) ? sel.filter((x) => x !== id) : [...sel, id]);

  // Toggle a group (all upload docs in this group that pass the filter)
  const groupState = (docs) => {
    const visible = docs.filter(matchDoc);
    const checked = visible.filter((d) => selSet.has(d.id)).length;
    if (checked === 0) return 'unchecked';
    if (checked === visible.length) return 'checked';
    return 'indeterminate';
  };

  const toggleGroup = (docs) => {
    const visible = docs.filter(matchDoc);
    const allOn = visible.every((d) => selSet.has(d.id));
    if (allOn) {
      onChange(sel.filter((id) => !visible.some((d) => d.id === id)));
    } else {
      const add = visible.filter((d) => !selSet.has(d.id)).map((d) => d.id);
      onChange([...sel, ...add]);
    }
  };

  // Select all / Clear (only upload docs, filter-aware)
  const allUploadFiltered = useMemo(() => uploadDocs.filter(matchDoc), [uploadDocs, filterLc]);
  const selectAll = () => {
    const add = allUploadFiltered.filter((d) => !selSet.has(d.id)).map((d) => d.id);
    if (add.length) onChange([...sel, ...add]);
  };
  const clearAll = () => onChange(sel.filter((id) => !allUploadFiltered.some((d) => d.id === id)));

  // Count
  const selectedUploadCount = uploadDocs.filter((d) => selSet.has(d.id)).length;

  if (!docs.data) return <Spinner small />;
  if (uploadDocs.length === 0) {
    return (
      <p className="muted small">
        Upload documents in <a href={href(project.id, 'knowledge')}>Knowledge</a> first.
      </p>
    );
  }

  return (
    <div className="source-picker">
      {/* Toolbar */}
      <div className="source-picker-bar">
        <input
          className="input input-sm source-picker-filter"
          type="search"
          placeholder="Filter documents…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter source documents"
        />
        {repoList.length ? (
          <Segmented
            value={mode}
            onChange={setGroupBySaved}
            label="Group by"
            size="sm"
            options={[
              { value: 'repo', label: 'Repository' },
              { value: 'folder', label: 'Folder' },
              { value: 'none', label: 'None' },
            ]}
          />
        ) : null}
      </div>
      <div className="source-picker-actions">
        <button type="button" className="linkish small" onClick={selectAll}>Select all</button>
        <span className="muted" aria-hidden="true">·</span>
        <button type="button" className="linkish small" onClick={clearAll}>Clear</button>
        <span className="source-picker-count muted small">
          {selectedUploadCount} of {uploadDocs.length} selected
        </span>
      </div>
      {/* Document tree */}
      <div className="check-list source-picker-list" role="tree" aria-label="Source documents">
        {/* Decisions log always at top */}
        {decisionDoc ? (
          <label key={decisionDoc.id} className="check" role="treeitem" aria-level={1}>
            <input
              type="checkbox"
              checked={selSet.has(decisionDoc.id)}
              onChange={() => toggleDoc(decisionDoc.id)}
              aria-label={`${decisionDoc.name} (decisions log)`}
            />
            <span>{decisionDoc.name}</span>
            <span className="muted small">decisions log</span>
          </label>
        ) : null}
        {/* Groups or flat list */}
        {hasGroups
          ? groups.map((g) => {
              const visibleDocs = g.docs.filter(matchDoc);
              if (!visibleDocs.length && filterLc) return null;
              const state = groupState(g.docs);
              const isCollapsed = collapsedSet.has(g.key);
              const label = groupLabel(g.key);
              const groupId = `spg-${g.key || 'none'}`;
              return (
                <div key={g.key} className="source-picker-group" role="group" aria-label={label}>
                  <div className="source-picker-group-head">
                    {/* Tri-state group checkbox */}
                    <span
                      role="checkbox"
                      tabIndex={0}
                      aria-checked={state === 'indeterminate' ? 'mixed' : state === 'checked'}
                      aria-label={`Select all in ${label}`}
                      className={`check-tri check-tri-${state}`}
                      onClick={() => toggleGroup(g.docs)}
                      onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && toggleGroup(g.docs)}
                    />
                    {/* Collapse toggle */}
                    <button
                      type="button"
                      className="source-picker-group-toggle"
                      aria-expanded={!isCollapsed}
                      aria-controls={groupId}
                      onClick={() => toggleCollapse(g.key)}
                    >
                      <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={13} />
                      <strong>{label}</strong>
                      <span className="muted small">{plural(g.docs.length, 'doc')}</span>
                    </button>
                  </div>
                  {!isCollapsed ? (
                    <div id={groupId} className="source-picker-group-docs">
                      {visibleDocs.length === 0 ? (
                        <span className="muted small source-picker-empty">No matches</span>
                      ) : (
                        visibleDocs.map((d) => (
                          <label key={d.id} className="check" role="treeitem" aria-level={2}>
                            <input
                              type="checkbox"
                              checked={selSet.has(d.id)}
                              onChange={() => toggleDoc(d.id)}
                            />
                            <span>{d.name}</span>
                            {d.sections_count ? <span className="muted small">{d.sections_count} sec</span> : null}
                          </label>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          : uploadDocs.filter(matchDoc).map((d) => (
              <label key={d.id} className="check" role="treeitem" aria-level={1}>
                <input
                  type="checkbox"
                  checked={selSet.has(d.id)}
                  onChange={() => toggleDoc(d.id)}
                />
                <span>{d.name}</span>
                {d.sections_count ? <span className="muted small">{d.sections_count} sec</span> : null}
              </label>
            ))}
        {filterLc && allUploadFiltered.length === 0 ? (
          <span className="muted small source-picker-empty">No documents match "{filter}"</span>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- Documents ---------------- */

function DocList() {
  const { project, canEdit } = useProject();
  const docs = useLoad(() => api.get(`/api/projects/${project.id}/learn/docs`), [project.id]);
  useProjectEvents(['learn.updated'], () => docs.reload(true));
  const [creating, setCreating] = useState(false);
  const list = docs.data?.docs || [];
  return (
    <div className="stack-lg">
      {canEdit ? (
        <div className="row">
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Write a document
          </Button>
          <span className="muted small">Drafts stay private to editors until someone publishes them.</span>
        </div>
      ) : null}
      {docs.loading && !docs.data ? (
        <Spinner />
      ) : !list.length ? (
        <Empty icon="learn" title={canEdit ? 'No learning documents yet' : 'Nothing published yet'}>
          {canEdit ? 'Generate a system overview first. Every document comes in a version for everyone and one for engineers.' : 'Your team has not published anything yet.'}
        </Empty>
      ) : (
        <div className="learn-grid">
          {list.map((d) => (
            <a key={d.id} href={href(project.id, 'learn', 'doc', d.id)} className="learn-card">
              <span className="muted small">{KIND_LABEL[d.kind]}</span>
              <h2>{d.title}</h2>
              <div className="row tight wrap">
                <StatusBadges item={d} />
                {d.read ? <Badge tone="ok">Read</Badge> : null}
              </div>
              <span className="muted small">Updated {timeAgo(d.updated_at)}</span>
              {d.error ? <span className="danger small">{d.error}</span> : null}
            </a>
          ))}
        </div>
      )}
      {creating ? <NewDoc onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function NewDoc({ onClose }) {
  const { project } = useProject();
  const [form, setForm] = useState({ title: '', kind: 'overview', focus: '', docIds: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <Modal
      title="Write a document"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!form.title.trim() || !form.docIds?.length}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const { doc } = await api.post(`/api/projects/${project.id}/learn/docs`, form);
                go(project.id, 'learn', 'doc', doc.id);
              } catch (e) {
                setError(e);
                setBusy(false);
              }
            }}
          >
            Write it
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title">{(id) => <input id={id} className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="How refunds work" />}</Field>
        <fieldset className="field">
          <legend className="field-label">Type</legend>
          <div className="kind-pick">
            {KINDS.map((k) => (
              <label key={k.value} className={cx('choice', form.kind === k.value && 'is-checked')}>
                <input type="radio" name="kind" checked={form.kind === k.value} onChange={() => setForm({ ...form, kind: k.value })} />
                <span>
                  <strong>{k.label}</strong> <span className="muted">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Only about (optional)" hint="Narrow the sources to sections about this, like “refund approval”.">
          {(id) => <input id={id} className="input" value={form.focus} onChange={(e) => setForm({ ...form, focus: e.target.value })} />}
        </Field>
        <div className="field">
          <span className="field-label">Sources</span>
          <SourcePicker value={form.docIds} onChange={(docIds) => setForm((f) => ({ ...f, docIds }))} />
        </div>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

function LearnDocView({ id }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const d = useLoad(() => api.get(`/api/learn/docs/${id}`), [id]);
  useProjectEvents(['learn.updated'], (_e, x) => (!x?.id || x.id === id) && d.reload(true));
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem('learn-view') || 'business';
    } catch {
      return 'business';
    }
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(null);
  const [quizOpen, setQuizOpen] = useState(false);
  const setViewSaved = (v) => {
    setView(v);
    try {
      localStorage.setItem('learn-view', v);
    } catch {
      /* ignore */
    }
  };

  const GLOSSARY_COLS = [
    { key: 'term',    label: 'Term',     accessor: 'term',     type: 'text' },
    { key: 'meaning', label: 'Meaning',  accessor: (g) => view === 'business' ? g.business : g.technical, type: 'text' },
  ];
  const { sorted: sortedGlossary, sortKey: gSortKey, sortDir: gSortDir, toggle: gToggle } = useSortable(
    d.data?.doc?.glossary || [],
    { columns: GLOSSARY_COLS, storageKey: `sort:glossary:${id}` }
  );
  if (d.error) return <div className="page"><a className="back" href={href(project.id, 'learn')}>← Learn</a><ErrorNote error={d.error} /></div>;
  if (!d.data) return <div className="page"><Spinner /></div>;
  const doc = d.data.doc;
  const field = view === 'business' ? 'business_md' : 'technical_md';
  const act = async (name, fn, msg) => {
    setBusy(name);
    try {
      await fn();
      if (msg) toast(msg);
      d.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page learn-doc">
      <a className="back" href={href(project.id, 'learn')}>
        ← Learn
      </a>
      <header className="learn-head">
        <div>
          <span className="muted small">{KIND_LABEL[doc.kind]}</span>
          <h1>{doc.title}</h1>
          <div className="row tight wrap">
            <StatusBadges item={doc} />
            {doc.published_at ? <span className="muted small">Published {timeAgo(doc.published_at)}{doc.approved_by_name ? ` by ${doc.approved_by_name}` : ''}</span> : null}
          </div>
        </div>
        <div className="learn-actions no-print">
          {canEdit && doc.status !== 'generating' ? (
            <>
              {doc.status === 'published' ? (
                <Button busy={busy === 'unpub'} onClick={() => act('unpub', () => api.post(`/api/learn/docs/${id}/unpublish`), 'Moved back to draft')}>
                  Unpublish
                </Button>
              ) : doc.business_md ? (
                <Button variant="primary" icon="check" busy={busy === 'pub'} onClick={() => act('pub', () => api.post(`/api/learn/docs/${id}/publish`), 'Published')}>
                  Approve and publish
                </Button>
              ) : null}
              <Button
                icon="refresh"
                busy={busy === 'regen'}
                onClick={async () => {
                  if (doc.business_md && !(await confirm({ title: 'Write again', message: 'Write both views again from the current sources? Your manual edits are replaced, and it goes back to draft.', confirmLabel: 'Write again' }))) return;
                  act('regen', () => api.post(`/api/learn/docs/${id}/regenerate`), 'Writing a new version');
                }}
              >
                Write again
              </Button>
            </>
          ) : null}
          {!doc.read && doc.status === 'published' ? (
            <Button icon="check" onClick={() => act('read', () => api.post(`/api/learn/docs/${id}/read`), 'Marked as read')}>
              Mark as read
            </Button>
          ) : null}
        </div>
      </header>

      {doc.status === 'generating' ? (
        <Note tone="info">
          <Spinner small /> Writing both versions from {doc.doc_ids.length || 'all'} source documents. This page updates when it is ready.
        </Note>
      ) : null}
      {doc.error ? <ErrorNote error={new Error(doc.error)} /> : null}
      {doc.stale && canEdit ? (
        <Note tone="warn" icon="alert" action={<Button size="sm" onClick={() => act('regen', () => api.post(`/api/learn/docs/${id}/regenerate`), 'Writing a new version')}>Write again</Button>}>
          A source document changed after this was written. Review it or write it again.
        </Note>
      ) : null}

      {doc.business_md ? (
        <>
          <div className="row between no-print view-bar">
            <Segmented value={view} onChange={(v) => { setViewSaved(v); setEditing(false); }} label="Version" options={[{ value: 'business', label: 'For everyone' }, { value: 'technical', label: 'For engineers' }]} />
            <div className="row tight">
              {canEdit && !editing ? (
                <Button size="sm" icon="edit" onClick={() => { setDraft(doc[field]); setEditing(true); }}>
                  Edit this version
                </Button>
              ) : null}
              <a className="btn btn-ghost btn-sm" href={`/api/learn/docs/${id}/export?format=html`}>
                <Icon name="download" size={15} />
                <span>HTML</span>
              </a>
              <a className="btn btn-ghost btn-sm" href={`/api/learn/docs/${id}/export?format=md&view=${view}`}>
                <Icon name="download" size={15} />
                <span>Markdown</span>
              </a>
              <Button size="sm" variant="ghost" icon="print" onClick={() => window.print()}>
                Print or PDF
              </Button>
            </div>
          </div>
          {editing ? (
            <div className="stack">
              <textarea className="input mono" rows={28} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Markdown" />
              <div className="row">
                <Button variant="primary" busy={busy === 'save'} onClick={() => act('save', async () => { await api.patch(`/api/learn/docs/${id}`, { [field]: draft }); setEditing(false); }, 'Saved. It needs approval again before it is published.')}>
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <article className="doc-body reading">
              <Markdown text={doc[field]} />
            </article>
          )}
          {doc.glossary?.length && doc.kind !== 'glossary' && !editing ? (
            <section className="glossary">
              <h2>Terms</h2>
              <table className="table">
                <thead>
                  <tr>
                    <SortHeader col={GLOSSARY_COLS[0]} sortKey={gSortKey} sortDir={gSortDir} onSort={gToggle} />
                    <SortHeader col={{ key: 'meaning', label: view === 'business' ? 'Meaning' : 'In the system' }} sortKey={gSortKey} sortDir={gSortDir} onSort={gToggle} />
                  </tr>
                </thead>
                <tbody>
                  {sortedGlossary.map((g) => (
                    <tr key={g.term}>
                      <td><strong>{g.term}</strong></td>
                      <td>{view === 'business' ? g.business : g.technical}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
          <section className="doc-sources no-print">
            <h2>Written from</h2>
            <ul className="plain-list small">
              {doc.source_refs.slice(0, 30).map((s) => (
                <li key={s.docId + s.anchor}>
                  <a href={href(project.id, 'knowledge', 'doc', s.docId, s.anchor)}>
                    {s.docName} › {s.heading}
                  </a>
                </li>
              ))}
            </ul>
          </section>
          <section className="no-print">
            <h2>Quizzes on this document</h2>
            {d.data.quizzes.length ? (
              <ul className="plain-list">
                {d.data.quizzes.map((q) => (
                  <li key={q.id}>
                    <a href={href(project.id, 'learn', 'quiz', q.id)}>{q.title}</a> <span className="muted small">{AUDIENCE[q.audience]}, {q.difficulty}</span> <Badge status={q.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">None yet.</p>
            )}
            {canEdit ? (
              <Button icon="plus" onClick={() => setQuizOpen(true)}>
                Make a quiz from this
              </Button>
            ) : null}
          </section>
        </>
      ) : null}
      {quizOpen ? <NewQuiz onClose={() => setQuizOpen(false)} learnDoc={doc} /> : null}
    </div>
  );
}

/* ---------------- Quizzes ---------------- */

function QuizList() {
  const { project, canEdit } = useProject();
  const q = useLoad(() => api.get(`/api/projects/${project.id}/learn/quizzes`), [project.id]);
  useProjectEvents(['learn.updated', 'learn.progress'], () => q.reload(true));
  const [creating, setCreating] = useState(false);
  const list = q.data?.quizzes || [];

  const QUIZ_COLS = [
    { key: 'title',      label: 'Quiz',      accessor: 'title',          type: 'text' },
    { key: 'audience',   label: 'For',       accessor: (x) => AUDIENCE[x.audience] || x.audience, type: 'text' },
    { key: 'difficulty', label: 'Level',     accessor: 'difficulty',     type: 'text' },
    { key: 'questions',  label: 'Questions', accessor: 'question_count', type: 'number' },
    { key: 'status',     label: 'Status',    accessor: 'status',         type: 'status' },
    { key: 'best',       label: 'Your best', accessor: (x) => x.my_best ?? null, type: 'number' },
  ];
  const { sorted, sortKey, sortDir, toggle } = useSortable(list, {
    columns: QUIZ_COLS,
    storageKey: `sort:quizzes:${project.id}`,
  });

  return (
    <div className="stack-lg">
      {canEdit ? (
        <div className="row">
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Make a quiz
          </Button>
          <span className="muted small">Every answer is checked against its source before the quiz is ready.</span>
        </div>
      ) : null}
      {q.loading && !q.data ? (
        <Spinner />
      ) : !list.length ? (
        <Empty icon="learn" title="No quizzes yet">{canEdit ? 'Make one from a learning document or straight from the project documents.' : 'Your team has not published a quiz yet.'}</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <SortHeader col={QUIZ_COLS[0]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={QUIZ_COLS[1]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={QUIZ_COLS[2]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={QUIZ_COLS[3]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={QUIZ_COLS[4]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={QUIZ_COLS[5]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((x) => (
              <tr key={x.id}>
                <td>
                  <a className="strong-link" href={href(project.id, 'learn', 'quiz', x.id)}>
                    {x.title}
                  </a>
                  {x.error ? <div className="danger small">{x.error}</div> : null}
                </td>
                <td>{AUDIENCE[x.audience]}</td>
                <td>{x.difficulty}</td>
                <td className="num">{x.question_count || ''}</td>
                <td><StatusBadges item={x} /></td>
                <td>{x.my_best === null || x.my_best === undefined ? <span className="muted">—</span> : `${Math.round(x.my_best * 100)}%`}</td>
                <td className="actions">
                  {x.status === 'published' || (canEdit && x.status === 'draft') ? (
                    <a className="btn btn-ghost btn-sm" href={href(project.id, 'learn', 'quiz', x.id, 'take')}>
                      Take quiz
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating ? <NewQuiz onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function NewQuiz({ onClose, learnDoc }) {
  const { project } = useProject();
  const docs = useLoad(() => (learnDoc ? Promise.resolve(null) : api.get(`/api/projects/${project.id}/learn/docs`)), [project.id]);
  const [form, setForm] = useState({
    title: learnDoc ? `${learnDoc.title}: check your understanding` : '',
    audience: 'business',
    difficulty: 'medium',
    count: 8,
    source: learnDoc ? 'learn' : 'docs',
    learnDocId: learnDoc?.id || '',
    docIds: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const learnDocs = (docs.data?.docs || []).filter((d) => d.status !== 'generating' && d.status !== 'error');
  return (
    <Modal
      title="Make a quiz"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!form.title.trim() || (form.source === 'learn' ? !form.learnDocId : !form.docIds?.length)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const body = { title: form.title, audience: form.audience, difficulty: form.difficulty, count: form.count, ...(form.source === 'learn' ? { learnDocId: form.learnDocId } : { docIds: form.docIds }) };
                const { quiz } = await api.post(`/api/projects/${project.id}/learn/quizzes`, body);
                go(project.id, 'learn', 'quiz', quiz.id);
              } catch (e) {
                setError(e);
                setBusy(false);
              }
            }}
          >
            Make quiz
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title">{(id) => <input id={id} className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Refund basics" />}</Field>
        <div className="row wrap">
          <div className="field">
            <span className="field-label">Who is it for?</span>
            <Segmented value={form.audience} onChange={(audience) => setForm({ ...form, audience })} label="Audience" options={[{ value: 'business', label: 'Everyone' }, { value: 'technical', label: 'Engineers' }]} />
          </div>
          <div className="field">
            <span className="field-label">Level</span>
            <Segmented value={form.difficulty} onChange={(difficulty) => setForm({ ...form, difficulty })} label="Difficulty" options={[{ value: 'easy', label: 'Easy' }, { value: 'medium', label: 'Medium' }, { value: 'hard', label: 'Hard' }]} />
          </div>
          <Field label="Questions">{(id) => <input id={id} type="number" min={3} max={25} className="input input-num" value={form.count} onChange={(e) => setForm({ ...form, count: Number(e.target.value) })} />}</Field>
        </div>
        <p className="muted small">
          {form.audience === 'business' ? 'Scenario and multiple-choice questions about rules and flows. No code.' : 'API behaviour, edge cases and code reading, including short answers.'}
        </p>
        {!learnDoc ? (
          <>
            <Segmented value={form.source} onChange={(source) => setForm({ ...form, source })} label="Source" options={[{ value: 'docs', label: 'Project documents' }, { value: 'learn', label: 'A learning document' }]} />
            {form.source === 'learn' ? (
              <Field label="Learning document">
                {(id) => (
                  <select id={id} className="input" value={form.learnDocId} onChange={(e) => setForm({ ...form, learnDocId: e.target.value })}>
                    <option value="">Choose…</option>
                    {learnDocs.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : (
              <SourcePicker value={form.docIds} onChange={(docIds) => setForm((f) => ({ ...f, docIds }))} />
            )}
          </>
        ) : null}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

function QuizEditor({ id }) {
  const { project } = useProject();
  const { toast, confirm } = useUi();
  const q = useLoad(() => api.get(`/api/learn/quizzes/${id}`), [id]);
  const attempts = useLoad(() => api.get(`/api/learn/quizzes/${id}/attempts`), [id]);
  useProjectEvents(['learn.updated'], (_e, x) => (!x?.id || x.id === id) && q.reload(true));
  useProjectEvents(['learn.progress'], () => attempts.reload(true));
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(null);

  const ATTEMPT_COLS = [
    { key: 'person', label: 'Person', accessor: 'name',       type: 'text' },
    { key: 'score',  label: 'Score',  accessor: (a) => a.total > 0 ? a.score / a.total : null, type: 'number' },
    { key: 'when',   label: 'When',   accessor: 'created_at', type: 'date' },
  ];
  const { sorted: sortedAttempts, sortKey: aSortKey, sortDir: aSortDir, toggle: aToggle } = useSortable(
    attempts.data?.attempts || [],
    { columns: ATTEMPT_COLS, storageKey: `sort:quiz-attempts:${id}` }
  );
  if (q.error) return <div className="page"><ErrorNote error={q.error} /></div>;
  if (!q.data) return <div className="page"><Spinner /></div>;
  const quiz = q.data.quiz;
  const act = async (name, fn, msg) => {
    setBusy(name);
    try {
      await fn();
      if (msg) toast(msg);
      q.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(null);
    }
  };
  const saveQuestions = (questions, msg) => act('save', () => api.patch(`/api/learn/quizzes/${id}`, { questions }), msg);

  return (
    <div className="page">
      <a className="back" href={href(project.id, 'learn', 'quizzes')}>
        ← Quizzes
      </a>
      <PageHeader
        title={quiz.title}
        sub={`For ${AUDIENCE[quiz.audience].toLowerCase()}, ${quiz.difficulty} level. ${quiz.questions.length} questions.`}
        actions={
          quiz.status === 'generating' ? null : (
            <>
              {quiz.status === 'published' ? (
                <Button busy={busy === 'unpub'} onClick={() => act('unpub', () => api.post(`/api/learn/quizzes/${id}/unpublish`), 'Moved back to draft')}>
                  Unpublish
                </Button>
              ) : quiz.questions.length ? (
                <Button variant="primary" icon="check" busy={busy === 'pub'} onClick={() => act('pub', () => api.post(`/api/learn/quizzes/${id}/publish`), 'Published')}>
                  Approve and publish
                </Button>
              ) : null}
              <a className="btn btn-default" href={href(project.id, 'learn', 'quiz', id, 'take')}>
                Take quiz
              </a>
              <Button
                icon="refresh"
                busy={busy === 'regen'}
                onClick={async () => {
                  if (!(await confirm({ title: 'Make again', message: 'Replace these questions with a new set from the same sources?', confirmLabel: 'Make again' }))) return;
                  act('regen', () => api.post(`/api/learn/quizzes/${id}/regenerate`), 'Writing new questions');
                }}
              >
                Make again
              </Button>
              <IconButton
                icon="trash"
                label="Delete quiz"
                onClick={async () => {
                  if (!(await confirm({ title: 'Delete quiz', message: 'Delete this quiz and everyone’s attempts?', confirmLabel: 'Delete', danger: true }))) return;
                  await api.del(`/api/learn/quizzes/${id}`);
                  go(project.id, 'learn', 'quizzes');
                }}
              />
            </>
          )
        }
      />
      <div className="row tight wrap">
        <StatusBadges item={quiz} />
      </div>
      {quiz.status === 'generating' ? (
        <Note tone="info">
          <Spinner small /> Writing questions, then checking each answer against its source.
        </Note>
      ) : null}
      {quiz.error ? <ErrorNote error={new Error(quiz.error)} /> : null}
      {quiz.dropped ? <Note tone="info">{quiz.dropped} question{quiz.dropped === 1 ? ' was' : 's were'} dropped because the source did not clearly support the answer.</Note> : null}
      <ol className="q-review">
        {quiz.questions.map((x, i) => (
          <li key={x.id} className="panel">
            {editing === x.id ? (
              <QuestionEdit
                q={x}
                onCancel={() => setEditing(null)}
                onSave={(nq) => {
                  setEditing(null);
                  saveQuestions(quiz.questions.map((y) => (y.id === x.id ? nq : y)), 'Question saved');
                }}
              />
            ) : (
              <>
                <div className="row between">
                  <span className="muted small">
                    Question {i + 1}, {x.type === 'mcq' ? 'multiple choice' : x.type === 'truefalse' ? 'true or false' : 'short answer'}
                    {x.verified ? ', checked against source' : ''}
                  </span>
                  <div className="row tight">
                    <IconButton icon="edit" label="Edit question" onClick={() => setEditing(x.id)} />
                    <IconButton icon="trash" label="Remove question" onClick={() => saveQuestions(quiz.questions.filter((y) => y.id !== x.id), 'Question removed')} />
                  </div>
                </div>
                <p className="q-text">{x.question}</p>
                {x.options ? (
                  <ul className="q-options">
                    {x.options.map((o) => (
                      <li key={o} className={cx(o === x.answer && 'is-correct')}>
                        {o === x.answer ? <Icon name="check" size={14} /> : <span className="bullet" />}
                        {o}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    Expected answer: <strong>{x.answer}</strong>
                  </p>
                )}
                <p className="muted small">{x.explanation}</p>
                <a className="small" href={href(project.id, 'knowledge', 'doc', x.source.docId, x.source.anchor)}>
                  {x.source.docName} › {x.source.heading}
                </a>
              </>
            )}
          </li>
        ))}
      </ol>
      {attempts.data?.attempts?.length ? (
        <section>
          <h2>Attempts</h2>
          <table className="table">
            <thead>
              <tr>
                <SortHeader col={ATTEMPT_COLS[0]} sortKey={aSortKey} sortDir={aSortDir} onSort={aToggle} />
                <SortHeader col={ATTEMPT_COLS[1]} sortKey={aSortKey} sortDir={aSortDir} onSort={aToggle} />
                <SortHeader col={ATTEMPT_COLS[2]} sortKey={aSortKey} sortDir={aSortDir} onSort={aToggle} />
              </tr>
            </thead>
            <tbody>
              {sortedAttempts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td>
                    {a.score} of {a.total}
                  </td>
                  <td className="muted">{timeAgo(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}

function QuestionEdit({ q, onSave, onCancel }) {
  const [f, setF] = useState({ ...q, options: q.options ? [...q.options] : undefined });
  return (
    <div className="stack">
      <Field label="Question">{(id) => <textarea id={id} className="input" rows={2} value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} />}</Field>
      {f.type === 'mcq' ? (
        <div className="field">
          <span className="field-label">Options (pick the correct one)</span>
          {f.options.map((o, i) => (
            <div key={i} className="row tight">
              <input type="radio" name="correct" checked={f.answer === o} onChange={() => setF({ ...f, answer: o })} aria-label={`Option ${i + 1} is correct`} />
              <input
                className="input"
                value={o}
                onChange={(e) => {
                  const options = [...f.options];
                  const wasAnswer = f.answer === options[i];
                  options[i] = e.target.value;
                  setF({ ...f, options, answer: wasAnswer ? e.target.value : f.answer });
                }}
                aria-label={`Option ${i + 1}`}
              />
            </div>
          ))}
        </div>
      ) : f.type === 'truefalse' ? (
        <Segmented value={f.answer} onChange={(answer) => setF({ ...f, answer })} label="Correct answer" options={[{ value: 'True', label: 'True' }, { value: 'False', label: 'False' }]} />
      ) : (
        <Field label="Expected answer">{(id) => <input id={id} className="input" value={f.answer} onChange={(e) => setF({ ...f, answer: e.target.value })} />}</Field>
      )}
      <Field label="Explanation">{(id) => <textarea id={id} className="input" rows={2} value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} />}</Field>
      <div className="row">
        <Button variant="primary" size="sm" onClick={() => onSave(f)}>
          Save question
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function TakeQuiz({ id }) {
  const { project } = useProject();
  const q = useLoad(() => api.get(`/api/learn/quizzes/${id}?mode=take`), [id]);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (q.error) return <div className="page"><ErrorNote error={q.error} /></div>;
  if (!q.data) return <div className="page"><Spinner /></div>;
  const quiz = q.data.quiz;
  const byId = new Map(result?.results.map((r) => [r.id, r]) || []);
  const answeredCount = Object.values(answers).filter((x) => String(x).trim()).length;
  return (
    <div className="page narrow">
      <a className="back" href={href(project.id, 'learn', 'quizzes')}>
        ← Quizzes
      </a>
      <PageHeader title={quiz.title} sub={`${quiz.questions.length} questions. You pass at 70%.`} />
      {result ? (
        <div className={cx('score', result.passed ? 'is-pass' : 'is-fail')} role="status">
          <span className="score-n">
            {result.score}/{result.total}
          </span>
          <span>{result.passed ? 'Passed. Well done.' : 'Not passed yet. Read the explanations and try again.'}</span>
          <Button
            onClick={() => {
              setResult(null);
              setAnswers({});
              window.scrollTo({ top: 0 });
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      <ol className="take">
        {quiz.questions.map((x, i) => {
          const r = byId.get(x.id);
          return (
            <li key={x.id} className={cx('panel', r && (r.correct ? 'is-right' : 'is-wrong'))}>
              <fieldset disabled={Boolean(result)}>
                <legend className="q-text">
                  <span className="q-n">{i + 1}</span> {x.question}
                </legend>
                {x.options ? (
                  x.options.map((o) => (
                    <label key={o} className={cx('choice', answers[x.id] === o && 'is-checked', r && o === r.answer && 'is-correct')}>
                      <input type="radio" name={x.id} checked={answers[x.id] === o} onChange={() => setAnswers({ ...answers, [x.id]: o })} />
                      <span>{o}</span>
                    </label>
                  ))
                ) : (
                  <input className="input" value={answers[x.id] || ''} onChange={(e) => setAnswers({ ...answers, [x.id]: e.target.value })} aria-label={`Answer to question ${i + 1}`} placeholder="Your answer" />
                )}
              </fieldset>
              {r ? (
                <div className="q-feedback">
                  <strong>{r.correct ? 'Correct.' : `The answer is: ${r.answer}.`}</strong> <span>{r.explanation}</span>{' '}
                  <a href={href(project.id, 'knowledge', 'doc', r.source.docId, r.source.anchor)}>Read the source</a>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <ErrorNote error={error} />
      {!result ? (
        <div className="row">
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const { attempt } = await api.post(`/api/learn/quizzes/${id}/attempts`, { answers });
                setResult(attempt);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Check my answers
          </Button>
          <span className="muted small">
            {answeredCount} of {quiz.questions.length} answered
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- Paths ---------------- */

function PathList() {
  const { project, canEdit } = useProject();
  const { toast } = useUi();
  const paths = useLoad(() => api.get(`/api/projects/${project.id}/learn/paths`), [project.id]);
  useProjectEvents(['learn.updated', 'learn.progress'], () => paths.reload(true));
  const [busy, setBusy] = useState(null);
  const list = paths.data?.paths || [];
  const auto = async (audience) => {
    setBusy(audience);
    try {
      const { path } = await api.post(`/api/projects/${project.id}/learn/paths/auto`, { audience });
      go(project.id, 'learn', 'path', path.id);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack-lg">
      {canEdit ? (
        <div className="row wrap">
          <Button variant="primary" icon="plus" busy={busy === 'business'} onClick={() => auto('business')}>
            Path for everyone
          </Button>
          <Button icon="plus" busy={busy === 'technical'} onClick={() => auto('technical')}>
            Path for engineers
          </Button>
          <span className="muted small">Built from published documents and quizzes, overview first. You can reorder it afterwards.</span>
        </div>
      ) : null}
      {paths.loading && !paths.data ? (
        <Spinner />
      ) : !list.length ? (
        <Empty icon="learn" title="No onboarding paths yet">
          {canEdit ? 'Publish a few documents and quizzes, then build a path from them.' : 'Your team has not published a path yet.'}
        </Empty>
      ) : (
        <ul className="path-list">
          {list.map((p) => (
            <li key={p.id}>
              <a href={href(project.id, 'learn', 'path', p.id)} className="panel path-card">
                <div className="row between">
                  <h2>{p.title}</h2>
                  <span className="row tight">
                    <Badge tone="muted">{AUDIENCE[p.audience]}</Badge>
                    {p.status !== 'published' ? <Badge status={p.status} /> : null}
                  </span>
                </div>
                <p className="muted small">{p.description}</p>
                <Progress value={p.progress} label={`${p.title} progress`} />
                <span className="small">
                  {p.progress}% done, {p.steps.length} steps
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PathView({ id }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const paths = useLoad(() => api.get(`/api/projects/${project.id}/learn/paths`), [project.id]);
  useProjectEvents(['learn.updated', 'learn.progress'], () => paths.reload(true));
  const p = paths.data?.paths.find((x) => x.id === id);
  if (!paths.data) return <div className="page"><Spinner /></div>;
  if (!p) return <div className="page"><Empty title="Path not found" /></div>;
  const save = async (patch, msg) => {
    try {
      await api.patch(`/api/learn/paths/${id}`, patch);
      if (msg) toast(msg);
      paths.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  const move = (i, d) => {
    const steps = p.steps.map((s) => ({ type: s.type, id: s.id }));
    const [x] = steps.splice(i, 1);
    steps.splice(i + d, 0, x);
    save({ steps });
  };
  return (
    <div className="page narrow">
      <a className="back" href={href(project.id, 'learn', 'paths')}>
        ← Onboarding paths
      </a>
      <PageHeader
        title={p.title}
        sub={p.description}
        actions={
          canEdit ? (
            <>
              <Toggle checked={p.status === 'published'} onChange={(on) => save({ status: on ? 'published' : 'draft' }, on ? 'Path published' : 'Path unpublished')} label="Published" />
              <IconButton
                icon="trash"
                label="Delete path"
                onClick={async () => {
                  if (!(await confirm({ title: 'Delete path', message: 'Delete this onboarding path? Documents and quizzes stay.', confirmLabel: 'Delete', danger: true }))) return;
                  await api.del(`/api/learn/paths/${id}`);
                  go(project.id, 'learn', 'paths');
                }}
              />
            </>
          ) : null
        }
      />
      <Progress value={p.progress} label="Your progress" />
      <p className="small">{p.progress}% done</p>
      <ol className="steps">
        {p.steps.map((s, i) => (
          <li key={s.type + s.id} className={cx('step', s.done && 'is-done', !s.item && 'is-missing')}>
            <span className="step-mark" aria-hidden="true">{s.done ? <Icon name="check" size={14} /> : i + 1}</span>
            <div className="step-main">
              {s.item ? (
                <a href={s.type === 'doc' ? href(project.id, 'learn', 'doc', s.id) : href(project.id, 'learn', 'quiz', s.id, 'take')}>
                  {s.item.title}
                </a>
              ) : (
                <span className="muted">Removed item</span>
              )}
              <span className="muted small">
                {s.type === 'doc' ? 'Read' : 'Quiz, pass with 70%'}
                {s.done ? ', done' : ''}
              </span>
            </div>
            {canEdit ? (
              <div className="row tight">
                <IconButton icon="arrowUp" label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton icon="arrowDown" label="Move down" disabled={i === p.steps.length - 1} onClick={() => move(i, 1)} />
                <IconButton icon="x" label="Remove step" onClick={() => save({ steps: p.steps.filter((_, j) => j !== i).map((x) => ({ type: x.type, id: x.id })) })} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function TeamProgress() {
  const { project } = useProject();
  const pr = useLoad(() => api.get(`/api/projects/${project.id}/learn/progress`), [project.id]);
  useProjectEvents(['learn.progress', 'learn.updated'], () => pr.reload(true));

  const members = pr.data?.members || [];
  const paths = pr.data?.paths || [];

  // Build dynamic columns: Person, Role, one per path, Quizzes passed
  const progressCols = [
    { key: 'name',    label: 'Person',         accessor: 'name',          type: 'text' },
    { key: 'role',    label: 'Role',            accessor: 'role',          type: 'text' },
    ...paths.map((p) => ({
      key: `path_${p.id}`,
      label: p.title,
      accessor: (m) => m.progress?.[p.id] ?? null,
      type: 'number',
    })),
    { key: 'quizzes', label: 'Quizzes passed',  accessor: 'quizzesPassed', type: 'number' },
  ];
  const { sorted: sortedMembers, sortKey: mSortKey, sortDir: mSortDir, toggle: mToggle } = useSortable(
    members,
    { columns: progressCols, storageKey: `sort:progress:${project.id}` }
  );

  if (pr.error) return <ErrorNote error={pr.error} />;
  if (!pr.data) return <Spinner />;
  return (
    <div className="stack">
      {!paths.length ? <p className="muted">Publish an onboarding path to track progress through it.</p> : null}
      <table className="table">
        <thead>
          <tr>
            <SortHeader col={progressCols[0]} sortKey={mSortKey} sortDir={mSortDir} onSort={mToggle} />
            <SortHeader col={progressCols[1]} sortKey={mSortKey} sortDir={mSortDir} onSort={mToggle} />
            {paths.map((p, i) => (
              <SortHeader key={p.id} col={progressCols[i + 2]} sortKey={mSortKey} sortDir={mSortDir} onSort={mToggle} />
            ))}
            <SortHeader col={progressCols[progressCols.length - 1]} sortKey={mSortKey} sortDir={mSortDir} onSort={mToggle} className="num" />
          </tr>
        </thead>
        <tbody>
          {sortedMembers.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td className="muted">{m.role}</td>
              {paths.map((p) => (
                <td key={p.id} className="progress-cell">
                  <Progress value={m.progress[p.id]} label={`${m.name}: ${p.title}`} />
                  <span className="small">{m.progress[p.id]}%</span>
                </td>
              ))}
              <td className="num">{m.quizzesPassed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
