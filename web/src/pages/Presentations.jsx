import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { BulkActionBar, BulkSelectHint } from '../components/BulkActionBar.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function StatusBadge({ stale, hasPptx }) {
  if (stale) return <span className="badge badge-warn">Stale</span>;
  if (hasPptx) return <span className="badge badge-ok">Ready</span>;
  return <span className="badge badge-info">Generating…</span>;
}

// ── Slide preview modal ───────────────────────────────────────────────────────

function SlidePreviewModal({ name, slides, onClose }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="preview-title">
      <div className="modal modal-wide">
        <div className="modal-header">
          <h2 id="preview-title">Slides — {name}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="slides-preview stack">
          {slides.map((s) => (
            <div key={s.index} className="slide-preview-card">
              <div className="slide-num">Slide {s.index}</div>
              <div className="slide-title">{s.title}</div>
              {s.text && <div className="slide-text">{s.text}</div>}
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ── New presentation modal ────────────────────────────────────────────────────

const SOURCE_KINDS = [
  { id: 'topic', label: 'Topic (free text)' },
  { id: 'document', label: 'From a generated document' },
  { id: 'session', label: 'From a session result' },
  { id: 'diagram', label: 'From an architecture diagram' },
];

function NewPresentationModal({ projectId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [sourceKind, setSourceKind] = useState('topic');
  const [topic, setTopic] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [slideCount, setSlideCount] = useState(12);
  const [audience, setAudience] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (sourceKind === 'topic' && !topic.trim()) { setError('Topic is required'); return; }
    if (sourceKind !== 'topic' && !sourceRef.trim()) { setError('Source reference is required'); return; }

    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/presentations`, {
        name: name.trim(),
        sourceKind,
        topic: sourceKind === 'topic' ? topic.trim() : undefined,
        sourceRef: sourceKind !== 'topic' ? sourceRef.trim() : undefined,
        slideCount: Number(slideCount),
        audience: audience.trim() || undefined,
      });
      onCreated(r);
    } catch (err) {
      setError(err.message || 'Failed to create presentation');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-pres-title">
      <div className="modal">
        <div className="modal-header">
          <h2 id="new-pres-title">New presentation</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="np-name">Name <span aria-hidden>*</span></label>
            <input
              id="np-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="e.g. Q4 Architecture Review"
              required
            />
          </div>

          <fieldset className="field">
            <legend>Source <span aria-hidden>*</span></legend>
            <div className="radio-group">
              {SOURCE_KINDS.map((k) => (
                <label key={k.id} className="radio-label">
                  <input
                    type="radio"
                    name="sourceKind"
                    value={k.id}
                    checked={sourceKind === k.id}
                    onChange={() => setSourceKind(k.id)}
                  />
                  {k.label}
                </label>
              ))}
            </div>
          </fieldset>

          {sourceKind === 'topic' && (
            <div className="field">
              <label htmlFor="np-topic">Topic <span aria-hidden>*</span></label>
              <textarea
                id="np-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                maxLength={4000}
                rows={4}
                placeholder="Describe what the presentation should cover…"
                required
              />
            </div>
          )}

          {sourceKind !== 'topic' && (
            <div className="field">
              <label htmlFor="np-source-ref">
                {sourceKind === 'document' ? 'Document ID' : sourceKind === 'session' ? 'Session ID' : 'Diagram ID'}
                {' '}<span aria-hidden>*</span>
              </label>
              <input
                id="np-source-ref"
                type="text"
                value={sourceRef}
                onChange={(e) => setSourceRef(e.target.value)}
                placeholder={`Enter ${sourceKind} ID`}
                required
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="np-slides">Slide count</label>
            <input
              id="np-slides"
              type="number"
              value={slideCount}
              onChange={(e) => setSlideCount(e.target.value)}
              min={3}
              max={40}
            />
          </div>

          <div className="field">
            <label htmlFor="np-audience">Audience (optional)</label>
            <input
              id="np-audience"
              type="text"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              maxLength={200}
              placeholder="e.g. Engineering leadership"
            />
          </div>

          {error && <p className="error-msg" role="alert">{error}</p>}

          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Presentations page ────────────────────────────────────────────────────────

/**
 * Presentations page — list, create, download and manage AI-generated PPTX decks.
 *
 * @param {{ projectId: string }} props
 */
export function Presentations({ projectId }) {
  const [presentations, setPresentations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [preview, setPreview] = useState(null); // { name, slides }

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/api/projects/${projectId}/presentations`);
      setPresentations(r.presentations ?? []);
    } catch (err) {
      setError(err.message || 'Failed to load presentations');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleCreated = () => {
    setShowNew(false);
    load();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this presentation?')) return;
    try {
      await api.delete(`/api/projects/${projectId}/presentations/${id}`);
      setPresentations((prev) => prev.filter((p) => p.id !== id));
      setSelected((prev) => { const s = new Set(prev); s.delete(id); return s; });
    } catch (err) {
      alert(err.message || 'Failed to delete');
    }
  };

  const handleRefresh = async (id) => {
    try {
      await api.post(`/api/projects/${projectId}/presentations/${id}/refresh`, {});
      load();
    } catch (err) {
      alert(err.message || 'Failed to refresh');
    }
  };

  const handleBulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} presentation(s)?`)) return;
    setBulkBusy(true);
    try {
      for (const id of selected) {
        await api.delete(`/api/projects/${projectId}/presentations/${id}`);
      }
      setSelected(new Set());
      load();
    } catch (err) {
      alert(err.message || 'Failed to delete');
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  };

  const toggleAll = () => {
    if (selected.size === presentations.length) setSelected(new Set());
    else setSelected(new Set(presentations.map((p) => p.id)));
  };

  if (loading) return <div className="page"><p className="muted">Loading presentations…</p></div>;
  if (error) return <div className="page"><p className="error-msg">{error}</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2>Presentations</h2>
          <p className="muted">AI-generated PowerPoint decks from your project content.</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowNew(true)}
        >
          + New presentation
        </button>
      </div>

      {presentations.length === 0 ? (
        <div className="empty-state">
          <p>No presentations yet. Create one to get started.</p>
        </div>
      ) : (
        <>
          <BulkSelectHint selected={selected.size} total={presentations.length} />

          <table className="data-table" aria-label="Presentations">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={selected.size === presentations.length && presentations.length > 0}
                    onChange={toggleAll}
                    aria-label="Select all"
                  />
                </th>
                <th>Name</th>
                <th>Source</th>
                <th>Slides</th>
                <th>Status</th>
                <th>Last updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {presentations.map((p) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      aria-label={`Select ${p.name}`}
                    />
                  </td>
                  <td className="table-primary">{p.name}</td>
                  <td className="table-muted">
                    {p.source_kind === 'topic' ? (
                      <span title={p.topic ?? ''}>{p.topic ? p.topic.slice(0, 40) + (p.topic.length > 40 ? '…' : '') : '—'}</span>
                    ) : (
                      <span className="badge badge-muted">{p.source_kind}</span>
                    )}
                  </td>
                  <td>{p.slide_count}</td>
                  <td>
                    <StatusBadge stale={p.stale} hasPptx={Boolean(p.pptx_path)} />
                  </td>
                  <td className="table-muted">{formatDate(p.updated_at)}</td>
                  <td>
                    <div className="action-row">
                      {p.pptx_path && (
                        <a
                          href={`/api/projects/${projectId}/presentations/${p.id}/download`}
                          className="btn btn-sm btn-ghost"
                          download
                        >
                          Download PPTX
                        </a>
                      )}
                      {p.preview_json && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setPreview({ name: p.name, slides: p.preview_json })}
                        >
                          View slides
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => handleRefresh(p.id)}
                        title="Refresh presentation"
                      >
                        Refresh
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDelete(p.id)}
                        title="Delete presentation"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {selected.size > 0 && (
            <BulkActionBar
              count={selected.size}
              busy={bulkBusy}
              onDelete={handleBulkDelete}
              onClear={() => setSelected(new Set())}
            />
          )}
        </>
      )}

      {showNew && (
        <NewPresentationModal
          projectId={projectId}
          onClose={() => setShowNew(false)}
          onCreated={handleCreated}
        />
      )}

      {preview && (
        <SlidePreviewModal
          name={preview.name}
          slides={preview.slides}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
