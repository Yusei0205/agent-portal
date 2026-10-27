/**
 * User management page (admin only).
 *
 * - List all users: name, email, admin badge, disabled badge, last active
 * - Invite user button → modal: email, role
 * - Deactivate/reactivate toggle per user
 */

import { useState, useEffect, useId, useRef } from 'react';
import { api } from '../../lib/api.js';

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [actionError, setActionError] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get('/api/governance/users');
      setUsers(data.users ?? []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleDisabled = async (user) => {
    setActionError(null);
    try {
      await api.put(`/api/governance/users/${user.id}`, { disabled: !user.disabled });
      await load();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const toggleAdmin = async (user) => {
    setActionError(null);
    try {
      await api.put(`/api/governance/users/${user.id}`, { is_admin: !user.is_admin });
      await load();
    } catch (e) {
      setActionError(e.message);
    }
  };

  if (loading) return <div className="spinner" aria-label="Loading users…" />;
  if (error) return <p className="error-note">{error}</p>;

  return (
    <section aria-label="User management">
      <div className="section-header">
        <h2>Users</h2>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setInviteOpen(true)}
        >
          Invite user
        </button>
      </div>

      {actionError && (
        <p className="error-note" role="alert">{actionError}</p>
      )}

      <table className="data-table" aria-label="Users">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col">Last active</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              onToggleDisabled={() => toggleDisabled(user)}
              onToggleAdmin={() => toggleAdmin(user)}
            />
          ))}
        </tbody>
      </table>

      {inviteOpen && (
        <InviteModal
          onClose={() => setInviteOpen(false)}
          onDone={() => { setInviteOpen(false); load(); }}
        />
      )}
    </section>
  );
}

// ── User row ──────────────────────────────────────────────────────────────────

function UserRow({ user, onToggleDisabled, onToggleAdmin }) {
  const lastActive = user.last_active_at
    ? new Date(user.last_active_at).toLocaleDateString()
    : 'Never';

  return (
    <tr className={user.disabled ? 'row-disabled' : ''}>
      <td>{user.name}</td>
      <td>{user.email}</td>
      <td>
        {user.is_admin ? (
          <span className="badge badge-blue">Admin</span>
        ) : (
          <span className="badge badge-gray">Member</span>
        )}
      </td>
      <td>
        {user.disabled ? (
          <span className="badge badge-red">Disabled</span>
        ) : (
          <span className="badge badge-green">Active</span>
        )}
      </td>
      <td className="muted small">{lastActive}</td>
      <td>
        <div className="stack-h">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onToggleDisabled}
            aria-label={user.disabled ? `Reactivate ${user.name}` : `Deactivate ${user.name}`}
          >
            {user.disabled ? 'Reactivate' : 'Deactivate'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onToggleAdmin}
            aria-label={user.is_admin ? `Remove admin from ${user.name}` : `Make ${user.name} admin`}
          >
            {user.is_admin ? 'Remove admin' : 'Make admin'}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Invite modal ──────────────────────────────────────────────────────────────

function InviteModal({ onClose, onDone }) {
  const uid = useId();
  const firstInputRef = useRef(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api.post('/api/governance/invitations', { email, role });
      setResult(data.invitation);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Trap focus in modal
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${uid}-title`}
      onKeyDown={handleKeyDown}
    >
      <div className="modal">
        <div className="modal-header">
          <h2 id={`${uid}-title`}>Invite user</h2>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {result ? (
          <div className="modal-body stack">
            <p className="success-note">
              Invitation created for <strong>{result.email || 'anyone with the link'}</strong>.
            </p>
            <div className="field">
              <label>Invite link</label>
              <div className="input-with-action">
                <input
                  type="text"
                  readOnly
                  value={result.inviteUrl}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => navigator.clipboard.writeText(result.inviteUrl).catch(() => {})}
                >
                  Copy
                </button>
              </div>
            </div>
            <p className="muted small">
              The link expires in 7 days. Share it with the person you're inviting.
            </p>
            <button type="button" className="btn btn-primary" onClick={onDone}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="modal-body stack" noValidate>
            <div className="field">
              <label htmlFor={`${uid}-email`}>Email address</label>
              <input
                id={`${uid}-email`}
                ref={firstInputRef}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@example.com"
                autoComplete="off"
                required
              />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-role`}>Role</label>
              <select
                id={`${uid}-role`}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            {error && <p className="error-note" role="alert">{error}</p>}
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create invitation'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
