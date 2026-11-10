import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { MODES, fileToBase64 } from '../lib/simulation.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { FlagBadge } from '../components/FlagBadge.jsx';
import { AiChoicePicker } from '../components/AiChoicePicker.jsx';
import { SimulationDetail } from './SimulationDetail.jsx';

/**
 * API simulation — a stand-in for a client's REST API while theirs is not ready.
 *
 * Import the client's specification (Excel requirement sheets or OpenAPI), fix what the importer could not know (the
 * URL path), approve it, and the portal answers calls as that API. Anything the importer was unsure about is marked
 * with an exclamation icon; those are warnings, never blockers.
 */

function statusBadge(a) {
  if (a.approvedVersion === 0) return <span className="badge badge-warn">Draft · not answering yet</span>;
  const newer = a.latestVersion > a.approvedVersion;
  return (
    <>
      <span className="badge badge-ok">Approved v{a.approvedVersion}</span>
      {newer && <span className="badge badge-neutral">v{a.latestVersion} waiting for review</span>}
    </>
  );
}

// ── Import dialog ─────────────────────────────────────────────────────────────

/** What a finished import shows, whichever way it was read. */
function ImportResult({ result }) {
  const created = result.created || [];
  const problems = result.errors || [];
  const notes = [...new Set([...(result.notes || []), ...(result.flags || []).map((f) => f.message)])];
  return (
    <div className="stack" role="status">
      <p><strong>{created.length}</strong> API{created.length === 1 ? '' : 's'} imported as draft{created.length === 1 ? '' : 's'}:</p>
      <ul className="sim-import-list">
        {created.map((c) => (
          <li key={c.id}>{c.name} <span className="muted small">{c.isNew ? 'new' : `new version v${c.version}`}</span></li>
        ))}
      </ul>
      {result.skippedSheets?.length > 0 && (
        <p className="muted small">Skipped {result.skippedSheets.length} sheet{result.skippedSheets.length === 1 ? '' : 's'} that are not API definitions: {result.skippedSheets.join(', ')}.</p>
      )}
      {problems.length > 0 && (
        <div className="sim-callout">
          <Icon name="warning" size={15} />
          <div>
            <strong>{problems.length} could not be read</strong>
            <ul>{problems.map((p) => <li key={p.api}>{p.api}: {p.message}</li>)}</ul>
          </div>
        </div>
      )}
      {notes.length > 0 && (
        <div className="sim-callout">
          <Icon name="info" size={15} />
          <div>
            <strong>Worth knowing</strong>
            <ul>{notes.map((m) => <li key={m}>{m}</li>)}</ul>
          </div>
        </div>
      )}
      <p className="muted small">Next: open each API, enter its URL path if the document did not give one, review the items marked with the exclamation icon, then approve.</p>
    </div>
  );
}

const PHASES = { queued: 'Starting…', outline: 'Finding the APIs in the document…', extract: 'Reading the APIs…' };

