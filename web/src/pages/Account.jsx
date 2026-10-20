import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { Button, ErrorNote, Field, PageHeader, Segmented, useUi } from '../components/ui.jsx';
import { useAction } from '../lib/useAsync.js';
import { getFx, getTheme, setFx, setTheme } from '../lib/theme.js';

export function Account() {
  const { user } = useApp();
  const { toast } = useUi();
  const [form, setForm] = useState({ current: '', password: '', confirm: '' });
  const act = useAction();
  const [look, setLook] = useState({ theme: getTheme(), fx: getFx() });
  return (
    <div className="page narrow">
      <PageHeader title="Your account" sub={`Signed in as ${user.name} (${user.email})`} />
      <section className="panel">
        <h2>Appearance</h2>
        <div className="stack">
          <Field label="Look" hint="HUD is the futuristic console. Standard is the quiet workbench and follows your system's light or dark mode.">
            {() => (
              <Segmented
                value={look.theme}
                onChange={(v) => {
                  setTheme(v);
                  setLook({ ...look, theme: v });
                }}
                label="Look"
                options={[
                  { value: 'hud', label: 'HUD' },
                  { value: 'standard', label: 'Standard' },
                ]}
              />
            )}
          </Field>
          <Field label="Effects" hint="Full adds the moving grid, scan line, glows and entrance animations. Reduced keeps the colours and turns the decoration off. Your system's reduced-motion setting always wins.">
            {() => (
              <Segmented
                value={look.fx}
                onChange={(v) => {
                  setFx(v);
                  setLook({ ...look, fx: v });
                }}
                label="Effects"
                options={[
                  { value: 'full', label: 'Full' },
                  { value: 'reduced', label: 'Reduced' },
                ]}
              />
            )}
          </Field>
        </div>
      </section>
      <section className="panel">
        <h2>Change password</h2>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            act.run(async () => {
              if (form.password !== form.confirm) throw new Error('The two new passwords do not match');
              await api.post('/api/auth/password', { current: form.current, password: form.password });
              setForm({ current: '', password: '', confirm: '' });
              toast('Password changed');
            });
          }}
        >
          <Field label="Current password">{(id) => <input id={id} type="password" className="input" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required />}</Field>
          <Field label="New password" hint="At least 10 characters.">{(id) => <input id={id} type="password" className="input" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={10} />}</Field>
          <Field label="Repeat new password">{(id) => <input id={id} type="password" className="input" autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required />}</Field>
          <ErrorNote error={act.error} />
          <div className="row">
            <Button type="submit" variant="primary" busy={act.busy}>
              Change password
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
