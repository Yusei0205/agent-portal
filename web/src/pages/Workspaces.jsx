import { useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { useLoad } from '../lib/useAsync.js';
import { href } from '../lib/router.js';
import { timeAgo } from '../lib/util.js';
import { Badge, Button, Empty, ErrorNote, Field, Modal, PageHeader, Spinner, useUi } from '../components/ui.jsx';
import { RepoRows } from './sessions/NewSessionRepos.jsx';
import { IntegrationPicker } from './Integrations.jsx';

/** Workspaces: named sets of this project's repositories to start sessions over. */
export function Workspaces() {
  const { project, canEdit } = useProject();
  const list = useLoad(() => api.get(`/api/projects/${project.id}/workspaces`), [project.id]);
  useProjectEvents(['workspace.updated', 'repo.updated', 'repo.deleted'], () => list.reload(true));
  const [editing, setEditing] = useState(null); // null | 'new' | workspace
  const items = list.data?.workspaces || [];
  return (
    <div className="page">
      <PageHeader
        title="Workspaces"
        sub="Named sets of this project's repositories, each with the branch work starts from. Pick one when you start a session; changing a workspace affects new sessions only."
        actions={canEdit ? <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New workspace</Button> : null}
      />
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : !items.length ? (
        <Empty icon="repos" title="No workspaces yet" action={canEdit ? <Button variant="primary" onClick={() => setEditing('new')}>Create a workspace</Button> : null}>
          Group the repositories a kind of work usually needs, for example the backend and the admin frontend, so a session can start over all of them at once.
        </Empty>
      ) : (
        <div className="conn-grid">
          {items.map((w) => (
            <WorkspaceCard key={w.id} w={w} canEdit={canEdit} onEdit={() => setEditing(w)} reload={() => list.reload(true)} />
          ))}
        </div>
      )}
      {editing ? <WorkspaceForm workspace={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => list.reload(true)} /> : null}
    </div>
  );
}

function WorkspaceCard({ w, canEdit, onEdit, reload }) {
  const { project } = useProject();
  const { toast, confirm } = useUi();
  const remove = async () => {
    if (!(await confirm({ title: 'Delete workspace', message: `Delete "${w.name}"? Sessions started from it keep their repositories.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/workspaces/${w.id}`);
      reload();
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  return (
    <article className="panel conn-card">
      <header className="conn-head">
        <h3>{w.name}</h3>
        <span className="muted small">
          {w.repos.length} repo{w.repos.length === 1 ? '' : 's'}
        </span>
      </header>
      {w.description ? <p className="muted small">{w.description}</p> : null}
      <ul className="plain-list ws-repo-list">
        {w.repos.map((r) => (
          <li key={r.repoId} className="row tight wrap">
            <strong>{r.name}</strong>
            <code className="small">{r.branch || r.defaultBranch || 'default branch'}</code>
            {r.status !== 'ready' ? <Badge status={r.status === 'missing' ? 'failed' : r.status}>{r.status === 'missing' ? 'removed' : undefined}</Badge> : null}
          </li>
        ))}
        {!w.repos.length ? <li className="muted small">No repositories: sessions work with the project documents only.</li> : null}
      </ul>
      {w.integrations.length ? (
        <p className="small">
          {w.integrations.length} integration{w.integrations.length === 1 ? '' : 's'} attached
        </p>
      ) : null}
      <p className="muted small">
        {w.sessions} session{w.sessions === 1 ? '' : 's'} started from it · updated {timeAgo(w.updated_at)}
        {w.updated_by ? ` by ${w.updated_by}` : ''}
      </p>
      <div className="row tight wrap">
        <a className="btn btn-sm btn-primary" href={`${href(project.id, 'sessions', 'new')}?workspaceId=${encodeURIComponent(w.id)}`}>
          Start a session
        </a>
        {canEdit ? (
          <>
            <Button size="sm" icon="edit" onClick={onEdit}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={remove}>
              Delete
            </Button>
          </>
        ) : null}
      </div>
    </article>
  );
}

function WorkspaceForm({ workspace, onClose, onSaved }) {
  const { project } = useProject();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const ready = (repos.data?.repos || []).filter((r) => r.status === 'ready');
  const [name, setName] = useState(workspace?.name ?? '');
  const [description, setDescription] = useState(workspace?.description ?? '');
  const [rows, setRows] = useState(() => (workspace?.repos || []).map((r) => ({ repoId: r.repoId, branch: r.branch })));
  const [integrations, setIntegrations] = useState(workspace?.integrations ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, description, integrations, repos: rows.filter((r) => r.repoId).map(({ repoId, branch }) => ({ repoId, branch: branch || undefined })) };
      if (workspace) await api.put(`/api/workspaces/${workspace.id}`, body);
      else await api.post(`/api/projects/${project.id}/workspaces`, body);
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={workspace ? `Edit “${workspace.name}”` : 'New workspace'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={save}>
            {workspace ? 'Save changes' : 'Create workspace'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">A workspace is a list of repositories. Each session clones its own copy of every repository here, side by side, on its own branch.</p>
        <Field label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Backend and admin portal" autoFocus />}</Field>
        <Field label="Description (optional)">{(id) => <input id={id} className="input" value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        {repos.loading && !repos.data ? <Spinner /> : <RepoRows rows={rows} setRows={setRows} ready={ready} session />}
        <fieldset className="repo-rows">
          <legend className="field-label">Integrations</legend>
          <p className="muted small">MCP tools every session of this workspace gets. Only team integrations can be attached here.</p>
          <IntegrationPicker value={integrations} onChange={setIntegrations} teamOnly />
        </fieldset>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
