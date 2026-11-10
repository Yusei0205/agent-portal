import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { MODES, fileToBase64 } from '../lib/simulation.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { FlagBadge } from '../components/FlagBadge.jsx';
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

function ImportDialog({ projectId, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const input = useRef(null);

  const kind = file && /\.json$/i.test(file.name) ? 'openapi' : 'xlsx';

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      let body;
      if (kind === 'openapi') {
        let spec;
        try { spec = JSON.parse(await file.text()); } catch { throw new Error('That file is not valid JSON. OpenAPI must be the JSON form.'); }
        body = { kind: 'openapi', spec };
      } else {
        body = { kind: 'xlsx', contentBase64: await fileToBase64(file) };
      }
      const r = await api.post(`/api/projects/${projectId}/sim/import`, body);
      setResult(r);
      onDone();
    } catch (e) {
      setError(e.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Import a client API specification">
      <div className="modal modal-wide">
        <div className="modal-header">
          <h2>Import a client API specification</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body stack">
          {!result && (
            <>
              <p className="muted small">
                An Excel workbook where each sheet describes one API (the “1. Request” / “2. Response” field tables), or an OpenAPI
                document in JSON. Each Excel sheet becomes its own API. Importing the same file again adds a new version of each API.
              </p>
              <div className="field">
                <label htmlFor="sim-file">File</label>
                <input id="sim-file" ref={input} type="file" accept=".xlsx,.json" onChange={(e) => { setFile(e.target.files?.[0] || null); setError(''); }} />
                {file && <span className="field-hint">{kind === 'openapi' ? 'Read as OpenAPI (JSON)' : 'Read as an Excel requirement workbook'} · {(file.size / 1024).toFixed(0)} KB</span>}
              </div>
              {error && <p className="error-note" role="alert">{error}</p>}
            </>
          )}
          {result && (
            <div className="stack" role="status">
              <p><strong>{result.created.length}</strong> API{result.created.length === 1 ? '' : 's'} imported as draft{result.created.length === 1 ? '' : 's'}:</p>
              <ul className="sim-import-list">
                {result.created.map((c) => (
                  <li key={c.id}>{c.name} <span className="muted small">{c.isNew ? 'new' : `new version v${c.version}`}</span></li>
                ))}
              </ul>
              {result.skippedSheets?.length > 0 && (
                <p className="muted small">Skipped {result.skippedSheets.length} sheet{result.skippedSheets.length === 1 ? '' : 's'} that are not API definitions: {result.skippedSheets.join(', ')}.</p>
              )}
              {result.flags?.length > 0 && (
                <div className="sim-callout">
                  <Icon name="warning" size={15} />
                  <div>
                    <strong>Check these before approving</strong>
                    <ul>{[...new Set(result.flags.map((f) => f.message))].map((m) => <li key={m}>{m}</li>)}</ul>
                  </div>
                </div>
              )}
              <p className="muted small">Next: open each API, enter its URL path (the workbook does not give one), review the warnings, then approve.</p>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {!result && <button type="button" className="btn" onClick={onClose}>Cancel</button>}
          {!result && <button type="button" className="btn btn-primary" disabled={!file || busy} onClick={submit}>{busy ? 'Reading…' : 'Import'}</button>}
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
