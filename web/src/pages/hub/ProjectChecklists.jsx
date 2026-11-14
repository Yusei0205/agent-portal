import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import './project-checklists.css';

const empty = () => ({ revision: 0, targets: [], items: [], analysis: [] });
const newId = () => crypto.randomUUID();
const statuses = ['pending', 'in_progress', 'approved', 'blocked', 'not_applicable'];

export function ProjectChecklists({ projectId, canEdit }) {
  const [doc, setDoc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState('all');
  const [provider, setProvider] = useState('all');
  const endpoint = `/api/projects/${projectId}/checklists`;
  useEffect(() => {
    let active = true;
    setDoc(null); setDirty(false); setError('');
    api.get(endpoint).then((r) => { if (active) setDoc(r.checklist || empty()); }).catch((e) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [endpoint]);
  useEffect(() => {
    const warn = (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const change = (next) => { setDoc(next); setDirty(true); setMessage(''); };
  const itemChange = (id, field, value) => change({ ...doc, items: doc.items.map((i) => i.id === id ? { ...i, [field]: value } : i) });
  async function save() {
    const result = await api.put(endpoint, { revision: doc.revision, targets: doc.targets, items: doc.items });
    setDoc(result.checklist); setDirty(false);
    return result.checklist;
  }
  async function run(action) {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'reload') {
        const result = await api.get(endpoint); setDoc(result.checklist || empty()); setDirty(false);
      } else if (action === 'save') { await save(); setMessage('Checklist saved.'); }
      else {
        const current = dirty ? await save() : doc;
        const result = await api.post(`${endpoint}/generate`, { revision: current.revision });
        setDoc(result.checklist); setMessage('Checklist regenerated. Saved edits and reviews were preserved.');
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  if (!doc) return <div>{error ? <><p className="error-note" role="alert">{error}</p><button className="btn" disabled={busy} onClick={() => run('reload')}>Retry</button></> : <p role="status">Loading checklists…</p>}</div>;
  const visible = doc.items.filter((i) => (kind === 'all' || i.kind === kind) && (provider === 'all' || i.targetId === provider));
  const approved = doc.items.filter((i) => i.status === 'approved').length;
  return <section className="project-checklists" aria-label="Deployment and security checklists">
    <div className="checklist-toolbar">
      <div><h2>Deployment & security</h2><p>Review repository requirements, deployment resources and security controls before release.</p></div>
      <div className="checklist-actions">
        {canEdit && <><button className="btn btn-primary" disabled={busy} onClick={() => run('generate')}>{busy ? 'Working…' : doc.generatedAt ? 'Regenerate' : 'Generate checklists'}</button><button className="btn" disabled={busy || !dirty} onClick={() => run('save')}>Save changes</button></>}
        <button className="btn" disabled={busy} onClick={() => run('reload')}>{dirty ? 'Discard changes & reload' : 'Reload'}</button>
        {doc.revision > 0 && !dirty && <><a className="btn" href={`${endpoint}/export?format=json`} download>Export JSON</a><a className="btn" href={`${endpoint}/export?format=markdown`} download>Export Markdown</a></>}
      </div>
    </div>
    {error && <p className="error-note" role="alert">{error} {dirty && 'Your unsaved edits are still here. Copy them before leaving if you need to reload a newer version.'}</p>}
    {message && <p role="status">{message}</p>}
    <p className="text-muted">{approved} of {doc.items.length} approved · Revision {doc.revision}{dirty ? ' · Unsaved changes (save to export)' : ''}{doc.generatedAt ? ` · Generated ${new Date(doc.generatedAt).toLocaleString()}` : ''}</p>
    <p className="text-muted">Static analysis supplies review prompts and file references. Approval requires a human review. Regeneration saves current changes first and keeps existing rows, notes, reviews and deletions.</p>
    <fieldset disabled={!canEdit || busy} className="checklist-providers">
      <legend>Deployment providers & services</legend>
      {doc.targets.map((target) => <div className="checklist-provider" key={target.id}>
        <label>Provider<select aria-label="Provider" value={target.provider} onChange={(e) => change({ ...doc, targets: doc.targets.map((t) => t.id === target.id ? { ...t, provider: e.target.value } : t) })}>{['aws', 'azure', 'gcp', 'custom'].map((p) => <option key={p} value={p}>{p === 'custom' ? 'Custom service' : p.toUpperCase()}</option>)}</select></label>
        <label>Service / account name<input type="text" maxLength={120} value={target.name} onChange={(e) => change({ ...doc, targets: doc.targets.map((t) => t.id === target.id ? { ...t, name: e.target.value } : t) })} /></label>
        <button className="btn" onClick={() => { change({ ...doc, targets: doc.targets.filter((t) => t.id !== target.id), items: doc.items.filter((i) => i.targetId !== target.id) }); setProvider('all'); }}>Remove provider & rows</button>
      </div>)}
      <button className="btn" disabled={doc.targets.length >= 20} onClick={() => change({ ...doc, targets: [...doc.targets, { id: newId(), provider: 'custom', name: 'New service' }] })}>Add provider / service</button>
    </fieldset>
    <details><summary>Repository analysis ({doc.analysis.length})</summary>
      {doc.analysis.length === 0 && <p>Generate to analyze the repositories added to this project. Providers are detected on the first generation, or you can add them above.</p>}
      {doc.analysis.map((repo) => <div key={repo.repoId}><h3>{repo.name}</h3><p>{repo.files} files · {repo.languages.join(', ') || 'Unclassified language'} · {repo.status}</p>{repo.warnings.map((w) => <p className="error-note" key={w}>{w}</p>)}<p>{repo.providers.length ? `Detected providers: ${repo.providers.join(', ')}` : 'No cloud provider detected; add the services you use.'}</p></div>)}
    </details>
    <div className="checklist-toolbar">
      <label>Checklist<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All checklists</option><option value="deployment">Deployment</option><option value="security">Security</option></select></label>
      <label>Provider filter<select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="all">All providers & shared</option><option value="">Shared requirements</option>{doc.targets.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.provider})</option>)}</select></label>
      {canEdit && <button className="btn" disabled={busy || doc.items.length >= 600} onClick={() => change({ ...doc, items: [...doc.items, { id: newId(), kind: kind === 'security' ? 'security' : 'deployment', targetId: provider === 'all' ? '' : provider, category: 'Custom', resource: 'New resource', requirement: 'Describe the required configuration or review.', evidence: [], status: 'pending', notes: '' }] })}>Add requirement</button>}
    </div>
    {visible.length === 0 && <p>No matching requirements. Generate checklists or add a requirement.</p>}
    {visible.map((item) => <fieldset className="checklist-item" disabled={!canEdit || busy} key={item.id}>
      <legend>{item.kind === 'deployment' ? 'Deployment' : 'Security'} · {item.category} · {item.resource}</legend>
      <div className="checklist-grid">
        <label>Checklist type<select value={item.kind} onChange={(e) => itemChange(item.id, 'kind', e.target.value)}><option value="deployment">Deployment</option><option value="security">Security</option></select></label>
        <label>Provider / service<select value={item.targetId} onChange={(e) => itemChange(item.id, 'targetId', e.target.value)}><option value="">Shared</option>{doc.targets.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.provider})</option>)}</select></label>
        <label>Category<input type="text" maxLength={120} value={item.category} onChange={(e) => itemChange(item.id, 'category', e.target.value)} /></label>
        <label>Resource name<input type="text" maxLength={240} value={item.resource} onChange={(e) => itemChange(item.id, 'resource', e.target.value)} /></label>
      </div>
      <label>Configuration / review requirement<textarea maxLength={4000} rows={2} value={item.requirement} onChange={(e) => itemChange(item.id, 'requirement', e.target.value)} /></label>
      <label>Evidence references (one file:line, URL or document reference per line)<textarea rows={2} value={item.evidence.join('\n')} onChange={(e) => itemChange(item.id, 'evidence', e.target.value.split('\n'))} onBlur={() => itemChange(item.id, 'evidence', item.evidence.map((s) => s.trim()).filter(Boolean))} /></label>
      <div className="checklist-grid"><label>Review status<select value={item.status} onChange={(e) => itemChange(item.id, 'status', e.target.value)}>{statuses.map((s) => <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>)}</select></label><label>Review notes<textarea maxLength={4000} rows={2} value={item.notes} onChange={(e) => itemChange(item.id, 'notes', e.target.value)} /></label></div>
      {item.reviewedAt && <p className="text-muted">Last reviewed {new Date(item.reviewedAt).toLocaleString()} by {item.reviewedBy}</p>}
      {canEdit && <button className="btn" onClick={() => change({ ...doc, items: doc.items.filter((i) => i.id !== item.id) })}>Remove requirement</button>}
    </fieldset>)}
  </section>;
}
