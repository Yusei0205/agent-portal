import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Learn } from './Learn.jsx';

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

function DocumentsTab({ projectId }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/knowledge`);
      setDocs(r.docs || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

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
        headers: { 'x-requested-with': 'fetch' },
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
    if (!confirm('Delete this document?')) return;
    try {
      await api.delete(`/api/projects/${projectId}/knowledge/${docId}`);
      setDocs((d) => d.filter((x) => x.id !== docId));
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div className="stack">
      {error && <p className="error-msg" role="alert">{error}</p>}

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
      </div>

      {docs.length === 0 ? (
        <div className="empty-state">
          <p>No documents yet. Upload a PDF, Word, Excel, PowerPoint or text file.</p>
        </div>
      ) : (
        <table className="data-table" aria-label="Knowledge documents">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>Status</th>
              <th>Uploaded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.name}</td>
                <td><span className="muted">{doc.mime_type || '—'}</span></td>
                <td>{formatBytes(doc.size_bytes)}</td>
                <td><StatusBadge status={doc.status} /></td>
                <td className="muted">{formatRelative(doc.created_at)}</td>
                <td>
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
      )}
    </div>
  );
}

// ── Search tab ────────────────────────────────────────────────────────────────

function SearchTab({ projectId }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const search = async (e) => {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/knowledge/search?q=${encodeURIComponent(q)}`);
      setResults(r.results || []);
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
      {error && <p className="error-msg" role="alert">{error}</p>}

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

      {results !== null && results.length === 0 && (
        <p className="muted">No results found.</p>
      )}

      {results?.map((r, i) => (
        <div key={i} className="knowledge-result-card">
          <div className="knowledge-result-name">{r.name}</div>
          <p className="knowledge-result-snippet">{highlight(r.snippet)}</p>
        </div>
      ))}
    </div>
  );
}

// ── Ask tab ───────────────────────────────────────────────────────────────────

function AskTab({ projectId }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [teamSent, setTeamSent] = useState(false);

  const ask = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setTeamSent(false);
    try {
      const r = await api.post(`/api/projects/${projectId}/knowledge/ask`, { question });
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
      {error && <p className="error-msg" role="alert">{error}</p>}

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
        <button type="submit" className="btn btn-primary" disabled={loading || !question.trim()}>
          {loading ? 'Searching…' : 'Ask'}
        </button>
      </form>

      {result && !result.needsTeam && (
        <div className="knowledge-answer">
          <h3>Answer</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</p>
          {result.sources?.length > 0 && (
            <div className="knowledge-sources">
              <h4>Sources</h4>
              {result.sources.map((s, i) => (
                <div key={i} className="knowledge-source-item">
                  <span className="knowledge-source-name">{s.name}</span>
                  <span className="knowledge-source-snippet muted">{s.snippet}</span>
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
        <p className="success-msg">
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
      {error && <p className="error-msg" role="alert">{error}</p>}
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

  return (
    <div className="page">
      <h1>Knowledge</h1>

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
        {tab === 'docs'      && <DocumentsTab  projectId={projectId} />}
        {tab === 'search'    && <SearchTab     projectId={projectId} />}
        {tab === 'ask'       && <AskTab        projectId={projectId} />}
        {tab === 'decisions' && <DecisionsTab  projectId={projectId} />}
        {tab === 'learn'     && <Learn         projectId={projectId} />}
      </div>
    </div>
  );
}

export default Knowledge;
