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

function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** What the portal does, shown as three short steps under the sign-in card. */
const LOGIN_STEPS = [
  { n: '1', title: 'Describe the work', text: 'Pick repositories and tell an agent what to do.' },
  { n: '2', title: 'Watch it run', text: 'Follow every command and edit live, step in when needed.' },
  { n: '3', title: 'Review and merge', text: 'Push the branch and open the pull request from the browser.' },
];

/**
 * Sign-in page: one centred card on a soft gradient, with the three steps beneath it.
 * Google is the main route when it is set up; email and password stay available below it.
 * @param {{ onDone: () => void }} props
 */
export function Login({ onDone, googleEnabled = false, expired = false }) {
  const tmpl = getTemplate(getActiveTemplateId());
  const productName = tmpl?.brand?.productName || 'Agent Portal';
  const logoSvg = tmpl?.brand?.logoSvg;
  const logoDataUrl = logoSvg ? `data:image/svg+xml,${encodeURIComponent(logoSvg)}` : '/favicon.svg';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Google sign-in sends failures back as #/login?error=...
  const hashError = (() => {
    const h = window.location.hash;
    return h.includes('?') ? new URLSearchParams(h.slice(h.indexOf('?') + 1)).get('error') : null;
  })();
  const [error, setError] = useState(/** @type {string|null} */ (hashError ?? (expired ? 'Your session ended because you were away for a while. Sign in again to continue.' : null)));
  // With Google on, the password form is folded away until asked for.
  const [showPassword, setShowPassword] = useState(!googleEnabled);
  const [forgot, setForgot] = useState(false);

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
    <main className="login-page">
      <div className="login-aurora" aria-hidden="true" />

      <div className="login-center">
        <div className="login-mark">
          <img src={logoDataUrl} alt="" width={44} height={44} />
          <span>{productName}</span>
        </div>
        <h1 className="login-title">
          Your coding agents,<br />
          <span className="login-accent">working in the cloud.</span>
        </h1>

        <div className="login-card">
          <h2>Welcome back</h2>
          <p className="login-card-intro">
            {googleEnabled
              ? 'Sign in with an approved Google account to start.'
              : 'Sign in with your email and password to start.'}
          </p>

          {error && <div className="error-note" role="alert">{error}</div>}

          {googleEnabled && (
            <a className="login-google" href="/api/auth/google/start">
              <GoogleMark />
              <span>Continue with Google</span>
            </a>
          )}

          {googleEnabled && !showPassword && (
            <button type="button" className="login-alt" onClick={() => setShowPassword(true)}>
              Use email and password instead
            </button>
          )}

          {showPassword && (
            <form onSubmit={submit} className="login-form" noValidate>
              {googleEnabled && <div className="login-or"><span>or</span></div>}
              <div className="field">
                <label htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                  autoFocus={!googleEnabled}
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
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <button type="button" className="login-alt" onClick={() => setForgot((v) => !v)} aria-expanded={forgot}>
                Forgot password?
              </button>
              {forgot && (
                <p className="muted small" role="status">
                  Ask your portal admin for a reset link: they open Settings › Users, press “Reset password” next to your name and send you the link.
                  It works once and expires after an hour. If you only ever signed in with Google, use “Continue with Google”.
                </p>
              )}
              <p className="muted small">Ask your admin to create an account or send you an invite link.</p>
            </form>
          )}

          <p className="login-note">
            Agents here run commands and can push to your repositories, so access is limited to
            approved accounts.
          </p>
        </div>

        <ol className="login-steps">
          {LOGIN_STEPS.map((st) => (
            <li key={st.n}>
              <span className="login-step-n">{st.n}</span>
              <div>
                <strong>{st.title}</strong>
                <span>{st.text}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </main>
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

/**
 * Reset-password form: opened from the one-time link an admin issues (#/reset-password?token=...).
 * @param {{ onDone: () => void }} props
 */
export function ResetPassword({ onDone }) {
  const hash = window.location.hash;
  const token = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '').get('token') || '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const [email, setEmail] = useState(/** @type {string|null} */ (null));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (password.length < 10) { setError('Password must be at least 10 characters'); return; }
    if (password !== again) { setError('The two passwords do not match'); return; }
    setBusy(true);
    try {
      const r = await api.post('/api/auth/reset-password', { token, password });
      setEmail(r.email || '');
    } catch (err) {
      setError(err.message || 'Could not reset the password');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthFrame title="Reset password">
        <div className="error-note" role="alert">This link is missing its token. Ask your admin for a new one.</div>
      </AuthFrame>
    );
  }

  if (email !== null) {
    return (
      <AuthFrame title="Password changed" intro={email ? `You can now sign in as ${email} with the new password.` : 'You can now sign in with the new password.'}>
        <button type="button" className="btn btn-primary" onClick={onDone}>Go to sign in</button>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Choose a new password" intro="This link works once and expires an hour after your admin made it.">
      <form onSubmit={submit} className="stack" noValidate>
        <div className="field">
          <label htmlFor="reset-password">New password (at least 10 characters)</label>
          <input id="reset-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="new-password" />
        </div>
        <div className="field">
          <label htmlFor="reset-again">Repeat the new password</label>
          <input id="reset-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} required autoComplete="new-password" />
        </div>
        {error && <div className="error-note" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </AuthFrame>
  );
}

export { AuthFrame };
