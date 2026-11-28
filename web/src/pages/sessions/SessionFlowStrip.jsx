/**
 * The flow (recipe) of this session above the conversation: the steps with their status, a Run picker for the portal
 * recipes of the session's engine, and Stop. Hidden until the session has a flow or a recipe it can run. The same flow
 * can be driven from the chat with /flow.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { subscribeProject } from '../../lib/events.js';

const MARK = { done: '✓', failed: '✗', running: '…', skipped: '–', pending: '·' };

/**
 * @param {{ workflowId: string, projectId: string }} props
 */
export function SessionFlowStrip({ workflowId, projectId }) {
  const [data, setData] = useState(null);
  const [pick, setPick] = useState('');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/projects/${projectId}/workflows/${workflowId}`;

  const load = useCallback(async () => {
    try {
      setData(await api.get(`${base}/flow`));
    } catch {
      // A dropped connection: keep what is shown.
    }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!projectId) return undefined;
    return subscribeProject(projectId, (event) => {
      const mine = event.workflowId === workflowId || event.parentWorkflowId === workflowId;
      if (mine && (event.type === 'workflow.flow-updated' || event.type === 'workflow.child-finished')) load();
    });
  }, [projectId, workflowId, load]);

  // Steps move on without the page asking, so while one runs the page checks now and then too.
  const running = data?.flow?.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(timer);
  }, [running, load]);

  if (!data) return null;
  const runnable = (data.recipes || []).filter((r) => r.kind === 'portal' && !r.error);
  const flow = data.flow;
  if (!flow && runnable.length === 0) return null;

  const run = async () => {
    const name = pick || runnable[0]?.name;
    if (!name) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`${base}/flow/run`, { name, input });
      setInput('');
      await load();
    } catch (e) {
      setError(e?.message || 'The flow did not start');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`${base}/flow/stop`);
      await load();
    } catch (e) {
      setError(e?.message || 'The flow could not be stopped');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agents-strip flow-strip" aria-label="Flow of this session">
      <div className="agents-strip-bar">
        <strong>Flow</strong>
        {flow && <span className="agents-strip-count">{flow.name}</span>}
        {flow && (
          <span className={`agents-strip-chip ${flow.status === 'running' ? 'is-running' : flow.status === 'failed' ? 'is-failed' : ''}`}>{flow.status}</span>
        )}
        {running && <button type="button" className="btn btn-sm btn-ghost flow-strip-action" disabled={busy} onClick={stop}>Stop</button>}
      </div>

      {flow && (
        <ol className="flow-steps">
          {flow.steps.map((s) => (
            <li key={s.id} className={`flow-step is-${s.status}`} title={s.error || s.resultPreview || ''}>
              <span className="flow-step-mark" aria-hidden="true">{MARK[s.status] || '·'}</span>
              <span className="flow-step-id">{s.id}</span>
              <span className="flow-step-meta">
                {s.status}{s.runs > 1 ? `, run ${s.runs}${s.maxRuns > 1 ? ` of ${s.maxRuns}` : ''}` : ''}
                {s.needs.length > 0 ? ` · after ${s.needs.join(', ')}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
      {flow?.note && flow.status !== 'running' && <p className="flow-note">{flow.note}</p>}

      {!running && runnable.length > 0 && (
        <div className="flow-run">
          <select aria-label="Recipe" value={pick || runnable[0].name} onChange={(e) => setPick(e.target.value)}>
            {runnable.map((r) => <option key={r.name} value={r.name}>{r.name} ({r.steps.length} steps)</option>)}
          </select>
          <input
            type="text"
            aria-label="Input for the flow"
            placeholder="Input for the flow (optional)"
            value={input}
            maxLength={10000}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={run}>Run</button>
        </div>
      )}
      {error && <p className="flow-note is-error" role="alert">{error}</p>}
    </section>
  );
}
