/**
 * Learn page — tab within Knowledge.
 * Tabs: Overview · Glossary · FAQ · Quizzes · Onboarding
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';

// ── Constants ─────────────────────────────────────────────────────────────────

const DOC_TYPES = ['overview', 'feature-guide', 'glossary', 'faq'];
const AUDIENCES = ['everyone', 'engineers'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function StaleBadge() {
  return (
    <span className="badge badge-warn" title="Sources have changed — regenerate to refresh">
      Stale
    </span>
  );
}

function StatusBadge({ status }) {
  const map = {
    generating: 'badge-info',
    draft: 'badge-neutral',
    published: 'badge-success',
    error: 'badge-error',
  };
  return <span className={`badge ${map[status] || 'badge-neutral'}`}>{status}</span>;
}

// ── Overview tab — list learn docs ────────────────────────────────────────────

function OverviewTab({ projectId }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ title: '', doc_type: 'overview', audience: 'everyone' });
  const [createError, setCreateError] = useState(null);
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/learn/docs`);
      setDocs(r.docs || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const createDoc = async (e) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await api.post(`/api/projects/${projectId}/learn/docs`, createForm);
      setShowCreate(false);
      setCreateForm({ title: '', doc_type: 'overview', audience: 'everyone' });
      await load();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const togglePublish = async (doc) => {
    try {
      const action = doc.published ? 'unpublish' : 'publish';
      await api.post(`/api/learn/docs/${doc.id}/${action}`);
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading documents…" />;
  if (error) return <p className="error-note" role="alert">{error}</p>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
        <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Icon name="plus" size={14} /> New document
        </button>
      </div>

      {showCreate && (
        <div className="card" style={{ marginBottom: '1rem', padding: '1rem' }}>
          <h3 style={{ marginTop: 0 }}>New learning document</h3>
          <form onSubmit={createDoc} className="stack">
            <div className="field">
              <label htmlFor="ld-title">Title</label>
              <input
                id="ld-title"
                type="text"
                value={createForm.title}
                onChange={(e) => setCreateForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="System overview"
                required
                maxLength={200}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="field">
                <label htmlFor="ld-type">Type</label>
                <select
                  id="ld-type"
                  value={createForm.doc_type}
                  onChange={(e) => setCreateForm((f) => ({ ...f, doc_type: e.target.value }))}
                >
                  {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ld-audience">Audience</label>
                <select
                  id="ld-audience"
                  value={createForm.audience}
                  onChange={(e) => setCreateForm((f) => ({ ...f, audience: e.target.value }))}
                >
                  {AUDIENCES.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
            </div>
            {createError && <p className="error-note" role="alert">{createError}</p>}
            <div style={{ display: 'flex', gap: '.5rem' }}>
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button type="button" className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {docs.length === 0 ? (
        <p className="muted">No learning documents yet. Create one above.</p>
      ) : (
        <div className="stack">
          {docs.map((doc) => (
            <div key={doc.id} className="card" style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 600 }}>{doc.title}</div>
                <div className="muted" style={{ fontSize: '.85rem' }}>
                  {doc.kind || doc.doc_type} · {doc.audience || 'everyone'} ·{' '}
                  <StatusBadge status={doc.status || (doc.published ? 'published' : 'draft')} />
                  {doc.stale && <> <StaleBadge /></>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '.5rem', flexShrink: 0 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => togglePublish(doc)}
                  title={doc.published ? 'Unpublish' : 'Publish'}
                >
                  {doc.published || doc.status === 'published' ? 'Unpublish' : 'Publish'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

// ── Quizzes tab ───────────────────────────────────────────────────────────────

function QuizzesTab({ projectId }) {
  const [quizzes, setQuizzes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [taking, setTaking] = useState(null); // quiz being taken
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/learn/quizzes`);
      setQuizzes(r.quizzes || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const startQuiz = async (quiz) => {
    try {
      const r = await api.get(`/api/learn/quizzes/${quiz.id}?mode=take`);
      setTaking(r.quiz);
      setAnswers({});
      setResult(null);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const submitQuiz = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const r = await api.post(`/api/learn/quizzes/${taking.id}/attempts`, { answers });
      setResult(r.attempt);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading quizzes…" />;
  if (error) return <p className="error-note" role="alert">{error}</p>;

  // Taking a quiz
  if (taking && !result) {
    const questions = taking.questions || [];
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
          <button type="button" className="btn" onClick={() => setTaking(null)}>← Back</button>
          <h2 style={{ margin: 0 }}>{taking.title}</h2>
        </div>
        <form onSubmit={submitQuiz} className="stack">
          {questions.map((q, i) => (
            <div key={q.id} className="card" style={{ padding: '1rem' }}>
              <div style={{ marginBottom: '.75rem', fontWeight: 600 }}>{i + 1}. {q.question}</div>
              {q.options ? (
                <div className="stack" style={{ gap: '.4rem' }}>
                  {q.options.map((opt) => (
                    <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name={`q-${q.id}`}
                        value={opt}
                        checked={answers[q.id] === opt}
                        onChange={() => setAnswers((a) => ({ ...a, [q.id]: opt }))}
                      />
                      {opt}
                    </label>
                  ))}
                </div>
              ) : (
                <input
                  type="text"
                  value={answers[q.id] || ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  placeholder="Your answer"
                />
              )}
            </div>
          ))}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit answers'}
          </button>
        </form>
      </div>
    );
  }

  // Quiz result
  if (taking && result) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
          <button type="button" className="btn" onClick={() => { setTaking(null); setResult(null); }}>← Back</button>
          <h2 style={{ margin: 0 }}>Results: {taking.title}</h2>
        </div>
        <div className="card" style={{ padding: '1.5rem', textAlign: 'center', marginBottom: '1rem' }}>
          <div style={{ fontSize: '2rem', fontWeight: 700 }}>{result.score}/{result.total}</div>
          <div style={{ color: result.passed ? 'var(--ok)' : 'var(--danger)', fontWeight: 600, marginTop: '.5rem' }}>
            {result.passed ? '✓ Passed' : '✗ Not passed'}
          </div>
        </div>
        <div className="stack">
          {result.results?.map((r, i) => (
            <div key={r.id} className="card" style={{ padding: '.75rem', borderLeft: `3px solid ${r.correct ? 'var(--ok)' : 'var(--danger)'}` }}>
              <div style={{ fontWeight: 600, marginBottom: '.25rem' }}>
                {r.correct ? '✓' : '✗'} Q{i + 1}: {r.given || '(no answer)'}
              </div>
              {!r.correct && (
                <div className="muted" style={{ fontSize: '.85rem' }}>
                  Correct: {r.answer} {r.explanation ? `— ${r.explanation}` : ''}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      {quizzes.length === 0 ? (
        <p className="muted">No quizzes yet. Quizzes are linked to learning documents.</p>
      ) : (
        <div className="stack">
          {quizzes.map((q) => (
            <div key={q.id} className="card" style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontWeight: 600 }}>{q.title}</div>
                <div className="muted" style={{ fontSize: '.85rem' }}>
                  {q.audience} · {q.difficulty} · {q.question_count ?? 0} questions
                  {q.stale && <> <StaleBadge /></>}
                </div>
              </div>
              {q.status === 'published' && (
                <button type="button" className="btn btn-sm btn-primary" onClick={() => startQuiz(q)}>
                  Take quiz
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}

// ── Onboarding paths tab ──────────────────────────────────────────────────────

function OnboardingTab({ projectId }) {
  const [paths, setPaths] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/learn/paths`);
      setPaths(r.paths || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="spinner" aria-label="Loading paths…" />;
  if (error) return <p className="error-note" role="alert">{error}</p>;

  return (
    <div>
      {paths.length === 0 ? (
        <p className="muted">No onboarding paths yet.</p>
      ) : (
        <div className="stack">
          {paths.map((p) => (
            <div key={p.id} className="card" style={{ padding: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{p.title}</div>
                  <div className="muted" style={{ fontSize: '.85rem' }}>
                    {p.audience} · {p.steps?.length ?? 0} steps
                  </div>
                </div>
                {p.progress !== undefined && (
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{p.progress}%</div>
                    <div className="muted" style={{ fontSize: '.8rem' }}>progress</div>
                  </div>
                )}
              </div>
              {p.description && (
                <p style={{ fontSize: '.9rem', color: 'var(--muted)', margin: '.5rem 0 0' }}>{p.description}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Learn component ──────────────────────────────────────────────────────

const LEARN_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'quizzes', label: 'Quizzes' },
  { id: 'onboarding', label: 'Onboarding' },
];

export function Learn({ projectId }) {
  const [tab, setTab] = useState('overview');

  return (
    <div>
      <div className="tabs" role="tablist" aria-label="Learn sections">
        {LEARN_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            className={`tab-btn${tab === t.id ? ' is-active' : ''}`}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-panel" style={{ paddingTop: '1rem' }}>
        {tab === 'overview' && <OverviewTab projectId={projectId} />}
        {tab === 'quizzes' && <QuizzesTab projectId={projectId} />}
        {tab === 'onboarding' && <OnboardingTab projectId={projectId} />}
      </div>
    </div>
  );
}

export default Learn;
