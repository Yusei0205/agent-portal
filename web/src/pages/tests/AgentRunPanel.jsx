import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatRelative } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { AiChoicePicker } from '../../components/AiChoicePicker.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';

/**
 * An agent performs a case set's test cases in a browser against the app, then the Status and Remarks columns are
 * filled in, a results CSV is made, and the run is kept in a history with pass and fail counts.
 */

const MAX_CASES = 30;

export function AgentRunDialog({ projectId, testProjectId, caseSetId, cases, onClose, onStarted, resume = null }) {
  const base = `/api/projects/${projectId}/tests/${testProjectId}/case-sets/${caseSetId}`;
  const [ai, setAi] = useState({});
  const [instructions, setInstructions] = useState('');
  const [scope, setScope] = useState('all');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [logins, setLogins] = useState([]);
  const [chosen, setChosen] = useState(null);

  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/tests/${testProjectId}/vault`).then((r) => {
      if (!live) return;
      const list = (r.items || []).filter((i) => i.kind === 'login');
      setLogins(list);
      setChosen(new Set(list.map((i) => i.name)));
    }).catch(() => { if (live) setChosen(new Set()); });
    return () => { live = false; };
  }, [projectId, testProjectId]);

  const toggleLogin = (name) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const categories = [...new Set(cases.map((c) => c.category).filter(Boolean))];
  const matching = resume ? resume.remaining : cases.filter((c) => (!category || c.category === category)
    && (scope === 'all' || (scope === 'notPassed' ? c.status !== 'Pass' : (!c.status || c.status === 'Not Run')))).length;
  const count = Math.min(matching, MAX_CASES);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`${base}/agent-runs`, { ...ai, instructions, scope, category, vaultNames: [...(chosen || [])], ...(resume ? { resumeOf: resume.id } : {}) });
      onStarted(r);
    } catch (e) {
      setError(e.message || 'Could not start the run');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="arun-title">
      <div className="modal">
        <div className="modal-header">
          <h2 id="arun-title">
            {resume ? 'Resume the run' : 'Run with agent'}
            <InfoTip title="What happens">
              An agent opens your app in a browser and performs each test case: it follows the steps, compares what it sees with the expected result,
              and decides Pass, Fail or Blocked, with a note.
              <span className="info-tip-line">Its answers fill the Status and Remarks columns of this sheet, a results CSV is made, and the run is kept in Run history with its pass and fail counts.</span>
              <span className="info-tip-line">The app address and rules come from the Settings tab. Tick the Vault logins the agent may sign in with; it gets no other part of the Vault.</span>
            </InfoTip>
          </h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close" disabled={busy}>✕</button>
        </div>
        <div className="stack">
          {resume && (
            <p className="muted small">
              {resume.remaining} case{resume.remaining === 1 ? '' : 's'} of the run from {formatRelative(resume.startedAt)} still {resume.remaining === 1 ? 'has' : 'have'} no result. The agent does only those; the ones that already have a result are left as they are.
            </p>
          )}
          <div className="arun-scope" hidden={!!resume}>
            <div className="field">
              <label htmlFor="arun-scope">Which cases</label>
              <select id="arun-scope" value={scope} onChange={(e) => setScope(e.target.value)} disabled={busy}>
                <option value="all">All cases</option>
                <option value="notRun">Only cases not run yet</option>
                <option value="notPassed">Only cases without Pass (re-test failed and blocked ones)</option>
              </select>
            </div>
            {categories.length > 1 && (
              <div className="field">
                <label htmlFor="arun-cat">Category</label>
                <select id="arun-cat" value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy}>
                  <option value="">Any category</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
          </div>
          <p className="muted small">
            {matching === 0
              ? 'No case matches that choice.'
              : <>The agent works through {count} test case{count === 1 ? '' : 's'} one by one; expect about a minute per case. You can keep working and watch the run live.
                {matching > MAX_CASES && <> {matching} cases match, and one run takes the first {MAX_CASES}. Choose “only cases not run yet” to run the next batch afterwards.</>}</>}
          </p>
          <AiChoicePicker onChange={setAi} disabled={busy} idPrefix="arun-ai" />
          <fieldset className="arun-logins">
            <legend>Sign-in accounts the agent may use</legend>
            {logins.length === 0
              ? <p className="muted small">No login in this project's Vault yet, so cases that need a sign-in will come back Blocked. Add one in the Vault tab, or write a test account in the instructions below.</p>
              : (
                <>
                  {logins.map((l) => (
                    <label key={l.id || l.name} className="choice">
                      <input type="checkbox" checked={!!chosen?.has(l.name)} onChange={() => toggleLogin(l.name)} disabled={busy} />
                      <span>{l.name} <span className="muted small">{l.username}{l.hasTotp ? ' · two-step code (agent cannot use it)' : ''}</span></span>
                    </label>
                  ))}
                  <p className="field-hint">The agent is given the username and password of each ticked account in its prompt, which is kept in the run's session transcript. Tick only test accounts.</p>
                </>
              )}
          </fieldset>
          <div className="field">
            <label htmlFor="arun-notes">Instructions for the agent <span className="muted">(optional)</span></label>
            <textarea
              id="arun-notes"
              rows={3}
              maxLength={4000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={busy}
              placeholder="e.g. Sign in as qa.tester@example.com, password … (a test account only)"
            />
            <p className="field-hint">What you write here is saved in the run's session transcript, so use a test account, never a real person's login.</p>
          </div>
          {error && <p className="error-note" role="alert">{error}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={start} disabled={busy || count === 0}>
            {busy ? 'Starting…' : `Run ${count} case${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL = { running: 'Running', done: 'Finished', failed: 'Failed', cancelled: 'Stopped' };

function Counts({ r }) {
  return (
    <span className="arun-counts">
      <span className="arun-n arun-pass" title="Pass">{r.pass} pass</span>
      <span className="arun-n arun-fail" title="Fail">{r.fail} fail</span>
      <span className="arun-n arun-blocked" title="Blocked">{r.blocked} blocked</span>
      {r.notRun > 0 && <span className="arun-n muted" title="Not run">{r.notRun} not run</span>}
    </span>
  );
}

export function AgentRunHistory({ projectId, testProjectId, caseSetId, onClose, onChanged, onResume }) {
  const base = `/api/projects/${projectId}/tests/${testProjectId}`;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const lastRunning = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`${base}/case-sets/${caseSetId}/agent-runs`);
      setData(r);
      setError(null);
      const running = r.runs.filter((x) => x.status === 'running').length;
      // A run just finished: the sheet's Status and Remarks changed, so the table behind this panel reloads.
      if (lastRunning.current > running) onChanged?.();
      lastRunning.current = running;
    } catch (e) {
      setError(e.message || 'Could not load the history');
    }
  }, [base, caseSetId, onChanged]);

  useEffect(() => { load(); }, [load]);
  const anyRunning = data?.runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!anyRunning) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const t = data?.totals;
  const cur = data?.current;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="ahist-title">
      <div className="modal arun-history">
        <div className="modal-header">
          <h2 id="ahist-title">
            Run history
            <InfoTip title="About the history">
              Every agent run of this case set, newest first, with how many cases passed, failed or were blocked in that run.
              <span className="info-tip-line">“Now” is the sheet as it stands: the latest result of each case, including any you edited by hand.</span>
              <span className="info-tip-line">Download CSV gives that run's results, to open in Excel.</span>
            </InfoTip>
          </h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {error && <p className="error-note" role="alert">{error}</p>}
        {!data && !error && <p className="muted">Loading…</p>}
        {data && (
          <>
            <div className="arun-summary">
              <div>
                <span className="muted small">Now</span>
                <Counts r={{ pass: cur.pass, fail: cur.fail, blocked: cur.blocked, notRun: cur.notRun }} />
              </div>
              <div>
                <span className="muted small">All {t.finished} finished run{t.finished === 1 ? '' : 's'}</span>
                <span className="arun-counts">
                  <span className="arun-n arun-pass">{t.casesPassed} passed</span>
                  <span className="arun-n arun-fail">{t.casesFailed} failed</span>
                  <span className="arun-n arun-blocked">{t.casesBlocked} blocked</span>
                  {t.failedRuns > 0 && <span className="arun-n muted">{t.failedRuns} run{t.failedRuns === 1 ? '' : 's'} did not finish</span>}
                </span>
              </div>
              <a className="btn btn-sm" href={`${base}/case-sets/${caseSetId}/results.csv`} download>
                <Icon name="download" size={13} /> Current results (CSV)
              </a>
            </div>

            {data.runs.length === 0 && <p className="muted">No agent run yet. Press “Run with agent” to start one.</p>}
            {data.runs.length > 0 && (
              <table className="data-table" aria-label="Agent runs">
                <thead>
                  <tr><th>Started</th><th>Status</th><th>Result</th><th>By</th><th></th></tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id}>
                      <td title={new Date(r.startedAt).toLocaleString()}>{formatRelative(r.startedAt)}</td>
                      <td>
                        {r.status === 'running'
                          ? <span className="arun-live"><span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" /> Running</span>
                          : <span className={`badge ${r.status === 'done' ? 'badge-ok' : 'badge-danger'}`}>{STATUS_LABEL[r.status]}</span>}
                      </td>
                      <td>
                        {r.status === 'running' ? <span className="muted small">{r.total} case{r.total === 1 ? '' : 's'}…</span> : <Counts r={r} />}
                        {r.error && <div className="error-note small" role="status">{r.error}</div>}
                      </td>
                      <td className="muted small">{r.startedBy}</td>
                      <td>
                        <div className="row-actions">
                          <a className="btn btn-sm" href={`#/p/${projectId}/sessions/${r.workflowId}`}>{r.status === 'running' ? 'Watch live' : 'View run'}</a>
                          {r.status !== 'running' && r.remaining > 0 && onResume && (
                            <button type="button" className="btn btn-sm btn-primary" onClick={() => onResume(r)} title="Run the cases of this run that still have no result">
                              Resume ({r.remaining})
                            </button>
                          )}
                          {r.hasCsv && <a className="btn btn-sm" href={`${base}/agent-runs/${r.id}/results.csv`} download>CSV</a>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
