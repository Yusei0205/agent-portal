import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href, runHref, withQuery } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, hueFor, timeAgo } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { ImportModal } from '../components/ImportModal.jsx';
import { DraftPromptModal } from '../components/DraftPromptModal.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Modal, PageHeader, Segmented, Spinner, Tabs, Toggle, useUi } from '../components/ui.jsx';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function Builder({ route }) {
  const { project } = useProject();
  // Claude Code agents and skills live in .claude, Kiro's in .kiro: each engine reads only its own.
  const engine = route.rest[0] === 'kiro' ? 'kiro' : 'claude';
  const tab = ['agents', 'skills', 'library'].includes(route.rest[0]) ? route.rest[0] : 'roles';
  return (
    <div className="page wide">
      <PageHeader
        title="Agents and skills"
        sub={
          engine === 'kiro'
            ? 'Kiro agents in Kiro’s own format, with the skills and steering they load. Stored in the project’s .kiro folder; Kiro runs use them when there are any.'
            : 'Role agents the main agent can delegate to, and skills that teach them how this project works. Stored in the project’s .claude folder.'
        }
      />
      <Segmented
        value={engine}
        onChange={(v) => (v === 'kiro' ? go(project.id, 'builder', 'kiro') : go(project.id, 'builder'))}
        label="Engine"
        options={[
          { value: 'claude', label: 'Claude Code' },
          { value: 'kiro', label: 'Kiro' },
        ]}
      />
      {engine === 'kiro' ? (
        <KiroAgents selected={route.rest[1]} />
      ) : (
        <>
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
        </>
      )}
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
        Adding a role writes its agent (or, for a team, its lead and specialists) and its skills into this project. The main agent delegates to a role when a task matches it. Edit them afterwards on the Agents and Skills tabs.
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
                <div><dt>Tools</dt><dd>{t.agent.tools.map((x) => (x.startsWith('Agent(') ? 'Agent' : x)).join(', ')}</dd></div>
                {t.team?.length ? <div><dt>Team</dt><dd>{[t.agent.name, ...t.team.map((a) => a.name)].join(', ')}</dd></div> : null}
                {t.skills.length ? <div><dt>Skills</dt><dd>{t.skills.map((s) => s.name).join(', ')}</dd></div> : null}
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
                          if (!(await confirm({ title: 'Reset role', message: `Overwrite ${t.agent.name}${t.team?.length ? `, its ${t.team.length} team agents` : ''} and its skills with the original template? Your edits to them are lost (they stay in the project’s git history).`, confirmLabel: 'Reset' }))) return;
                          act(t.key, () => api.post(`/api/projects/${project.id}/roles/${t.key}/apply`), `${t.title} reset`);
                        }}
                      >
                        Reset
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        onClick={async () => {
                          if (!(await confirm({ title: 'Remove role', message: `Remove ${t.agent.name}${t.team?.length ? ` and its ${t.team.length} team agents` : ''} and its skills from this project?`, confirmLabel: 'Remove', danger: true }))) return;
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

function ItemList({ items, selected, kind, onNew, onImport, onDescribe, onCatalog, canEdit, projectId }) {
  return (
    <aside className="item-list">
      {onCatalog ? (
        <Button icon="builder" size="sm" variant={selected === 'catalog' ? 'primary' : 'default'} onClick={onCatalog}>
          Browse templates
        </Button>
      ) : null}
      {canEdit ? (
        <div className="stack" style={{ gap: '0.3rem' }}>
          <Button icon="plus" size="sm" onClick={onNew}>
            New {kind === 'agents' ? 'agent' : 'skill'}
          </Button>
          {onDescribe ? (
            <Button icon="question" size="sm" variant="ghost" onClick={onDescribe} title={`Describe ${kind === 'agents' ? 'an agent' : 'a skill'} in plain language`}>
              Describe…
            </Button>
          ) : null}
          {onImport ? (
            <Button icon="upload" size="sm" variant="ghost" onClick={onImport} aria-label="Import from .claude folder or zip">
              Import
            </Button>
          ) : null}
        </div>
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
  const [showImport, setShowImport] = useState(false);
  const [draftForm, setDraftForm] = useState(null); // prefilled form from draft
  if (!agents.data || !tools.data || !skills.data) return <Spinner />;
  const list = agents.data.agents;
  const current = selected === 'new' ? null : list.find((a) => a.name === selected) || (selected ? undefined : list[0]);

  function handleDraft(draft) {
    // Navigate to new agent view with a prefilled form
    setDraftForm(draft);
    go(project.id, 'builder', 'agents', 'new');
  }

  return (
    <div className="builder-layout">
      {showImport && (
        <ImportModal
          projectId={project.id}
          onClose={() => setShowImport(false)}
          onImported={() => { agents.reload(true); skills.reload(true); }}
        />
      )}
      <ItemList
        items={list}
        selected={current?.name ?? selected}
        kind="agents"
        onNew={() => { setDraftForm(null); go(project.id, 'builder', 'agents', 'new'); }}
        onImport={canEdit ? () => setShowImport(true) : null}
        onDescribe={canEdit ? () => setDraftForm('open-modal') : null}
        canEdit={canEdit}
        projectId={project.id}
      />
      <div className="builder-main">
        {draftForm === 'open-modal' && (
          <DraftPromptModal
            kind="agent"
            projectId={project.id}
            onClose={() => setDraftForm(null)}
            onDraft={handleDraft}
          />
        )}
        {current === undefined && selected && selected !== 'new' ? (
          <Empty title="Agent not found" />
        ) : !list.length && selected !== 'new' ? (
          <Empty icon="builder" title="No agents yet" action={
            canEdit ? (
              <div className="row tight wrap" style={{ justifyContent: 'center' }}>
                <a className="btn btn-primary" href={href(project.id, 'builder')}>Add a role</a>
                <Button icon="upload" onClick={() => setShowImport(true)}>Import</Button>
              </div>
            ) : null
          }>
            Start from a role template, create an agent from scratch, or import from a .claude folder.
          </Empty>
        ) : (
          <AgentEditor key={`${current?.name || 'new'}-${draftForm?.name || ''}`} agent={current} skills={skills.data.skills} tools={tools.data} draftForm={selected === 'new' && draftForm && draftForm !== 'open-modal' ? draftForm : null} />
        )}
      </div>
    </div>
  );
}

function AgentEditor({ agent, skills, tools, draftForm }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const isNew = !agent;
  const [form, setForm] = useState(() => {
    if (draftForm) {
      return {
        name: draftForm.name || '',
        description: draftForm.description || '',
        model: draftForm.model || 'inherit',
        tools: draftForm.tools || ['Read', 'Grep', 'Glob'],
        skills: draftForm.skills || [],
        prompt: draftForm.prompt || '',
      };
    }
    return {
      name: agent?.name || '',
      description: agent?.description || '',
      model: agent?.model || 'inherit',
      tools: agent?.tools || ['Read', 'Grep', 'Glob'],
      skills: agent?.skills || [],
      prompt: agent?.prompt || 'You are the … for this project.\n\nHow to work:\n1. Read docs/decisions.md and search docs/md/ first.\n2. …\n\nCite every requirement you rely on.',
    };
  });
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
      {draftForm && isNew && (
        <div className="note note-info" role="status">
          <Icon name="question" size={16} />
          <span>This form was pre-filled by the AI draft. Review every field before saving.</span>
        </div>
      )}
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
              window.location.hash = runHref(project.id, run.id);
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
  const [showImport, setShowImport] = useState(false);
  const [draftForm, setDraftForm] = useState(null);
  if (!skills.data || !tools.data) return <Spinner />;
  const list = skills.data.skills;
  const catalog = selected === 'catalog';
  const current = selected === 'new' || catalog ? null : list.find((s) => s.name === selected) || (selected ? undefined : list[0]);

  function handleDraft(draft) {
    setDraftForm(draft);
    go(project.id, 'builder', 'skills', 'new');
  }

  return (
    <div className="builder-layout">
      {showImport && (
        <ImportModal
          projectId={project.id}
          onClose={() => setShowImport(false)}
          onImported={() => skills.reload(true)}
        />
      )}
      <ItemList
        items={list}
        selected={current?.name ?? selected}
        kind="skills"
        onNew={() => { setDraftForm(null); go(project.id, 'builder', 'skills', 'new'); }}
        onImport={canEdit ? () => setShowImport(true) : null}
        onDescribe={canEdit ? () => setDraftForm('open-modal') : null}
        onCatalog={() => go(project.id, 'builder', 'skills', 'catalog')}
        canEdit={canEdit}
        projectId={project.id}
      />
      <div className="builder-main">
        {draftForm === 'open-modal' && (
          <DraftPromptModal
            kind="skill"
            projectId={project.id}
            onClose={() => setDraftForm(null)}
            onDraft={handleDraft}
          />
        )}
        {catalog ? (
          <SkillCatalog installed={new Set(list.map((s) => s.name))} />
        ) : current === undefined && selected && selected !== 'new' ? (
          <Empty title="Skill not found" />
        ) : !list.length && selected !== 'new' ? (
          <Empty icon="builder" title="No skills yet" action={
            canEdit ? (
              <div className="row tight wrap" style={{ justifyContent: 'center' }}>
                <Button icon="plus" variant="primary" onClick={() => go(project.id, 'builder', 'skills', 'new')}>New skill</Button>
                <Button icon="upload" onClick={() => setShowImport(true)}>Import</Button>
              </div>
            ) : null
          }>
            Create a skill from scratch, import from a .claude folder, browse the templates, or add a role on the Roles tab.
          </Empty>
        ) : (
          <SkillEditor key={`${current?.name || 'new'}-${draftForm?.name || ''}`} skill={current} tools={tools.data} draftForm={selected === 'new' && draftForm && draftForm !== 'open-modal' ? draftForm : null} />
        )}
      </div>
    </div>
  );
}

/** Every skill the role templates carry, installable on its own (without taking the whole role). */
function SkillCatalog({ installed }) {
  const { project, canEdit } = useProject();
  const { toast } = useUi();
  const templates = useLoad(() => api.get('/api/skill-templates'), []);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // skill name being previewed
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const togglePreview = async (name) => {
    if (open === name) return setOpen(null);
    setOpen(name);
    setPreview(null);
    try {
      setPreview((await api.get(`/api/skill-templates/${encodeURIComponent(name)}`)).skill);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  const add = async (name) => {
    setBusy(name);
    try {
      await api.post(`/api/projects/${project.id}/skill-templates/${encodeURIComponent(name)}/add`);
      toast(`${name} added to the project`);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(null);
    }
  };
  if (!templates.data) return <Spinner />;
  const all = templates.data.skills;
  const needle = q.trim().toLowerCase();
  const list = needle ? all.filter((s) => s.name.includes(needle) || s.description.toLowerCase().includes(needle) || s.roles.some((r) => r.title.toLowerCase().includes(needle))) : all;
  return (
    <div className="stack">
      <div className="stack" style={{ gap: '0.25rem' }}>
        <h2>Skill templates</h2>
        <p className="muted small">
          {all.length} skills come with the role templates. Add one here to use it on its own, or add its role on the Roles tab to get the role’s agents too. Skills already in this project show as Added.
        </p>
      </div>
      <input className="input input-md" type="search" placeholder="Search skills or roles" aria-label="Search skill templates" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="skill-catalog">
        {list.map((s) => {
          const has = installed.has(s.name);
          return (
            <article key={s.name} className="panel skill-card" style={{ '--role-h': hueFor(s.name) }}>
              <header>
                <h3 className="mono">{s.name}</h3>
                {has ? <Badge tone="ok">Added</Badge> : null}
              </header>
              <p className="small">{s.description}</p>
              <p className="muted small">Role{s.roles.length === 1 ? '' : 's'}: {s.roles.map((r) => r.title).join(', ')}</p>
              <div className="row tight wrap">
                <Button size="sm" variant="ghost" onClick={() => togglePreview(s.name)} aria-expanded={open === s.name}>
                  {open === s.name ? 'Hide preview' : 'Preview'}
                </Button>
                {canEdit ? (
                  <Button size="sm" variant="primary" icon="plus" disabled={has} busy={busy === s.name} onClick={() => add(s.name)}>
                    {has ? 'Already added' : 'Add to project'}
                  </Button>
                ) : null}
              </div>
              {open === s.name ? <div className="skill-preview">{preview ? <Markdown text={preview.body} /> : <Spinner small />}</div> : null}
            </article>
          );
        })}
        {!list.length ? <p className="muted small">No skill matches “{q}”.</p> : null}
      </div>
    </div>
  );
}

function SkillEditor({ skill, tools, draftForm }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const isNew = !skill;
  const builtIn = skill?.name === 'project-docs';
  const [form, setForm] = useState(() => {
    if (draftForm) {
      return {
        name: draftForm.name || '',
        description: draftForm.description || '',
        body: draftForm.body || '# Skill title\n\nWhat to do, step by step.\n\n1. …\n2. …\n',
        allowedTools: [],
      };
    }
    return {
      name: skill?.name || '',
      description: skill?.description || '',
      body: skill?.body || '# Skill title\n\nWhat to do, step by step.\n\n1. …\n2. …\n',
      allowedTools: skill?.allowedTools || [],
    };
  });
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
      {draftForm && isNew && (
        <div className="note note-info" role="status">
          <Icon name="question" size={16} />
          <span>This form was pre-filled by the AI draft. Review every field before saving.</span>
        </div>
      )}

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

/* ---------------- Kiro agents ---------------- */

/** Built-in Kiro tools offered as checkboxes; anything else in an agent's list is kept as it is. */
const KIRO_TOOLS = ['read', 'write', 'shell', 'grep', 'glob', 'web_fetch', 'web_search', 'knowledge', 'subagent'];

function KiroAgents({ selected }) {
  const { project, canEdit } = useProject();
  const data = useLoad(() => api.get(`/api/projects/${project.id}/kiro-agents`), [project.id]);
  useProjectEvents(['builder.updated'], () => data.reload(true));
  const [importing, setImporting] = useState(false);
  if (!data.data) return data.error ? <ErrorNote error={data.error} /> : <Spinner />;
  const list = data.data.agents;
  const current = selected === 'new' ? null : list.find((a) => a.name === selected) || (selected ? undefined : list[0]);
  return (
    <div className="builder-layout">
      {importing ? <KiroImport onClose={() => setImporting(false)} onDone={() => data.reload(true)} /> : null}
      <aside className="item-list">
        {canEdit ? (
          <div className="row tight wrap">
            <Button icon="plus" size="sm" onClick={() => go(project.id, 'builder', 'kiro', 'new')}>
              New agent
            </Button>
            <Button icon="upload" size="sm" variant="ghost" onClick={() => setImporting(true)}>
              Import
            </Button>
          </div>
        ) : null}
        <ul>
          {list.map((a) => (
            <li key={a.name}>
              <a href={href(project.id, 'builder', 'kiro', a.name)} className={cx('item', a.name === current?.name && 'is-active', !a.enabled && 'is-off')} style={{ '--role-h': hueFor(a.name) }}>
                <span className="item-swatch" aria-hidden="true" />
                <span className="item-name">{a.name}</span>
                {!a.enabled ? <Badge>off</Badge> : a.team.length ? <span className="muted small" title="Agents on its team">+{a.team.length}</span> : null}
              </a>
            </li>
          ))}
        </ul>
        <div className="stack" style={{ gap: '0.25rem' }}>
          <h3 className="small">Skills and steering</h3>
          <p className="muted small">
            {data.data.skills.filter((f) => f.endsWith('/SKILL.md')).length} skills, {data.data.steering.length} steering files in .kiro.{' '}
            <a href={withQuery(href(project.id, 'config'), { root: '.kiro' })}>Edit in Configuration</a>
          </p>
        </div>
      </aside>
      <div className="builder-main">
        {current === undefined && selected ? (
          <Empty title="Kiro agent not found" />
        ) : !list.length && selected !== 'new' ? (
          <Empty
            icon="builder"
            title="No Kiro agents yet"
            action={
              canEdit ? (
                <div className="row tight">
                  <Button icon="upload" onClick={() => setImporting(true)}>
                    Import Kiro agents
                  </Button>
                  <Button icon="plus" variant="ghost" onClick={() => go(project.id, 'builder', 'kiro', 'new')}>
                    New agent
                  </Button>
                </div>
              ) : null
            }
          >
            Kiro runs use the project’s Claude Code agents until it has Kiro agents of its own. Import yours from ~/.kiro, a folder or a zip, or write one here.
          </Empty>
        ) : (
          <KiroAgentEditor key={current?.name || 'new'} agent={current} all={list} />
        )}
      </div>
    </div>
  );
}

/** The form's fields written back into the agent's JSON, leaving everything else in it as it was. */
function kiroJsonFrom(form, base) {
  const json = { ...base, description: form.description, tools: form.tools };
  if (form.model) json.model = form.model;
  else delete json.model;
  const ts = { ...(base.toolsSettings || {}) };
  const sub = { ...(ts.subagent || {}) };
  if (form.team.length) sub.availableAgents = form.team;
  else delete sub.availableAgents;
  if (Object.keys(sub).length) ts.subagent = sub;
  else delete ts.subagent;
  if (Object.keys(ts).length) json.toolsSettings = ts;
  else delete json.toolsSettings;
  return json;
}

function KiroAgentEditor({ agent, all }) {
  const { project, canEdit } = useProject();
  const { user } = useApp();
  const { toast, confirm } = useUi();
  const isNew = !agent;
  const base = agent?.json || { tools: ['read', 'write', 'shell', 'grep', 'glob'], allowedTools: ['read', 'grep', 'glob'], resources: ['file://.kiro/steering/**/*.md', 'skill://.kiro/skills/**/SKILL.md'] };
  const [form, setForm] = useState(() => ({
    name: agent?.name || '',
    description: agent?.description || '',
    model: agent?.model || '',
    tools: agent?.tools || base.tools,
    team: agent?.team || [],
    prompt: agent?.prompt ?? 'You are a specialist agent for this project.\n\nHow to work:\n1. Read the steering files and the code you are asked about first.\n2. Do the task you are given and verify it.\n3. Report what you did and anything left open.\n',
  }));
  const [mode, setMode] = useState('form');
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const nameOk = NAME_RE.test(form.name) && !form.name.startsWith('agent-portal-');
  const others = all.filter((a) => a.name !== agent?.name);
  const extraTools = form.tools.filter((t) => !KIRO_TOOLS.includes(t));
  const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const switchMode = (next) => {
    setError(null);
    if (next === 'json') {
      setRaw(JSON.stringify({ ...kiroJsonFrom(form, base), ...(agent?.promptFile ? {} : { prompt: form.prompt }) }, null, 2));
    } else {
      try {
        const json = JSON.parse(raw);
        setForm((cur) => ({
          ...cur,
          description: String(json.description ?? ''),
          model: String(json.model ?? ''),
          tools: Array.isArray(json.tools) ? json.tools.map(String) : [],
          team: Array.isArray(json.toolsSettings?.subagent?.availableAgents) ? json.toolsSettings.subagent.availableAgents.map(String) : [],
          prompt: agent?.promptFile || typeof json.prompt !== 'string' ? cur.prompt : json.prompt,
        }));
      } catch (e) {
        setError(new Error(`The JSON is not valid: ${e.message}`));
        return;
      }
    }
    setMode(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let body;
      if (mode === 'json') {
        const json = JSON.parse(raw);
        // A prompt kept in its own file is still edited in the form; the JSON then keeps its file:// reference.
        body = agent?.promptFile ? { json, prompt: form.prompt } : { json };
      } else body = { json: kiroJsonFrom(form, base), prompt: form.prompt };
      await api.put(`/api/projects/${project.id}/kiro-agents/${form.name}`, body);
      toast(isNew ? 'Kiro agent created' : 'Kiro agent saved');
      if (isNew) go(project.id, 'builder', 'kiro', form.name);
    } catch (e) {
      setError(e instanceof SyntaxError ? new Error(`The JSON is not valid: ${e.message}`) : e);
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (enabled) => {
    try {
      await api.put(`/api/projects/${project.id}/kiro-agents/${agent.name}/enabled`, { enabled });
      toast(enabled ? `${agent.name} is enabled` : `${agent.name} is disabled: Kiro runs no longer use it`);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="stack-lg">
      <div className="editor-head">
        <div className="row tight wrap">
          <h2>{isNew ? 'New Kiro agent' : agent.name}</h2>
          {agent && !agent.enabled ? <Badge>disabled</Badge> : null}
        </div>
        {agent && canEdit ? <Toggle checked={agent.enabled} onChange={setEnabled} label="Enabled" /> : null}
      </div>
      <p className="muted small">
        Kiro runs use the project’s enabled Kiro agents: a lead runs as the main agent and its team are the agents in its availableAgents. Whatever the agent pre-approves, file edits and commands
        still ask in the portal (or follow the session’s trust setting), and only the run’s own integrations are connected.
      </p>
      <Segmented
        value={mode}
        onChange={switchMode}
        label="Edit as"
        options={[
          { value: 'form', label: 'Form' },
          { value: 'json', label: 'JSON' },
        ]}
      />
      <fieldset className="stack" disabled={!canEdit}>
        {isNew ? (
          <Field label="Name" hint="Lowercase letters, digits and hyphens; the file is .kiro/agents/<name>.json." error={form.name && !nameOk ? 'Use lowercase letters, digits and hyphens (names starting with agent-portal- are taken)' : null}>
            {(id) => <input id={id} className="input mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.trim() })} />}
          </Field>
        ) : null}
        {mode === 'json' ? (
          <Field label="Agent definition" hint={agent?.promptFile ? `The instructions are kept in ${agent.promptFile}; edit them below.` : 'Kiro’s agent format. Hooks and MCP servers can only be changed by admins.'}>
            {(id) => <textarea id={id} className="input mono" rows={22} value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />}
          </Field>
        ) : (
          <>
            <Field label="Description" hint="What the agent does; a lead reads this to decide what to hand it.">
              {(id) => <textarea id={id} className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}
            </Field>
            <Field label="Model" hint="Leave empty for Kiro’s default.">
              {(id) => <input id={id} className="input mono" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value.trim() })} placeholder="e.g. claude-sonnet-4.6" />}
            </Field>
            <div className="field">
              <span className="field-label">Tools</span>
              <div className="row wrap">
                {[...KIRO_TOOLS, ...extraTools].map((t) => (
                  <label key={t} className="check">
                    <input type="checkbox" checked={form.tools.includes(t)} onChange={() => setForm({ ...form, tools: toggle(form.tools, t) })} /> <code>{t}</code>
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">Team</span>
              {others.length ? (
                <div className="row wrap">
                  {others.map((a) => (
                    <label key={a.name} className="check">
                      <input type="checkbox" checked={form.team.includes(a.name)} onChange={() => setForm({ ...form, team: toggle(form.team, a.name) })} /> {a.name}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="muted small">No other Kiro agents yet.</p>
              )}
              <p className="field-hint">When this agent leads, it can hand work to these agents with the subagent tool (toolsSettings.subagent.availableAgents).</p>
            </div>
          </>
        )}
        {mode === 'form' || agent?.promptFile ? (
          <Field label="Instructions" hint={agent?.promptFile ? `Stored in ${agent.promptFile}.` : 'The agent’s prompt. Markdown.'}>
            {(id) => <textarea id={id} className="input mono" rows={16} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />}
          </Field>
        ) : null}
        {agent?.resources?.length && mode === 'form' ? (
          <div className="field">
            <span className="field-label">Resources</span>
            <ul className="muted small mono">
              {agent.resources.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {agent?.hasHooks ? <p className="muted small">This agent has hooks. They run in portal runs too; only admins can change them{user.is_admin ? '' : ', so they are kept as they are'}.</p> : null}
      </fieldset>
      <ErrorNote error={error} />
      {canEdit ? (
        <div className="row wrap">
          <Button variant="primary" busy={busy} onClick={save} disabled={!nameOk || (mode === 'form' && !form.description.trim())}>
            {isNew ? 'Create agent' : 'Save agent'}
          </Button>
          {!isNew ? (
            <Button
              variant="danger-ghost"
              icon="trash"
              onClick={async () => {
                if (!(await confirm({ title: 'Delete Kiro agent', message: `Delete ${agent.name}? It stays in the project's git history.`, confirmLabel: 'Delete', danger: true }))) return;
                try {
                  await api.del(`/api/projects/${project.id}/kiro-agents/${agent.name}`);
                  go(project.id, 'builder', 'kiro');
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}
      {agent?.enabled && canEdit ? <KiroTestRun agent={agent} /> : null}
    </div>
  );
}

/** Try an agent: a single Kiro run it leads, with no repository. */
function KiroTestRun({ agent }) {
  const { project } = useProject();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const { workflow } = await api.post(`/api/projects/${project.id}/workflows`, { singleRun: true, prompt, engine: 'kiro', leadAgent: agent.name });
      go(project.id, 'sessions', workflow.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <section className="panel stack" aria-label="Test run">
      <h3 className="small">Test run on Kiro</h3>
      <Field label="Task" hint={`${agent.name} leads a single run with no repository; its team is on hand. Edits and commands ask for your approval.`}>
        {(id) => <textarea id={id} className="input" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Explain what you would do first for a new API endpoint" />}
      </Field>
      <ErrorNote error={error} />
      <div className="row">
        <Button icon="play" busy={busy} disabled={!prompt.trim()} onClick={start}>
          Start test run
        </Button>
      </div>
    </section>
  );
}

/** The parts of a .kiro folder an import reads (the server applies the same rule). */
const KIRO_IMPORT_TOPS = ['agents', 'skills', 'steering', 'prompts', 'specs', 'docs'];
function kiroUploadPath(raw) {
  let parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  const k = parts.indexOf('.kiro');
  if (k >= 0) parts = parts.slice(k + 1);
  else if (!KIRO_IMPORT_TOPS.includes(parts[0]) && KIRO_IMPORT_TOPS.includes(parts[1])) parts = parts.slice(1);
  if (!KIRO_IMPORT_TOPS.includes(parts[0]) || parts.length < 2 || parts.some((x) => /^(settings|sessions|logs)$/i.test(x) || /mcp\.json$/i.test(x))) return null;
  return parts.join('/');
}

async function toBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function KiroImport({ onClose, onDone }) {
  const { project } = useProject();
  const { user } = useApp();
  const { toast } = useUi();
  const [source, setSource] = useState(user.is_admin ? 'home' : 'folder');
  const [payload, setPayload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [choices, setChoices] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = async (body) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/api/projects/${project.id}/kiro-agents/import`, body);
      setPayload(body);
      setPreview(res);
      setChoices(Object.fromEntries(res.agents.map((a) => [a.name, a.conflict ? 'skip' : 'import'])));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const pickFolder = async (fileList) => {
    const files = [];
    for (const f of fileList) {
      const rel = kiroUploadPath(f.webkitRelativePath || f.name);
      if (rel) files.push({ path: rel, content: await toBase64(f) });
    }
    if (!files.length) return setError(new Error('That folder has no Kiro agents: choose a .kiro folder (or one with an agents folder inside).'));
    load({ files });
  };
  const pickZip = async (file) => file && load({ zip: await toBase64(file) });
  const confirmImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/api/projects/${project.id}/kiro-agents/import`, { ...payload, choices });
      toast(res.imported.length ? `Imported ${res.imported.join(', ')}` : 'Nothing was imported');
      onDone();
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal title="Import Kiro agents" onClose={onClose} wide>
      {!preview ? (
        <div className="stack">
          <p className="muted small">
            Copies each agent with its prompt and the skills and steering it loads into this project’s .kiro folder, rewriting ~/.kiro paths to the project. Settings, sessions, logs, mcp.json and MCP
            credentials are never copied.
          </p>
          <Segmented
            value={source}
            onChange={setSource}
            label="Import from"
            options={[...(user.is_admin ? [{ value: 'home', label: '~/.kiro on the server' }] : []), { value: 'folder', label: 'A folder' }, { value: 'zip', label: 'A zip' }]}
          />
          {source === 'home' ? (
            <Button variant="primary" busy={busy} onClick={() => load({ source: 'home' })}>
              Look in ~/.kiro
            </Button>
          ) : source === 'folder' ? (
            <Field label="Folder" hint="Your .kiro folder, or any folder with an agents folder inside.">
              {(id) => <input id={id} type="file" webkitdirectory="" multiple disabled={busy} onChange={(e) => pickFolder(e.target.files)} />}
            </Field>
          ) : (
            <Field label="Zip" hint="A zip of a .kiro folder.">
              {(id) => <input id={id} type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => pickZip(e.target.files[0])} />}
            </Field>
          )}
          <ErrorNote error={error} />
        </div>
      ) : (
        <div className="stack">
          <p className="muted small">
            {preview.agents.length} agent{preview.agents.length === 1 ? '' : 's'} in {preview.source}.
          </p>
          <ul className="stack" style={{ gap: '0.5rem' }}>
            {preview.agents.map((a) => (
              <li key={a.name} className="panel stack" style={{ gap: '0.3rem' }}>
                <div className="row between wrap">
                  <strong className="mono">{a.name}</strong>
                  <select className="input input-sm" value={choices[a.name]} onChange={(e) => setChoices({ ...choices, [a.name]: e.target.value })} aria-label={`What to do with ${a.name}`}>
                    <option value="import">{a.conflict ? 'Replace the existing one' : 'Import'}</option>
                    {a.conflict ? <option value="rename">Import under a new name</option> : null}
                    <option value="skip">Skip</option>
                  </select>
                </div>
                {a.description ? <span className="muted small">{a.description}</span> : null}
                {a.conflict ? <span className="small">The project already has an agent called {a.name}.</span> : null}
                {a.team.length ? <span className="small">Team: {a.team.join(', ')}</span> : null}
                {a.files.length ? <span className="muted small">Copies {a.files.join(', ')}</span> : null}
                {a.missing.length ? <span className="small" style={{ color: 'var(--warn)' }}>Not found: {a.missing.join(', ')}</span> : null}
                {a.skipped.length ? <span className="small" style={{ color: 'var(--warn)' }}>Left out (outside .kiro or private): {a.skipped.join(', ')}</span> : null}
                {a.dropped.length ? <span className="muted small">Removed: {a.dropped.join(', ')}</span> : null}
              </li>
            ))}
          </ul>
          <ErrorNote error={error} />
          <div className="row">
            <Button variant="primary" busy={busy} disabled={!Object.values(choices).some((c) => c !== 'skip')} onClick={confirmImport}>
              Import
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </Modal>
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
