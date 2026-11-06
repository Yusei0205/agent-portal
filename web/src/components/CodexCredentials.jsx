import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './Icon.jsx';

export function CodexCredentials({ isAdmin }) {
  const [status, setStatus] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => new URLSearchParams(window.location.hash.split('?')[1] || '').has('codex_error')
    ? 'OpenAI authorization could not be completed or did not grant inference access. Start sign-in again.' : '');
  const callbackFailed = useRef(Boolean(error));
  const loading = useRef(false);
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const next = await api.get('/api/codex/status');
      setStatus(next);
      if (!callbackFailed.current) setError('');
      if (next.login?.status === 'pending' || next.login?.status === 'starting') setChallenge(next.login);
      else {
        setChallenge(null);
        if (next.login?.status === 'failed') setError(next.login.error || 'Codex sign-in failed.');
      }
    } catch (e) { setError(e.message); }
    finally { loading.current = false; }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!challenge) return;
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [Boolean(challenge), load]);

  const act = async (endpoint) => {
    if (busy) return;
    setBusy(true);
    callbackFailed.current = false;
    setError('');
    try {
      const result = await api.post('/api/codex/' + endpoint, {});
      if (result.authorizationUrl) { window.location.assign(result.authorizationUrl); return; }
      if (endpoint === 'login') setChallenge(result);
      else { setChallenge(null); await load(); }
      if (result.remoteRevocationConfirmed === false) setError('Signed out of the portal. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const unavailable = !status || status.supported === false || status.installed === false
    || (status.code && !['codex_status_failed', 'codex_reauthentication_required'].includes(status.code));
  const statusLabel = !status ? 'Checking Codex...' : status.signedIn
    ? 'Signed in' + (status.email ? ' as ' + status.email : '') : unavailable ? 'Unavailable' : 'Not signed in';
  const problem = error || status?.error;

  return (
    <section className="cred-engine-section" aria-labelledby="codex-credentials-title">
      <div className="cred-engine-heading">
        <h2 id="codex-credentials-title">Codex</h2>
        <span className="muted">ChatGPT sign-in</span>
      </div>
      <div className="cred-list" style={{ marginBottom: 12 }}>
        <div className={`cred-card${status?.signedIn ? ' is-default' : ''}`}>
          <div className="cred-card-body">
            <div className="cred-card-name">
              <span>{status?.signedIn ? 'Codex account' : 'Codex'}</span>
              <span className="badge">ChatGPT subscription</span>
              {status?.planType && <span className="badge">{status.planType}</span>}
            </div>
            <div className="cred-card-meta">
              <span role="status" aria-live="polite">{statusLabel}</span>
            </div>
            {problem && <p className="error-note" role="alert" style={{ marginTop: 6, marginBottom: 0, fontSize: '0.82rem' }}>{problem}</p>}
            {challenge && (
              <div className="device-code-box" role="status">
                <h4>Sign in to Codex</h4>
                <p>{challenge.userCode ? 'Open the sign-in page and enter this one-time code:' : 'Preparing your device authorization code...'}</p>
                {challenge.userCode && <div className="device-user-code-row"><strong className="device-user-code">{challenge.userCode}</strong></div>}
                {challenge.verificationUrl && <a className="device-code-url" href={challenge.verificationUrl} target="_blank" rel="noopener noreferrer">Sign in with ChatGPT</a>}
                <p className="device-status">Waiting for authorization. Enable device-code login in ChatGPT Settings → Security if prompted. If the code expires, cancel and start again.</p>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act('login/cancel')}>Cancel sign-in</button>
              </div>
            )}
          </div>
          <div className="cred-card-actions">
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={load}>
              <Icon name="refresh" size={12} /> Refresh status
            </button>
            {!challenge && status?.signedIn && <>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy || unavailable} onClick={() => act('login')}>Sign in again</button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act('logout')}>Sign out of Codex</button>
            </>}
            {!challenge && !status?.signedIn && (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy || unavailable} onClick={() => act('login')}>
                {busy ? 'Working...' : 'Sign in with ChatGPT'}
              </button>
            )}
          </div>
        </div>
      </div>
      {!challenge && isAdmin && status?.canImportHostLogin && !status?.signedIn && (
        <button type="button" className="btn" disabled={busy || unavailable} onClick={() => act('import-host-login')}>
          Use this machine's Codex sign-in
        </button>
      )}
      <p className="field-hint" style={{ marginTop: 8 }}>
        Your sessions use this account's Codex access and limits. Your sign-in is kept separately from other portal users.
      </p>
    </section>
  );
}
