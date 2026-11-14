/**
 * ApiRunDialog: run the API cases of a case set against the simulation or the client's real API, and compare the two.
 *
 *   GET/PUT /api/projects/:pid/tests/:tpid/api-target
 *   POST    .../case-sets/:csid/api-runs     { target }
 *   POST    .../case-sets/:csid/api-compare
 *
 * A run writes Pass / Fail and a "Run [...]" remark into the sheet, so onChanged() reloads it.
 *
 *   GET .../api-runs                       the run history of the test project
 *   GET .../api-schedules, PUT/DELETE .../case-sets/:csid/api-schedule   run on a cron schedule (UTC)
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';

const PRESETS = [
  { cron: '*/15 * * * *', label: 'Every 15 minutes' },
  { cron: '0 * * * *', label: 'Every hour' },
  { cron: '0 2 * * *', label: 'Every day at 02:00 UTC' },
  { cron: '0 9 * * 1-5', label: 'Weekdays at 09:00 UTC' },
];

const TARGET_LABEL = { simulation: 'Simulation', live: 'Live API', compare: 'Both, compared' };

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
  const [history, setHistory] = useState([]);
  const [sched, setSched] = useState(null);   // the saved schedule for this case set, or null
  const [form, setForm] = useState({ enabled: true, preset: PRESETS[2].cron, custom: '', target: 'simulation' });
  const [schedMsg, setSchedMsg] = useState('');
  const trapRef = useFocusTrap();
  const overlay = useOverlayDismiss(onClose, { disabled: busy });

  const loadHistory = () => api.get(`${base}/api-runs`).then((r) => setHistory(r.runs || [])).catch(() => {});
  const loadSchedule = () => api.get(`${base}/api-schedules`).then((r) => {
    const mine = (r.schedules || []).find((x) => x.caseSetId === caseSetId) || null;
    setSched(mine);
    if (mine) {
      const preset = PRESETS.find((x) => x.cron === mine.cron);
      setForm({ enabled: mine.enabled, preset: preset ? preset.cron : 'custom', custom: preset ? '' : mine.cron, target: mine.target });
    }
  }).catch(() => {});
  useEffect(() => { loadHistory(); loadSchedule(); }, [base, caseSetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSchedule = async () => {
    setSchedMsg('');
    const cron = form.preset === 'custom' ? form.custom.trim() : form.preset;
    try {
      await api.put(`${base}/case-sets/${caseSetId}/api-schedule`, { cron, target: form.target, enabled: form.enabled });
      setSchedMsg('Schedule saved.');
      await loadSchedule();
    } catch (e) { setSchedMsg(e.message); }
  };
  const removeSchedule = async () => {
    try { await api.delete(`${base}/case-sets/${caseSetId}/api-schedule`); setSched(null); setSchedMsg('Schedule removed.'); } catch (e) { setSchedMsg(e.message); }
  };

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
      loadHistory();
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

        <div className="dialog-body stack" style={{ paddingTop: 0 }}>
          <details className="gc-spec">
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              Run on a schedule {sched ? <span className={`badge ${sched.enabled ? 'badge-ok' : 'badge-neutral'}`}>{sched.enabled ? 'On' : 'Paused'}</span> : <span className="muted small" style={{ fontWeight: 400 }}>(off)</span>}
            </summary>
            <div className="stack" style={{ marginTop: 10 }}>
              <p className="muted small" style={{ margin: 0 }}>
                Runs these cases automatically and records each run under Run history. Times are UTC. The simulation can run as often as every 5 minutes;
                the live API, which is the client’s server, at most every 15. A scheduled run is made as you, and is skipped if you stop being an editor of the project.
              </p>
              <div className="row wrap" style={{ gap: 10 }}>
                <label className="small">Run on{' '}
                  <select value={form.target} onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))} aria-label="What to run on">
                    {Object.entries(TARGET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label className="small">When{' '}
                  <select value={form.preset} onChange={(e) => setForm((f) => ({ ...f, preset: e.target.value }))} aria-label="When to run">
                    {PRESETS.map((x) => <option key={x.cron} value={x.cron}>{x.label}</option>)}
                    <option value="custom">Custom (cron)…</option>
                  </select>
                </label>
                {form.preset === 'custom' && (
                  <input aria-label="Cron expression" placeholder="m h dom mon dow, e.g. 30 6 * * *" style={{ width: 200 }} value={form.custom} onChange={(e) => setForm((f) => ({ ...f, custom: e.target.value }))} spellCheck={false} />
                )}
                <label className="sim-check small"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} /> On</label>
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={saveSchedule}>Save schedule</button>
                {sched && <button type="button" className="btn btn-sm" onClick={removeSchedule}>Remove</button>}
                {sched?.lastRunAt && <span className="muted small">Last run {new Date(sched.lastRunAt).toLocaleString()}</span>}
                {schedMsg && <span className="small" role="status">{schedMsg}</span>}
              </div>
            </div>
          </details>

          <details className="gc-spec">
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Run history <span className="muted small" style={{ fontWeight: 400 }}>({history.length})</span></summary>
            <div className="sim-table-wrap" style={{ marginTop: 10, maxHeight: 260, overflow: 'auto' }}>
              <table className="sim-table">
                <thead><tr><th>When</th><th>Case set</th><th>Ran on</th><th>By</th><th>Result</th></tr></thead>
                <tbody>
                  {history.length === 0 && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{new Date(h.at).toLocaleString()}</td>
                      <td>{h.caseSetName}</td>
                      <td>{TARGET_LABEL[h.target] || h.target}</td>
                      <td>{h.trigger === 'schedule' ? 'Schedule' : 'A person'}</td>
                      <td className="small">
                        {h.error ? <span className="sim-flag"><Icon name="warning" size={13} /> {h.error}</span> : (
                          <>
                            <span className="badge badge-ok">{h.pass} pass</span>{' '}
                            <span className={`badge ${h.fail ? 'badge-danger' : 'badge-neutral'}`}>{h.fail} fail</span>{' '}
                            {h.mismatch > 0 && <span className="badge badge-danger">{h.mismatch} differ</span>}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default ApiRunDialog;
