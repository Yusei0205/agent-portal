/**
 * AWS accounts for a project's agents (a tab of Workspaces).
 *
 * The account marked "agents use this" is handed to every cloud session of the project as AWS_* variables, so
 * the aws CLI and SDKs work in the agent's shell. Keys are stored encrypted and are never shown again.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { SectionHead } from '../components/PageHeader.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';

const EMPTY = { name: '', region: 'ap-southeast-1', accessKeyId: '', secretAccessKey: '', sessionToken: '' };

function AccountForm({ projectId, account, onDone, onCancel }) {
  const editing = Boolean(account);
  const [form, setForm] = useState(editing ? { ...EMPTY, name: account.name, region: account.region || EMPTY.region } : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name: form.name, region: form.region };
      // When editing, empty key fields keep the stored keys.
      if (!editing || form.accessKeyId || form.secretAccessKey || form.sessionToken) {
        body.accessKeyId = form.accessKeyId;
        body.secretAccessKey = form.secretAccessKey;
        body.sessionToken = form.sessionToken;
      }
      if (editing) await api.put(`/api/projects/${projectId}/aws-accounts/${account.id}`, body);
      else await api.post(`/api/projects/${projectId}/aws-accounts`, body);
      onDone();
    } catch (err) {
      setError(err.message || 'Could not save the account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="aws-form" onSubmit={submit} autoComplete="off">
      <div className="aws-form-row">
        <div className="field">
          <label htmlFor="aws-name">Name</label>
          <input id="aws-name" value={form.name} onChange={set('name')} placeholder="dev account" required maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor="aws-region">Region</label>
          <input id="aws-region" value={form.region} onChange={set('region')} placeholder="ap-southeast-1" required />
        </div>
      </div>
      <div className="aws-form-row">
        <div className="field">
          <label htmlFor="aws-key">Access key id</label>
          <input id="aws-key" value={form.accessKeyId} onChange={set('accessKeyId')} placeholder={editing ? 'Leave empty to keep the stored keys' : 'AKIA…'} required={!editing} spellCheck={false} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="aws-secret">Secret access key</label>
          <input id="aws-secret" type="password" value={form.secretAccessKey} onChange={set('secretAccessKey')} required={!editing} spellCheck={false} autoComplete="new-password" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="aws-token">Session token <span className="muted">(only for temporary keys)</span></label>
        <input id="aws-token" type="password" value={form.sessionToken} onChange={set('sessionToken')} spellCheck={false} autoComplete="new-password" />
        <p className="field-hint">Write-only: after saving, only the last 4 characters of the key id are shown.</p>
      </div>
      {error && <div className="error-note" role="alert">{error}</div>}
      <div className="aws-form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add account'}</button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

export function ProjectAws({ projectId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // null | 'new' | account
  const { confirmState, requestConfirm } = useConfirm();

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/projects/${projectId}/aws-accounts`));
      setError(null);
    } catch (e) {
      setError(e.message || 'Could not load the AWS accounts');
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const useForAgents = async (accountId) => {
    try { await api.put(`/api/projects/${projectId}/aws-default`, { accountId }); await load(); } catch (e) { setError(e.message); }
  };

  const remove = async (account) => {
    const ok = await requestConfirm(`Remove ${account.name}? Agents in this project stop using it and its keys are deleted from the portal; nothing changes in AWS.`, 'Remove', 'danger');
    if (!ok) return;
    try { await api.delete(`/api/projects/${projectId}/aws-accounts/${account.id}`); await load(); } catch (e) { setError(e.message); }
  };

  const accounts = data?.accounts ?? [];

  return (
    <div className="aws-accounts">
      <ConfirmDialog state={confirmState} />
      <SectionHead description="AWS accounts for this project's agents. The account marked “agents use this” is given to every cloud session of the project, so the aws CLI and SDKs work in the agent's shell.">
        <button type="button" className="btn btn-primary" onClick={() => setForm('new')}>
          <Icon name="plus" size={14} />
          Add AWS account
        </button>
      </SectionHead>

      <div className="warn-note aws-note" role="note">
        <Icon name="warning" size={15} />
        <span>
          The agent can do whatever this account's permissions allow. Use an IAM user limited to what the project
          needs, and keep “ask before tool use” on. Keys are stored encrypted and sent only to the session's machine.
        </span>
      </div>

      {error && <div className="error-note" role="alert">{error}</div>}
      {form && (
        <AccountForm
          projectId={projectId}
          account={form === 'new' ? null : form}
          onDone={() => { setForm(null); load(); }}
          onCancel={() => setForm(null)}
        />
      )}

      {!data && !error && <p className="muted">Loading…</p>}
      {data && accounts.length === 0 && !form && (
        <p className="muted">No AWS account yet. Add one to let this project's agents use the aws CLI.</p>
      )}
      <ul className="aws-list">
        {accounts.map((a) => (
          <li key={a.id} className="aws-item">
            <div className="aws-item-main">
              <strong>{a.name}</strong>
              <span className="muted small">
                {a.region || 'no region'} · key …{a.accessKeyIdTail ?? '????'}{a.temporary ? ' · temporary' : ''}
              </span>
            </div>
            {a.isDefault
              ? <span className="badge badge-ok">agents use this</span>
              : <button type="button" className="btn btn-sm" onClick={() => useForAgents(a.id)}>Use for agents</button>}
            <button type="button" className="btn btn-sm" onClick={() => setForm(a)}>Edit</button>
            <button type="button" className="btn btn-sm" onClick={() => remove(a)}>Remove</button>
          </li>
        ))}
      </ul>
      {accounts.length > 0 && data?.defaultId && (
        <p className="muted small">
          <button type="button" className="link-btn" onClick={() => useForAgents(null)}>Stop giving agents an account</button>
        </p>
      )}
    </div>
  );
}

export default ProjectAws;
