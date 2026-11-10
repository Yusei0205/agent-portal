import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import {
  MODES, FAILURES, sampleFromSchema, flattenSchema, operationsOf, simulatedUrl,
  parseJsonField, ruleCondition, ruleOutcome, newRuleId, describeRule,
} from '../lib/simulation.js';
import { Icon } from '../components/Icon.jsx';
import { FlagBadge } from '../components/FlagBadge.jsx';
import { AiChoicePicker } from '../components/AiChoicePicker.jsx';

const SECTIONS = [
  { id: 'review', label: 'Review' },
  { id: 'rules', label: 'Mock rules' },
  { id: 'try', label: 'Try it' },
  { id: 'settings', label: 'Settings' },
];

// ── Field tables ──────────────────────────────────────────────────────────────

function SchemaTable({ schema, empty }) {
  const rows = useMemo(() => flattenSchema(schema), [schema]);
  if (rows.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <div className="sim-table-wrap">
      <table className="sim-table">
        <thead><tr><th>Field</th><th>Type</th><th>Needed</th><th>Notes</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.name}-${i}`}>
              <td style={{ paddingLeft: 8 + r.depth * 18 }}><code>{r.name}</code></td>
              <td>{r.type}{r.maxLength ? <span className="muted small"> · up to {r.maxLength}</span> : null}</td>
              <td>
                {r.required && <span className="badge badge-neutral">Yes</span>}
                {!r.required && r.conditional && (
                  <span className="sim-flag" title={`Not enforced: ${r.conditional}`}><Icon name="warning" size={13} /> Sometimes</span>
                )}
                {!r.required && !r.conditional && <span className="muted small">Optional</span>}
              </td>
              <td className="small">
                {r.description && <div>{r.description}</div>}
                {r.allowed.length > 0 && (
                  <div className="sim-allowed">
                    {r.allowed.map((v) => <span key={v} className="sim-chip" title={r.allowedNotes[v] || ''}>{v}</span>)}
                  </div>
                )}
                {r.conditional && <div className="muted">{r.conditional.split('\n')[0]}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlagList({ flags }) {
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const shown = onlyWarnings ? flags.filter((f) => f.severity === 'warning') : flags;
  if (flags.length === 0) return <p className="muted small">Nothing to check.</p>;
  return (
    <div className="stack">
      <label className="sim-check small">
        <input type="checkbox" checked={onlyWarnings} onChange={(e) => setOnlyWarnings(e.target.checked)} /> Show only things that need attention
      </label>
      <ul className="sim-flags">
        {shown.map((f, i) => (
          <li key={`${f.code}-${i}`} className={`sim-flag-row ${f.severity}`}>
            <Icon name={f.severity === 'warning' ? 'warning' : 'info'} size={14} />
            <span>{f.message}{f.at ? <code className="sim-at">{f.at}</code> : null}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Review ────────────────────────────────────────────────────────────────────

function OperationCard({ op, editable, onSavePath, busy }) {
  const [path, setPath] = useState(op.path);
  useEffect(() => setPath(op.path), [op.path]);
  const needsPath = op.flags.some((f) => f.code === 'MISSING_PATH');
  const dirty = path !== op.path;
  return (
    <section className="card sim-op">
      <header className="sim-op-head">
        <span className="sim-method">{op.method}</span>
        {editable ? (
          <div className="sim-path-edit">
            <input
              aria-label={`URL path for ${op.summary || op.operationId}`}
              className={needsPath ? 'sim-input-warn' : ''}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              spellCheck={false}
            />
            <button type="button" className="btn btn-sm" disabled={!dirty && !needsPath ? true : busy} onClick={() => onSavePath(op, path)}>
              {needsPath ? 'Confirm path' : 'Save path'}
            </button>
          </div>
        ) : <code>{op.path}</code>}
        {op.secured && <span className="badge badge-neutral" title="Callers must send the client’s credential">Needs login token</span>}
      </header>
      {needsPath && (
        <p className="sim-note"><Icon name="warning" size={14} /> The document does not give a URL path. Type the real one (for example <code>/flash/update</code>) and confirm it.</p>
      )}
      {op.headers.length > 0 && (
        <p className="small muted">Headers: {op.headers.map((h) => `${h.name}${h.required ? ' (needed)' : ''}`).join(', ')}</p>
      )}
      <details open>
        <summary>Request body</summary>
        <SchemaTable schema={op.requestSchema} empty="This API takes no request body." />
      </details>
      <details>
        <summary>Response</summary>
        <SchemaTable schema={op.responseSchema} empty="No response fields were found." />
      </details>
      <details open={op.flags.length > 0}>
        <summary>To check ({op.flags.filter((f) => f.severity === 'warning').length} need attention)</summary>
        <FlagList flags={op.flags} />
      </details>
    </section>
  );
}

/** What changed from another version, so an updated client document can be checked against the old one. */
function ChangesPanel({ data, projectId }) {
  const versions = data.versions.map((v) => v.version);
  const to = data.version.version;
  const earlier = versions.filter((v) => v < to);
  const [from, setFrom] = useState(() => (data.api.approvedVersion > 0 && data.api.approvedVersion < to ? data.api.approvedVersion : to - 1));
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { setFrom((f) => (earlier.includes(f) ? f : earlier[earlier.length - 1])); }, [to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (earlier.length === 0 || !earlier.includes(from)) return;
    let live = true;
    setDiff(null);
    api.get(`/api/projects/${projectId}/sim/apis/${data.api.id}/diff?from=${from}&to=${to}`)
      .then((r) => { if (live) { setDiff(r); setError(''); } })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [from, to, projectId, data.api.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (earlier.length === 0) return null;
  return (
    <details className="card" open={diff?.count > 0}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        What changed since version {from}{diff ? ` (${diff.count} difference${diff.count === 1 ? '' : 's'})` : ''}
      </summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <label className="small muted">Compare with{' '}
          <select value={from} onChange={(e) => setFrom(Number(e.target.value))} aria-label="Compare with version">
            {earlier.map((v) => <option key={v} value={v}>v{v}</option>)}
          </select>
        </label>
        {error && <p className="error-note" role="alert">{error}</p>}
        {diff && diff.changes.length === 0 && <p className="muted small">No differences between version {from} and version {to}.</p>}
        {diff && diff.changes.map((c) => (
          <div key={c.operationId} className="stack" style={{ gap: 4 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className={`badge ${c.kind === 'added' ? 'badge-ok' : c.kind === 'removed' ? 'badge-danger' : 'badge-warn'}`}>{c.kind === 'added' ? 'New' : c.kind === 'removed' ? 'Removed' : 'Changed'}</span>
              <code>{c.label}</code>
            </div>
            <ul className="sim-howto small">{c.details.map((d) => <li key={d}>{d}</li>)}</ul>
          </div>
        ))}
        {diff && diff.count > 0 && <p className="muted small">Mock rules for an operation that changed are switched off when this version is approved, until you confirm them again.</p>}
      </div>
    </details>
  );
}

/** Rules the document states in words: turned into checks by the AI step, confirmed by a person. */
function BusinessRules({ data, ops, projectId, isDraft, reload, toast, onOpenVersion }) {
  const [ai, setAi] = useState({});
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState(null);
  const base = `/api/projects/${projectId}/sim/apis/${data.api.id}/versions/${data.version.version}`;

  const inWords = useMemo(() => ops.reduce((n, o) => n + flattenSchema(o.requestSchema).filter((r) => r.conditional).length, 0), [ops]);
  const rules = ops.flatMap((o) => o.rules.map((r) => ({ ...r, operation: o })));
  if (inWords === 0 && rules.length === 0) return null;

  const suggest = async () => {
    setRunning(true);
    setNote(null);
    try {
      const r = await api.post(`${base}/ai-rules`, { credentialId: ai.credentialId || undefined, model: ai.model || undefined });
      setNote(r);
      if (r.version) { toast(`${r.accepted} suggested check${r.accepted === 1 ? '' : 's'} saved as version ${r.version}. Confirm the ones that are right.`, 'ok'); onOpenVersion(r.version); }
      await reload();
    } catch (e) { toast(e.message, 'error'); } finally { setRunning(false); }
  };

  const decide = async (rule, status) => {
    try { await api.put(`${base}/rules/${rule.id}`, { status }); await reload(); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <section className="card stack">
      <header className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 className="sim-h3">Rules the document states in words</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            {inWords} field{inWords === 1 ? ' has' : 's have'} a rule such as “mandatory when action = 142”. Today these only raise a warning.
            Once turned into a check and confirmed, the simulation refuses requests that break it and the test cases include it.
          </p>
        </div>
      </header>

      {isDraft && inWords > 0 && (
        <div className="stack">
          <AiChoicePicker onChange={setAi} disabled={running} idPrefix="simrules" />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={running} onClick={suggest}>
              <Icon name="sparkles" size={13} /> {running ? 'Asking the model…' : 'Turn them into checks with AI'}
            </button>
            <span className="muted small">The result is saved as a new draft version for you to review. Nothing is applied until you confirm it.</span>
          </div>
        </div>
      )}

      {note && note.rejected?.length > 0 && (
        <div className="sim-callout" role="status">
          <Icon name="warning" size={15} />
          <div><strong>{note.version ? 'Some suggestions were left out' : 'No usable checks came back'}</strong>
            <ul>{note.rejected.slice(0, 6).map((m) => <li key={m}>{m}</li>)}</ul></div>
        </div>
      )}

      {rules.length > 0 && (
        <ul className="sim-rule-list">
          {rules.map((r) => (
            <li key={r.id} className={`sim-rule-item ${r.status}`}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className={`badge ${r.status === 'confirmed' ? 'badge-ok' : 'badge-warn'}`}>{r.status === 'confirmed' ? 'Applied' : 'Suggested'}</span>
                  <strong className="small">{r.description}</strong>
                </div>
                <div className="muted small">{describeRule(r)}{ops.length > 1 ? ` · ${r.operation.method} ${r.operation.path}` : ''}</div>
              </div>
              {isDraft && (
                <div className="row" style={{ gap: 6 }}>
                  {r.status !== 'confirmed' && <button type="button" className="btn btn-sm btn-primary" onClick={() => decide(r, 'confirmed')}>Confirm</button>}
                  {r.status === 'confirmed' && <button type="button" className="btn btn-sm" onClick={() => decide(r, 'suggested')}>Undo</button>}
                  <button type="button" className="btn-icon" aria-label={`Remove check: ${r.description}`} onClick={() => decide(r, 'removed')}><Icon name="trash" size={14} /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewPanel({ data, projectId, reload, toast, busy, setBusy, onOpenVersion }) {
  const ops = useMemo(() => operationsOf(data.spec), [data.spec]);
  const isDraft = data.version.status === 'draft';
  const missing = data.flags.some((f) => f.code === 'MISSING_PATH');
  const [justApproved, setJustApproved] = useState(null);

  const savePath = async (op, path) => {
    setBusy(true);
    try {
      await api.put(`/api/projects/${projectId}/sim/apis/${data.api.id}/versions/${data.version.version}/path`, { path: path.trim(), operationId: op.operationId });
      await reload();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const approve = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/projects/${projectId}/sim/apis/${data.api.id}/versions/${data.version.version}/approve`);
      setJustApproved(r);
      toast(`Version ${r.approvedVersion} approved. The simulation now answers calls.`, 'ok');
      await reload();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="stack-lg">
      {isDraft ? (
        <div className="card sim-approve">
          <div>
            <strong>Version {data.version.version} is a draft</strong>
            <p className="muted small">
              {missing
                ? 'Enter the URL path of each API below first. Approving makes the simulation answer calls from this version.'
                : 'Check the items marked with the exclamation icon, then approve. Approving makes the simulation answer calls from this version.'}
            </p>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || missing} onClick={approve} title={missing ? 'Enter the URL path first' : ''}>
            <Icon name="check" size={14} /> Approve version {data.version.version}
          </button>
        </div>
      ) : (
        <div className="card sim-approve ok">
          <div>
            <strong><Icon name="check" size={14} /> Version {data.version.version} is approved</strong>
            <p className="muted small">An approved version cannot be edited. To change it, import the updated specification: it arrives as a new draft.</p>
          </div>
        </div>
      )}
      {justApproved?.rulesNeedingReview > 0 && (
        <div className="sim-callout" role="status">
          <Icon name="warning" size={15} />
          <div>
            <strong>{justApproved.rulesNeedingReview} mock rule{justApproved.rulesNeedingReview === 1 ? '' : 's'} need review</strong>
            <p className="small">The specification changed for those operations. They return an error until you open <em>Mock rules</em> and confirm each one.</p>
          </div>
        </div>
      )}
      <ChangesPanel data={data} projectId={projectId} />
      <BusinessRules data={data} ops={ops} projectId={projectId} isDraft={isDraft} reload={reload} toast={toast} onOpenVersion={onOpenVersion} />
      {ops.map((op) => (
        <OperationCard key={op.operationId} op={op} editable={isDraft} onSavePath={savePath} busy={busy} />
      ))}
    </div>
  );
}

