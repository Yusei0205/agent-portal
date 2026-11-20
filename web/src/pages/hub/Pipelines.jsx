import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../lib/api.js';
import { subscribeProject } from '../../lib/events.js';
import { formatRelative } from '../../lib/util.js';

const STATUSES = {
  queued: { label: 'Queued', tone: 'info' },
  in_progress: { label: 'Running', tone: 'warn' },
  success: { label: 'Succeeded', tone: 'ok' },
  failure: { label: 'Failed', tone: 'danger' },
  timed_out: { label: 'Timed out', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  skipped: { label: 'Skipped', tone: 'muted' },
  other: { label: 'Other', tone: 'muted' },
};

function StatusPill({ status }) {
  const s = STATUSES[status] || STATUSES.other;
  return <span className={`af-pill is-${s.tone}`}>{s.label}</span>;
}

const isGithubUrl = (u) => typeof u === 'string' && u.startsWith('https://github.com/');

function duration(run) {
  if (!run.started_at || !run.completed_at) return '';
  const ms = Date.parse(run.completed_at) - Date.parse(run.started_at);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function RunMeta({ run }) {
  const d = duration(run);
  return (
    <div className="pl-meta">
      <span className="pl-branch">{run.branch}</span>
      <code>{String(run.head_sha || '').slice(0, 7)}</code>
      {run.actor && <span>{run.actor}</span>}
      <span className="muted">{formatRelative(run.started_at || run.updated_at)}</span>
      {d && <span className="muted">{d}</span>}
    </div>
  );
}

function RunRow({ run, onHistory, open }) {
  return (
    <li className="pl-row" data-testid="pipeline-run">
      <div className="pl-main">
        <StatusPill status={run.status} />
        <strong className="pl-wf">{run.workflow_name}</strong>
      </div>
      <RunMeta run={run} />
      <div className="pl-actions">
        {isGithubUrl(run.html_url) && <a href={run.html_url} target="_blank" rel="noreferrer">View run</a>}
        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={onHistory}>{open ? 'Hide history' : 'History'}</button>
      </div>
    </li>
  );
}

function History({ projectId, repoId, run }) {
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    const q = `repoId=${encodeURIComponent(repoId)}&workflowId=${encodeURIComponent(run.workflow_id)}&branch=${encodeURIComponent(run.branch)}`;
    api.get(`/api/projects/${projectId}/pipelines/history?${q}`)
      .then((r) => { if (live) setRuns(r.runs || []); })
      .catch((e) => { if (live) setErr(e.message || 'Could not load the history'); });
    return () => { live = false; };
  }, [projectId, repoId, run.workflow_id, run.branch]);
  return (
    <li className="pl-history" aria-label={`History of ${run.workflow_name} on ${run.branch}`}>
      {err ? <p className="error-note" role="alert">{err}</p>
        : !runs ? <p className="muted small">Loading…</p>
          : runs.length === 0 ? <p className="muted small">No earlier runs.</p>
            : (
              <ul className="pl-hist-list">
                {runs.map((r) => (
                  <li key={`${r.run_id}-${r.run_attempt}`} className="pl-hist-row">
                    <StatusPill status={r.status} />
                    <span>#{r.run_number}{r.run_attempt > 1 ? ` (attempt ${r.run_attempt})` : ''}</span>
                    <code>{String(r.head_sha || '').slice(0, 7)}</code>
                    <span className="muted">{formatRelative(r.started_at || r.updated_at)}</span>
                    {isGithubUrl(r.html_url) && <a href={r.html_url} target="_blank" rel="noreferrer">View run</a>}
                  </li>
                ))}
              </ul>
            )}
    </li>
  );
}

