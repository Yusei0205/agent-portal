import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../styles/automations.css';
import { api } from '../lib/api.js';
import { href } from '../lib/router.js';
import { formatRelative } from '../lib/util.js';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { ModelPicker } from './sessions/NewSessionDialog.jsx';

const kinds = { start: 'Start', agent: 'Agent task', condition: 'Condition', approval: 'Human approval', end: 'End' };
const engineLabel = { codex: 'Codex', 'claude-code': 'Claude Code', kiro: 'Kiro', demo: 'Demo' };

function StepNode({ data, selected }) {
  const { node, status } = data;
  return <div className={`automation-node ${selected ? 'selected' : ''} kind-${node.kind} ${status || ''}`}>
    {node.kind !== 'start' && <Handle type="target" position={Position.Left} />}
    <small>{kinds[node.kind]}{status ? ` · ${status}` : ''}</small><strong>{node.label}</strong>
    {node.kind === 'condition' ? <>
      <span className="branch-yes">Yes</span><Handle type="source" id="yes" position={Position.Right} style={{ top: '35%' }} />
      <span className="branch-no">No</span><Handle type="source" id="no" position={Position.Right} style={{ top: '75%' }} />
    </> : node.kind !== 'end' && <Handle type="source" id="next" position={Position.Right} />}
  </div>;
}
const nodeTypes = { step: StepNode };
const toFlow = (graph, run) => ({
  nodes: graph.nodes.map((node) => ({ id: node.id, type: 'step', position: node.position, data: { node, status: run?.attempts?.filter((a) => a.nodeId === node.id).at(-1)?.status } })),
  edges: graph.edges.map((edge) => ({ ...edge, sourceHandle: edge.branch, label: edge.branch === 'next' ? '' : edge.branch, type: 'smoothstep' })),
});
const toGraph = (graph, nodes, edges) => ({ ...graph,
  nodes: nodes.map((n) => ({ ...n.data.node, position: n.position })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, branch: e.sourceHandle || 'next' })),
});

/** "Development", then "Development 2", "Development 3"… so a new workflow never repeats a name in the list. */
function uniqueName(base, taken) {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  let name = base; let i = 2;
  while (used.has(name.toLowerCase())) name = `${base} ${i++}`;
  return name;
}
const templateBaseName = (t) => t.name.replace(/ \(.*$/, '');

function Crumbs({ items }) {
  return <nav aria-label="Breadcrumb" className="automation-crumbs">{items.map((item, i) => <span key={i}>
    {i > 0 && <span aria-hidden="true"> › </span>}
    {item.onClick ? <button type="button" className="automation-crumb-link" onClick={item.onClick}>{item.label}</button> : <span aria-current="page">{item.label}</span>}
  </span>)}</nav>;
}

/** A template drawn as it will be created: read-only canvas, and the instructions of the step you click. */
function TemplateCanvas({ template }) {
  const flow = useMemo(() => toFlow(template.graph), [template]);
  const [pickedId, setPickedId] = useState(null);
  useEffect(() => { setPickedId(null); }, [template.id]);
  const picked = template.graph.nodes.find((n) => n.id === pickedId);
  const steps = template.graph.nodes.filter((n) => n.kind === 'agent').length;
  return <div className="automation-builder" aria-label={`Template preview: ${template.name}`}>
    <aside className="automation-palette"><h2>Preview</h2><p className="muted">{template.graph.nodes.length} steps ({steps} agent tasks). Click a step to read its instructions. Nothing is created until you press Create; you can change every step afterwards.</p></aside>
    <div className="automation-canvas" aria-label="Template canvas">
      <ReactFlow key={template.id} nodes={flow.nodes.map((n) => ({ ...n, selected: n.id === pickedId }))} edges={flow.edges} nodeTypes={nodeTypes} fitView colorMode="dark"
        nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null}
        onNodeClick={(_, node) => setPickedId(node.id)} onPaneClick={() => setPickedId(null)}>
        <Background gap={20} /><Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <aside className="automation-inspector"><h2>{picked ? picked.label : 'Select a step'}</h2>{picked && <>
      <p className="muted small">{kinds[picked.kind]}{picked.maxVisits ? ` · visit limit ${picked.maxVisits}` : ''}</p>
      {picked.prompt ? <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '.78rem', margin: 0 }}>{picked.prompt}</pre> : <p className="muted small">No instructions for this step type.</p>}
      {picked.checks?.length > 0 && <><h3>Verification checks</h3>{picked.checks.map((c, i) => <p className="small" key={i}><strong>{c.step}</strong>: <code>{c.cmd}</code></p>)}</>}
    </>}</aside>
  </div>;
}

