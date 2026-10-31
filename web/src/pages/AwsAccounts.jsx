import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { AwsRegionSelect } from '../components/AwsRegionSelect.jsx';

const AUTH_METHODS = [
  { value: 'keys',          label: 'Access keys' },
  { value: 'profile',       label: 'Named profile' },
  { value: 'instance-role', label: 'Instance role' },
  { value: 'sso',           label: 'AWS SSO / IAM Identity Center' },
];

const METHOD_BADGE_CLASS = {
  'keys':          'badge badge-neutral',
  'profile':       'badge badge-neutral',
  'instance-role': 'badge badge-info',
  'sso':           'badge badge-info',
};

// ── Conditional credential fields ─────────────────────────────────────────────

function CredentialFields({ authMethod, state, onChange }) {
  const update = (key, val) => onChange({ ...state, [key]: val });

  if (authMethod === 'keys') {
    return (
      <>
        <div className="field">
          <label htmlFor="aws-key-id">Access key ID</label>
          <input
            id="aws-key-id"
            type="password"
            value={state.accessKeyId ?? ''}
            onChange={(e) => update('accessKeyId', e.target.value)}
            autoComplete="off"
            placeholder="AKIAIOSFODNN7EXAMPLE"
          />
        </div>
        <div className="field">
          <label htmlFor="aws-key-secret">Secret access key</label>
          <input
            id="aws-key-secret"
            type="password"
            value={state.secretAccessKey ?? ''}
            onChange={(e) => update('secretAccessKey', e.target.value)}
            autoComplete="new-password"
          />
        </div>
      </>
    );
  }

  if (authMethod === 'profile') {
    return (
      <div className="field">
        <label htmlFor="aws-profile">Profile name</label>
        <input
          id="aws-profile"
          type="text"
          value={state.profileName ?? ''}
          onChange={(e) => update('profileName', e.target.value)}
          placeholder="default"
        />
      </div>
    );
  }

  const notes = {
    'instance-role': 'The portal will use the instance role attached to the host machine. No credentials to enter.',
    'sso':           'AWS SSO sign-in is initiated when the portal first needs to call AWS. No credentials to enter.',
  };

  return <p className="field-hint">{notes[authMethod]}</p>;
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function AwsAccountModal({ projectId, account, onClose, onSave }) {
  const [name, setName]           = useState(account?.name ?? '');
  const [authMethod, setAuthMethod] = useState(account?.auth_method ?? 'keys');
  const [region, setRegion]       = useState(account?.region ?? '');
  const [credState, setCredState] = useState({});
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);

    const credentials = authMethod === 'keys'
      ? { accessKeyId: credState.accessKeyId, secretAccessKey: credState.secretAccessKey }
      : undefined;
    const profileName = authMethod === 'profile' ? credState.profileName : undefined;

    try {
      if (account) {
        const r = await api.put(`/api/projects/${projectId}/aws-accounts/${account.id}`, {
          name: name.trim(),
          region: region.trim() || null,
          ...(credentials ? { credentials } : {}),
          ...(profileName !== undefined ? { profileName } : {}),
        });
        onSave(r.account);
      } else {
        const r = await api.post(`/api/projects/${projectId}/aws-accounts`, {
          name: name.trim(),
          authMethod,
          region: region.trim() || null,
          ...(credentials ? { credentials } : {}),
          ...(profileName !== undefined ? { profileName } : {}),
        });
        onSave(r.account);
      }
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={account ? 'Edit AWS account' : 'Add AWS account'}>
      <div className="modal">
        <div className="modal-header">
          <h2>{account ? 'Edit AWS account' : 'Add AWS account'}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="stack">
            <div className="field">
              <label htmlFor="aws-name">Name</label>
              <input
                id="aws-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Production"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="aws-region">Region</label>
              <AwsRegionSelect
                id="aws-region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </div>
            {!account && (
              <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
                <legend className="field" style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--ink-2)' }}>
                    Authentication method
                  </span>
                </legend>
                <div className="stack">
                  {AUTH_METHODS.map((m) => (
                    <label
                      key={m.value}
                      className={`choice${authMethod === m.value ? ' is-checked' : ''}`}
                    >
                      <input
                        type="radio"
                        name="auth-method"
                        value={m.value}
                        checked={authMethod === m.value}
                        onChange={() => { setAuthMethod(m.value); setCredState({}); }}
                      />
                      <span>{m.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <CredentialFields
              authMethod={account?.auth_method ?? authMethod}
              state={credState}
              onChange={setCredState}
            />
            {error && <p className="error-note" role="alert">{error}</p>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : account ? 'Save changes' : 'Add account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AwsAccounts({ projectId, currentProject }) {
  const [accounts, setAccounts]       = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [modal, setModal]             = useState(null); // null | 'new' | { account }
  const [testResults, setTestResults] = useState({}); // id → { ok, identity?, note?, error? }
  const [testing, setTesting]         = useState({}); // id → bool
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  const load = useCallback(async () => {
    if (!projectId) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/projects/${projectId}/aws-accounts`);
      setAccounts(r.accounts || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const testAccount = async (acct) => {
    setTesting((t) => ({ ...t, [acct.id]: true }));
    setTestResults((r) => ({ ...r, [acct.id]: null }));
    try {
      const result = await api.post(`/api/projects/${projectId}/aws-accounts/${acct.id}/test`);
      setTestResults((r) => ({ ...r, [acct.id]: result }));
    } catch (e) {
      setTestResults((r) => ({ ...r, [acct.id]: { ok: false, error: e.message } }));
    } finally {
      setTesting((t) => ({ ...t, [acct.id]: false }));
    }
  };

  const deleteAccount = async (acct) => {
    if (!await requestConfirm(`Remove AWS account "${acct.name}"?`, 'Remove', 'danger')) return;
    try {
      await api.delete(`/api/projects/${projectId}/aws-accounts/${acct.id}`);
      setAccounts((prev) => prev.filter((a) => a.id !== acct.id));
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const handleSave = (saved) => {
    setAccounts((prev) => {
      const idx = prev.findIndex((a) => a.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
    setModal(null);
  };

  const renderTestResult = (res) => {
    if (!res) return null;
    if (!res.ok) return <span className="danger small" role="status">✗ {res.error || 'Failed'}</span>;
    if (res.identity) return <span className="ok small" role="status">✓ {res.identity.account} ({res.identity.arn?.split(':').pop()})</span>;
    return <span className="ok small" role="status">✓ {res.note || 'OK'}</span>;
  };

  return (
    <>
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />

      {/* No project selected — helpful prompt */}
      {!projectId && (
        <div className="card">
          <p className="muted">
            No project selected.{' '}
            <a href="#/projects">Choose a project</a> in the rail picker to manage its AWS credentials here.
          </p>
        </div>
      )}

      {/* Project-scoped content */}
      {projectId && (
        <>
          {/* Project context header */}
          <p className="muted" style={{ marginBottom: '0.75rem', fontSize: '0.84rem' }}>
            AWS accounts for project:{' '}
            <strong>{currentProject?.name ?? projectId}</strong>
          </p>

          <div className="page-actions" style={{ marginBottom: '1rem' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setModal('new')}
            >
              <Icon name="plus" size={14} />
              Add account
            </button>
          </div>
          <p className="muted">AWS accounts available to agent runs in this project.</p>

          {loading && <p className="muted">Loading…</p>}
          {error && <p className="error-note" role="alert">{error}</p>}

          {!loading && !error && accounts.length === 0 && (
            <div className="card">
              <p className="muted">No AWS accounts yet.</p>
            </div>
          )}

          {!loading && accounts.length > 0 && (
            <table className="data-table" aria-label="AWS accounts">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Auth method</th>
                  <th>Region</th>
                  <th>Added</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acct) => (
                  <tr key={acct.id}>
                    <td>{acct.name}</td>
                    <td>
                      <span className={METHOD_BADGE_CLASS[acct.auth_method] || 'badge badge-neutral'}>
                        {AUTH_METHODS.find((m) => m.value === acct.auth_method)?.label ?? acct.auth_method}
                      </span>
                    </td>
                    <td className="muted">{acct.region || '—'}</td>
                    <td className="muted">{formatRelative(acct.created_at)}</td>
                    <td>
                      <div className="row">
                        {renderTestResult(testResults[acct.id])}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => testAccount(acct)}
                          disabled={testing[acct.id]}
                          aria-label={`Test ${acct.name}`}
                        >
                          {testing[acct.id] ? 'Testing…' : 'Test'}
                        </button>
                        <button
                          type="button"
                          className="btn-icon"
                          title="Delete"
                          aria-label={`Delete ${acct.name}`}
                          onClick={() => deleteAccount(acct)}
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
        </>
      )}

      {modal && (
        <AwsAccountModal
          projectId={projectId}
          account={modal === 'new' ? null : modal.account}
          onClose={() => setModal(null)}
          onSave={handleSave}
        />
      )}
    </>
  );
}

export default AwsAccounts;
