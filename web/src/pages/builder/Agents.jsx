import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { go, href } from '../../lib/router.js';
import { Icon } from '../../components/Icon.jsx';
import { ImportModal } from '../../components/ImportModal.jsx';
import { DraftPromptModal } from '../../components/DraftPromptModal.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Spinner, Toggle, useUi } from '../../components/ui.jsx';
import { ItemList, NAME_RE, TestPanel, useBuilderData } from './shared.jsx';

export function Agents({ selected }) {
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

export function AgentEditor({ agent, skills, tools, draftForm }) {
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
