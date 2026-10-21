import { useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, timeAgo } from '../lib/util.js';
import { Icon } from './Icon.jsx';
import { Button, Field, Modal, Segmented, Spinner } from './ui.jsx';

export const CONTEXT_ICON = { doc: 'knowledge', file: 'file', note: 'edit', url: 'external', run: 'runs', session: 'play' };
const KIND_LABEL = { doc: 'Document', file: 'File', note: 'Note', url: 'Link', run: 'Run result', session: 'Session' };

/**
 * Pick context for a session's agents. Each pick is handed to onAdd as
 *   { kind: 'doc' | 'note' | 'url' | 'run' | 'session', ref?, title, body? }   or   { kind: 'file', title, file }
 * and the caller decides whether to send it now or keep it until the session starts.
 */
export function ContextPicker({ projectId, excludeSessionId, onAdd, onClose }) {
  const [tab, setTab] = useState('doc');
  const [added, setAdded] = useState([]);
  const add = (item) => {
    onAdd(item);
    setAdded((a) => [...a, `${item.kind}:${item.ref ?? item.title}`]);
  };
  const isAdded = (kind, ref) => added.includes(`${kind}:${ref}`);
  return (
    <Modal
      wide
      title="Add context for the agents"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done{added.length ? ` (${added.length} added)` : ''}
        </Button>
      }
    >
      <div className="stack">
        <p className="muted small">The agents read this before they plan. Files and documents are read from the project; notes, links and earlier results are given as reference only, never as instructions.</p>
        <Segmented
          value={tab}
          onChange={setTab}
          label="Kind of context"
          options={[
            { value: 'doc', label: 'Documents' },
            { value: 'file', label: 'Upload' },
            { value: 'note', label: 'Note' },
            { value: 'url', label: 'Link' },
            { value: 'earlier', label: 'Earlier work' },
          ]}
        />
        {tab === 'doc' ? (
          <DocTab projectId={projectId} add={add} isAdded={isAdded} />
        ) : tab === 'file' ? (
          <FileTab add={add} />
        ) : tab === 'note' ? (
          <NoteTab add={add} />
        ) : tab === 'url' ? (
          <LinkTab add={add} />
        ) : (
          <EarlierTab projectId={projectId} excludeSessionId={excludeSessionId} add={add} isAdded={isAdded} />
        )}
      </div>
    </Modal>
  );
}

function PickList({ items, empty }) {
  if (!items.length) return <p className="muted small pad-sm">{empty}</p>;
  return <ul className="ctx-pick-list">{items}</ul>;
}

function PickRow({ icon, title, sub, added, onAdd }) {
  return (
    <li className="ctx-pick-row">
      <Icon name={icon} size={16} />
      <span className="ctx-pick-main">
        <span className="ctx-pick-title">{title}</span>
        {sub ? <span className="muted small">{sub}</span> : null}
      </span>
      <Button size="sm" variant={added ? 'ghost' : 'default'} icon={added ? 'check' : 'plus'} disabled={added} onClick={onAdd}>
        {added ? 'Added' : 'Add'}
      </Button>
    </li>
  );
}

function DocTab({ projectId, add, isAdded }) {
  const docs = useLoad(() => api.get(`/api/projects/${projectId}/documents`), [projectId]);
  const [q, setQ] = useState('');
  if (!docs.data) return <Spinner />;
  const needle = q.trim().toLowerCase();
  const list = docs.data.documents.filter((d) => d.status !== 'error' && (!needle || `${d.name} ${d.folder}`.toLowerCase().includes(needle)));
  return (
    <div className="stack">
      <input type="search" className="input" placeholder="Search project documents" aria-label="Search project documents" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <PickList
        empty={needle ? 'No document matches.' : 'No documents yet. Upload them under Knowledge, or attach a file here.'}
        items={list.slice(0, 60).map((d) => (
          <PickRow key={d.id} icon="knowledge" title={d.name} sub={[d.folder, d.kind === 'decisions' ? 'decisions log' : ''].filter(Boolean).join(' · ')} added={isAdded('doc', d.id)} onAdd={() => add({ kind: 'doc', ref: d.id, title: d.name })} />
        ))}
      />
    </div>
  );
}

