import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../styles/automations.css';
import { api } from '../lib/api.js';
import { href } from '../lib/router.js';
import { ModelPicker } from './sessions/NewSessionDialog.jsx';

const kinds = { start: 'Start', agent: 'Agent task', condition: 'Condition', approval: 'Human approval', end: 'End' };
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

export default function Automations({ projectId }) {
  const base = `/api/projects/${projectId}/automations`;
  const [definitions, setDefinitions] = useState([]);
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
  const [input, setInput] = useState(''); const [newName, setNewName] = useState('SDLC automation');
  const [loading, setLoading] = useState(true);
  const requestId = useRef(null);
  const selected = nodes.find((n) => n.id === selectedId);
  const task = async (fn) => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message || 'Request failed'); } finally { setBusy(false); } };
  const open = useCallback((d) => {
    setDefinition(d); setGraph(d.graph); const flow = toFlow(d.graph); setNodes(flow.nodes); setEdges(flow.edges);
    setSelectedId(null); setRun(null); setRuns([]); setVersions(null); setDirty(false); setError(''); setNotice(''); requestId.current = null;
  }, []);
  useEffect(() => {
    let live = true; setLoading(true); setDefinition(null);
    Promise.all([api.get(base), api.get(`/api/projects/${projectId}/repos`)]).then(([result, repositories]) => {
      if (!live) return;
      setDefinitions(result.definitions); setAvailable(result.executionAvailable); setRepos(repositories.repos || []);
      if (result.definitions.length) open(result.definitions[0]);
    }).catch((e) => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [base, projectId, open]);
  useEffect(() => {
    if (!graph) return;
    let live = true;
    api.get(`/api/user-config/agents?engine=${encodeURIComponent(graph.engine)}`).then((r) => { if (live) setAgents(r.agents || []); }).catch(() => { if (live) setAgents([]); });
    return () => { live = false; };
  }, [graph?.engine]);
  useEffect(() => {
    if (!definition) return;
    let live = true;
    const poll = () => api.get(`${base}/${definition.id}/runs`).then((r) => {
      if (!live) return;
      setRuns(r.runs); setRun((old) => old ? r.runs.find((v) => v.id === old.id) || old : r.runs[0] || null);
    }).catch((e) => { if (live) setError(e.message); });
    poll(); const timer = setInterval(poll, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [base, definition?.id]);
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
  const create = () => task(async () => {
    const r = await api.post(base, { name: newName }); setDefinitions((list) => [...list, r.definition]); open(r.definition);
  });
  const start = () => task(async () => {
    requestId.current ||= crypto.randomUUID();
    const r = await api.post(`${base}/${definition.id}/runs`, { input, requestId: requestId.current });
    setRun(r.run); setRuns((list) => [r.run, ...list.filter((v) => v.id !== r.run.id)]); requestId.current = null;
  });
  const control = (action) => task(async () => {
    const attempt = run.attempts.at(-1);
    const r = await api.post(`${base}/${definition.id}/runs/${run.id}/${action}`, { revision: run.revision, nodeId: run.cursor, visit: attempt?.visit }); setRun(r.run);
  });
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
  return <div className="page automations-page">
    <header className="automation-heading"><div><h1>Workflows</h1><p className="muted">Build repeatable agent tasks with checks, branches, and human approvals.</p></div>
      <div className="automation-actions"><input aria-label="New workflow name" value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} /><button className="btn" disabled={busy || !newName.trim() || dirty} onClick={create}>New SDLC workflow</button></div></header>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading workflows…</p> : <>
      <div className="automation-actions"><label>Workflow <select aria-label="Workflow" value={definition?.id || ''} disabled={dirty || busy} onChange={(e) => open(definitions.find((d) => d.id === e.target.value))}><option value="" disabled>Select a workflow</option>{definitions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        {definition && <><button className="btn" disabled={busy || !dirty} onClick={() => task(async () => { await save(); setNotice('Draft saved.'); })}>Save draft</button><button className="btn" disabled={busy} onClick={publish}>Publish version</button><button className="btn" disabled={busy} onClick={() => task(async () => { const r = await api.get(`${base}/${definition.id}/versions`); setVersions(r.versions); })}>Version history</button>{dirty && <><span className="muted">Unsaved changes</span><button className="btn" onClick={() => open(definitions.find((d) => d.id === definition.id))}>Discard changes</button></>}</>}
      </div>
      {!definition ? <p>Create an SDLC workflow to begin. You can change every stage before publishing.</p> : <>
        {versions && <section className="automation-versions"><h2>Published versions</h2><button className="btn" onClick={() => setVersions(null)}>Close history</button>{versions.length ? versions.map((v) => <div key={v.version}><strong>Version {v.version}</strong> · {new Date(v.created_at).toLocaleString()} <button className="btn" disabled={dirty} onClick={() => { const f = toFlow(v.graph); setGraph(v.graph); setNodes(f.nodes); setEdges(f.edges); setDirty(true); setVersions(null); }}>Copy to draft</button></div>) : <p>No published versions yet.</p>}</section>}
        <div className="automation-settings">
          <label>Name<input value={definition.name} maxLength={120} onChange={(e) => { setDefinition((d) => ({ ...d, name: e.target.value })); setDirty(true); }} /></label>
          <label>Engine<select value={graph.engine} onChange={(e) => updateGraph({ engine: e.target.value, budgetUsd: ['codex', 'kiro'].includes(e.target.value) ? null : graph.budgetUsd })}><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="kiro">Kiro</option><option value="demo">Demo</option></select></label>
          <label>Step limit<input type="number" min="1" max="100" value={graph.maxSteps} onChange={(e) => updateGraph({ maxSteps: Number(e.target.value) })} /></label>
          <label>Time limit (minutes)<input type="number" min="1" max="1440" value={graph.timeoutMinutes} onChange={(e) => updateGraph({ timeoutMinutes: Number(e.target.value) })} /></label>
          <label>USD budget (optional)<input type="number" min="0.01" max="1000" step="0.01" value={graph.budgetUsd ?? ''} disabled={['codex', 'kiro'].includes(graph.engine)} onChange={(e) => updateGraph({ budgetUsd: e.target.value ? Number(e.target.value) : null })} /></label>
        </div>
        <fieldset className="automation-repos"><legend>Repositories</legend>{repos.length ? repos.map((r) => <label key={r.id}><input type="checkbox" checked={graph.repoIds.includes(r.id)} onChange={(e) => updateGraph({ repoIds: e.target.checked ? [...graph.repoIds, r.id] : graph.repoIds.filter((id) => id !== r.id) })} />{r.name}</label>) : <span className="muted">Connect a repository in Workspaces to use it here.</span>}</fieldset>
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
        <section className="automation-execution"><div className="automation-actions"><h2>Execution</h2><span className="muted">Published version: {definition.published_version ?? 'none'}</span></div>
          {!available && <p role="status">Durable execution is not configured on this deployment.</p>}
          <label>Run request<textarea rows={2} value={input} maxLength={2000} onChange={(e) => { setInput(e.target.value); requestId.current = null; }} placeholder="Describe what this workflow should build…" /></label>
          <button className="btn btn-primary" disabled={busy || !available || definition.published_version === null || dirty} onClick={start}>Run published workflow</button>
          <p className="muted">Runs continue when this page closes. Each agent task has a 12 minute limit. Subscription usage is bounded by time and step limits; dollar budgets apply only to priced providers.</p>
          <label>Run history<select value={run?.id || ''} onChange={(e) => setRun(runs.find((r) => r.id === e.target.value))}><option value="" disabled>No runs</option>{runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.started_at).toLocaleString()} · v{r.version} · {r.status}</option>)}</select></label>
          {run && <><div className="automation-actions"><strong>{run.status}{run.cancelRequested ? ' · cancellation requested' : ''}</strong><a href={href(projectId, 'sessions', run.session_id)}>Open session, logs & artifacts</a>{['running', 'waiting'].includes(run.status) && <button className="btn" disabled={busy || run.cancelRequested} onClick={() => control('cancel')}>Cancel run</button>}{run.status === 'waiting' && <button className="btn btn-primary" disabled={busy} onClick={() => control('approve')}>Approve {run.attempts.at(-1)?.label}</button>}</div>
            {run.status === 'waiting' && <p>{runGraph?.nodes.find((n) => n.id === run.cursor)?.prompt}</p>}
            {run.error && <p role="alert">{run.error}</p>}
            {executionFlow && <div style={{ height: 320 }} aria-label={`Execution graph version ${run.version}`}><ReactFlow key={run.id} nodes={executionFlow.nodes} edges={executionFlow.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} fitView colorMode="dark"><Background /><Controls showInteractive={false} /></ReactFlow></div>}
            <ol className="automation-timeline">{run.attempts.map((a, i) => <li key={`${a.nodeId}-${i}`} className={a.status}><strong>{a.label}</strong><span>{a.status} · attempt {a.visit}</span>{a.output && <pre>{a.output}</pre>}</li>)}</ol>
          </>}
        </section>
      </>}
    </>}
  </div>;
}
