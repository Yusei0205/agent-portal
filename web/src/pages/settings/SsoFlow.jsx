import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Button, ErrorNote, Field, Spinner, useUi } from '../../components/ui.jsx';
import { RegionSelect } from './regions.jsx';

/** SSO device-authorisation flow panel, shown when auth === 'sso'. */
export function SsoFlow({ s, reload }) {
  const { toast } = useUi();
  // Config fields
  const [startUrl, setStartUrl] = useState(s.aws.ssoStartUrl ?? '');
  const [ssoRegion, setSsoRegion] = useState(s.aws.ssoRegion ?? s.aws.region ?? '');
  // Flow state
  const [flowError, setFlowError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null); // { userCode, verificationUriComplete, expiresIn }
  const [pollStatus, setPollStatus] = useState(null); // { state, accountId, roleName, expiresAt, error }
  // Account/role selection
  const [accounts, setAccounts] = useState(null);
  const [roles, setRoles] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(s.aws.ssoAccountId ?? '');
  const [selectedRole, setSelectedRole] = useState(s.aws.ssoRoleName ?? '');
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [saving, setSaving] = useState(false);
  const pollRef = useRef(null);

  // Derive signed-in state from settings OR from a successful poll
  const signedIn = s.ssoStatus?.signedIn || pollStatus?.state === 'authorised';

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Clean up on unmount
  useEffect(() => () => stopPolling(), []);

  // When we become authorised, load accounts
  useEffect(() => {
    if (signedIn && accounts === null && !loadingAccounts) {
      loadAccounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // When selectedAccount changes, load roles
  useEffect(() => {
    if (signedIn && selectedAccount) {
      loadRoles(selectedAccount);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccount]);

  const loadAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const data = await api.get('/api/sso/accounts');
      setAccounts(data.accounts);
      // Auto-select if only one account
      if (data.accounts.length === 1 && !selectedAccount) {
        setSelectedAccount(data.accounts[0].accountId);
      }
    } catch (e) {
      setFlowError(e);
    } finally {
      setLoadingAccounts(false);
    }
  };

  const loadRoles = async (accountId) => {
    setLoadingRoles(true);
    setRoles(null);
    try {
      const data = await api.get(`/api/sso/roles?accountId=${encodeURIComponent(accountId)}`);
      setRoles(data.roles);
      // Auto-select if only one role
      if (data.roles.length === 1 && !selectedRole) {
        setSelectedRole(data.roles[0].roleName);
      }
    } catch (e) {
      setFlowError(e);
    } finally {
      setLoadingRoles(false);
    }
  };

  const startAuth = async () => {
    setFlowError(null);
    setStarting(true);
    stopPolling();
    setPollStatus(null);
    setDeviceInfo(null);
    try {
      const data = await api.post('/api/sso/start', { startUrl, ssoRegion });
      setDeviceInfo(data);
      // Poll for authorisation
      const intervalMs = Math.max((data.interval ?? 5) * 1000, 3000);
      pollRef.current = setInterval(async () => {
        try {
          const st = await api.get('/api/sso/status');
          setPollStatus(st);
          if (st.state === 'authorised') {
            stopPolling();
            setDeviceInfo(null);
            await reload();
            loadAccounts();
          } else if (st.state === 'expired' || st.state === 'error') {
            stopPolling();
          }
        } catch {
          // network glitch — keep trying
        }
      }, intervalMs);
    } catch (e) {
      setFlowError(e);
    } finally {
      setStarting(false);
    }
  };

  const saveSelection = async () => {
    if (!selectedAccount || !selectedRole) return;
    setSaving(true);
    setFlowError(null);
    try {
      await api.post('/api/sso/select', { accountId: selectedAccount, roleName: selectedRole });
      toast('Account and role saved');
      await reload();
    } catch (e) {
      setFlowError(e);
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    setFlowError(null);
    stopPolling();
    try {
      await api.del('/api/sso/session');
      setDeviceInfo(null);
      setPollStatus(null);
      setAccounts(null);
      setRoles(null);
      toast('Signed out of AWS SSO');
      await reload();
    } catch (e) {
      setFlowError(e);
    }
  };

  const expiresAt = s.ssoStatus?.expiresAt ?? pollStatus?.expiresAt;
  const expiryStr = expiresAt ? new Date(expiresAt).toLocaleString() : null;

  return (
    <div className="stack" aria-live="polite">
      {!signedIn ? (
        <>
          <Field label="SSO start URL">
            {(id) => (
              <input
                id={id}
                className="input mono input-md"
                type="url"
                value={startUrl}
                onChange={(e) => setStartUrl(e.target.value.trim())}
                placeholder="https://my-org.awsapps.com/start"
                aria-describedby="sso-url-hint"
              />
            )}
          </Field>
          <p id="sso-url-hint" className="field-hint">
            Find this in the IAM Identity Center console under &ldquo;AWS access portal URL&rdquo;.
          </p>
          <Field label="SSO region">
            {(id) => (
              <RegionSelect
                id={id}
                value={ssoRegion}
                onChange={(v) => setSsoRegion(v)}
                className="input mono input-sm"
                placeholder="Select the IAM Identity Center region…"
              />
            )}
          </Field>
          <div className="row">
            <Button
              variant="primary"
              busy={starting}
              disabled={!startUrl || !ssoRegion}
              onClick={startAuth}
            >
              Sign in with AWS SSO
            </Button>
          </div>
        </>
      ) : null}

      {deviceInfo && !signedIn ? (
        <div className="note note-info" role="status">
          <div className="stack">
            <p>
              <strong>Your one-time code:</strong>{' '}
              <code
                className="mono"
                style={{ fontSize: '1.4em', letterSpacing: '0.12em' }}
                aria-label={`One-time code: ${deviceInfo.userCode}`}
              >
                {deviceInfo.userCode}
              </code>
            </p>
            <p>
              Open the link below, enter the code, then return here. This page will update
              automatically.
            </p>
            <a
              href={deviceInfo.verificationUriComplete}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-default btn-sm"
            >
              Open AWS sign-in page ↗
            </a>
            <p className="muted small">
              Waiting for approval
              <span className="spinner spinner-sm" role="status" aria-label="Waiting" style={{ marginLeft: '0.5rem' }} />
            </p>
          </div>
        </div>
      ) : null}

      {(pollStatus?.state === 'expired' || pollStatus?.state === 'error') ? (
        <ErrorNote error={{ message: pollStatus.error ?? 'Authorisation failed. Try again.' }} />
      ) : null}

      {signedIn ? (
        <>
          <div className="note note-ok" role="status">
            <div>
              <strong>Signed in to AWS SSO</strong>
              {expiryStr ? <span className="muted small"> · session expires {expiryStr}</span> : null}
              {s.aws.ssoAccountId && s.aws.ssoRoleName ? (
                <p className="muted small">
                  Using account <code>{s.aws.ssoAccountId}</code>, role <code>{s.aws.ssoRoleName}</code>
                </p>
              ) : null}
            </div>
          </div>

          {/* Account selector */}
          <Field label="AWS account">
            {(id) =>
              loadingAccounts ? (
                <Spinner />
              ) : (
                <select
                  id={id}
                  className="input"
                  value={selectedAccount}
                  onChange={(e) => {
                    setSelectedAccount(e.target.value);
                    setSelectedRole('');
                  }}
                  aria-label="Select AWS account"
                >
                  <option value="">Select an account…</option>
                  {(accounts ?? []).map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.accountName} ({a.accountId})
                    </option>
                  ))}
                </select>
              )
            }
          </Field>
          {accounts && accounts.length === 0 && !loadingAccounts ? (
            <p className="field-hint">
              AWS returned no accounts for this sign-in. Check that you approved the code as a user with accounts assigned in IAM Identity Center, and that the SSO region above is the Identity Center region. Or sign out and use the Named profile or Access keys method instead.
            </p>
          ) : null}

          {/* Role selector */}
          {selectedAccount ? (
            <Field label="IAM role">
              {(id) =>
                loadingRoles ? (
                  <Spinner />
                ) : (
                  <select
                    id={id}
                    className="input"
                    value={selectedRole}
                    onChange={(e) => setSelectedRole(e.target.value)}
                    aria-label="Select IAM role"
                  >
                    <option value="">Select a role…</option>
                    {(roles ?? []).map((r) => (
                      <option key={r.roleName} value={r.roleName}>
                        {r.roleName}
                      </option>
                    ))}
                  </select>
                )
              }
            </Field>
          ) : null}

          <div className="row">
            {selectedAccount && selectedRole ? (
              <Button
                variant="primary"
                busy={saving}
                onClick={saveSelection}
                disabled={selectedAccount === s.aws.ssoAccountId && selectedRole === s.aws.ssoRoleName}
              >
                Use this account &amp; role
              </Button>
            ) : null}
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </>
      ) : null}

      <ErrorNote error={flowError} onClose={() => setFlowError(null)} />
    </div>
  );
}
