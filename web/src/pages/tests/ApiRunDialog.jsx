/**
 * ApiRunDialog: run the API cases of a case set against the simulation or the client's real API, and compare the two.
 *
 *   GET/PUT /api/projects/:pid/tests/:tpid/api-target
 *   POST    .../case-sets/:csid/api-runs     { target }
 *   POST    .../case-sets/:csid/api-compare
 *
 * A run writes Pass / Fail and a "Run [...]" remark into the sheet, so onChanged() reloads it.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';

const VERDICTS = {
  match: { label: 'Same on both', cls: 'badge-ok' },
  mismatch: { label: 'Differs: the live API does not follow the specification', cls: 'badge-danger' },
  both_fail: { label: 'Fails on both', cls: 'badge-warn' },
  live_only: { label: 'Fails only on the simulation', cls: 'badge-warn' },
  not_run: { label: 'Not run', cls: 'badge-neutral' },
};

function Outcome({ o }) {
  const cls = o.outcome === 'pass' ? 'badge-ok' : o.outcome === 'fail' ? 'badge-danger' : 'badge-neutral';
  return <span className={`badge ${cls}`}>{o.outcome === 'pass' ? 'Pass' : o.outcome === 'fail' ? 'Fail' : 'Skipped'}</span>;
}

export function ApiRunDialog({ projectId, testProjectId, caseSetId, onClose, onChanged }) {
  const base = `/api/projects/${projectId}/tests/${testProjectId}`;
  const [cfg, setCfg] = useState(null);
  const [apis, setApis] = useState([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { kind: 'run'|'compare', ... }
  const [onlyProblems, setOnlyProblems] = useState(true);
  const trapRef = useFocusTrap();
  const overlay = useOverlayDismiss(onClose, { disabled: busy });

  useEffect(() => {
    api.get(`${base}/api-target`).then((r) => setCfg({
      ...r.target,
      headerName: Object.keys(r.target.liveHeaders || {})[0] || 'Authorization',
      headerValue: Object.values(r.target.liveHeaders || {})[0] || '',
    })).catch((e) => setError(e.message));
    api.get(`/api/projects/${projectId}/sim/apis`).then((r) => setApis(r.apis || [])).catch(() => {});
  }, [base, projectId]);

  const payload = (c) => ({
    apiIds: c.apiIds,
    target: c.target,
    errorStyle: c.errorStyle.kind === 'code'
      ? { kind: 'code', field: c.errorStyle.field, successValue: c.errorStyle.successValue }
      : { kind: 'http' },
    liveHeaders: c.headerName.trim() && c.headerValue.trim() ? { [c.headerName.trim()]: c.headerValue.trim() } : {},
  });

  const save = async () => {
    setSaving(true);
    setError('');
    try { await api.put(`${base}/api-target`, payload(cfg)); return true; } catch (e) { setError(e.message); return false; } finally { setSaving(false); }
  };

  const run = async (kind) => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      if (!(await save())) return;
      if (kind === 'compare') {
        setResult({ kind, ...(await api.post(`${base}/case-sets/${caseSetId}/api-compare`, {})) });
      } else {
        setResult({ kind: 'run', ...(await api.post(`${base}/case-sets/${caseSetId}/api-runs`, { target: kind })) });
      }
      onChanged?.();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const rows = useMemo(() => {
    if (!result) return [];
    if (result.kind === 'compare') return result.rows.filter((r) => !onlyProblems || (r.verdict !== 'match' && r.verdict !== 'not_run'));
    return result.results.filter((r) => !onlyProblems || r.outcome !== 'pass');
  }, [result, onlyProblems]);

  const setErrKind = (kind) => setCfg((c) => ({ ...c, errorStyle: kind === 'code' ? { kind: 'code', field: c.errorStyle.field || 'code', successValue: c.errorStyle.successValue || '00' } : { kind: 'http' } }));

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={overlay.onMouseDown} onClick={overlay.onClick}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="apirun-title" style={{ maxWidth: 820 }} ref={trapRef}>
        <div className="dialog-head">
          <h2 className="dialog-title" id="apirun-title">Run API cases</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        <div className="dialog-body stack">
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Sends each case that has a request to the API and checks the answer: the status, and for a successful call
            the response fields against the specification. Pass or Fail is written into the sheet. Cases without a
            request (rules the document only states in words) are skipped.
          </p>

          {!cfg && !error && <p className="muted">Loading…</p>}

          {cfg && (
            <>
              <details className="gc-spec">
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Where to run and how to read the answers</summary>
                <div className="stack" style={{ marginTop: 10 }}>
                  <div className="field">
                    <span className="field-label">APIs <span className="muted" style={{ fontWeight: 400 }}>(none ticked = every API of this project)</span></span>
                    {apis.length === 0 && <span className="muted small">No APIs yet. Add them on the API simulation tab.</span>}
                    {apis.map((a) => (
                      <label key={a.id} className="sim-check small">
                        <input
                          type="checkbox"
                          checked={cfg.apiIds.includes(a.id)}
                          onChange={(e) => setCfg((c) => ({ ...c, apiIds: e.target.checked ? [...c.apiIds, a.id] : c.apiIds.filter((x) => x !== a.id) }))}
                        />
                        <span>{a.name} <span className="muted">· {a.liveBaseUrl ? 'has a live address' : 'no live address'}</span></span>
                      </label>
                    ))}
                  </div>
                  <div className="field">
                    <span className="field-label">How the client’s real API reports a rejected request</span>
                    <label className="sim-check small"><input type="radio" name="errstyle" checked={cfg.errorStyle.kind === 'http'} onChange={() => setErrKind('http')} /> An HTTP error status (400-499)</label>
                    <label className="sim-check small"><input type="radio" name="errstyle" checked={cfg.errorStyle.kind === 'code'} onChange={() => setErrKind('code')} /> HTTP 200 with a result code in the body</label>
                    {cfg.errorStyle.kind === 'code' && (
                      <div className="row wrap" style={{ gap: 10 }}>
                        <label className="small">Field <input aria-label="Result code field" style={{ width: 120 }} value={cfg.errorStyle.field} onChange={(e) => setCfg((c) => ({ ...c, errorStyle: { ...c.errorStyle, field: e.target.value } }))} /></label>
                        <label className="small">Success value <input aria-label="Success value" style={{ width: 90 }} value={cfg.errorStyle.successValue} onChange={(e) => setCfg((c) => ({ ...c, errorStyle: { ...c.errorStyle, successValue: e.target.value } }))} /></label>
                      </div>
                    )}
                    <span className="field-hint">The client’s document does not say. This only affects runs on the live API; the simulation is exact.</span>
                  </div>
                  <div className="field">
                    <span className="field-label">Login for the live API</span>
                    <div className="row wrap" style={{ gap: 10 }}>
                      <input aria-label="Live header name" style={{ width: 150 }} value={cfg.headerName} onChange={(e) => setCfg((c) => ({ ...c, headerName: e.target.value }))} />
                      <input aria-label="Live header value" style={{ flex: 1, minWidth: 220 }} value={cfg.headerValue} onChange={(e) => setCfg((c) => ({ ...c, headerValue: e.target.value }))} placeholder="{{vault.live-token.value}}" spellCheck={false} />
                    </div>
                    <span className="field-hint">Replaces the placeholder token in the cases that send one. Keep the secret in this test project’s Vault and refer to it as {'{{vault.NAME.value}}'}.</span>
                  </div>
                  <div><button type="button" className="btn btn-sm" onClick={save} disabled={saving || busy}>{saving ? 'Saving…' : 'Save settings'}</button></div>
                </div>
              </details>

              <div className="row wrap" style={{ gap: 8 }}>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run('simulation')}><Icon name="play" size={13} /> Run on the simulation</button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run('live')}><Icon name="external" size={13} /> Run on the live API</button>
                <button type="button" className="btn" disabled={busy} onClick={() => run('compare')}><Icon name="chart" size={13} /> Compare both</button>
                {busy && <span className="muted small"><span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" /> Running…</span>}
              </div>
            </>
          )}

          {error && <div className="error-note" role="alert">{error}</div>}

          {result && (
            <div className="stack" aria-live="polite">
              {result.kind === 'run' ? (
                <div className="row wrap" style={{ gap: 8 }}>
                  <strong>{result.target === 'live' ? 'Live API' : 'Simulation'}:</strong>
                  <span className="badge badge-ok">{result.summary.pass} pass</span>
                  <span className="badge badge-danger">{result.summary.fail} fail</span>
                  <span className="badge badge-neutral">{result.summary.skipped} skipped</span>
                </div>
              ) : (
                <div className="row wrap" style={{ gap: 8 }}>
                  <strong>Compared:</strong>
                  <span className="badge badge-ok">{result.summary.match} same</span>
                  <span className={`badge ${result.summary.mismatch ? 'badge-danger' : 'badge-neutral'}`}>{result.summary.mismatch} differ</span>
                  <span className="badge badge-warn">{result.summary.bothFail + result.summary.liveOnly} fail</span>
                  <span className="badge badge-neutral">{result.summary.notRun} not run</span>
                </div>
              )}
              {result.kind === 'compare' && result.live.total > 0 && result.live.skipped === result.live.total && (
                <div className="sim-callout" role="status">
                  <Icon name="warning" size={15} />
                  <div>Nothing could be compared: no case reached the live API. Set the client’s real address for each API on the API simulation tab (Settings), then try again.</div>
                </div>
              )}
              {result.kind === 'compare' && result.summary.mismatch > 0 && (
                <div className="sim-callout"><Icon name="warning" size={15} /><div>{result.summary.mismatch} case{result.summary.mismatch === 1 ? '' : 's'} pass on the simulation but fail on the live API. Those are where the client’s API differs from their own specification.</div></div>
              )}
              <label className="sim-check small"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Show only cases that need attention</label>
              <div className="sim-table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
                <table className="sim-table">
                  <thead><tr><th>Test ID</th><th>Scenario</th><th>{result.kind === 'compare' ? 'Result' : 'Outcome'}</th><th>Why</th></tr></thead>
                  <tbody>
                    {rows.length === 0 && <tr><td colSpan={4} className="muted">Nothing needs attention.</td></tr>}
                    {rows.map((r) => (
                      <tr key={r.caseId}>
                        <td>{r.testId}</td>
                        <td>{r.scenario}</td>
                        <td>{result.kind === 'compare'
                          ? <span className={`badge ${VERDICTS[r.verdict].cls}`}>{VERDICTS[r.verdict].label}</span>
                          : <Outcome o={r} />}</td>
                        <td className="small">{result.kind === 'compare' ? (r.live.outcome === 'fail' ? `Live: ${r.live.reason}` : r.simulation.reason) : r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default ApiRunDialog;