function ChipInput({ id, label, hint, values, onChange, readOnly, placeholder }) {
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setText('');
  };
  return (
    <div className="field af-field">
      <label htmlFor={id}>{label}</label>
      <ul className="af-chips" aria-label={label}>
        {values.map((v) => (
          <li key={v} className="af-chip">{v}
            {!readOnly && <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>}
          </li>
        ))}
        {values.length === 0 && <li className="muted small">{hint}</li>}
      </ul>
      {!readOnly && (
        <div className="af-copy">
          <input id={id} type="text" value={text} maxLength={100} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          <button type="button" className="btn btn-sm" onClick={add}>Add</button>
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ projectId, canManage, requestConfirm, toast }) {
  const [data, setData] = useState(null);
  const [wf, setWf] = useState([]);
  const [br, setBr] = useState([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ro = !canManage;

  const apply = (r) => { setData(r); setWf(r.settings.deploy_workflows); setBr(r.settings.alert_branches); };
  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/pipelines/settings`)
      .then((r) => { if (live) apply(r); })
      .catch((e) => { if (live) setError(e.message || 'Could not load the settings'); });
    return () => { live = false; };
  }, [projectId]);

  if (!data) return error ? <div className="error-note" role="alert">{error}</div> : null;
  const hint = data.chat?.hint;
  const status = data.chat?.status;

  const saveSettings = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.put(`/api/projects/${projectId}/pipelines/settings`, { deploy_workflows: wf, alert_branches: br });
      setWf(r.settings.deploy_workflows); setBr(r.settings.alert_branches);
      toast('Pipeline settings saved', 'ok');
    } catch (err) { setError(err.message || 'Could not save the settings'); }
    finally { setBusy(false); }
  };
  const putChat = async (value) => {
    setBusy(true); setError('');
    try {
      const r = await api.put(`/api/projects/${projectId}/pipelines/chat`, { url: value });
      setData((d) => ({ ...d, chat: r }));
      setUrl('');
      toast(value ? 'Chat URL saved' : 'Chat URL removed', 'ok');
    } catch (err) { setError(err.message || 'Could not save the chat URL'); }
    finally { setBusy(false); }
  };
  const clearChat = async () => {
    if (!await requestConfirm('Remove the chat URL? Deploy alerts stop going to the channel.', 'Remove', 'danger')) return;
    await putChat(null);
  };
  const sendTest = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/projects/${projectId}/pipelines/chat/test`, {});
      toast(r.ok ? 'Test message sent' : 'The channel did not accept the test message', r.ok ? 'ok' : 'error');
      const s = await api.get(`/api/projects/${projectId}/pipelines/settings`);
      setData(s);
    } catch (err) { toast(err.message || 'Could not send the test message', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <section className="af-card" aria-label="Pipeline settings" data-testid="pipelines-settings">
      <h3>Settings</h3>
      {ro && <p className="muted small" data-testid="pipelines-readonly">Only a project owner or admin can change these settings.</p>}
      <form className="af-fieldset" onSubmit={saveSettings}>
        <ChipInput id="pl-wf" label="Deploy workflows" values={wf} onChange={setWf} readOnly={ro}
          hint="Default: any workflow with “deploy” in its name." placeholder="Workflow name, for example Deploy portal" />
        <ChipInput id="pl-br" label="Alert branches" values={br} onChange={setBr} readOnly={ro}
          hint="Default: only each repository's default branch." placeholder="Extra branch, for example release" />
        {!ro && <div><button type="submit" className="btn btn-primary" disabled={busy}>Save settings</button></div>}
      </form>

      <h4 className="af-legend">Slack or Teams channel</h4>
      <p className="small" data-testid="pipelines-chat-hint">
        {hint ? <>Posting to <strong>{hint.host}</strong> (ends in <code>{hint.last4}</code>).</> : <span className="muted">No channel set.</span>}
      </p>
      {status?.lastFailureAt && (
        <p className="error-note small" role="status">Last post failed {formatRelative(status.lastFailureAt)}{status.lastError ? `: ${status.lastError}` : ''}</p>
      )}
      {!ro && (
        <>
          <div className="af-copy">
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Chat webhook URL" autoComplete="off"
              placeholder="https://hooks.slack.com/… or a Teams workflow URL" />
            <button type="button" className="btn btn-sm" disabled={busy || !url.trim()} onClick={() => putChat(url.trim())}>Save URL</button>
          </div>
          <div className="pl-actions">
            <button type="button" className="btn btn-sm" disabled={busy || !hint} onClick={sendTest}>Send test message</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy || !hint} onClick={clearChat}>Remove URL</button>
          </div>
          <p className="field-hint">The saved URL is never shown again, only its host and last 4 characters.</p>
        </>
      )}
      {error && <div className="error-note" role="alert" data-testid="pipelines-error">{error}</div>}
    </section>
  );
}

/** A project's Pipelines tab: the latest GitHub workflow run per branch and workflow, a history drawer and the alert settings. */
export function Pipelines({ projectId, canManage = false, requestConfirm = async () => true, toast = () => {} }) {
  const [showAll, setShowAll] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [openKey, setOpenKey] = useState('');
  const timer = useRef(0);

  const load = useCallback(() => {
    return api.get(`/api/projects/${projectId}/pipelines${showAll ? '?all=1' : ''}`)
      .then((r) => { setData(r); setError(null); })
      .catch((e) => setError(e.message || 'Failed to load pipelines'));
  }, [projectId, showAll]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const unsub = subscribeProject(projectId, (event) => {
      if (event.type !== 'pipeline.run') return;
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 500);
    });
    return () => { clearTimeout(timer.current); unsub(); };
  }, [projectId, load]);

  if (error && !data) return <div className="error-note" role="alert">{error}</div>;
  if (!data) return <div className="spinner-wrap"><div className="spinner" aria-label="Loading…" /></div>;

  const noRuns = data.repos.every((r) => r.runs.length === 0);
  const hookUrl = `${window.location.origin}/api/hooks/autofix/${projectId}`;
  return (
    <div className="af-root pl-root" data-testid="pipelines-tab">
      {error && <div className="error-note" role="alert">{error}</div>}
      {!data.webhookSeen && (
        <p className="af-notice" role="note" data-testid="pipelines-setup-hint">
          <strong>No workflow runs received yet.</strong> Pipelines uses the same GitHub webhook as Auto-fix. In the repository settings on GitHub add a webhook
          with the payload URL <code>{hookUrl}</code>, content type <code>application/json</code> and the <strong>Workflow runs</strong> event. The secret is
          rotated on the <a href={`#/p/${projectId}/setup/autofix`}>Auto-fix tab</a>.
        </p>
      )}
      <label className="af-check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all branches</label>
      {data.repos.length === 0 && <p className="muted">This project has no GitHub repositories.</p>}
      {data.repos.map((repo) => (
        <section key={repo.repoId} className="af-card" aria-label={repo.fullName}>
          <h3>{repo.fullName}</h3>
          {repo.runs.length === 0 ? (
            <p className="muted small">{noRuns && !data.webhookSeen ? 'No runs yet.' : showAll ? 'No runs recorded.' : 'No runs on the alerting branches.'}</p>
          ) : (
            <ul className="pl-list">
              {repo.runs.flatMap((run) => {
                const key = `${repo.repoId}|${run.workflow_id}|${run.branch}`;
                const rows = [<RunRow key={key} run={run} open={openKey === key} onHistory={() => setOpenKey(openKey === key ? '' : key)} />];
                if (openKey === key) rows.push(<History key={`${key}-h`} projectId={projectId} repoId={repo.repoId} run={run} />);
                return rows;
              })}
            </ul>
          )}
        </section>
      ))}
      <SettingsPanel projectId={projectId} canManage={canManage} requestConfirm={requestConfirm} toast={toast} />
    </div>
  );
}

export default Pipelines;
