import { useEffect, useRef, useState } from 'react';

function stepCount(graph, kind, noun) {
  const count = graph.nodes.filter((node) => node.kind === kind).length;
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function AutomationTemplateLibrary({ templates, busy, onBack, onUse, onEdit, onReset, onDelete, onNew, renderPreview }) {
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState(null);
  const previewRef = useRef(null);
  useEffect(() => { if (previewId) previewRef.current?.focus(); }, [previewId]);
  const preview = templates.find((template) => template.id === previewId);
  const matches = (template) => `${template.name} ${template.description} ${template.category || ''}`.toLowerCase().includes(query.trim().toLowerCase());
  return <>
    <header className="automation-heading"><div><h1>Workflow templates</h1><p className="muted">Reusable starting points for this project. Creating a workflow takes a copy; later template edits do not change existing workflows or runs.</p></div><div className="automation-actions"><button type="button" className="btn" onClick={onBack}>Back to workflows</button><button type="button" className="btn btn-primary" disabled={busy || !templates.length} onClick={onNew}>New user template</button></div></header>
    <label className="automation-template-search">Search templates<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by task, name or category" /></label>
    {[['system', 'System templates', 'Provided by the portal. Customize for this project and reset to the shipped default whenever needed.'], ['user', 'User templates', 'Created by your team for this project. Edit, reuse or delete them independently of system templates.']].map(([source, title, description]) => {
      const items = templates.filter((template) => template.source === source || (source === 'system' && !template.source)).filter(matches);
      return <section className="automation-template-section" key={source} aria-label={title}>
        <header><h2>{title} <span className="muted small">({items.length})</span></h2><p className="muted">{description}</p></header>
        <div className="automation-template-grid">{items.map((template) => <article className="automation-template-card" key={template.id} aria-label={template.name}>
          <div className="automation-template-badges"><span className="badge">{template.category || 'Workflow'}</span><span className={`badge${template.customized ? ' badge-info' : ''}`}>{source === 'system' ? template.customized ? 'Project override' : 'System default' : 'User template'}</span>{template.updateAvailable && <span className="badge">New default available</span>}</div>
          <h3>{template.name}</h3><p>{template.description || 'A reusable workflow created for this project.'}</p>
          {template.inputHint && <p className="automation-template-input"><strong>Input:</strong> {template.inputHint}</p>}
          <small className="muted">{stepCount(template.graph, 'agent', 'agent task')} · {stepCount(template.graph, 'approval', 'approval gate')}</small>
          <div className="automation-template-actions"><button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onUse(template)}>Use template</button><button type="button" className="btn btn-sm" onClick={() => setPreviewId(template.id)}>Preview</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => onEdit(template)}>{source === 'system' ? template.customized ? 'Edit project override' : 'Customize for project' : 'Edit template'}</button>{source === 'system' && template.customized && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onReset(template)}>Reset to default</button>}{source === 'user' && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onDelete(template)}>Delete template</button>}</div>
        </article>)}</div>
        {!items.length && <p className="automation-template-empty">{query ? 'No matching templates in this section.' : source === 'user' ? 'No user templates yet. Create one here or save a workflow as a template.' : 'No system templates available.'}</p>}
      </section>;
    })}
    {preview && <section className="automation-template-preview" aria-label="Template preview" tabIndex={-1} ref={previewRef}><header className="automation-heading"><h2>{preview.name}</h2><button type="button" className="btn btn-sm" onClick={() => setPreviewId(null)}>Close preview</button></header>{renderPreview(preview)}</section>}
  </>;
}
