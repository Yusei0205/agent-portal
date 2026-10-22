/**
 * Stage 4 — Profile page
 *
 * Own usage summary, API tokens (own + scoped), name change.
 * Also shown as the #/account tab.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { useLoad, useAction } from '../lib/useAsync.js';
import { money, timeAgo } from '../lib/util.js';
import { Badge, Button, ErrorNote, Field, PageHeader, Segmented, Spinner, useUi } from '../components/ui.jsx';
import { getFx, getTheme, setFx, setTheme } from '../lib/theme.js';

export function Profile() {
  const { user, reloadMeta } = useApp();
  const { toast } = useUi();
  const usage = useLoad(() => api.get('/api/usage/me'), []);
  const profile = useLoad(() => api.get('/api/profile'), []);
  const [form, setForm] = useState({ name: '', current: '', password: '', confirm: '' });
  const [look, setLook] = useState({ theme: getTheme(), fx: getFx() });
  const act = useAction();

  useEffect(() => {
    if (profile.data) setForm((f) => ({ ...f, name: profile.data.name || '' }));
  }, [profile.data]);

  const saveName = () => act.run(async () => {
    await api.patch('/api/profile', { name: form.name });
    toast('Name updated');
    profile.reload(true);
    reloadMeta();
  });

  const changePassword = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirm) { toast('The two new passwords do not match', 'danger'); return; }
    try {
      await api.post('/api/auth/password', { current: form.current, password: form.password });
      setForm((f) => ({ ...f, current: '', password: '', confirm: '' }));
      toast('Password changed');
    } catch (err) { toast(err.message, 'danger'); }
  };

  const u = usage.data;

  return (
    <div className="page narrow">
      <PageHeader title="Your account" sub={`Signed in as ${user.name} (${user.email})`} />

      {/* Usage */}
      <section className="panel">
        <h2>Usage this month</h2>
        {usage.loading && !u ? <Spinner /> : u ? (
          <>
            <p className="lead-num">{money(u.month_usd ?? 0, 2)} <span className="muted">this month</span></p>
            {u.by_project?.length ? (
              <table className="table compact">
                <thead><tr><th>Project</th><th className="num">Runs</th><th className="num">Spend</th></tr></thead>
                <tbody>
                  {u.by_project.map((p) => (
                    <tr key={p.project_id}>
                      <td>{p.project_name}</td>
                      <td className="num">{p.runs}</td>
                      <td className="num">{money(p.usd, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted small">No runs this month.</p>}
          </>
        ) : null}
      </section>

      {/* Appearance */}
      <section className="panel">
        <h2>Appearance</h2>
        <div className="stack">
          <Field label="Look" hint="HUD is the futuristic console. Standard follows your system's light or dark mode.">
            {() => (
              <Segmented
                value={look.theme}
                onChange={(v) => { setTheme(v); setLook({ ...look, theme: v }); }}
                label="Look"
                options={[{ value: 'hud', label: 'HUD' }, { value: 'standard', label: 'Standard' }]}
              />
            )}
          </Field>
          <Field label="Effects" hint="Full adds the moving grid, scan line, glows and entrance animations.">
            {() => (
              <Segmented
                value={look.fx}
                onChange={(v) => { setFx(v); setLook({ ...look, fx: v }); }}
                label="Effects"
                options={[{ value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }]}
              />
            )}
          </Field>
        </div>
      </section>

      {/* Name */}
      <section className="panel">
        <h2>Display name</h2>
        <div className="row tight">
          <Field label="Name">
            {(id) => <input id={id} className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}
          </Field>
          <Button variant="primary" busy={act.busy} disabled={form.name === (profile.data?.name || '')} onClick={saveName} style={{ alignSelf: 'flex-end' }}>
            Save
          </Button>
        </div>
        <ErrorNote error={act.error} />
      </section>

      {/* Password */}
      {!user.google_sub ? (
        <section className="panel">
          <h2>Change password</h2>
          <form className="stack" onSubmit={changePassword} noValidate>
            <Field label="Current password">{(id) => <input id={id} type="password" className="input" autoComplete="current-password" value={form.current} onChange={(e) => setForm((f) => ({ ...f, current: e.target.value }))} required />}</Field>
            <Field label="New password" hint="At least 10 characters.">{(id) => <input id={id} type="password" className="input" autoComplete="new-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required minLength={10} />}</Field>
            <Field label="Repeat new password">{(id) => <input id={id} type="password" className="input" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))} required />}</Field>
            <div className="row">
              <Button type="submit" variant="primary">Change password</Button>
            </div>
          </form>
        </section>
      ) : (
        <section className="panel">
          <h2>Sign-in method</h2>
          <p className="muted small">You signed in with Google ({user.email}). Password login is disabled for your account.</p>
        </section>
      )}
    </div>
  );
}
