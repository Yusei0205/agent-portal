import { AwsKeysFields } from '../components/AwsKeysFields.jsx';
import { CodexCredentials } from '../components/CodexCredentials.jsx';
/**
 * Credentials page (F4) — per-user engine sign-ins.
 *
 * Engines:
 *   kiro        → api_key | identity_center (device-code flow)
 *   claude-code → api_key | subscription_token | bedrock_role
 *
 * Secrets are write-only; after saving only mode and last 4 chars are shown.
 * Browser-only: API token requests get 403 from the server.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { navigate } from '../lib/router.js';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';
import { AwsRegionSelect } from '../components/AwsRegionSelect.jsx';
import { DeviceCodeBox } from '../components/DeviceCodeBox.jsx';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';
import { PageHeader, SectionHead } from '../components/PageHeader.jsx';

// ── Helpers ────────────────────────────────────────────────────────────────────

function modeLabel(engine, mode) {
  if (engine === 'kiro') {
    return mode === 'api_key' ? 'API key' : 'IAM Identity Center';
  }
  if (mode === 'api_key') return 'API key';
  if (mode === 'subscription_token') return 'Subscription token';
  if (mode === 'bedrock_role') return 'Amazon Bedrock (role)';
  if (mode === 'aws_keys') return 'Amazon Bedrock (AWS access keys)';
  return mode;
}

function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function tokenValidity(config) {
  if (!config?.tokenExpiry) return null;
  const ms = new Date(config.tokenExpiry).getTime() - Date.now();
  if (ms <= 0) return 'Token expired';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `Access token expires in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hrs = Math.floor(mins / 60);
  return `Access token expires in ${hrs} hour${hrs === 1 ? '' : 's'}`;
}

/**
 * Returns the status text and colour for a credential card.
 * Uses the server-supplied `status` field when available; falls back to
 * `tokenValidity` for older server responses that lack the field.
 *
 * @param {{ status?: string, config?: { tokenExpiry?: string }, canRefresh?: boolean }} cred
 * @returns {{ text: string|null, color: string|null }}
 */
function getStatusInfo(cred) {
  if (cred.status) {
    if (cred.status === 'expiring')      return { text: 'Expiring soon',        color: 'var(--warn)' };
    if (cred.status === 'expired')       return { text: 'Token expired',         color: 'var(--danger)' };
    if (cred.status === 'needs_sign_in') return { text: 'Sign-in needed',        color: 'var(--danger)' };
    if (cred.status === 'pending')       return { text: 'Waiting for sign-in',   color: 'var(--warn)' };
    // 'ok' — show remaining time when available
    if (cred.config?.tokenExpiry) {
      const ms = new Date(cred.config.tokenExpiry).getTime() - Date.now();
      if (ms > 0) {
        const hrs = Math.floor(ms / 3600000);
        if (hrs >= 1) return { text: `Expires in ${hrs}h`, color: 'var(--ok)' };
        const mins = Math.floor(ms / 60000);
        return { text: `Expires in ${mins}m`, color: 'var(--ok)' };
      }
    }
    return { text: null, color: null };
  }
  // Backward-compat: server does not supply status yet
  const validity = tokenValidity(cred.config);
  if (!validity) return { text: null, color: null };
  return { text: validity, color: validity.includes('expired') ? 'var(--danger)' : 'var(--ok)' };
}

// ── Device code polling hook ───────────────────────────────────────────────────

function useDevicePoll(credId, challenge, onComplete) {
  const intervalRef = useRef(null);
  const [pollStatus, setPollStatus] = useState('pending'); // pending | slow_down | expired

  useEffect(() => {
    if (!credId || !challenge) return;
    setPollStatus('pending'); // Reset whenever a new challenge begins
    let currentInterval = (challenge.interval || 5) * 1000;

    const poll = async () => {
      try {
        const result = await api.post(`/api/credentials/${credId}/device-poll`, {});
        if (result.status === 'complete') {
          clearInterval(intervalRef.current);
          setPollStatus('complete');
          onComplete?.(result.credential);
        } else if (result.status === 'expired') {
          clearInterval(intervalRef.current);
          setPollStatus('expired');
        } else if (result.status === 'slow_down') {
          clearInterval(intervalRef.current);
          currentInterval = Math.min(currentInterval + 5000, 30000);
          intervalRef.current = setInterval(poll, currentInterval);
          setPollStatus('slow_down');
        }
        // pending: keep polling
      } catch {
        // non-fatal: keep polling
      }
    };

    intervalRef.current = setInterval(poll, currentInterval);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credId, challenge]);

  return pollStatus;
}