/**
 * Workflows, in three views:
 *   list - every workflow of the project, its status and latest run, and New workflow
 *   new  - pick a template (cards), see it on a canvas, name it, create it
 *   edit - one workflow: Design (settings + canvas) and Runs tabs, with Save, Publish and history
 */
export default function Automations({ projectId }) {
  const base = `/api/projects/${projectId}/automations`;
  const { confirmState, requestConfirm } = useConfirm();
  const [view, setView] = useState('list'); const [tab, setTab] = useState('design');
  const [definitions, setDefinitions] = useState([]); const [stats, setStats] = useState({});
  const [definition, setDefinition] = useState(null);
  const [graph, setGraph] = useState(null);
  const [nodes, setNodes] = useState([]); const [edges, setEdges] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [repos, setRepos] = useState([]); const [agents, setAgents] = useState([]);
  const [runs, setRuns] = useState([]); const [run, setRun] = useState(null);
  const [versions, setVersions] = useState(null);
  const [runGraph, setRunGraph] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [available, setAvailable] = useState(false); const [dirty, setDirty] = useState(false);
  const [input, setInput] = useState('');
  const [templates, setTemplates] = useState([]); const [newTemplateId, setNewTemplateId] = useState(null); const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);
  const requestId = useRef(null);
  const selected = nodes.find((n) => n.id === selectedId);
  const task = async (fn) => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message || 'Request failed'); } finally { setBusy(false); } };

  const open = useCallback((d) => {
    setDefinition(d); setGraph(d.graph); const flow = toFlow(d.graph); setNodes(flow.nodes); setEdges(flow.edges);
    setSelectedId(null); setRun(null); setRuns([]); setVersions(null); setDirty(false); setError(''); setNotice(''); requestId.current = null;
  }, []);
  const openWorkflow = useCallback((d) => { open(d); setTab('design'); setView('edit'); }, [open]);

  const refresh = useCallback(async () => {
    const result = await api.get(base);
    setDefinitions(result.definitions); setStats(result.stats || {}); setTemplates(result.templates || []); setAvailable(result.executionAvailable);
    return result;
  }, [base]);
  useEffect(() => {
    let live = true; setLoading(true); setDefinition(null); setView('list');
    Promise.all([refresh(), api.get(`/api/projects/${projectId}/repos`)]).then(([, repositories]) => {
      if (live) setRepos(repositories.repos || []);
    }).catch((e) => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [base, projectId, refresh]);
  useEffect(() => {
    if (!graph) return;
    let live = true;
    api.get(`/api/user-config/agents?engine=${encodeURIComponent(graph.engine)}`).then((r) => { if (live) setAgents(r.agents || []); }).catch(() => { if (live) setAgents([]); });
    return () => { live = false; };
  }, [graph?.engine]);
  useEffect(() => {
    if (!definition || view !== 'edit') return;
    let live = true;
    const poll = () => api.get(`${base}/${definition.id}/runs`).then((r) => {
      if (!live) return;
      setRuns(r.runs); setRun((old) => old ? r.runs.find((v) => v.id === old.id) || old : r.runs[0] || null);
    }).catch((e) => { if (live) setError(e.message); });
    poll(); const timer = setInterval(poll, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [base, definition?.id, view]);
  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    let live = true; setRunGraph(null);
    if (run) api.get(`${base}/${run.definition_id}/versions`).then((r) => {
      if (live) setRunGraph(r.versions.find((v) => v.version === run.version)?.graph || null);
    }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [base, run?.id, run?.version]);

  const updateNode = (patch) => { setNodes((list) => list.map((n) => n.id === selectedId ? { ...n, data: { ...n.data, node: { ...n.data.node, ...patch } } } : n)); setDirty(true); };
  const updateGraph = (patch) => { setGraph((g) => ({ ...g, ...patch })); setDirty(true); };
  const save = async () => {
    const result = await api.put(`${base}/${definition.id}`, { revision: definition.revision, name: definition.name, graph: toGraph(graph, nodes, edges) });
    setDefinition(result.definition); setDefinitions((list) => list.map((d) => d.id === result.definition.id ? result.definition : d)); setDirty(false); return result.definition;
  };
  const publish = () => task(async () => {
    const d = dirty ? await save() : definition;
    const result = await api.post(`${base}/${d.id}/publish`, { revision: d.revision });
    setDefinition(result.definition); setDefinitions((list) => list.map((v) => v.id === d.id ? result.definition : v));
    setNotice(`Published version ${result.definition.published_version}. Runs keep this version even when you edit the draft.`);
  });

  // ── Navigation ──
  const confirmLeave = async () => !dirty || await requestConfirm('You have unsaved changes to this workflow. Leave without saving them?', 'Leave', 'danger');
  const goList = async () => {
    if (!(await confirmLeave())) return;
    setDirty(false); setDefinition(null); setError(''); setNotice(''); setView('list');
    refresh().catch((e) => setError(e.message));
  };
  const startNew = () => {
    const first = templates[0];
    setNewTemplateId(first?.id ?? null); setNewName(uniqueName(first ? templateBaseName(first) : 'Workflow', definitions.map((d) => d.name)));
    setError(''); setNotice(''); setView('new');
  };
  const pickTemplate = (t) => { setNewTemplateId(t.id); setNewName(uniqueName(templateBaseName(t), definitions.map((d) => d.name))); };
  const create = () => task(async () => {
    const r = await api.post(base, { name: newName.trim(), templateId: newTemplateId });
    setDefinitions((list) => [...list, r.definition]); openWorkflow(r.definition);
  });
  const remove = async (d) => {
    if (!(await requestConfirm(`Delete the workflow "${d.name}"? Its published versions and past runs are kept as history, but it will no longer be listed.`, 'Delete', 'danger'))) return;
    await task(async () => { await api.delete(`${base}/${d.id}`); await refresh(); setNotice(`Deleted "${d.name}".`); });
  };

  // ── Runs ──
  const start = () => task(async () => {
    requestId.current ||= crypto.randomUUID();
    const r = await api.post(`${base}/${definition.id}/runs`, { input, requestId: requestId.current });
    setRun(r.run); setRuns((list) => [r.run, ...list.filter((v) => v.id !== r.run.id)]); requestId.current = null;
  });
  const control = (action) => task(async () => {
    const attempt = run.attempts.at(-1);
    const r = await api.post(`${base}/${definition.id}/runs/${run.id}/${action}`, { revision: run.revision, nodeId: run.cursor, visit: attempt?.visit }); setRun(r.run);
  });

  // ── Canvas ──
  const addNode = (kind) => {
    const id = crypto.randomUUID();
    const node = { id, kind, label: kinds[kind], prompt: '', model: '', agent: '', checks: [], maxVisits: 3, position: { x: 100 + nodes.length * 30, y: 100 + nodes.length * 20 } };
    setNodes((list) => [...list, { id, position: node.position, type: 'step', data: { node } }]); setSelectedId(id); setDirty(true);
  };
  // Remove the selected step and every connection to or from it.
  const removeStep = () => {
    if (!selectedId) return;
    setNodes((list) => list.filter((n) => n.id !== selectedId));
    setEdges((list) => list.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null); setDirty(true);
  };
  const check = selected?.data.node;
  const markedNodes = nodes.map((n) => ({ ...n, selected: n.id === selectedId }));
  const executionFlow = runGraph ? toFlow(runGraph, run) : null;
  const newTemplate = templates.find((t) => t.id === newTemplateId);
  const activeRuns = runs.filter((r) => ['running', 'waiting'].includes(r.status)).length;

  const banners = <>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
  </>;

  // ───────────────────────────── List ─────────────────────────────
  if (view === 'list' || (view === 'edit' && !definition) || (view === 'new' && !templates.length)) {
    return <div className="page automations-page">
      <header className="automation-heading"><div><h1>Workflows</h1><p className="muted">Build repeatable agent tasks with checks, branches, and human approvals.</p></div>
        <button className="btn btn-primary" disabled={loading || !templates.length} onClick={startNew}>New workflow</button></header>
      {banners}
      {loading ? <p role="status">Loading workflows…</p> : definitions.length === 0 ? <section className="automation-empty">
        <h2>No workflows yet</h2><p className="muted">Start from a template (SDLC, Development from a Jira ticket, or Testing a ticket) and change every step to fit your process.</p>
        <button className="btn btn-primary" onClick={startNew}>Create your first workflow</button>
      </section> : <div style={{ overflowX: 'auto' }}><table className="table automation-list" aria-label="Workflows">
        <thead><tr><th>Name</th><th>Engine</th><th>Steps</th><th>Status</th><th>Latest run</th><th>Updated</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{definitions.map((d) => {
          const s = stats[d.id];
          return <tr key={d.id}>
            <td><button type="button" className="btn btn-ghost btn-sm" onClick={() => openWorkflow(d)}><strong>{d.name}</strong></button></td>
            <td>{engineLabel[d.graph.engine] || d.graph.engine}</td>
            <td>{d.graph.nodes.length}</td>
            <td>{d.published_version === null ? <span className="badge">Draft only</span> : <span className="badge badge-ok">Published v{d.published_version}</span>}</td>
            <td>{s?.lastStartedAt ? <>{s.active > 0 && <span className="badge badge-info">{s.active} running</span>} <span className="muted small">{s.lastStatus} · {formatRelative(s.lastStartedAt)}</span></> : <span className="muted small">Never run</span>}</td>
            <td className="muted small">{formatRelative(d.updated_at)}</td>
            <td style={{ whiteSpace: 'nowrap' }}><button className="btn btn-sm" onClick={() => openWorkflow(d)}>Open</button> <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => remove(d)} aria-label={`Delete ${d.name}`}>Delete</button></td>
          </tr>;
        })}</tbody>
      </table></div>}
      <ConfirmDialog state={confirmState} />
    </div>;
  }

  // ───────────────────────────── New ─────────────────────────────
  if (view === 'new') {
    return <div className="page automations-page">
      <Crumbs items={[{ label: 'Workflows', onClick: () => { setError(''); setView('list'); } }, { label: 'New workflow' }]} />
      <header className="automation-heading"><div><h1>New workflow</h1><p className="muted">Pick a template, check it on the canvas, then name and create it. You can change every step before publishing.</p></div></header>
      {banners}
      <div role="radiogroup" aria-label="Template" className="automation-cards">{templates.map((t) => <button key={t.id} type="button" role="radio" aria-checked={t.id === newTemplateId}
        className={`automation-card${t.id === newTemplateId ? ' is-selected' : ''}`} onClick={() => pickTemplate(t)}>
        <strong>{t.name}</strong><span className="muted small">{t.description}</span><span className="small">{t.graph.nodes.length} steps</span>
      </button>)}</div>
      <div className="automation-actions automation-toolbar">
        <label>Name<input aria-label="New workflow name" value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy || !newName.trim() || !newTemplate} onClick={create}>Create workflow</button>
        <button className="btn" onClick={() => { setError(''); setView('list'); }}>Cancel</button>
      </div>
      {newTemplate && <TemplateCanvas template={newTemplate} />}
      <ConfirmDialog state={confirmState} />
    </div>;
  }

  // ───────────────────────────── Edit ─────────────────────────────
  return <div className="page automations-page">
    <Crumbs items={[{ label: 'Workflows', onClick: goList }, { label: definition.name }]} />
    <header className="automation-heading"><div><h1>{definition.name}</h1>
      <p className="muted automation-meta">{definition.published_version === null ? <span className="badge">Draft only</span> : <span className="badge badge-ok">Published v{definition.published_version}</span>} {dirty && <span className="automation-dirty">Unsaved changes</span>}</p></div>
      <div className="automation-actions automation-toolbar">
        <button className="btn" disabled={busy || !dirty} onClick={() => task(async () => { await save(); setNotice('Draft saved.'); })}>Save draft</button>
        <button className="btn btn-primary" disabled={busy} onClick={publish}>Publish version</button>
        <button className="btn" disabled={busy} onClick={() => task(async () => { const r = await api.get(`${base}/${definition.id}/versions`); setVersions(r.versions); setTab('design'); })}>Version history</button>
        {dirty && <button className="btn" onClick={() => open(definitions.find((d) => d.id === definition.id) || definition)}>Discard changes</button>}
      </div></header>
    {banners}
    <div className="tab-bar" role="tablist" aria-label="Workflow sections">
      <button role="tab" type="button" aria-selected={tab === 'design'} className={`tab-btn${tab === 'design' ? ' is-active' : ''}`} onClick={() => setTab('design')}>Design</button>
      <button role="tab" type="button" aria-selected={tab === 'runs'} className={`tab-btn${tab === 'runs' ? ' is-active' : ''}`} onClick={() => setTab('runs')}>Runs{activeRuns ? ` (${activeRuns} running)` : ''}</button>
    </div>

    {tab === 'design' && <>
      {versions && <section className="automation-versions"><h2>Published versions</h2><button className="btn" onClick={() => setVersions(null)}>Close history</button>{versions.length ? versions.map((v) => <div key={v.version}><strong>Version {v.version}</strong> · {new Date(v.created_at).toLocaleString()} <button className="btn" disabled={dirty} onClick={() => { const f = toFlow(v.graph); setGraph(v.graph); setNodes(f.nodes); setEdges(f.edges); setDirty(true); setVersions(null); }}>Copy to draft</button></div>) : <p>No published versions yet.</p>}</section>}
      <details className="automation-settingsbox" open>
        <summary>Settings <span className="muted small">· {engineLabel[graph.engine] || graph.engine} · up to {graph.maxSteps} steps · {graph.timeoutMinutes} min · {graph.repoIds.length} {graph.repoIds.length === 1 ? 'repository' : 'repositories'}</span></summary>
        <div className="automation-settings">
          <label>Name<input value={definition.name} maxLength={120} onChange={(e) => { setDefinition((d) => ({ ...d, name: e.target.value })); setDirty(true); }} /></label>
          <label>Engine<select value={graph.engine} onChange={(e) => updateGraph({ engine: e.target.value, budgetUsd: ['codex', 'kiro'].includes(e.target.value) ? null : graph.budgetUsd })}><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="kiro">Kiro</option><option value="demo">Demo</option></select></label>
          <label>Step limit<input type="number" min="1" max="100" value={graph.maxSteps} onChange={(e) => updateGraph({ maxSteps: Number(e.target.value) })} /></label>
          <label>Time limit (minutes)<input type="number" min="1" max="1440" value={graph.timeoutMinutes} onChange={(e) => updateGraph({ timeoutMinutes: Number(e.target.value) })} /></label>
          <label>USD budget (optional)<input type="number" min="0.01" max="1000" step="0.01" value={graph.budgetUsd ?? ''} disabled={['codex', 'kiro'].includes(graph.engine)} onChange={(e) => updateGraph({ budgetUsd: e.target.value ? Number(e.target.value) : null })} /></label>
        </div>
        <fieldset className="automation-repos"><legend>Repositories</legend>{repos.length ? repos.map((r) => <label key={r.id}><input type="checkbox" checked={graph.repoIds.includes(r.id)} onChange={(e) => updateGraph({ repoIds: e.target.checked ? [...graph.repoIds, r.id] : graph.repoIds.filter((id) => id !== r.id) })} />{r.name}</label>) : <span className="muted">Connect a repository in Workspaces to use it here.</span>}</fieldset>
      </details>
      <div className="automation-builder">
        <aside className="automation-palette"><h2>Steps</h2>{Object.entries(kinds).map(([kind, label]) => <button className="btn" key={kind} onClick={() => addNode(kind)}>+ {label}</button>)}<p className="muted">Drag steps to arrange them. Drag between handles to connect. Select a step or a connection and press Delete (or use Delete step in its settings) to remove it.</p></aside>
        <div className="automation-canvas" aria-label="Workflow canvas">
          <ReactFlow nodes={markedNodes} edges={edges} nodeTypes={nodeTypes} fitView colorMode="dark" deleteKeyCode={['Backspace', 'Delete']}
            onNodesChange={(changes) => { setNodes((list) => applyNodeChanges(changes, list)); if (changes.some((c) => c.type !== 'select' && c.type !== 'dimensions')) setDirty(true); }}
            onEdgesChange={(changes) => { setEdges((list) => applyEdgeChanges(changes, list)); if (changes.some((c) => c.type !== 'select')) setDirty(true); }}
            onNodesDelete={(removed) => { const ids = new Set(removed.map((n) => n.id)); setEdges((list) => list.filter((e) => !ids.has(e.source) && !ids.has(e.target))); setSelectedId(null); }}
            onNodeClick={(_, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(null)}
            onConnect={(connection) => { setEdges((list) => addEdge({ ...connection, id: crypto.randomUUID(), type: 'smoothstep', label: connection.sourceHandle === 'next' ? '' : connection.sourceHandle }, list)); setDirty(true); }}>
            <Background gap={20} /><Controls />
          </ReactFlow>
        </div>
        <aside className="automation-inspector"><h2>{check ? 'Step settings' : 'Select a step'}</h2>{check && <>
          <button type="button" className="btn btn-danger" onClick={removeStep}>Delete step</button>
          <label>Name<input value={check.label} maxLength={100} onChange={(e) => updateNode({ label: e.target.value })} /></label>
          <label>Visit limit<input type="number" min="1" max="10" value={check.maxVisits} onChange={(e) => updateNode({ maxVisits: Number(e.target.value) })} /></label>
          {check.kind === 'agent' && <>
            <label>Agent<select value={check.agent} onChange={(e) => updateNode({ agent: e.target.value })}><option value="">Engine default</option>{agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}</select></label>
            <ModelPicker engine={graph.engine} credentialId="" value={check.model} onChange={(model) => updateNode({ model })} />
            <label>Instructions<textarea rows={7} value={check.prompt} maxLength={6000} onChange={(e) => updateNode({ prompt: e.target.value })} /></label>
            <p className="muted">Use {'{{input}}'} for the run request or {'{{steps.design.output}}'} for an earlier step’s summary. Step ID: {check.id}. Tasks share one working copy and conversation. The run uses your default sign-in.</p>
            <h3>Verification checks</h3>{check.checks.map((c, i) => <div className="automation-check" key={i}>
              <label>Command<input value={c.cmd} onChange={(e) => updateNode({ checks: check.checks.map((v, j) => j === i ? { ...v, cmd: e.target.value } : v) })} /></label>
              <label>Working directory<select value={c.workRepo || ''} onChange={(e) => updateNode({ checks: check.checks.map((v, j) => j === i ? { ...v, workRepo: e.target.value || undefined } : v) })}><option value="">Session root</option>{repos.filter((r) => graph.repoIds.includes(r.id)).map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}</select></label>
              <button className="btn" onClick={() => updateNode({ checks: check.checks.filter((_, j) => j !== i) })}>Remove check</button>
            </div>)}<button className="btn" onClick={() => updateNode({ checks: [...check.checks, { step: `Check ${check.checks.length + 1}`, cmd: 'npm test', timeout: 300 }] })}>Add check</button>
          </>}
          {check.kind === 'condition' && <p className="muted">Yes follows a successful agent turn with passing checks. Failed checks follow No. Connect No to a task to retry; visit and step limits bound the loop.</p>}
          {check.kind === 'approval' && <><label>Review instructions<textarea value={check.prompt} rows={5} onChange={(e) => updateNode({ prompt: e.target.value })} /></label><p className="muted">The run waits here until its owner or a portal admin approves. Tool calls still follow your portal permissions.</p></>}
        </>}</aside>
      </div>
    </>}

    {tab === 'runs' && <section className="automation-execution"><div className="automation-actions"><h2>Run this workflow</h2><span className="muted">Published version: {definition.published_version ?? 'none'}</span></div>
      {!available && <p role="status">Durable execution is not configured on this deployment.</p>}
      {definition.published_version === null && <p className="muted">Publish a version first (Publish version, above). Runs use the published version, so editing the draft does not change a run in progress.</p>}
      {dirty && <p className="muted">Save or publish your changes first: runs use the published version.</p>}
      <label>Run request<textarea rows={2} value={input} maxLength={2000} onChange={(e) => { setInput(e.target.value); requestId.current = null; }} placeholder="Describe what this workflow should build, or give the Jira ticket key…" /></label>
      <div><button className="btn btn-primary" disabled={busy || !available || definition.published_version === null || dirty} onClick={start}>Run published workflow</button></div>
      <p className="muted">Runs continue when this page closes. Each agent task has a 12 minute limit. Subscription usage is bounded by time and step limits; dollar budgets apply only to priced providers.</p>
      <label>Run history<select value={run?.id || ''} onChange={(e) => setRun(runs.find((r) => r.id === e.target.value))}><option value="" disabled>No runs</option>{runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.started_at).toLocaleString()} · v{r.version} · {r.status}</option>)}</select></label>
      {run && <><div className="automation-actions"><strong>{run.status}{run.cancelRequested ? ' · cancellation requested' : ''}</strong><a href={href(projectId, 'sessions', run.session_id)}>Open session, logs & artifacts</a>{['running', 'waiting'].includes(run.status) && <button className="btn" disabled={busy || run.cancelRequested} onClick={() => control('cancel')}>Cancel run</button>}{run.status === 'waiting' && <button className="btn btn-primary" disabled={busy} onClick={() => control('approve')}>Approve {run.attempts.at(-1)?.label}</button>}</div>
        {run.status === 'waiting' && <p>{runGraph?.nodes.find((n) => n.id === run.cursor)?.prompt}</p>}
        {run.error && <p role="alert">{run.error}</p>}
        {executionFlow && <div style={{ height: 320 }} aria-label={`Execution graph version ${run.version}`}><ReactFlow key={run.id} nodes={executionFlow.nodes} edges={executionFlow.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} fitView colorMode="dark"><Background /><Controls showInteractive={false} /></ReactFlow></div>}
        <ol className="automation-timeline">{run.attempts.map((a, i) => <li key={`${a.nodeId}-${i}`} className={a.status}><strong>{a.label}</strong><span>{a.status} · attempt {a.visit}</span>{a.output && <pre>{a.output}</pre>}</li>)}</ol>
      </>}
    </section>}
    <ConfirmDialog state={confirmState} />
  </div>;
}
