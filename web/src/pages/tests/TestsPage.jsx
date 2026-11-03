/**
 * Tests module (F12) — AI-assisted end-to-end and API testing.
 *
 * Routing via route.rest:
 *   []                          → test project list
 *   [tpid]                      → test project detail (tab: scripts)
 *   [tpid, tab]                 → test project detail with selected tab
 *   [tpid, 'scripts', sid]      → script editor
 *   [tpid, 'cases', csid]       → case set viewer
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { navigate, href } from '../../lib/router.js';
import { Icon } from '../../components/Icon.jsx';
import { AttachmentPicker } from '../../components/AttachmentPicker.jsx';
import { formatRelative, formatDate } from '../../lib/util.js';
import { GenerationTracker } from './GenerationTracker.jsx';
import { CaseSetList } from './CaseSetList.jsx';
import { CaseSetViewer } from './CaseSetViewer.jsx';
import { GenerateCasesDialog } from './GenerateCasesDialog.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../../components/Toast.jsx';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';
import { AiChoicePicker } from '../../components/AiChoicePicker.jsx';

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeJson(s, fallback) {
  if (!s) return fallback;
  // The cloud API returns lists already parsed; the local one returns JSON text.
  if (typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return fallback; }
}

function statusDotClass(status) {
  if (status === 'running' || status === 'queued') return 'dot-running';
  if (status === 'passed')                          return 'dot-running'; // green
  if (status === 'failed' || status === 'error')    return 'dot-failed';
  return 'dot-stopped';
}

function BrowserBanner({ available, reason }) {
  if (available !== false) return null;
  return (
    <div
      role="alert"
      style={{
        background: 'var(--warn-wash)',
        border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)',
        borderRadius: 'var(--radius)',
        padding: '10px 14px',
        marginBottom: 16,
        fontSize: '0.84rem',
        color: 'var(--warn)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
      }}
    >
      <Icon name="warning" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>
        <strong>Browser not available.</strong>{' '}
        {reason || 'A headless browser is required to run tests.'}
      </span>
    </div>
  );
}

// ── Step kind definitions ──────────────────────────────────────────────────────

const STEP_KINDS = [
  { value: 'goto',           label: 'Go to URL' },
  { value: 'click',          label: 'Click' },
  { value: 'fill',           label: 'Fill input' },
  { value: 'select',         label: 'Select option' },
  { value: 'press',          label: 'Press key' },
  { value: 'upload',         label: 'Upload file' },
  { value: 'assert_visible', label: 'Assert visible' },
  { value: 'assert_text',    label: 'Assert text' },
  { value: 'assert_url',     label: 'Assert URL' },
  { value: 'wait',           label: 'Wait' },
  { value: 'api_request',    label: 'API request' },
  { value: 'agent',          label: 'Agent instruction' },
];

const LOCATOR_MODES = [
  { value: 'role',   label: 'Role + name' },
  { value: 'label',  label: 'Label' },
  { value: 'text',   label: 'Text' },
  { value: 'testId', label: 'Test ID' },
  { value: 'css',    label: 'CSS selector' },
];

function emptyLocator(mode = 'role') {
  if (mode === 'role')   return { role: 'button', name: '' };
  if (mode === 'label')  return { label: '' };
  if (mode === 'text')   return { text: '' };
  if (mode === 'testId') return { testId: '' };
  return { css: '' };
}

function emptyStep(kind = 'goto') {
  switch (kind) {
    case 'goto':           return { kind, path: '/' };
    case 'click':
    case 'assert_visible': return { kind, locator: emptyLocator() };
    case 'fill':
    case 'select':         return { kind, locator: emptyLocator(), value: '' };
    case 'press':          return { kind, key: 'Enter' };
    case 'upload':         return { kind, locator: emptyLocator(), file: '' };
    case 'assert_text':    return { kind, locator: emptyLocator(), text: '' };
    case 'assert_url':     return { kind, url: '' };
    case 'wait':           return { kind, ms: 1000 };
    case 'api_request':    return { kind, method: 'GET', path: '/', expectedStatus: 200 };
    case 'agent':          return { kind, instruction: '' };
    default:               return { kind };
  }
}

// ── Locator editor ─────────────────────────────────────────────────────────────

function LocatorEditor({ locator, onChange, vaultItems, files, disabled }) {
  const mode = locator
    ? ('role' in locator ? 'role' : 'label' in locator ? 'label' : 'text' in locator ? 'text' : 'testId' in locator ? 'testId' : 'css')
    : 'role';

  const changeMode = (newMode) => onChange(emptyLocator(newMode));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          value={mode}
          onChange={(e) => changeMode(e.target.value)}
          disabled={disabled}
          aria-label="Locator mode"
          style={{ width: 130 }}
        >
          {LOCATOR_MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        {mode === 'role' && (
          <>
            <input
              type="text"
              placeholder="role (button, link…)"
              value={locator?.role || ''}
              onChange={(e) => onChange({ ...locator, role: e.target.value })}
              disabled={disabled}
              style={{ flex: 1 }}
              aria-label="ARIA role"
            />
            <input
              type="text"
              placeholder="accessible name"
              value={locator?.name || ''}
              onChange={(e) => onChange({ ...locator, name: e.target.value })}
              disabled={disabled}
              style={{ flex: 2 }}
              aria-label="Accessible name"
            />
          </>
        )}
        {mode === 'label' && (
          <input
            type="text"
            placeholder="label text"
            value={locator?.label || ''}
            onChange={(e) => onChange({ ...locator, label: e.target.value })}
            disabled={disabled}
            style={{ flex: 1 }}
            aria-label="Label text"
          />
        )}
        {mode === 'text' && (
          <input
            type="text"
            placeholder="visible text"
            value={locator?.text || ''}
            onChange={(e) => onChange({ ...locator, text: e.target.value })}
            disabled={disabled}
            style={{ flex: 1 }}
            aria-label="Visible text"
          />
        )}
        {mode === 'testId' && (
          <input
            type="text"
            placeholder="data-testid value"
            value={locator?.testId || ''}
            onChange={(e) => onChange({ ...locator, testId: e.target.value })}
            disabled={disabled}
            style={{ flex: 1 }}
            aria-label="Test ID"
          />
        )}
        {mode === 'css' && (
          <input
            type="text"
            placeholder="CSS selector"
            value={locator?.css || ''}
            onChange={(e) => onChange({ ...locator, css: e.target.value })}
            disabled={disabled}
            style={{ flex: 1 }}
            aria-label="CSS selector"
          />
        )}
      </div>
    </div>
  );
}

// ── Step editor ───────────────────────────────────────────────────────────────

function StepEditor({ step, index, onChange, onRemove, onMoveUp, onMoveDown, isFirst, isLast, vaultItems, files }) {
  const [open, setOpen] = useState(true);
  const updateField = (key, val) => onChange({ ...step, [key]: val });

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        marginBottom: 8,
        background: 'var(--canvas)',
      }}
    >
      {/* Step header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: open ? '1px solid var(--line)' : 'none',
          cursor: 'pointer',
        }}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}
        tabIndex={0}
        role="button"
        aria-expanded={open}
        aria-label={`Step ${index + 1}: ${step.kind}`}
      >
        <span style={{ color: 'var(--ink-3)', fontSize: '0.75rem', width: 24, textAlign: 'center', flexShrink: 0 }}>
          {index + 1}
        </span>
        <select
          value={step.kind}
          onChange={(e) => { e.stopPropagation(); onChange({ ...emptyStep(e.target.value), _cid: step._cid }); }}
          style={{ fontWeight: 600, fontSize: '0.84rem' }}
          aria-label={`Step ${index + 1} kind`}
          onClick={(e) => e.stopPropagation()}
        >
          {STEP_KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn-icon"
          onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
          disabled={isFirst}
          aria-label={`Move step ${index + 1} up`}
          style={{ width: 22, height: 22 }}
        >
          <Icon name="chevron-up" size={12} />
        </button>
        <button
          type="button"
          className="btn-icon"
          onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
          disabled={isLast}
          aria-label={`Move step ${index + 1} down`}
          style={{ width: 22, height: 22 }}
        >
          <Icon name="chevronDown" size={12} />
        </button>
        <button
          type="button"
          className="btn-icon"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label={`Remove step ${index + 1}`}
          style={{ width: 22, height: 22, color: 'var(--danger)' }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      {/* Step fields */}
      {open && (
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {step.kind === 'goto' && (
            <div className="field">
              <label>Path</label>
              <input
                type="text"
                value={step.path || ''}
                onChange={(e) => updateField('path', e.target.value)}
                placeholder="/login"
                aria-label="URL path"
              />
              <p className="field-hint">Relative to the app URL.</p>
            </div>
          )}

          {['click', 'assert_visible', 'fill', 'select', 'upload', 'assert_text'].includes(step.kind) && (
            <div className="field">
              <label>Locator</label>
              <LocatorEditor
                locator={step.locator}
                onChange={(loc) => updateField('locator', loc)}
                vaultItems={vaultItems}
                files={files}
              />
            </div>
          )}

          {(step.kind === 'fill' || step.kind === 'select') && (
            <div className="field">
              <label>Value</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={step.value || ''}
                  onChange={(e) => updateField('value', e.target.value)}
                  placeholder={step.kind === 'fill' ? 'Text to fill, or {{vault.name.field}}' : 'Option value'}
                  style={{ flex: 1 }}
                  aria-label="Value"
                />
                {step.kind === 'fill' && vaultItems && vaultItems.length > 0 && (
                  <select
                    aria-label="Insert vault reference"
                    defaultValue=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      updateField('value', (step.value || '') + e.target.value);
                      e.target.value = '';
                    }}
                    style={{ width: 160 }}
                  >
                    <option value="">Insert vault ref…</option>
                    {vaultItems.flatMap((item) => {
                      const refs = item.kind === 'login'
                        ? [`{{vault.${item.name}.username}}`, `{{vault.${item.name}.password}}`,
                           ...(item.hasTotp ? [`{{vault.${item.name}.totp}}`] : [])]
                        : [`{{vault.${item.name}.value}}`];
                      return refs.map((r) => <option key={r} value={r}>{r}</option>);
                    })}
                  </select>
                )}
              </div>
            </div>
          )}

          {step.kind === 'press' && (
            <div className="field">
              <label>Key</label>
              <input
                type="text"
                value={step.key || ''}
                onChange={(e) => updateField('key', e.target.value)}
                placeholder="Enter, Tab, Escape…"
                aria-label="Key to press"
              />
            </div>
          )}

          {step.kind === 'upload' && (
            <div className="field">
              <label>File reference</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={step.file || ''}
                  onChange={(e) => updateField('file', e.target.value)}
                  placeholder="{{file.name}}"
                  style={{ flex: 1 }}
                  aria-label="File reference"
                />
                {files && files.length > 0 && (
                  <select
                    aria-label="Insert file reference"
                    defaultValue=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      updateField('file', e.target.value);
                      e.target.value = '';
                    }}
                    style={{ width: 160 }}
                  >
                    <option value="">Insert file ref…</option>
                    {files.map((f) => (
                      <option key={f.id} value={`{{file.${f.name}}}`}>{f.name}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          )}

          {step.kind === 'assert_text' && (
            <div className="field">
              <label>Expected text</label>
              <input
                type="text"
                value={step.text || ''}
                onChange={(e) => updateField('text', e.target.value)}
                placeholder="Expected visible text"
                aria-label="Expected text"
              />
            </div>
          )}

          {step.kind === 'assert_url' && (
            <div className="field">
              <label>Expected URL (or pattern)</label>
              <input
                type="text"
                value={step.url || ''}
                onChange={(e) => updateField('url', e.target.value)}
                placeholder="https://example.com/dashboard"
                aria-label="Expected URL"
              />
            </div>
          )}

          {step.kind === 'wait' && (
            <div className="field" style={{ maxWidth: 200 }}>
              <label>Wait (milliseconds)</label>
              <input
                type="number"
                min="0"
                value={step.ms ?? 1000}
                onChange={(e) => updateField('ms', Number(e.target.value))}
                aria-label="Wait milliseconds"
              />
            </div>
          )}

          {step.kind === 'api_request' && (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="field" style={{ width: 100 }}>
                  <label>Method</label>
                  <select
                    value={step.method || 'GET'}
                    onChange={(e) => updateField('method', e.target.value)}
                    aria-label="HTTP method"
                  >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>Path</label>
                  <input
                    type="text"
                    value={step.path || ''}
                    onChange={(e) => updateField('path', e.target.value)}
                    placeholder="/api/users"
                    aria-label="API path"
                  />
                </div>
                <div className="field" style={{ width: 120 }}>
                  <label>Expected status</label>
                  <input
                    type="number"
                    value={step.expectedStatus || 200}
                    onChange={(e) => updateField('expectedStatus', Number(e.target.value))}
                    aria-label="Expected HTTP status"
                  />
                </div>
              </div>
              <div className="field">
                <label>Body (JSON, optional)</label>
                <textarea
                  rows={3}
                  value={typeof step.body === 'string' ? step.body : (step.body ? JSON.stringify(step.body, null, 2) : '')}
                  onChange={(e) => updateField('body', e.target.value)}
                  placeholder='{"key": "value"}'
                  style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}
                  aria-label="Request body"
                />
              </div>
            </>
          )}

          {step.kind === 'agent' && (
            <div className="field">
              <label>Instruction</label>
              <textarea
                rows={3}
                value={step.instruction || ''}
                onChange={(e) => updateField('instruction', e.target.value)}
                placeholder='Sign in with the admin credentials from the vault'
                aria-label="Agent instruction"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Generate with AI dialog ───────────────────────────────────────────────────

/**
 * Submits a generation request and closes immediately (202 accepted).
 * The caller is responsible for tracking the job via onGenerated(genId, description).
 */
function GenerateDialog({ testProjectId, projectId, groupId, onClose, onGenerated }) {
  const [description, setDescription]     = useState('');
  const [busy, setBusy]                   = useState(false);
  const [error, setError]                 = useState(null);
  const [attachmentIds, setAttachmentIds] = useState([]);
  const [uploadsBusy, setUploadsBusy]     = useState(false);
  const [aiChoice, setAiChoice]           = useState({});
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
        `/api/projects/${projectId}/tests/${testProjectId}/generate`,
        {
          description:   description.trim(),
          groupId:       groupId || undefined,
          attachmentIds: attachmentIds.length ? attachmentIds : undefined,
          credentialId:  aiChoice.credentialId,
          model:         aiChoice.model,
        },
      );
      onGenerated(data.generationId, description.trim());
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

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
        aria-labelledby="gen-dialog-title"
        style={{ maxWidth: 520 }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="gen-dialog-title">Generate with AI</h2>
          <button type="button" className="btn-icon" onClick={onClose} disabled={uploadsBusy} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="dialog-body stack">
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Describe a test scenario. Attach requirement docs, screenshots or architecture
            diagrams and the AI will use them to generate steps.
            Generation runs in the background — you can continue working while it completes.
          </p>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: -2 }}>
            This generates <strong>automation steps</strong> (Playwright/API actions).{' '}
            <button
              type="button"
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent, #6366f1)', cursor: 'pointer', fontSize: 'inherit', textDecoration: 'underline' }}
              onClick={onClose}
              aria-label="Switch to test cases dialog"
            >
              Need a test case sheet?
            </button>
            {' '}Go to the <strong>Test cases</strong> tab instead.
          </p>
          <div className="field">
            <label htmlFor="gen-desc">Test description <span aria-hidden="true">*</span></label>
            <textarea
              id="gen-desc"
              ref={descRef}
              rows={4}
              maxLength={4000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Log in with the admin vault credential and verify the dashboard loads"
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

          <AiChoicePicker onChange={setAiChoice} disabled={busy} idPrefix="gen" />

          {error && <div className="error-note" role="alert">{error}</div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={uploadsBusy}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!description.trim() || busy || uploadsBusy}
          >
            {uploadsBusy && !busy
              ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Uploading…</>
              : busy
                ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Starting…</>
                : <><Icon name="agents" size={14} /> Generate</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Refine with AI dialog ─────────────────────────────────────────────────────

/**
 * Submits a refine request and closes immediately (202 accepted).
 * The caller is responsible for tracking the job via onRefined(genId, instruction).
 */
function RefineDialog({ testProjectId, projectId, scriptId, onClose, onRefined }) {
  const [instruction, setInstruction]     = useState('');
  const [busy, setBusy]                   = useState(false);
  const [error, setError]                 = useState(null);
  const [attachmentIds, setAttachmentIds] = useState([]);
  const [uploadsBusy, setUploadsBusy]     = useState(false);
  const trapRef = useFocusTrap();

  const handleAttachments = (ids, uploading) => {
    setAttachmentIds(ids);
    setUploadsBusy(uploading);
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !uploadsBusy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, uploadsBusy]);

  const submit = async () => {
    if (!instruction.trim() || busy || uploadsBusy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api.post(
        `/api/projects/${projectId}/tests/${testProjectId}/scripts/${scriptId}/refine`,
        {
          instruction:   instruction.trim(),
          attachmentIds: attachmentIds.length ? attachmentIds : undefined,
        },
      );
      onRefined(data.generationId, instruction.trim());
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

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
        aria-labelledby="refine-dialog-title"
        style={{ maxWidth: 520 }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="refine-dialog-title">Refine with AI</h2>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            disabled={uploadsBusy}
            aria-label="Close"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="dialog-body stack">
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Describe what to change. Attach supporting files and the AI will use them when
            refining the script. Refinement runs in the background — you can continue working
            while it completes.
          </p>
          <div className="field">
            <label htmlFor="refine-instruction">Instruction <span aria-hidden="true">*</span></label>
            <textarea
              id="refine-instruction"
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. Add a step to verify the success toast appears after submission"
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
            disabled={!instruction.trim() || busy || uploadsBusy}
          >
            {uploadsBusy && !busy
              ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Uploading…</>
              : busy
                ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Starting…</>
                : <><Icon name="agents" size={14} /> Refine</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Import test cases dialog ──────────────────────────────────────────────────

function ImportTestsDialog({ testProjectId, projectId, onClose, onImported }) {
  const [csv, setCsv] = useState('name,description\n');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [importErrors, setImportErrors] = useState([]);
  const trapRef = useFocusTrap();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!csv.trim() || busy) return;
    setBusy(true);
    setError(null);
    setImportErrors([]);
    try {
      const data = await api.post(
        `/api/projects/${projectId}/tests/${testProjectId}/import`,
        { csv },
      );
      setImportErrors(data.errors || []);
      if (data.generationIds?.length > 0) {
        onImported(data.generationIds);
        onClose();
      } else if ((data.errors || []).length === 0) {
        onClose();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const overlayDismiss = useOverlayDismiss(onClose);

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
        aria-labelledby="import-tests-title"
        style={{ maxWidth: 560 }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="import-tests-title">Import test cases</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="dialog-body stack">
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Paste a CSV with <code>name</code> and <code>description</code> columns.
            One test case per row; an AI session generates steps for each.
          </p>
          <div className="field">
            <label htmlFor="imp-csv">CSV content</label>
            <textarea
              id="imp-csv"
              rows={8}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem' }}
              aria-label="CSV content"
            />
          </div>
          {importErrors.length > 0 && (
            <ul style={{ fontSize: '0.82rem', color: 'var(--danger)', paddingLeft: 20 }}>
              {importErrors.map((e, i) => (
                <li key={i}>Row {e.row}: {e.error}</li>
              ))}
            </ul>
          )}
          {error && <div className="error-note" role="alert">{error}</div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Script editor ─────────────────────────────────────────────────────────────

function ScriptEditor({ scriptId, testProjectId, projectId, onBack }) {
  const [script, setScript]       = useState(null);
  const [steps, setSteps]         = useState([]);
  const [name, setName]           = useState('');
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [vaultItems, setVaultItems] = useState([]);
  const [files, setFiles]         = useState([]);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showRefine, setShowRefine]     = useState(false);

  // Refine tracking: polls until done, then reloads the script's steps.
  const [refineGen, setRefineGen]       = useState(null); // { id, status, error }
  const refineIntervalRef               = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [scriptData, vaultData, filesData] = await Promise.all([
        api.get(`/api/projects/${projectId}/tests/${testProjectId}/scripts/${scriptId}`),
        api.get(`/api/projects/${projectId}/tests/${testProjectId}/vault`).catch(() => ({ items: [] })),
        api.get(`/api/projects/${projectId}/tests/${testProjectId}/vault/files`).catch(() => ({ files: [] })),
      ]);
      const s = scriptData.script;
      setScript(s);
      setName(s.name);
      setSteps(safeJson(s.steps, []).map((step) => ({ ...step, _cid: step._cid ?? crypto.randomUUID() })));
      setVaultItems(vaultData.items || []);
      setFiles(filesData.files || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [scriptId, testProjectId, projectId]);

  useEffect(() => { load(); }, [load]);

  // Clean up refine polling on unmount.
  useEffect(() => {
    return () => {
      if (refineIntervalRef.current) {
        clearInterval(refineIntervalRef.current);
        refineIntervalRef.current = null;
      }
    };
  }, []);

  /**
   * Called by RefineDialog after the POST returns 202.
   * Polls /generate/:genId until done (reloads steps) or failed.
   */
  const handleRefineStarted = useCallback((genId) => {
    setRefineGen({ id: genId, status: 'pending' });
    if (refineIntervalRef.current) clearInterval(refineIntervalRef.current);
    refineIntervalRef.current = setInterval(async () => {
      try {
        const data = await api.get(
          `/api/projects/${projectId}/tests/${testProjectId}/generate/${genId}`,
        );
        const gen = data.generation;
        if (gen.status === 'done') {
          clearInterval(refineIntervalRef.current);
          refineIntervalRef.current = null;
          setRefineGen(null);
          load(); // reload script with refined steps
          setSaved(false);
        } else if (gen.status === 'failed') {
          clearInterval(refineIntervalRef.current);
          refineIntervalRef.current = null;
          setRefineGen({ id: genId, status: 'failed', error: gen.error || 'Refinement failed' });
        } else {
          setRefineGen((prev) => prev ? { ...prev, status: gen.status } : prev);
        }
      } catch { /* ignore transient poll errors */ }
    }, 2000);
  }, [projectId, testProjectId, load]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      // Strip client-only stable IDs before sending to server
      const stepsForServer = steps.map(({ _cid, ...step }) => step);
      await api.put(
        `/api/projects/${projectId}/tests/${testProjectId}/scripts/${scriptId}`,
        { name: name.trim() || script.name, steps: stepsForServer },
      );
      setSaved(true);
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const addStep = () => {
    setSteps((prev) => [...prev, { ...emptyStep('goto'), _cid: crypto.randomUUID() }]);
    setSaved(false);
  };

  const removeStep = (i) => {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
    setSaved(false);
  };

  const updateStep = (i, step) => {
    setSteps((prev) => prev.map((s, idx) => idx === i ? step : s));
    setSaved(false);
  };

  const moveStep = (i, dir) => {
    setSteps((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return next;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setSaved(false);
  };

  const refine = () => setShowRefine(true);

  if (loading) return <div className="page"><div className="spinner" aria-label="Loading script…" /></div>;
  if (error)   return <div className="page"><p className="error-note" role="alert">{error}</p></div>;

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button type="button" className="btn-icon" onClick={onBack} aria-label="Back to scripts">
          <Icon name="chevronLeft" size={16} />
        </button>
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setSaved(false); }}
          style={{ fontWeight: 600, fontSize: '1rem', flex: 1, maxWidth: 400 }}
          aria-label="Script name"
        />
        <span className="muted" style={{ fontSize: '0.82rem' }}>
          {steps.length} step{steps.length !== 1 ? 's' : ''}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={refine}>
          Refine with AI
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowGenerate(true)}>
          <Icon name="agents" size={13} /> Generate with AI
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Saving…</> : 'Save'}
        </button>
      </div>

      {saveError && <p className="error-note" role="alert" style={{ marginBottom: 10 }}>{saveError}</p>}
      {saved && <p role="status" style={{ color: 'var(--ok)', marginBottom: 10, fontSize: '0.84rem' }}>✓ Saved</p>}

      {/* Refine-in-progress indicator */}
      {refineGen && (
        <div
          role={refineGen.status === 'failed' ? 'alert' : 'status'}
          aria-live="polite"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
            padding: '7px 12px',
            borderRadius: 'var(--radius)',
            background: refineGen.status === 'failed'
              ? 'color-mix(in srgb, var(--danger, #dc2626) 8%, var(--canvas))'
              : 'color-mix(in srgb, var(--accent, #6366f1) 8%, var(--canvas))',
            border: `1px solid ${refineGen.status === 'failed'
              ? 'color-mix(in srgb, var(--danger, #dc2626) 30%, transparent)'
              : 'color-mix(in srgb, var(--accent, #6366f1) 25%, transparent)'}`,
            fontSize: '0.84rem',
          }}
        >
          {refineGen.status === 'failed'
            ? <Icon name="warning" size={14} style={{ color: 'var(--danger)', flexShrink: 0 }} aria-hidden="true" />
            : <span className="spinner" style={{ width: 14, height: 14, flexShrink: 0 }} aria-hidden="true" />}
          <span style={{ flex: 1 }}>
            {refineGen.status === 'failed'
              ? <><strong>Refinement failed:</strong> {refineGen.error}</>
              : 'Refining… steps will update when complete'}
          </span>
          {refineGen.status === 'failed' && (
            <button
              type="button"
              className="btn-icon"
              onClick={() => setRefineGen(null)}
              aria-label="Dismiss refinement error"
              style={{ flexShrink: 0 }}
            >
              <Icon name="x" size={13} />
            </button>
          )}
        </div>
      )}

      <section aria-label="Script steps">
        {steps.map((step, i) => (
          <StepEditor
            key={step._cid ?? i}
            step={step}
            index={i}
            onChange={(s) => updateStep(i, s)}
            onRemove={() => removeStep(i)}
            onMoveUp={() => moveStep(i, -1)}
            onMoveDown={() => moveStep(i, 1)}
            isFirst={i === 0}
            isLast={i === steps.length - 1}
            vaultItems={vaultItems}
            files={files}
          />
        ))}
        <button type="button" className="btn btn-ghost btn-sm" onClick={addStep} style={{ marginTop: 8 }}>
          <Icon name="plus" size={14} /> Add step
        </button>
      </section>

      {showGenerate && (
        <GenerateDialog
          testProjectId={testProjectId}
          projectId={projectId}
          groupId={script?.testGroupId}
          onClose={() => setShowGenerate(false)}
          onGenerated={() => {}} // generation tracked at ScriptsTab level when user navigates back
        />
      )}
      {showRefine && (
        <RefineDialog
          testProjectId={testProjectId}
          projectId={projectId}
          scriptId={scriptId}
          onClose={() => setShowRefine(false)}
          onRefined={handleRefineStarted}
        />
      )}
    </div>
  );
}

// ── Generations indicator ─────────────────────────────────────────────────────

/**
 * Compact, non-modal indicator near the Scripts toolbar.
 * Shows one row per active or failed generation job.
 * role="status" / aria-live="polite" for running jobs; role="alert" for failures.
 */
function GenerationsIndicator({ jobs, onDismiss }) {
  const visible = jobs.filter(
    (j) => j.status === 'pending' || j.status === 'running' || j.status === 'failed',
  );
  if (visible.length === 0) return null;

  return (
    <div
      aria-label="Generation progress"
      aria-live="polite"
      style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}
    >
      {visible.map((job) => (
        <div
          key={job.id}
          role={job.status === 'failed' ? 'alert' : 'status'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 12px',
            borderRadius: 'var(--radius)',
            background: job.status === 'failed'
              ? 'color-mix(in srgb, var(--danger, #dc2626) 8%, var(--canvas))'
              : 'color-mix(in srgb, var(--accent, #6366f1) 8%, var(--canvas))',
            border: `1px solid ${job.status === 'failed'
              ? 'color-mix(in srgb, var(--danger, #dc2626) 30%, transparent)'
              : 'color-mix(in srgb, var(--accent, #6366f1) 25%, transparent)'}`,
            fontSize: '0.84rem',
          }}
        >
          {job.status === 'failed'
            ? <Icon name="warning" size={14} style={{ color: 'var(--danger)', flexShrink: 0 }} aria-hidden="true" />
            : <span className="spinner" style={{ width: 14, height: 14, flexShrink: 0 }} aria-hidden="true" />}
          <span style={{ flex: 1, minWidth: 0 }}>
            {job.status === 'failed'
              ? <><strong>{job.kind === 'refine' ? 'Refinement' : 'Generation'} failed:</strong> {job.error || 'Unknown error'}</>
              : <>{job.kind === 'refine' ? 'Refining' : 'Generating'}{job.description ? ` — ${job.description}` : '…'}</>}
          </span>
          {job.status === 'failed' && (
            <button
              type="button"
              className="btn-icon"
              onClick={() => onDismiss(job.id)}
              aria-label="Dismiss failed generation"
              style={{ flexShrink: 0 }}
            >
              <Icon name="x" size={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Scripts tab ───────────────────────────────────────────────────────────────

function ScriptsTab({ testProject, projectId, onOpenScript, onOpenCasesDialog }) {
  const [groups, setGroups]       = useState([]);
  const [scripts, setScripts]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [addingGroup, setAddingGroup] = useState(false);
  const [showNewScript, setShowNewScript] = useState(null); // groupId
  const [newScriptName, setNewScriptName] = useState('');
  const [showGenerate, setShowGenerate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  // ── Background-generation tracking ────────────────────────────────────────
  // Each job: { id, kind: 'generate'|'refine', description, status, error }
  const [genJobs, setGenJobsState] = useState([]);
  const genJobsRef = useRef([]);
  const genPollRef = useRef(null);

  // Keep ref in sync so the polling interval always reads current jobs.
  const setGenJobs = useCallback((updater) => {
    setGenJobsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      genJobsRef.current = next;
      return next;
    });
  }, []);

  // Silent refresh — used after a generation completes to show new scripts
  // without flashing the full-page loading spinner.
  const reload = useCallback(async () => {
    try {
      const [gd, sd] = await Promise.all([
        api.get(`/api/projects/${projectId}/tests/${testProject.id}/groups`),
        api.get(`/api/projects/${projectId}/tests/${testProject.id}/scripts`),
      ]);
      setGroups(gd.groups || []);
      setScripts(sd.scripts || []);
    } catch { /* ignore silent reload errors */ }
  }, [testProject.id, projectId]);

  const startGenPoll = useCallback(() => {
    if (genPollRef.current) return; // already polling
    genPollRef.current = setInterval(async () => {
      const active = genJobsRef.current.filter(
        (j) => j.status === 'pending' || j.status === 'running',
      );
      if (active.length === 0) {
        clearInterval(genPollRef.current);
        genPollRef.current = null;
        return;
      }
      for (const job of active) {
        try {
          const data = await api.get(
            `/api/projects/${projectId}/tests/${testProject.id}/generate/${job.id}`,
          );
          const gen = data.generation;
          if (gen.status === 'done') {
            reload();
            const scriptCount = (data.scripts || []).length;
            const ws = Array.isArray(gen.warnings) ? gen.warnings : [];
            const msg = `Generated ${scriptCount} test script${scriptCount !== 1 ? 's' : ''}` +
              (ws.length ? ` (${ws.length} step${ws.length !== 1 ? 's' : ''} adjusted)` : '');
            toast(msg, 'ok');
            setGenJobs((prev) => prev.filter((j) => j.id !== job.id));
          } else if (gen.status === 'failed') {
            const ws = Array.isArray(gen.warnings) ? gen.warnings : [];
            setGenJobs((prev) => prev.map((j) =>
              j.id === job.id
                ? { ...j, status: 'failed', error: gen.error || 'Unknown error', warnings: ws }
                : j,
            ));
          } else {
            setGenJobs((prev) => prev.map((j) =>
              j.id === job.id
                ? { ...j, status: gen.status, progress: gen.progress, startedAt: gen.startedAt }
                : j,
            ));
          }
        } catch { /* ignore transient poll errors */ }
      }
    }, 2500);
  }, [projectId, testProject.id, reload, toast, setGenJobs]);

  const cancelGenJob = useCallback(async (id) => {
    try {
      await api.post(
        `/api/projects/${projectId}/tests/${testProject.id}/generations/${id}/cancel`,
        {},
      );
      setGenJobs((prev) => prev.map((j) => j.id === id ? { ...j, status: 'cancelled' } : j));
    } catch (e) {
      toast(`Cancel failed: ${e.message}`, 'error');
    }
  }, [projectId, testProject.id, toast, setGenJobs]);

  const addGenJob = useCallback((job) => {
    setGenJobs((prev) => [
      ...prev.filter((j) => j.id !== job.id), // deduplicate
      job,
    ]);
    startGenPoll();
  }, [setGenJobs, startGenPoll]);

  const dismissGenJob = useCallback((id) => {
    setGenJobs((prev) => prev.filter((j) => j.id !== id));
  }, [setGenJobs]);

  const handleRetryGen = useCallback(async (job) => {
    try {
      const data = await api.post(
        `/api/projects/${projectId}/tests/${testProject.id}/generations/${job.id}/retry`,
        {},
      );
      const newId = data.generationId;
      setGenJobs((prev) => [
        ...prev.filter((j) => j.id !== job.id),
        { id: newId, kind: job.kind, description: job.description, status: 'pending' },
      ]);
      startGenPoll();
    } catch (e) {
      toast(`Retry failed: ${e.message}`, 'error');
      throw e; // re-throw so JobRow can reset its retrying state
    }
  }, [projectId, testProject.id, setGenJobs, startGenPoll, toast]);

  // Load any already-running generations on mount (survives reload / navigation).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get(
          `/api/projects/${projectId}/tests/${testProject.id}/generations?active=1`,
        );
        if (cancelled) return;
        const active = data.generations || [];
        if (active.length > 0) {
          setGenJobs(active);
          startGenPoll();
        }
      } catch { /* ignore — page still works without the indicator */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testProject.id, projectId]);

  // Clean up interval on unmount.
  useEffect(() => {
    return () => {
      if (genPollRef.current) {
        clearInterval(genPollRef.current);
        genPollRef.current = null;
      }
    };
  }, []);
  // ── End background-generation tracking ────────────────────────────────────

  const load = useCallback(async () => {
    setError(null);
    try {
      const [gd, sd] = await Promise.all([
        api.get(`/api/projects/${projectId}/tests/${testProject.id}/groups`),
        api.get(`/api/projects/${projectId}/tests/${testProject.id}/scripts`),
      ]);
      setGroups(gd.groups || []);
      setScripts(sd.scripts || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [testProject.id, projectId]);

  useEffect(() => { load(); }, [load]);

  const createGroup = async (e) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    try {
      await api.post(
        `/api/projects/${projectId}/tests/${testProject.id}/groups`,
        { name: newGroupName.trim() },
      );
      setNewGroupName('');
      setAddingGroup(false);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const deleteGroup = async (gid) => {
    if (!await requestConfirm('Delete this group and all its scripts? This cannot be undone.', 'Delete', 'danger')) return;
    try {
      await api.delete(`/api/projects/${projectId}/tests/${testProject.id}/groups/${gid}`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const createScript = async (e, groupId) => {
    e.preventDefault();
    if (!newScriptName.trim()) return;
    try {
      const data = await api.post(
        `/api/projects/${projectId}/tests/${testProject.id}/groups/${groupId}/scripts`,
        { name: newScriptName.trim() },
      );
      setNewScriptName('');
      setShowNewScript(null);
      load();
      onOpenScript(data.script.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const runScript = async (scriptId) => {
    try {
      await api.post(
        `/api/projects/${projectId}/tests/${testProject.id}/scripts/${scriptId}/run`,
        {},
      );
      toast('Run started. Check the Runs tab.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const runGroup = async (groupId) => {
    try {
      await api.post(
        `/api/projects/${projectId}/tests/${testProject.id}/groups/${groupId}/run`,
        {},
      );
      toast('Group run started. Check the Runs tab.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading scripts…" />;
  if (error)   return <p className="error-note" role="alert">{error}</p>;

  return (
    <div>
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setAddingGroup(true)}>
          <Icon name="plus" size={13} /> New group
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowGenerate(true)}>
          <Icon name="agents" size={13} /> Generate with AI
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowImport(true)}>
          Import test cases
        </button>
      </div>

      <GenerationTracker
        jobs={genJobs}
        onDismiss={dismissGenJob}
        onCancel={cancelGenJob}
        onRetry={handleRetryGen}
        onOpenCasesDialog={onOpenCasesDialog}
        projectId={projectId}
        tpId={testProject.id}
      />

      {addingGroup && (
        <form onSubmit={createGroup} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            autoFocus
            type="text"
            placeholder="Group name"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            style={{ flex: 1, maxWidth: 300 }}
            aria-label="New group name"
          />
          <button type="submit" className="btn btn-primary btn-sm">Create</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddingGroup(false)}>Cancel</button>
        </form>
      )}

      {groups.length === 0 && (
        <div className="ws-placeholder">
          <Icon name="play" size={32} />
          <p>No groups yet. Create a group to start adding scripts.</p>
        </div>
      )}

      {groups.map((g) => {
        const groupScripts = scripts.filter((s) => s.testGroupId === g.id);
        return (
          <section key={g.id} aria-label={`Group: ${g.name}`} style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: '0.95rem', flex: 1 }}>{g.name}</h3>
              <span className="muted" style={{ fontSize: '0.78rem' }}>
                {groupScripts.length} script{groupScripts.length !== 1 ? 's' : ''}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => runGroup(g.id)}
                aria-label={`Run group ${g.name}`}
              >
                <Icon name="play" size={12} /> Run group
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowNewScript(g.id)}
                aria-label={`Add script to ${g.name}`}
              >
                <Icon name="plus" size={12} /> Script
              </button>
              <button
                type="button"
                className="btn-icon"
                onClick={() => deleteGroup(g.id)}
                aria-label={`Delete group ${g.name}`}
                title="Delete group"
              >
                <Icon name="x" size={13} />
              </button>
            </div>

            {showNewScript === g.id && (
              <form
                onSubmit={(e) => createScript(e, g.id)}
                style={{ display: 'flex', gap: 8, marginBottom: 8 }}
              >
                <input
                  autoFocus
                  type="text"
                  placeholder="Script name"
                  value={newScriptName}
                  onChange={(e) => setNewScriptName(e.target.value)}
                  style={{ flex: 1, maxWidth: 300 }}
                  aria-label="New script name"
                />
                <button type="submit" className="btn btn-primary btn-sm">Create</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowNewScript(null)}>Cancel</button>
              </form>
            )}

            {groupScripts.length === 0 && (
              <p className="muted" style={{ fontSize: '0.82rem', paddingLeft: 8 }}>No scripts in this group.</p>
            )}

            {groupScripts.map((s) => (
              <div
                key={s.id}
                className="ws-item"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}
              >
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => onOpenScript(s.id)}
                  aria-label={`Open script ${s.name}`}
                  style={{ flex: 1, textAlign: 'left', justifyContent: 'flex-start', height: 'auto', gap: 8 }}
                >
                  <Icon name="play" size={13} style={{ color: 'var(--ink-3)' }} />
                  <span style={{ fontWeight: 500 }}>{s.name}</span>
                  <span className="muted" style={{ fontSize: '0.77rem' }}>
                    {safeJson(s.steps, []).length} step{safeJson(s.steps, []).length !== 1 ? 's' : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => runScript(s.id)}
                  aria-label={`Run script ${s.name}`}
                >
                  Run
                </button>
              </div>
            ))}
          </section>
        );
      })}

      {showGenerate && (
        <GenerateDialog
          testProjectId={testProject.id}
          projectId={projectId}
          groupId={groups[0]?.id}
          onClose={() => setShowGenerate(false)}
          onGenerated={(genId, desc) => addGenJob({ id: genId, kind: 'generate', description: desc, status: 'pending' })}
        />
      )}
      {showImport && (
        <ImportTestsDialog
          testProjectId={testProject.id}
          projectId={projectId}
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Runs tab ──────────────────────────────────────────────────────────────────

function RunsTab({ testProject, projectId, onOpenRun }) {
  const [runs, setRuns]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get(`/api/projects/${projectId}/tests/${testProject.id}/runs`);
      setRuns(data.runs || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [testProject.id, projectId]);

  useEffect(() => { load(); }, [load]);

  const filtered = (runs || []).filter((r) => {
    if (statusFilter === 'all') return true;
    return r.status === statusFilter;
  });

  if (loading) return <div className="spinner" aria-label="Loading runs…" />;
  if (error)   return <p className="error-note" role="alert">{error}</p>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: '0.84rem' }}>{runs?.length ?? 0} runs</span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
          style={{ marginLeft: 'auto' }}
        >
          <option value="all">All statuses</option>
          {['queued', 'running', 'passed', 'failed', 'cancelled', 'error'].map((s) => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
        <button type="button" className="btn-icon" onClick={load} aria-label="Refresh runs">
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {filtered.length === 0 && (
        <div className="ws-placeholder">
          <Icon name="play" size={32} />
          <p>{statusFilter === 'all' ? 'No runs yet. Run a script or group to see results.' : `No ${statusFilter} runs.`}</p>
        </div>
      )}

      {filtered.map((r) => {
        const duration = r.finished_at && r.started_at
          ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000)
          : null;
        return (
          <div
            key={r.id}
            className="ws-item"
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', cursor: 'pointer' }}
            onClick={() => onOpenRun(r.id)}
            tabIndex={0}
            role="button"
            aria-label={`Open run ${r.id}`}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenRun(r.id); } }}
          >
            <span className={`dot ${statusDotClass(r.status)}`} aria-label={r.status} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>
                {r.script_id ? `Script run` : r.group_id ? `Group run` : `Run`}
              </div>
              <div className="muted" style={{ fontSize: '0.77rem' }}>
                {r.status} · {formatRelative(r.created_at)}
                {duration !== null && ` · ${duration}s`}
              </div>
            </div>
            <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-3)' }} />
          </div>
        );
      })}
    </div>
  );
}

// ── Run detail ────────────────────────────────────────────────────────────────

function RunDetail({ runId, testProject, projectId, onBack }) {
  const [run, setRun]         = useState(null);
  const [runSteps, setRunSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const { toast: runToast, toasts: runToasts, removeToast: runRemoveToast } = useToast();
  const [expandedScreenshot, setExpandedScreenshot] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get(
        `/api/projects/${projectId}/tests/${testProject.id}/runs/${runId}`,
      );
      setRun(data.run);
      setRunSteps(data.steps || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [runId, testProject.id, projectId]);

  useEffect(() => { load(); }, [load]);

  // Poll while running
  useEffect(() => {
    if (!run || run.status === 'queued' || run.status === 'running') {
      pollRef.current = setInterval(load, 3000);
    }
    return () => clearInterval(pollRef.current);
  }, [run, load]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.post(
        `/api/projects/${projectId}/tests/${testProject.id}/runs/${runId}/cancel`,
        {},
      );
      load();
    } catch (e) {
      runToast(e.message, 'error');
    } finally {
      setCancelling(false);
    }
  };

  if (loading) return <div className="page"><div className="spinner" aria-label="Loading run…" /></div>;
  if (error)   return (
    <div className="page">
      <button type="button" className="btn-icon" onClick={onBack} style={{ marginBottom: 12 }}>
        <Icon name="chevronLeft" size={16} />
      </button>
      <p className="error-note" role="alert">{error}</p>
    </div>
  );

  const isRunning = run?.status === 'running' || run?.status === 'queued';

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button type="button" className="btn-icon" onClick={onBack} aria-label="Back">
          <Icon name="chevronLeft" size={16} />
        </button>
        <h2 style={{ margin: 0, flex: 1, fontSize: '1rem' }}>
          Run detail
          <span className={`badge${run?.status === 'passed' ? ' badge-info' : run?.status === 'failed' ? '' : ''}`} style={{ marginLeft: 8 }}>
            {run?.status}
          </span>
        </h2>
        {isRunning && (
          <button type="button" className="btn btn-danger btn-sm" onClick={cancel} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel run'}
          </button>
        )}
      </div>

      {run?.error && (
        <div className="error-note" role="alert" style={{ marginBottom: 12 }}>{run.error}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {runSteps.map((step, i) => (
          <div
            key={step.id || i}
            style={{
              border: `1px solid ${step.status === 'passed' ? 'var(--ok)' : step.status === 'failed' || step.status === 'error' ? 'var(--danger)' : 'var(--line)'}`,
              borderRadius: 'var(--radius)',
              padding: '8px 12px',
              background: 'var(--canvas)',
            }}
            aria-label={`Step ${i + 1}: ${step.status}`}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={`dot ${statusDotClass(step.status)}`} />
              <span style={{ fontWeight: 500, fontSize: '0.84rem' }}>Step {step.step_index + 1}</span>
              <span className="muted" style={{ fontSize: '0.77rem' }}>
                {step.duration_ms != null ? `${step.duration_ms}ms` : ''}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: '0.77rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {step.status}
              </span>
            </div>
            {step.error && (
              <p style={{ fontSize: '0.8rem', color: 'var(--danger)', marginTop: 4, fontFamily: 'var(--mono)' }}>
                {step.error}
              </p>
            )}
            {step.screenshot_path && (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setExpandedScreenshot(
                    expandedScreenshot === step.id ? null : step.id
                  )}
                  aria-expanded={expandedScreenshot === step.id}
                >
                  {expandedScreenshot === step.id ? 'Hide screenshot' : 'Show screenshot'}
                </button>
                {expandedScreenshot === step.id && (
                  <a
                    href={`/api/projects/${projectId}/tests/${testProject.id}/runs/${runId}/steps/${step.step_index}/screenshot`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: 'block', marginTop: 8 }}
                    aria-label={`Full screenshot for step ${step.step_index + 1}`}
                  >
                    <img
                      src={`/api/projects/${projectId}/tests/${testProject.id}/runs/${runId}/steps/${step.step_index}/screenshot`}
                      alt={`Screenshot for step ${step.step_index + 1}`}
                      style={{ maxWidth: '100%', borderRadius: 'var(--radius)', cursor: 'pointer' }}
                      loading="lazy"
                    />
                  </a>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {expandedScreenshot && (
        <button
          type="button"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200, cursor: 'zoom-out', border: 'none', padding: 0 }}
          aria-label="Close screenshot"
          onClick={() => setExpandedScreenshot(null)}
        />
      )}
      <ToastShelf toasts={runToasts} onRemove={runRemoveToast} />
    </div>
  );
}

// ── Vault tab ─────────────────────────────────────────────────────────────────

function VaultTab({ testProject, projectId }) {
  const [items, setItems]     = useState([]);
  const [files, setFiles]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showImportCsv, setShowImportCsv] = useState(false);
  const [importCsv, setImportCsv] = useState('name,kind,username,password,totp,value\n');
  const [importBusy, setImportBusy] = useState(false);
  const [importErrors, setImportErrors] = useState([]);
  const [newKind, setNewKind] = useState('login');
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newTotp, setNewTotp] = useState('');
  const [newValue, setNewValue] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState(null);
  const { confirmState: vaultConfirmState, requestConfirm: vaultConfirm } = useConfirm();
  const { toast: vaultToast, toasts: vaultToasts, removeToast: vaultRemoveToast } = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [vd, fd] = await Promise.all([
        api.get(`/api/projects/${projectId}/tests/${testProject.id}/vault`),
        api.get(`/api/projects/${projectId}/tests/${testProject.id}/vault/files`),
      ]);
      setItems(vd.items || []);
      setFiles(fd.files || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [testProject.id, projectId]);

  useEffect(() => { load(); }, [load]);

  const deleteItem = async (id) => {
    if (!await vaultConfirm('Delete this credential?', 'Delete', 'danger')) return;
    try {
      await api.delete(`/api/projects/${projectId}/tests/${testProject.id}/vault/${id}`);
      load();
    } catch (e) { vaultToast(e.message, 'error'); }
  };

  const createItem = async (e) => {
    e.preventDefault();
    setAddBusy(true);
    setAddError(null);
    try {
      const body = { name: newName.trim(), kind: newKind };
      if (newKind === 'login') {
        body.username = newUsername;
        body.password = newPassword;
        body.totpSecret = newTotp;
      } else {
        body.value = newValue;
      }
      await api.post(`/api/projects/${projectId}/tests/${testProject.id}/vault`, body);
      setShowNew(false);
      setNewName(''); setNewUsername(''); setNewPassword(''); setNewTotp(''); setNewValue('');
      load();
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAddBusy(false);
    }
  };

  const importCsvSubmit = async (e) => {
    e.preventDefault();
    setImportBusy(true);
    setImportErrors([]);
    try {
      const data = await api.post(
        `/api/projects/${projectId}/tests/${testProject.id}/vault/import`,
        { csv: importCsv },
      );
      setImportErrors(data.errors || []);
      if ((data.errors || []).length === 0) { setShowImportCsv(false); load(); }
      else { load(); }
    } catch (e) {
      setImportErrors([{ row: 0, error: e.message }]);
    } finally {
      setImportBusy(false);
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading vault…" />;
  if (error)   return <p className="error-note" role="alert">{error}</p>;

  return (
    <div>
      <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 12 }}>
        Credentials are write-only. Once saved, values can only be replaced, not read.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowNew((v) => !v)}>
          <Icon name="plus" size={13} /> New credential
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowImportCsv((v) => !v)}>
          Import CSV
        </button>
      </div>

      {/* Add credential form */}
      {showNew && (
        <form onSubmit={createItem} className="stack" style={{ maxWidth: 420, marginBottom: 20, padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}>
          <h3 style={{ marginBottom: 8, fontSize: '0.9rem' }}>New credential</h3>
          <div className="field">
            <label htmlFor="vault-name">Name</label>
            <input
              id="vault-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="admin-login"
              required
              aria-required="true"
            />
          </div>
          <div role="group" aria-label="Credential type">
            {['login', 'secret'].map((k) => (
              <label key={k} className={`choice${newKind === k ? ' is-checked' : ''}`} style={{ marginBottom: 4 }}>
                <input
                  type="radio"
                  name="vault-kind"
                  value={k}
                  checked={newKind === k}
                  onChange={() => setNewKind(k)}
                />
                <span>{k.charAt(0).toUpperCase() + k.slice(1)}</span>
              </label>
            ))}
          </div>
          {newKind === 'login' && (
            <>
              <div className="field">
                <label htmlFor="vault-username">Username</label>
                <input id="vault-username" type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="vault-password">Password</label>
                <input
                  id="vault-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  aria-describedby="vault-pwd-hint"
                />
                <p className="field-hint" id="vault-pwd-hint">Write-only — not shown after saving.</p>
              </div>
              <div className="field">
                <label htmlFor="vault-totp">Authenticator key (TOTP secret) <span className="muted">(optional)</span></label>
                <input
                  id="vault-totp"
                  type="password"
                  value={newTotp}
                  onChange={(e) => setNewTotp(e.target.value)}
                  autoComplete="off"
                  placeholder="JBSWY3DPEHPK3PXP"
                />
              </div>
            </>
          )}
          {newKind === 'secret' && (
            <div className="field">
              <label htmlFor="vault-secret-value">Secret value</label>
              <input
                id="vault-secret-value"
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                autoComplete="new-password"
                aria-describedby="vault-val-hint"
              />
              <p className="field-hint" id="vault-val-hint">Write-only — not shown after saving.</p>
            </div>
          )}
          {addError && <p className="error-note" role="alert">{addError}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={addBusy || !newName.trim()}>
              {addBusy ? 'Saving…' : 'Save credential'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </form>
      )}

      {/* CSV import */}
      {showImportCsv && (
        <form onSubmit={importCsvSubmit} style={{ maxWidth: 480, marginBottom: 20, padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}>
          <h3 style={{ marginBottom: 8, fontSize: '0.9rem' }}>Import credentials from CSV</h3>
          <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 8 }}>
            Columns: <code>name, kind, username, password, totp, value</code>
          </p>
          <textarea
            rows={6}
            value={importCsv}
            onChange={(e) => { setImportCsv(e.target.value); setImportErrors([]); }}
            style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}
            aria-label="Credential CSV"
          />
          {importErrors.length > 0 && (
            <ul style={{ fontSize: '0.8rem', color: 'var(--danger)', paddingLeft: 20, marginTop: 4 }}>
              {importErrors.map((e, i) => <li key={i}>Row {e.row}: {e.error}</li>)}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={importBusy}>
              {importBusy ? 'Importing…' : 'Import'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowImportCsv(false)}>Cancel</button>
          </div>
        </form>
      )}

      {/* Credentials list */}
      <h3 style={{ marginBottom: 8, fontSize: '0.9rem' }}>Credentials</h3>
      {items.length === 0
        ? <p className="muted" style={{ fontSize: '0.84rem' }}>No credentials yet.</p>
        : (
          <div style={{ marginBottom: 20 }}>
            {items.map((item) => (
              <div
                key={item.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid var(--line-2)' }}
              >
                <span style={{ fontWeight: 500, flex: 1 }}>{item.name}</span>
                <span className="badge">{item.kind}</span>
                {item.kind === 'login' && item.username && (
                  <span className="muted" style={{ fontSize: '0.78rem' }}>{item.username}</span>
                )}
                {item.kind === 'login' && item.hasTotp && (
                  <span className="badge badge-info" style={{ fontSize: '0.69rem' }}>authenticator key set</span>
                )}
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => deleteItem(item.id)}
                  aria-label={`Delete credential ${item.name}`}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
          </div>
        )
      }

      {/* Files section */}
      <h3 style={{ marginBottom: 8, fontSize: '0.9rem' }}>Upload files</h3>
      <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 8 }}>
        Files can be referenced in upload steps as <code>{'{{file.name}}'}</code>.
      </p>
      {files.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {files.map((f) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: '1px solid var(--line-2)' }}>
              <span style={{ flex: 1, fontSize: '0.84rem' }}>{f.name}</span>
              <span className="muted" style={{ fontSize: '0.76rem' }}>
                {f.size_bytes ? `${Math.ceil(f.size_bytes / 1024)}KB` : ''}
              </span>
              <a
                href={`/api/projects/${projectId}/tests/${testProject.id}/vault/files/${f.id}/download`}
                download={f.name}
                className="btn btn-ghost btn-sm"
                aria-label={`Download ${f.name}`}
              >
                Download
              </a>
              <button
                type="button"
                className="btn-icon"
                onClick={async () => {
                  if (!await vaultConfirm(`Delete file ${f.name}?`, 'Delete', 'danger')) return;
                  try {
                    await api.delete(`/api/projects/${projectId}/tests/${testProject.id}/vault/files/${f.id}`);
                    load();
                  } catch (e) { vaultToast(e.message, 'error'); }
                }}
                aria-label={`Delete file ${f.name}`}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog state={vaultConfirmState} />
      <ToastShelf toasts={vaultToasts} onRemove={vaultRemoveToast} />
    </div>
  );
}

// ── Test project settings tab ─────────────────────────────────────────────────

function SettingsTab({ testProject, projectId, onUpdated }) {
  const [name, setName]         = useState(testProject.name);
  const [appUrl, setAppUrl]     = useState(testProject.appUrl);
  const [apiBase, setApiBase]   = useState(testProject.apiBaseUrl || '');
  const [rules, setRules]       = useState(testProject.rulesForAi || '');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState(null);
  const [saved, setSaved]       = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const data = await api.put(
        `/api/projects/${projectId}/tests/${testProject.id}`,
        {
          name: name.trim(),
          appUrl: appUrl.trim(),
          apiBaseUrl: apiBase.trim() || null,
          rulesForAi: rules,
        },
      );
      onUpdated(data.testProject);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="stack" style={{ maxWidth: 560 }} noValidate>
      <h3>Test project settings</h3>
      <div className="field">
        <label htmlFor="tp-name">Name</label>
        <input id="tp-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="tp-appurl">App URL *</label>
        <input
          id="tp-appurl"
          type="url"
          value={appUrl}
          onChange={(e) => setAppUrl(e.target.value)}
          placeholder="https://myapp.example.com"
          required
          aria-describedby="tp-appurl-hint"
        />
        <p className="field-hint" id="tp-appurl-hint">Where every run starts. Scripts open paths relative to it.</p>
      </div>
      <div className="field">
        <label htmlFor="tp-apibase">API base URL <span className="muted">(optional)</span></label>
        <input
          id="tp-apibase"
          type="url"
          value={apiBase}
          onChange={(e) => setApiBase(e.target.value)}
          placeholder="https://myapp.example.com/api"
        />
      </div>
      <div className="field">
        <label htmlFor="tp-rules">Rules for the AI ({rules.length}/4000 chars)</label>
        <textarea
          id="tp-rules"
          rows={5}
          maxLength={4000}
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          placeholder="Instructions applied to every AI generation for this project…"
        />
      </div>
      {error && <p className="error-note" role="alert">{error}</p>}
      {saved && <p role="status" style={{ color: 'var(--ok)', fontSize: '0.84rem' }}>✓ Settings saved.</p>}
      <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: 'fit-content' }}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}

// ── Test project detail ───────────────────────────────────────────────────────

const TP_TABS = [
  { id: 'scripts',  label: 'Scripts' },
  { id: 'cases',    label: 'Test cases' },
  { id: 'runs',     label: 'Runs' },
  { id: 'vault',    label: 'Vault' },
  { id: 'settings', label: 'Settings' },
];

function TestProjectDetail({ testProjectId, activeTab, projectId, route, onBack }) {
  const [testProject, setTestProject] = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [tab, setTab]                 = useState(activeTab || 'scripts');
  // Script/run/case-set IDs come from route props (URL-driven) to avoid stale state
  const openScriptId  = route?.scriptId  ?? null;
  const openRunId     = route?.runId     ?? null;
  const openCaseSetId = route?.caseSetId ?? null;

  const openScript  = (sid)  => navigate(href(projectId, 'tests', testProjectId, 'scripts', sid));
  const openRun     = (rid)  => navigate(href(projectId, 'tests', testProjectId, 'runs', rid));
  const openCaseSet = (csid) => navigate(href(projectId, 'tests', testProjectId, 'cases', csid));

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get(`/api/projects/${projectId}/tests/${testProjectId}`);
      setTestProject(data.testProject);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [testProjectId, projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="page"><div className="spinner" aria-label="Loading test project…" /></div>;
  if (error)   return (
    <div className="page">
      <button type="button" className="btn-icon" onClick={onBack}><Icon name="chevronLeft" size={16} /></button>
      <p className="error-note" role="alert">{error}</p>
    </div>
  );

  if (openScriptId) {
    return (
      <ScriptEditor
        scriptId={openScriptId}
        testProjectId={testProjectId}
        projectId={projectId}
        onBack={() => navigate(href(projectId, 'tests', testProjectId))}
      />
    );
  }

  if (openRunId) {
    return (
      <RunDetail
        runId={openRunId}
        testProject={testProject}
        projectId={projectId}
        onBack={() => navigate(href(projectId, 'tests', testProjectId, 'runs'))}
      />
    );
  }

  if (openCaseSetId) {
    return (
      <CaseSetViewer
        caseSetId={openCaseSetId}
        testProject={testProject}
        projectId={projectId}
        onBack={() => navigate(href(projectId, 'tests', testProjectId, 'cases'))}
      />
    );
  }

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button type="button" className="btn-icon" onClick={onBack} aria-label="Back to test projects">
          <Icon name="chevronLeft" size={16} />
        </button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', flex: 1 }}>{testProject.name}</h2>
        <span className="muted" style={{ fontSize: '0.82rem' }}>{testProject.appUrl}</span>
      </div>

      <div className="tab-bar" role="tablist" aria-label="Test project sections">
        {TP_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            id={`tp-tab-${t.id}`}
            className={`tab-btn${tab === t.id ? ' is-active' : ''}`}
            aria-selected={tab === t.id}
            aria-controls={`tp-panel-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`tp-panel-${tab}`} aria-labelledby={`tp-tab-${tab}`} className="tab-panel">
        {tab === 'scripts' && (
          <ScriptsTab
            testProject={testProject}
            projectId={projectId}
            onOpenScript={openScript}
            onOpenCasesDialog={() => setTab('cases')}
          />
        )}
        {tab === 'cases' && (
          <CaseSetList
            testProject={testProject}
            projectId={projectId}
            onOpenCaseSet={openCaseSet}
          />
        )}
        {tab === 'runs' && (
          <RunsTab
            testProject={testProject}
            projectId={projectId}
            onOpenRun={openRun}
          />
        )}
        {tab === 'vault' && (
          <VaultTab testProject={testProject} projectId={projectId} />
        )}
        {tab === 'settings' && (
          <SettingsTab
            testProject={testProject}
            projectId={projectId}
            onUpdated={(updated) => setTestProject(updated)}
          />
        )}
      </div>
    </div>
  );
}

// ── New test project dialog ───────────────────────────────────────────────────

function NewTestProjectDialog({ projectId, repos, onClose, onCreate }) {
  const [name, setName]       = useState('');
  const [appUrl, setAppUrl]   = useState('');
  const [apiBase, setApiBase] = useState('');
  const [selectedRepos, setSelectedRepos] = useState(new Set());
  const [rules, setRules]     = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);
  const nameRef = useRef(null);
  const trapRef = useFocusTrap();

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleRepo = (id) => {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api.post(`/api/projects/${projectId}/tests`, {
        name: name.trim(),
        appUrl: appUrl.trim(),
        apiBaseUrl: apiBase.trim() || undefined,
        repoIds: [...selectedRepos],
        rulesForAi: rules,
      });
      onCreate(data.testProject);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const overlayDismiss = useOverlayDismiss(onClose);

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
        aria-labelledby="new-tp-title"
        style={{ maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="new-tp-title">New test project</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="dialog-body stack">
            <div className="field">
              <label htmlFor="ntp-name">Name <span aria-hidden="true">*</span></label>
              <input
                id="ntp-name"
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My App E2E Tests"
                required
                aria-required="true"
              />
            </div>
            <div className="field">
              <label htmlFor="ntp-appurl">App URL <span aria-hidden="true">*</span></label>
              <input
                id="ntp-appurl"
                type="url"
                value={appUrl}
                onChange={(e) => setAppUrl(e.target.value)}
                placeholder="https://myapp.example.com"
                required
                aria-required="true"
                aria-describedby="ntp-appurl-hint"
              />
              <p className="field-hint" id="ntp-appurl-hint">Where every run starts. Scripts open paths relative to it.</p>
            </div>
            <div className="field">
              <label htmlFor="ntp-apibase">API base URL <span className="muted">(optional)</span></label>
              <input
                id="ntp-apibase"
                type="url"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="https://myapp.example.com/api"
              />
            </div>
            {repos && repos.length > 0 && (
              <fieldset>
                <legend style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: 6, display: 'block' }}>
                  Repositories <span className="muted">(optional)</span>
                </legend>
                {repos.map((r) => (
                  <label key={r.id} className={`choice${selectedRepos.has(r.id) ? ' is-checked' : ''}`} style={{ marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      checked={selectedRepos.has(r.id)}
                      onChange={() => toggleRepo(r.id)}
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <div className="field">
              <label htmlFor="ntp-rules">Rules for the AI ({rules.length}/4000 chars) <span className="muted">(optional)</span></label>
              <textarea
                id="ntp-rules"
                rows={3}
                maxLength={4000}
                value={rules}
                onChange={(e) => setRules(e.target.value)}
                placeholder="Instructions the AI should follow when generating tests…"
              />
            </div>
            {error && <div className="error-note" role="alert">{error}</div>}
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !appUrl.trim()}>
              {busy ? 'Creating…' : 'Create test project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Test projects list ────────────────────────────────────────────────────────

function TestProjectList({ projectId, onSelect }) {
  const [projects, setProjects] = useState(null);
  const [repos, setRepos]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [capability, setCapability] = useState(null);
  const [showNew, setShowNew]   = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pd, capData, repoData] = await Promise.all([
        api.get(`/api/projects/${projectId}/tests`),
        api.get('/api/tests/capability').catch(() => null),
        api.get(`/api/projects/${projectId}/repos`).catch(() => ({ repos: [] })),
      ]);
      setProjects(pd.testProjects || []);
      setCapability(capData);
      setRepos(repoData.repos || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="page"><div className="spinner" aria-label="Loading tests…" /></div>;
  if (error)   return <div className="page"><p className="error-note" role="alert">{error}</p></div>;

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ flex: 1 }}>Tests</h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>
          <Icon name="plus" size={14} /> New test project
        </button>
      </div>

      <BrowserBanner available={capability?.available} reason={capability?.reason} />

      {projects.length === 0 && (
        <div className="ws-placeholder">
          <Icon name="play" size={48} />
          <p>No test projects yet.</p>
          <p className="muted">Create a test project to start writing AI-assisted end-to-end tests.</p>
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
            Create your first test project
          </button>
        </div>
      )}

      {projects.map((tp) => (
        <button
          key={tp.id}
          type="button"
          className="ws-item"
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', width: '100%', textAlign: 'left', cursor: 'pointer', border: 'none', background: 'none' }}
          onClick={() => onSelect(tp.id)}
          aria-label={`Open test project: ${tp.name}`}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{tp.name}</div>
            <div className="muted" style={{ fontSize: '0.78rem' }}>
              {tp.appUrl} · {formatRelative(tp.updatedAt)}
            </div>
          </div>
          <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-3)' }} />
        </button>
      ))}

      {showNew && (
        <NewTestProjectDialog
          projectId={projectId}
          repos={repos}
          onClose={() => setShowNew(false)}
          onCreate={(tp) => { load(); onSelect(tp.id); }}
        />
      )}
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────

/**
 * @param {{
 *   projectId: string,
 *   route: { rest: string[] },
 * }} props
 */
export function TestsPage({ projectId, route }) {
  const rest = route?.rest || [];
  const testProjectId = rest[0] || null;
  const activeTab     = rest[1] || 'scripts';
  // rest[2] is the id of script/run when rest[1] is 'scripts'/'runs'
  const subId         = rest[2] || null;

  const handleSelect = (tpid) => {
    navigate(href(projectId, 'tests', tpid));
  };

  const handleBack = () => {
    navigate(href(projectId, 'tests'));
  };

  if (!testProjectId) {
    return <TestProjectList projectId={projectId} onSelect={handleSelect} />;
  }

  // Derive scriptId/runId/caseSetId from URL so state is URL-driven
  const scriptId  = activeTab === 'scripts' && subId ? subId : null;
  const runId     = activeTab === 'runs'    && subId ? subId : null;
  const caseSetId = activeTab === 'cases'   && subId ? subId : null;

  // Use full route path as key so component remounts when navigation changes (avoids stale state)
  const routeKey = rest.join('/');

  return (
    <TestProjectDetail
      key={routeKey}
      testProjectId={testProjectId}
      activeTab={scriptId || runId || caseSetId ? activeTab : (activeTab || 'scripts')}
      projectId={projectId}
      route={{ scriptId, runId, caseSetId }}
      onBack={handleBack}
    />
  );
}
