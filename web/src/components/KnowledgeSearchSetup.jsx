import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Search setup for a project's Knowledge: choose how documents are found and prepare it.
 *   keyword     nothing to set up
 *   embeddings  the portal's own meaning-based index (index the documents once; new uploads are indexed automatically)
 *   kb          an Amazon Bedrock Knowledge Base with S3 Vectors (copy and sync the documents)
 */

const OPTIONS = [
  { id: 'keyword', title: 'Keywords', blurb: 'Matches the exact words of your question. Nothing to set up.' },
  { id: 'embeddings', title: 'Meaning (portal index)', blurb: 'Finds passages that mean the same even when the words differ ("time off" finds "annual leave"), and keeps exact-word matches too. Stays in your AWS account; costs a fraction of a cent per document.' },
  { id: 'kb', title: 'AWS Knowledge Base', blurb: 'One Amazon Bedrock Knowledge Base (S3 Vectors) shared by every project; each project only ever searches its own documents. Good for large document sets.' },
];

function Result({ r }) {
  if (!r) return null;
  return <p className={r.ok ? 'success-note' : 'error-note'} role="status">{r.message}</p>;
}

export function KnowledgeSearchSetup({ projectId, onClose, onChanged }) {
  const base = `/api/projects/${projectId}/knowledge/search-setup`;
  const [info, setInfo] = useState(null);
  const [choice, setChoice] = useState('keyword');
  const [kbForm, setKbForm] = useState({ knowledgeBaseId: '', dataSourceId: '', region: 'ap-southeast-1' });
  const [busy, setBusy] = useState(null); // 'index' | 'sync' | 'test:<backend>' | 'save'
  const [test, setTest] = useState({});
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get(base);
      setInfo(r);
      return r;
    } catch (e) {
      setError(e.message || 'Could not load the search setup');
      return null;
    }
  }, [base]);

  useEffect(() => { load().then((r) => { if (r) setChoice(r.backend); }); }, [load]);

  // While documents are being indexed or synced, keep the numbers fresh.
  const working = info && ((info.embeddings.indexed < info.total && busy === 'index')
    || ['STARTING', 'IN_PROGRESS'].includes(info.kb?.sync?.status));
  useEffect(() => {
    if (!working) return undefined;
    const t = setInterval(() => { load(); }, 3000);
    return () => clearInterval(t);
  }, [working, load]);

  useEffect(() => {
    if (busy === 'index' && info && info.embeddings.indexed >= info.total) setBusy(null);
  }, [busy, info]);

  const run = async (name, fn) => {
    setBusy(name);
    setError(null);
    try { await fn(); } catch (e) { setError(e.message || 'That did not work'); setBusy(null); return; }
    if (name !== 'index') setBusy(null);
  };

  const indexAll = () => run('index', async () => { await api.post(`${base}/index`, {}); await load(); });
  const syncNow = () => run('sync', async () => { await api.post(`${base}/sync`, {}); await load(); });
  const testIt = (backend) => run(`test:${backend}`, async () => {
    const r = await api.post(`${base}/test`, { backend });
    setTest((t) => ({ ...t, [backend]: r }));
  });
  const createKb = () => run('create', async () => { await api.post('/api/knowledge-base', {}); await load(); });
  const removeKb = () => run('remove', async () => { await api.delete('/api/knowledge-base'); setConfirmRemove(false); await load(); });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = () => run('save', async () => {
    const body = { backend: choice };
    if (choice === 'kb' && !info.kb.configured) body.kb = kbForm;
    await api.put(base, body);
    onChanged?.(choice);
    onClose();
  });

  const total = info?.total ?? 0;
  const kb = info?.kb;
  const needsIndex = choice === 'embeddings' && info && total > 0 && info.embeddings.indexed === 0;
  const needsKb = choice === 'kb' && info && !kb.configured && !(!kb.creatable && kbForm.knowledgeBaseId && kbForm.dataSourceId);
  const sync = kb?.sync;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="kss-title">
      <div className="modal kss-modal">
        <div className="modal-header">
          <h2 id="kss-title">Search setup</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="muted small">How this project's documents are found by Search and Ask. {info ? `${total} document${total === 1 ? '' : 's'} ready.` : ''}</p>
        {error && <p className="error-note" role="alert">{error}</p>}
        {!info && !error && <p className="muted">Loading…</p>}

        {info && OPTIONS.map((o) => (
          <section key={o.id} className={`kss-option${choice === o.id ? ' is-chosen' : ''}`}>
            <label className="kss-option-head">
              <input type="radio" name="kss-backend" checked={choice === o.id} onChange={() => setChoice(o.id)} />
              <span>
                <strong>{o.title}</strong>
                {info.backend === o.id && <span className="badge badge-ok kss-now">in use</span>}
                <span className="muted small kss-blurb">{o.blurb}</span>
              </span>
            </label>

            {choice === o.id && o.id === 'embeddings' && (
              <div className="kss-body">
                <p className="small">
                  <strong>{info.embeddings.indexed}</strong> of {total} document{total === 1 ? '' : 's'} indexed
                  <span className="muted"> · model {info.embeddings.model}</span>
                </p>
                <div className="kss-actions">
                  <button type="button" className="btn btn-sm btn-primary" onClick={indexAll} disabled={busy !== null || total === 0}>
                    {busy === 'index' ? 'Indexing…' : info.embeddings.indexed ? 'Re-index all documents' : 'Index documents'}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => testIt('embeddings')} disabled={busy !== null}>
                    {busy === 'test:embeddings' ? 'Testing…' : 'Test'}
                  </button>
                </div>
                <Result r={test.embeddings} />
                <p className="field-hint">New uploads are indexed automatically once this is chosen. Re-index after a model change.</p>
              </div>
            )}

            {choice === o.id && o.id === 'kb' && (
              <div className="kss-body">
                {kb.configured ? (
                  <>
                    <p className="small">
                      Knowledge Base <code>{kb.knowledgeBaseId}</code> · data source <code>{kb.dataSourceId}</code> · {kb.region}
                      <span className="muted"> ({kb.source === 'shared' ? 'shared by all projects' : 'entered by hand'})</span>
                    </p>
                    <p className="small"><strong>{kb.copied}</strong> of {total} document{total === 1 ? '' : 's'} copied to the data source
                      {sync ? <> · last sync <strong>{sync.status.toLowerCase().replace('_', ' ')}</strong>{sync.documents ? `, ${sync.documents.indexed} indexed, ${sync.documents.failed} failed` : ''}</> : ' · not synced yet'}
                    </p>
                    {kb.syncError && <p className="error-note">Could not read the sync state: {kb.syncError}</p>}
                    <div className="kss-actions">
                      <button type="button" className="btn btn-sm btn-primary" onClick={syncNow} disabled={busy !== null || total === 0}>
                        {busy === 'sync' ? 'Starting…' : 'Copy documents and sync'}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => testIt('kb')} disabled={busy !== null}>
                        {busy === 'test:kb' ? 'Testing…' : 'Test'}
                      </button>
                    </div>
                    <Result r={test.kb} />
                    <p className="field-hint">The Knowledge Base reads documents only when it syncs. Uploads start a sync automatically once this is chosen; a sync takes a minute or two.</p>
                    {kb.source === 'shared' && info.canAdminister && (
                      <p className="field-hint">
                        {confirmRemove ? (
                          <>Remove the shared Knowledge Base for <strong>all projects</strong>? Their documents are kept; projects using it fall back to keywords.{' '}
                            <button type="button" className="link-btn" onClick={removeKb} disabled={busy !== null}>{busy === 'remove' ? 'Removing…' : 'Yes, remove it'}</button>{' · '}
                            <button type="button" className="link-btn" onClick={() => setConfirmRemove(false)}>Keep it</button></>
                        ) : (
                          <button type="button" className="link-btn" onClick={() => setConfirmRemove(true)}>Remove the shared Knowledge Base…</button>
                        )}
                      </p>
                    )}
                  </>
                ) : kb.creatable ? (
                  <>
                    <p className="small">
                      There is no Knowledge Base yet. One is created for the whole portal and shared by every project: each project's documents carry
                      their project's label, and a search only asks for its own. Creating it takes about a minute and costs nothing until documents are synced.
                    </p>
                    <div className="kss-actions">
                      <button type="button" className="btn btn-sm btn-primary" onClick={createKb} disabled={busy !== null || !info.canAdminister}>
                        {busy === 'create' ? 'Creating… (about a minute)' : 'Create the shared Knowledge Base'}
                      </button>
                    </div>
                    {!info.canAdminister && <p className="field-hint">Only an admin can create it. Ask one to open this popup and press the button.</p>}
                  </>
                ) : (
                  <>
                    <p className="small">
                      This portal's stack does not have the Knowledge Base prerequisites (vector index and role); deploy the latest stack to get a
                      one-click setup, or enter the ids of a Knowledge Base you already have.
                    </p>
                    <div className="kss-fields">
                      <div className="field">
                        <label htmlFor="kss-kb">Knowledge Base id</label>
                        <input id="kss-kb" value={kbForm.knowledgeBaseId} onChange={(e) => setKbForm((f) => ({ ...f, knowledgeBaseId: e.target.value.trim() }))} placeholder="ABCDEFGHIJ" maxLength={10} spellCheck={false} />
                      </div>
                      <div className="field">
                        <label htmlFor="kss-ds">Data source id</label>
                        <input id="kss-ds" value={kbForm.dataSourceId} onChange={(e) => setKbForm((f) => ({ ...f, dataSourceId: e.target.value.trim() }))} placeholder="KLMNOPQRST" maxLength={10} spellCheck={false} />
                      </div>
                      <div className="field">
                        <label htmlFor="kss-region">Region</label>
                        <input id="kss-region" value={kbForm.region} onChange={(e) => setKbForm((f) => ({ ...f, region: e.target.value.trim() }))} />
                      </div>
                    </div>
                    <p className="field-hint">The data source must read <code>kb/</code> in the portal's storage bucket, where the portal copies each document's Markdown.</p>
                  </>
                )}
              </div>
            )}
          </section>
        ))}

        {needsIndex && <p className="field-hint">Index the documents first, or Search and Ask will use keywords until they are.</p>}
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy === 'save'}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!info || busy !== null || needsKb}>
            {busy === 'save' ? 'Saving…' : choice === info?.backend ? 'Done' : 'Use this search'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default KnowledgeSearchSetup;
