import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { go, href } from '../lib/router.js';
import { plural } from '../lib/util.js';
import { Badge, Button, Empty, ErrorNote, Field, Modal, PageHeader, Spinner } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';

export function Projects() {
  const { projects, reloadProjects } = useApp();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  if (!projects) return <div className="pad"><Spinner /></div>;
  const visible = projects.filter((p) => showArchived || !p.archived);
  return (
    <div className="page">
      <PageHeader
        title="Projects"
        sub="Each project keeps its own documents, repositories, agents, skills and runs."
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New project</Button>}
      />
      {projects.length === 0 ? (
        <Empty icon="projects" title="No projects yet" action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Create your first project</Button>}>
          Start with a project, then upload its FSD and TSD and connect its repositories.
        </Empty>
      ) : (
        <>
          <div className="project-grid">
            {visible.map((p) => (
              <a key={p.id} href={href(p.id, 'knowledge')} className="project-card">
                <div className="project-card-head">
                  <h2>{p.name}</h2>
                  {p.archived ? <Badge tone="muted">Archived</Badge> : null}
                  {p.open_questions ? <Badge tone="warn">{plural(p.open_questions, 'team question')}</Badge> : null}
                </div>
                <p className="muted clamp-2">{p.description || 'No description'}</p>
                <dl className="project-stats">
                  <div><dt>Documents</dt><dd>{p.docs}</dd></div>
                  <div><dt>Repositories</dt><dd>{p.repos}</dd></div>
                  <div><dt>Members</dt><dd>{p.members}</dd></div>
                  <div><dt>Your access</dt><dd>{p.access}</dd></div>
                </dl>
              </a>
            ))}
          </div>
          {projects.some((p) => p.archived) ? (
            <Button variant="ghost" size="sm" onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? 'Hide archived projects' : 'Show archived projects'}
            </Button>
          ) : null}
        </>
      )}
      {creating ? (
        <CreateProject
          onClose={() => setCreating(false)}
          onCreated={async (p) => {
            await reloadProjects();
            go(p.id, 'knowledge');
          }}
        />
      ) : null}
    </div>
  );
}

function CreateProject({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.post('/api/projects', { name, description });
      await onCreated(project);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={!name.trim()}>
            Create project
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="stack">
        <Field label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Refund service" required />}</Field>
        <Field label="What is it about?" hint="Agents read this first, so a sentence or two of context helps.">
          {(id) => <textarea id={id} className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Backend for card refunds, used by customer support." />}
        </Field>
        <ErrorNote error={error} />
        <p className="muted small">
          <Icon name="lock" size={13} /> Only you can see the project until you add members.
        </p>
      </form>
    </Modal>
  );
}
