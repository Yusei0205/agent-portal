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

/** The sessions strip on the sign-in page: a few example sessions and a typed command. */
const DEMO_SESSIONS = [
  { engine: 'Kiro', repo: 'payments-api', task: 'add the refund cancel endpoint', state: 'running' },
  { engine: 'Claude', repo: 'web-checkout', task: 'fix the flaky e2e total', state: 'done' },
  { engine: 'Kiro', repo: 'ledger-service', task: 'rotate the signing secrets', state: 'queued' },
];

/**
 * Sign-in page: product pitch on the left, sign-in card on the right.
 * Google is the main route when it is set up; email and password stay available below it.
 * @param {{ onDone: () => void }} props
 */
export function Login({ onDone, googleEnabled = false }) {
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
  const [error, setError] = useState(/** @type {string|null} */ (hashError));
  // With Google on, the password form is folded away until asked for.
  const [showPassword, setShowPassword] = useState(!googleEnabled);

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
    <div className="login-split">
      <section className="login-hero" aria-label={`About ${productName}`}>
        <div className="login-brand">
          <img src={logoDataUrl} alt="" width={36} height={36} />
          <span>{productName}</span>
        </div>

        <div className="login-pitch">
          <p className="login-eyebrow">Kiro and Claude Code, in the cloud</p>
          <h1 className="login-headline">
            Hand the work to agents.
            <br />
            <span className="login-accent">Watch</span> it ship.
          </h1>
          <p className="login-lede">
            Start a session over your repositories, follow every tool call as it runs, then push the
            branch and open the pull request without leaving the browser.
          </p>
        </div>

        <div className="login-term" aria-hidden="true">
          <div className="login-term-bar">
            <span /><span /><span />
            <em>sessions</em>
          </div>
          <ul>
            {DEMO_SESSIONS.map((r) => (
              <li key={r.repo}>
                <i className={`login-dot is-${r.state}`} />
                <b className={r.engine === 'Kiro' ? 'is-kiro' : 'is-claude'}>{r.engine}</b>
                <span className="login-repo">{r.repo}</span>
                <span className="login-task">{r.task}</span>
                <span className="login-state">{r.state}</span>
              </li>
            ))}
          </ul>
          <div className="login-prompt">
            <span>&gt;</span> <span className="login-typed">open a pull request for payments-api</span>
            <span className="login-caret" />
          </div>
        </div>
      </section>

      <section className="login-side">
        <div className="login-card">
          <h2>Sign in</h2>
          <p className="login-card-intro">
            {googleEnabled
              ? `${productName} runs coding agents with a shell in the cloud and can push to your repositories, so it admits only approved Google accounts.`
              : `${productName} runs coding agents with a shell in the cloud and can push to your repositories, so it admits only approved accounts.`}
          </p>

          {error && <div className="error-note" role="alert">{error}</div>}

          {googleEnabled && (
            <a className="login-google" href="/api/auth/google/start">
              <span className="login-google-g"><GoogleMark /></span>
              <span>Sign in with Google</span>
            </a>
          )}

          {googleEnabled && !showPassword && (
            <button type="button" className="login-alt" onClick={() => setShowPassword(true)}>
              Use email and password instead
            </button>
          )}

          {showPassword && (
            <form onSubmit={submit} className="login-form" noValidate>
              {googleEnabled && <div className="login-or"><span>or with email</span></div>}
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
              <p className="muted small">Ask your admin to create an account or send you an invite link.</p>
            </form>
          )}

          <div className="login-note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <span>
              Your session is kept in a secure cookie that page scripts cannot read. Nothing is saved
              to this browser&apos;s storage.
            </span>
          </div>
        </div>
      </section>
    </div>
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
