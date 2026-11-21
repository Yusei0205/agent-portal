/**
 * GenerateCasesDialog — start a manual QA test-case generation from specs.
 *
 * POST /api/projects/:pid/tests/:tpid/case-sets
 * Body: { name?, description, attachmentIds? }
 * Response 202: { caseSet }
 *
 * An API specification is optional. When one is chosen (an API already in the simulation, or a file read just for this),
 * the cases the specification states are made at once by rule:
 * POST /api/projects/:pid/tests/:tpid/case-sets/from-api  -> 201. A description is then optional; with one, the AI
 * generation runs as well and makes its own case set.
 *
 * Props:
 *   testProjectId  - string
 *   projectId      - string
 *   onClose()      - called to close the dialog
 *   onGenerated(caseSetId, name, description) - called when AI generation is accepted (202)
 *   onCreated(result) - called when API-specification cases were made (already finished)
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { AttachmentPicker } from '../../components/AttachmentPicker.jsx';
import { fileToBase64 } from '../../lib/simulation.js';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';

export function GenerateCasesDialog({ testProjectId, projectId, onClose, onGenerated, onCreated }) {
  const [description, setDescription] = useState('');
  const [name, setName]               = useState('');
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState(null);
  const [attachmentIds, setAttachmentIds] = useState([]);
  const [uploadsBusy, setUploadsBusy] = useState(false);
  // Optional: cases from an API specification.
  const [specMode, setSpecMode]       = useState('none'); // none | sim | file
  const [simApis, setSimApis]         = useState(null);
  const [chosenApis, setChosenApis]   = useState([]);
  const [specFile, setSpecFile]       = useState(null);
  const [makeScripts, setMakeScripts] = useState(true);
  const descRef = useRef(null);
  const trapRef = useFocusTrap();

  const handleAttachments = (ids, uploading) => {
    setAttachmentIds(ids);
    setUploadsBusy(uploading);
  };

  useEffect(() => { descRef.current?.focus(); }, []);
  useEffect(() => {
    if (specMode !== 'sim' || simApis !== null) return;
    api.get(`/api/projects/${projectId}/sim/apis`).then((r) => setSimApis(r.apis || [])).catch(() => setSimApis([]));
  }, [specMode, simApis, projectId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !uploadsBusy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, uploadsBusy]);

  const hasSpec = (specMode === 'sim' && chosenApis.length > 0) || (specMode === 'file' && Boolean(specFile));
  const hasDescription = Boolean(description.trim());

  const specSource = async () => {
    if (specMode === 'sim') return { kind: 'sim', apiIds: chosenApis };
    if (/\.json$/i.test(specFile.name)) {
      let spec;
      try { spec = JSON.parse(await specFile.text()); } catch { throw new Error('That file is not valid JSON. OpenAPI must be the JSON form.'); }
      return spec && Array.isArray(spec.item) && spec.info ? { kind: 'postman', collection: spec } : { kind: 'openapi', spec };
    }
    return { kind: 'xlsx', contentBase64: await fileToBase64(specFile) };
  };

  const submit = async () => {
    if ((!hasDescription && !hasSpec) || busy || uploadsBusy) return;
    setBusy(true);
    setError(null);
    let specResult = null;
    try {
      if (hasSpec) {
        specResult = await api.post(`/api/projects/${projectId}/tests/${testProjectId}/case-sets/from-api`, {
          name: !hasDescription ? (name.trim() || undefined) : undefined,
          source: await specSource(),
          createScript: makeScripts,
        });
      }
      if (hasDescription) {
        const data = await api.post(
          `/api/projects/${projectId}/tests/${testProjectId}/case-sets`,
          {
            description:   description.trim(),
            name:          name.trim() || undefined,
            attachmentIds: attachmentIds.length ? attachmentIds : undefined,
          },
        );
        if (specResult) onCreated?.(specResult);
        onGenerated(data.caseSet.id, name.trim() || description.trim().slice(0, 60), description.trim());
      } else {
        onCreated?.(specResult);
      }
      onClose();
    } catch (e) {
      if (specResult) onCreated?.(specResult);
      setError(specResult ? `The API cases were created, but the AI generation could not start: ${e.message}` : e.message);
      setBusy(false);
    }
  };

  const canSubmit = (hasDescription || hasSpec) && !busy && !uploadsBusy;
  const overlayDismiss = useOverlayDismiss(onClose, { disabled: uploadsBusy });

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gen-cases-title"
        style={{ maxWidth: 540 }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="gen-cases-title">Generate test cases</h2>
          <button type="button" className="btn-icon" onClick={onClose} disabled={uploadsBusy} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="dialog-body stack">
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Describe what you want to test. Attach requirement docs, user stories or
            architecture diagrams and the AI will plan categories and write test case rows.
            The result downloads as Excel (Test ID, Category, Scenario, Precondition,
            Test Steps, Expected Result, Status, Remarks).
            Generation runs in the background.
          </p>

          <div className="field">
            <label htmlFor="gc-desc">
              Description{' '}
              {hasSpec
                ? <span className="muted" style={{ fontWeight: 400 }}>(optional: fill it to also get AI-written cases)</span>
                : <span aria-hidden="true">*</span>}
            </label>
            <textarea
              id="gc-desc"
              ref={descRef}
              rows={4}
              maxLength={4000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Login and registration flows for the customer portal"
              disabled={busy}
            />
          </div>

          <div className="field">
            <label htmlFor="gc-name">
              Set name <span className="muted" style={{ fontWeight: 400 }}>(optional — defaults to description)</span>
            </label>
            <input
              id="gc-name"
              type="text"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Login &amp; Registration Tests"
              disabled={busy}
            />
          </div>

          <div className="field">
            <label>Attachments <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
            <AttachmentPicker
              projectId={projectId}
              onAttachmentsChange={handleAttachments}
              disabled={busy}
            />
          </div>

          <fieldset className="field gc-spec" disabled={busy} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
            <legend className="field-label">API specification <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></legend>
            <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 8px' }}>
              Adds the cases that follow from the specification: a valid request, each required field missing, wrong types,
              values that are not allowed, over-long values and a missing login token. They are made at once, without AI.
            </p>
            <div className="row wrap" style={{ gap: 14 }}>
              <label className="sim-check"><input type="radio" name="gc-spec" checked={specMode === 'none'} onChange={() => setSpecMode('none')} /> None</label>
              <label className="sim-check"><input type="radio" name="gc-spec" checked={specMode === 'sim'} onChange={() => setSpecMode('sim')} /> An API from the simulation</label>
              <label className="sim-check"><input type="radio" name="gc-spec" checked={specMode === 'file'} onChange={() => setSpecMode('file')} /> Import a file</label>
            </div>
            {specMode === 'sim' && (
              <div className="stack" style={{ marginTop: 8 }}>
                {simApis === null && <span className="muted small">Loading…</span>}
                {simApis && simApis.length === 0 && (
                  <span className="muted small">No APIs in the simulation yet. Import a file here, or add them on the API simulation tab.</span>
                )}
                {simApis && simApis.map((a) => (
                  <label key={a.id} className="sim-check small">
                    <input
                      type="checkbox"
                      checked={chosenApis.includes(a.id)}
                      onChange={(e) => setChosenApis((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id)))}
                    />
                    <span>{a.group ? `${a.group} / ` : ''}{a.name} <span className="muted">· {a.approvedVersion > 0 ? `approved v${a.approvedVersion}` : 'draft'}</span></span>
                  </label>
                ))}
              </div>
            )}
            {specMode === 'file' && (
              <div className="field" style={{ marginTop: 8 }}>
                <input type="file" accept=".xlsx,.json" aria-label="API specification file" onChange={(e) => setSpecFile(e.target.files?.[0] || null)} />
                <span className="field-hint">An Excel requirement workbook, an OpenAPI JSON file or a Postman collection. It is read for these cases only; it is not added to the simulation.</span>
              </div>
            )}
            {specMode !== 'none' && (
              <label className="sim-check small" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={makeScripts} onChange={(e) => setMakeScripts(e.target.checked)} />
                <span>Also create runnable API scripts (on the Scripts tab)</span>
              </label>
            )}
          </fieldset>

          {error && <div className="error-note" role="alert">{error}</div>}
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={uploadsBusy}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            {uploadsBusy && !busy
              ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Uploading&hellip;</>
              : busy
                ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Starting&hellip;</>
                : <><Icon name="flask" size={14} /> {hasSpec && !hasDescription ? 'Generate from specification' : 'Generate test cases'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
