/**
 * Asks for the account password before a sensitive action (stored credentials, users, project deletion).
 * Mounted once; api.js calls it when the server answers "reauth_required" and repeats the action after a correct password.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, setReauthHandler } from '../lib/api.js';

export function ReauthPrompt() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const [busy, setBusy] = useState(false);
  const resolver = useRef(/** @type {null | ((ok: boolean) => void)} */ (null));
  const input = useRef(/** @type {HTMLInputElement|null} */ (null));

  useEffect(() => {
    setReauthHandler(() => new Promise((resolve) => {
      // One prompt at a time: a second request waits for the same answer.
      resolver.current?.(false);
      resolver.current = resolve;
      setPassword('');
      setError(null);
      setOpen(true);
    }));
    return () => setReauthHandler(null);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const finish = (ok) => {
    setOpen(false);
    setPassword('');
    const r = resolver.current;
    resolver.current = null;
    r?.(ok);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/confirm', { password });
      finish(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm your password');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  // On top of whatever dialog asked for the action (an "Add credential" form is itself a dialog).
  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reauth-title" style={{ zIndex: 2000 }}>
      <form className="modal" style={{ maxWidth: 420 }} onSubmit={submit}>
        <div className="modal-header">
          <h2 id="reauth-title" style={{ fontSize: '1rem' }}>Confirm your password</h2>
        </div>
        <p style={{ margin: '4px 0 12px', color: 'var(--ink-2)', fontSize: '0.9rem' }}>
          This changes what the portal trusts, so enter your password to continue. You will not be asked again for 10 minutes.
        </p>
        <input
          ref={input}
          type="password"
          className="input"
          autoComplete="current-password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '100%' }}
        />
        {error && <p role="alert" style={{ color: 'var(--danger, #b3261e)', fontSize: '0.85rem', margin: '8px 0 0' }}>{error}</p>}
        <div className="modal-footer" style={{ marginTop: 16 }}>
          <button type="button" className="btn" onClick={() => finish(false)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!password || busy}>Confirm</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
