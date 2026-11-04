/**
 * GenerateCasesDialog — start a manual QA test-case generation from specs.
 *
 * POST /api/projects/:pid/tests/:tpid/case-sets
 * Body: { name?, description, attachmentIds? }
 * Response 202: { caseSet }
 *
 * Props:
 *   testProjectId  - string
 *   projectId      - string
 *   onClose()      - called to close the dialog
 *   onGenerated(caseSetId, name, description) - called when accepted (202)
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { AttachmentPicker } from '../../components/AttachmentPicker.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';

export function GenerateCasesDialog({ testProjectId, projectId, onClose, onGenerated }) {
  const [description, setDescription] = useState('');
  const [name, setName]               = useState('');
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState(null);
  const [attachmentIds, setAttachmentIds] = useState([]);
  const [uploadsBusy, setUploadsBusy] = useState(false);
  const descRef = useRef(null);
  const trapRef = useFocusTrap();

  const handleAttachments = (ids, uploading) => {
    setAttachmentIds(ids);
    setUploadsBusy(uploading);
  };

  useEffect(() => { descRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !uploadsBusy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, uploadsBusy]);

  const submit = async () => {
    if (!description.trim() || busy || uploadsBusy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.post(
        `/api/projects/${projectId}/tests/${testProjectId}/case-sets`,
        {
          description:   description.trim(),
          name:          name.trim() || undefined,
          attachmentIds: attachmentIds.length ? attachmentIds : undefined,
        },
      );
      onGenerated(data.caseSet.id, name.trim() || description.trim().slice(0, 60), description.trim());
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const canSubmit = description.trim() && !busy && !uploadsBusy;
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
            <label htmlFor="gc-desc">Description <span aria-hidden="true">*</span></label>
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
                : <><Icon name="flask" size={14} /> Generate test cases</>}
          </button>
        </div>
      </div>
    </div>
  );
}
