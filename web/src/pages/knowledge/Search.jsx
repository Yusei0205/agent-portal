import { Fragment, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { href } from '../../lib/router.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx, plural, timeAgo } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { Markdown } from '../../components/Markdown.jsx';
import { Button, Empty, ErrorNote, PageHeader, Spinner, useUi } from '../../components/ui.jsx';

/* --- Search bar (always visible above the file manager) --- */
export function SearchBar({ q, setQ, projectId: _pid }) {
  return (
    <div className="searchbar">
      <Icon name="search" />
      <input
        className="input"
        type="search"
        placeholder="Search all documents and decisions"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search documents"
      />
    </div>
  );
}

/* ---------------- Highlight (used in search) ---------------- */

export function Highlight({ text, start, end }) {
  const parts = [];
  let rest = text || '';
  let i = 0;
  while (rest.length) {
    const a = rest.indexOf(start);
    if (a < 0) { parts.push(<Fragment key={i++}>{rest}</Fragment>); break; }
    const b = rest.indexOf(end, a);
    if (a > 0) parts.push(<Fragment key={i++}>{rest.slice(0, a)}</Fragment>);
    parts.push(<mark key={i++}>{rest.slice(a + start.length, b < 0 ? undefined : b)}</mark>);
    rest = b < 0 ? '' : rest.slice(b + end.length);
  }
  return <>{parts}</>;
}

export function SearchResults({ hits, projectId, onClear }) {
  return (
    <div className="stack-lg">
      <div className="row between">
        <span className="muted small">{hits.hits.length ? `${hits.hits.length} result${hits.hits.length !== 1 ? 's' : ''}` : 'Nothing found'}</span>
        <button type="button" className="linkish small" onClick={onClear}>← Back to file manager</button>
      </div>
      {!hits.hits.length ? <Empty icon="search" title="Nothing found">Try fewer or different words.</Empty> : (
        <ol className="results">
          {hits.hits.map((h) => (
            <li key={h.sectionId}>
              <a href={href(projectId, 'knowledge', 'doc', h.docId, h.anchor)}>
                <span className="muted small">{h.docName}</span>
                <strong>{h.heading}</strong>
              </a>
              <p><Highlight text={h.snippet} start={hits.markStart} end={hits.markEnd} /></p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ---------------- Document viewer ---------------- */

export function DocView({ docId, anchor }) {
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
      <a className="back" href={href(project.id, 'knowledge')}>← All documents</a>
      <PageHeader
        title={d.name}
        sub={`${plural(d.sections_count, 'section')}, updated ${timeAgo(d.updated_at)}. Agents read the Markdown version shown here.`}
        actions={
          <>
            {d.kind === 'upload' ? (
              <a className="btn btn-default" href={`/api/documents/${d.id}/original`}>
                <Icon name="download" size={17} /><span>Original</span>
              </a>
            ) : null}
            {canEdit ? (
              <Button icon="refresh" busy={reindexing} onClick={async () => {
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
              }}>Convert again</Button>
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
        <article className="doc-body"><Markdown text={doc.data.markdown} /></article>
      </div>
    </div>
  );
}
