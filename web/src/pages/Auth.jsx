import { useState } from 'react';
import { api } from '../lib/api.js';
import { getTemplate, getActiveTemplateId } from '../lib/theme.js';

/**
 * Centered auth card frame.
 * Uses the active template's brand (product name + logo) so the login and
 * setup screens match whatever template the admin has configured.
 *
 * @param {{ title: string, intro?: string, children: React.ReactNode }} props
 */
function AuthFrame({ title, intro, children }) {
  const tmpl = getTemplate(getActiveTemplateId());
  const productName = tmpl?.brand?.productName || 'Agent Portal';
  const logoSvg     = tmpl?.brand?.logoSvg;
  const logoDataUrl = logoSvg
    ? `data:image/svg+xml,${encodeURIComponent(logoSvg)}`
    : '/favicon.svg';

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          {/* Render logo as <img> data URL — prevents script execution even if sanitiser misses something */}
          <img src={logoDataUrl} alt="" width={28} height={28} />
          <span>{productName}</span>
        </div>
        <h1>{title}</h1>
        {intro && <p className="muted small">{intro}</p>}
        {children}
      </div>
    </div>
  );
}

/**
 * Login form.
 * @param {{ onDone: () => void }} props
 */
export function Login({ onDone, googleEnabled = false }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Google sign-in sends failures back as #/login?error=...
  const hashError = (() => {
    const h = window.location.hash;
    return h.includes('?') ? new URLSearchParams(h.slice(h.indexOf('?') + 1)).get('error') : null;
  })();
  const [error, setError] = useState(/** @type {string|null} */ (hashError));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { email, password });
      onDone();
    } catch (err) {
      setError(err.message || 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in">
      <form onSubmit={submit} className="stack" noValidate>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        {error && (
          <div className="error-note" role="alert">
            {error}
          </div>
        )}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {googleEnabled && (
          <a className="btn" href="/api/auth/google/start" style={{ textAlign: 'center' }}>
            Continue with Google
          </a>
        )}
        <p className="muted small">
          Ask your admin to create an account or send you an invite link.
        </p>
      </form>
    </AuthFrame>
  );
}

/**
 * Accept-invite form: opened from the link an admin shares (#/accept-invite?token=...).
 * Creates the account, then signs the new user in.
 * @param {{ onDone: () => void }} props
 */
export function AcceptInvite({ onDone }) {
  const hash = window.location.hash;
  const token = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '').get('token') || '';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string|null} */ (null));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The invite may already carry an email; if so the server ignores the one typed here.
      await api.post('/api/auth/accept-invite', { token, name, email, password });
      const login = email || undefined;
      if (login) await api.post('/api/auth/login', { email: login, password }).catch(() => {});
      onDone();
    } catch (err) {
      setError(err.message || 'Could not accept the invitation');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthFrame title="Invitation">
        <div className="error-note" role="alert">This invitation link is missing its token. Ask your admin for a new link.</div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Accept invitation" intro="Choose a name and password to create your account.">
      <form onSubmit={submit} className="stack" noValidate>
        <div className="field">
          <label htmlFor="invite-name">Name</label>
          <input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus autoComplete="name" />
        </div>
        <div className="field">
          <label htmlFor="invite-email">Email</label>
          <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </div>
        <div className="field">
          <label htmlFor="invite-password">Password (at least 10 characters)</label>
          <input id="invite-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
        </div>
        {error && <div className="error-note" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthFrame>
  );
}

export { AuthFrame };
