import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDate, formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';

// ── New token modal ───────────────────────────────────────────────────────────

function NewTokenModal({ projects, onClose, onCreated }) {
  const [name, setName]         = useState('');
  const [scope, setScope]       = useState('read');
  const [projectId, setProjectId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        scope,
        ...(projectId ? { projectId } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      };
      const r = await api.post('/api/api-tokens', body);
      onCreated(r.token, r.info);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Create API token">
      <div className="modal">
        <div className="modal-header">
          <h2>New API token</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="stack">
            <div className="field">
              <label htmlFor="tok-name">Name</label>
              <input
                id="tok-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CI pipeline"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="tok-scope">Scope</label>
              <select id="tok-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="read">Read</option>
                <option value="write">Read + Write</option>
              </select>
            </div>
            {projects && projects.length > 0 && (
              <div className="field">
                <label htmlFor="tok-project">Restrict to project (optional)</label>
                <select id="tok-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">— all projects —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="tok-expires">Expiry date (optional)</label>
              <input
                id="tok-expires"
                type="date"
                value={expiresAt}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
              <span className="field-hint">Leave blank for the default 90-day expiry.</span>
            </div>
            {error && <p className="error-note" role="alert">{error}</p>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create token'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Token revealed modal ──────────────────────────────────────────────────────

function TokenRevealModal({ token, onClose }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback — select the text
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Token created">
      <div className="modal">
        <div className="modal-header">
          <h2>Token created</h2>
        </div>
        <div className="stack">
          <div
            className="card"
            style={{ background: 'var(--ok-wash)', border: '1px solid var(--ok)', display: 'flex', gap: 10, alignItems: 'center' }}
          >
            <Icon name="warning" size={16} style={{ flexShrink: 0, color: 'var(--warn)' }} />
            <span className="small"><strong>Save this — it won't be shown again.</strong></span>
          </div>
          <div
            className="card"
            style={{ fontFamily: 'var(--mono)', fontSize: '0.85rem', wordBreak: 'break-all' }}
            aria-label="API token value"
          >
            {token}
          </div>
          <div>
            <button type="button" className="btn btn-primary" onClick={copy}>
              <Icon name="copy" size={14} />
              {copied ? 'Copied!' : 'Copy token'}
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done — I've saved the token
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ApiAccess() {
  const [tokens, setTokens]       = useState([]);
  const [projects, setProjects]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [showNew, setShowNew]     = useState(false);
  const [revealToken, setRevealToken] = useState(null); // raw token string

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tokRes, projRes] = await Promise.all([
        api.get('/api/api-tokens'),
        api.get('/api/projects').catch(() => ({ projects: [] })),
      ]);
      setTokens(tokRes.tokens || []);
      setProjects(projRes.projects || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreated = (rawToken, info) => {
    setShowNew(false);
    setRevealToken(rawToken);
    setTokens((prev) => [info, ...prev]);
  };

  const revokeToken = async (tok) => {
    if (!confirm(`Revoke token "${tok.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/api-tokens/${tok.id}`);
      setTokens((prev) => prev.map((t) => (t.id === tok.id ? { ...t, active: false, revoked_at: new Date().toISOString() } : t)));
    } catch (e) {
      alert(e.message);
    }
  };

  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="page">
      <div className="page-head">
        <h1>API access</h1>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
            <Icon name="plus" size={14} />
            New token
          </button>
        </div>
      </div>
      <p className="muted">Personal API tokens for automating portal access. Tokens act as you.</p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error-note" role="alert">{error}</p>}

      {!loading && !error && tokens.length === 0 && (
        <div className="card">
          <p className="muted">No tokens yet. Create one to access the portal API.</p>
        </div>
      )}

      {!loading && tokens.length > 0 && (
        <table className="data-table" aria-label="API tokens">
          <thead>
            <tr>
              <th>Name</th>
              <th>Scope</th>
              <th>Project</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((tok) => (
              <tr key={tok.id} style={{ opacity: tok.active ? 1 : 0.5 }}>
                <td>
                  {tok.name}
                  {!tok.active && (
                    <span className="badge badge-neutral" style={{ marginLeft: 6 }}>
                      {tok.revoked_at ? 'revoked' : 'expired'}
                    </span>
                  )}
                </td>
                <td>
                  <span className={`badge ${tok.scope === 'write' ? 'badge-info' : 'badge-neutral'}`}>
                    {tok.scope}
                  </span>
                </td>
                <td className="muted">{tok.project_id ? projectName(tok.project_id) : '—'}</td>
                <td className="muted">{formatRelative(tok.created_at)}</td>
                <td className="muted">{tok.last_used_at ? formatRelative(tok.last_used_at) : '—'}</td>
                <td className="muted">{formatDate(tok.expires_at)}</td>
                <td>
                  {tok.active && (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => revokeToken(tok)}
                      aria-label={`Revoke ${tok.name}`}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showNew && (
        <NewTokenModal
          projects={projects}
          onClose={() => setShowNew(false)}
          onCreated={handleCreated}
        />
      )}

      {revealToken && (
        <TokenRevealModal
          token={revealToken}
          onClose={() => setRevealToken(null)}
        />
      )}
    </div>
  );
}

export default ApiAccess;
