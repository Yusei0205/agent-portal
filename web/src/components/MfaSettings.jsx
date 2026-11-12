/**
 * Two-step sign-in with an authenticator app, on the Account page: turn it on (secret, confirm a code, save recovery
 * codes) and turn it off. Needs the password (the page asks for it) like other sensitive changes.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export function MfaSettings() {
  const [status, setStatus] = useState(/** @type {null | {available: boolean, enabled: boolean, recoveryLeft: number}} */ (null));
  const [setup, setSetup] = useState(/** @type {null | {secret: string, otpauthUrl: string}} */ (null));
  const [recovery, setRecovery] = useState(/** @type {string[]|null} */ (null));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(/** @type {null | {ok: boolean, text: string}} */ (null));

  const load = useCallback(async () => {
    try { setStatus(await api.get('/api/auth/mfa')); } catch { setStatus(null); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true);
    setMsg(null);
    try { await fn(); } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : 'Something went wrong' }); } finally { setBusy(false); }
  };

  const start = () => run(async () => {
    setSetup(await api.post('/api/auth/mfa/setup', {}));
    setCode('');
  });
  const enable = (e) => {
    e.preventDefault();
    return run(async () => {
      const r = await api.post('/api/auth/mfa/enable', { code });
      setRecovery(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await load();
    });
  };
  const disable = (e) => {
    e.preventDefault();
    return run(async () => {
      await api.post('/api/auth/mfa/disable', { code });
      setCode('');
      setMsg({ ok: true, text: 'Two-step sign-in is off.' });
      await load();
    });
  };

  if (!status) return null;
  return (
    <section className="panel stack" aria-labelledby="acct-mfa">
      <h2 id="acct-mfa">Two-step sign-in</h2>
      {!status.available && <p className="muted small">Your account signs in with Google, which has its own second step.</p>}

      {status.available && !status.enabled && !setup && !recovery && (
        <>
          <p className="muted small">Ask for a code from an authenticator app (Google Authenticator, 1Password, Authy…) after your password. A stolen password is then not enough to get in.</p>
          <div><button type="button" className="btn btn-primary" onClick={start} disabled={busy}>Set up</button></div>
        </>
      )}

      {setup && (
        <form onSubmit={enable} className="stack">
          <p className="small">1. In your authenticator app choose “enter a setup key” and type this key (account: your email, type: time-based):</p>
          <p><code style={{ fontSize: '1.05rem', letterSpacing: '0.08em', userSelect: 'all' }}>{setup.secret}</code></p>
          <p className="muted small">Or paste this link into an app that reads it: <code style={{ wordBreak: 'break-all', userSelect: 'all' }}>{setup.otpauthUrl}</code></p>
          <div className="field">
            <label htmlFor="mfa-code">2. Enter the 6-digit code the app shows</label>
            <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={busy || !code}>Turn on</button>
            <button type="button" className="btn" onClick={() => { setSetup(null); setCode(''); }}>Cancel</button>
          </div>
        </form>
      )}

      {recovery && (
        <div className="stack" role="status">
          <p><strong>Two-step sign-in is on.</strong> Save these recovery codes somewhere safe. Each works once if you lose your phone, and they are not shown again.</p>
          <pre style={{ userSelect: 'all', margin: 0 }}>{recovery.join('\n')}</pre>
          <div><button type="button" className="btn" onClick={() => setRecovery(null)}>I have saved them</button></div>
        </div>
      )}

      {status.available && status.enabled && !recovery && (
        <form onSubmit={disable} className="stack">
          <p className="muted small">On. {status.recoveryLeft} recovery code{status.recoveryLeft === 1 ? '' : 's'} left. To turn it off, enter a current code or a recovery code.</p>
          <div className="field">
            <label htmlFor="mfa-off-code">Code</label>
            <input id="mfa-off-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required />
          </div>
          <div><button type="submit" className="btn" disabled={busy || !code}>Turn off</button></div>
        </form>
      )}

      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'muted small' : 'small'} style={msg.ok ? undefined : { color: 'var(--danger, #b3261e)' }}>{msg.text}</p>}
    </section>
  );
}
