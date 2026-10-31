import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';

// ── Modal ─────────────────────────────────────────────────────────────────────

function WorkspaceModal({ projectId, workspace, repos, onClose, onSave }) {
  const [name, setName] = useState(workspace?.name ?? '');
  const [selectedRepos, setSelectedRepos] = useState(workspace?.repo_ids ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const toggleRepo = (id) => {
    setSelectedRepos((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      if (workspace) {
        const r = await api.put(`/api/projects/${projectId}/workspaces/${workspace.id}`, {
          name: name.trim(),
          repoIds: selectedRepos,
        });
        onSave(r.workspace);
      } else {
        const r = await api.post(`/api/projects/${projectId}/workspaces`, {
          name: name.trim(),
          repoIds: selectedRepos,
        });
        onSave(r.workspace);
      }
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={workspace ? 'Edit workspace' : 'New workspace'}>
      <div className="modal">
        <div className="modal-header">
          <h2>{workspace ? 'Edit workspace' : 'New workspace'}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="stack">
            <div className="field">
              <label htmlFor="ws-name">Name</label>
              <input
                id="ws-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Backend services"
                autoFocus
              />
            </div>
            {repos.length > 0 ? (
              <div className="field">
                <label>Repositories</label>
                <div className="stack" style={{ maxHeight: 240, overflowY: 'auto' }}>
                  {repos.map((repo) => (
                    <label key={repo.id} className={`choice${selectedRepos.includes(repo.id) ? ' is-checked' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selectedRepos.includes(repo.id)}
                        onChange={() => toggleRepo(repo.id)}
                      />
                      <span>{repo.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <div className="field">
                <label>Repositories</label>
                <p className="field-hint">
                  This project has no repositories yet.{' '}
                  <a href={`#/p/${projectId}/setup/repositories`} onClick={onClose}>
                    Add repositories
                  </a>{' '}
                  to include them in workspaces.
                </p>
              </div>
            )}
            {error && <p className="error-note" role="alert">{error}</p>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : workspace ? 'Save changes' : 'Create workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function Workspaces({ projectId }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // null | 'new' | { workspace }
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wsRes, repoRes] = await Promise.all([
        api.get(`/api/projects/${projectId}/workspaces`),
        api.get(`/api/projects/${projectId}/repos`),
      ]);
      setWorkspaces(wsRes.workspaces || []);
      setRepos(repoRes.repos || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Reload data when the page becomes visible again — this covers:
  // ① navigating away and back (hashchange fires, but also covers pageshow/focus)
  // ② same-URL navigation in automated tests where hashchange may not fire
  // ③ user returning to the tab from another window
  useEffect(() => {
    const refresh = () => load();
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('popstate', refresh);
    const onHash = () => {
      if (window.location.hash.includes('/workspaces')) load();
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener('popstate', refresh);
      window.removeEventListener('hashchange', onHash);
    };
  }, [load]);

  const deleteWorkspace = async (ws) => {
    if (!await requestConfirm(`Delete workspace "${ws.name}"?`, 'Delete', 'danger')) return;
    try {
      await api.delete(`/api/projects/${projectId}/workspaces/${ws.id}`);
      setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const handleSave = (saved) => {
    setWorkspaces((prev) => {
      const idx = prev.findIndex((w) => w.id === saved.id);
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
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div className="page-head">
        <h1>Workspaces</h1>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setModal('new')}
          >
            <Icon name="plus" size={14} />
            New workspace
          </button>
        </div>
      </div>
      <p className="muted">Group repositories into named workspaces for agent runs.</p>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error-note" role="alert">{error}</p>}

      {!loading && !error && repos.length === 0 && (
        <p className="muted" style={{ fontSize: '0.84rem' }}>
          This project has no repositories.{' '}
          <a href={`#/p/${projectId}/setup/repositories`}>Add repositories</a>{' '}
          to include them in workspaces.
        </p>
      )}

      {!loading && !error && workspaces.length === 0 && (
        <div className="card">
          <p className="muted">No workspaces yet.</p>
        </div>
      )}

      {!loading && workspaces.length > 0 && (
        <table className="data-table" aria-label="Workspaces">
          <thead>
            <tr>
              <th>Name</th>
              <th>Repositories</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((ws) => (
              <tr key={ws.id}>
                <td>{ws.name}</td>
                <td>
                  <span className="badge">
                    {(ws.repo_ids || []).length} repo{(ws.repo_ids || []).length !== 1 ? 's' : ''}
                  </span>
                </td>
                <td className="muted">{formatRelative(ws.created_at)}</td>
                <td>
                  <div className="row">
                    <button
                      type="button"
                      className="btn-icon"
                      title="Edit"
                      aria-label={`Edit ${ws.name}`}
                      onClick={() => setModal({ workspace: ws })}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      title="Delete"
                      aria-label={`Delete ${ws.name}`}
                      onClick={() => deleteWorkspace(ws)}
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
        <WorkspaceModal
          projectId={projectId}
          workspace={modal === 'new' ? null : modal.workspace}
          repos={repos}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

export default Workspaces;
