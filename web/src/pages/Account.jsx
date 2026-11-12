import { useState } from 'react';
import { api } from '../lib/api.js';

import { MfaSettings } from '../components/MfaSettings.jsx';
/**
 * The signed-in person's own account: who they are, their password, and signing out other devices.
 * @param {{ user: { id: string, name?: string, email: string, is_admin?: boolean } }} props
 */
export function Account({ user }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState(/** @type {{ ok: boolean, text: string } | null} */ (null));
  const [outBusy, setOutBusy] = useState(false);
  const [outMsg, setOutMsg] = useState(/** @type {{ ok: boolean, text: string } | null} */ (null));

  const changePassword = async (e) => {
    e.preventDefault();
    setPwMsg(null);
    if (next.length < 10) { setPwMsg({ ok: false, text: 'The new password must be at least 10 characters.' }); return; }
    if (next !== again) { setPwMsg({ ok: false, text: 'The two new passwords do not match.' }); return; }
    setPwBusy(true);
    try {
      await api.post('/api/auth/password', { current, password: next });
      setCurrent(''); setNext(''); setAgain('');
      setPwMsg({ ok: true, text: 'Password changed. Your other browsers and devices were signed out.' });
    } catch (err) {
      setPwMsg({ ok: false, text: err.message || 'Could not change the password' });
    } finally {
      setPwBusy(false);
    }
  };

  const signOutOthers = async () => {
    setOutBusy(true);
    setOutMsg(null);
    try {
      const r = await api.post('/api/auth/sign-out-others', {});
      setOutMsg({ ok: true, text: r.signedOut ? `Signed out of ${r.signedOut} other browser${r.signedOut === 1 ? '' : 's'} or device${r.signedOut === 1 ? '' : 's'}.` : 'You were not signed in anywhere else.' });
    } catch (err) {
      setOutMsg({ ok: false, text: err.message || 'Could not sign out the other devices' });
    } finally {
      setOutBusy(false);
    }
  };

  return (
    <div className="page account-page">
      <h1>Account</h1>

      <section className="panel stack" aria-labelledby="acct-profile">
        <h2 id="acct-profile">Profile</h2>
        <dl className="account-facts">
          <dt>Name</dt><dd>{user.name || '—'}</dd>
          <dt>Email</dt><dd>{user.email}</dd>
          <dt>Role</dt><dd>{user.is_admin ? 'Admin' : 'Member'}</dd>
        </dl>
        <p className="muted small">To change your name or email, ask an admin.</p>
      </section>

      <section className="panel stack" aria-labelledby="acct-password">
        <h2 id="acct-password">Password</h2>
        <form onSubmit={changePassword} className="stack" noValidate>
          <div className="field">
            <label htmlFor="acct-current">Current password</label>
            <input id="acct-current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </div>
          <div className="field">
            <label htmlFor="acct-new">New password (at least 10 characters)</label>
            <input id="acct-new" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
          </div>
          <div className="field">
            <label htmlFor="acct-again">Repeat the new password</label>
            <input id="acct-again" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
          </div>
          {pwMsg && <div className={pwMsg.ok ? 'success-note' : 'error-note'} role={pwMsg.ok ? 'status' : 'alert'}>{pwMsg.text}</div>}
          <div><button type="submit" className="btn btn-primary" disabled={pwBusy || !current || !next}>{pwBusy ? 'Saving…' : 'Change password'}</button></div>
        </form>
        <p className="muted small">Forgot it? Sign out and ask an admin for a reset link. If you only sign in with Google you have no portal password to change.</p>
      </section>

      <MfaSettings />

      <section className="panel stack" aria-labelledby="acct-devices">
        <h2 id="acct-devices">Other devices</h2>
        <p className="muted small">Signed in on a shared or lost computer? This ends every session except the one you are using now.</p>
        {outMsg && <div className={outMsg.ok ? 'success-note' : 'error-note'} role={outMsg.ok ? 'status' : 'alert'}>{outMsg.text}</div>}
        <div><button type="button" className="btn btn-outline" onClick={signOutOthers} disabled={outBusy}>{outBusy ? 'Signing out…' : 'Sign out other devices'}</button></div>
      </section>
    </div>
  );
}
