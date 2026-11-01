/**
 * CaseSetViewer — detail view for a single test case set.
 *
 * Shows:
 *  - Header: editable name, status badge / live progress tracker, Download Excel link, Back
 *  - Summary strip: total, per-status counts, per-category counts (filterable)
 *  - Table with columns matching the Excel export order:
 *    Test ID | Category | Scenario | Precondition | Test Steps | Expected Result |
 *    [Request] | [Response] | Status | Remarks | Actions
 *    Request/Response columns are hidden when no case in the set carries them.
 *  - Inline edits: Status (select with pills) and Remarks (text field), saved on change/blur
 *  - Row "Edit" dialog for full row editing (includes request/response fields)
 *  - Add-row and delete-row actions
 *  - Progressive updates while generation is running (re-fetched each poll)
 *  - Generation steps panel (trace) for running, failed, and finished case sets
 *
 * Props:
 *   caseSetId   - string
 *   testProject - test project object
 *   projectId   - string
 *   onBack()    - called when Back is clicked
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../../components/Toast.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { formatRelative } from '../../lib/util.js';
import { GenerationTracker, StepTimeline } from './GenerationTracker.jsx';
import { buildCurl, prettyBody } from '../../lib/curlBuilder.js';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';
import './tests-cases.css';

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_OPTIONS  = ['', 'Pass', 'Fail', 'Blocked', 'Not Run'];
const HTTP_METHODS    = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// ── Column resize / sort constants ────────────────────────────────────────────

const LS_WIDTHS_KEY  = 'case-table-widths:v1';
const LS_SORT_KEY    = 'case-table-sort:v1';
const LS_WRAP_KEY    = 'case-table-wrap:v1';
const MIN_COL_W      = 60;
const RESIZE_STEP    = 16;

/** Status sort order: Fail < Blocked < Not Run < Pass < blank */
const STATUS_SORT_ORDER = { Fail: 0, Blocked: 1, 'Not Run': 2, Pass: 3 };

/** Default column widths (px). Ratios: 12:35:60:50:70:60:12:30 */
const DEFAULT_COL_WIDTHS = {
  testId: 80, category: 120, scenario: 180, precondition: 150,
  steps:  210, expectedResult: 180, request: 160, response: 110,
  status: 90,  remarks: 110,
};

/**
 * Natural sort for test IDs like TC-2.1.9 < TC-2.1.10 < TC-10.1.
 * Non-TC IDs sort after TC IDs.
 */
function naturalTestIdCmp(a, b) {
  const parse = (id) => {
    const m = /^TC-(.+)$/i.exec(id || '');
    if (!m) return null;
    return m[1].split('.').map((n) => parseInt(n, 10) || 0);
  };
  const pa = parse(a), pb = parse(b);
  if (!pa && !pb) return (a || '').localeCompare(b || '', undefined, { numeric: true });
  if (!pa) return 1;
  if (!pb) return -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? -1, nb = pb[i] ?? -1;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Category sort: compare leading numeric prefix first, then lexically. */
function categoryLeadingCmp(a, b) {
  const leadNum = (s) => {
    const m = /^(\d+)/.exec(s || '');
    return m ? parseInt(m[1], 10) : Infinity;
  };
  const na = leadNum(a), nb = leadNum(b);
  if (na !== nb) return na - nb;
  return (a || '').localeCompare(b || '', undefined, { numeric: true });
}

function statusPillClass(status) {
  if (status === 'Pass')    return 'status-pill status-pill-pass';
  if (status === 'Fail')    return 'status-pill status-pill-fail';
  if (status === 'Blocked') return 'status-pill status-pill-blocked';
  if (status === 'Not Run') return 'status-pill status-pill-not-run';
  return null;
}

function methodBadgeClass(method) {
  const m = (method || 'GET').toUpperCase();
  const map = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete', HEAD: 'head' };
  return `method-badge method-${map[m] || 'other'}`;
}

// ── Copy button (self-contained, no external toast) ───────────────────────────

function CopyButton({ text, label = 'Copy', size = 12, style: extraStyle }) {
  const [done, setDone] = useState(false);
  const handle = async (e) => {
    e.stopPropagation();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button
      type="button"
      className="btn-icon"
      onClick={handle}
      aria-label={done ? 'Copied!' : label}
      title={done ? 'Copied!' : label}
      style={{ width: 22, height: 22, ...extraStyle }}
    >
      <Icon name={done ? 'check' : 'copy'} size={size} />
    </button>
  );
}

// ── Clamped cell — click to expand ───────────────────────────────────────────

function CellClamp({ text }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  return (
    <div
      className={`cell-clamp${expanded ? ' expanded' : ''}`}
      onClick={() => setExpanded((e) => !e)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((ex) => !ex); } }}
      role="button"
      tabIndex={0}
      title={expanded ? 'Click to collapse' : 'Click to expand'}
      aria-expanded={expanded}
    >
      {text}
    </div>
  );
}

// ── Request cell ──────────────────────────────────────────────────────────────

