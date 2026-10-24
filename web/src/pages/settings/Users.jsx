import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/context.js';
import { useLoad } from '../../lib/useAsync.js';
import { useSortable } from '../../lib/useSortable.js';
import { SortHeader } from '../../components/SortHeader.jsx';
import { Badge, Button, ErrorNote, Field, Modal, Note, Spinner, Toggle, useUi } from '../../components/ui.jsx';

export function Users() {
  const { user } = useApp();
  const { toast, confirm } = useUi();
  const users = useLoad(() => api.get('/api/users'), []);
  const [adding, setAdding] = useState(false);
  const patch = async (u, body, msg) => {
    try {
      await api.patch(`/api/users/${u.id}`, body);
      toast(msg);
      users.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  const USER_COLS = [
    { key: 'name',   label: 'Name',   accessor: 'name',  type: 'text' },
    { key: 'email',  label: 'Email',  accessor: 'email', type: 'text' },
    { key: 'admin',  label: 'Admin',  accessor: (u) => u.is_admin ? 1 : 0, type: 'number' },
    { key: 'status', label: 'Status', accessor: (u) => u.disabled ? 'disabled' : 'active', type: 'status' },
  ];
  const { sorted: sortedUsers, sortKey: uSortKey, sortDir: uSortDir, toggle: uToggle } = useSortable(
    users.data?.users || [],
    { columns: USER_COLS, storageKey: 'sort:settings:users' }
  );

  return (
    <section className="panel span-2">
      <div className="row between">
        <h2>Users</h2>
        <Button icon="plus" onClick={() => setAdding(true)}>
          Add user
        </Button>
      </div>
      {users.data ? (
        <table className="table">
          <thead>
            <tr>
              <SortHeader col={USER_COLS[0]} sortKey={uSortKey} sortDir={uSortDir} onSort={uToggle} />
              <SortHeader col={USER_COLS[1]} sortKey={uSortKey} sortDir={uSortDir} onSort={uToggle} />
              <SortHeader col={USER_COLS[2]} sortKey={uSortKey} sortDir={uSortDir} onSort={uToggle} />
              <SortHeader col={USER_COLS[3]} sortKey={uSortKey} sortDir={uSortDir} onSort={uToggle} />
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="muted">{u.email}</td>
                <td>
                  <Toggle checked={Boolean(u.is_admin)} disabled={u.id === user.id} onChange={(on) => patch(u, { isAdmin: on }, on ? `${u.name} is now an admin` : `${u.name} is no longer an admin`)} label={<span className="sr-only">Admin</span>} />
                </td>
                <td>{u.disabled ? <Badge tone="muted">Disabled</Badge> : <Badge tone="ok">Active</Badge>}</td>
                <td className="actions">
                  {u.id !== user.id ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? `${u.name} enabled` : `${u.name} disabled and signed out`)}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const pw = prompt(`New password for ${u.name} (at least 10 characters)`);
                          if (pw) patch(u, { password: pw }, 'Password reset');
                        }}
                      >
                        Reset password
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        onClick={async () => {
                          if (!(await confirm({ title: 'Delete user', message: `Delete ${u.name}? Their runs and answers stay.`, confirmLabel: 'Delete', danger: true }))) return;
                          await api.del(`/api/users/${u.id}`);
                          users.reload(true);
                        }}
                      >
                        Delete
                      </Button>
                    </>
                  ) : (
                    <span className="muted small">you</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Spinner />
      )}
      {adding ? <AddUser onClose={() => setAdding(false)} onAdded={() => users.reload(true)} /> : null}
    </section>
  );
}

function AddUser({ onClose, onAdded }) {
  const [f, setF] = useState({ name: '', email: '', password: '', isAdmin: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <Modal
      title="Add user"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post('/api/users', f);
                onAdded();
                onClose();
              } catch (e) {
                setError(e);
                setBusy(false);
              }
            }}
          >
            Add user
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">{(id) => <input id={id} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Email">{(id) => <input id={id} type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="First password" hint="At least 10 characters. They can change it under their account.">
          {(id) => <input id={id} type="password" className="input" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}
        </Field>
        <Toggle checked={f.isAdmin} onChange={(isAdmin) => setF({ ...f, isAdmin })} label="Admin (can change settings and users)" />
        <Note tone="info">Add them to projects from each project’s team page.</Note>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
