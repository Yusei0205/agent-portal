import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { useSort } from '../lib/useSort.jsx';
import { HubContext, PageHeader, SectionHead } from '../components/PageHeader.jsx';
import { navigate } from '../lib/router.js';
import { ProjectRepositories } from './hub/ProjectHub.jsx';
import { ProjectAws } from './ProjectAws.jsx';

// ── Modal ─────────────────────────────────────────────────────────────────────

function WorkspaceModal({ projectId, workspace, repos, onClose, onSave }) {
  const [name, setName] = useState(workspace?.name ?? '');
  const [selectedRepos, setSelectedRepos] = useState(workspace?.repo_ids ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Session defaults
  const [defaultEngine, setDefaultEngine] = useState(workspace?.default_engine ?? '');
  const [defaultAgent, setDefaultAgent] = useState(workspace?.default_agent ?? '');
  const [defaultModel, setDefaultModel] = useState(workspace?.default_model ?? '');
  const [defaultTrustTools, setDefaultTrustTools] = useState(Boolean(workspace?.default_trust_tools));
  const [agentList, setAgentList] = useState(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [modelList, setModelList] = useState([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState(null);

  // Load agents when default engine changes
  useEffect(() => {
    if (!defaultEngine) { setAgentList(null); return; }
    setAgentLoading(true);
    api.get(`/api/user-config/agents?engine=${encodeURIComponent(defaultEngine)}`)
      .then((r) => setAgentList(r.agents || []))
      .catch(() => setAgentList([]))
      .finally(() => setAgentLoading(false));
  }, [defaultEngine]);

  // Load models when default engine changes
  const loadModels = useCallback(async (forceRefresh = false) => {
    if (!defaultEngine) { setModelList([]); setModelError(null); return; }
    setModelLoading(true);
    setModelError(null);
    try {
      const qs = forceRefresh ? '?refresh=1' : '';
      const data = await api.get(`/api/engines/${encodeURIComponent(defaultEngine)}/models${qs}`);
      setModelList(data.models || []);
      if (data.error) setModelError(data.error);
    } catch (e) {
      setModelList([]);
      setModelError(e.message || 'Failed to load models');
    } finally {
      setModelLoading(false);
    }
  }, [defaultEngine]);

  useEffect(() => { loadModels(false); }, [loadModels]);

  // Changing engine clears agent and model that no longer fit
  const handleEngineChange = (eng) => {
    setDefaultEngine(eng);
    setDefaultAgent('');
    setDefaultModel('');
  };

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
          defaultEngine,
          defaultAgent,
          defaultModel,
          defaultTrustTools,
        });
        onSave(r.workspace);
      } else {
        const r = await api.post(`/api/projects/${projectId}/workspaces`, {
          name: name.trim(),
          repoIds: selectedRepos,
          defaultEngine,
          defaultAgent,
          defaultModel,
          defaultTrustTools,
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
                  <a href={`#/p/${projectId}/workspaces/repositories`} onClick={onClose}>
                    Add repositories
                  </a>{' '}
                  to include them in workspaces.
                </p>
              </div>
            )}
            {/* Session defaults */}
            <div className="field">
              <label style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: 4, display: 'block' }}>
                Session defaults
              </label>
              <p className="field-hint" style={{ marginBottom: 8 }}>
                Pre-fill engine, agent, and model when this workspace is selected in new sessions.
              </p>
              <div className="stack" style={{ gap: 8 }}>
                <div className="field">
                  <label htmlFor="ws-def-engine">Default engine</label>
                  <select
                    id="ws-def-engine"
                    value={defaultEngine}
                    onChange={(e) => handleEngineChange(e.target.value)}
                  >
                    <option value="">None</option>
                    <option value="kiro">Kiro</option>
                    <option value="codex">Codex</option>
                    <option value="claude-code">Claude Code</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="ws-def-agent">Default agent</label>
                  {agentLoading ? (
                    <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading agents…" />
                  ) : (
                    <select
                      id="ws-def-agent"
                      value={defaultAgent}
                      onChange={(e) => setDefaultAgent(e.target.value)}
                      disabled={!defaultEngine}
                    >
                      <option value="">None</option>
                      {(agentList || []).map((a) => (
                        <option key={a.name} value={a.name}>
                          {a.name}{a.description ? ` — ${a.description.slice(0, 50)}` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="ws-def-model">Default model</label>
                  {modelLoading ? (
                    <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading models…" />
                  ) : modelError ? (
                    <>
                      <input
                        id="ws-def-model"
                        type="text"
                        value={defaultModel}
                        onChange={(e) => setDefaultModel(e.target.value)}
                        placeholder="Enter model ID (e.g. claude-sonnet-4-5)"
                        disabled={!defaultEngine}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <p className="field-hint" style={{ color: 'var(--danger)', flex: 1, margin: 0 }}>
                          {modelError}
                        </p>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => loadModels(true)}
                          aria-label="Retry loading models"
                        >
                          Retry
                        </button>
                      </div>
                    </>
                  ) : (
                    <select
                      id="ws-def-model"
                      value={defaultModel}
                      onChange={(e) => setDefaultModel(e.target.value)}
                      disabled={!defaultEngine}
                    >
                      <option value="">Engine default</option>
                      {modelList.map((m) => (
                        <option key={m.id} value={m.id}>{m.label || m.id}</option>
                      ))}
                    </select>
                  )}
                </div>
                <label className="choice" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={defaultTrustTools}
                    onChange={(e) => setDefaultTrustTools(e.target.checked)}
                  />
                  <span>
                    <strong>Trust all tools by default</strong>{' '}
                    <span className="muted">New sessions start with Trust all tools ticked (can still be changed per session).</span>
                  </span>
                </label>
              </div>
            </div>
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

function WorkspacesList({ projectId }) {
  const [workspaces, setWorkspaces] = useState([]);
  const { sorted: sortedWorkspaces, sortProps } = useSort(workspaces, { name: (ws) => ws.name, repos: (ws) => (ws.repo_ids ?? []).length, created: (ws) => ws.created_at });
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
      <PageHeader title="Workspaces" description="Group repositories into named workspaces for agent runs.">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setModal('new')}
        >
          <Icon name="plus" size={14} />
          New workspace
        </button>
      </PageHeader>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error-note" role="alert">{error}</p>}

      {!loading && !error && repos.length === 0 && (
        <p className="muted" style={{ fontSize: '0.84rem' }}>
          This project has no repositories.{' '}
          <a href={`#/p/${projectId}/workspaces/repositories`}>Add repositories</a>{' '}
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
              <th {...sortProps('name')}>Name</th>
              <th {...sortProps('repos')}>Repositories</th>
              <th {...sortProps('created')}>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sortedWorkspaces.map((ws) => (
              <tr key={ws.id}>
                <td>
                  <div>{ws.name}</div>
                  {(ws.default_engine || ws.default_agent || ws.default_model) && (
                    <div className="muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>
                      {[
                        ws.default_engine === 'codex' ? 'Codex' : ws.default_engine === 'kiro' ? 'Kiro' : ws.default_engine === 'claude-code' ? 'Claude Code' : ws.default_engine,
                        ws.default_agent,
                        ws.default_model,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </td>
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

const WORKSPACE_TABS = [
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'aws', label: 'AWS' },
];

/** The project's work areas: named workspaces, and the repositories they are made of. */
export function Workspaces({ projectId, tab }) {
  const current = WORKSPACE_TABS.find((t) => t.id === tab) ?? WORKSPACE_TABS[0];
  return (
    <div className="page connect-hub">
      <PageHeader title="Workspaces" description="What agents work on in this project: its repositories, named groups of them, and the AWS account they use.">
        <a className="btn btn-sm" href={`#/p/${projectId}/setup/overview`}>Project setup</a>
      </PageHeader>
      <div className="tab-bar" role="tablist" aria-label="Workspaces sections">
        {WORKSPACE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={current.id === t.id}
            className={`tab-btn${current.id === t.id ? ' is-active' : ''}`}
            onClick={() => navigate(`/p/${projectId}/workspaces${t.id === 'workspaces' ? '' : `/${t.id}`}`)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="connect-panel" role="tabpanel">
        <HubContext.Provider value>
          {current.id === 'repositories' ? <ProjectRepositories projectId={projectId} /> : current.id === 'aws' ? <ProjectAws projectId={projectId} /> : <WorkspacesList projectId={projectId} />}
        </HubContext.Provider>
      </div>
    </div>
  );
}

export default Workspaces;
