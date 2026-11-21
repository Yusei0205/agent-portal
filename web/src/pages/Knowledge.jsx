import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Learn } from './Learn.jsx';
import { AiChoicePicker } from '../components/AiChoicePicker.jsx';
import { KnowledgeSearchSetup } from '../components/KnowledgeSearchSetup.jsx';
import { KnowledgeDocViewer } from '../components/KnowledgeDocViewer.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useBulkSelect } from '../lib/useBulkSelect.js';
import { BulkActionBar } from '../components/BulkActionBar.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { useSort } from '../lib/useSort.jsx';
import { PageHeader, SectionHead } from '../components/PageHeader.jsx';
import { BuildKnowledgeDialog } from '../components/BuildKnowledgeDialog.jsx';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function StatusBadge({ status }) {
  const map = { processing: 'badge-info', ready: 'badge-success', error: 'badge-error' };
  return <span className={`badge ${map[status] || 'badge-neutral'}`}>{status}</span>;
}

// ── Documents tab ─────────────────────────────────────────────────────────────

function DocumentsTab({ projectId, onOpenDoc }) {
  const [docs, setDocs] = useState([]);
  const { sorted: sortedDocs, sortProps } = useSort(docs, { name: (doc) => doc.name, type: (doc) => doc.mime_type, size: (doc) => doc.size_bytes, status: (doc) => doc.status, uploaded: (doc) => doc.created_at });
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const fileRef = useRef(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();
  const bulk = useBulkSelect(docs);
  const [building, setBuilding] = useState(false);
  // Documents being written from the code that are not in Knowledge yet (linked, no copy so far).
  const [writing, setWriting] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/knowledge`);
      setDocs(r.docs || []);
      const g = await api.get(`/api/projects/${projectId}/generated-docs`).catch(() => ({ docs: [] }));
      setWriting((g.docs || []).filter((d) => d.sources?.knowledge?.on && !d.sources?.knowledge?.docId && d.status !== 'failed'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // While documents are being written, look again every 20 s so they appear without a reload.
  useEffect(() => {
    if (!writing.length) return undefined;
    const t = setInterval(() => { load(); }, 20000);
    return () => clearInterval(t);
  }, [writing.length, load]);

  const rebuild = async (doc) => {
    try {
      await api.post(`/api/projects/${projectId}/generated-docs/${doc.generated.id}/refresh`, {});
      toast(`Rebuilding "${doc.generated.name}" from the code. It updates here when done.`, 'success');
      setDocs((all) => all.map((d) => (d.id === doc.id ? { ...d, generated: { ...d.generated, status: 'generating' } } : d)));
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => { load(); }, [load]);

  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/projects/${projectId}/knowledge/upload`, {
        method: 'POST',
        headers: { 'x-requested-with': 'agent-portal' },
        body: fd,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Upload failed (${res.status})`);
      }
      fileRef.current.value = '';
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const deleteDoc = async (docId) => {
    if (!await requestConfirm('Delete this document?', 'Delete', 'danger')) return;
    try {
      await api.delete(`/api/projects/${projectId}/knowledge/${docId}`);
      setDocs((d) => d.filter((x) => x.id !== docId));
      bulk.clearAll();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleBulkDelete = async () => {
    const n = bulk.selected.size;
    if (!await requestConfirm(
      `Delete ${n} document${n === 1 ? '' : 's'}? This cannot be undone.`,
      'Delete', 'danger',
    )) return;
    setBulkBusy(true);
    const ids = [...bulk.selected];
    const failed = [];
    await Promise.all(ids.map(async (id) => {
      try {
        await api.delete(`/api/projects/${projectId}/knowledge/${id}`);
      } catch {
        failed.push(id);
      }
    }));
    setDocs((d) => d.filter((x) => !ids.includes(x.id) || failed.includes(x.id)));
    bulk.clearAll();
    if (failed.length > 0) {
      toast(`${failed.length} document${failed.length === 1 ? '' : 's'} could not be deleted.`, 'error');
    }
    setBulkBusy(false);
  };

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      {error && <p className="error-note" role="alert">{error}</p>}

      <div className="actions-row">
        <label className={`btn btn-primary${uploading ? ' disabled' : ''}`}>
          <Icon name="upload" size={14} />
          {uploading ? 'Uploading…' : 'Upload document'}
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.xlsx,.pptx,.html,.txt,.md,.csv"
            style={{ display: 'none' }}
            onChange={upload}
            disabled={uploading}
            aria-label="Upload document"
          />
        </label>
        <button type="button" className="btn" onClick={() => setBuilding(true)}>
          <Icon name="sparkles" size={14} /> Build from repositories
        </button>
      </div>
      {building && (
        <BuildKnowledgeDialog
          projectId={projectId}
          onClose={() => setBuilding(false)}
          onStarted={(started) => { toast(`Writing ${started.length} document${started.length === 1 ? '' : 's'} from the code. They appear here when ready.`, 'success'); load(); }}
        />
      )}
      {writing.length > 0 && (
        <p className="muted kb-writing" role="status">
          <Icon name="sparkles" size={13} /> Writing from the code: {writing.map((d) => d.name).join('; ')}. They appear below when ready.{' '}
          <a href={`#/p/${projectId}/create`}>See progress in Create › Documents</a>
        </p>
      )}

      {docs.length === 0 ? (
        <div className="empty-state">
          <p>No documents yet. Upload a PDF, Word, Excel, PowerPoint or text file, or <strong>Build from repositories</strong> to have the portal write them from the project's code.</p>
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <table className="data-table" aria-label="Knowledge documents">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all documents"
                    checked={bulk.allSelected}
                    ref={(el) => { if (el) el.indeterminate = bulk.someSelected; }}
                    onChange={bulk.toggleAll}
                  />
                </th>
                <th {...sortProps('name')}>Name</th>
                <th {...sortProps('type')}>Type</th>
                <th {...sortProps('size')}>Size</th>
                <th {...sortProps('status')}>Status</th>
                <th {...sortProps('uploaded')}>Uploaded</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedDocs.map((doc) => (
                <tr key={doc.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${doc.name}`}
                      checked={bulk.selected.has(doc.id)}
                      onChange={() => bulk.toggle(doc.id)}
                    />
                  </td>
                  <td>
                    {doc.status === 'ready'
                      ? <button type="button" className="link-btn" onClick={() => onOpenDoc({ docId: doc.id, name: doc.name })} title="Read the document">{doc.name}</button>
                      : doc.name}
                    {doc.generated && (
                      <span className="badge badge-neutral kb-from-code" title={`Written from the code by "${doc.generated.name}" in Create`}>
                        From code{doc.generated.stale ? ' · out of date' : ''}
                      </span>
                    )}
                  </td>
                  <td><span className="muted">{doc.mime_type || '—'}</span></td>
                  <td>{formatBytes(doc.size_bytes)}</td>
                  <td><StatusBadge status={doc.status} /></td>
                  <td className="muted">{formatRelative(doc.created_at)}</td>
                  <td className="kb-row-actions">
                    {doc.generated && (
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => rebuild(doc)}
                        disabled={doc.generated.status === 'generating' || doc.generated.status === 'running'}
                        aria-label={`Rebuild ${doc.name} from the code`}
                        title="Rebuild from the code"
                      >
                        <Icon name="refresh" size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={() => deleteDoc(doc.id)}
                      aria-label={`Delete ${doc.name}`}
                      title="Delete"
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <BulkActionBar
            selected={bulk.selected}
            onDelete={handleBulkDelete}
            onClear={bulk.clearAll}
            busy={bulkBusy}
            noun="document"
          />
        </div>
      )}
    </div>
  );
}

// ── Search tab ────────────────────────────────────────────────────────────────

function SearchTab({ projectId, onOpenDoc }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [via, setVia] = useState(null);
  const [searchNote, setSearchNote] = useState(null);

  const search = async (e) => {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/knowledge/search?q=${encodeURIComponent(q)}`);
      setResults(r.results || []);
      setSearchNote(r.note || null);
      setVia(r.via || null);
    } catch (err) {
      setError(err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const highlight = (text) => {
    if (!text) return text;
    // Replace ⟦…⟧ markers with highlighted spans
    const parts = String(text).split(/(⟦[^⟧]*⟧)/);
    return parts.map((p, i) => {
      if (p.startsWith('⟦') && p.endsWith('⟧')) {
        return <mark key={i}>{p.slice(1, -1)}</mark>;
      }
      return p;
    });
  };

  return (
    <div className="stack">
      {error && <p className="error-note" role="alert">{error}</p>}

      <form onSubmit={search} className="search-form" role="search">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your documents…"
          aria-label="Search knowledge base"
          className="input-search"
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searchNote && <p className="field-hint" role="status">{searchNote}</p>}
      {via && !searchNote && <p className="field-hint">Searched by {VIA_LABEL[via] || via}.</p>}
      {results !== null && results.length === 0 && (
        <p className="muted">No results found.</p>
      )}

      {results?.map((r, i) => (
        <div key={i} className="knowledge-result-card">
          <div className="knowledge-result-name">{r.name}{r.heading ? ` › ${r.heading}` : ""}</div>
          <p className="knowledge-result-snippet">{highlight(r.snippet)}</p>
          <button type="button" className="btn btn-sm" onClick={() => onOpenDoc({ docId: r.docId, name: r.name, passage: r.passage || r.snippet, heading: r.heading })}>
            Open document
          </button>
        </div>
      ))}
    </div>
  );
}

const VIA_LABEL = { keyword: 'keywords', embeddings: 'meaning and keywords', kb: 'the AWS Knowledge Base' };

// ── Ask tab ───────────────────────────────────────────────────────────────────

function AskTab({ projectId, onOpenDoc }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [teamSent, setTeamSent] = useState(false);
  const [ai, setAi] = useState({});

  const ask = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setTeamSent(false);
    try {
      const r = await api.post(`/api/projects/${projectId}/knowledge/ask`, { question, ...ai });
      setResult(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const sendToTeam = async () => {
    try {
      await api.post(`/api/projects/${projectId}/knowledge/decisions`, {
        question,
        answer: '(Pending team response)',
      });
      setTeamSent(true);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="stack">
      {error && <p className="error-note" role="alert">{error}</p>}

      <form onSubmit={ask} className="stack">
        <div className="field">
          <label htmlFor="ask-question">Question</label>
          <textarea
            id="ask-question"
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask something about your project documents…"
            className="input-textarea"
          />
        </div>
        <AiChoicePicker onChange={setAi} disabled={loading} idPrefix="ask-ai" />
        <p className="field-hint">
          Ask finds the passages that use your words, then the model above answers from those passages only and cites them.
        </p>
        <button type="submit" className="btn btn-primary" disabled={loading || !question.trim()}>
          {loading ? 'Reading the documents…' : 'Ask'}
        </button>
      </form>

      {result && !result.needsTeam && (
        <div className="knowledge-answer">
          <h3>Answer</h3>
          {result.note && <p className="field-hint" role="status">{result.note}</p>}
          {result.searchNote ? <p className="field-hint" role="status">{result.searchNote}</p> : result.via ? <p className="field-hint">Passages found by {VIA_LABEL[result.via] || result.via}.</p> : null}
          <p style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</p>
          {result.sources?.length > 0 && (
            <div className="knowledge-sources">
              <h4>Sources</h4>
              {result.sources.map((s, i) => (
                <div key={i} className="knowledge-source-item">
                  <span className="knowledge-source-name">
                    {s.n ? `[${s.n}] ` : ''}{s.name}{s.heading ? ` › ${s.heading}` : ''}
                    {result.mode === 'model' && result.cited?.includes(s.n) ? ' · cited' : ''}
                  </span>
                  <span className="knowledge-source-snippet muted">{s.snippet}</span>
                  <button type="button" className="link-btn" onClick={() => onOpenDoc({ docId: s.docId, name: s.name, passage: s.passage || s.snippet, heading: s.heading })}>
                    Open in the document
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {result?.needsTeam && !teamSent && (
        <div className="knowledge-needs-team">
          <p>The documents don't contain a clear answer to this question.</p>
          <button type="button" className="btn btn-secondary" onClick={sendToTeam}>
            Send to team questions
          </button>
        </div>
      )}

      {teamSent && (
        <p className="success-note">
          <Icon name="check" size={14} /> Sent to team questions.
        </p>
      )}
    </div>
  );
}

// ── Decisions tab ─────────────────────────────────────────────────────────────

function DecisionsTab({ projectId }) {
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/api/projects/${projectId}/knowledge/decisions`)
      .then((r) => setDecisions(r.decisions || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      {error && <p className="error-note" role="alert">{error}</p>}
      {decisions.length === 0 ? (
        <div className="empty-state">
          <p>No decisions yet. They appear when team questions are answered.</p>
        </div>
      ) : (
        <div className="decisions-list">
          {decisions.map((d) => (
            <div key={d.id} className="decision-card">
              <div className="decision-q">
                <strong>Q:</strong> {d.question}
              </div>
              <div className="decision-a">
                <strong>A:</strong> {d.answer}
              </div>
              <div className="decision-meta muted">
                {formatRelative(d.created_at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'docs',      label: 'Documents' },
  { id: 'search',    label: 'Search'    },
  { id: 'ask',       label: 'Ask'       },
  { id: 'decisions', label: 'Decisions' },
  { id: 'learn',     label: 'Learn'     },
];

export function Knowledge({ projectId }) {
  const [tab, setTab] = useState('docs');
  const [setupOpen, setSetupOpen] = useState(false);
  const [viewer, setViewer] = useState(null); // { docId, name, passage?, heading? }

  return (
    <div className="page">
      <PageHeader title="Knowledge" description="Documents, decisions and learning material that agents in this project can draw on.">
        <button type="button" className="btn" onClick={() => setSetupOpen(true)}>
          <Icon name="settings" size={14} />
          Search setup
        </button>
      </PageHeader>
      {setupOpen && <KnowledgeSearchSetup projectId={projectId} onClose={() => setSetupOpen(false)} />}
      {viewer && <KnowledgeDocViewer projectId={projectId} {...viewer} onClose={() => setViewer(null)} />}

      <div className="tab-bar" role="tablist" aria-label="Knowledge sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-btn${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {tab === 'docs'      && <DocumentsTab  projectId={projectId} onOpenDoc={setViewer} />}
        {tab === 'search'    && <SearchTab     projectId={projectId} onOpenDoc={setViewer} />}
        {tab === 'ask'       && <AskTab        projectId={projectId} onOpenDoc={setViewer} />}
        {tab === 'decisions' && <DecisionsTab  projectId={projectId} />}
        {tab === 'learn'     && <Learn         projectId={projectId} />}
      </div>
    </div>
  );
}

export default Knowledge;
