import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { go } from '../lib/router.js';
import { money } from '../lib/util.js';
import { Badge, Button, ErrorNote, Field, IconButton, PageHeader, useUi } from '../components/ui.jsx';
import { useAction } from '../lib/useAsync.js';

const ROLE_SUGGESTIONS = ['Business analyst', 'Solution architect', 'Backend developer', 'Frontend developer', 'QA engineer', 'Reviewer', 'Technical writer', 'Product owner', 'Stakeholder'];

export function ProjectSettings() {
  const { project, members, counts, monthUsd, isOwner, reload } = useProject();
  const { reloadProjects, user } = useApp();
  const { toast, confirm } = useUi();
  const [form, setForm] = useState({ name: project.name, description: project.description, notes: project.notes });
  useEffect(() => setForm({ name: project.name, description: project.description, notes: project.notes }), [project]);
  const save = useAction();
  const add = useAction();
  const [member, setMember] = useState({ email: '', access: 'editor', role: '' });
  const [users, setUsers] = useState([]);
  useEffect(() => {
    api.get('/api/users').then((r) => setUsers(r.users)).catch(() => undefined);
  }, []);

  const dirty = form.name !== project.name || form.description !== project.description || form.notes !== project.notes;

  return (
    <div className="page">
      <PageHeader title="Project and team" sub="Details agents read in CLAUDE.md, and who can do what." />
      <div className="two-col">
        <section className="panel">
          <h2>Details</h2>
          <div className="stack">
            <Field label="Name">{(id) => <input id={id} className="input" value={form.name} disabled={!isOwner} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Description">{(id) => <textarea id={id} className="input" rows={3} value={form.description} disabled={!isOwner} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <Field label="Project notes for agents" hint="Conventions, constraints and links. Added to CLAUDE.md, which every agent reads first.">
              {(id) => <textarea id={id} className="input mono" rows={8} value={form.notes} disabled={!isOwner} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="- Use the refunds table, never payments directly&#10;- Amounts are in minor units (cents)" />}
            </Field>
            <ErrorNote error={save.error} />
            {isOwner ? (
              <div className="row">
                <Button
                  variant="primary"
                  disabled={!dirty}
                  busy={save.busy}
                  onClick={() =>
                    save.run(async () => {
                      await api.patch(`/api/projects/${project.id}`, form);
                      await reload();
                      await reloadProjects();
                      toast('Project saved');
                    })
                  }
                >
                  Save changes
                </Button>
              </div>
            ) : (
              <p className="muted small">Only project owners can change these.</p>
            )}
          </div>
          <dl className="kv">
            <div><dt>Documents</dt><dd>{counts.docs}</dd></div>
            <div><dt>Repositories</dt><dd>{counts.repos}</dd></div>
            <div><dt>Runs</dt><dd>{counts.runs}</dd></div>
            <div><dt>Spend this month</dt><dd>{money(monthUsd, 2)}</dd></div>
          </dl>
        </section>

        <section className="panel">
          <h2>Members</h2>
          <p className="muted small">Viewers read documents, take quizzes and answer agent questions. Editors also run agents, upload and approve. Owners manage members.</p>
          <ul className="member-list">
            {members.map((m) => (
              <li key={m.id}>
                <div>
                  <strong>{m.name}</strong>
                  <span className="muted small"> {m.email}</span>
                  {m.role ? <div className="small">{m.role}</div> : null}
                </div>
                {isOwner ? (
                  <div className="row tight">
                    <select
                      className="input input-sm"
                      aria-label={`Access for ${m.name}`}
                      value={m.access}
                      onChange={async (e) => {
                        try {
                          await api.patch(`/api/projects/${project.id}/members/${m.id}`, { access: e.target.value });
                          reload();
                        } catch (err) {
                          toast(err.message, 'danger');
                        }
                      }}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </select>
                    <IconButton
                      icon="x"
                      label={`Remove ${m.name}`}
                      onClick={async () => {
                        if (!(await confirm({ title: 'Remove member', message: `Remove ${m.name} from ${project.name}?`, confirmLabel: 'Remove', danger: true }))) return;
                        try {
                          await api.del(`/api/projects/${project.id}/members/${m.id}`);
                          reload();
                        } catch (err) {
                          toast(err.message, 'danger');
                        }
                      }}
                    />
                  </div>
                ) : (
                  <Badge tone="muted">{m.access}</Badge>
                )}
              </li>
            ))}
          </ul>
          {isOwner ? (
            <form
              className="stack add-member"
              onSubmit={(e) => {
                e.preventDefault();
                add.run(async () => {
                  await api.post(`/api/projects/${project.id}/members`, member);
                  setMember({ email: '', access: 'editor', role: '' });
                  reload();
                  toast('Member added');
                });
              }}
            >
              <h3>Add a member</h3>
              <Field label="Email">
                {(id) => (
                  <>
                    <input id={id} className="input" type="email" list="user-emails" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} required />
                    <datalist id="user-emails">
                      {users.filter((u) => !members.some((m) => m.id === u.id)).map((u) => (
                        <option key={u.id} value={u.email}>{u.name}</option>
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
              <div className="row">
                <Field label="Access">
                  {(id) => (
                    <select id={id} className="input" value={member.access} onChange={(e) => setMember({ ...member, access: e.target.value })}>
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </select>
                  )}
                </Field>
                <Field label="Role in the project">
                  {(id) => (
                    <>
                      <input id={id} className="input" list="role-names" value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value })} placeholder="Backend developer" />
                      <datalist id="role-names">{ROLE_SUGGESTIONS.map((r) => <option key={r} value={r} />)}</datalist>
                    </>
                  )}
                </Field>
              </div>
              <ErrorNote error={add.error} />
              <div className="row">
                <Button type="submit" variant="primary" busy={add.busy}>
                  Add member
                </Button>
              </div>
              {user.is_admin ? <p className="muted small">People need an account first. Create one in Settings › Users.</p> : null}
            </form>
          ) : null}
        </section>
      </div>

      {isOwner ? (
        <section className="panel danger-zone">
          <h2>Archive or delete</h2>
          <div className="row">
            <Button
              onClick={async () => {
                await api.patch(`/api/projects/${project.id}`, { archived: !project.archived });
                await reload();
                await reloadProjects();
                toast(project.archived ? 'Project restored' : 'Project archived');
              }}
            >
              {project.archived ? 'Restore project' : 'Archive project'}
            </Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                const typed = await confirm({
                  title: 'Delete project',
                  message: 'The project folder moves to the trash folder on the server. Runs, documents and learning content are removed from the portal.',
                  typeToConfirm: project.name,
                  confirmLabel: 'Delete project',
                  danger: true,
                });
                if (!typed) return;
                try {
                  await api.del(`/api/projects/${project.id}`, { confirm: typed });
                  await reloadProjects();
                  go(null, 'projects');
                } catch (err) {
                  toast(err.message, 'danger');
                }
              }}
            >
              Delete project
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
