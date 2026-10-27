import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';

const PROVIDERS = [
  { value: 'github',      label: 'GitHub' },
  { value: 'bitbucket',   label: 'Bitbucket' },
  { value: 'codecommit',  label: 'CodeCommit' },
  { value: 'git',         label: 'Generic Git' },
];

const SCOPES = [
  { value: 'personal', label: 'Personal' },
  { value: 'shared',   label: 'Shared' },
];

const PROVIDER_BADGE_CLASS = {
  github:     'badge badge-info',
  bitbucket:  'badge badge-neutral',
  codecommit: 'badge badge-neutral',
  git:        'badge badge-neutral',
};

// ── Modal ─────────────────────────────────────────────────────────────────────

function ConnectionModal({ connection, onClose, onSave }) {
  const [name, setName]       = useState(connection?.name ?? '');
  const [provider, setProvider] = useState(connection?.provider ?? 'github');
  const [scope, setScope]     = useState(connection?.scope ?? 'personal');
  const [token, setToken]     = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);

    const credentials = token
      ? { token }
      : username && password
        ? { username, password }
        : undefined;

    try {
      if (connection) {
        const r = await api.put(`/api/git-connections/${connection.id}`, {
          name: name.trim(),
          scope,
          ...(credentials ? { credentials } : {}),
        });
        onSave(r.connection);
      } else {
        const r = await api.post('/api/git-connections', {
          name: name.trim(),
          provider,
          scope,
          ...(credentials ? { credentials } : {}),
        });
        onSave(r.connection);
      }
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={connection ? 'Edit connection' : 'New connection'}>
      <div className="modal">
        <div className="modal-header">
          <h2>{connection ? 'Edit connection' : 'New Git connection'}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="stack">
            <div className="field">
              <label htmlFor="conn-name">Name</label>
              <input
                id="conn-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. My GitHub"
                autoFocus
              />
            </div>
            {!connection && (
              <div className="field">
                <label htmlFor="conn-provider">Provider</label>
                <select id="conn-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="conn-scope">Scope</label>
              <select id="conn-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
                {SCOPES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="conn-token">Access token (optional)</label>
              <input
                id="conn-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Personal access token"
                autoComplete="off"
              />
            </div>
            {!token && (
              <>
                <div className="field">
                  <label htmlFor="conn-username">Username (optional)</label>
                  <input
                    id="conn-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor="conn-password">Password (optional)</label>
                  <input
                    id="conn-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
              </>
            )}
            {error && <p className="error-note" role="alert">{error}</p>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : connection ? 'Save changes' : 'Create connection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function Connections() {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [modal, setModal]             = useState(null); // null | 'new' | { connection }
  const [testResults, setTestResults] = useState({}); // id → { ok, error }
  const [testing, setTesting]         = useState({}); // id → bool

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/api/git-connections');
      setConnections(r.connections || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const testConnection = async (conn) => {
    const url = prompt('Enter a repository URL to test:', '');
    if (!url) return;
    setTesting((t) => ({ ...t, [conn.id]: true }));
    setTestResults((r) => ({ ...r, [conn.id]: null }));
    try {
      const result = await api.post(`/api/git-connections/${conn.id}/test`, { url });
      setTestResults((r) => ({ ...r, [conn.id]: result }));
    } catch (e) {
      setTestResults((r) => ({ ...r, [conn.id]: { ok: false, error: e.message } }));
    } finally {
      setTesting((t) => ({ ...t, [conn.id]: false }));
    }
  };

  const deleteConnection = async (conn) => {
    if (!confirm(`Delete connection "${conn.name}"?`)) return;
    try {
      await api.delete(`/api/git-connections/${conn.id}`);
      setConnections((prev) => prev.filter((c) => c.id !== conn.id));
    } catch (e) {
      alert(e.message);
    }
  };

  const handleSave = (saved) => {
    setConnections((prev) => {
      const idx = prev.findIndex((c) => c.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
    setModal(null);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Git connections</h1>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setModal('new')}
          >
            <Icon name="plus" size={14} />
            New connection
          </button>
        </div>
      </div>
      <p className="muted">Saved Git credentials shared across projects.</p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error-note" role="alert">{error}</p>}

      {!loading && !error && connections.length === 0 && (
        <div className="card">
          <p className="muted">No connections yet. Add one to use authenticated repositories.</p>
        </div>
      )}

      {!loading && connections.length > 0 && (
        <table className="data-table" aria-label="Git connections">
          <thead>
            <tr>
              <th>Name</th>
              <th>Provider</th>
              <th>Scope</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {connections.map((conn) => (
              <tr key={conn.id}>
                <td>{conn.name}</td>
                <td>
                  <span className={PROVIDER_BADGE_CLASS[conn.provider] || 'badge badge-neutral'}>
                    {conn.provider}
                  </span>
                </td>
                <td>
                  <span className={`badge ${conn.scope === 'shared' ? 'badge-info' : 'badge-neutral'}`}>
                    {conn.scope}
                  </span>
                </td>
                <td className="muted">{formatRelative(conn.created_at)}</td>
                <td>
                  <div className="row">
                    {testResults[conn.id] && (
                      <span
                        className={testResults[conn.id].ok ? 'ok small' : 'danger small'}
                        role="status"
                      >
                        {testResults[conn.id].ok ? '✓ OK' : `✗ ${testResults[conn.id].error || 'Failed'}`}
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => testConnection(conn)}
                      disabled={testing[conn.id]}
                      aria-label={`Test ${conn.name}`}
                    >
                      {testing[conn.id] ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      title="Edit"
                      aria-label={`Edit ${conn.name}`}
                      onClick={() => setModal({ connection: conn })}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      title="Delete"
                      aria-label={`Delete ${conn.name}`}
                      onClick={() => deleteConnection(conn)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal && (
        <ConnectionModal
          connection={modal === 'new' ? null : modal.connection}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

export default Connections;
