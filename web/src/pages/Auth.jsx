import { useState } from 'react';
import { api } from '../lib/api.js';

/**
 * Centered auth card frame.
 * @param {{ title: string, intro?: string, children: React.ReactNode }} props
 */
function AuthFrame({ title, intro, children }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>Agent Portal</span>
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
export function Login({ onDone }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string|null} */ (null));

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
        <p className="muted small">
          Ask your admin to create an account or send you an invite link.
        </p>
      </form>
    </AuthFrame>
  );
}

export { AuthFrame };
