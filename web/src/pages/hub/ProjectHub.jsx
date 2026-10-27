import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api.js';

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CLASS = {
  new: 'badge-neutral',
  cloning: 'badge-info',
  ready: 'badge-success',
  error: 'badge-error',
};

function StatusBadge({ status }) {
  const cls = STATUS_CLASS[status] || 'badge-neutral';
  return <span className={`badge ${cls}`}>{status}</span>;
}

// ── Add repo modal ────────────────────────────────────────────────────────────

function AddRepoModal({ projectId, onClose, onAdded }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [provider, setProvider] = useState('github');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (!url.trim()) { setError('URL is required'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${projectId}/repos`, {
        name: name.trim(),
        url: url.trim(),
        provider,
      });
      onAdded(r.repo);
    } catch (err) {
      setError(err.message || 'Failed to add repository');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="add-repo-title">
      <div className="modal">
        <div className="modal-header">
          <h2 id="add-repo-title">Add repository</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="ar-name">Name <span aria-hidden="true">*</span></label>
            <input
              id="ar-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              placeholder="e.g. my-service"
            />
          </div>
          <div className="field">
            <label htmlFor="ar-url">URL <span aria-hidden="true">*</span></label>
            <input
              id="ar-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              placeholder="https://github.com/owner/repo"
            />
          </div>
          <div className="field">
            <label htmlFor="ar-provider">Provider</label>
            <select id="ar-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="github">GitHub</option>
              <option value="codecommit">AWS CodeCommit</option>
              <option value="bitbucket">Bitbucket</option>
              <option value="git">Other Git</option>
            </select>
          </div>
          {error && <div className="error-note" role="alert">{error}</div>}
          <div className="row gap-sm">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add repository'}
            </button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add member modal ──────────────────────────────────────────────────────────

function AddMemberModal({ projectId, onClose, onAdded }) {
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/users').then((r) => setUsers(r.users || [])).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!userId) { setError('Please select a user'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/projects/${projectId}/members`, { userId, role });
      onAdded();
    } catch (err) {
      setError(err.message || 'Failed to add member');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="add-member-title">
      <div className="modal">
        <div className="modal-header">
          <h2 id="add-member-title">Add member</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="am-user">User <span aria-hidden="true">*</span></label>
            <select id="am-user" value={userId} onChange={(e) => setUserId(e.target.value)} required>
              <option value="">— select a user —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="am-role">Role</label>
            <select id="am-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="owner">Owner</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          {error && <div className="error-note" role="alert">{error}</div>}
          <div className="row gap-sm">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add member'}
            </button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab({ projectId, repos, members }) {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    api.get('/api/auth/state').then((s) => {
      setSettings({ provider: s.provider || 'demo' });
    }).catch(() => {});
  }, []);

  const hasProvider = settings?.provider && settings.provider !== 'demo';
  const hasRepo = repos?.some((r) => r.status === 'ready');
  const hasMember = (members?.length ?? 0) > 1; // more than just the owner

  const checks = [
    { label: 'Model provider configured', ok: hasProvider },
    { label: 'At least one repository cloned and ready', ok: hasRepo },
    { label: 'At least one team member added', ok: hasMember },
  ];

  return (
    <div className="stack">
      <h2>Readiness checklist</h2>
      <ul className="checklist">
        {checks.map((c) => (
          <li key={c.label} className={`checklist-item ${c.ok ? 'ok' : 'pending'}`}>
            <span className="checklist-icon" aria-hidden="true">{c.ok ? '✓' : '○'}</span>
            <span>{c.label}</span>
            {!c.ok && <span className="muted small"> — not yet</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Repositories tab ──────────────────────────────────────────────────────────

function RepositoriesTab({ projectId, repos, setRepos }) {
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [branches, setBranches] = useState({});

  const sync = async (repoId) => {
    try {
      await api.post(`/api/projects/${projectId}/repos/${repoId}/sync`);
      setRepos((prev) =>
        prev.map((r) => r.id === repoId ? { ...r, status: 'cloning' } : r),
      );
    } catch (err) {
      alert(err.message || 'Sync failed');
    }
  };

  const remove = async (repoId) => {
    if (!confirm('Remove this repository from the project?')) return;
    try {
      await api.delete(`/api/projects/${projectId}/repos/${repoId}`);
      setRepos((prev) => prev.filter((r) => r.id !== repoId));
    } catch (err) {
      alert(err.message || 'Failed to remove repository');
    }
  };

  const toggleBranches = async (repoId) => {
    setExpanded((prev) => ({ ...prev, [repoId]: !prev[repoId] }));
    if (!branches[repoId]) {
      try {
        const r = await api.get(`/api/projects/${projectId}/repos/${repoId}/branches`);
        setBranches((prev) => ({ ...prev, [repoId]: r.branches || [] }));
      } catch {
        setBranches((prev) => ({ ...prev, [repoId]: [] }));
      }
    }
  };

  return (
    <div className="stack">
      <div className="row-between">
        <h2>Repositories</h2>
        <button type="button" className="btn btn-primary" onClick={() => setShowModal(true)}>
          + Add repository
        </button>
      </div>

      {repos.length === 0 && (
        <p className="muted">No repositories yet. Add one to get started.</p>
      )}

      <div className="stack">
        {repos.map((repo) => (
          <div key={repo.id} className="card">
            <div className="row-between">
              <div>
                <strong>{repo.name}</strong>
                <span className="muted small" style={{ marginLeft: '0.5em' }}>{repo.provider}</span>
              </div>
              <div className="row gap-sm">
                <StatusBadge status={repo.status} />
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => sync(repo.id)}
                  disabled={repo.status === 'cloning'}
                >
                  {repo.status === 'cloning' ? 'Syncing…' : 'Sync'}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => toggleBranches(repo.id)}
                  aria-expanded={Boolean(expanded[repo.id])}
                >
                  {expanded[repo.id] ? 'Hide branches' : 'Branches'}
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => remove(repo.id)}
                  aria-label={`Remove ${repo.name}`}
                  title="Remove repository"
                >
                  ✕
                </button>
              </div>
            </div>
            <p className="muted small" style={{ marginTop: '0.25em' }}>{repo.url}</p>
            {repo.last_error && (
              <p className="error-note small" style={{ marginTop: '0.25em' }}>{repo.last_error}</p>
            )}
            {expanded[repo.id] && (
              <div style={{ marginTop: '0.5em' }}>
                {branches[repo.id]?.length ? (
                  <ul className="branch-list">
                    {branches[repo.id].map((b) => (
                      <li key={b} className="branch-item muted small">{b}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted small">No branches found (repo may not be cloned yet).</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {showModal && (
        <AddRepoModal
          projectId={projectId}
          onClose={() => setShowModal(false)}
          onAdded={(repo) => {
            setShowModal(false);
            setRepos((prev) => [...prev, repo]);
          }}
        />
      )}
    </div>
  );
}

// ── Team tab ──────────────────────────────────────────────────────────────────

function TeamTab({ projectId, members, setMembers, currentUserId, isAdmin }) {
  const [showModal, setShowModal] = useState(false);

  const changeRole = async (userId, role) => {
    try {
      await api.put(`/api/projects/${projectId}/members/${userId}`, { role });
      setMembers((prev) =>
        prev.map((m) => m.user_id === userId ? { ...m, role, access: role } : m),
      );
    } catch (err) {
      alert(err.message || 'Failed to change role');
    }
  };

  const removeMember = async (userId) => {
    if (!confirm('Remove this member from the project?')) return;
    try {
      await api.delete(`/api/projects/${projectId}/members/${userId}`);
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      alert(err.message || 'Failed to remove member');
    }
  };

  const reload = async () => {
    try {
      const r = await api.get(`/api/projects/${projectId}/members`);
      setMembers(r.members || []);
    } catch { /* best effort */ }
  };

  const ROLE_BADGE = { owner: 'badge-primary', editor: 'badge-info', viewer: 'badge-neutral' };

  return (
    <div className="stack">
      <div className="row-between">
        <h2>Team &amp; members</h2>
        <button type="button" className="btn btn-primary" onClick={() => setShowModal(true)}>
          + Add member
        </button>
      </div>

      {members.length === 0 && (
        <p className="muted">No members yet.</p>
      )}

      <div className="stack">
        {members.map((m) => {
          const canEdit = isAdmin || (
            members.some((x) => x.user_id === currentUserId && x.role === 'owner')
          );
          return (
            <div key={m.user_id} className="card row-between">
              <div>
                <strong>{m.name}</strong>
                <span className="muted small" style={{ marginLeft: '0.5em' }}>{m.email}</span>
              </div>
              <div className="row gap-sm">
                <span className={`badge ${ROLE_BADGE[m.role] || 'badge-neutral'}`}>{m.role}</span>
                {canEdit && (
                  <select
                    value={m.role}
                    onChange={(e) => changeRole(m.user_id, e.target.value)}
                    aria-label={`Change role for ${m.name}`}
                    className="select-inline"
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                )}
                {canEdit && m.user_id !== currentUserId && (
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => removeMember(m.user_id)}
                    aria-label={`Remove ${m.name}`}
                    title="Remove member"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showModal && (
        <AddMemberModal
          projectId={projectId}
          onClose={() => setShowModal(false)}
          onAdded={() => {
            setShowModal(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

// ── Permissions tab ───────────────────────────────────────────────────────────

function PermissionsTab({ projectId }) {
  const [groups, setGroups] = useState([]);
  const [currentGroupId, setCurrentGroupId] = useState(null);
  const [toolRules, setToolRules] = useState([]);
  const [busy, setBusy] = useState(false);
  const [newTool, setNewTool] = useState('');
  const [newAction, setNewAction] = useState('allow');

  useEffect(() => {
    api.get(`/api/projects/${projectId}/permissions`).then((r) => {
      setCurrentGroupId(r.rule_group_id || null);
      setToolRules(r.tool_rules || []);
    }).catch(() => {});
    api.get('/api/admin/permissions').then((r) => {
      // We only have built-in groups for now
      setGroups([{ id: 'standard', name: 'Standard' }, { id: 'core-safe', name: 'Core Safe' }]);
    }).catch(() => {});
  }, [projectId]);

  const saveGroupOverride = async (groupId) => {
    setBusy(true);
    try {
      await api.put(`/api/projects/${projectId}/permissions`, { ruleGroupId: groupId || null });
      setCurrentGroupId(groupId || null);
    } catch (err) {
      alert(err.message || 'Failed to save permission override');
    } finally {
      setBusy(false);
    }
  };

  const addToolRule = async () => {
    if (!newTool.trim()) return;
    try {
      const r = await api.post(`/api/projects/${projectId}/tool-rules`, {
        toolName: newTool.trim(),
        action: newAction,
        scope: 'always',
      });
      setToolRules((prev) => [...prev, r.rule]);
      setNewTool('');
    } catch (err) {
      alert(err.message || 'Failed to add tool rule');
    }
  };

  const removeToolRule = async (ruleId) => {
    try {
      await api.delete(`/api/projects/${projectId}/tool-rules/${ruleId}`);
      setToolRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch (err) {
      alert(err.message || 'Failed to remove tool rule');
    }
  };

  return (
    <div className="stack">
      <h2>Permissions</h2>

      <div className="field">
        <label htmlFor="perm-group">Rule group override</label>
        <select
          id="perm-group"
          value={currentGroupId || ''}
          onChange={(e) => saveGroupOverride(e.target.value)}
          disabled={busy}
        >
          <option value="">— use portal default —</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>

      <div>
        <h3>Project tool rules</h3>
        {toolRules.length === 0 && (
          <p className="muted small">No custom tool rules for this project.</p>
        )}
        <div className="stack">
          {toolRules.map((rule) => (
            <div key={rule.id} className="card row-between">
              <span className="small"><strong>{rule.tool_name}</strong> — {rule.action}</span>
              <button
                type="button"
                className="btn-icon"
                onClick={() => removeToolRule(rule.id)}
                aria-label={`Remove rule for ${rule.tool_name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="row gap-sm" style={{ marginTop: '1em' }}>
          <input
            type="text"
            value={newTool}
            onChange={(e) => setNewTool(e.target.value)}
            placeholder="Tool name (e.g. Bash)"
            aria-label="Tool name"
            style={{ flex: 1 }}
          />
          <select value={newAction} onChange={(e) => setNewAction(e.target.value)} aria-label="Action">
            <option value="allow">Allow</option>
            <option value="ask">Ask</option>
            <option value="block">Block</option>
          </select>
          <button type="button" className="btn" onClick={addToolRule}>Add</button>
        </div>
      </div>
    </div>
  );
}

// ── ProjectHub ────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'repositories', label: 'Repositories' },
  { id: 'team', label: 'Team & members' },
  { id: 'permissions', label: 'Permissions' },
];

/**
 * @param {{ projectId: string, user: object }} props
 */
export function ProjectHub({ projectId, user }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [project, setProject] = useState(null);
  const [members, setMembers] = useState([]);
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [projR, repoR] = await Promise.all([
        api.get(`/api/projects/${projectId}`),
        api.get(`/api/projects/${projectId}/repos`),
      ]);
      setProject(projR.project);
      setMembers(projR.members || []);
      setRepos(repoR.repos || []);
    } catch (err) {
      setError(err.message || 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="page">
        <div className="spinner-wrap"><div className="spinner" aria-label="Loading…" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="error-note" role="alert">{error}</div>
      </div>
    );
  }

  const isAdmin = Boolean(user?.is_admin);
  const currentUserId = user?.id;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{project?.name} — Setup</h1>
          {project?.description && (
            <p className="muted small">{project.description}</p>
          )}
        </div>
      </div>

      {/* Tab navigation */}
      <nav className="tab-nav" role="tablist" aria-label="Setup sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            aria-controls={`tabpanel-${t.id}`}
            className={`tab-btn${activeTab === t.id ? ' is-active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* Tab panels */}
      <div role="tabpanel" id={`tabpanel-${activeTab}`} className="tab-panel">
        {activeTab === 'overview' && (
          <OverviewTab projectId={projectId} repos={repos} members={members} />
        )}
        {activeTab === 'repositories' && (
          <RepositoriesTab projectId={projectId} repos={repos} setRepos={setRepos} />
        )}
        {activeTab === 'team' && (
          <TeamTab
            projectId={projectId}
            members={members}
            setMembers={setMembers}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
          />
        )}
        {activeTab === 'permissions' && (
          <PermissionsTab projectId={projectId} />
        )}
      </div>
    </div>
  );
}

export default ProjectHub;