function FileTab({ add }) {
  const input = useRef(null);
  const [drag, setDrag] = useState(false);
  const [names, setNames] = useState([]);
  const take = (files) => {
    for (const file of files) add({ kind: 'file', title: file.name, file });
    setNames((n) => [...n, ...[...files].map((f) => f.name)]);
  };
  return (
    <div className="stack">
      <div
        className={cx('ctx-drop', drag && 'is-over')}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          take(e.dataTransfer.files);
        }}
      >
        <Icon name="upload" size={22} />
        <p>Drop files here, or</p>
        <Button onClick={() => input.current?.click()}>Choose files</Button>
        <input ref={input} type="file" multiple hidden aria-label="Files to attach" onChange={(e) => take(e.target.files)} />
        <p className="muted small">Word, PDF, Excel and PowerPoint files are converted to text. Text, code and images are passed as they are.</p>
      </div>
      {names.length ? <p className="small">Added: {names.join(', ')}</p> : null}
    </div>
  );
}

function NoteTab({ add }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  return (
    <div className="stack">
      <Field label="Title (optional)">{(id) => <input id={id} className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Refund limits agreed with Finance" />}</Field>
      <Field label="Note" hint="Up to 8,000 characters. Paste requirements, log excerpts, decisions, anything the agents should know.">
        {(id) => <textarea id={id} className="input" rows={7} value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} />}
      </Field>
      <div className="row">
        <Button
          variant="primary"
          icon="plus"
          disabled={!body.trim()}
          onClick={() => {
            add({ kind: 'note', title: title.trim() || body.trim().split('\n')[0].slice(0, 80), body: body.trim() });
            setTitle('');
            setBody('');
          }}
        >
          Add note
        </Button>
      </div>
    </div>
  );
}

function LinkTab({ add }) {
  const [url, setUrl] = useState('');
  const [body, setBody] = useState('');
  const ok = /^https?:\/\/\S+$/i.test(url.trim());
  return (
    <div className="stack">
      <Field label="Link" hint="The agents get the address and your note. Whether they can open it depends on the tools the project allows.">
        {(id) => <input id={id} className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />}
      </Field>
      <Field label="What is it? (optional)">{(id) => <textarea id={id} className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
      <div className="row">
        <Button
          variant="primary"
          icon="plus"
          disabled={!ok}
          onClick={() => {
            add({ kind: 'url', ref: url.trim(), title: url.trim(), body: body.trim() });
            setUrl('');
            setBody('');
          }}
        >
          Add link
        </Button>
      </div>
    </div>
  );
}

function EarlierTab({ projectId, excludeSessionId, add, isAdded }) {
  const sessions = useLoad(() => api.get(`/api/projects/${projectId}/workflows`), [projectId]);
  const runs = useLoad(() => api.get(`/api/projects/${projectId}/runs?standalone=1&limit=50`), [projectId]);
  if (!sessions.data || !runs.data) return <Spinner />;
  const s = sessions.data.workflows.filter((w) => w.id !== excludeSessionId);
  const r = runs.data.runs.filter((x) => x.status === 'completed');
  return (
    <div className="stack">
      <h3 className="small">Sessions</h3>
      <PickList
        empty="No other sessions."
        items={s.map((w) => (
          <PickRow key={w.id} icon="play" title={w.title} sub={`${w.summary ? w.summary.slice(0, 100) : 'no summary yet'} · ${timeAgo(w.updated_at)}`} added={isAdded('session', w.id)} onAdd={() => add({ kind: 'session', ref: w.id, title: w.title })} />
        ))}
      />
      <h3 className="small">Single runs</h3>
      <PickList
        empty="No finished single runs."
        items={r.map((x) => (
          <PickRow key={x.id} icon="runs" title={x.title} sub={timeAgo(x.created_at)} added={isAdded('run', x.id)} onAdd={() => add({ kind: 'run', ref: x.id, title: x.title })} />
        ))}
      />
    </div>
  );
}

/** Attached context as removable chips. */
export function ContextChips({ items, onRemove }) {
  if (!items.length) return null;
  return (
    <ul className="ctx-chips" aria-label="Attached context">
      {items.map((c, i) => (
        <li key={`${c.kind}:${c.ref ?? c.title}:${i}`} className="ctx-chip" title={`${KIND_LABEL[c.kind] ?? c.kind}: ${c.title}`}>
          <Icon name={CONTEXT_ICON[c.kind] ?? 'file'} size={13} />
          <span className="ctx-chip-title">{c.title}</span>
          {onRemove ? (
            <button type="button" className="ctx-chip-x" onClick={() => onRemove(i)} aria-label={`Remove ${c.title}`}>
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Upload picked files to a session; returns the other picks, ready to send with a request. */
export async function sendFiles(workflowId, items) {
  for (const c of items.filter((x) => x.kind === 'file')) {
    await api.upload(`/api/workflows/${workflowId}/context/file?name=${encodeURIComponent(c.file.name)}`, c.file);
  }
  return items.filter((x) => x.kind !== 'file').map(({ kind, ref, title, body }) => ({ kind, ref, title, body }));
}

export { KIND_LABEL as CONTEXT_KIND_LABEL };
