import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { PageHeader, SectionHead } from '../components/PageHeader.jsx';
import { SetupChecklist } from '../components/SetupChecklist.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function greeting(name) {
  const hour = new Date().getHours();
  const time = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const first = (name || '').split(/[\s@]+/)[0] || 'there';
  return `Good ${time}, ${first} 👋`;
}

// ── New project modal ─────────────────────────────────────────────────────────

function NewProjectModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/api/projects', { name: name.trim(), description: description.trim() });
      onCreated(r.project);
    } catch (err) {
      setError(err.message || 'Failed to create project');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
      <div className="modal">
        <div className="modal-header">
          <h2 id="new-project-title">New project</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={submit} className="stack">
          <div className="field">
            <label htmlFor="np-name">Name <span aria-hidden="true">*</span></label>
            <input
              id="np-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              maxLength={120}
              placeholder="e.g. Refund service"
            />
          </div>
          <div className="field">
            <label htmlFor="np-desc">Description</label>
            <textarea
              id="np-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Brief description of the project"
            />
          </div>
          {error && <div className="error-note" role="alert">{error}</div>}
          <div className="row gap-sm">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create project'}
            </button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Project card ──────────────────────────────────────────────────────────────

function ProjectCard({ project, currentUserId, isAdmin, onArchive, requestConfirm, toast }) {
  const isOwner = isAdmin || project.members?.some?.(
    (m) => m.user_id === currentUserId && m.role === 'owner',
  );

  const handleClick = (e) => {
    // Avoid navigating when clicking archive button
    if (e.target.closest('.btn-archive')) return;
    navigate(`/p/${project.id}/sessions`);
  };

  const handleArchive = async (e) => {
    e.stopPropagation();
    if (!await requestConfirm(`Archive "${project.name}"? It will be hidden from the list.`, 'Archive', 'danger')) return;
    try {
      await api.delete(`/api/projects/${project.id}`);
      onArchive(project.id);
    } catch (err) {
      toast(err.message || 'Failed to archive project', 'error');
    }
  };

  return (
    <div
      className="card project-card"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/p/${project.id}/sessions`)}
      aria-label={`Open project ${project.name}`}
    >
      <div className="project-card-header">
        <h3 className="project-card-name">{project.name}</h3>
        {isOwner && (
          <button
            type="button"
            className="btn-icon btn-archive"
            onClick={handleArchive}
            aria-label={`Archive ${project.name}`}
            title="Archive project"
          >
            ✕
          </button>
        )}
      </div>
      {project.description && (
        <p className="project-card-desc muted small">{project.description}</p>
      )}
      <div className="project-card-meta muted small">
        <span>{project.member_count ?? 0} member{project.member_count !== 1 ? 's' : ''}</span>
        <span>·</span>
        <span>Created {formatDate(project.created_at)}</span>
      </div>
    </div>
  );
}

// ── Projects page ─────────────────────────────────────────────────────────────

/**
 * @param {{ user: import('../App.jsx').User, onProjectsChange: () => void }} props
 */
export function Projects({ user, onProjectsChange }) {
  const [projects, setProjects] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get('/api/projects');
      setProjects(r.projects || []);
    } catch (err) {
      setError(err.message || 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreated = (project) => {
    setShowModal(false);
    setProjects((prev) => [project, ...(prev || [])]);
    onProjectsChange?.();
    navigate(`/p/${project.id}/sessions`);
  };

  const handleArchive = (id) => {
    setProjects((prev) => (prev || []).filter((p) => p.id !== id));
    onProjectsChange?.();
  };

  const isEmpty = !loading && !error && projects?.length === 0;
  const hasList = !loading && projects && projects.length > 0;

  return (
    <div className="page">
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      {/* ── Greeting header ─────────────────────────────── */}
      <div className="page-greeting" style={{ marginBottom: 4 }}>
        <p className="greeting-title">{greeting(user?.name || user?.email)}</p>
        <p className="greeting-subtitle">Here's what's happening across your projects.</p>
      </div>

      {!loading && !error && projects && (
        <SetupChecklist project={projects[0] || null} onNewProject={() => setShowModal(true)} />
      )}

      {/* ── KPI row ─────────────────────────────────────── */}
      {hasList && (
        <div className="kpi-row" style={{ marginBottom: 8 }}>
          <div className="kpi-card">
            <div className="kpi-icon-tile">
              <Icon name="projects" size={18} />
            </div>
            <div className="kpi-label">Projects</div>
            <div className="kpi-value">{projects.length}</div>
            <div className="kpi-delta muted">Active workspaces</div>
          </div>
        </div>
      )}

      {/* ── Page header ─────────────────────────────────── */}
      <PageHeader title="Projects" description="Each project has its own repositories, sessions, knowledge and members.">
        {/* Primary action shown only when there are projects */}
        {hasList && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowModal(true)}
          >
            <Icon name="plus" size={14} />
            New project
          </button>
        )}
      </PageHeader>

      {loading && (
        <div className="spinner-wrap" aria-label="Loading projects">
          <div className="spinner" />
        </div>
      )}

      {error && (
        <div className="error-note" role="alert">{error}</div>
      )}

      {/* Empty state — exactly ONE primary action button */}
      {isEmpty && (
        <div className="empty-state empty-state-hero">
          <div className="empty-state-icon" aria-hidden="true">
            <Icon name="projects" size={48} />
          </div>
          <p className="empty-state-title">No projects yet</p>
          <p className="empty-state-body">Projects keep your sessions, knowledge base, and team settings together. Create one to get started.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowModal(true)}
          >
            + New project
          </button>
        </div>
      )}

      {hasList && (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              currentUserId={user.id}
              isAdmin={Boolean(user.is_admin)}
              onArchive={handleArchive}
              requestConfirm={requestConfirm}
              toast={toast}
            />
          ))}
        </div>
      )}

      {showModal && (
        <NewProjectModal
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

export default Projects;
