/**
 * Stage 4 — Admin panel
 *
 * Full admin UI for:
 *   - Users: list, invite (copy-paste), roles, deactivate/reactivate, reset-password link
 *   - Teams: create, members, project access, budgets
 *   - Google sign-in (OIDC): settings, redirect URI copy, Test button, password login toggle
 *   - SCIM tokens
 *   - Audit log (filters, table)
 *   - Control plane: drain mode, queue / running counts, caps, budget ceilings
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { useLoad, useAction } from '../lib/useAsync.js';
import { cx, money, timeAgo } from '../lib/util.js';
import { useSortable } from '../lib/useSortable.js';
import { SortHeader } from '../components/SortHeader.jsx';
import { Badge, Button, ErrorNote, Field, Modal, Note, PageHeader, Spinner, Toggle, useUi } from '../components/ui.jsx';

// ─── Tabs ────────────────────────────────────────────────────────────────────
const ADMIN_TABS = [
  { value: 'users',    label: 'Users' },
  { value: 'teams',    label: 'Teams' },
  { value: 'google',   label: 'Google sign-in' },
  { value: 'scim',     label: 'SCIM' },
  { value: 'audit',    label: 'Audit log' },
  { value: 'control',  label: 'Control plane' },
];

export function AdminPanel({ initialTab }) {
  const { user } = useApp();
  const [tab, setTab] = useState(initialTab || 'users');
  if (!user?.is_admin) {
    return (
      <div className="page">
        <PageHeader title="Admin" />
        <p className="muted">Only admins can access this page.</p>
      </div>
    );
  }
  return (
    <div className="page">
      <PageHeader title="Admin" sub="Users, teams, sign-in, audit, and control plane." />
      <nav className="tabs" aria-label="Admin sections">
        {ADMIN_TABS.map((t) => (
          <button key={t.value} type="button" className={cx('tab', tab === t.value && 'is-active')} aria-pressed={tab === t.value} onClick={() => setTab(t.value)}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'users'   && <AdminUsers />}
      {tab === 'teams'   && <AdminTeams />}
      {tab === 'google'  && <AdminOidc />}
      {tab === 'scim'    && <AdminScim />}
      {tab === 'audit'   && <AdminAuditLog />}
      {tab === 'control' && <AdminControlPlane />}
    </div>
  );
}

// ─── Users ──────────────────────────────────────────────────────────────────

function AdminUsers() {
  const { user: me } = useApp();
  const { toast, confirm } = useUi();
  const users = useLoad(() => api.get('/api/users'), []);
  const invites = useLoad(() => api.get('/api/invitations'), []);
  const [showInvite, setShowInvite] = useState(false);

  const USER_COLS = [
    { key: 'name',  label: 'Name',   accessor: 'name',  type: 'text' },
    { key: 'email', label: 'Email',  accessor: 'email', type: 'text' },
    { key: 'admin', label: 'Admin',  accessor: (u) => u.is_admin ? 1 : 0, type: 'number' },
    { key: 'status', label: 'Status', accessor: (u) => u.disabled ? 'disabled' : 'active', type: 'status' },
  ];
  const { sorted, sortKey, sortDir, toggle } = useSortable(users.data?.users || [], { columns: USER_COLS, storageKey: 'sort:admin:users' });

  const patch = async (u, body, msg) => {
    try { await api.patch(`/api/users/${u.id}`, body); toast(msg); users.reload(true); }
    catch (e) { toast(e.message, 'danger'); }
  };

  const deactivate = async (u) => {
    if (!(await confirm({ title: 'Deactivate user', message: `Sign out ${u.name} and revoke their sessions? They can be reactivated later.`, confirmLabel: 'Deactivate', danger: true }))) return;
    try { await api.post(`/api/users/${u.id}/deactivate`); toast(`${u.name} deactivated`); users.reload(true); }
    catch (e) { toast(e.message, 'danger'); }
  };

  const reactivate = async (u) => {
    try { await api.post(`/api/users/${u.id}/reactivate`); toast(`${u.name} reactivated`); users.reload(true); }
    catch (e) { toast(e.message, 'danger'); }
  };

  const copyResetLink = async (u) => {
    try {
      const r = await api.post(`/api/users/${u.id}/password-reset-link`);
      const url = `${window.location.origin}/#/reset-password/${r.token}`;
      await navigator.clipboard.writeText(url);
      toast(`Reset link copied — expires in 24 h`);
    } catch (e) { toast(e.message, 'danger'); }
  };

  const deleteUser = async (u) => {
    if (!(await confirm({ title: 'Delete user', message: `Delete ${u.name}? Their runs and answers stay.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.del(`/api/users/${u.id}`); users.reload(true); }
    catch (e) { toast(e.message, 'danger'); }
  };

  return (
    <div className="stack">
      <section className="panel">
        <div className="row between">
          <h2>Users</h2>
          <Button icon="plus" onClick={() => setShowInvite(true)}>Invite user</Button>
        </div>
        {users.loading && !users.data ? <Spinner /> : (
          <table className="table">
            <thead>
              <tr>
                <SortHeader col={USER_COLS[0]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
                <SortHeader col={USER_COLS[1]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
                <SortHeader col={USER_COLS[2]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
                <SortHeader col={USER_COLS[3]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}{u.google_email ? <span className="muted small"> · Google</span> : null}</td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <Toggle
                      checked={Boolean(u.is_admin)}
                      disabled={u.id === me.id}
                      onChange={(on) => patch(u, { isAdmin: on }, on ? `${u.name} is now an admin` : `${u.name} is no longer an admin`)}
                      label={<span className="sr-only">Admin</span>}
                    />
                  </td>
                  <td>{u.disabled ? <Badge tone="muted">Disabled</Badge> : <Badge tone="ok">Active</Badge>}</td>
                  <td className="actions">
                    {u.id !== me.id ? (
                      <>
                        {u.disabled
                          ? <Button size="sm" variant="ghost" onClick={() => reactivate(u)}>Reactivate</Button>
                          : <Button size="sm" variant="ghost" onClick={() => deactivate(u)}>Deactivate</Button>}
                        <Button size="sm" variant="ghost" onClick={() => copyResetLink(u)}>Copy reset link</Button>
                        <Button size="sm" variant="danger-ghost" onClick={() => deleteUser(u)}>Delete</Button>
                      </>
                    ) : <span className="muted small">you</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Pending invitations */}
      <section className="panel">
        <h2>Pending invitations</h2>
        {invites.loading && !invites.data ? <Spinner /> : (
          <InviteList invites={invites.data?.invitations || []} onRevoke={() => invites.reload(true)} />
        )}
      </section>

      {showInvite ? <InviteModal onClose={() => { setShowInvite(false); invites.reload(true); }} /> : null}
    </div>
  );
}

