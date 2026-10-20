import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, money, timeAgo } from '../lib/util.js';
import { useSortable } from '../lib/useSortable.js';
import { SortHeader } from '../components/SortHeader.jsx';
import { Badge, Button, ErrorNote, Field, Modal, Note, PageHeader, Spinner, Toggle, useUi } from '../components/ui.jsx';

const PROVIDERS = [
  { value: 'demo', title: 'Demo', body: 'Simulated agents. Free, no key needed. Use it to try every feature.' },
  { value: 'anthropic', title: 'Anthropic API', body: 'Pay per token with an API key from the Claude Console.' },
  { value: 'bedrock', title: 'Amazon Bedrock', body: 'Claude through your AWS account, billed by AWS.' },
  { value: 'kiro', title: 'Kiro CLI', body: 'Runs through kiro-cli on this server with its Kiro sign-in. Billed as Kiro credits.' },
];

/**
 * Current AWS commercial regions, sorted alphabetically by code.
 * Each entry: [regionCode, friendlyName]
 * Exported so that Repos.jsx and other pages can share them.
 */
export const AWS_REGIONS = [
  ['af-south-1', 'Africa (Cape Town)'],
  ['ap-east-1', 'Asia Pacific (Hong Kong)'],
  ['ap-northeast-1', 'Asia Pacific (Tokyo)'],
  ['ap-northeast-2', 'Asia Pacific (Seoul)'],
  ['ap-northeast-3', 'Asia Pacific (Osaka)'],
  ['ap-south-1', 'Asia Pacific (Mumbai)'],
  ['ap-south-2', 'Asia Pacific (Hyderabad)'],
  ['ap-southeast-1', 'Asia Pacific (Singapore)'],
  ['ap-southeast-2', 'Asia Pacific (Sydney)'],
  ['ap-southeast-3', 'Asia Pacific (Jakarta)'],
  ['ap-southeast-4', 'Asia Pacific (Melbourne)'],
  ['ap-southeast-5', 'Asia Pacific (Malaysia)'],
  ['ca-central-1', 'Canada (Central)'],
  ['ca-west-1', 'Canada West (Calgary)'],
  ['eu-central-1', 'Europe (Frankfurt)'],
  ['eu-central-2', 'Europe (Zurich)'],
  ['eu-north-1', 'Europe (Stockholm)'],
  ['eu-south-1', 'Europe (Milan)'],
  ['eu-south-2', 'Europe (Spain)'],
  ['eu-west-1', 'Europe (Ireland)'],
  ['eu-west-2', 'Europe (London)'],
  ['eu-west-3', 'Europe (Paris)'],
  ['il-central-1', 'Israel (Tel Aviv)'],
  ['me-central-1', 'Middle East (UAE)'],
  ['me-south-1', 'Middle East (Bahrain)'],
  ['mx-central-1', 'Mexico (Central)'],
  ['sa-east-1', 'South America (São Paulo)'],
  ['us-east-1', 'US East (N. Virginia)'],
  ['us-east-2', 'US East (Ohio)'],
  ['us-west-1', 'US West (N. California)'],
  ['us-west-2', 'US West (Oregon)'],
];

/**
 * A <select> for AWS regions.
 * Exported so that Repos.jsx and other pages can share it.
 * - If `value` is non-empty and not in the canonical list it is still shown as
 *   a selectable option so existing installs don't lose their saved value.
 */
export function RegionSelect({ id, value, onChange, className = 'input mono input-md', placeholder = 'Select a region…' }) {
  const knownCodes = AWS_REGIONS.map(([code]) => code);
  const showCustom = value && !knownCodes.includes(value);
  return (
    <select id={id} className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label="AWS region">
      <option value="" disabled>{placeholder}</option>
      {showCustom ? (
        <option value={value}>{value} (custom)</option>
      ) : null}
      {AWS_REGIONS.map(([code, name]) => (
        <option key={code} value={code}>{code} — {name}</option>
      ))}
    </select>
  );
}

const AWS_AUTH = [
  { value: 'ambient', label: 'Server’s own AWS identity', hint: 'An EC2 instance role, ECS task role, or environment variables. Recommended on AWS.' },
  { value: 'profile', label: 'Named profile', hint: 'A profile from ~/.aws on the server, including SSO profiles.' },
  { value: 'keys', label: 'Access keys', hint: 'An access key and secret, optionally with a session token. Stored encrypted.' },
  { value: 'bedrock-key', label: 'Bedrock API key', hint: 'A Bedrock-only API key. Not used for CodeCommit.' },
  { value: 'sso', label: 'AWS SSO (IAM Identity Center)', hint: 'Sign in with your browser. Temporary credentials, no ~/.aws profiles needed.' },
];

