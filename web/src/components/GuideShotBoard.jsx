import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';

/**
 * The shot board of a user guide: every picture of the guide with where it stands.
 *   placed        the text shows it
 *   unplaced      taken, but no section shows it yet (it goes in "More screenshots" in the HTML guide)
 *   missing file  the text shows it, but the file is not there
 *   not captured  the screenshot manifest says it could not be taken
 * Role, page and title come from screenshots/manifest.jsonl when the run wrote one.
 */

const STATUS = {
  placed: { label: 'Placed', cls: 'badge-success' },
  unplaced: { label: 'Not in the text', cls: 'badge-warning' },
  'missing-file': { label: 'File missing', cls: 'badge-danger' },
  'not-captured': { label: 'Not captured', cls: 'badge-muted' },
};

export function GuideShotBoard({ projectId, doc, onClose }) {
  const ref = useFocusTrap();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/generated-docs/${doc.id}/shots`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e.message || 'Could not load the screenshots'); });
    return () => { live = false; };
  }, [projectId, doc.id]);

  const rows = (data?.shots || []).filter((r) => filter === 'all' || r.status === filter);
  const counts = data?.counts;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="shot-board-title">
      <div className="modal" ref={ref} style={{ width: 'min(960px, 94vw)', maxWidth: 'none' }}>
        <div className="modal-header">
          <h2 id="shot-board-title">Screenshots: {doc.name}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="stack">
          {error && <p className="error-msg" role="alert">{error}</p>}
          {!data && !error && <p className="muted">Loading…</p>}
          {counts && counts.total === 0 && <p className="muted">This guide has no screenshots.</p>}
          {counts && counts.total > 0 && (
            <>
              <div className="action-row" role="group" aria-label="Show">
                <button type="button" className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter('all')}>All {counts.total}</button>
                {Object.entries(STATUS).map(([key, s]) => counts[key] > 0 && (
                  <button key={key} type="button" className={`btn btn-sm ${filter === key ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(key)}>{s.label} {counts[key]}</button>
                ))}
              </div>
              <div className="table-wrap" style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead><tr><th>Picture</th><th>Status</th><th>Role</th><th>Page</th><th>What it shows</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.file}>
                        <td className="table-primary"><code>{r.file.replace(/^screenshots\//, '')}</code></td>
                        <td><span className={`badge ${STATUS[r.status]?.cls || 'badge-muted'}`}>{STATUS[r.status]?.label || r.status}</span></td>
                        <td className="table-muted">{r.role}</td>
                        <td className="table-muted">{r.page}</td>
                        <td>
                          {r.title}
                          {r.boxes?.length > 0 && <span className="table-muted"> · {r.boxes.length} marked</span>}
                          {r.notes && <div className="field-hint">{r.notes}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.shots.some((r) => r.inManifest) && (
                <p className="field-hint">No screenshot manifest came with this guide, so role, page and title are not known. They appear when a run writes <code>screenshots/manifest.jsonl</code>.</p>
              )}
            </>
          )}
          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
