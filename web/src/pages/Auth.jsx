/**
 * Stage 4 — Auth pages
 *
 * Login  – password form + optional "Sign in with Google" button
 * Setup  – first-admin account creation
 * AcceptInvite  – accept an invitation link (new user or signed-in user)
 * ResetPassword – consume a password-reset token from an admin link
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { Button, ErrorNote, Field, Spinner } from '../components/ui.jsx';

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

/** Login page — shows Google button when OIDC is configured. */
export function Login({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [oidcBusy, setOidcBusy] = useState(false);

  // Check if OIDC is configured (public endpoint returns minimal info)
  useEffect(() => {
    api.get('/api/auth/oidc/enabled').then((r) => setOidcEnabled(Boolean(r.enabled))).catch(() => {});
  }, []);

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

  const signInWithGoogle = async () => {
    setOidcBusy(true);
    setError(null);
    try {
      const r = await api.get('/api/auth/oidc/start');
      // Redirect to Google — the callback will come back to the app
      window.location.href = r.url;
    } catch (err) {
      setError(err);
      setOidcBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in">
      {oidcEnabled ? (
        <div className="stack">
          <Button variant="primary" type="button" busy={oidcBusy} onClick={signInWithGoogle} className="btn-google">
            <span aria-hidden="true">G</span> Sign in with Google
          </Button>
          <div className="auth-divider" aria-hidden="true"><span>or</span></div>
        </div>
      ) : null}
      <form onSubmit={submit} className="stack">
        <Field label="Email">{(id) => <input id={id} className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
        <Field label="Password">
          {(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
        </Field>
        <ErrorNote error={error} />
        <Button variant={oidcEnabled ? 'default' : 'primary'} type="submit" busy={busy}>
          Sign in with password
        </Button>
        <p className="muted small">Ask your admin to create an account for you, or send you an invite link.</p>
      </form>
    </AuthFrame>
  );
}

/** First-run admin account creation. */
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

/** Accept-invite page — rendered when user opens an invite link. */
export function AcceptInvite({ token, onDone }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState({ name: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    api.get(`/api/invitations/accept/${token}`)
      .then((r) => { setPreview(r); setLoading(false); })
      .catch((e) => { setLoadError(e); setLoading(false); });
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (preview.newUser && form.password !== form.confirm) {
      setError(new Error('The two passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/invitations/accept/${token}`, {
        name: form.name || undefined,
        password: form.password || undefined,
      });
      setDone(true);
      setTimeout(() => onDone?.(), 1500);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <AuthFrame title="Accepting invite…"><Spinner /></AuthFrame>;
  if (loadError) return <AuthFrame title="Invite link"><ErrorNote error={loadError} /><p className="muted small">The link may have expired or already been used.</p></AuthFrame>;
  if (done) return <AuthFrame title="All set!"><p className="muted">You are in. Redirecting…</p></AuthFrame>;

  return (
    <AuthFrame
      title={preview.newUser ? 'Create your account' : 'Accept invitation'}
      intro={preview.newUser
        ? `You've been invited to Agent Portal${preview.project_name ? ` — ${preview.project_name}` : ''}. Create your account to join.`
        : `Accept the invitation${preview.project_name ? ` to ${preview.project_name}` : ''}.`}
    >
      <form onSubmit={submit} className="stack">
        {preview.newUser ? (
          <>
            <Field label="Your name">{(id) => <input id={id} className="input" value={form.name} onChange={set('name')} required autoComplete="name" autoFocus />}</Field>
            <Field label="Password" hint="At least 10 characters.">
              {(id) => <input id={id} type="password" className="input" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />}
            </Field>
            <Field label="Repeat password">
              {(id) => <input id={id} type="password" className="input" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />}
            </Field>
          </>
        ) : (
          <p className="muted small">Click Accept to link this invitation to your signed-in account ({preview.signedInEmail}).</p>
        )}
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" busy={busy}>
          {preview.newUser ? 'Create account and join' : 'Accept invitation'}
        </Button>
      </form>
    </AuthFrame>
  );
}

/** Reset-password page — user opens a link from admin's copy-paste. */
export function ResetPassword({ token, onDone }) {
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError(new Error('The two passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/reset-password', { token, password: form.password });
      setDone(true);
      setTimeout(() => onDone?.(), 1500);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <AuthFrame title="Password changed"><p className="muted">Password changed. Redirecting to sign-in…</p></AuthFrame>;
  return (
    <AuthFrame title="Set a new password" intro="Choose a new password for your account.">
      <form onSubmit={submit} className="stack">
        <Field label="New password" hint="At least 10 characters.">
          {(id) => <input id={id} type="password" className="input" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" autoFocus />}
        </Field>
        <Field label="Repeat new password">
          {(id) => <input id={id} type="password" className="input" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />}
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" busy={busy}>Change password</Button>
      </form>
    </AuthFrame>
  );
}
