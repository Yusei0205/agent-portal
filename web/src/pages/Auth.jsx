import { useState } from 'react';
import { api } from '../lib/api.js';
import { Button, ErrorNote, Field } from '../components/ui.jsx';

function AuthFrame({ title, intro, children }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/favicon.svg" alt="" width="34" height="34" />
          <span>Agent Portal</span>
        </div>
        <h1>{title}</h1>
        {intro ? <p className="muted">{intro}</p> : null}
        {children}
      </div>
    </div>
  );
}

export function Login({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { email, password });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Sign in">
      <form onSubmit={submit} className="stack">
        <Field label="Email">{(id) => <input id={id} className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
        <Field label="Password">
          {(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" busy={busy}>
          Sign in
        </Button>
        <p className="muted small">Ask your admin to create an account for you.</p>
      </form>
    </AuthFrame>
  );
}

export function Setup({ onDone }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError(new Error('The two passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/setup', { name: form.name, email: form.email, password: form.password });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Create the admin account" intro="This is the first time the portal runs. The account you create here manages settings and users.">
      <form onSubmit={submit} className="stack">
        <Field label="Your name">{(id) => <input id={id} className="input" value={form.name} onChange={set('name')} required autoComplete="name" />}</Field>
        <Field label="Email">{(id) => <input id={id} className="input" type="email" value={form.email} onChange={set('email')} required autoComplete="username" />}</Field>
        <Field label="Password" hint="At least 10 characters.">
          {(id) => <input id={id} className="input" type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />}
        </Field>
        <Field label="Repeat password">{(id) => <input id={id} className="input" type="password" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />}</Field>
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" busy={busy}>
          Create account
        </Button>
      </form>
    </AuthFrame>
  );
}
