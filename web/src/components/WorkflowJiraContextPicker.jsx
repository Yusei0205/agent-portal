import { useEffect, useState } from 'react';
import { JiraTicketPicker } from './JiraTicketPicker.jsx';
import { api } from '../lib/api.js';
import { href } from '../lib/router.js';
import '../styles/jira.css';

export function WorkflowJiraContextPicker({ projectId, value, onChange, enabled, disabled }) {
  const [connection, setConnection] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true); setError('');
    api.get(`/api/projects/${projectId}/jira`).then((result) => { if (live) setConnection(result); }).catch((failure) => { if (live) setError(failure.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, enabled, refresh]);
  return <fieldset className="automation-jira-context" disabled={disabled || !enabled}>
    <legend>Jira issue context (optional)</legend>
    {loading && !connection && <p role="status">Loading Jira connection…</p>}
    {error && <p role="alert">Could not load Jira connection: {error}</p>}
    {enabled && (connection?.connected || value) && <JiraTicketPicker projectId={projectId} jiraMapping={connection?.mapping || null} value={value} onChange={onChange} />}
    {connection && !connection.connected && <p className="muted small">Jira is not connected for this project. <a href={href(projectId, 'tickets')}>Set up Jira</a> to choose an issue.</p>}
    <div className="automation-jira-context-help"><p className="muted small">Choose an issue from the project’s Jira connection. Search by key or summary, filter the project, or switch between Mine and All. The selected issue and its available attachments are snapshotted when the run starts.</p><button type="button" className="btn btn-sm" disabled={loading} onClick={() => setRefresh((current) => current + 1)}>{loading ? 'Refreshing…' : 'Refresh connection'}</button></div>
  </fieldset>;
}
