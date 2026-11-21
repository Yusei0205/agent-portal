import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';
import { ConfigEditor } from './ConfigEditor.jsx';

const ENGINES = [
  { id: 'codex', folder: 'codex', label: 'Codex', icon: 'terminal' },
  { id: 'claude-code', folder: 'claude', label: 'Claude Code', icon: 'sparkles' },
  { id: 'kiro', folder: 'kiro', label: 'Kiro', icon: 'workflow' },
];
const keyOf = (agent) => `${agent.engine}:${agent.definitionPath || agent.name}`;

function WorkforceDialog({ agent, onClose, onSaved }) {
  const ref = useFocusTrap();
  const dismiss = useOverlayDismiss(onClose);
  const [engine, setEngine] = useState(agent?.engine || 'codex');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [following, setFollowing] = useState(true);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const close = () => { if (!busy && (!dirty || window.confirm('Discard unsaved agent changes?'))) onClose(); };
  const config = ENGINES.find((item) => item.id === engine);
  useEffect(() => {
    const escape = (event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [busy, dirty, onClose]);
  useEffect(() => {
    if (!agent) return;
    let disposed = false;
    api.get(`/api/user-config/${config.folder}/status`).then((status) => {
      if (!disposed) { setFollowing(Boolean(status.following && status.teamVersion)); setStatusLoaded(true); }
    }).catch((err) => { if (!disposed) setError(err.message); });
    return () => { disposed = true; };
  }, [agent, config.folder]);
  const create = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    const id = name.trim();
    const details = description.trim();
    const prompt = instructions.trim();
    const selectedModel = model.trim();
    const ext = engine === 'codex' ? 'toml' : engine === 'kiro' ? 'json' : 'md';
    const path = `agents/${id}.${ext}`;
    let content;
    if (engine === 'kiro') content = JSON.stringify({ name: id, description: details, prompt, ...(selectedModel ? { model: selectedModel } : {}), tools: [] }, null, 2) + '\n';
    else if (engine === 'codex') content = [`name = ${JSON.stringify(id)}`, `description = ${JSON.stringify(details)}`, `developer_instructions = ${JSON.stringify(prompt)}`, ...(selectedModel ? [`model = ${JSON.stringify(selectedModel)}`] : [])].join('\n') + '\n';
    else content = ['---', `name: ${JSON.stringify(id)}`, `description: ${JSON.stringify(details)}`, ...(selectedModel ? [`model: ${JSON.stringify(selectedModel)}`] : []), '---', '', prompt, ''].join('\n');
    try {
      await api.post(`/api/user-config/${config.folder}/file`, { path, content });
      onSaved(); onClose();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="dialog-overlay workforce-overlay" onMouseDown={dismiss.onMouseDown} onClick={busy || dirty ? undefined : dismiss.onClick}>
    <section className="workforce-inspector" role="dialog" aria-modal="true" aria-labelledby="workforce-dialog-title" ref={ref}>
      <header><div><span className="db-eyebrow">{agent ? config.label + ' · Agent definition' : 'Build your workforce'}</span><h2 id="workforce-dialog-title">{agent?.name || 'Create agent'}</h2></div><button className="btn-icon" type="button" onClick={close} disabled={busy} aria-label="Close agent inspector"><Icon name="x" size={18} /></button></header>
      {agent ? <div className="workforce-inspector-content">
        <p>{agent.description || 'No description configured.'}</p>
        <div className="workforce-tags"><span>{config.label}</span><span>{agent.model || 'Engine default model'}</span>{(agent.skills || []).map((skill) => <span key={skill}>{skill}</span>)}</div>
        <p className="muted small">Personal configuration · changes apply to sessions started or resumed afterwards.</p>
        {error && <p role="alert" className="error-note">{error}</p>}
        {!statusLoaded ? <p role="status">Loading configuration access…</p> : <>
          {following && <p className="workforce-notice">Following the team default. <a href={`#/config/${config.folder}`}>Open engine configuration</a> to customize your copy.</p>}
          {agent.definitionPath ? <ConfigEditor folder={config.folder} filePath={agent.definitionPath} following={following} onFileSaved={onSaved} onDirtyChange={setDirty} /> : <a className="btn" href={`#/config/${config.folder}`}>Open engine configuration</a>}
        </>}
      </div> : <form className="workforce-create" onSubmit={create}>
        <p className="muted small">Creates a definition in your existing engine configuration. You can choose it when starting a session.</p>
        <fieldset disabled={busy}>
          <label>Engine<select aria-label="Engine" value={engine} onChange={(event) => setEngine(event.target.value)}>{ENGINES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>Agent name<input aria-label="Agent name" value={name} onChange={(event) => setName(event.target.value)} required pattern="[A-Za-z0-9_-]{1,100}" maxLength={100} placeholder="solution-architect" autoComplete="off" /><small>Letters, numbers, hyphens and underscores.</small></label>
          <label>Description<input aria-label="Description" value={description} onChange={(event) => setDescription(event.target.value)} required maxLength={1000} placeholder="Architecture and technical design" /></label>
          <label>Model <span className="muted">(optional)</span><input value={model} onChange={(event) => setModel(event.target.value)} maxLength={120} placeholder="Leave blank for engine default" /></label>
          <label>Instructions<textarea aria-label="Instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} required rows={7} maxLength={40000} placeholder="Describe the agent’s responsibilities, context and verification steps." /></label>
        </fieldset>
        <p className="muted small">Creating a definition customizes your engine configuration if you currently follow a team default. Review tools and permissions in the engine editor before running it.</p>
        {error && <p role="alert" className="error-note">{error}</p>}
        <footer><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create agent'}</button></footer>
      </form>}
    </section>
  </div>, document.body);
}

export function AgentWorkforce() {
  const [agents, setAgents] = useState([]);
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [engine, setEngine] = useState('all');
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    Promise.allSettled(ENGINES.map((item) => api.get(`/api/user-config/agents?engine=${item.id}`))).then((results) => {
      if (disposed) return;
      const failed = results.flatMap((result, index) => result.status === 'rejected' ? [ENGINES[index].label] : []);
      setAgents((previous) => results.flatMap((result, index) => {
        const item = ENGINES[index];
        if (result.status === 'rejected') return previous.filter((agent) => agent.engine === item.id);
        return (result.value.agents || []).map((agent) => ({ ...agent, engine: item.id }));
      }));
      setErrors(failed); setLoading(false);
    });
    return () => { disposed = true; };
  }, [revision]);
  const filtered = useMemo(() => agents.filter((agent) => (engine === 'all' || agent.engine === engine) && [agent.name, agent.description, agent.model, ...(agent.skills || [])].join(' ').toLowerCase().includes(query.trim().toLowerCase())), [agents, engine, query]);
  return <section className="workforce" aria-label="Agent workforce">
    <header className="workforce-heading"><div><span className="db-eyebrow">Your specialized team</span><h2>Agent workforce</h2><p>Find the right agent, inspect its instructions and shape how it works.</p></div><button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} />Create agent</button></header>
    <div className="workforce-summary"><span><i />{agents.length} configured agents</span>{ENGINES.map((item) => <span key={item.id}>{item.label}<strong>{agents.filter((agent) => agent.engine === item.id).length}</strong></span>)}</div>
    <div className="workforce-toolbar"><label><Icon name="search" size={16} /><input type="search" aria-label="Search agents" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents, skills or models…" /></label><select aria-label="Filter agent engine" value={engine} onChange={(event) => setEngine(event.target.value)}><option value="all">All engines</option>{ENGINES.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select><button type="button" className="btn" onClick={refresh} disabled={loading}><Icon name="refresh" size={14} />Refresh</button></div>
    {errors.length > 0 && <p role="alert" className="workforce-notice">{errors.join(', ')} could not be refreshed. Any previous definitions remain visible. <button type="button" className="btn btn-sm" onClick={refresh}>Retry</button></p>}
    {loading && <p role="status" className="muted small">Loading your configured agents…</p>}
    <div className="workforce-grid">{filtered.map((agent) => {
      const config = ENGINES.find((item) => item.id === agent.engine);
      return <button type="button" className={`workforce-card workforce-${agent.engine}`} key={keyOf(agent)} onClick={() => setSelected(agent)} aria-label={`Inspect ${agent.name} (${config.label})`}>
        <span className="workforce-card-top"><span className="workforce-avatar"><Icon name={config.icon} size={22} /></span><span className="workforce-configured"><i />Configured</span></span>
        <strong className="workforce-name">{agent.name}</strong><span className="workforce-description">{agent.description || 'Add a description in the agent definition.'}</span>
        <span className="workforce-tags"><span>{config.label}</span>{(agent.skills || []).slice(0, 3).map((skill) => <span key={skill}>{skill}</span>)}{agent.skills?.length > 3 && <span>+{agent.skills.length - 3}</span>}</span>
        <span className="workforce-card-footer"><span title={agent.model || 'Uses the session or engine default model'}>{agent.model || 'Engine default model'}</span><span>Inspect<Icon name="chevronRight" size={13} /></span></span>
      </button>;
    })}</div>
    {!loading && !filtered.length && <div className="workforce-empty"><Icon name="agents" size={32} /><h3>{agents.length ? 'No matching agents' : errors.length ? 'Agent definitions are unavailable' : 'Build your first specialist'}</h3><p>{agents.length ? 'Try a different search or engine filter.' : errors.length ? 'Retry the connection to load your definitions.' : 'Create an agent here, or add the agent pack from an engine’s configuration tab.'}</p><a href="#/config/sign-ins" className="btn">Manage engine sign-ins</a></div>}
    <p className="workforce-footnote">These are your saved engine definitions. Live agent status and recorded activity appear in Dashboard › Mission control and in each session.</p>
    {(selected || creating) && <WorkforceDialog agent={selected} onClose={() => { setSelected(null); setCreating(false); }} onSaved={refresh} />}
  </section>;
}
