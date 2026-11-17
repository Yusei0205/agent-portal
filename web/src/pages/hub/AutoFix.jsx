import { useState, useEffect } from 'react';
import { api } from '../../lib/api.js';
import { formatRelative } from '../../lib/util.js';

const STATUSES = [
  { id: 'new', label: 'New', tone: 'info' },
  { id: 'triaged', label: 'Triaged', tone: 'info' },
  { id: 'fixing', label: 'Fixing', tone: 'warn' },
  { id: 'pr_open', label: 'PR open', tone: 'ok' },
  { id: 'resolved', label: 'Resolved', tone: 'ok' },
  { id: 'dismissed', label: 'Dismissed', tone: 'muted' },
  { id: 'suppressed', label: 'Suppressed', tone: 'muted' },
  { id: 'needs_human', label: 'Needs a person', tone: 'danger' },
];
const BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

function StatusPill({ status }) {
  const s = BY_ID[status] || { label: status, tone: 'muted' };
  return <span className={`af-pill is-${s.tone}`}>{s.label}</span>;
}

/** Read-only view of a project's Auto-fix findings. Policy editing comes later. */
export function AutoFix({ projectId }) {
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/autofix/policy`)
      .then((r) => { if (live) setPolicy(r.policy); })
      .catch(() => { if (live) setPolicy(null); });
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    let live = true;
    setError(null);
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    api.get(`/api/projects/${projectId}/autofix/findings${q}`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e.message || 'Failed to load findings'); });
    return () => { live = false; };
  }, [projectId, status]);

  if (error) return <div className="error-note" role="alert">{error}</div>;
  if (!data) return <div className="spinner-wrap"><div className="spinner" aria-label="Loading…" /></div>;

  const counts = data.counts || {};
  return (
    <div className="af-root" data-testid="autofix-tab">
      {policy?.mode === 'off' && (
        <p className="af-notice" role="status">
          <strong>Auto-fix is off for this project.</strong> Failures are not being turned into findings or fixes. Findings recorded earlier are shown below.
        </p>
      )}
      <ul className="af-counts" aria-label="Findings by status">
        {STATUSES.map((s) => (
          <li key={s.id} className="af-count">
            <span className="af-count-n">{counts[s.id] ?? 0}</span>
            <StatusPill status={s.id} />
          </li>
        ))}
      </ul>
      <div className="af-filter">
        <label htmlFor="af-status">Status</label>
        <select id="af-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      {data.findings.length === 0 ? (
        <p className="muted">No findings{status ? ' with this status' : ' yet'}.</p>
      ) : (
        <div className="af-table-wrap">
          <table className="af-table">
            <thead>
              <tr><th>Kind</th><th>Branch</th><th>Seen</th><th>Status</th><th>Links</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {data.findings.map((f) => (
                <tr key={f.id} data-finding-id={f.id}>
                  <td>{f.kind}</td>
                  <td>{f.branch || <span className="muted">none</span>}</td>
                  <td>{f.occurrences}x</td>
                  <td><StatusPill status={f.status} /></td>
                  <td className="af-links">
                    {f.workflow_id && <a href={`#/p/${projectId}/sessions/${f.workflow_id}`}>Session</a>}
                    {f.pr_url && <a href={f.pr_url} target="_blank" rel="noreferrer">PR{f.pr_number ? ` #${f.pr_number}` : ''}</a>}
                    {!f.workflow_id && !f.pr_url && <span className="muted">none</span>}
                  </td>
                  <td className="muted">{formatRelative(f.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default AutoFix;