export function Settings() {
  const { user, reloadMeta } = useApp();
  const s = useLoad(() => api.get('/api/settings'), []);
  const usage = useLoad(() => api.get('/api/usage'), []);
  if (!user.is_admin) return <div className="page"><p>Only admins can change settings.</p></div>;
  if (s.error) return <div className="page"><ErrorNote error={s.error} /></div>;
  if (!s.data) return <div className="page"><Spinner /></div>;
  const reload = async () => {
    await s.reload(true);
    reloadMeta();
  };
  return (
    <div className="page">
      <PageHeader title="Settings" sub="How agents reach Claude, what they may spend, and who can sign in." />
      <div className="settings">
        <ProviderSection s={s.data} reload={reload} />
        <AwsSection s={s.data} reload={reload} />
        <ModelsSection s={s.data} reload={reload} />
        <SecretRow
          title="GitHub token"
          desc="Default token for GitHub repositories that have no token of their own. Fine-grained, with Contents and Pull requests read and write."
          name="github.token"
          info={s.data.secretsInfo['github.token']}
          reload={reload}
        />
        <BudgetSection s={s.data} usage={usage.data} reload={reload} />
        <AgentsSection s={s.data} reload={reload} />
        <SecretsSection s={s.data} reload={reload} />
        <Users />
      </div>
    </div>
  );
}

function useSave(reload) {
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async (patch, msg = 'Settings saved') => {
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/settings', patch);
      toast(msg);
      await reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, save };
}

function ProviderSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  return (
    <section className="panel">
      <h2>Model provider</h2>
      <div className="provider-pick" role="radiogroup" aria-label="Model provider">
        {PROVIDERS.map((p) => (
          <button
            key={p.value}
            type="button"
            role="radio"
            aria-checked={s.provider.mode === p.value}
            className={cx('provider', s.provider.mode === p.value && 'is-on')}
            onClick={() => s.provider.mode !== p.value && save({ provider: { mode: p.value } }, `Switched to ${p.title}`)}
            disabled={busy}
          >
            <strong>{p.title}</strong>
            <span>{p.body}</span>
          </button>
        ))}
      </div>
      {s.provider.mode === 'anthropic' ? (
        <SecretRow
          inline
          title="Anthropic API key"
          desc="Create one at platform.claude.com under API keys. Stored encrypted; never shown again."
          name="anthropic.api_key"
          info={s.secretsInfo['anthropic.api_key']}
          reload={reload}
        />
      ) : null}
      {s.provider.mode === 'bedrock' ? <p className="muted small">Set the AWS region and sign-in below. Enable the Claude models in the Bedrock console for that region first.</p> : null}
      {s.provider.mode === 'kiro' ? <KiroPanel s={s} reload={reload} /> : null}
      <ErrorNote error={error} />
      <div className="row">
        <Button
          busy={testing}
          onClick={async () => {
            setTesting(true);
            setTest(null);
            try {
              setTest(await api.post('/api/settings/test'));
            } catch (e) {
              setTest({ ok: false, error: e.message });
            } finally {
              setTesting(false);
            }
          }}
        >
          Test connection
        </Button>
        {test ? (
          test.ok ? (
            <span className="ok small">Connected. {s.provider.mode === 'kiro' ? 'Kiro' : 'Claude'} replied in {Math.round(test.ms / 100) / 10}s.</span>
          ) : (
            <span className="danger small">{test.error || `Unexpected reply: ${test.reply}`}</span>
          )
        ) : null}
      </div>
    </section>
  );
}