function RequestCell({ request }) {
  const [expanded, setExpanded] = useState(false);
  if (!request) return <span style={{ color: 'var(--ink-3)', fontSize: '0.78rem' }}>—</span>;

  const curl = buildCurl(request);
  const body = prettyBody(request);

  return (
    <div className="api-cell">
      <div className="api-cell-summary">
        <span className={methodBadgeClass(request.method)}>{(request.method || 'GET').toUpperCase()}</span>
        <span className="api-cell-url" title={request.url}>{request.url}</span>
        <button
          type="button"
          className="btn-icon"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse request' : 'Expand request'}
          style={{ width: 18, height: 18, flexShrink: 0 }}
        >
          <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={11} />
        </button>
      </div>

      {expanded && (
        <>
          {request.headers && Object.keys(request.headers).length > 0 && (
            <pre className="cell-code-block" style={{ marginTop: 4 }}>
              {Object.entries(request.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
            </pre>
          )}
          {body && (
            <pre className="cell-code-block" style={{ marginTop: 4 }}>{body}</pre>
          )}
          <div className="api-cell-actions">
            <CopyButton text={curl} label="Copy as cURL" size={10} />
            {body && <CopyButton text={body} label="Copy body" size={10} />}
          </div>
        </>
      )}
    </div>
  );
}

// ── Response cell ─────────────────────────────────────────────────────────────

function ResponseCell({ response }) {
  const [expanded, setExpanded] = useState(false);
  if (!response) return <span style={{ color: 'var(--ink-3)', fontSize: '0.78rem' }}>—</span>;

  const body     = prettyBody(response);
  const status   = response.status;
  const is2xx    = status != null && status >= 200 && status < 300;

  return (
    <div className="api-cell">
      <div className="api-cell-summary">
        {status != null && (
          <span className={`status-code-badge ${is2xx ? 'ok' : 'err'}`}>{status}</span>
        )}
        {body && (
          <button
            type="button"
            className="btn-icon"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse response' : 'Expand response'}
            style={{ width: 18, height: 18, flexShrink: 0 }}
          >
            <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={11} />
          </button>
        )}
        {!body && !status && (
          <span style={{ color: 'var(--ink-3)', fontSize: '0.78rem' }}>—</span>
        )}
      </div>

      {expanded && body && (
        <>
          <pre className="cell-code-block" style={{ marginTop: 4 }}>{body}</pre>
          <div className="api-cell-actions">
            <CopyButton text={body} label="Copy response body" size={10} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Request / Response fields (shared between dialogs) ───────────────────────

function RequestFields({ enabled, onToggle, method, setMethod, url, setUrl, headers, setHeaders, body, setBody, headersError, disabled }) {
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={disabled}
        />
        API Test — Request
      </label>

      {enabled && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              disabled={disabled}
              style={{ width: 100 }}
              aria-label="HTTP method"
            >
              {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/endpoint"
              style={{ flex: 1, minWidth: 0 }}
              aria-label="Request URL"
              disabled={disabled}
            />
          </div>
          <div className="field">
            <label style={{ fontSize: '0.82rem' }}>Headers (JSON object, optional)</label>
            <textarea
              rows={2}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder='{"Content-Type": "application/json"}'
              style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}
              aria-label="Request headers JSON"
              disabled={disabled}
            />
            {headersError && (
              <div className="error-note" role="alert" style={{ marginTop: 3, padding: '4px 8px', fontSize: '0.78rem' }}>
                {headersError}
              </div>
            )}
          </div>
          <div className="field">
            <label style={{ fontSize: '0.82rem' }}>Body (optional)</label>
            <textarea
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder='{"key": "value"}'
              style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}
              aria-label="Request body"
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ResponseFields({ enabled, onToggle, status, setStatus, body, setBody, disabled }) {
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={disabled}
        />
        API Test — Expected Response
      </label>

      {enabled && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="field" style={{ maxWidth: 160 }}>
            <label style={{ fontSize: '0.82rem' }}>Status code</label>
            <input
              type="number"
              min={100}
              max={599}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder="200"
              aria-label="Expected HTTP status code"
              disabled={disabled}
            />
          </div>
          <div className="field">
            <label style={{ fontSize: '0.82rem' }}>Body (optional)</label>
            <textarea
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder='{"success": true}'
              style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}
              aria-label="Expected response body"
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Parse request/response from saved case row ────────────────────────────────

function parseBodyField(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  try { return JSON.stringify(val, null, 2); } catch { return String(val); }
}

function buildRequestObj(enabled, method, url, headers, body) {
  if (!enabled || !url.trim()) return null;
  let parsedHeaders = null;
  if (headers.trim()) {
    try { parsedHeaders = JSON.parse(headers); } catch { return undefined; /* signal error */ }
  }
  return { method, url: url.trim(), headers: parsedHeaders, body: body || null };
}

function buildResponseObj(enabled, status, body) {
  if (!enabled) return null;
  return { status: status ? Number(status) : null, body: body || null };
}

// ── Edit row dialog ────────────────────────────────────────────────────────────

function EditCaseDialog({ caseRow, onSave, onClose }) {
  const [form, setForm] = useState({
    category:       caseRow.category       || '',
    scenario:       caseRow.scenario       || '',
    precondition:   caseRow.precondition   || '',
    steps:          caseRow.steps          || '',
    expectedResult: caseRow.expectedResult || '',
    status:         caseRow.status         || '',
    remarks:        caseRow.remarks        || '',
  });
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const trapRef = useFocusTrap();

  // Request fields
  const [hasReq,     setHasReq]     = useState(!!caseRow.request);
  const [reqMethod,  setReqMethod]  = useState(caseRow.request?.method || 'GET');
  const [reqUrl,     setReqUrl]     = useState(caseRow.request?.url || '');
  const [reqHeaders, setReqHeaders] = useState(parseBodyField(caseRow.request?.headers));
  const [reqBody,    setReqBody]    = useState(parseBodyField(caseRow.request?.body));
  const [headersErr, setHeadersErr] = useState(null);

  // Response fields
  const [hasRes,    setHasRes]    = useState(!!caseRow.response);
  const [resStatus, setResStatus] = useState(caseRow.response?.status != null ? String(caseRow.response.status) : '');
  const [resBody,   setResBody]   = useState(parseBodyField(caseRow.response?.body));

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
    disabled: busy,
  });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setHeadersErr(null);

    const request = buildRequestObj(hasReq, reqMethod, reqUrl, reqHeaders, reqBody);
    if (request === undefined) {
      setHeadersErr('Headers must be a valid JSON object');
      setBusy(false);
      return;
    }
    const response = buildResponseObj(hasRes, resStatus, resBody);

    try {
      await onSave({ ...form, request, response });
      onClose();
    } catch (err) {
      setError(err.message);
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
        aria-labelledby="edit-case-title"
        style={{ maxWidth: 580, maxHeight: '90vh', overflowY: 'auto' }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="edit-case-title">Edit test case {caseRow.testId}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="dialog-body stack">
            {[
              { id: 'ec-cat',   label: 'Category',        key: 'category',       rows: 1 },
              { id: 'ec-scn',   label: 'Scenario',        key: 'scenario',       rows: 2 },
              { id: 'ec-pre',   label: 'Precondition',    key: 'precondition',   rows: 2 },
              { id: 'ec-steps', label: 'Test Steps',      key: 'steps',          rows: 4 },
              { id: 'ec-exp',   label: 'Expected Result', key: 'expectedResult', rows: 3 },
            ].map(({ id, label, key, rows }) => (
              <div className="field" key={key}>
                <label htmlFor={id}>{label}</label>
                <textarea id={id} rows={rows} {...field(key)} />
              </div>
            ))}

            <div className="field">
              <label htmlFor="ec-status">Status</label>
              <select id="ec-status" {...field('status')}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s || '— not set —'}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="ec-remarks">Remarks</label>
              <textarea id="ec-remarks" rows={2} {...field('remarks')} />
            </div>

            {/* Request / Response */}
            <RequestFields
              enabled={hasReq}
              onToggle={setHasReq}
              method={reqMethod}   setMethod={setReqMethod}
              url={reqUrl}         setUrl={setReqUrl}
              headers={reqHeaders} setHeaders={setReqHeaders}
              body={reqBody}       setBody={setReqBody}
              headersError={headersErr}
              disabled={busy}
            />
            <ResponseFields
              enabled={hasRes}
              onToggle={setHasRes}
              status={resStatus}   setStatus={setResStatus}
              body={resBody}       setBody={setResBody}
              disabled={busy}
            />

            {error && <div className="error-note" role="alert">{error}</div>}
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving\u2026' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add row dialog ─────────────────────────────────────────────────────────────

function AddCaseDialog({ existingCategories, onAdd, onClose }) {
  const [form, setForm] = useState({ category: '', scenario: '', precondition: '', steps: '', expectedResult: '', status: '', remarks: '' });
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const trapRef = useFocusTrap();

  // Request fields
  const [hasReq,     setHasReq]     = useState(false);
  const [reqMethod,  setReqMethod]  = useState('GET');
  const [reqUrl,     setReqUrl]     = useState('');
  const [reqHeaders, setReqHeaders] = useState('');
  const [reqBody,    setReqBody]    = useState('');
  const [headersErr, setHeadersErr] = useState(null);

  // Response fields
  const [hasRes,    setHasRes]    = useState(false);
  const [resStatus, setResStatus] = useState('');
  const [resBody,   setResBody]   = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((prev) => ({ ...prev, [key]: e.target.value })),
    disabled: busy,
  });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setHeadersErr(null);

    const request = buildRequestObj(hasReq, reqMethod, reqUrl, reqHeaders, reqBody);
    if (request === undefined) {
      setHeadersErr('Headers must be a valid JSON object');
      setBusy(false);
      return;
    }
    const response = buildResponseObj(hasRes, resStatus, resBody);

    try {
      await onAdd({ ...form, request, response });
      onClose();
    } catch (err) {
      setError(err.message);
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
        aria-labelledby="add-case-title"
        style={{ maxWidth: 580, maxHeight: '90vh', overflowY: 'auto' }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="add-case-title">Add test case</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="dialog-body stack">
            <div className="field">
              <label htmlFor="ac-cat">Category</label>
              {existingCategories.length > 0
                ? (
                  <datalist id="ac-cat-list">
                    {existingCategories.map((c) => <option key={c} value={c} />)}
                  </datalist>
                ) : null}
              <input id="ac-cat" type="text" list="ac-cat-list" {...field('category')} />
            </div>
            {[
              { id: 'ac-scn',   label: 'Scenario',        key: 'scenario',       rows: 2 },
              { id: 'ac-pre',   label: 'Precondition',    key: 'precondition',   rows: 2 },
              { id: 'ac-steps', label: 'Test Steps',      key: 'steps',          rows: 4 },
              { id: 'ac-exp',   label: 'Expected Result', key: 'expectedResult', rows: 3 },
            ].map(({ id, label, key, rows }) => (
              <div className="field" key={key}>
                <label htmlFor={id}>{label}</label>
                <textarea id={id} rows={rows} {...field(key)} />
              </div>
            ))}
            <div className="field">
              <label htmlFor="ac-status">Status</label>
              <select id="ac-status" {...field('status')}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>{s || '— not set —'}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ac-remarks">Remarks</label>
              <textarea id="ac-remarks" rows={2} {...field('remarks')} />
            </div>

            {/* Request / Response */}
            <RequestFields
              enabled={hasReq}
              onToggle={setHasReq}
              method={reqMethod}   setMethod={setReqMethod}
              url={reqUrl}         setUrl={setReqUrl}
              headers={reqHeaders} setHeaders={setReqHeaders}
              body={reqBody}       setBody={setReqBody}
              headersError={headersErr}
              disabled={busy}
            />
            <ResponseFields
              enabled={hasRes}
              onToggle={setHasRes}
              status={resStatus}   setStatus={setResStatus}
              body={resBody}       setBody={setResBody}
              disabled={busy}
            />

            {error && <div className="error-note" role="alert">{error}</div>}
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Adding\u2026' : 'Add case'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Status summary strip ──────────────────────────────────────────────────────

function SummaryStrip({ cases, activeCategory, onCategoryClick }) {
  const total = cases.length;
  const byStatus = STATUS_OPTIONS.slice(1).map((s) => ({ status: s, count: cases.filter((c) => c.status === s).length }));
  const noStatus = cases.filter((c) => !c.status).length;

  const categories = [...new Set(cases.map((c) => c.category || '').filter(Boolean))];
  const byCat = categories.map((cat) => ({ cat, count: cases.filter((c) => c.category === cat).length }));

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        padding: '10px 12px',
        background: 'color-mix(in srgb, var(--accent, #6366f1) 4%, var(--canvas))',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        marginBottom: 12,
        fontSize: '0.82rem',
        alignItems: 'center',
      }}
      aria-label="Test case summary"
    >
      <span style={{ color: 'var(--ink-2)', marginRight: 4 }}>
        <strong>{total}</strong> case{total !== 1 ? 's' : ''}
      </span>

      {byStatus.filter((s) => s.count > 0).map(({ status, count }) => {
        const cls = statusPillClass(status);
        return (
          <span key={status} className={cls || 'status-pill'}>
            {status}: {count}
          </span>
        );
      })}

      {noStatus > 0 && (
        <span className="status-pill status-pill-not-run">Unset: {noStatus}</span>
      )}

      {byCat.length > 0 && (
        <span
          aria-hidden="true"
          style={{ width: 1, height: 16, background: 'var(--line)', margin: '0 4px', flexShrink: 0 }}
        />
      )}

      {byCat.map(({ cat, count }) => (
        <button
          key={cat}
          type="button"
          className={`case-summary-chip${activeCategory === cat ? ' is-active' : ''}`}
          onClick={() => onCategoryClick(cat)}
          aria-pressed={activeCategory === cat}
          aria-label={`Filter by category: ${cat} (${count})`}
          title={cat}
        >
          {/* Truncate long category names */}
          <span className="case-summary-chip-cat">{cat}</span>
          <span style={{ opacity: 0.65, flexShrink: 0 }}>{count}</span>
        </button>
      ))}

      {activeCategory && (
        <button
          type="button"
          className="case-summary-chip"
          onClick={() => onCategoryClick(null)}
          aria-label="Clear category filter"
          style={{ borderColor: 'var(--accent, #6366f1)', color: 'var(--accent, #6366f1)' }}
        >
          <Icon name="x" size={11} /> Clear filter
        </button>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function CaseSetViewer({ caseSetId, testProject, projectId, onBack }) {
  const [caseSet, setCaseSet]   = useState(null);
  const [cases, setCases]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [editName, setEditName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [activeCategory, setActiveCategory] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [editRow, setEditRow]   = useState(null); // case row to edit
  const [showAdd, setShowAdd]   = useState(false);

  // Resume failed/interrupted generation
  const [resuming, setResuming] = useState(false);

  // Generation trace for finished/failed case sets
  const [showTrace, setShowTrace]   = useState(false);
  const [traceSteps, setTraceSteps] = useState([]);
  const [traceFetched, setTraceFetched] = useState(false);

  const pollRef = useRef(null);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast }   = useToast();

  // Optimistic status/remarks updates
  const [optimistic, setOptimistic] = useState({}); // { [caseId]: { status?, remarks? } }

  // ── Column widths, sort, wrap text ─────────────────────────────────────────
  const [colWidths, setColWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_WIDTHS_KEY) || 'null');
      return saved ? { ...DEFAULT_COL_WIDTHS, ...saved } : { ...DEFAULT_COL_WIDTHS };
    } catch { return { ...DEFAULT_COL_WIDTHS }; }
  });

  const [sort, setSort] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_SORT_KEY) || 'null');
      return (saved && saved.col) ? saved : { col: null, dir: 'asc' };
    } catch { return { col: null, dir: 'asc' }; }
  });

  const [wrapText, setWrapText] = useState(() => {
    try { return localStorage.getItem(LS_WRAP_KEY) === '1'; } catch { return false; }
  });

  const colgroupRef = useRef(null);
  const tableRef    = useRef(null);
  const dragRef     = useRef(null); // { colKey, colIdx, startX, startW, startTableW }

  const tpId = testProject.id;
  const base = `/api/projects/${projectId}/tests/${tpId}/case-sets/${caseSetId}`;

  const load = useCallback(async () => {
    try {
      const data = await api.get(base);
      setCaseSet(data.caseSet);
      setCases(data.cases || []);
      setEditName((prev) => prev || data.caseSet.name || '');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  // Poll while running
  useEffect(() => {
    if (!caseSet) return;
    const active = caseSet.status === 'pending' || caseSet.status === 'running';
    if (active) {
      pollRef.current = setInterval(load, 2500);
    } else {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { clearInterval(pollRef.current); pollRef.current = null; };
  }, [caseSet?.status, load]);

  const fetchTrace = useCallback(async () => {
    if (traceFetched) return;
    try {
      const data = await api.get(`${base}/trace`);
      setTraceSteps(data.steps || []);
    } catch { /* trace not available — ignore gracefully */ }
    setTraceFetched(true);
  }, [base, traceFetched]);

  const toggleTrace = useCallback(() => {
    setShowTrace((prev) => {
      const next = !prev;
      if (next && !traceFetched) fetchTrace();
      return next;
    });
  }, [fetchTrace, traceFetched]);

  const saveName = async () => {
    if (!editName.trim() || editName === caseSet?.name) return;
    setSavingName(true);
    try {
      await api.patch(base, { name: editName.trim() });
      setCaseSet((prev) => prev ? { ...prev, name: editName.trim() } : prev);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSavingName(false);
    }
  };

  const updateCase = useCallback(async (caseId, updates) => {
    // Optimistic
    setOptimistic((prev) => ({ ...prev, [caseId]: { ...(prev[caseId] || {}), ...updates } }));
    try {
      await api.put(`${base}/cases/${caseId}`, updates);
      setCases((prev) => prev.map((c) => c.id === caseId ? { ...c, ...updates } : c));
      setOptimistic((prev) => { const n = { ...prev }; delete n[caseId]; return n; });
    } catch (e) {
      setOptimistic((prev) => { const n = { ...prev }; delete n[caseId]; return n; });
      toast(`Could not save: ${e.message}`, 'error');
    }
  }, [base, toast]);

  const saveFullCase = useCallback(async (caseId, fields) => {
    await api.put(`${base}/cases/${caseId}`, fields);
    setCases((prev) => prev.map((c) => c.id === caseId ? { ...c, ...fields } : c));
  }, [base]);

  const deleteCase = async (caseId) => {
    if (!await requestConfirm('Delete this test case?', 'Delete', 'danger')) return;
    try {
      await api.delete(`${base}/cases/${caseId}`);
      setCases((prev) => prev.filter((c) => c.id !== caseId));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const addCase = async (fields) => {
    const data = await api.post(`${base}/cases`, fields);
    setCases((prev) => [...prev, data.case]);
  };

  // ── Sort ──────────────────────────────────────────────────────────────────

  const cycleSort = useCallback((colKey) => {
    setSort((prev) => {
      let next;
      if (prev.col !== colKey) {
        next = { col: colKey, dir: 'asc' };
      } else if (prev.dir === 'asc') {
        next = { col: colKey, dir: 'desc' };
      } else {
        next = { col: null, dir: 'asc' };
      }
      try { localStorage.setItem(LS_SORT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // ── Column resize ─────────────────────────────────────────────────────────

  const startResize = useCallback((e, colKey, colIdx) => {
    e.preventDefault();
    const startX   = e.clientX;
    const startW   = colWidths[colKey] ?? DEFAULT_COL_WIDTHS[colKey] ?? 100;
    const startTableW = tableRef.current ? tableRef.current.offsetWidth : 800;

    dragRef.current = { colKey, colIdx, startX, startW, startTableW, currentW: startW };

    const onMove = (ev) => {
      if (!dragRef.current) return;
      const dx   = ev.clientX - dragRef.current.startX;
      const newW = Math.max(MIN_COL_W, dragRef.current.startW + dx);
      dragRef.current.currentW = newW;
      // Directly mutate the DOM — no React re-render during drag
      const cg = colgroupRef.current;
      if (cg && cg.children[dragRef.current.colIdx]) {
        cg.children[dragRef.current.colIdx].style.width = newW + 'px';
      }
      if (tableRef.current) {
        tableRef.current.style.width = (dragRef.current.startTableW + (newW - dragRef.current.startW)) + 'px';
      }
    };

    const onUp = () => {
      if (!dragRef.current) return;
      const { colKey: key, currentW } = dragRef.current;
      dragRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setColWidths((prev) => {
        const next = { ...prev, [key]: currentW };
        try { localStorage.setItem(LS_WIDTHS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        return next;
      });
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [colWidths]);

  const handleResizeKey = useCallback((e, colKey) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? RESIZE_STEP : -RESIZE_STEP;
    setColWidths((prev) => {
      const cur  = prev[colKey] ?? DEFAULT_COL_WIDTHS[colKey] ?? 100;
      const next = { ...prev, [colKey]: Math.max(MIN_COL_W, cur + delta) };
      try { localStorage.setItem(LS_WIDTHS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const autoFitCol = useCallback((colKey) => {
    // Estimate best-fit width from visible cell content (first line only)
    const getText = (c) => {
      const raw = c[colKey] ?? '';
      return String(raw).split('\n')[0] || '';
    };
    const headerLabel = { testId: 'Test ID', category: 'Category', scenario: 'Scenario', precondition: 'Precondition', steps: 'Test Steps', expectedResult: 'Expected Result', status: 'Status', remarks: 'Remarks' }[colKey] || colKey;
    let maxChars = headerLabel.length + 4;
    for (const c of cases) {
      const len = getText(c).length;
      if (len > maxChars) maxChars = len;
    }
    const est = Math.min(600, Math.max(MIN_COL_W, maxChars * 7 + 24));
    setColWidths((prev) => {
      const next = { ...prev, [colKey]: est };
      try { localStorage.setItem(LS_WIDTHS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [cases]);

  const resetColumns = useCallback(() => {
    setColWidths({ ...DEFAULT_COL_WIDTHS });
    try { localStorage.removeItem(LS_WIDTHS_KEY); } catch { /* ignore */ }
  }, []);

  // ── Wrap text ────────────────────────────────────────────────────────────

  const toggleWrapText = useCallback(() => {
    setWrapText((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_WRAP_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const handleResume = async () => {
    if (resuming) return;
    setResuming(true);
    try {
      await api.post(`${base}/resume`, {});
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setResuming(false);
    }
  };

  // Detect whether any case carries API data (controls Request/Response columns visibility)
  const hasApiCols = useMemo(() => cases.some((c) => c.request != null || c.response != null), [cases]);

  // Active column definitions (includes optional request/response)
  const activeCols = useMemo(() => [
    { key: 'testId',         label: 'Test ID',         sortable: true  },
    { key: 'category',       label: 'Category',        sortable: true  },
    { key: 'scenario',       label: 'Scenario',        sortable: true  },
    { key: 'precondition',   label: 'Precondition',    sortable: true  },
    { key: 'steps',          label: 'Test Steps',      sortable: true  },
    { key: 'expectedResult', label: 'Expected Result', sortable: true  },
    ...(hasApiCols ? [
      { key: 'request',  label: 'Request',  sortable: false },
      { key: 'response', label: 'Response', sortable: false },
    ] : []),
    { key: 'status',   label: 'Status',   sortable: true  },
    { key: 'remarks',  label: 'Remarks',  sortable: true  },
  ], [hasApiCols]);

  // Sorted cases — computed from base `cases` (not optimistic) so rows don't jump while editing
  const sortedCases = useMemo(() => {
    if (!sort.col) return cases;
    return [...cases].sort((a, b) => {
      let cmp = 0;
      switch (sort.col) {
        case 'testId':
          cmp = naturalTestIdCmp(a.testId, b.testId); break;
        case 'category':
          cmp = categoryLeadingCmp(a.category, b.category); break;
        case 'status': {
          const sa = STATUS_SORT_ORDER[a.status] ?? 4;
          const sb = STATUS_SORT_ORDER[b.status] ?? 4;
          cmp = sa - sb; break;
        }
        default:
          cmp = (a[sort.col] || '').localeCompare(b[sort.col] || '', undefined, { numeric: true });
      }
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [cases, sort]);

  // Filtered view (applied on top of sort)
  const visibleCases = useMemo(() => {
    return sortedCases.filter((c) => {
      const opt    = optimistic[c.id];
      const merged = opt ? { ...c, ...opt } : c;
      if (activeCategory && merged.category !== activeCategory) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          (merged.testId || '').toLowerCase().includes(q) ||
          (merged.category || '').toLowerCase().includes(q) ||
          (merged.scenario || '').toLowerCase().includes(q) ||
          (merged.precondition || '').toLowerCase().includes(q) ||
          (merged.steps || '').toLowerCase().includes(q) ||
          (merged.expectedResult || '').toLowerCase().includes(q) ||
          (merged.remarks || '').toLowerCase().includes(q) ||
          (merged.request?.url || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [sortedCases, activeCategory, searchQuery, optimistic]);

  const isRunning = caseSet?.status === 'pending' || caseSet?.status === 'running';
  const isFailed  = caseSet?.status === 'failed';
  const isDone    = caseSet?.status === 'done';

  const existingCategories = [...new Set(cases.map((c) => c.category || '').filter(Boolean))];

  if (loading) return <div className="page"><div className="spinner" aria-label="Loading test cases…" /></div>;
  if (error)   return (
    <div className="page">
      <button type="button" className="btn-icon" onClick={onBack}><Icon name="chevronLeft" size={16} /></button>
      <p className="error-note" role="alert">{error}</p>
    </div>
  );

  const exportUrl = `${base}/export.xlsx`;

  return (
    <div className="page">
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <button type="button" className="btn-icon" onClick={onBack} aria-label="Back to test cases">
          <Icon name="chevronLeft" size={16} />
        </button>
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }}
          style={{ fontWeight: 600, fontSize: '1rem', flex: 1, minWidth: 120, maxWidth: 400 }}
          aria-label="Case set name"
          disabled={savingName}
        />
        {savingName && <span className="muted" style={{ fontSize: '0.78rem' }}>Saving…</span>}
        {caseSet && (
          <span
            className="muted"
            style={{ fontSize: '0.81rem' }}
            aria-label={`Status: ${caseSet.status}`}
          >
            {isRunning ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" />
                Running
              </span>
            ) : (
              <span className={`badge${isFailed ? ' badge-error' : isDone ? '' : ''}`}>
                {caseSet.status}
              </span>
            )}
          </span>
        )}
        {caseSet && (
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            {cases.length} case{cases.length !== 1 ? 's' : ''}
          </span>
        )}

        {/* Generation steps button for finished/failed case sets */}
        {(isDone || isFailed) && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={toggleTrace}
            aria-expanded={showTrace}
            aria-label={showTrace ? 'Hide generation steps' : 'Show generation steps'}
          >
            <Icon name="clock" size={13} /> {showTrace ? 'Hide' : 'Show'} steps
          </button>
        )}

        {isDone && caseSet?.resumable && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleResume}
            disabled={resuming}
            aria-label={`Retry skipped categories in ${caseSet.name}`}
          >
            {resuming ? 'Resuming\u2026' : 'Retry skipped categories'}
          </button>
        )}

        {(isDone || cases.length > 0) ? (
          <a
            href={exportUrl}
            download
            className="btn btn-ghost btn-sm"
            aria-label="Download as Excel"
            data-testid="download-excel"
          >
            <Icon name="download" size={13} /> Download Excel
          </a>
        ) : null}
      </div>

      {/* Generation steps panel (finished / failed) */}
      {showTrace && (
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            padding: '10px 14px',
            marginBottom: 12,
            background: 'var(--canvas)',
          }}
          aria-label="Generation steps"
        >
          <div style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 8 }}>
            Generation steps
          </div>
          {!traceFetched
            ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-3)', fontSize: '0.8rem' }}>
                <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" />
                Loading…
              </div>
            : traceSteps.length === 0
              ? <p style={{ margin: 0, color: 'var(--ink-3)', fontSize: '0.82rem' }}>No generation steps recorded.</p>
              : <StepTimeline steps={traceSteps} running={false} />
          }
        </div>
      )}

      {/* Progress tracker while running */}
      {isRunning && caseSet && (
        <GenerationTracker
          jobs={[{
            id:          caseSet.id,
            kind:        'case-set',
            description: caseSet.description,
            status:      caseSet.status === 'pending' ? 'pending' : 'running',
            progress:    caseSet.progress,
            startedAt:   caseSet.startedAt,
            createdAt:   caseSet.createdAt,
            traceUrl:    `${base}/trace`,
          }]}
          onDismiss={null}
          onCancel={async () => {
            try { await api.post(`${base}/cancel`, {}); load(); }
            catch (e) { toast(e.message, 'error'); }
          }}
        />
      )}

      {/* Failed state */}
      {isFailed && caseSet && (
        <div className="error-note" role="alert" style={{ marginBottom: 12 }}>
          <strong>Generation failed:</strong> {caseSet.error || 'Unknown error'}
          {Array.isArray(caseSet.warnings) && caseSet.warnings.length > 0 && (
            <ul style={{ marginTop: 6, paddingLeft: 18 }}>
              {caseSet.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          {caseSet.resumable && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: '0.82rem', color: 'var(--ink-2)' }}>
                {caseSet.remainingCategories != null
                  ? `Generates the ${caseSet.remainingCategories.length} remaining ${caseSet.remainingCategories.length === 1 ? 'category' : 'categories'}: ${caseSet.remainingCategories.join(', ')}`
                  : 'Re-plans categories and generates only ones not already present'}
              </span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleResume}
                disabled={resuming}
                aria-label={`Resume generation of ${caseSet.name}`}
                style={{ width: 'fit-content' }}
              >
                {resuming ? 'Resuming\u2026' : 'Resume generation'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!isRunning && !isFailed && cases.length === 0 && (
        <div className="ws-placeholder">
          <Icon name="flask" size={32} />
          <p>No test cases yet.</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={13} /> Add first case
          </button>
        </div>
      )}

      {/* Summary strip + table */}
      {cases.length > 0 && (
        <>
          <SummaryStrip
            cases={cases}
            activeCategory={activeCategory}
            onCategoryClick={(cat) => setActiveCategory((prev) => prev === cat ? null : cat)}
          />

          {/* Search + add row toolbar */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, position: 'relative', maxWidth: 300 }}>
              <Icon name="search" size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', pointerEvents: 'none' }} />
              <input
                type="search"
                placeholder="Search cases…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ paddingLeft: 28, width: '100%' }}
                aria-label="Search test cases"
              />
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={toggleWrapText}
              aria-pressed={wrapText}
              title={wrapText ? 'Switch to compact view (3-line clamp)' : 'Switch to wrap-text view (full text)'}
            >
              <Icon name="menu" size={13} />
              {wrapText ? 'Compact' : 'Wrap text'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={resetColumns}
              title="Reset column widths to defaults"
            >
              <Icon name="refresh" size={13} /> Reset columns
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAdd(true)}>
              <Icon name="plus" size={13} /> Add row
            </button>
          </div>

          {/* Compute total width for table-layout: fixed */}
          {(() => {
            const totalW = activeCols.reduce((s, c) => s + (colWidths[c.key] ?? DEFAULT_COL_WIDTHS[c.key]), 0) + 60;
            return (
              <div className={`case-table-wrap${wrapText ? ' wrap-text' : ''}`}>
                <table
                  className="case-table"
                  aria-label="Test cases"
                  ref={tableRef}
                  style={{ tableLayout: 'fixed', width: Math.max(totalW, 600) + 'px' }}
                >
                  <colgroup ref={colgroupRef}>
                    {activeCols.map((col) => (
                      <col key={col.key} style={{ width: (colWidths[col.key] ?? DEFAULT_COL_WIDTHS[col.key]) + 'px' }} />
                    ))}
                    <col style={{ width: '60px' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {activeCols.map((col, colIdx) => {
                        const isActive = sort.col === col.key;
                        const ariaSortVal = isActive
                          ? (sort.dir === 'asc' ? 'ascending' : 'descending')
                          : 'none';
                        return (
                          <th
                            key={col.key}
                            scope="col"
                            className="case-table-th"
                            aria-sort={col.sortable ? ariaSortVal : undefined}
                            data-col={col.key}
                          >
                            {col.sortable ? (
                              <button
                                type="button"
                                className={`sort-btn${isActive ? ' sort-active' : ''}`}
                                onClick={() => cycleSort(col.key)}
                                data-col={col.key}
                              >
                                <span>{col.label}</span>
                                <span className="sort-indicator" aria-hidden="true">
                                  {isActive ? (sort.dir === 'asc' ? '\u2191' : '\u2193') : ''}
                                </span>
                              </button>
                            ) : (
                              <span className="col-label">{col.label}</span>
                            )}
                            <span
                              role="separator"
                              aria-orientation="vertical"
                              aria-label={`Resize ${col.label} column`}
                              aria-valuenow={colWidths[col.key] ?? DEFAULT_COL_WIDTHS[col.key]}
                              className="col-resize-handle"
                              tabIndex={0}
                              onPointerDown={(e) => startResize(e, col.key, colIdx)}
                              onDoubleClick={() => autoFitCol(col.key)}
                              onKeyDown={(e) => handleResizeKey(e, col.key)}
                            />
                          </th>
                        );
                      })}
                      <th scope="col" className="col-actions" aria-label="Row actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleCases.length === 0 && (
                      <tr>
                        <td colSpan={activeCols.length + 1} style={{ textAlign: 'center', padding: '20px', color: 'var(--ink-3)' }}>
                          No cases match the current filter.
                        </td>
                      </tr>
                    )}
                    {visibleCases.map((c) => {
                      const opt     = optimistic[c.id] || {};
                      const display = { ...c, ...opt };
                      const pillCls = statusPillClass(display.status);

                      return (
                        <tr key={c.id}>
                          <td style={{ whiteSpace: 'nowrap', color: 'var(--ink-3)', fontSize: '0.77rem' }}>
                            {display.testId || c.id.slice(0, 8)}
                          </td>
                          <td>
                            <CellClamp text={display.category} />
                          </td>
                          <td>
                            <CellClamp text={display.scenario} />
                          </td>
                          <td>
                            <CellClamp text={display.precondition} />
                          </td>
                          <td>
                            <CellClamp text={display.steps} />
                          </td>
                          <td>
                            <CellClamp text={display.expectedResult} />
                          </td>

                          {/* Request / Response (only when any case has API data) */}
                          {hasApiCols && (
                            <td>
                              <RequestCell request={display.request} />
                            </td>
                          )}
                          {hasApiCols && (
                            <td>
                              <ResponseCell response={display.response} />
                            </td>
                          )}

                          {/* Status — inline select with pill */}
                          <td>
                            <select
                              value={display.status || ''}
                              onChange={(e) => updateCase(c.id, { status: e.target.value })}
                              aria-label={`Status for ${display.testId || c.id}`}
                              style={{
                                border: 'none',
                                background: 'none',
                                cursor: 'pointer',
                                padding: 0,
                                font: 'inherit',
                                fontSize: '0.78rem',
                                color: 'inherit',
                                width: '100%',
                              }}
                            >
                              {STATUS_OPTIONS.map((s) => (
                                <option key={s} value={s}>{s || '\u2014 not set \u2014'}</option>
                              ))}
                            </select>
                            {pillCls && (
                              <span className={pillCls} aria-hidden="true" style={{ pointerEvents: 'none', marginTop: 2, display: 'block' }}>
                                {display.status}
                              </span>
                            )}
                          </td>

                          {/* Remarks — inline text */}
                          <td>
                            <input
                              type="text"
                              value={display.remarks || ''}
                              onChange={(e) => setOptimistic((prev) => ({ ...prev, [c.id]: { ...(prev[c.id] || {}), remarks: e.target.value } }))}
                              onBlur={(e) => updateCase(c.id, { remarks: e.target.value })}
                              aria-label={`Remarks for ${display.testId || c.id}`}
                              style={{
                                border: 'none',
                                background: 'transparent',
                                width: '100%',
                                fontSize: '0.8rem',
                                padding: '2px 0',
                              }}
                              placeholder="Add remarks\u2026"
                            />
                          </td>

                          {/* Actions — sticky right */}
                          <td className="col-actions">
                            <button
                              type="button"
                              className="btn-icon"
                              onClick={() => setEditRow(c)}
                              aria-label={`Edit test case ${display.testId || c.id}`}
                              title="Edit"
                              style={{ width: 24, height: 24 }}
                            >
                              <Icon name="edit" size={12} />
                            </button>
                            <button
                              type="button"
                              className="btn-icon"
                              onClick={() => deleteCase(c.id)}
                              aria-label={`Delete test case ${display.testId || c.id}`}
                              title="Delete"
                              style={{ width: 24, height: 24, color: 'var(--danger)' }}
                            >
                              <Icon name="trash" size={12} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </>
      )}

      {/* Edit row dialog */}
      {editRow && (
        <EditCaseDialog
          caseRow={editRow}
          onSave={async (fields) => { await saveFullCase(editRow.id, fields); setEditRow(null); }}
          onClose={() => setEditRow(null)}
        />
      )}

      {/* Add row dialog */}
      {showAdd && (
        <AddCaseDialog
          existingCategories={existingCategories}
          onAdd={addCase}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
