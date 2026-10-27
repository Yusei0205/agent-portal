import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { BulkActionBar, BulkSelectHint } from '../components/BulkActionBar.jsx';
import { DiagramStyle } from '../components/DiagramStyle.jsx';
import { MermaidViewer } from '../components/MermaidViewer.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function StatusBadge({ status, stale }) {
  if (stale) {
    return <span className="badge badge-warn">Stale</span>;
  }
  const map = {
    ready: ['badge-ok', 'Ready'],
    generating: ['badge-info', 'Generating…'],
    error: ['badge-error', 'Error'],
  };
  const [cls, label] = map[status] ?? ['badge-muted', status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

// ── New diagram modal ─────────────────────────────────────────────────────────

function NewDiagramModal({ projectId, repos, packsAvailable, onClose, onCreated }) {
  const KINDS = [
    { id: 'system_context', label: 'System context' },
    { id: 'components',     label: 'Components' },
    { id: 'data_flow',      label: 'Data flow' },
  ];

  const [name, setName] = useState('');
  const [kind, setKind] = useState('system_context');
  const [style, setStyle] = useState(packsAvailable ? 'icon' : 'mermaid');
  const [cloud, setCloud] = useState('aws');
  const [selectedRepos, setSelectedRepos] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const toggleRepo = (id) => {
    setSelectedRepos((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!selectedRepos.length) { setError('Select at least one repository'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/diagrams`, {
        name: name.trim() || undefined,
        kind,
        style,
        cloud: style === 'icon' ? cloud : undefined,
        repoIds: selectedRepos,
      });
      onCreated(r);
    } catch (err) {
      setError(err.message || 'Failed to create diagram');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-diagram-title">
      <div className="modal">
        <div className="modal-header">
          <h2 id="new-diagram-title">New diagram</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="nd-name">Name</label>
            <input
              id="nd-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Auto-generated from type and repos if blank"
            />
          </div>

          <div className="field">
            <label htmlFor="nd-kind">Diagram type <span aria-hidden>*</span></label>
            <select id="nd-kind" value={kind} onChange={(e) => setKind(e.target.value)} required>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
          </div>

          <DiagramStyle
            style={style}
            cloud={cloud}
            onChange={(s, c) => { setStyle(s); setCloud(c); }}
            packsAvailable={packsAvailable}
          />

          <div className="field">
            <span className="field-label">Repositories <span aria-hidden>*</span></span>
            {!repos.length ? (
              <p className="muted">No repositories connected to this project yet.</p>
            ) : (
              <div className="checkbox-group" role="group" aria-label="Repositories">
                {repos.map((r) => (
                  <label key={r.id} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedRepos.includes(r.id)}
                      onChange={() => toggleRepo(r.id)}
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {error && <div className="error-note" role="alert">{error}</div>}

          <div className="row gap-sm">
            <button type="submit" className="btn btn-primary" disabled={busy || !repos.length}>
              {busy ? 'Creating…' : 'Create diagram'}
            </button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Diagram view modal ────────────────────────────────────────────────────────

function ViewDiagramModal({ diagram, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await api.get(`/api/projects/${diagram.project_id}/diagrams/${diagram.id}`);
        setDetail(r.diagram);
      } catch (err) {
        setError(err.message || 'Failed to load diagram');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [diagram]);

  return (
    <div className="modal-backdrop modal-wide" role="dialog" aria-modal="true" aria-labelledby="view-diagram-title">
      <div className="modal modal-xl">
        <div className="modal-header">
          <h2 id="view-diagram-title">{diagram.title}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          {loading && <div className="spinner" aria-label="Loading…" />}
          {error && <div className="error-note" role="alert">{error}</div>}
          {detail && detail.style === 'mermaid' && detail.mermaid && (
            <MermaidViewer mmd={detail.mermaid} />
          )}
          {detail && detail.style === 'icon' && (
            <div className="drawio-placeholder">
              <Icon name="builder" size={40} />
              <p>Icon diagram (.drawio). <a href={`/api/projects/${detail.project_id}/diagrams/${detail.id}/versions/${detail.version}/download?format=drawio`}>Download .drawio</a> to open in draw.io.</p>
            </div>
          )}
          {detail && !detail.mermaid && detail.style !== 'icon' && (
            <p className="muted">No diagram generated yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Diagram row ───────────────────────────────────────────────────────────────

function DiagramRow({ diagram, selected, onSelect, onRefresh, onDelete, onView }) {
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleDelete = async () => {
    if (!confirm(`Delete diagram "${diagram.title}"?`)) return;
    setDeleting(true);
    try {
      await api.delete(`/api/projects/${diagram.project_id}/diagrams/${diagram.id}`);
      onDelete(diagram.id);
    } catch (err) {
      alert(err.message || 'Failed to delete');
      setDeleting(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await api.post(`/api/projects/${diagram.project_id}/diagrams/${diagram.id}/refresh`, {});
      onRefresh();
    } catch (err) {
      alert(err.message || 'Failed to start refresh');
    } finally {
      setRefreshing(false);
    }
  };

  const downloadUrl = diagram.version > 0
    ? `/api/projects/${diagram.project_id}/diagrams/${diagram.id}/versions/${diagram.version}/download`
    : null;

  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onSelect(diagram.id)}
          aria-label={`Select ${diagram.title}`}
        />
      </td>
      <td>
        <button type="button" className="btn-link" onClick={() => onView(diagram)}>
          {diagram.title}
        </button>
        <div className="row gap-xs muted small">
          <span>{diagram.kind_label}</span>
          {diagram.cloud_label && <><span>·</span><span>{diagram.cloud_label}</span></>}
        </div>
      </td>
      <td>
        <span className="badge badge-muted">{diagram.style_label?.split(' ')[0] ?? diagram.style}</span>
      </td>
      <td>
        <StatusBadge status={diagram.status} stale={diagram.stale} />
      </td>
      <td className="muted small">{formatDate(diagram.updated_at)}</td>
      <td>
        <div className="row gap-xs">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onView(diagram)}
            aria-label={`View ${diagram.title}`}
            disabled={!diagram.version}
          >
            View
          </button>
          {downloadUrl && (
            <a
              href={downloadUrl}
              className="btn btn-sm"
              aria-label={`Download ${diagram.title}`}
              download
            >
              <Icon name="download" size={13} />
            </a>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleRefresh}
            disabled={refreshing || diagram.status === 'generating'}
            aria-label={`Refresh ${diagram.title}`}
            title="Redraw diagram"
          >
            <Icon name="refresh" size={13} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={handleDelete}
            disabled={deleting}
            aria-label={`Delete ${diagram.title}`}
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function Diagrams({ projectId }) {
  const [diagrams, setDiagrams] = useState([]);
  const [repos, setRepos] = useState([]);
  const [styles, setStyles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [viewingDiagram, setViewingDiagram] = useState(null);

  const packsAvailable = styles.find((s) => s.id === 'icon')?.available === true;

  const load = useCallback(async () => {
    try {
      const [diagramsRes, reposRes] = await Promise.all([
        api.get(`/api/projects/${projectId}/diagrams`),
        api.get(`/api/projects/${projectId}/repos`),
      ]);
      setDiagrams(diagramsRes.diagrams || []);
      setStyles(diagramsRes.styles || []);
      setRepos(reposRes.repos || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load diagrams');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
    // Poll for generating diagrams
    const interval = setInterval(() => {
      const hasGenerating = diagrams.some((d) => d.status === 'generating');
      if (hasGenerating) load();
    }, 5000);
    return () => clearInterval(interval);
  }, [load, diagrams]);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} diagram${selected.size === 1 ? '' : 's'}?`)) return;
    setBulkDeleting(true);
    try {
      await Promise.all([...selected].map((id) =>
        api.delete(`/api/projects/${projectId}/diagrams/${id}`)
      ));
      setDiagrams((prev) => prev.filter((d) => !selected.has(d.id)));
      setSelected(new Set());
    } catch (err) {
      alert(err.message || 'Failed to delete some diagrams');
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleCreated = ({ diagram }) => {
    setDiagrams((prev) => [diagram, ...prev]);
    setShowNew(false);
  };

  return (
    <div className="page">
      <div className="page-header row gap-sm">
        <h2>Architecture diagrams</h2>
        <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
          <Icon name="plus" size={15} />
          New diagram
        </button>
      </div>

      {loading && <div className="spinner" aria-label="Loading…" />}
      {error && <div className="error-note" role="alert">{error}</div>}

      {!loading && !diagrams.length && (
        <div className="empty-state">
          <Icon name="builder" size={40} />
          <p>No diagrams yet. Click <strong>New diagram</strong> to draw one from your repositories.</p>
        </div>
      )}

      {diagrams.length > 0 && (
        <div className="table-wrap" style={{ position: 'relative' }}>
          <BulkSelectHint />
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <span className="sr-only">Select</span>
                </th>
                <th>Name</th>
                <th>Style</th>
                <th>Status</th>
                <th>Last updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {diagrams.map((d) => (
                <DiagramRow
                  key={d.id}
                  diagram={d}
                  selected={selected.has(d.id)}
                  onSelect={toggleSelect}
                  onDelete={(id) => {
                    setDiagrams((prev) => prev.filter((x) => x.id !== id));
                    setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
                  }}
                  onRefresh={load}
                  onView={setViewingDiagram}
                />
              ))}
            </tbody>
          </table>
          <BulkActionBar
            selected={selected}
            onDelete={bulkDelete}
            onClear={() => setSelected(new Set())}
            busy={bulkDeleting}
          />
        </div>
      )}

      {showNew && (
        <NewDiagramModal
          projectId={projectId}
          repos={repos}
          packsAvailable={packsAvailable}
          onClose={() => setShowNew(false)}
          onCreated={handleCreated}
        />
      )}

      {viewingDiagram && (
        <ViewDiagramModal
          diagram={viewingDiagram}
          onClose={() => setViewingDiagram(null)}
        />
      )}
    </div>
  );
}