// ── Rules ─────────────────────────────────────────────────────────────────────

function RuleDialog({ rule, ops, onClose, onSave }) {
  const isNew = !rule?.id;
  const [name, setName] = useState(rule?.name || '');
  const [operationId, setOperationId] = useState(rule?.operationId || ops[0]?.operationId || '');
  const [whenText, setWhenText] = useState(rule?.when?.body ? JSON.stringify(rule.when.body, null, 2) : '');
  const [kind, setKind] = useState(rule?.failure ? 'failure' : 'reply');
  const [status, setStatus] = useState(String(rule?.response?.status ?? 200));
  const [bodyText, setBodyText] = useState(rule?.response?.body !== undefined ? JSON.stringify(rule.response.body, null, 2) : '');
  const [failure, setFailure] = useState(rule?.failure || 'server_error');
  const [delay, setDelay] = useState(String(rule?.delayMs ?? 0));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fillFromSchema = () => {
    const op = ops.find((o) => o.operationId === operationId);
    if (op?.responseSchema) setBodyText(JSON.stringify(sampleFromSchema(op.responseSchema), null, 2));
  };

  const submit = async () => {
    setError('');
    const when = parseJsonField(whenText, 'The condition');
    const body = parseJsonField(bodyText, 'The reply body');
    if (when.error || body.error) { setError(when.error || body.error); return; }
    if (when.value !== undefined && (typeof when.value !== 'object' || Array.isArray(when.value) || when.value === null)) {
      setError('The condition must be a JSON object such as {"action": "142"}'); return;
    }
    const payload = {
      operationId,
      name: name.trim(),
      ...(when.value ? { when: { body: when.value } } : {}),
      delayMs: Number(delay) || 0,
      needsReview: false,
      ...(kind === 'failure' ? { failure } : { response: { status: Number(status), ...(body.value !== undefined ? { body: body.value } : {}) } }),
    };
    setBusy(true);
    try {
      await onSave(rule?.id || newRuleId(name), payload);
      onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={isNew ? 'New mock rule' : 'Edit mock rule'}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <h2>{isNew ? 'New mock rule' : 'Edit mock rule'}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="modal-body stack">
          <p className="muted small">Rules are tried from the top; the first one whose condition matches answers the call. With no matching rule the answer is made up from the response fields.</p>
          <div className="field">
            <label htmlFor="rule-name">Name</label>
            <input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Reject action 142" maxLength={120} />
          </div>
          {ops.length > 1 && (
            <div className="field">
              <label htmlFor="rule-op">Operation</label>
              <select id="rule-op" value={operationId} onChange={(e) => setOperationId(e.target.value)}>
                {ops.map((o) => <option key={o.operationId} value={o.operationId}>{o.method} {o.path}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="rule-when">Only when the request body has (optional)</label>
            <textarea id="rule-when" rows={3} value={whenText} onChange={(e) => setWhenText(e.target.value)} placeholder='{"action": "142"}' spellCheck={false} />
            <span className="field-hint">Field values the request must contain. Leave empty to match every request.</span>
          </div>
          <div className="field">
            <span className="field-label">Then</span>
            <div className="row wrap" style={{ gap: 14 }}>
              <label className="sim-check"><input type="radio" name="kind" checked={kind === 'reply'} onChange={() => setKind('reply')} /> Send a reply</label>
              <label className="sim-check"><input type="radio" name="kind" checked={kind === 'failure'} onChange={() => setKind('failure')} /> Simulate a failure</label>
            </div>
          </div>
          {kind === 'reply' ? (
            <>
              <div className="field">
                <label htmlFor="rule-status">Status code</label>
                <input id="rule-status" type="number" min="100" max="599" value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 120 }} />
              </div>
              <div className="field">
                <label htmlFor="rule-body">Reply body (JSON)</label>
                <textarea id="rule-body" rows={8} value={bodyText} onChange={(e) => setBodyText(e.target.value)} spellCheck={false} />
                <button type="button" className="btn btn-sm" onClick={fillFromSchema} style={{ justifySelf: 'start' }}>Fill from the response fields</button>
              </div>
            </>
          ) : (
            <div className="field">
              <label htmlFor="rule-failure">Failure</label>
              <select id="rule-failure" value={failure} onChange={(e) => setFailure(e.target.value)}>
                {FAILURES.filter((f) => f.id).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="rule-delay">Delay before answering (ms)</label>
            <input id="rule-delay" type="number" min="0" max="60000" value={delay} onChange={(e) => setDelay(e.target.value)} style={{ maxWidth: 140 }} />
          </div>
          {error && <p className="error-note" role="alert">{error}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={submit}>{busy ? 'Saving…' : 'Save rule'}</button>
        </div>
      </div>
    </div>
  );
}

function RulesPanel({ data, projectId, reload, toast }) {
  const ops = useMemo(() => operationsOf(data.spec), [data.spec]);
  const [editing, setEditing] = useState(null); // null | {} (new) | rule
  const base = `/api/projects/${projectId}/sim/apis/${data.api.id}/rules`;

  const save = async (id, payload) => {
    await api.put(`${base}/${id}`, payload);
    await reload();
  };
  const remove = async (r) => {
    try { await api.delete(`${base}/${r.id}`); await reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const confirmRule = async (r) => {
    try {
      await api.put(`${base}/${r.id}`, { operationId: r.operationId, name: r.name, when: r.when, response: r.response, failure: r.failure, delayMs: r.delayMs, needsReview: false });
      toast('Rule confirmed.', 'ok');
      await reload();
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted small">Scripted answers. Use them for the cases you need to test: a rejection, an error, a slow reply.</p>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({})}><Icon name="plus" size={13} /> New rule</button>
      </div>
      {data.rules.length === 0 && <div className="card"><p className="muted">No rules yet. Calls are answered from the response fields with plausible values.</p></div>}
      {data.rules.map((r) => (
        <article key={r.id} className={`card sim-rule${r.needsReview ? ' needs-review' : ''}`}>
          <div className="sim-rule-main">
            <strong>{r.name}</strong>
            <span className="muted small">{ruleCondition(r)} → {ruleOutcome(r)}{r.delayMs ? ` after ${r.delayMs} ms` : ''}</span>
            {r.needsReview && (
              <span className="sim-flag"><Icon name="warning" size={13} /> The specification changed. This rule is switched off until you confirm it.</span>
            )}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {r.needsReview && <button type="button" className="btn btn-sm btn-primary" onClick={() => confirmRule(r)}>Confirm</button>}
            <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>
            <button type="button" className="btn-icon" aria-label={`Delete ${r.name}`} onClick={() => remove(r)}><Icon name="trash" size={14} /></button>
          </div>
        </article>
      ))}
      {editing && <RuleDialog rule={editing} ops={ops} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

// ── Try it ────────────────────────────────────────────────────────────────────

function TryPanel({ data, projectId }) {
  const ops = useMemo(() => operationsOf(data.spec), [data.spec]);
  const [opId, setOpId] = useState(ops[0]?.operationId || '');
  const op = ops.find((o) => o.operationId === opId) || ops[0];
  const [path, setPath] = useState(op?.path || '/');
  const [headersText, setHeadersText] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fill = useCallback((o) => {
    if (!o) return;
    setPath(o.path);
    const headers = {};
    if (o.secured) headers.Authorization = 'Bearer test-token';
    for (const h of o.headers) if (h.required) headers[h.name] = 'sample';
    setHeadersText(JSON.stringify(headers, null, 2));
    setBodyText(o.requestSchema ? JSON.stringify(sampleFromSchema(o.requestSchema), null, 2) : '');
    setResult(null);
    setError('');
  }, []);
  useEffect(() => { fill(op); }, [op?.operationId, data.version.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    setError('');
    const headers = parseJsonField(headersText, 'Headers');
    const body = parseJsonField(bodyText, 'The body');
    if (headers.error || body.error) { setError(headers.error || body.error); return; }
    setBusy(true);
    try {
      const r = await api.post(`/api/projects/${projectId}/sim/apis/${data.api.id}/try`, {
        method: op.method, path, headers: headers.value || {}, body: body.value, version: data.version.version,
      });
      setResult(r.result);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!op) return <p className="muted">This API has no operations.</p>;
  const source = result?.source;
  return (
    <div className="stack">
      <p className="muted small">Sends a sample request to the simulation for this version. Nothing is delivered to the client’s server, and no token is needed here.</p>
      <div className="sim-try-grid">
        <div className="stack">
          {ops.length > 1 && (
            <div className="field">
              <label htmlFor="try-op">Operation</label>
              <select id="try-op" value={op.operationId} onChange={(e) => setOpId(e.target.value)}>
                {ops.map((o) => <option key={o.operationId} value={o.operationId}>{o.method} {o.path}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="try-path">Path</label>
            <div className="sim-path-edit"><span className="sim-method">{op.method}</span><input id="try-path" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} /></div>
          </div>
          <div className="field">
            <label htmlFor="try-headers">Headers (JSON)</label>
            <textarea id="try-headers" rows={4} value={headersText} onChange={(e) => setHeadersText(e.target.value)} spellCheck={false} />
          </div>
          <div className="field">
            <label htmlFor="try-body">Body (JSON)</label>
            <textarea id="try-body" rows={12} value={bodyText} onChange={(e) => setBodyText(e.target.value)} spellCheck={false} />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={send}><Icon name="send" size={14} /> {busy ? 'Sending…' : 'Send'}</button>
            <button type="button" className="btn" onClick={() => fill(op)}>Reset example</button>
          </div>
          {error && <p className="error-note" role="alert">{error}</p>}
        </div>
        <div className="stack" aria-live="polite">
          <h3 className="sim-h3">Answer</h3>
          {!result && <p className="muted small">Send a request to see the answer.</p>}
          {result && (
            <>
              <div className="row wrap" style={{ gap: 8 }}>
                <span className={`badge ${result.status < 300 ? 'badge-ok' : result.status < 500 ? 'badge-warn' : 'badge-danger'}`}>{result.status}</span>
                <span className="badge badge-neutral">
                  {source === 'generated' ? 'Made up from the response fields' : source === 'rule' ? 'From a mock rule' : source === 'blocked' ? 'Blocked: no usable rule' : source === 'invalid' ? 'Request does not match the spec' : 'Simulated failure'}
                </span>
                {result.delayMs > 0 && <span className="muted small">would wait {result.delayMs} ms</span>}
              </div>
              {source === 'blocked' && (
                <p className="sim-note"><Icon name="warning" size={14} /> Nothing was guessed and nothing was sent to the client’s server.</p>
              )}
              {result.warnings?.length > 0 && (
                <ul className="sim-flags">
                  {result.warnings.map((w, i) => (
                    <li key={i} className="sim-flag-row warning"><Icon name="warning" size={14} /><span>{w.message}</span></li>
                  ))}
                </ul>
              )}
              <pre className="sim-pre">{typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2)}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** How to give the simulated APIs to agents as tools. */
function AgentAccess({ projectId, approved }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (!approved) return;
    api.get(`/api/projects/${projectId}/sim/mcp-info`).then(setInfo).catch(() => setInfo({ tools: [], path: '' }));
  }, [projectId, approved]);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = info ? `${origin}${info.path}` : '';
  return (
    <div className="card stack">
      <h3 className="sim-h3">Let agents call it (MCP)</h3>
      <p className="muted small" style={{ margin: 0 }}>
        The approved APIs of this project can be given to an agent as tools, one per operation, so a session can try the client’s API
        before the real one exists. A call goes through the same mode as above: simulated, or forwarded to the live API.
      </p>
      {!approved ? (
        <p className="muted small">Approve a version of an API first. Tools only appear for approved APIs.</p>
      ) : (
        <>
          <div className="sim-url">
            <code>{url || '…'}</code>
            <button type="button" className="btn-icon" aria-label="Copy the MCP address" onClick={() => navigator.clipboard?.writeText(url)}><Icon name="copy" size={14} /></button>
          </div>
          <ol className="small muted sim-howto">
            <li>Create an API token (API access in the menu).</li>
            <li>On Connect › Tools &amp; services, add a remote MCP server with this address and the header <code>Authorization: Bearer ap_…</code>. Turn on <em>allow writes</em> so the POST, PUT, PATCH and DELETE tools are offered too.</li>
            <li>Start a session of this project: its agent now has the tools below.</li>
          </ol>
          {info && info.tools.length > 0 && (
            <div className="sim-table-wrap">
              <table className="sim-table">
                <thead><tr><th>Tool</th><th>Calls</th><th>API</th></tr></thead>
                <tbody>{info.tools.map((t) => (<tr key={t.name}><td><code>{t.name}</code></td><td>{t.method} {t.path}{t.readOnly ? '' : ' (changes data)'}</td><td>{t.api}</td></tr>))}</tbody>
              </table>
            </div>
          )}
          <p className="muted small" style={{ margin: 0 }}>The agent’s runner only accepts https addresses, so this works on a portal reached over https.</p>
        </>
      )}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────

function SettingsPanel({ data, projectId, reload, toast }) {
  const a = data.api;
  const ops = useMemo(() => operationsOf(data.spec), [data.spec]);
  const [name, setName] = useState(a.name);
  const [mode, setMode] = useState(a.mode);
  const [liveBaseUrl, setLiveBaseUrl] = useState(a.liveBaseUrl || '');
  const [explicit, setExplicit] = useState(a.requireExplicitRule);
  const [opModes, setOpModes] = useState(a.operationModes || {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.put(`/api/projects/${projectId}/sim/apis/${a.id}`, { name, mode, liveBaseUrl, requireExplicitRule: explicit, operationModes: opModes });
      toast('Settings saved.', 'ok');
      await reload();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <div className="stack-lg">
      <div className="card stack">
        <div className="field">
          <label htmlFor="set-name">Name</label>
          <input id="set-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </div>
        <fieldset className="sim-modes">
          <legend className="field-label">Who answers calls</legend>
          {MODES.map((m) => (
            <label key={m.id} className={`sim-mode${mode === m.id ? ' is-on' : ''}`}>
              <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
              <span><strong>{m.label}</strong><span className="muted small">{m.help}</span></span>
            </label>
          ))}
        </fieldset>
        {mode === 'hybrid' && (
          <div className="stack">
            <span className="field-label">Per operation</span>
            {ops.map((o) => (
              <div key={o.operationId} className="row" style={{ gap: 10 }}>
                <span className="sim-method">{o.method}</span><code style={{ flex: 1 }}>{o.path}</code>
                <select aria-label={`Mode for ${o.path}`} value={opModes[o.operationId] || 'mock'} onChange={(e) => setOpModes({ ...opModes, [o.operationId]: e.target.value })}>
                  <option value="mock">Simulated</option>
                  <option value="live">Live</option>
                </select>
              </div>
            ))}
          </div>
        )}
        {(mode === 'live' || mode === 'hybrid') && (
          <div className="field">
            <label htmlFor="set-live">Client’s real API address</label>
            <input id="set-live" value={liveBaseUrl} onChange={(e) => setLiveBaseUrl(e.target.value)} placeholder="https://api.client.example" spellCheck={false} />
            <span className="field-hint">https only. The caller’s own login token (sent as X-Sim-Authorization) is passed on; the portal token never is.</span>
          </div>
        )}
        <label className="sim-check">
          <input type="checkbox" checked={explicit} onChange={(e) => setExplicit(e.target.checked)} />
          <span>Block calls that have no mock rule <span className="muted small">(otherwise they are answered from the response fields)</span></span>
        </label>
        {error && <p className="error-note" role="alert">{error}</p>}
        <div><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button></div>
      </div>

      <div className="card stack">
        <h3 className="sim-h3">How to call it</h3>
        {a.approvedVersion === 0 ? (
          <p className="muted small">Not answering yet: approve a version on the Review tab first. Until then every call gets “API_NOT_APPROVED”.</p>
        ) : (
          <>
            {ops.map((o) => (
              <div key={o.operationId} className="sim-url">
                <span className="sim-method">{o.method}</span>
                <code>{simulatedUrl(origin, projectId, a.id, o.path)}</code>
                <button type="button" className="btn-icon" aria-label={`Copy address for ${o.path}`} onClick={() => navigator.clipboard?.writeText(simulatedUrl(origin, projectId, a.id, o.path))}>
                  <Icon name="copy" size={14} />
                </button>
              </div>
            ))}
            <ul className="small muted sim-howto">
              <li>Send a portal API token as <code>Authorization: Bearer ap_…</code> (create one under API tokens).</li>
              <li>Send the client’s own login token as <code>X-Sim-Authorization: Bearer …</code>. It reaches the simulated API as <code>Authorization</code>.</li>
              <li>A call the specification does not describe gets a 501 error. It is never guessed and never forwarded.</li>
            </ul>
          </>
        )}
      </div>

      <AgentAccess projectId={projectId} approved={a.approvedVersion > 0} />
    </div>
  );
}

// ── Detail page ───────────────────────────────────────────────────────────────

export function SimulationDetail({ projectId, apiId, onBack, onChanged, toast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [section, setSection] = useState('review');
  const [version, setVersion] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (v = version) => {
    try {
      const r = await api.get(`/api/projects/${projectId}/sim/apis/${apiId}${v ? `?version=${v}` : ''}`);
      setData(r);
      setError('');
    } catch (e) { setError(e.message); }
  }, [projectId, apiId, version]);

  useEffect(() => { load(); }, [load]);

  const reload = useCallback(async () => { await load(); onChanged?.(); }, [load, onChanged]);

  if (error) return <div className="page"><button type="button" className="btn btn-sm" onClick={onBack}>Back</button><p className="error-note" role="alert">{error}</p></div>;
  if (!data) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page sim-detail">
      <div className="sim-detail-head">
        <button type="button" className="btn btn-sm" onClick={onBack}><Icon name="x" size={12} /> Close</button>
        <h2>{data.api.name}</h2>
        <FlagBadge flags={data.api.flags} />
        <span className="spacer" />
        <label className="sim-version small">
          Version
          <select value={data.version.version} onChange={(e) => setVersion(Number(e.target.value))} aria-label="Specification version">
            {data.versions.map((v) => (
              <option key={v.version} value={v.version}>v{v.version} · {v.status === 'approved' ? 'approved' : 'draft'}{v.flags ? ` · ${v.flags} notes` : ''}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="tab-bar" role="tablist" aria-label="API sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={section === s.id} className={`tab-btn${section === s.id ? ' is-active' : ''}`} onClick={() => setSection(s.id)}>
            {s.label}{s.id === 'rules' && data.rules.some((r) => r.needsReview) ? ' !' : ''}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="sim-panel">
        {section === 'review' && <ReviewPanel data={data} projectId={projectId} reload={reload} toast={toast} busy={busy} setBusy={setBusy} onOpenVersion={setVersion} />}
        {section === 'rules' && <RulesPanel data={data} projectId={projectId} reload={reload} toast={toast} />}
        {section === 'try' && <TryPanel data={data} projectId={projectId} />}
        {section === 'settings' && <SettingsPanel data={data} projectId={projectId} reload={reload} toast={toast} />}
      </div>
    </div>
  );
}

export default SimulationDetail;
