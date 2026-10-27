import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';

const INTEGRATION_TYPES = [
  { value: 'http',       label: 'HTTP' },
  { value: 'stdio',      label: 'Stdio' },
  { value: 'atlassian',  label: 'Atlassian (Jira)' },
  { value: 'aws',        label: 'AWS' },
  { value: 'browser',    label: 'Browser' },
  { value: 'drawio',     label: 'draw.io' },
];

const TYPE_BADGE_CLASS = {
  http:      'badge badge-info',
  stdio:     'badge badge-neutral',
  atlassian: 'badge badge-neutral',
  aws:       'badge badge-neutral',
  browser:   'badge badge-neutral',
  drawio:    'badge badge-neutral',
};

// ── Config fields per type ────────────────────────────────────────────────────

function ConfigFields({ type, config, onChange }) {
  const update = (key, val) => onChange({ ...config, [key]: val });

  if (type === 'http') {
    return (
      <div className="field">
        <label htmlFor="int-url">URL</label>
        <input
          id="int-url"
          type="url"
          value={config.url ?? ''}
          onChange={(e) => update('url', e.target.value)}
          placeholder="https://my-mcp-server.example.com"
        />
      </div>
    );
  }

  if (type === 'stdio') {
    return (
      <>
        <div className="field">
          <label htmlFor="int-cmd">Command</label>
          <input
            id="int-cmd"
            type="text"
            value={config.command ?? ''}
            onChange={(e) => update('command', e.target.value)}
            placeholder="npx my-mcp-server"
          />
        </div>
        <div className="field">
          <label htmlFor="int-args">Args (space-separated)</label>
          <input
            id="int-args"
            type="text"
            value={config.args ?? ''}
            onChange={(e) => update('args', e.target.value)}
            placeholder="--port 3000"
          />
        </div>
      </>
    );
  }

  if (type === 'atlassian') {
    return (
      <>
        <div className="field">
          <label htmlFor="int-jira-url">Jira base URL</label>
          <input
            id="int-jira-url"
            type="url"
            value={config.baseUrl ?? ''}
            onChange={(e) => update('baseUrl', e.target.value)}
            placeholder="https://yourorg.atlassian.net"
          />
        </div>
        <div className="field">
          <label htmlFor="int-jira-token">API token</label>
          <input
            id="int-jira-token"
            type="password"
            value={config.token ?? ''}
            onChange={(e) => update('token', e.target.value)}
            autoComplete="off"
          />
        </div>
      </>
    );
  }

  // aws, browser, drawio — informational only
  const notes = {
    aws:     'AWS integration is managed via the AWS Accounts section. Enable it per session using /aws on.',
    browser: 'Browser integration requires the Browser MCP tool pack. Enable it per session using /browser on.',
    drawio:  'draw.io integration requires the Icon diagrams tool pack installed under Settings › Tools.',
  };

  return (
    <p className="field-hint">{notes[type]}</p>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function IntegrationModal({ projectId, integration, onClose, onSave }) {
  const [name, setName]     = useState(integration?.name ?? '');
  const [type, setType]     = useState(integration?.type ?? 'http');
  const [config, setConfig] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    try {
      if (integration) {
        const r = await api.put(`/api/projects/${projectId}/integrations/${integration.id}`, {
          name: name.trim(),
          config,
        });
        onSave(r.integration);
      } else {
        const r = await api.post(`/api/projects/${projectId}/integrations`, {
          name: name.trim(),
          type,
          config,
        });
        onSave(r.integration);
      }
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={integration ? 'Edit integration' : 'Add integration'}>
      <div className="modal">
        <div className="modal-header">
          <h2>{integration ? 'Edit integration' : 'Add integration'}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="stack">
            <div className="field">
              <label htmlFor="int-name">Name</label>
              <input
                id="int-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Internal MCP server"
                autoFocus
              />
            </div>
            {!integration && (
              <div className="field">
                <label htmlFor="int-type">Type</label>
                <select id="int-type" value={type} onChange={(e) => { setType(e.target.value); setConfig({}); }}>
                  {INTEGRATION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            )}
            <ConfigFields type={integration?.type ?? type} config={config} onChange={setConfig} />
            {error && <p className="error-note" role="alert">{error}</p>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : integration ? 'Save changes' : 'Add integration'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function Integrations({ projectId }) {
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [modal, setModal]               = useState(null); // null | 'new' | { integration }
  const [testResults, setTestResults]   = useState({}); // id → { ok, note, error }
  const [testing, setTesting]           = useState({}); // id → bool

  const load = useCallback(async () => {
    if (!projectId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/integrations`);
      setIntegrations(r.integrations || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const toggleEnabled = async (intg) => {
    try {
      const r = await api.put(`/api/projects/${projectId}/integrations/${intg.id}`, {
        enabled: !intg.enabled,
      });
      setIntegrations((prev) => prev.map((i) => (i.id === r.integration.id ? r.integration : i)));
    } catch (e) {
      alert(e.message);
    }
  };

  const testIntegration = async (intg) => {
    setTesting((t) => ({ ...t, [intg.id]: true }));
    setTestResults((r) => ({ ...r, [intg.id]: null }));
    try {
      const result = await api.post(`/api/projects/${projectId}/integrations/${intg.id}/test`);
      setTestResults((r) => ({ ...r, [intg.id]: result }));
    } catch (e) {
      setTestResults((r) => ({ ...r, [intg.id]: { ok: false, error: e.message } }));
    } finally {
      setTesting((t) => ({ ...t, [intg.id]: false }));
    }
  };

  const deleteIntegration = async (intg) => {
    if (!confirm(`Remove integration "${intg.name}"?`)) return;
    try {
      await api.delete(`/api/projects/${projectId}/integrations/${intg.id}`);
      setIntegrations((prev) => prev.filter((i) => i.id !== intg.id));
    } catch (e) {
      alert(e.message);
    }
  };

  const handleSave = (saved) => {
    setIntegrations((prev) => {
      const idx = prev.findIndex((i) => i.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
    setModal(null);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Integrations</h1>
        <div className="page-actions">
          {projectId && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setModal('new')}
            >
              <Icon name="plus" size={14} />
              Add integration
            </button>
          )}
        </div>
      </div>
      <p className="muted">MCP integrations available to agent runs in this project.</p>

      {!projectId && (
        <div className="card">
          <p className="muted">Open a project and go to Integrations to manage its MCP integrations.</p>
        </div>
      )}

      {projectId && loading && <p className="muted">Loading…</p>}
      {projectId && error && <p className="error-note" role="alert">{error}</p>}

      {!loading && !error && integrations.length === 0 && (
        <div className="card">
          <p className="muted">No integrations yet.</p>
        </div>
      )}

      {!loading && integrations.length > 0 && (
        <table className="data-table" aria-label="MCP integrations">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Enabled</th>
              <th>Added</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {integrations.map((intg) => (
              <tr key={intg.id}>
                <td>{intg.name}</td>
                <td>
                  <span className={TYPE_BADGE_CLASS[intg.type] || 'badge badge-neutral'}>
                    {intg.type}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className={`btn btn-sm ${intg.enabled ? '' : 'btn-ghost'}`}
                    onClick={() => toggleEnabled(intg)}
                    aria-pressed={intg.enabled}
                    aria-label={intg.enabled ? `Disable ${intg.name}` : `Enable ${intg.name}`}
                  >
                    {intg.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </td>
                <td className="muted">{formatRelative(intg.created_at)}</td>
                <td>
                  <div className="row">
                    {testResults[intg.id] && (
                      <span
                        className={testResults[intg.id].ok ? 'ok small' : 'danger small'}
                        role="status"
                      >
                        {testResults[intg.id].ok
                          ? testResults[intg.id].note || '✓ OK'
                          : `✗ ${testResults[intg.id].error || 'Failed'}`}
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => testIntegration(intg)}
                      disabled={testing[intg.id]}
                      aria-label={`Test ${intg.name}`}
                    >
                      {testing[intg.id] ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      title="Delete"
                      aria-label={`Delete ${intg.name}`}
                      onClick={() => deleteIntegration(intg)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal && (
        <IntegrationModal
          projectId={projectId}
          integration={modal === 'new' ? null : modal.integration}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

export default Integrations;