function KiroPanel({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [command, setCommand] = useState(s.kiro?.command ?? '');
  useEffect(() => setCommand(s.kiro?.command ?? ''), [s.kiro?.command]);
  const dirty = command !== (s.kiro?.command ?? '');
  return (
    <div className="stack">
      <Field label="kiro-cli path" hint="Leave blank to find kiro-cli on the server's PATH.">
        {(id) => (
          <input
            id={id}
            className="input mono input-md"
            value={command}
            onChange={(e) => setCommand(e.target.value.trim())}
            placeholder="kiro-cli (found on PATH)"
            aria-describedby="kiro-path-hint"
          />
        )}
      </Field>
      <SecretRow
        inline
        title="Kiro API key (optional)"
        desc="Only needed on headless servers that have no interactive kiro-cli sign-in. Requires Kiro Pro or above."
        name="kiro.api_key"
        info={s.secretsInfo['kiro.api_key']}
        reload={reload}
      />
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => save({ kiro: { command, models: s.kiro?.models ?? { sonnet: '', haiku: '', opus: '' } } })}>
          Save Kiro settings
        </Button>
      </div>
      <p className="muted small">
        Portal runs use their own Kiro agent profile — no MCP servers; file writes and shell commands ask for your approval. Each run signs in as the Kiro account the server is running as.
      </p>
    </div>
  );
}

function AwsSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [aws, setAws] = useState(s.aws);
  useEffect(() => setAws(s.aws), [s.aws]);
  const dirty = JSON.stringify(aws) !== JSON.stringify(s.aws);
  return (
    <section className="panel">
      <h2>AWS credentials for Bedrock</h2>
      <p className="muted small">Used only for the Amazon Bedrock model. A project can connect to its own AWS account under Project and team › AWS account.</p>
      <div className="stack">
        <Field label="Region">{(id) => <RegionSelect id={id} value={aws.region} onChange={(v) => setAws({ ...aws, region: v })} />}</Field>
        <Field label="How the server signs in" hint={AWS_AUTH.find((a) => a.value === aws.auth)?.hint}>
          {(id) => (
            <select id={id} className="input" value={aws.auth} onChange={(e) => setAws({ ...aws, auth: e.target.value })}>
              {AWS_AUTH.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {aws.auth === 'profile' ? (
          <Field label="Profile name">{(id) => <input id={id} className="input input-md" value={aws.profile} onChange={(e) => setAws({ ...aws, profile: e.target.value })} placeholder="dev-sso" />}</Field>
        ) : null}
        <ErrorNote error={error} />
        <div className="row">
          <Button variant="primary" disabled={!dirty} busy={busy} onClick={() => save({ aws })}>
            Save AWS settings
          </Button>
        </div>
        {aws.auth === 'keys' ? (
          <>
            <SecretRow inline title="Access key ID" name="aws.access_key_id" info={s.secretsInfo['aws.access_key_id']} reload={reload} />
            <SecretRow inline title="Secret access key" name="aws.secret_access_key" info={s.secretsInfo['aws.secret_access_key']} reload={reload} />
            <SecretRow inline title="Session token (optional)" desc="Only for temporary credentials. Replace it when it expires." name="aws.session_token" info={s.secretsInfo['aws.session_token']} reload={reload} />
          </>
        ) : null}
        {aws.auth === 'bedrock-key' ? <SecretRow inline title="Bedrock API key" name="aws.bedrock_api_key" info={s.secretsInfo['aws.bedrock_api_key']} reload={reload} /> : null}
        {aws.auth === 'sso' ? <SsoFlow s={s} reload={reload} /> : null}
      </div>
    </section>
  );
}

/** SSO device-authorisation flow panel, shown when auth === 'sso'. */
function SsoFlow({ s, reload }) {
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

function ModelsSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const isKiro = s.provider.mode === 'kiro';
  const sourceModels = isKiro ? (s.kiro?.models ?? { sonnet: '', haiku: '', opus: '' }) : s.provider.models;
  const [m, setM] = useState(sourceModels);
  useEffect(() => setM(isKiro ? (s.kiro?.models ?? { sonnet: '', haiku: '', opus: '' }) : s.provider.models), [s.provider.models, s.kiro?.models, isKiro]);
  const dirty = JSON.stringify(m) !== JSON.stringify(sourceModels);
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const canLoad = s.provider.mode !== 'demo';
  const loadModels = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get('/api/settings/models');
      setList(data.models);
    } catch (e) {
      setList(null);
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (canLoad) loadModels();
    else setList(null);
  }, [s.provider.mode, s.aws.region, s.aws.auth]);
  return (
    <section className="panel">
      <h2>Model versions</h2>
      <p className="muted small">
        {isKiro
          ? 'Agents ask for "sonnet", "haiku" or "opus". Leave these blank and Kiro will pick its newest model of that family.'
          : 'Agents ask for "sonnet", "haiku" or "opus". Leave these on the default to use the latest versions. On Bedrock, pick the model or inference profile your account has enabled.'}
      </p>
      <div className="model-grid">
        {['haiku', 'sonnet', 'opus'].map((k) => {
          const own = (list ?? []).filter((o) => o.family === k);
          const options = own.length ? own : list ?? [];
          const missing = m[k] && !options.some((o) => o.id === m[k]);
          const kiroPlaceholder = k === 'sonnet' ? 'claude-sonnet-5.5' : k === 'haiku' ? 'claude-haiku-4.5' : 'claude-opus-5.5';
          return (
            <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
              {(id) =>
                list ? (
                  <select id={id} className="input mono" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })}>
                    <option value="">{isKiro ? 'Kiro picks newest (default)' : 'Latest (default)'}</option>
                    {missing ? <option value={m[k]}>{m[k]} (current)</option> : null}
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name === o.id ? o.id : `${o.name} — ${o.id}`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input id={id} className="input mono" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value.trim() })} placeholder={isKiro ? kiroPlaceholder : s.provider.mode === 'bedrock' ? `global.anthropic.claude-${k}-...` : `claude-${k}-5-5`} />
                )
              }
            </Field>
          );
        })}
      </div>
      {loadError ? <p className="muted small">Could not load the model list ({loadError.message}). You can type the model IDs instead.</p> : null}
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" disabled={!dirty} busy={busy} onClick={() => save(isKiro ? { kiro: { command: s.kiro?.command ?? '', models: m } } : { provider: { models: m } })}>
          Save model versions
        </Button>
        {canLoad ? (
          <Button variant="ghost" busy={loading} onClick={loadModels}>
            Reload model list
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function BudgetSection({ s, usage, reload }) {
  const { busy, error, save } = useSave(reload);
  const [cap, setCap] = useState(s.budget.monthlyUsd ?? '');
  useEffect(() => setCap(s.budget.monthlyUsd ?? ''), [s.budget.monthlyUsd]);
  const used = usage?.totalUsd ?? s.usage.monthUsd;
  const pct = s.budget.monthlyUsd ? Math.min(100, Math.round((100 * used) / s.budget.monthlyUsd)) : null;

  const BUDGET_COLS = [
    { key: 'name',  label: 'Project', accessor: 'name', type: 'text' },
    { key: 'runs',  label: 'Runs',    accessor: 'runs', type: 'number' },
    { key: 'spend', label: 'Spend',   accessor: 'usd',  type: 'number' },
  ];
  const { sorted: sortedBudget, sortKey: bSortKey, sortDir: bSortDir, toggle: bToggle } = useSortable(
    usage?.byProject || [],
    { columns: BUDGET_COLS, storageKey: 'sort:settings:budget' }
  );

  return (
    <section className="panel">
      <h2>Budget</h2>
      <p className="lead-num">
        {money(used, 2)} <span className="muted">spent this month{s.budget.monthlyUsd ? ` of ${money(s.budget.monthlyUsd, 0)}` : ''}</span>
      </p>
      {pct !== null ? (
        <div className={cx('budget-bar', pct >= 90 && 'is-hot')}>
          <div style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <p className="muted small">New runs are refused once the cap is reached. Demo runs are free and do not count.</p>
      {s.provider.mode === 'kiro' ? <p className="muted small">Kiro runs are billed as Kiro credits, not dollars. This dollar cap does not apply to them.</p> : null}
      <div className="row">
        <Field label="Monthly cap in USD" hint="Empty means no cap.">
          {(id) => <input id={id} type="number" min={0} step={1} className="input input-num" value={cap} onChange={(e) => setCap(e.target.value)} />}
        </Field>
        <Button variant="primary" busy={busy} onClick={() => save({ budget: { monthlyUsd: cap === '' ? null : Number(cap) } })}>
          Save cap
        </Button>
      </div>
      <ErrorNote error={error} />
      {usage?.byProject?.length ? (
        <table className="table compact">
          <thead>
            <tr>
              <SortHeader col={BUDGET_COLS[0]} sortKey={bSortKey} sortDir={bSortDir} onSort={bToggle} />
              <SortHeader col={BUDGET_COLS[1]} sortKey={bSortKey} sortDir={bSortDir} onSort={bToggle} className="num" />
              <SortHeader col={BUDGET_COLS[2]} sortKey={bSortKey} sortDir={bSortDir} onSort={bToggle} className="num" />
            </tr>
          </thead>
          <tbody>
            {sortedBudget.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="num">{p.runs}</td>
                <td className="num">{money(p.usd, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function AgentsSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [a, setA] = useState(s.agents);
  useEffect(() => setA(s.agents), [s.agents]);
  return (
    <section className="panel">
      <h2>Agent defaults</h2>
      <div className="row wrap">
        <Field label="Changes, unless a run says otherwise">
          {(id) => (
            <select id={id} className="input" value={a.defaultPermissionMode} onChange={(e) => setA({ ...a, defaultPermissionMode: e.target.value })}>
              <option value="default">Ask before changes</option>
              <option value="acceptEdits">Auto-accept edits</option>
              <option value="plan">Plan only</option>
            </select>
          )}
        </Field>
        <Field label="Maximum turns per run" hint="Stops runaway runs.">
          {(id) => <input id={id} type="number" min={1} max={500} className="input input-num" value={a.maxTurns} onChange={(e) => setA({ ...a, maxTurns: Number(e.target.value) })} />}
        </Field>
      </div>
      <ErrorNote error={error} />
      <Button variant="primary" busy={busy} onClick={() => save({ agents: a })} disabled={JSON.stringify(a) === JSON.stringify(s.agents)}>
        Save defaults
      </Button>
    </section>
  );
}

function SecretsSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [x, setX] = useState(s.secrets);
  useEffect(() => setX(s.secrets), [s.secrets]);
  return (
    <section className="panel span-2">
      <h2>Where secrets are stored</h2>
      <div className="choice-row">
      <label className={cx('choice', x.mode === 'local' && 'is-checked')}>
        <input type="radio" name="secrets" checked={x.mode === 'local'} onChange={() => setX({ ...x, mode: 'local' })} />
        <span>
          <strong>Encrypted in the portal database</strong> <span className="muted">AES-256, key from PORTAL_SECRET_KEY or data/master.key. No extra cost.</span>
        </span>
      </label>
      <label className={cx('choice', x.mode === 'aws-ssm' && 'is-checked')}>
        <input type="radio" name="secrets" checked={x.mode === 'aws-ssm'} onChange={() => setX({ ...x, mode: 'aws-ssm' })} />
        <span>
          <strong>AWS Systems Manager Parameter Store</strong> <span className="muted">SecureString parameters, read with the server’s own AWS identity. Needs the AWS CLI.</span>
        </span>
      </label>
      </div>
      {x.mode === 'aws-ssm' ? (
        <div className="row">
          <Field label="Parameter prefix">{(id) => <input id={id} className="input mono" value={x.prefix} onChange={(e) => setX({ ...x, prefix: e.target.value })} />}</Field>
          <Field label="Region (optional)">{(id) => <input id={id} className="input mono" value={x.region} onChange={(e) => setX({ ...x, region: e.target.value.trim() })} />}</Field>
        </div>
      ) : null}
      <p className="muted small">Changing this applies to secrets you save from now on. Save each secret again to move it.</p>
      <ErrorNote error={error} />
      <Button variant="primary" busy={busy} disabled={JSON.stringify(x) === JSON.stringify(s.secrets)} onClick={() => save({ secrets: x })}>
        Save
      </Button>
      <p className="muted small">Data folder on the server: <code>{s.dataDir}</code></p>
    </section>
  );
}

function SecretRow({ title, desc, name, info, reload, inline }) {
  const { toast } = useUi();
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(!info?.set);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setEditing(!info?.set), [info?.set]);
  const body = (
    <>
      <div className="row between">
        <div>
          <strong>{title}</strong>
          {desc ? <p className="muted small">{desc}</p> : null}
        </div>
        {info?.set ? <Badge tone="ok">Saved {info.hint}</Badge> : <Badge tone="muted">Not set</Badge>}
      </div>
      {editing ? (
        <div className="row">
          <input className="input mono" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} aria-label={title} placeholder="Paste the value" />
          <Button
            variant="primary"
            busy={busy}
            disabled={!value.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post(`/api/settings/secrets/${name}`, { value });
                setValue('');
                toast(`${title} saved`);
                await reload();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
          {info?.set ? <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button> : null}
        </div>
      ) : (
        <div className="row tight">
          <Button size="sm" onClick={() => setEditing(true)}>
            Replace
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.del(`/api/settings/secrets/${name}`);
              toast(`${title} removed`);
              await reload();
            }}
          >
            Remove
          </Button>
          {info?.updatedAt ? <span className="muted small">updated {timeAgo(info.updatedAt)}</span> : null}
        </div>
      )}
      <ErrorNote error={error} />
    </>
  );
  return inline ? <div className="secret-row">{body}</div> : <section className="panel">{body}</section>;
}

function Users() {
  const { user } = useApp();
  const { toast, confirm } = useUi();
  const users = useLoad(() => api.get('/api/users'), []);
  const [adding, setAdding] = useState(false);
  const patch = async (u, body, msg) => {
    try {
      await api.patch(`/api/users/${u.id}`, body);
      toast(msg);
      users.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  const USER_COLS = [
    { key: 'name',   label: 'Name',   accessor: 'name',  type: 'text' },
    { key: 'email',  label: 'Email',  accessor: 'email', type: 'text' },
    { key: 'admin',  label: 'Admin',  accessor: (u) => u.is_admin ? 1 : 0, type: 'number' },
    { key: 'status', label: 'Status', accessor: (u) => u.disabled ? 'disabled' : 'active', type: 'status' },
  ];
  const { sorted: sortedUsers, sortKey: uSortKey, sortDir: uSortDir, toggle: uToggle } = useSortable(
    users.data?.users || [],
    { columns: USER_COLS, storageKey: 'sort:settings:users' }
  );

  return (
    <section className="panel span-2">
      <div className="row between">
        <h2>Users</h2>
        <Button icon="plus" onClick={() => setAdding(true)}>
          Add user
        </Button>
      </div>
      {users.data ? (
        <table className="table">
          <thead>
            <tr>
              <SortHeader col={USER_COLS[0]} sortKey={uSortKey} sortDir={uSortDir} onSort={uToggle} />
              <SortHeader col={USER_COLS[1]} sortKey={uSortKey} sortDir={uSortDir} onSort={uToggle} />
              <SortHeader col={USER_COLS[2]} sortKey={uSortKey} sortDir={uSortDir} onSort={uToggle} />
              <SortHeader col={USER_COLS[3]} sortKey={uSortKey} sortDir={uSortDir} onSort={uToggle} />
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="muted">{u.email}</td>
                <td>
                  <Toggle checked={Boolean(u.is_admin)} disabled={u.id === user.id} onChange={(on) => patch(u, { isAdmin: on }, on ? `${u.name} is now an admin` : `${u.name} is no longer an admin`)} label={<span className="sr-only">Admin</span>} />
                </td>
                <td>{u.disabled ? <Badge tone="muted">Disabled</Badge> : <Badge tone="ok">Active</Badge>}</td>
                <td className="actions">
                  {u.id !== user.id ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => patch(u, { disabled: !u.disabled }, u.disabled ? `${u.name} enabled` : `${u.name} disabled and signed out`)}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const pw = prompt(`New password for ${u.name} (at least 10 characters)`);
                          if (pw) patch(u, { password: pw }, 'Password reset');
                        }}
                      >
                        Reset password
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        onClick={async () => {
                          if (!(await confirm({ title: 'Delete user', message: `Delete ${u.name}? Their runs and answers stay.`, confirmLabel: 'Delete', danger: true }))) return;
                          await api.del(`/api/users/${u.id}`);
                          users.reload(true);
                        }}
                      >
                        Delete
                      </Button>
                    </>
                  ) : (
                    <span className="muted small">you</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Spinner />
      )}
      {adding ? <AddUser onClose={() => setAdding(false)} onAdded={() => users.reload(true)} /> : null}
    </section>
  );
}

function AddUser({ onClose, onAdded }) {
  const [f, setF] = useState({ name: '', email: '', password: '', isAdmin: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <Modal
      title="Add user"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post('/api/users', f);
                onAdded();
                onClose();
              } catch (e) {
                setError(e);
                setBusy(false);
              }
            }}
          >
            Add user
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">{(id) => <input id={id} className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Email">{(id) => <input id={id} type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="First password" hint="At least 10 characters. They can change it under their account.">
          {(id) => <input id={id} type="password" className="input" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}
        </Field>
        <Toggle checked={f.isAdmin} onChange={(isAdmin) => setF({ ...f, isAdmin })} label="Admin (can change settings and users)" />
        <Note tone="info">Add them to projects from each project’s team page.</Note>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