// ── Claude plan sign-in (server drives `claude setup-token`; no copy from your computer) ──

function ClaudePlanSignIn({ name, isDefault, onDone }) {
  const [support, setSupport] = useState(null); // { supported, reason }
  const [url, setUrl] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/api/claude-login/status')
      .then((r) => { if (live) setSupport(r); })
      .catch(() => { if (live) setSupport({ supported: false }); });
    // Drop a half-finished sign-in when the dialog closes.
    return () => { live = false; api.post('/api/claude-login/cancel', {}).catch(() => {}); };
  }, []);

  if (!support || !support.supported) {
    return support?.reason ? <p className="field-hint">{support.reason}</p> : null;
  }

  const start = async () => {
    setBusy(true); setError(null);
    try {
      const { login } = await api.post('/api/claude-login/start', {});
      setUrl(login.url);
      window.open(login.url, '_blank', 'noopener,noreferrer');
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  const finish = async () => {
    setBusy(true); setError(null);
    try {
      const { credential } = await api.post('/api/claude-login/complete',
        { code: code.trim(), name: name.trim() || undefined, isDefault });
      onDone(credential);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="field">
      <span className="field-label">Sign in with your Claude plan</span>
      {!url ? (
        <button type="button" className="btn" onClick={start} disabled={busy}>
          {busy ? 'Starting…' : 'Sign in with Claude'}
        </button>
      ) : (
        <div className="stack">
          <p className="field-hint">
            1. Approve access in the tab that opened (<a href={url} target="_blank" rel="noopener noreferrer">open it again</a>).
            {' '}2. Copy the code Claude shows you and paste it here.
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text" value={code} onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the code" autoComplete="off" spellCheck={false} aria-label="Code from Claude"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-primary" onClick={finish} disabled={busy || code.trim().length < 10}>
              {busy ? 'Checking…' : 'Finish'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <p className="field-hint">Uses Claude Code's own sign-in on the portal server. Or paste a token below instead.</p>
    </div>
  );
}

// ── Add Credential dialog ──────────────────────────────────────────────────────

function AddCredentialDialog({ engine, onClose, onCreated }) {
  const [mode, setMode] = useState(() => engine === 'kiro' ? 'api_key' : 'api_key');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  // IAM Identity Center fields
  const [startUrl, setStartUrl] = useState('');
  const [region, setRegion] = useState('us-east-1');
  // Bedrock role fields
  const [roleArn, setRoleArn] = useState('');
  const [bedrockRegion, setBedrockRegion] = useState('us-east-1');
  const [externalId, setExternalId] = useState('');
  // AWS access keys (pasted from the AWS access portal)
  const [awsKeys, setAwsKeys] = useState({});

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [deviceChallenge, setDeviceChallenge] = useState(null);
  const [deviceCredId, setDeviceCredId] = useState(null);

  const KIRO_MODES = [
    { id: 'api_key',          label: 'API key',              desc: 'You have a Kiro API key (from kiro.dev)' },
    { id: 'identity_center',  label: 'Company sign-in (AWS SSO)', desc: 'Your company gives you Kiro through AWS. You approve a code in your browser.' },
  ];
  const CLAUDE_MODES = [
    { id: 'api_key',           label: 'Anthropic API key',    desc: 'You have a key from console.anthropic.com. Usage is billed to it.' },
    { id: 'subscription_token', label: 'Claude plan (Pro / Max)', desc: 'Sign in with your Claude account here, or paste a token from `claude setup-token`.' },
    { id: 'aws_keys',          label: 'Amazon Bedrock (AWS access keys)', desc: 'Your company signs in to AWS with SSO. Paste the keys the AWS access portal copies for you; they expire after a few hours.' },
    { id: 'bedrock_role',      label: 'Amazon Bedrock (IAM role)', desc: 'Your company runs Claude on AWS Bedrock and gave you a role ARN. No secret is stored.' },
  ];
  const modes = engine === 'kiro' ? KIRO_MODES : CLAUDE_MODES;

  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);

  // Trap focus
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(el.querySelectorAll(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { last.focus(); e.preventDefault(); }
      } else {
        if (document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pollStatus = useDevicePoll(
    deviceCredId,
    deviceChallenge,
    (credential) => {
      onCreated(credential);
      onClose();
    },
  );

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { engine, mode, name: name.trim() || undefined, isDefault };
      if (mode === 'identity_center') {
        body.config = { startUrl: startUrl.trim(), region: region.trim() };
      } else if (mode === 'aws_keys') {
        body.config = { region: (awsKeys.region || bedrockRegion).trim() };
        body.awsKeys = { accessKeyId: awsKeys.accessKeyId, secretAccessKey: awsKeys.secretAccessKey, sessionToken: awsKeys.sessionToken };
      } else if (mode === 'bedrock_role') {
        body.config = { roleArn: roleArn.trim(), region: bedrockRegion.trim() };
        if (externalId.trim()) body.config.externalId = externalId.trim();
      } else {
        body.secret = secret;
      }

      const result = await api.post('/api/credentials', body);
      if (result.deviceChallenge) {
        setDeviceChallenge(result.deviceChallenge);
        setDeviceCredId(result.credential.id);
      } else {
        onCreated(result.credential);
        onClose();
      }
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const engineLabel = engine === 'kiro' ? 'Kiro' : 'Claude Code';
  const isDeviceFlow = deviceChallenge && deviceCredId;
  const overlayDismiss = useOverlayDismiss(onClose);

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-cred-title"
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="add-cred-title">
            Add {engineLabel} credential
          </h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="dialog-body stack">
          {/* Mode picker */}
          <div className="cred-dialog-section">
            <h3>Sign-in method</h3>
            <div className="cred-mode-grid" role="radiogroup" aria-label="Sign-in method">
              {modes.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  className={`cred-mode-card${mode === m.id ? ' is-selected' : ''}`}
                  onClick={() => setMode(m.id)}
                >
                  <strong>{m.label}</strong>
                  <span>{m.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Name */}
          <div className="field">
            <label htmlFor="cred-name">Name (optional)</label>
            <input
              id="cred-name"
              ref={firstFieldRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`My ${engineLabel} credential`}
              maxLength={100}
            />
          </div>

          {mode === 'subscription_token' && (
            <ClaudePlanSignIn
              name={name}
              isDefault={isDefault}
              onDone={(credential) => { onCreated(credential); onClose(); }}
            />
          )}

          {/* Secret fields by mode */}
          {(mode === 'api_key' || mode === 'subscription_token') && (
            <div className="field">
              <label htmlFor="cred-secret">
                {mode === 'api_key' ? 'API key' : 'Subscription token'}{' '}
                <span aria-hidden="true">*</span>
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id="cred-secret"
                  type={showSecret ? 'text' : 'password'}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="••••••••••••"
                  aria-required="true"
                  autoComplete="off"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setShowSecret((v) => !v)}
                  aria-label={showSecret ? 'Hide value' : 'Show value'}
                >
                  <Icon name="eye" size={15} />
                </button>
              </div>
              <p className="field-hint">Write-only — after saving only the last 4 characters are shown.</p>
            </div>
          )}

          {mode === 'identity_center' && !isDeviceFlow && (
            <>
              <div className="field">
                <label htmlFor="cred-start-url">Start URL <span aria-hidden="true">*</span></label>
                <input
                  id="cred-start-url"
                  type="url"
                  value={startUrl}
                  onChange={(e) => setStartUrl(e.target.value)}
                  placeholder="https://d-xxxxxxxxxx.awsapps.com/start"
                  aria-required="true"
                />
              </div>
              <div className="field">
                <label htmlFor="cred-sso-region">AWS region</label>
                <AwsRegionSelect
                  id="cred-sso-region"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                />
              </div>
            </>
          )}

          {mode === 'aws_keys' && (
            <>
              <AwsKeysFields value={awsKeys} onChange={setAwsKeys} idPrefix="cred-aws" />
              <div className="field">
                <label htmlFor="cred-aws-region">Bedrock region</label>
                <AwsRegionSelect
                  id="cred-aws-region"
                  value={awsKeys.region || bedrockRegion}
                  onChange={(e) => { setBedrockRegion(e.target.value); setAwsKeys({ ...awsKeys, region: e.target.value }); }}
                />
              </div>
            </>
          )}

          {mode === 'bedrock_role' && (
            <>
              <div className="field">
                <label htmlFor="cred-role-arn">IAM role ARN <span aria-hidden="true">*</span></label>
                <input
                  id="cred-role-arn"
                  type="text"
                  value={roleArn}
                  onChange={(e) => setRoleArn(e.target.value)}
                  placeholder="arn:aws:iam::123456789012:role/MyRole"
                  aria-required="true"
                />
              </div>
              <div className="field">
                <label htmlFor="cred-bedrock-region">Bedrock region</label>
                <AwsRegionSelect
                  id="cred-bedrock-region"
                  value={bedrockRegion}
                  onChange={(e) => setBedrockRegion(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="cred-external-id">External ID (optional)</label>
                <input
                  id="cred-external-id"
                  type="text"
                  value={externalId}
                  onChange={(e) => setExternalId(e.target.value)}
                  placeholder="Optional external ID"
                />
              </div>
            </>
          )}

          {/* Device code challenge */}
          {isDeviceFlow && (
            <div className="device-code-box" role="region" aria-label="Device authorization">
              <h4>Authorize in your browser</h4>
              <p style={{ fontSize: '0.84rem', marginBottom: 8 }}>
                Open the link below and enter the code to sign in:
              </p>
              <div className="device-code-url">
                <a
                  href={deviceChallenge.verificationUriComplete || deviceChallenge.verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {deviceChallenge.verificationUri}
                </a>
              </div>
              <div
                className="device-user-code"
                aria-label={`User code: ${deviceChallenge.userCode}`}
              >
                {deviceChallenge.userCode}
              </div>
              <div className="device-status" aria-live="polite">
                {pollStatus === 'expired' ? (
                  <><Icon name="warning" size={15} /> Code expired. Close and try again.</>
                ) : pollStatus === 'slow_down' ? (
                  <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
                  Waiting for authorization (slowing down)…</>
                ) : (
                  <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
                  Waiting for you to authorize…</>
                )}
              </div>
            </div>
          )}

          {/* Default */}
          {!isDeviceFlow && (
            <label className="choice" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              <span>Set as default for {engineLabel} sessions</span>
            </label>
          )}

          {error && <p className="error-note" role="alert">{error}</p>}
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {!isDeviceFlow && (
            <button
              type="submit"
              className="btn btn-primary"
              form="add-cred-form"
              disabled={busy}
              onClick={submit}
            >
              {busy ? (
                <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> {mode === 'identity_center' ? 'Requesting sign-in code…' : 'Saving…'}</>
              ) : (
                'Add credential'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Credential card ────────────────────────────────────────────────────────────

function CredentialCard({ cred, onSetDefault, onRemove, onRefresh }) {
  const [removing, setRemoving] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  // Refresh (token-based silent renewal)
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [highlightSignIn, setHighlightSignIn] = useState(false);
  // Re-authentication (new device-code flow, same credential id)
  const [reauthBusy, setReauthBusy] = useState(false);
  const [reauthError, setReauthError] = useState(null);
  const [reauthChallenge, setReauthChallenge] = useState(null);
  const [reauthCredId, setReauthCredId] = useState(null);

  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  // Inline device-code polling for re-authentication
  const pollStatus = useDevicePoll(
    reauthCredId,
    reauthChallenge,
    (credential) => {
      toast('Kiro sign-in renewed', 'ok');
      setReauthChallenge(null);
      setReauthCredId(null);
      setHighlightSignIn(false);
      onRefresh();
    },
  );

  const handleRemove = async () => {
    if (!await requestConfirm(`Remove credential "${cred.name}"?`, 'Remove', 'danger')) return;
    setRemoving(true);
    try {
      await api.delete(`/api/credentials/${cred.id}`);
      onRefresh();
    } catch (e) {
      toast(e.message, 'error');
      setRemoving(false);
    }
  };

  // Test: a real call with this sign-in (the models it can list), with the answer shown on the card.
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const handleTest = async () => {
    setTestBusy(true);
    setTestResult(null);
    try {
      setTestResult(await api.post('/api/credentials/check', { engine: cred.engine, credentialId: cred.id }));
    } catch (e) {
      setTestResult({ ok: false, message: e.message || 'The check could not run' });
    } finally {
      setTestBusy(false);
    }
  };

  // Replace keys (AWS access keys expire): paste new ones, same sign-in.
  const [keysOpen, setKeysOpen] = useState(false);
  const [newKeys, setNewKeys] = useState({});
  const [keysBusy, setKeysBusy] = useState(false);
  const [keysError, setKeysError] = useState(null);
  const saveKeys = async () => {
    setKeysBusy(true);
    setKeysError(null);
    try {
      await api.put(`/api/credentials/${cred.id}`, { awsKeys: { accessKeyId: newKeys.accessKeyId, secretAccessKey: newKeys.secretAccessKey, sessionToken: newKeys.sessionToken } });
      setKeysOpen(false);
      setNewKeys({});
      setTestResult(null);
      onRefresh();
    } catch (e) {
      setKeysError(e.message);
    } finally {
      setKeysBusy(false);
    }
  };

  const handleSetDefault = async () => {
    setSettingDefault(true);
    try {
      await api.post(`/api/credentials/${cred.id}/set-default`, {});
      onRefresh();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setSettingDefault(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshBusy(true);
    setRefreshError(null);
    setHighlightSignIn(false);
    try {
      await api.post(`/api/credentials/${cred.id}/refresh`, {});
      toast('Kiro sign-in renewed', 'ok');
      onRefresh();
    } catch (err) {
      // 409 with needsSignIn: true means the refresh token is gone — must sign in again
      if (err.status === 409 && err.data?.needsSignIn) {
        setRefreshError(err.message || 'Token cannot be refreshed automatically. Please sign in again.');
        setHighlightSignIn(true);
      } else {
        setRefreshError(err.message);
      }
    } finally {
      setRefreshBusy(false);
    }
  };

  const handleSignInAgain = async () => {
    setReauthBusy(true);
    setReauthError(null);
    setRefreshError(null);
    setHighlightSignIn(false);
    try {
      const result = await api.post(`/api/credentials/${cred.id}/reauth`, {});
      setReauthChallenge(result.deviceChallenge);
      setReauthCredId(result.credential.id);
    } catch (err) {
      setReauthError(err.message);
    } finally {
      setReauthBusy(false);
    }
  };

  const handleCancelReauth = () => {
    setReauthChallenge(null);
    setReauthCredId(null);
  };

  const statusInfo = getStatusInfo(cred);
  const isKiroIdC = cred.engine === 'kiro' && cred.mode === 'identity_center';
  // Determine if "Sign in again" should be shown with primary (accent) styling
  const isExpiredOrNeedsSignIn =
    cred.status === 'expired' ||
    cred.status === 'needs_sign_in' ||
    (cred.status == null && cred.config?.tokenExpiry && new Date(cred.config.tokenExpiry) < new Date());

  // Map useDevicePoll statuses to what DeviceCodeBox accepts
  const boxPollStatus =
    pollStatus === 'complete' ? 'complete' :
    pollStatus === 'expired'  ? 'expired'  : 'pending';

  return (
    <div className={`cred-card${cred.isDefault ? ' is-default' : ''}`}>
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div className="cred-card-body">
        <div className="cred-card-name">
          <span>{cred.name}</span>
          {cred.isDefault && (
            <span className="badge" style={{ background: 'var(--accent-wash)', color: 'var(--accent)' }}>
              Default
            </span>
          )}
          <span className="badge">{modeLabel(cred.engine, cred.mode)}</span>
        </div>
        <div className="cred-card-meta">
          {cred.last4 && (
            <span title="Last 4 characters of the secret">
              <Icon name="eye" size={12} /> ••••{cred.last4}
            </span>
          )}
          {cred.mode === 'bedrock_role' && cred.config?.roleArn && (
            <span title="IAM role ARN" style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem' }}>
              {String(cred.config.roleArn).slice(0, 50)}{cred.config.roleArn.length > 50 ? '…' : ''}
            </span>
          )}
          {cred.mode === 'identity_center' && cred.config?.startUrl && (
            <span>{cred.config.startUrl}</span>
          )}
          {statusInfo.text && (
            <span role="status" aria-live="polite" style={{ color: statusInfo.color }}>
              {statusInfo.text}
            </span>
          )}
          {cred.updatedAt && (
            <span>Updated {timeAgo(cred.updatedAt)}{cred.updatedBy ? ` by ${cred.updatedBy}` : ''}</span>
          )}
        </div>

        {keysOpen && (
          <div className="stack" style={{ margin: '8px 0' }}>
            <AwsKeysFields value={newKeys} onChange={setNewKeys} idPrefix={`aws-new-${cred.id}`} />
            {keysError && <p className="error-note" role="alert">{keysError}</p>}
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-sm btn-primary" onClick={saveKeys} disabled={keysBusy}>{keysBusy ? 'Saving…' : 'Save keys'}</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setKeysOpen(false)}>Cancel</button>
            </div>
          </div>
        )}

        {testResult && (
          <p role="status" className={testResult.ok ? 'muted small' : 'error-note'} style={{ margin: '4px 0 0' }}>
            {testResult.ok ? '✓ ' : ''}{testResult.message}
          </p>
        )}

        {/* Refresh error (shown above the "Sign in again" highlight) */}
        {refreshError && (
          <p className="error-note" role="alert" style={{ marginTop: 6, marginBottom: 0, fontSize: '0.82rem' }}>
            {refreshError}
          </p>
        )}
        {reauthError && (
          <p className="error-note" role="alert" style={{ marginTop: 6, marginBottom: 0, fontSize: '0.82rem' }}>
            {reauthError}
          </p>
        )}

        {/* Inline device-code flow for re-authentication */}
        {reauthChallenge && reauthCredId && (
          <DeviceCodeBox
            challenge={reauthChallenge}
            pollStatus={boxPollStatus}
            onCancel={handleCancelReauth}
            heading="Sign in to Kiro again"
          />
        )}
      </div>

      <div className="cred-card-actions">
        {/* Kiro IAM Identity Center: Refresh + Sign in again */}
        {isKiroIdC && !reauthChallenge && (
          <>
            {cred.canRefresh && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={handleRefresh}
                disabled={refreshBusy}
                aria-label={`Refresh "${cred.name}" Kiro sign-in`}
              >
                {refreshBusy ? (
                  <><span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" /> Refreshing…</>
                ) : (
                  <><Icon name="refresh" size={12} /> Refresh</>
                )}
              </button>
            )}
            <button
              type="button"
              className={`btn btn-sm${isExpiredOrNeedsSignIn || highlightSignIn ? ' btn-primary' : ' btn-ghost'}`}
              onClick={handleSignInAgain}
              disabled={reauthBusy}
              aria-label={`Sign in to "${cred.name}" again`}
            >
              {reauthBusy ? (
                <><span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" /> Starting…</>
              ) : (
                'Sign in again'
              )}
            </button>
          </>
        )}

        {cred.mode === 'aws_keys' && (
          <button type="button" className={`btn btn-sm${testResult && !testResult.ok ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setKeysOpen((o) => !o)} aria-expanded={keysOpen}>
            Replace keys
          </button>
        )}
        {!isKiroIdC && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={handleTest} disabled={testBusy} aria-label={`Test "${cred.name}"`}>
            {testBusy ? 'Testing…' : 'Test'}
          </button>
        )}
        {isKiroIdC && !reauthChallenge && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={handleTest} disabled={testBusy} aria-label={`Test "${cred.name}"`}>
            {testBusy ? 'Testing…' : 'Test'}
          </button>
        )}
        {!cred.isDefault && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleSetDefault}
            disabled={settingDefault}
            aria-label={`Set "${cred.name}" as default`}
          >
            {settingDefault ? 'Setting…' : 'Set default'}
          </button>
        )}
        <button
          type="button"
          className={`btn btn-sm${isKiroIdC ? ' btn-ghost' : ' btn-danger'}`}
          onClick={handleRemove}
          disabled={removing}
          aria-label={`Remove credential "${cred.name}"`}
        >
          {removing ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  );
}

// ── Engine section ─────────────────────────────────────────────────────────────

function EngineSection({ engine, credentials, onRefresh }) {
  const [addOpen, setAddOpen] = useState(false);
  const label = engine === 'kiro' ? 'Kiro' : 'Claude Code';
  const folder = engine === 'kiro' ? '~/.kiro' : 'claude setup-token / API';

  return (
    <section className="cred-engine-section" aria-labelledby={`cred-engine-${engine}`}>
      <div className="cred-engine-heading">
        <h2 id={`cred-engine-${engine}`}>{label}</h2>
        <span className="muted">{folder}</span>
      </div>

      {credentials.length === 0 ? (
        <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 12 }}>
          No credentials yet. Add one to use this engine in your sessions.
        </p>
      ) : (
        <div className="cred-list" style={{ marginBottom: 12 }}>
          {credentials.map((c) => (
            <CredentialCard
              key={c.id}
              cred={c}
              onSetDefault={onRefresh}
              onRemove={onRefresh}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        className="btn"
        onClick={() => setAddOpen(true)}
        aria-label={`Add ${label} credential`}
      >
        <Icon name="plus" size={14} />
        Add {label} credential
      </button>

      {addOpen && (
        <AddCredentialDialog
          engine={engine}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); onRefresh(); }}
        />
      )}
    </section>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function Credentials({ user }) {
  const isAdmin = Boolean(user?.is_admin);
  const [credentials, setCredentials] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // #/config/sign-ins?engine=kiro (from the Get started card) scrolls to that engine's section.
  useEffect(() => {
    if (loading) return;
    const wanted = new URLSearchParams(window.location.hash.split('?')[1] || '').get('engine');
    if (wanted) document.getElementById(`cred-engine-${wanted}`)?.scrollIntoView({ block: 'start' });
  }, [loading]);

  const load = useCallback(async () => {
    try {
      const { credentials: creds } = await api.get('/api/credentials');
      setCredentials(creds);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="page">
        <div className="spinner" aria-label="Loading credentials…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <p className="error-note" role="alert">{error}</p>
        <button type="button" className="btn" onClick={load} style={{ marginTop: 12 }}>
          Retry
        </button>
      </div>
    );
  }

  const kiroCredentials = (credentials || []).filter((c) => c.engine === 'kiro');
  const claudeCredentials = (credentials || []).filter((c) => c.engine === 'claude-code');

  return (
    <div className="page">
      <PageHeader
        title="Credentials"
        description={<>
          Your own sign-ins for Codex, Kiro and Claude Code. Your sessions use these first; without one
          they fall back to the{' '}
          {isAdmin ? <a href="#/settings">portal AI provider</a> : 'portal AI provider'}.{' '}
          Secrets are write-only and never appear in logs or transcripts.
        </>}
      />

      <div id="cred-engine-codex"><CodexCredentials isAdmin={isAdmin} /></div>

      <EngineSection
        engine="kiro"
        credentials={kiroCredentials}
        onRefresh={load}
      />

      <EngineSection
        engine="claude-code"
        credentials={claudeCredentials}
        onRefresh={load}
      />
    </div>
  );
}

export default Credentials;
