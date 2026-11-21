import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';

/**
 * Test accounts for user guides: who the agent signs in as when it walks through a system and takes screenshots.
 *
 * One row per role (an admin, a clerk, a customer ...): a username and a password. The list is kept encrypted on the server and
 * a password is never shown again (an empty password box keeps the stored one). A CSV can add or replace many at once.
 */

const TEMPLATE = 'role,username,password,notes\nAdmin,admin@test.example,change-me,Can manage everything\nClerk,clerk@test.example,change-me,Day-to-day user\n';

function blank() {
  return { key: `new-${Math.random().toString(36).slice(2)}`, id: '', role: '', username: '', password: '', notes: '', hasPassword: false };
}

export function GuideAccountsModal({ projectId, onClose, onChanged }) {
  const ref = useFocusTrap();
  const [rows, setRows] = useState([]);
  const [limits, setLimits] = useState({ accounts: 20 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [importMode, setImportMode] = useState('add');
  const [importErrors, setImportErrors] = useState([]);

  const base = `/api/projects/${projectId}/guide-accounts`;
  const load = useCallback(async () => {
    try {
      const r = await api.get(base);
      setRows((r.accounts || []).map((a) => ({ ...a, key: a.id, password: '' })));
      setLimits(r.limits || { accounts: 20 });
    } catch (e) {
      setError(e.message || 'Could not load the test accounts');
    } finally {
      setLoading(false);
    }
  }, [base]);
  useEffect(() => { load(); }, [load]);

  const edit = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const save = async () => {
    setBusy(true); setError(null); setNotice(null); setImportErrors([]);
    try {
      const r = await api.put(base, {
        accounts: rows.map((x) => ({ id: x.id || undefined, role: x.role, username: x.username, password: x.password || undefined, notes: x.notes })),
      });
      setRows((r.accounts || []).map((a) => ({ ...a, key: a.id, password: '' })));
      setNotice('Saved.');
      onChanged?.(r.accounts || []);
    } catch (e) {
      setError(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async (file) => {
    if (!file) return;
    setBusy(true); setError(null); setNotice(null); setImportErrors([]);
    try {
      const csv = await file.text();
      const r = await api.post(`${base}/import`, { csv, mode: importMode });
      setRows((r.accounts || []).map((a) => ({ ...a, key: a.id, password: '' })));
      setImportErrors(r.errors || []);
      setNotice(`Imported: ${r.added} added, ${r.updated} updated${r.errors?.length ? `, ${r.errors.length} row${r.errors.length === 1 ? '' : 's'} skipped` : ''}.`);
      onChanged?.(r.accounts || []);
    } catch (e) {
      setError(e.message || 'Could not import the file');
      setImportErrors(e.data?.errors || []);
    } finally {
      setBusy(false);
    }
  };

  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="guide-accounts-title">
      <div className="modal" ref={ref} style={{ width: 'min(900px, 94vw)', maxWidth: 'none' }}>
        <div className="modal-header">
          <h2 id="guide-accounts-title">Test accounts for user guides</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="stack">
          <p className="field-hint">
            When a user guide is made from the running system, the agent signs in with one of these accounts, one per kind of user (role), so it can show each user what they see.
            Use accounts made for testing: anyone who can create documents in this project can use them. The agent never sees a password; it is typed into the sign-in page for it.
            Passwords are stored encrypted and are not shown again.
          </p>

          {loading ? <p className="muted">Loading…</p> : (
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr><th>Role</th><th>Username</th><th>Password</th><th>Notes</th><th aria-label="Remove" /></tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={5} className="table-muted">No test accounts yet. Add one, or import a CSV.</td></tr>}
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td><input type="text" aria-label="Role" style={{ minWidth: 120, width: '100%' }} value={r.role} maxLength={60} placeholder="e.g. Admin" onChange={(e) => edit(r.key, { role: e.target.value })} /></td>
                      <td><input type="text" aria-label="Username" style={{ minWidth: 210, width: '100%' }} value={r.username} maxLength={200} autoComplete="off" onChange={(e) => edit(r.key, { username: e.target.value })} /></td>
                      <td>
                        <input
                          type="password" aria-label="Password" style={{ minWidth: 150, width: '100%' }} value={r.password} maxLength={200} autoComplete="new-password"
                          placeholder={r.hasPassword ? 'unchanged' : 'required'}
                          onChange={(e) => edit(r.key, { password: e.target.value })}
                        />
                      </td>
                      <td><input type="text" aria-label="Notes" style={{ minWidth: 170, width: '100%' }} value={r.notes} maxLength={200} onChange={(e) => edit(r.key, { notes: e.target.value })} /></td>
                      <td><button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={`Remove ${r.role || 'account'}`}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="action-row">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows((rs) => [...rs, blank()])} disabled={busy || rows.length >= limits.accounts}>Add account</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={busy || loading}>{busy ? 'Saving…' : 'Save'}</button>
          </div>

          <div className="field">
            <label htmlFor="ga-csv">Import from a CSV file</label>
            <div className="action-row">
              <input id="ga-csv" type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => { importCsv(e.target.files?.[0]); e.target.value = ''; }} />
              <select aria-label="How to import" value={importMode} onChange={(e) => setImportMode(e.target.value)} disabled={busy}>
                <option value="add">Add new roles, update existing ones</option>
                <option value="replace">Replace the whole list</option>
              </select>
              <a className="btn btn-sm btn-ghost" href={template} download="test-accounts-template.csv">Download template</a>
            </div>
            <p className="field-hint">Columns: <code>role</code>, <code>username</code>, <code>password</code>, and optionally <code>notes</code>. One row per role, up to {limits.accounts}. Delete the file once it is imported.</p>
          </div>

          {error && <p className="error-msg" role="alert">{error}</p>}
          {notice && <p className="field-hint" role="status">{notice}</p>}
          {importErrors.length > 0 && (
            <ul className="field-hint" aria-label="Rows that were skipped">
              {importErrors.map((e, i) => <li key={`${e.line}-${i}`}>{e.line ? `Line ${e.line}: ` : ''}{e.reason}</li>)}
            </ul>
          )}

          <div className="modal-footer">
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
