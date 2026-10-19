import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { bytes, cx, plural, timeAgo } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { InputCard } from '../components/InputCard.jsx';
import { Badge, Button, Empty, ErrorNote, IconButton, Note, PageHeader, Segmented, Spinner, Tabs, useUi } from '../components/ui.jsx';

export function Knowledge({ route }) {
  const { project, counts } = useProject();
  const [sub, a, b] = route.rest;
  if (sub === 'doc' && a) return <DocView docId={a} anchor={b} />;
  const tab = ['ask', 'inbox', 'decisions'].includes(sub) ? sub : 'docs';
  return (
    <div className="page">
      <PageHeader title="Knowledge" sub="Project documents agents search before they answer, and the questions they raise." />
      <Tabs
        value={tab}
        tabs={[
          { value: 'docs', label: 'Documents', href: href(project.id, 'knowledge') },
          { value: 'ask', label: 'Ask', href: href(project.id, 'knowledge', 'ask') },
          { value: 'inbox', label: 'Open questions', href: href(project.id, 'knowledge', 'inbox'), count: counts.open_questions },
          { value: 'decisions', label: 'Decisions log', href: href(project.id, 'knowledge', 'decisions') },
        ]}
      />
      {tab === 'docs' ? <Documents /> : tab === 'ask' ? <Ask /> : tab === 'inbox' ? <Inbox /> : <Decisions />}
    </div>
  );
}

/* ---------------- Documents and search ---------------- */

