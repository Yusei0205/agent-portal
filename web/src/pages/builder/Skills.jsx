import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { go } from '../../lib/router.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx, hueFor } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { Markdown } from '../../components/Markdown.jsx';
import { ImportModal } from '../../components/ImportModal.jsx';
import { DraftPromptModal } from '../../components/DraftPromptModal.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Segmented, Spinner, Toggle, useUi } from '../../components/ui.jsx';
import { ItemList, NAME_RE, TestPanel, useBuilderData } from './shared.jsx';

/* ---------------- Skills ---------------- */

export function Skills({ selected }) {
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
