import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, hueFor, timeAgo } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { Badge, Button, Empty, ErrorNote, Field, PageHeader, Segmented, Spinner, Tabs, Toggle, useUi } from '../components/ui.jsx';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function Builder({ route }) {
  const { project } = useProject();
  const tab = ['agents', 'skills', 'library'].includes(route.rest[0]) ? route.rest[0] : 'roles';
  return (
    <div className="page wide">
      <PageHeader title="Agents and skills" sub="Role agents the main agent can delegate to, and skills that teach them how this project works. Stored in the project’s .claude folder." />
      <Tabs
        value={tab}
        tabs={[
          { value: 'roles', label: 'Roles', href: href(project.id, 'builder') },
          { value: 'agents', label: 'Agents', href: href(project.id, 'builder', 'agents') },
          { value: 'skills', label: 'Skills', href: href(project.id, 'builder', 'skills') },
          { value: 'library', label: 'Shared library', href: href(project.id, 'builder', 'library') },
        ]}
      />
      {tab === 'roles' ? <Roles /> : tab === 'agents' ? <Agents selected={route.rest[1]} /> : tab === 'skills' ? <Skills selected={route.rest[1]} /> : <Library />}
    </div>
  );
}

/* ---------------- Roles ---------------- */

function Roles() {
  const { project, canEdit, members } = useProject();
  const { toast, confirm } = useUi();
  const templates = useLoad(() => api.get('/api/roles'), []);
  const applied = useLoad(() => api.get(`/api/projects/${project.id}/roles`), [project.id]);
  useProjectEvents(['builder.updated'], () => applied.reload(true));
  const [busy, setBusy] = useState(null);
  const state = new Map((applied.data?.applied || []).map((a) => [a.role_key, a]));
  const people = members.filter((m) => m.role);

  const act = async (key, fn, msg) => {
    setBusy(key);
    try {
      await fn();
      toast(msg);
      applied.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(null);
    }
  };

  if (!templates.data) return <Spinner />;
  return (
    <div className="stack-lg">
      <p className="muted">
        Adding a role writes one agent and its starter skills into this project. The main agent delegates to a role when a task matches it. Edit them afterwards on the Agents and Skills tabs.
      </p>
      <div className="role-grid">
        {templates.data.roles.map((t) => {
          const a = state.get(t.key);
          const staff = people.filter((m) => m.role.toLowerCase().includes(t.title.toLowerCase().split(' ')[0]));
          return (
            <article key={t.key} className={cx('role-card', a && 'is-added', a && !a.enabled && 'is-off')} style={{ '--role-h': hueFor(t.agent.name) }}>
              <header>
                <h2>{t.title}</h2>
                {a ? <Badge tone={a.enabled ? 'ok' : 'muted'}>{a.enabled ? 'In use' : 'Turned off'}</Badge> : null}
              </header>
              <p>{t.summary}</p>
              <dl className="role-facts">
                <div><dt>Model</dt><dd>{t.agent.model}</dd></div>
                <div><dt>Tools</dt><dd>{t.agent.tools.join(', ')}</dd></div>
                <div><dt>Skills</dt><dd>{t.skills.map((s) => s.name).join(', ')}</dd></div>
                {staff.length ? <div><dt>People</dt><dd>{staff.map((s) => s.name).join(', ')}</dd></div> : null}
              </dl>
              {canEdit ? (
                <div className="row tight wrap">
                  {!a ? (
                    <Button variant="primary" size="sm" icon="plus" busy={busy === t.key} onClick={() => act(t.key, () => api.post(`/api/projects/${project.id}/roles/${t.key}/apply`), `${t.title} added`)}>
                      Add to project
                    </Button>
                  ) : (
                    <>
                      <Toggle
                        checked={Boolean(a.enabled)}
                        label="Available to agents"
                        onChange={(on) => act(t.key, () => api.post(`/api/projects/${project.id}/roles/${t.key}/enabled`, { enabled: on }), on ? `${t.title} turned on` : `${t.title} turned off`)}
                      />
                      <a className="btn btn-ghost btn-sm" href={href(project.id, 'builder', 'agents', t.agent.name)}>
                        Edit agent
                      </a>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          if (!(await confirm({ title: 'Reset role', message: `Overwrite ${t.agent.name} and its skills with the original template? Your edits to them are lost (they stay in the project’s git history).`, confirmLabel: 'Reset' }))) return;
                          act(t.key, () => api.post(`/api/projects/${project.id}/roles/${t.key}/apply`), `${t.title} reset`);
                        }}
                      >
                        Reset
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        onClick={async () => {
                          if (!(await confirm({ title: 'Remove role', message: `Remove ${t.agent.name} and its skills from this project?`, confirmLabel: 'Remove', danger: true }))) return;
                          act(t.key, () => api.del(`/api/projects/${project.id}/roles/${t.key}`), `${t.title} removed`);
                        }}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Agents ---------------- */

function useBuilderData() {
  const { project } = useProject();
  const agents = useLoad(() => api.get(`/api/projects/${project.id}/agents`), [project.id]);
  const skills = useLoad(() => api.get(`/api/projects/${project.id}/skills`), [project.id]);
  const tools = useLoad(() => api.get('/api/tools'), []);
  useProjectEvents(['builder.updated'], () => {
    agents.reload(true);
    skills.reload(true);
  });
  return { agents, skills, tools };
}

function ItemList({ items, selected, kind, onNew, canEdit, projectId }) {
  return (
    <aside className="item-list">
      {canEdit ? (
        <Button icon="plus" size="sm" onClick={onNew}>
          New {kind === 'agents' ? 'agent' : 'skill'}
        </Button>
      ) : null}
      <ul>
        {items.map((a) => (
          <li key={a.name}>
            <a href={href(projectId, 'builder', kind, a.name)} className={cx('item', selected === a.name && 'is-active', !a.enabled && 'is-off')} style={{ '--role-h': hueFor(a.name) }}>
              <span className="item-swatch" aria-hidden="true" />
              <span className="item-name">{a.name}</span>
              {a.role ? <span className="muted small">role</span> : null}
              {!a.enabled ? <span className="muted small">off</span> : null}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Agents({ selected }) {
  const { project, canEdit } = useProject();
  const { agents, skills, tools } = useBuilderData();
  if (!agents.data || !tools.data || !skills.data) return <Spinner />;
  const list = agents.data.agents;
  const current = selected === 'new' ? null : list.find((a) => a.name === selected) || (selected ? undefined : list[0]);
  return (
    <div className="builder-layout">
      <ItemList items={list} selected={current?.name ?? selected} kind="agents" onNew={() => go(project.id, 'builder', 'agents', 'new')} canEdit={canEdit} projectId={project.id} />
      <div className="builder-main">
        {current === undefined && selected && selected !== 'new' ? (
          <Empty title="Agent not found" />
        ) : !list.length && selected !== 'new' ? (
          <Empty icon="builder" title="No agents yet" action={canEdit ? <a className="btn btn-primary" href={href(project.id, 'builder')}>Add a role</a> : null}>
            Start from a role template, or create an agent from scratch.
          </Empty>
        ) : (
          <AgentEditor key={current?.name || 'new'} agent={current} skills={skills.data.skills} tools={tools.data} />
        )}
      </div>
    </div>
  );
}

function AgentEditor({ agent, skills, tools }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const isNew = !agent;
  const [form, setForm] = useState(() => ({
    name: agent?.name || '',
    description: agent?.description || '',
    model: agent?.model || 'inherit',
    tools: agent?.tools || ['Read', 'Grep', 'Glob'],
    skills: agent?.skills || [],
    prompt: agent?.prompt || 'You are the … for this project.\n\nHow to work:\n1. Read docs/decisions.md and search docs/md/ first.\n2. …\n\nCite every requirement you rely on.',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const nameOk = NAME_RE.test(form.name);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/projects/${project.id}/agents/${form.name}`, form);
      toast(isNew ? 'Agent created' : 'Agent saved');
      if (isNew) go(project.id, 'builder', 'agents', form.name);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="stack-lg">
      <div className="editor-head">
        <h2>{isNew ? 'New agent' : agent.name}</h2>
        {!isNew ? (
          <div className="row tight">
            {agent.role ? <Badge tone="muted">from role template</Badge> : null}
            <Toggle
              checked={agent.enabled}
              disabled={!canEdit}
              label="Available to agents"
              onChange={async (on) => {
                await api.post(`/api/projects/${project.id}/agents/${agent.name}/enabled`, { enabled: on });
                toast(on ? 'Agent turned on' : 'Agent turned off');
              }}
            />
          </div>
        ) : null}
      </div>
      <fieldset className="stack" disabled={!canEdit}>
        {isNew ? (
          <Field label="Name" hint="Lowercase letters, digits and hyphens, like payments-expert." error={form.name && !nameOk ? 'Use lowercase letters, digits and hyphens only' : null}>
            {(id) => <input id={id} className="input mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.trim() })} />}
          </Field>
        ) : null}
        <Field label="When should the main agent use it?" hint="This description decides delegation. Be specific about the tasks it handles.">
          {(id) => <textarea id={id} className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}
        </Field>
        <Field label="Model">
          {(id) => (
            <select id={id} className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              <option value="inherit">Same as the main agent</option>
              <option value="haiku">Haiku (cheapest, good for reading and checklists)</option>
              <option value="sonnet">Sonnet (balanced)</option>
              <option value="opus">Opus (hardest tasks)</option>
            </select>
          )}
        </Field>
        <div className="field">
          <span className="field-label">Tools it may use</span>
          <div className="check-grid">
            {tools.tools.map((t) => (
              <label key={t} className="check">
                <input type="checkbox" checked={form.tools.includes(t)} onChange={() => setForm({ ...form, tools: toggle(form.tools, t) })} />
                <code>{t}</code>
              </label>
            ))}
          </div>
          <p className="field-hint">Leave Edit, Write and Bash off for read-only roles. Edits still need approval unless a run auto-accepts them.</p>
        </div>
        <div className="field">
          <span className="field-label">Skills to load</span>
          {skills.length ? (
            <div className="check-grid">
              {skills.map((s) => (
                <label key={s.name} className="check" title={s.description}>
                  <input type="checkbox" checked={form.skills.includes(s.name)} onChange={() => setForm({ ...form, skills: toggle(form.skills, s.name) })} />
                  <span>{s.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="muted small">No skills in this project yet.</p>
          )}
        </div>
        <Field label="Instructions" hint="The agent’s system prompt. Markdown.">
          {(id) => <textarea id={id} className="input mono" rows={16} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />}
        </Field>
      </fieldset>
      <ErrorNote error={error} />
      {canEdit ? (
        <div className="row wrap">
          <Button variant="primary" busy={busy} onClick={save} disabled={!nameOk || !form.description.trim() || !form.prompt.trim()}>
            {isNew ? 'Create agent' : 'Save agent'}
          </Button>
          {!isNew ? (
            <>
              <Button
                onClick={async () => {
                  await api.post(`/api/projects/${project.id}/library/save`, { type: 'agents', name: agent.name });
                  toast('Saved to the shared library');
                }}
              >
                Save to shared library
              </Button>
              <Button
                variant="danger-ghost"
                icon="trash"
                onClick={async () => {
                  if (!(await confirm({ title: 'Delete agent', message: `Delete ${agent.name}? It stays in the project’s git history.`, confirmLabel: 'Delete', danger: true }))) return;
                  await api.del(`/api/projects/${project.id}/agents/${agent.name}`);
                  go(project.id, 'builder', 'agents');
                }}
              >
                Delete
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {!isNew && canEdit && agent.enabled ? <TestPanel type="agent" name={agent.name} /> : null}
    </div>
  );
}

function TestPanel({ type, name }) {
  const { project } = useProject();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <section className="panel test-panel">
      <h3>Try it</h3>
      <p className="muted small">Starts a plan-only run on Haiku that must use this {type}. Nothing in the project changes.</p>
      <div className="row">
        <input className="input" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={type === 'agent' ? 'Summarise the refund rules' : 'Apply this skill to the refunds section'} aria-label="Test task" />
        <Button
          icon="play"
          busy={busy}
          disabled={!prompt.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const { run } = await api.post(`/api/projects/${project.id}/builder/test`, { type, name, prompt });
              go(project.id, 'runs', run.id);
            } catch (e) {
              setError(e);
              setBusy(false);
            }
          }}
        >
          Run test
        </Button>
      </div>
      <ErrorNote error={error} />
    </section>
  );
}

/* ---------------- Skills ---------------- */

function Skills({ selected }) {
  const { project, canEdit } = useProject();
  const { skills, tools } = useBuilderData();
  if (!skills.data || !tools.data) return <Spinner />;
  const list = skills.data.skills;
  const current = selected === 'new' ? null : list.find((s) => s.name === selected) || (selected ? undefined : list[0]);
  return (
    <div className="builder-layout">
      <ItemList items={list} selected={current?.name ?? selected} kind="skills" onNew={() => go(project.id, 'builder', 'skills', 'new')} canEdit={canEdit} projectId={project.id} />
      <div className="builder-main">
        {current === undefined && selected && selected !== 'new' ? <Empty title="Skill not found" /> : <SkillEditor key={current?.name || 'new'} skill={current} tools={tools.data} />}
      </div>
    </div>
  );
}

function SkillEditor({ skill, tools }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const isNew = !skill;
  const builtIn = skill?.name === 'project-docs';
  const [form, setForm] = useState(() => ({
    name: skill?.name || '',
    description: skill?.description || '',
    body: skill?.body || '# Skill title\n\nWhat to do, step by step.\n\n1. …\n2. …\n',
    allowedTools: skill?.allowedTools || [],
  }));
  const [view, setView] = useState('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const nameOk = NAME_RE.test(form.name);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/projects/${project.id}/skills/${form.name}`, form);
      toast(isNew ? 'Skill created' : 'Skill saved');
      if (isNew) go(project.id, 'builder', 'skills', form.name);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-lg">
      <div className="editor-head">
        <h2>{isNew ? 'New skill' : skill.name}</h2>
        {!isNew ? (
          <div className="row tight">
            {builtIn ? <Badge tone="muted">built in</Badge> : null}
            {skill.role ? <Badge tone="muted">from role template</Badge> : null}
            {!builtIn ? (
              <Toggle
                checked={skill.enabled}
                disabled={!canEdit}
                label="Available to agents"
                onChange={async (on) => {
                  await api.post(`/api/projects/${project.id}/skills/${skill.name}/enabled`, { enabled: on });
                  toast(on ? 'Skill turned on' : 'Skill turned off');
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <fieldset className="stack" disabled={!canEdit}>
        {isNew ? (
          <Field label="Name" hint="Lowercase letters, digits and hyphens." error={form.name && !nameOk ? 'Use lowercase letters, digits and hyphens only' : null}>
            {(id) => <input id={id} className="input mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.trim() })} />}
          </Field>
        ) : null}
        <Field label="When should agents use it?" hint="Agents load a skill when this description matches their task. Start with “Use when…”.">
          {(id) => <textarea id={id} className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}
        </Field>
        <div className="field">
          <div className="row between">
            <span className="field-label">Instructions (SKILL.md)</span>
            <Segmented size="sm" value={view} onChange={setView} label="View" options={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]} />
          </div>
          {view === 'edit' ? (
            <textarea className="input mono" rows={18} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} aria-label="Skill instructions" />
          ) : (
            <div className="panel md-preview">
              <Markdown text={form.body} />
            </div>
          )}
        </div>
        <details>
          <summary className="small">Limit tools while this skill is active (optional)</summary>
          <div className="check-grid">
            {tools.tools.map((t) => (
              <label key={t} className="check">
                <input
                  type="checkbox"
                  checked={form.allowedTools.includes(t)}
                  onChange={() => setForm({ ...form, allowedTools: form.allowedTools.includes(t) ? form.allowedTools.filter((x) => x !== t) : [...form.allowedTools, t] })}
                />
                <code>{t}</code>
              </label>
            ))}
          </div>
        </details>
      </fieldset>
      <ErrorNote error={error} />
      {canEdit ? (
        <div className="row wrap">
          <Button variant="primary" busy={busy} onClick={save} disabled={!nameOk || !form.description.trim()}>
            {isNew ? 'Create skill' : 'Save skill'}
          </Button>
          {!isNew ? (
            <Button
              onClick={async () => {
                await api.post(`/api/projects/${project.id}/library/save`, { type: 'skills', name: skill.name });
                toast('Saved to the shared library');
              }}
            >
              Save to shared library
            </Button>
          ) : null}
          {!isNew && !builtIn ? (
            <Button
              variant="danger-ghost"
              icon="trash"
              onClick={async () => {
                if (!(await confirm({ title: 'Delete skill', message: `Delete ${skill.name} and its files?`, confirmLabel: 'Delete', danger: true }))) return;
                await api.del(`/api/projects/${project.id}/skills/${skill.name}`);
                go(project.id, 'builder', 'skills');
              }}
            >
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}
      {!isNew ? <SkillFiles skill={skill} /> : null}
      {!isNew && canEdit && skill.enabled ? <TestPanel type="skill" name={skill.name} /> : null}
    </div>
  );
}

function SkillFiles({ skill }) {
  const { project, canEdit } = useProject();
  const { toast } = useUi();
  const [open, setOpen] = useState(null);
  const [content, setContent] = useState('');
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState(null);
  const base = `/api/projects/${project.id}/skills/${skill.name}/file`;
  useEffect(() => {
    if (!open || open.isNew) return;
    api.get(`${base}?path=${encodeURIComponent(open.path)}`).then((r) => setContent(r.content), setError);
  }, [open, base]);
  return (
    <section className="panel">
      <h3>Extra files</h3>
      <p className="muted small">Reference material, templates or scripts the skill can point to. Agents read them only when needed.</p>
      <ul className="file-list">
        {skill.files.map((f) => (
          <li key={f}>
            <button type="button" className={cx('linkish', open?.path === f && 'is-active')} onClick={() => setOpen({ path: f })}>
              <Icon name="file" size={15} /> {f}
            </button>
          </li>
        ))}
        {!skill.files.length ? <li className="muted small">None yet.</li> : null}
      </ul>
      {canEdit ? (
        <div className="row">
          <input className="input mono" placeholder="reference.md or scripts/check.py" value={newPath} onChange={(e) => setNewPath(e.target.value)} aria-label="New file path" />
          <Button
            size="sm"
            icon="plus"
            disabled={!newPath.trim()}
            onClick={() => {
              setOpen({ path: newPath.trim(), isNew: true });
              setContent('');
              setNewPath('');
            }}
          >
            Add file
          </Button>
        </div>
      ) : null}
      {open ? (
        <div className="stack">
          <textarea className="input mono" rows={12} value={content} onChange={(e) => setContent(e.target.value)} aria-label={open.path} disabled={!canEdit} />
          <ErrorNote error={error} />
          {canEdit ? (
            <div className="row">
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  try {
                    await api.put(base, { path: open.path, content });
                    toast(`Saved ${open.path}`);
                    setOpen({ path: open.path });
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                Save file
              </Button>
              {!open.isNew ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.del(`${base}?path=${encodeURIComponent(open.path)}`);
                    setOpen(null);
                    toast('File deleted');
                  }}
                >
                  Delete file
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                Close
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ---------------- Library ---------------- */

function Library() {
  const { project, canEdit } = useProject();
  const { user } = useApp();
  const { toast, confirm } = useUi();
  const lib = useLoad(() => api.get('/api/library'), []);
  const [kind, setKind] = useState('agents');
  if (!lib.data) return <Spinner />;
  const items = lib.data[kind];
  return (
    <div className="stack-lg">
      <div className="row between">
        <p className="muted">Agents and skills saved from any project. Install them here to reuse what worked elsewhere.</p>
        <Segmented value={kind} onChange={setKind} label="Type" options={[{ value: 'agents', label: `Agents (${lib.data.agents.length})` }, { value: 'skills', label: `Skills (${lib.data.skills.length})` }]} />
      </div>
      {!items.length ? (
        <Empty icon="builder" title="Nothing saved yet">Use “Save to shared library” on an agent or skill.</Empty>
      ) : (
        <ul className="lib-list">
          {items.map((x) => (
            <li key={x.name} className="panel">
              <div>
                <strong>{x.name}</strong>
                <p className="muted small">{x.description}</p>
              </div>
              <div className="row tight">
                {canEdit ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        await api.post(`/api/projects/${project.id}/library/install`, { type: kind, name: x.name });
                        toast(`Installed ${x.name}`);
                      } catch (e) {
                        if (/already has/.test(e.message) && (await confirm({ title: 'Replace?', message: `${e.message}. Replace it with the library version?`, confirmLabel: 'Replace' }))) {
                          await api.post(`/api/projects/${project.id}/library/install`, { type: kind, name: x.name, overwrite: true });
                          toast(`Replaced ${x.name}`);
                        } else if (!/already has/.test(e.message)) toast(e.message, 'danger');
                      }
                    }}
                  >
                    Install in this project
                  </Button>
                ) : null}
                {user.is_admin ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    onClick={async () => {
                      if (!(await confirm({ title: 'Remove from library', message: `Remove ${x.name} from the shared library? Projects that installed it keep their copy.`, confirmLabel: 'Remove', danger: true }))) return;
                      await api.del(`/api/library/${kind}/${x.name}`);
                      lib.reload(true);
                    }}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