const TYPE_LABEL = { '.md': 'Markdown', '.markdown': 'Markdown', '.txt': 'Text', '.pdf': 'PDF', '.docx': 'Word', '.xlsx': 'Excel', '.pptx': 'PowerPoint', '.html': 'HTML', '.htm': 'HTML', '.csv': 'CSV', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.odt': 'OpenDocument', '.rtf': 'RTF', '.epub': 'EPUB' };

function Documents() {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const docs = useLoad(() => api.get(`/api/projects/${project.id}/documents`), [project.id]);
  useProjectEvents(['document.updated', 'document.deleted'], () => docs.reload(true));
  const [uploads, setUploads] = useState([]);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [searchError, setSearchError] = useState(null);

  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setSearchError(null);
        setHits(await api.get(`/api/projects/${project.id}/search?q=${encodeURIComponent(q)}`));
      } catch (e) {
        setSearchError(e);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, project.id]);

  const upload = async (files) => {
    for (const f of files) {
      const id = Math.random().toString(36).slice(2);
      setUploads((u) => [...u, { id, name: f.name, status: 'uploading' }]);
      try {
        const r = await api.upload(`/api/projects/${project.id}/documents?name=${encodeURIComponent(f.name)}`, f);
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: r.document.status, error: r.document.error } : x)));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, status: 'error', error: e.message } : x)));
      }
    }
    docs.reload(true);
    setTimeout(() => setUploads((u) => u.filter((x) => x.status === 'error')), 4000);
  };

  const list = docs.data?.documents || [];
  const uploaded = list.filter((d) => d.kind === 'upload');

  return (
    <div className="stack-lg">
      <div className="searchbar">
        <Icon name="search" />
        <input className="input" type="search" placeholder="Search all documents and decisions" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" />
      </div>
      <ErrorNote error={searchError} />
      {hits ? (
        <SearchResults hits={hits} projectId={project.id} />
      ) : (
        <>
          {canEdit ? (
            <div
              className={cx('dropzone', drag && 'is-drag')}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                upload([...e.dataTransfer.files]);
              }}
            >
              <Icon name="upload" size={22} />
              <div>
                <strong>Drop the FSD, TSD, API specs or meeting notes here</strong>
                <p className="muted small">
                  Word, PDF, Excel, PowerPoint, Markdown, HTML and text, up to {docs.data?.maxUploadMb ?? 50} MB each. Uploading a file with the same name replaces it.
                </p>
              </div>
              <Button icon="upload" onClick={() => fileInput.current?.click()}>
                Choose files
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept={(docs.data?.supported || []).join(',')}
                onChange={(e) => {
                  upload([...e.target.files]);
                  e.target.value = '';
                }}
              />
            </div>
          ) : null}
          {uploads.length ? (
            <ul className="upload-list">
              {uploads.map((u) => (
                <li key={u.id}>
                  {u.status === 'uploading' ? <Spinner small /> : <Badge status={u.status === 'ready' ? 'ready' : 'error'} />}
                  <span>{u.name}</span>
                  {u.error ? <span className="danger small">{u.error}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {docs.loading && !docs.data ? (
            <Spinner />
          ) : uploaded.length === 0 ? (
            <Empty icon="knowledge" title="No documents yet">
              Agents answer from these documents and cite them. Start with the functional and technical specifications.
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Type</th>
                  <th className="num">Sections</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a href={href(project.id, 'knowledge', 'doc', d.id)} className="strong-link">
                        {d.name}
                      </a>
                      {d.kind === 'decisions' ? <span className="muted small"> built in</span> : null}
                      {d.error ? <div className="danger small">{d.error}</div> : null}
                    </td>
                    <td className="muted">{d.kind === 'decisions' ? 'Log' : TYPE_LABEL[d.mime] || d.mime}{d.size ? `, ${bytes(d.size)}` : ''}</td>
                    <td className="num">{d.sections_count}</td>
                    <td>
                      <Badge status={d.status} />
                    </td>
                    <td className="muted">{timeAgo(d.updated_at)}</td>
                    <td className="actions">
                      {d.kind === 'upload' ? (
                        <>
                          <a className="icon-btn" href={`/api/documents/${d.id}/original`} aria-label={`Download ${d.name}`} title="Download original">
                            <Icon name="download" size={17} />
                          </a>
                          {canEdit ? (
                            <IconButton
                              icon="trash"
                              label={`Delete ${d.name}`}
                              onClick={async () => {
                                if (!(await confirm({ title: 'Delete document', message: `Delete “${d.name}”? Agents will no longer find it. Learning content built from it will be marked out of date.`, confirmLabel: 'Delete', danger: true }))) return;
                                try {
                                  await api.del(`/api/documents/${d.id}`);
                                  toast('Document deleted');
                                  docs.reload(true);
                                } catch (e) {
                                  toast(e.message, 'danger');
                                }
                              }}
                            />
                          ) : null}
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

export function Highlight({ text, start, end }) {
  const parts = [];
  let rest = text || '';
  let i = 0;
  while (rest.length) {
    const a = rest.indexOf(start);
    if (a < 0) {
      parts.push(<Fragment key={i++}>{rest}</Fragment>);
      break;
    }
    const b = rest.indexOf(end, a);
    if (a > 0) parts.push(<Fragment key={i++}>{rest.slice(0, a)}</Fragment>);
    parts.push(<mark key={i++}>{rest.slice(a + start.length, b < 0 ? undefined : b)}</mark>);
    rest = b < 0 ? '' : rest.slice(b + end.length);
  }
  return <>{parts}</>;
}

function SearchResults({ hits, projectId }) {
  if (!hits.hits.length) return <Empty icon="search" title="Nothing found">Try fewer or different words.</Empty>;
  return (
    <ol className="results">
      {hits.hits.map((h) => (
        <li key={h.sectionId}>
          <a href={href(projectId, 'knowledge', 'doc', h.docId, h.anchor)}>
            <span className="muted small">{h.docName}</span>
            <strong>{h.heading}</strong>
          </a>
          <p>
            <Highlight text={h.snippet} start={hits.markStart} end={hits.markEnd} />
          </p>
        </li>
      ))}
    </ol>
  );
}

/* ---------------- Document viewer ---------------- */

function DocView({ docId, anchor }) {
  const { project, canEdit } = useProject();
  const { toast } = useUi();
  const doc = useLoad(() => api.get(`/api/documents/${docId}`), [docId]);
  useProjectEvents(['document.updated'], (_e, d) => d?.id === docId && doc.reload(true));
  const [reindexing, setReindexing] = useState(false);
  useEffect(() => {
    if (!doc.data || !anchor) return;
    const t = setTimeout(() => document.getElementById(`sec-${anchor}`)?.scrollIntoView({ block: 'start' }), 50);
    return () => clearTimeout(t);
  }, [doc.data, anchor]);
  if (doc.error) return <div className="page"><ErrorNote error={doc.error} /></div>;
  if (!doc.data) return <div className="page"><Spinner /></div>;
  const d = doc.data.document;
  return (
    <div className="page">
      <a className="back" href={href(project.id, 'knowledge')}>
        ← All documents
      </a>
      <PageHeader
        title={d.name}
        sub={`${plural(d.sections_count, 'section')}, updated ${timeAgo(d.updated_at)}. Agents read the Markdown version shown here.`}
        actions={
          <>
            {d.kind === 'upload' ? (
              <a className="btn btn-default" href={`/api/documents/${d.id}/original`}>
                <Icon name="download" size={17} />
                <span>Original</span>
              </a>
            ) : null}
            {canEdit ? (
              <Button
                icon="refresh"
                busy={reindexing}
                onClick={async () => {
                  setReindexing(true);
                  try {
                    await api.post(`/api/documents/${d.id}/reindex`);
                    toast('Converted and indexed again');
                    doc.reload(true);
                  } catch (e) {
                    toast(e.message, 'danger');
                  } finally {
                    setReindexing(false);
                  }
                }}
              >
                Convert again
              </Button>
            ) : null}
          </>
        }
      />
      {d.error ? <ErrorNote error={new Error(d.error)} /> : null}
      <div className="doc-layout">
        <nav className="doc-outline" aria-label="Sections">
          <ol>
            {doc.data.sections.map((s) => (
              <li key={s.id} className={cx(`lvl-${s.level}`, s.anchor === anchor && 'is-active')}>
                <a href={href(project.id, 'knowledge', 'doc', d.id, s.anchor)}>{s.heading}</a>
              </li>
            ))}
          </ol>
        </nav>
        <article className="doc-body">
          <Markdown text={doc.data.markdown} />
        </article>
      </div>
    </div>
  );
}

/* ---------------- Ask ---------------- */

function Ask() {
  const { project } = useProject();
  const { toast } = useUi();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [inboxQ, setInboxQ] = useState('');
  const [sent, setSent] = useState(false);
  const history = useLoad(() => api.get(`/api/projects/${project.id}/qa`), [project.id]);

  const ask = async (e) => {
    e?.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      const r = await api.post(`/api/projects/${project.id}/ask`, { question });
      setAnswer({ ...r, question });
      setInboxQ(r.suggestedQuestion || question);
      history.reload(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const citeTransform = useCallback((t) => t.replace(/\[(\d{1,2})\]/g, (_m, n) => `<sup class="cite" data-n="${n}"><a href="#">${n}</a></sup>`), []);
  const [focusN, setFocusN] = useState(null);

  return (
    <div className="ask-layout">
      <div className="stack-lg">
        <form className="ask-box" onSubmit={ask}>
          <label htmlFor="ask-q" className="field-label">
            Ask anything about this project
          </label>
          <textarea
            id="ask-q"
            className="input"
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Who has to approve a refund above 500 USD?"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask();
            }}
          />
          <div className="row">
            <Button variant="primary" type="submit" busy={busy} disabled={!question.trim()}>
              Ask
            </Button>
            <span className="muted small">Answers come only from the project documents and decisions, with sources.</span>
          </div>
        </form>
        <ErrorNote error={error} />
        {answer ? (
          <section className="answer">
            <Markdown text={answer.answer} transform={citeTransform} onCite={setFocusN} />
            {answer.sources.length ? (
              <ol className="sources">
                {answer.sources.map((s) => (
                  <li key={s.n} className={cx(s.cited && 'is-cited', focusN === s.n && 'is-focus')}>
                    <span className="src-n">{s.n}</span>
                    <a href={href(project.id, 'knowledge', 'doc', s.docId, s.anchor)}>
                      {s.docName} › {s.heading}
                    </a>
                  </li>
                ))}
              </ol>
            ) : null}
            {answer.missing ? (
              <Note tone="warn" icon="question">
                <p>
                  <strong>The documents don’t answer this yet.</strong> Send it to the team as an open question; the answer goes into the decisions log, so agents and future answers can use it.
                </p>
                <div className="row">
                  <input className="input" value={inboxQ} onChange={(e) => setInboxQ(e.target.value)} aria-label="Question for the team" />
                  <Button
                    disabled={sent || !inboxQ.trim()}
                    onClick={async () => {
                      try {
                        await api.post(`/api/projects/${project.id}/inbox`, { question: inboxQ });
                        setSent(true);
                        toast('Sent to open questions');
                      } catch (e) {
                        toast(e.message, 'danger');
                      }
                    }}
                  >
                    {sent ? 'Sent' : 'Ask the team'}
                  </Button>
                </div>
              </Note>
            ) : null}
          </section>
        ) : null}
      </div>
      <aside className="side">
        <h2 className="side-title">Recent questions</h2>
        {history.data?.history?.length ? (
          <ul className="plain-list">
            {history.data.history.map((h) => (
              <li key={h.id}>
                <button type="button" className="linkish" onClick={() => setQuestion(h.meta?.question || h.title.replace(/^Question: /, ''))}>
                  {h.meta?.question || h.title}
                </button>
                <span className="muted small">
                  {h.asked_by}, {timeAgo(h.created_at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Questions people ask show up here.</p>
        )}
      </aside>
    </div>
  );
}

/* ---------------- Open questions ---------------- */

export function Inbox() {
  const { project, canEdit } = useProject();
  const [filter, setFilter] = useState('pending');
  const inputs = useLoad(() => api.get(`/api/projects/${project.id}/inputs?status=${filter === 'pending' ? 'pending' : 'all'}`), [project.id, filter]);
  useProjectEvents(['input.created', 'input.resolved'], () => inputs.reload(true));
  const { toast } = useUi();
  const list = inputs.data?.inputs || [];
  return (
    <div className="stack-lg">
      <div className="row between">
        <p className="muted">Questions agents asked during runs, and questions people sent from Ask. Answers go into the decisions log.</p>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'pending', label: 'Open' }, { value: 'all', label: 'All' }]} label="Filter" />
      </div>
      {inputs.loading && !inputs.data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty icon="inbox" title={filter === 'pending' ? 'No open questions' : 'Nothing here yet'}>
          When an agent is unsure, it asks here instead of guessing.
        </Empty>
      ) : (
        <div className="stack">
          {list.map((i) => (
            <div key={i.id} className="inbox-item">
              <InputCard input={i} projectId={project.id} canApprove={canEdit} onDone={() => inputs.reload(true)} />
              {i.status === 'pending' && !i.run_id && canEdit ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    await api.post(`/api/inputs/${i.id}/dismiss`);
                    toast('Question dismissed');
                    inputs.reload(true);
                  }}
                >
                  Dismiss
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Decisions ---------------- */

function Decisions() {
  const { project } = useProject();
  const docs = useLoad(() => api.get(`/api/projects/${project.id}/documents`), [project.id]);
  const decisionsDoc = useMemo(() => docs.data?.documents.find((d) => d.kind === 'decisions'), [docs.data]);
  const doc = useLoad(() => (decisionsDoc ? api.get(`/api/documents/${decisionsDoc.id}`) : Promise.resolve(null)), [decisionsDoc?.id, decisionsDoc?.updated_at]);
  useProjectEvents(['document.updated'], () => docs.reload(true));
  if (!doc.data) return <Spinner />;
  return (
    <div className="doc-body narrow-doc">
      <Markdown text={doc.data.markdown} />
    </div>
  );
}