function InviteList({ invites, onRevoke }) {
  const { toast } = useUi();
  const active = invites.filter((i) => !i.used_at && new Date(i.expires_at) > new Date());
  if (!active.length) return <p className="muted small">No pending invitations.</p>;
  return (
    <table className="table compact">
      <thead>
        <tr><th>Email</th><th>Role</th><th>Expires</th><th>Sent by</th><th /></tr>
      </thead>
      <tbody>
        {active.map((inv) => (
          <tr key={inv.token_hash}>
            <td>{inv.email}</td>
            <td>{inv.is_admin ? <Badge tone="accent">Admin</Badge> : <Badge tone="muted">Member</Badge>}</td>
            <td className="muted small">{timeAgo(inv.expires_at)}</td>
            <td className="muted small">{inv.created_by_name}</td>
            <td className="actions">
              <Button size="sm" variant="ghost" onClick={async () => {
                try { await api.del(`/api/invitations/${inv.token_hash}`); toast('Invitation revoked'); onRevoke(); }
                catch (e) { toast(e.message, 'danger'); }
              }}>Revoke</Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InviteModal({ onClose }) {
  const { toast } = useUi();
  const projects = useLoad(() => api.get('/api/projects'), []);
  const [f, setF] = useState({ email: '', isAdmin: false, projectId: '', access: 'editor', expiryDays: 7 });
  const [result, setResult] = useState(null); // { token, link }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/api/invitations', {
        email: f.email,
        portal_role: f.isAdmin ? 'admin' : 'member',
        project_id: f.projectId || undefined,
        project_access: f.projectId ? f.access : undefined,
        expiry_hours: Number(f.expiryDays) * 24,
      });
      const link = `${window.location.origin}/#/accept-invite/${r.token}`;
      setResult({ token: r.token, link });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(result.link);
    toast('Invite link copied to clipboard');
  };

  return (
    <Modal
      title="Invite user"
      onClose={onClose}
      footer={
        result ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={!f.email.trim()} onClick={create}>
              Create invite link
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <Note tone="ok">Invite link created — share it with the user. It expires in {f.expiryDays} days and can only be used once.</Note>
          <div className="row">
            <input className="input mono" readOnly value={result.link} aria-label="Invite link" />
            <Button icon="copy" onClick={copyLink} aria-label="Copy invite link">Copy</Button>
          </div>
          <p className="muted small">The link opens a sign-up page where the user sets their name and password.</p>
        </div>
      ) : (
        <div className="stack">
          <Field label="Email address">
            {(id) => <input id={id} type="email" className="input" value={f.email} onChange={set('email')} required autoFocus />}
          </Field>
          <Field label="Project access (optional)" hint="Leave blank for a portal-only invite.">
            {(id) => (
              <select id={id} className="input" value={f.projectId} onChange={set('projectId')}>
                <option value="">No project (portal member)</option>
                {(projects.data?.projects || []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </Field>
          {f.projectId ? (
            <Field label="Project role">
              {(id) => (
                <select id={id} className="input" value={f.access} onChange={set('access')}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </select>
              )}
            </Field>
          ) : null}
          <Field label="Expires in (days)">
            {(id) => <input id={id} type="number" min={1} max={30} className="input input-num" value={f.expiryDays} onChange={set('expiryDays')} />}
          </Field>
          <Toggle checked={f.isAdmin} onChange={(v) => setF((p) => ({ ...p, isAdmin: v }))} label="Admin access" />
          <ErrorNote error={error} />
        </div>
      )}
    </Modal>
  );
}

// ─── Teams ──────────────────────────────────────────────────────────────────

function AdminTeams() {
  const { toast, confirm } = useUi();
  const teams = useLoad(() => api.get('/api/teams'), []);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack">
      <section className="panel">
        <div className="row between">
          <h2>Teams</h2>
          <Button icon="plus" onClick={() => setCreating(true)}>New team</Button>
        </div>
        {teams.loading && !teams.data ? <Spinner /> : (
          <>
            {(teams.data?.teams || []).length === 0 && <p className="muted small">No teams yet.</p>}
            <div className="conn-grid">
              {(teams.data?.teams || []).map((t) => (
                <article key={t.id} className="panel conn-card">
                  <header className="conn-head">
                    <h3>{t.name}</h3>
                    {t.monthly_budget_usd ? <span className="muted small">${t.monthly_budget_usd}/mo cap</span> : null}
                  </header>
                  <p className="muted small">{t.member_count ?? 0} member{t.member_count === 1 ? '' : 's'}</p>
                  <div className="row tight">
                    <Button size="sm" onClick={() => setSelected(t)}>Manage</Button>
                    <Button size="sm" variant="danger-ghost" onClick={async () => {
                      if (!(await confirm({ title: 'Delete team', message: `Delete team "${t.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
                      try { await api.del(`/api/teams/${t.id}`); toast('Team deleted'); teams.reload(true); }
                      catch (e) { toast(e.message, 'danger'); }
                    }}>Delete</Button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
      {creating ? <TeamForm onClose={() => { setCreating(false); teams.reload(true); }} /> : null}
      {selected ? <TeamEditor team={selected} onClose={() => { setSelected(null); teams.reload(true); }} /> : null}
    </div>
  );
}

function TeamForm({ team, onClose }) {
  const { toast } = useUi();
  const [f, setF] = useState({ name: team?.name || '', monthly_budget_usd: team?.monthly_budget_usd ?? '' });
  const act = useAction();
  const save = () => act.run(async () => {
    const body = { name: f.name, monthly_budget_usd: f.monthly_budget_usd === '' ? null : Number(f.monthly_budget_usd) };
    team ? await api.put(`/api/teams/${team.id}`, body) : await api.post('/api/teams', body);
    toast(team ? 'Team updated' : 'Team created');
    onClose();
  });
  return (
    <Modal title={team ? `Edit ${team.name}` : 'New team'} onClose={onClose} footer={
      <><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={act.busy} disabled={!f.name.trim()} onClick={save}>Save</Button></>
    }>
      <div className="stack">
        <Field label="Team name">{(id) => <input id={id} className="input" value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} autoFocus />}</Field>
        <Field label="Monthly budget cap (USD)" hint="Empty = no separate team cap.">
          {(id) => <input id={id} type="number" min={0} className="input input-num" value={f.monthly_budget_usd} onChange={(e) => setF((p) => ({ ...p, monthly_budget_usd: e.target.value }))} />}
        </Field>
        <ErrorNote error={act.error} />
      </div>
    </Modal>
  );
}

function TeamEditor({ team, onClose }) {
  const { toast } = useUi();
  const detail = useLoad(() => api.get(`/api/teams/${team.id}`), [team.id]);
  const users = useLoad(() => api.get('/api/users'), []);
  const projects = useLoad(() => api.get('/api/projects'), []);
  const [editing, setEditing] = useState(false);
  const t = detail.data?.team || team;
  const members = detail.data?.members || [];
  const teamProjects = detail.data?.projects || [];

  const addMember = async (userId, role) => {
    try { await api.post(`/api/teams/${team.id}/members`, { userId, role }); detail.reload(true); }
    catch (e) { toast(e.message, 'danger'); }
  };
  const removeMember = async (userId) => {
    try { await api.del(`/api/teams/${team.id}/members/${userId}`); detail.reload(true); }
    catch (e) { toast(e.message, 'danger'); }
  };
  const addProject = async (projectId, access) => {
    try { await api.post(`/api/teams/${team.id}/projects`, { projectId, access }); detail.reload(true); }
    catch (e) { toast(e.message, 'danger'); }
  };
  const removeProject = async (projectId) => {
    try { await api.del(`/api/teams/${team.id}/projects/${projectId}`); detail.reload(true); }
    catch (e) { toast(e.message, 'danger'); }
  };

  return (
    <Modal wide title={`Team: ${t.name}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        {editing ? <TeamForm team={t} onClose={() => { setEditing(false); detail.reload(true); }} /> : (
          <div className="row between">
            <span className="muted small">{t.monthly_budget_usd ? `Monthly cap: $${t.monthly_budget_usd}` : 'No budget cap'}</span>
            <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
          </div>
        )}

        <h3>Members</h3>
        {members.length ? (
          <table className="table compact">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id}>
                  <td>{m.name}</td>
                  <td className="muted">{m.email}</td>
                  <td><Badge tone={m.role === 'maintainer' ? 'accent' : 'muted'}>{m.role}</Badge></td>
                  <td><Button size="sm" variant="ghost" onClick={() => removeMember(m.user_id)}>Remove</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted small">No members.</p>}
        <AddMemberRow users={users.data?.users || []} existing={members.map((m) => m.user_id)} onAdd={addMember} />

        <h3>Project access</h3>
        {teamProjects.length ? (
          <table className="table compact">
            <thead><tr><th>Project</th><th>Access</th><th /></tr></thead>
            <tbody>
              {teamProjects.map((p) => (
                <tr key={p.project_id}>
                  <td>{p.project_name}</td>
                  <td><Badge tone="muted">{p.access}</Badge></td>
                  <td><Button size="sm" variant="ghost" onClick={() => removeProject(p.project_id)}>Remove</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted small">No projects.</p>}
        <AddProjectRow projects={projects.data?.projects || []} existing={teamProjects.map((p) => p.project_id)} onAdd={addProject} />
      </div>
    </Modal>
  );
}

function AddMemberRow({ users, existing, onAdd }) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('member');
  const available = users.filter((u) => !existing.includes(u.id));
  return (
    <div className="row tight wrap">
      <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Add member">
        <option value="">Add member…</option>
        {available.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
      </select>
      <select className="input" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Member role">
        <option value="member">Member</option>
        <option value="maintainer">Maintainer</option>
      </select>
      <Button size="sm" disabled={!userId} onClick={() => { onAdd(userId, role); setUserId(''); }}>Add</Button>
    </div>
  );
}

function AddProjectRow({ projects, existing, onAdd }) {
  const [projectId, setProjectId] = useState('');
  const [access, setAccess] = useState('editor');
  const available = projects.filter((p) => !existing.includes(p.id));
  return (
    <div className="row tight wrap">
      <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Add project">
        <option value="">Add project…</option>
        {available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select className="input" value={access} onChange={(e) => setAccess(e.target.value)} aria-label="Access level">
        <option value="viewer">Viewer</option>
        <option value="editor">Editor</option>
        <option value="owner">Owner</option>
      </select>
      <Button size="sm" disabled={!projectId} onClick={() => { onAdd(projectId, access); setProjectId(''); }}>Add</Button>
    </div>
  );
}

// ─── Google OIDC ──────────────────────────────────────────────────────────────

function AdminOidc() {
  const { toast } = useUi();
  const settings = useLoad(() => api.get('/api/admin/oidc'), []);
  const [f, setF] = useState(null);
  const [clientSecret, setClientSecret] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const act = useAction();

  useEffect(() => {
    if (settings.data) {
      setF({
        enabled: settings.data.enabled ?? false,
        clientId: settings.data.clientId ?? '',
        hostedDomain: settings.data.hostedDomain ?? '',
        adminEmails: (settings.data.adminEmails ?? []).join('\n'),
        allowedDomains: (settings.data.allowedDomains ?? []).join('\n'),
        disablePasswordLogin: settings.data.disablePasswordLogin ?? false,
      });
    }
  }, [settings.data]);

  const redirectUri = `${window.location.origin}/api/auth/oidc/callback`;

  const save = () => act.run(async () => {
    await api.put('/api/admin/oidc', {
      ...f,
      adminEmails: f.adminEmails.split('\n').map((s) => s.trim()).filter(Boolean),
      allowedDomains: f.allowedDomains.split('\n').map((s) => s.trim()).filter(Boolean),
      clientSecret: clientSecret || undefined,
    });
    toast('Google sign-in settings saved');
    setClientSecret('');
    settings.reload(true);
  });

  const testOidc = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.get('/api/auth/oidc/start');
      setTestResult({ ok: true, message: `OIDC start URL generated. Open: ${r.url?.slice(0, 80)}…` });
    } catch (e) {
      setTestResult({ ok: false, message: e.message });
    } finally {
      setTesting(false);
    }
  };

  if (settings.loading && !settings.data) return <Spinner />;
  if (settings.error) return <ErrorNote error={settings.error} />;
  if (!f) return <Spinner />;

  return (
    <div className="stack">
      <section className="panel">
        <h2>Google sign-in (OIDC)</h2>
        <p className="muted small">
          Allow users to sign in with their Google Workspace account. You need a Google Cloud OAuth 2.0 client ID and secret (Web application type).
        </p>
        <div className="stack">
          <Toggle
            checked={f.enabled}
            onChange={(v) => setF((p) => ({ ...p, enabled: v }))}
            label="Enable Google sign-in"
          />

          <Field label="Authorised redirect URI" hint="Copy this into your Google Cloud OAuth client's authorised redirect URIs.">
            {(id) => (
              <div className="row tight">
                <input id={id} className="input mono" readOnly value={redirectUri} aria-label="Redirect URI" />
                <Button size="sm" icon="copy" onClick={async () => { await navigator.clipboard.writeText(redirectUri); toast('Copied'); }} aria-label="Copy redirect URI">Copy</Button>
              </div>
            )}
          </Field>

          <Field label="Google OAuth Client ID">
            {(id) => <input id={id} className="input mono" value={f.clientId} onChange={(e) => setF((p) => ({ ...p, clientId: e.target.value.trim() }))} placeholder="1234567890-xxx.apps.googleusercontent.com" />}
          </Field>

          <Field label="Google OAuth Client secret" hint={settings.data?.clientSecretSet ? 'Secret already saved. Paste a new value to replace it.' : 'Paste the client secret here — stored encrypted, never shown again.'}>
            {(id) => (
              <div className="row tight">
                {settings.data?.clientSecretSet ? <Badge tone="ok">Saved</Badge> : <Badge tone="muted">Not set</Badge>}
                <input id={id} type="password" className="input mono" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" placeholder="GOCSPX-…" />
              </div>
            )}
          </Field>

          <Field label="Allowed Google Workspace domains (one per line)" hint="Leave blank to allow any Google account. Add your domain (e.g. company.com) to restrict to your org.">
            {(id) => <textarea id={id} className="input mono" rows={3} value={f.allowedDomains} onChange={(e) => setF((p) => ({ ...p, allowedDomains: e.target.value }))} placeholder="company.com" />}
          </Field>

          <Field label="Auto-promote to admin (emails, one per line)" hint="Users signing in with these emails become admins automatically on first login.">
            {(id) => <textarea id={id} className="input mono" rows={3} value={f.adminEmails} onChange={(e) => setF((p) => ({ ...p, adminEmails: e.target.value }))} placeholder="admin@company.com" />}
          </Field>

          <Toggle
            checked={f.disablePasswordLogin}
            onChange={(v) => setF((p) => ({ ...p, disablePasswordLogin: v }))}
            label="Disable password login (Google only) — DANGER: don't enable this before at least one Google user has signed in"
            disabled={!f.enabled}
          />

          <ErrorNote error={act.error} />
          <div className="row">
            <Button variant="primary" busy={act.busy} onClick={save}>Save settings</Button>
            <Button busy={testing} onClick={testOidc} disabled={!f.enabled || !f.clientId}>Test OIDC</Button>
          </div>
          {testResult ? (
            testResult.ok
              ? <p className="ok small">{testResult.message}</p>
              : <p className="danger small">{testResult.message}</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

// ─── SCIM tokens ──────────────────────────────────────────────────────────────

function AdminScim() {
  const { toast, confirm } = useUi();
  const tokens = useLoad(() => api.get('/api/admin/scim-tokens'), []);
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState(null);

  const create = async () => {
    try {
      const r = await api.post('/api/admin/scim-tokens');
      setNewToken(r.token);
      tokens.reload(true);
    } catch (e) { toast(e.message, 'danger'); }
  };

  const revoke = async (id, hint) => {
    if (!(await confirm({ title: 'Revoke SCIM token', message: `Revoke token ${hint}? Your IdP will stop being able to provision users.`, confirmLabel: 'Revoke', danger: true }))) return;
    try { await api.del(`/api/admin/scim-tokens/${id}`); toast('Token revoked'); tokens.reload(true); }
    catch (e) { toast(e.message, 'danger'); }
  };

  const scimBase = `${window.location.origin}/scim/v2`;

  return (
    <div className="stack">
      <section className="panel">
        <h2>SCIM 2.0 provisioning</h2>
        <p className="muted small">
          Use SCIM to automatically provision and deprovision users from your IdP (Okta, Entra ID, Google Workspace).
        </p>
        <Field label="SCIM base URL" hint="Copy this into your IdP's SCIM configuration.">
          {(id) => (
            <div className="row tight">
              <input id={id} className="input mono" readOnly value={scimBase} aria-label="SCIM base URL" />
              <Button size="sm" icon="copy" onClick={async () => { await navigator.clipboard.writeText(scimBase); toast('Copied'); }} aria-label="Copy SCIM URL">Copy</Button>
            </div>
          )}
        </Field>
        <div className="row between" style={{ marginTop: '1rem' }}>
          <h3>Bearer tokens</h3>
          <Button size="sm" icon="plus" onClick={create}>New token</Button>
        </div>
        {newToken ? (
          <Note tone="ok">
            New token (copy now — shown once only):{' '}
            <div className="row tight">
              <code className="mono">{newToken}</code>
              <Button size="sm" icon="copy" onClick={async () => { await navigator.clipboard.writeText(newToken); toast('Copied'); }} aria-label="Copy token">Copy</Button>
            </div>
          </Note>
        ) : null}
        {tokens.loading && !tokens.data ? <Spinner /> : (
          <table className="table compact">
            <thead><tr><th>Token</th><th>Created</th><th /></tr></thead>
            <tbody>
              {(tokens.data?.tokens || []).map((t) => (
                <tr key={t.id}>
                  <td className="mono muted">{t.hint}</td>
                  <td className="muted small">{timeAgo(t.created_at)}</td>
                  <td><Button size="sm" variant="danger-ghost" onClick={() => revoke(t.id, t.hint)}>Revoke</Button></td>
                </tr>
              ))}
              {!(tokens.data?.tokens || []).length && <tr><td colSpan={3} className="muted small">No tokens yet.</td></tr>}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ─── Audit log ──────────────────────────────────────────────────────────────

function AdminAuditLog() {
  const [filters, setFilters] = useState({ actor: '', action: '', limit: 100 });
  const log = useLoad(() => api.get(`/api/admin/audit-log?limit=${filters.limit}${filters.actor ? `&actor=${encodeURIComponent(filters.actor)}` : ''}${filters.action ? `&action=${encodeURIComponent(filters.action)}` : ''}`), [filters]);

  const exportCsv = () => {
    const rows = log.data?.entries || [];
    const csv = ['ts,actor,action,target,ip', ...rows.map((r) => [r.ts, r.actor_name || r.actor_id || '', r.action, r.target || '', r.ip || ''].map((v) => JSON.stringify(v)).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'audit-log.csv';
    a.click();
  };

  return (
    <div className="stack">
      <section className="panel">
        <div className="row between">
          <h2>Audit log</h2>
          <Button size="sm" onClick={exportCsv} disabled={!log.data?.entries?.length}>Export CSV</Button>
        </div>
        <div className="row wrap tight">
          <Field label="Filter by actor (email)" inline>
            {(id) => <input id={id} className="input input-md" value={filters.actor} onChange={(e) => setFilters((f) => ({ ...f, actor: e.target.value }))} placeholder="user@example.com" />}
          </Field>
          <Field label="Filter by action" inline>
            {(id) => <input id={id} className="input input-md" value={filters.action} onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))} placeholder="user.deactivate" />}
          </Field>
          <Field label="Max rows" inline>
            {(id) => (
              <select id={id} className="input" value={filters.limit} onChange={(e) => setFilters((f) => ({ ...f, limit: Number(e.target.value) }))}>
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={500}>500</option>
              </select>
            )}
          </Field>
          <Button size="sm" onClick={() => log.reload(true)}>Refresh</Button>
        </div>
        {log.loading && !log.data ? <Spinner /> : log.error ? <ErrorNote error={log.error} /> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table compact">
              <thead>
                <tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th></tr>
              </thead>
              <tbody>
                {(log.data?.entries || []).map((e) => (
                  <tr key={e.id}>
                    <td className="mono small muted" style={{ whiteSpace: 'nowrap' }}>{new Date(e.ts).toLocaleString()}</td>
                    <td className="muted small">{e.actor_name || e.actor_id || '—'}</td>
                    <td className="mono small">{e.action}</td>
                    <td className="muted small">{e.target || '—'}</td>
                    <td className="mono small muted">{e.ip || '—'}</td>
                  </tr>
                ))}
                {!(log.data?.entries || []).length && <tr><td colSpan={5} className="muted small">No entries.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Control plane ──────────────────────────────────────────────────────────

function AdminControlPlane() {
  const { toast } = useUi();
  const status = useLoad(() => api.get('/api/admin/control-plane'), []);
  const settings = useLoad(() => api.get('/api/settings'), []);
  const act = useAction();

  const toggleDrain = async (on) => {
    try {
      await api.post('/api/admin/drain', { enable: on });
      toast(on ? 'Drain mode on — no new sessions will start' : 'Drain mode off — sessions can start again');
      status.reload(true);
    } catch (e) { toast(e.message, 'danger'); }
  };

  const s = status.data || {};
  const set = settings.data || {};

  return (
    <div className="stack">
      <section className="panel">
        <h2>Control plane</h2>
        {status.loading && !status.data ? <Spinner /> : status.error ? (
          <p className="muted small">Control status not available ({status.error.message})</p>
        ) : (
          <div className="stack">
            <div className="row tight wrap">
              <div className="kv-item">
                <dt>Running sessions</dt>
                <dd><strong>{s.sessions?.running ?? '—'}</strong></dd>
              </div>
              <div className="kv-item">
                <dt>Queued</dt>
                <dd><strong>{s.sessions?.queued ?? '—'}</strong></dd>
              </div>
              <div className="kv-item">
                <dt>Pending approvals</dt>
                <dd><strong>{s.approvals?.pending ?? '—'}</strong></dd>
              </div>
            </div>

            <Toggle
              checked={Boolean(s.drain?.active)}
              onChange={toggleDrain}
              label={s.drain?.active ? 'Drain mode is ON — no new sessions will start until you turn this off' : 'Drain mode — turn on to pause new sessions gracefully'}
            />
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Budget ceilings</h2>
        <p className="muted small">Per-level caps that stop sessions when exceeded. All amounts are in USD.</p>
        <table className="table compact">
          <thead><tr><th>Level</th><th>Cap</th><th>This month</th></tr></thead>
          <tbody>
            <tr>
              <td>Portal total</td>
              <td>{set.budget?.monthlyUsd ? `$${set.budget.monthlyUsd}` : <span className="muted">No cap</span>}</td>
              <td className="muted">{set.usage?.monthUsd != null ? money(set.usage.monthUsd, 2) : '—'}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted small">Per-user and per-project caps are set on each user/project page.</p>
      </section>

      <section className="panel">
        <h2>Concurrency caps</h2>
        <p className="muted small">From Settings › Agent defaults.</p>
        <table className="table compact">
          <thead><tr><th>Setting</th><th>Value</th></tr></thead>
          <tbody>
            <tr><td>Max sessions per user</td><td>{set.agents?.maxTopLevelPerUser ?? '5 (default)'}</td></tr>
            <tr><td>Max turns per run</td><td>{set.agents?.maxTurns ?? 50}</td></tr>
          </tbody>
        </table>
        <a className="btn btn-sm btn-ghost" href="#/settings">Edit in Settings</a>
      </section>
    </div>
  );
}