function ImportDialog({ projectId, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('ai'); // ai | layout (Excel only)
  const [ai, setAi] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [job, setJob] = useState(null);
  const input = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const ext = file ? (file.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase() : '';
  const kind = ext === '.json' ? 'json' : ext === '.docx' ? 'docx' : ext === '.xlsx' ? 'xlsx' : '';
  const useAi = kind === 'docx' || (kind === 'xlsx' && mode === 'ai');

  const finish = (r) => { setResult(r); onDone(); };

  const readWithAi = async () => {
    const fd = new FormData();
    fd.append('file', file);
    const up = await api.upload(`/api/projects/${projectId}/ai-attachments`, fd);
    const { jobId } = await api.post(`/api/projects/${projectId}/sim/import-ai`, {
      attachmentId: up.attachment.id, credentialId: ai.credentialId || undefined, model: ai.model || undefined,
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!alive.current) return;
      const { job: j } = await api.get(`/api/projects/${projectId}/sim/import-jobs/${jobId}`);
      setJob(j);
      if (j.status === 'running') continue;
      if (j.status === 'failed') throw new Error(j.error || 'The document could not be read.');
      finish(j);
      return;
    }
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    setJob(null);
    try {
      if (useAi) {
        await readWithAi();
      } else if (kind === 'json') {
        let spec;
        try { spec = JSON.parse(await file.text()); } catch { throw new Error('That file is not valid JSON.'); }
        // A Postman collection is also JSON: it has "info" and a list of "item".
        const body = spec && Array.isArray(spec.item) && spec.info ? { kind: 'postman', collection: spec } : { kind: 'openapi', spec };
        finish(await api.post(`/api/projects/${projectId}/sim/import`, body));
      } else {
        finish(await api.post(`/api/projects/${projectId}/sim/import`, { kind: 'xlsx', contentBase64: await fileToBase64(file) }));
      }
    } catch (e) {
      setError(e.message || 'Import failed');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Import a client API specification">
      <div className="modal modal-wide">
        <div className="modal-header">
          <h2>Import a client API specification</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close" disabled={busy && useAi}><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body stack">
          {!result && (
            <>
              <p className="muted small">
                A Word or Excel document in any layout is read by AI. An OpenAPI file or a Postman collection (JSON) is already structured
                and is read directly, with no AI. Importing an updated document again adds a new version to the APIs it recognises, and
                the changes show on the review screen.
              </p>
              <div className="field">
                <label htmlFor="sim-file">File</label>
                <input id="sim-file" ref={input} type="file" accept=".xlsx,.docx,.json" disabled={busy}
                  onChange={(e) => { setFile(e.target.files?.[0] || null); setError(''); setMode('ai'); }} />
                {file && !kind && <span className="field-hint">Choose a .docx, .xlsx or .json file.</span>}
                {kind === 'json' && <span className="field-hint">OpenAPI or Postman: read directly, no AI needed.</span>}
              </div>

              {kind === 'xlsx' && (
                <fieldset className="field" disabled={busy} style={{ border: 0, padding: 0 }}>
                  <legend className="field-label">How to read the workbook</legend>
                  <label className="sim-check small"><input type="radio" name="how" checked={mode === 'ai'} onChange={() => setMode('ai')} /> <span><strong>With AI</strong> <span className="muted">(works with any layout)</span></span></label>
                  <label className="sim-check small"><input type="radio" name="how" checked={mode === 'layout'} onChange={() => setMode('layout')} /> <span><strong>By a fixed layout, without AI</strong> <span className="muted">(only for workbooks laid out like the FLASH sample: one sheet per API with “1. Request” and “2. Response” tables)</span></span></label>
                </fieldset>
              )}

              {useAi && (
                <div className="stack">
                  <AiChoicePicker onChange={setAi} disabled={busy} idPrefix="simimp" />
                  <p className="muted small" style={{ margin: 0 }}>
                    The model is called once to find the APIs and once for each API, so a long document takes a few minutes. What it reads is
                    marked with “Read from the document by AI” on the review screen: check it against the original.
                  </p>
                </div>
              )}

              {busy && useAi && (
                <div className="sim-progress" role="status" aria-live="polite">
                  <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
                  <span>
                    {job ? (PHASES[job.phase] || 'Working…') : 'Uploading the document…'}
                    {job?.phase === 'extract' && job.total > 0 && ` ${Math.min(job.done + 1, job.total)} of ${job.total}${job.current ? `: ${job.current}` : ''}`}
                  </span>
                </div>
              )}
              {error && <p className="error-note" role="alert">{error}</p>}
            </>
          )}
          {result && <ImportResult result={result} />}
        </div>
        <div className="modal-footer">
          {!result && <button type="button" className="btn" onClick={onClose} disabled={busy && useAi}>Cancel</button>}
          {!result && <button type="button" className="btn btn-primary" disabled={!file || !kind || busy} onClick={submit}>{busy ? (useAi ? 'Reading…' : 'Importing…') : (useAi ? 'Read with AI' : 'Import')}</button>}
          {result && <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function Simulation({ projectId }) {
  const [apis, setApis] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [openId, setOpenId] = useState(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    if (!projectId) { setLoading(false); return; }
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/sim/apis`);
      setApis(r.apis || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const remove = async (a) => {
    if (!await requestConfirm(`Delete “${a.name}” with all its versions and mock rules? Anything calling it will get an error.`, 'Delete', 'danger')) return;
    try {
      await api.delete(`/api/projects/${projectId}/sim/apis/${a.id}`);
      setApis((prev) => prev.filter((x) => x.id !== a.id));
    } catch (e) { toast(e.message, 'error'); }
  };

  const open = apis.find((a) => a.id === openId);
  if (open) {
    return (
      <>
        <ToastShelf toasts={toasts} onRemove={removeToast} />
        <SimulationDetail
          projectId={projectId}
          apiId={open.id}
          onBack={() => { setOpenId(null); load(); }}
          onChanged={load}
          toast={toast}
        />
      </>
    );
  }

  return (
    <div className="page">
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <PageHeader
        title="API simulation"
        description="A stand-in for a client’s REST API while theirs is not ready. Import their specification, check what the importer was unsure about, approve it, and the portal answers calls as that API."
      >
        {projectId && (
          <button type="button" className="btn btn-primary" onClick={() => setImporting(true)}>
            <Icon name="upload" size={14} /> Import specification
          </button>
        )}
      </PageHeader>

      {!projectId && <div className="card"><p className="muted">Open a project to simulate APIs for it.</p></div>}
      {projectId && loading && <p className="muted">Loading…</p>}
      {projectId && error && <p className="error-note" role="alert">{error}</p>}

      {projectId && !loading && !error && apis.length === 0 && (
        <div className="card sim-empty">
          <Icon name="plug" size={22} />
          <div>
            <strong>No simulated APIs yet</strong>
            <p className="muted">Import the client’s requirement workbook (.xlsx) or an OpenAPI file. Every sheet that has a request and a response table becomes one API.</p>
          </div>
        </div>
      )}

      {projectId && apis.length > 0 && (
        <div className="sim-cards">
          {apis.map((a) => (
            <article key={a.id} className="card sim-card">
              <header className="sim-card-head">
                <h3>{a.name}</h3>
                <span className={`badge badge-${a.mode === 'mock' ? 'neutral' : a.mode === 'live' ? 'warn' : 'info'}`}>
                  {MODES.find((m) => m.id === a.mode)?.label || a.mode}
                </span>
                {statusBadge(a)}
                <FlagBadge flags={a.flags} />
              </header>
              <ul className="sim-ops">
                {a.operations.map((o) => (
                  <li key={o.operationId}><span className="sim-method">{o.method.toUpperCase()}</span> <code>{o.path}</code></li>
                ))}
              </ul>
              <footer className="sim-card-foot">
                <span className="muted small">Updated {formatRelative(a.updatedAt)}</span>
                <span className="spacer" />
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpenId(a.id)}>Review</button>
                <button type="button" className="btn-icon" title="Delete" aria-label={`Delete ${a.name}`} onClick={() => remove(a)}>
                  <Icon name="trash" size={14} />
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}

      {importing && <ImportDialog projectId={projectId} onClose={() => setImporting(false)} onDone={load} />}
    </div>
  );
}

export default Simulation;
