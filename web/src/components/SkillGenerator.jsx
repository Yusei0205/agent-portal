import { useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useLoad } from '../lib/useAsync.js';
import { href } from '../lib/router.js';
import { Button, Field, ErrorNote, Spinner } from './ui.jsx';
import { Markdown } from './Markdown.jsx';

export function SkillGenerator({ onSaved, onCancel }) {
  const { project, canEdit } = useProject();
  const base = `/api/projects/${project.id}`;
  const docs = useLoad(() => api.get(`${base}/documents`), [base]);
  const [docId, setDocId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const [sources, setSources] = useState([]);
  const [preview, setPreview] = useState(false);
  if (!canEdit) return null;
  const documents = (docs.data?.documents || []).filter((d) => d.kind === 'upload');
  const update = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  const act = async (kind, fn) => {
    setBusy(kind); setError(null);
    try { await fn(); } catch (e) { setError(e); } finally { setBusy(''); }
  };
  const upload = (file) => {
    if (!file) return;
    if (file.size > docs.data.maxUploadMb * 1024 * 1024) {
      setError(new Error(`Maximum upload: ${docs.data.maxUploadMb} MB.`)); return;
    }
    act('upload', async () => {
      const { document } = await api.upload(`${base}/documents?name=${encodeURIComponent(file.name)}`, file);
      await docs.reload(true);
      setDocId(document.id);
    });
  };
  return <section className="panel stack-lg" aria-label="Generate skill from document">
    <div><h2>{draft ? 'Review generated skill' : 'Generate from document'}</h2>
      <p className="muted">Turn documented company practices and workflows into a skill. Review and edit the draft before saving it for agents to use.</p>
      <p className="muted small">Drafts stay in this page until saved. Leaving or discarding removes the draft.</p></div>
    <ErrorNote error={error || docs.error} />
    {docs.loading ? <Spinner /> : !draft ? <form className="stack" onSubmit={(e) => {
      e.preventDefault(); act('generate', async () => {
        const result = await api.post(`${base}/skills/generate`, { docId });
        setDraft(result.draft); setSources(result.sources || []);
      });
    }}>
      <Field label="Source document">{(id) => <select id={id} className="input" value={docId} onChange={(e) => setDocId(e.target.value)} required disabled={!!busy}>
        <option value="">Choose an uploaded document</option>
        {documents.map((d) => <option key={d.id} value={d.id} disabled={d.status !== 'ready'}>{d.name}{d.status !== 'ready' ? ` (${d.status})` : ''}</option>)}
      </select>}</Field>
      <Field label="Or upload a document" hint={docs.data ? `Maximum upload: ${docs.data.maxUploadMb} MB. For long documents, upload a focused excerpt (up to 60,000 characters).` : ''}>
        {(id) => <input id={id} className="input" type="file" disabled={!!busy || !docs.data} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />}
      </Field>
      <div className="row wrap">
        <Button type="submit" variant="primary" busy={busy === 'generate'} disabled={!docId || !!busy}>Generate draft</Button>
        <Button type="button" onClick={onCancel} disabled={!!busy}>Cancel</Button>
        {busy ? <span role="status">{busy === 'upload' ? 'Uploading document…' : 'Generating draft…'}</span> : null}
      </div>
    </form> : <form className="stack" onSubmit={(e) => {
      e.preventDefault(); act('save', async () => {
        const { skill } = await api.put(`${base}/skills/${encodeURIComponent(draft.name.trim())}`, { ...draft, createOnly: true });
        await onSaved(skill);
      });
    }}>
      <fieldset className="stack" disabled={!!busy}>
        <Field label="Skill name" hint="Lowercase letters, digits and hyphens; choose a new name.">{(id) => <input id={id} className="input mono" value={draft.name} onChange={update('name')} required pattern="[a-z0-9][a-z0-9-]{0,62}" maxLength={63} />}</Field>
        <Field label="When should agents use it?">{(id) => <textarea id={id} className="input" value={draft.description} onChange={update('description')} required maxLength={1024} rows={3} />}</Field>
        <Field label="Skill instructions (Markdown)">{(id) => <textarea id={id} className="input mono" value={draft.body} onChange={update('body')} required maxLength={100000} rows={18} />}</Field>
      </fieldset>
      <Button type="button" onClick={() => setPreview(!preview)}>{preview ? 'Hide preview' : 'Preview instructions'}</Button>
      {preview ? <div className="md-preview"><Markdown text={draft.body} /></div> : null}
      <details><summary>Source sections</summary><ul>{sources.map((s, i) => <li key={i}><a href={href(project.id, 'knowledge', 'doc', s.docId, s.anchor)} target="_blank" rel="noreferrer">{s.docName} › {s.heading}</a></li>)}</ul></details>
      <p className="muted">Check the draft against the source and remove unsupported instructions. Approving creates a skill available to agents. You can select it in an agent’s Skills settings.</p>
      <div className="row wrap">
        <Button type="submit" variant="primary" busy={busy === 'save'} disabled={!!busy || !draft.name.trim() || !draft.description.trim() || !draft.body.trim()}>Approve and save skill</Button>
        <Button type="button" onClick={onCancel} disabled={!!busy}>Discard draft</Button>
      </div>
    </form>}
  </section>;
}
