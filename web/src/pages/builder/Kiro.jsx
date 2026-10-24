import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp, useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { go, href, withQuery } from '../../lib/router.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx, hueFor } from '../../lib/util.js';
import { Badge, Button, Empty, ErrorNote, Field, Segmented, Spinner, Toggle, useUi } from '../../components/ui.jsx';
import { KiroImport } from './KiroImport.jsx';
import { NAME_RE } from './shared.jsx';

/* ---------------- Kiro agents ---------------- */

/** Built-in Kiro tools offered as checkboxes; anything else in an agent's list is kept as it is. */
const KIRO_TOOLS = ['read', 'write', 'shell', 'grep', 'glob', 'web_fetch', 'web_search', 'knowledge', 'subagent'];

export function KiroAgents({ selected }) {
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
