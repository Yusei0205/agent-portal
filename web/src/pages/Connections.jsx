import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatRelative } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { DeviceCodeBox } from '../components/DeviceCodeBox.jsx';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { parseAwsCredentials } from '../lib/awsCredParser.js';
import { AwsRegionSelect } from '../components/AwsRegionSelect.jsx';
import { useBulkSelect } from '../lib/useBulkSelect.js';
import { BulkActionBar } from '../components/BulkActionBar.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../components/Toast.jsx';

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    id: 'github',
    label: 'GitHub',
    icon: 'source-control',
    description: 'Connect via GitHub OAuth device flow or a Personal Access Token.',
  },
  {
    id: 'codecommit',
    label: 'AWS CodeCommit',
    icon: 'cloud',
    description: 'Connect using AWS credentials, access keys, or Portal AWS SSO.',
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket Cloud',
    icon: 'branch',
    description: 'Connect using your Atlassian email and API token.',
  },
  {
    id: 'git',
    label: 'Other Git',
    icon: 'git-branch',
    description: 'Any HTTPS Git host using a token or username and password.',
  },
];

const PROVIDER_ICON = {
  github:     'source-control',
  codecommit: 'cloud',
  bitbucket:  'branch',
  git:        'git-branch',
};

const PROVIDER_LABEL = {
  github:     'GitHub',
  codecommit: 'CodeCommit',
  bitbucket:  'Bitbucket',
  git:        'Git',
};

const CC_CRED_SOURCES = [
  { value: 'keys',        label: 'Access key ID + secret' },
  { value: 'aws-account', label: 'Portal AWS account' },
  { value: 'portal-sso',  label: 'Portal AWS SSO identity' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatExpiry(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'session expired';
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return `expires in ${Math.floor(h / 24)}d`;
  if (h >= 1)  return `expires in ${h}h`;
  const m = Math.floor(ms / 60000);
  return `expires in ${m < 1 ? '<1' : m}m`;
}

// ── Provider picker ───────────────────────────────────────────────────────────

function ProviderPicker({ value, onChange }) {
  return (
    <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
      <legend style={{
        fontSize: '0.84rem', fontWeight: 600, color: 'var(--ink-2)',
        marginBottom: 10, float: 'left', width: '100%',
      }}>
        Provider
      </legend>
      <div className="provider-grid" role="group" aria-label="Select Git provider" style={{ clear: 'both' }}>
        {PROVIDERS.map((p) => (
          <label
            key={p.id}
            className={`provider-card${value === p.id ? ' is-selected' : ''}`}
          >
            <input
              type="radio"
              name="conn-provider"
              value={p.id}
              checked={value === p.id}
              onChange={() => onChange(p.id)}
            />
            <div className="provider-card-header">
              <span className="provider-card-icon" aria-hidden="true">
                <Icon name={p.icon} size={16} />
              </span>
              <span className="provider-card-name">{p.label}</span>
              <span className="provider-card-badges">
                <span className="provider-card-check" aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
              </span>
            </div>
            <span className="provider-card-desc">{p.description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ── GitHub form ───────────────────────────────────────────────────────────────

function GitHubForm({
  isEditing,
  githubMode, onGithubModeChange,
  githubDeviceFlowEnabled,
  flowPhase, challenge, pollStatus,
  onStartDeviceFlow, onCancelDeviceFlow, flowStarting,
  pat, onPatChange,
  flowAccount,
}) {
  if (isEditing) {
    return (
      <div className="field">
        <label htmlFor="gh-pat-edit">
          New personal access token{' '}
          <span className="muted" style={{ fontWeight: 400 }}>(optional — leave blank to keep existing)</span>
        </label>
        <input
          id="gh-pat-edit"
          type="password"
          value={pat}
          onChange={(e) => onPatChange(e.target.value)}
          placeholder="ghp_… (leave blank to keep existing)"
          autoComplete="off"
        />
        <p className="field-hint">
          Create a classic token at{' '}
          <a href="https://github.com/settings/tokens/new?scopes=repo,read:user" target="_blank" rel="noopener noreferrer">
            github.com/settings/tokens
          </a>
          {' '}with <code>repo</code> and <code>read:user</code> scopes.
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      {/* Auth mode selector */}
      <div>
        <p style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--ink-2)', marginBottom: 8 }}>
          Authentication method
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label className={`choice${githubMode === 'device' ? ' is-checked' : ''}${!githubDeviceFlowEnabled ? ' is-disabled' : ''}`}
            style={{ cursor: githubDeviceFlowEnabled ? 'pointer' : 'default', opacity: githubDeviceFlowEnabled ? 1 : 0.6 }}>
            <input
              type="radio"
              name="gh-mode"
              value="device"
              checked={githubMode === 'device'}
              onChange={() => { if (githubDeviceFlowEnabled) onGithubModeChange('device'); }}
              disabled={!githubDeviceFlowEnabled}
              aria-disabled={!githubDeviceFlowEnabled}
            />
            <div>
              <div style={{ fontSize: '0.87rem', fontWeight: 600 }}>Sign in with GitHub</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--ink-3)', marginTop: 2 }}>
                OAuth device flow — no token copy/paste
              </div>
            </div>
          </label>
          <label className={`choice${githubMode === 'pat' ? ' is-checked' : ''}`}>
            <input
              type="radio"
              name="gh-mode"
              value="pat"
              checked={githubMode === 'pat'}
              onChange={() => onGithubModeChange('pat')}
            />
            <div>
              <div style={{ fontSize: '0.87rem', fontWeight: 600 }}>Personal access token</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--ink-3)', marginTop: 2 }}>
                Paste a token from github.com
              </div>
            </div>
          </label>
        </div>
        {!githubDeviceFlowEnabled && (
          <p style={{ fontSize: '0.79rem', color: 'var(--ink-3)', marginTop: 6 }}>
            Device flow requires a GitHub OAuth App.{' '}
            <a href="#/settings" style={{ color: 'var(--link, var(--accent))' }}>
              Configure it in Settings → GitHub
            </a>.
          </p>
        )}
      </div>

      {/* Device flow */}
      {githubMode === 'device' && githubDeviceFlowEnabled && (
        <>
          {flowPhase === 'idle' && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onStartDeviceFlow}
              disabled={flowStarting}
              style={{ width: 'fit-content' }}
            >
              <Icon name="source-control" size={14} />
              {flowStarting ? 'Starting…' : 'Sign in with GitHub'}
            </button>
          )}
          {(flowPhase === 'authorizing' || pollStatus === 'complete') && challenge && (
            <>
              <DeviceCodeBox
                challenge={challenge}
                pollStatus={pollStatus}
                onCancel={onCancelDeviceFlow}
                heading="Authorize GitHub in your browser"
              />
              {flowAccount && (
                <p style={{ fontSize: '0.84rem', color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <Icon name="check" size={14} />
                  Connected as {flowAccount.login || flowAccount.email || flowAccount.name}
                </p>
              )}
            </>
          )}
        </>
      )}

      {/* PAT */}
      {githubMode === 'pat' && (
        <div className="field">
          <label htmlFor="gh-pat">Personal access token <span aria-hidden="true">*</span></label>
          <input
            id="gh-pat"
            type="password"
            value={pat}
            onChange={(e) => onPatChange(e.target.value)}
            placeholder="ghp_…"
            autoComplete="off"
            aria-required="true"
          />
          <p className="field-hint">
            Create a classic token at{' '}
            <a href="https://github.com/settings/tokens/new?scopes=repo,read:user" target="_blank" rel="noopener noreferrer">
              github.com/settings/tokens
            </a>
            {' '}— enable <code>repo</code> and <code>read:user</code> scopes.
          </p>
        </div>
      )}
    </div>
  );
}

// ── CodeCommit form ───────────────────────────────────────────────────────────

function CodeCommitForm({
  region, onRegionChange,
  credSource, onCredSourceChange,
  awsAccountId, onAwsAccountIdChange,
  accessKeyId, onAccessKeyIdChange,
  secretAccessKey, onSecretAccessKeyChange,
  sessionToken, onSessionTokenChange,
  hasSessionToken,           // true when an encrypted token is already stored (edit mode)
  onNamePrefill,             // callback(profileName) — fills the connection Name if blank
  isEditing,
  awsAccountGroups,    // null = not loaded, [] = loaded empty, [...] = loaded
  awsAccountsLoading,
  ssoSettings,         // provider.sso from GET /api/settings
}) {
  // ── Paste-area local state ─────────────────────────────────────────────────
  const [pasteText,     setPasteText]     = useState('');
  const [pasteFeedback, setPasteFeedback] = useState(null); // null | { type: 'ok'|'error', msg }

  function fillFromResult(result) {
    const filled = [];
    if (result.accessKeyId)     { onAccessKeyIdChange(result.accessKeyId);         filled.push('access key ID'); }
    if (result.secretAccessKey) { onSecretAccessKeyChange(result.secretAccessKey); filled.push('secret access key'); }
    if (result.sessionToken)    { onSessionTokenChange(result.sessionToken);        filled.push('session token'); }
    if (result.profileName && onNamePrefill) onNamePrefill(result.profileName);
    setPasteFeedback({ type: 'ok', msg: `Filled: ${filled.join(', ')}.` });
    setPasteText('');
  }

  function handlePasteEvent(e) {
    const pasted = (e.clipboardData || window.clipboardData)?.getData('text') ?? '';
    if (!pasted.trim()) return;
    e.preventDefault(); // take full control — we handle the textarea content ourselves
    const result = parseAwsCredentials(pasted);
    if (result) {
      fillFromResult(result);
    } else {
      setPasteText(pasted); // show what was pasted so the user can inspect / edit
      setPasteFeedback({ type: 'error', msg: 'No recognizable AWS credentials found.' });
    }
  }

  function handleFillButton() {
    if (!pasteText.trim()) return;
    const result = parseAwsCredentials(pasteText);
    if (result) {
      fillFromResult(result);
    } else {
      setPasteFeedback({ type: 'error', msg: 'No recognizable AWS credentials found.' });
    }
  }

  const isAsia = accessKeyId.startsWith('ASIA');

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="cc-region">AWS region <span aria-hidden="true">*</span></label>
        <AwsRegionSelect
          id="cc-region"
          value={region}
          onChange={(e) => onRegionChange(e.target.value)}
          required
          aria-required="true"
        />
      </div>

      {!isEditing && (
        <div>
          <p style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--ink-2)', marginBottom: 8 }}>
            Credential source
          </p>
          <div className="stack" style={{ gap: 6 }}>
            {CC_CRED_SOURCES.map((s) => (
              <label key={s.value} className={`choice${credSource === s.value ? ' is-checked' : ''}`}>
                <input
                  type="radio"
                  name="cc-cred-source"
                  value={s.value}
                  checked={credSource === s.value}
                  onChange={() => onCredSourceChange(s.value)}
                />
                <span style={{ fontSize: '0.87rem', fontWeight: 600 }}>{s.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {credSource === 'aws-account' && (
        <div className="field">
          <label htmlFor="cc-aws-account-id">
            Portal AWS account{' '}
            {isEditing && <span className="muted" style={{ fontWeight: 400 }}>(optional — leave blank to keep existing)</span>}
          </label>
          {awsAccountsLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.84rem', color: 'var(--ink-3)' }}>
              <div className="spinner" style={{ width: 14, height: 14 }} aria-label="Loading AWS accounts…" />
              Loading AWS accounts…
            </div>
          ) : awsAccountGroups === null || (awsAccountGroups && awsAccountGroups.length === 0) ? (
            <>
              <select id="cc-aws-account-id" disabled style={{ color: 'var(--ink-3)' }}>
                <option>No AWS accounts found</option>
              </select>
              <p className="field-hint" id="cc-aws-hint">
                Add an AWS account under{' '}
                <a href="#/connections/aws" style={{ color: 'var(--link, var(--accent))' }}>
                  Connections → AWS accounts
                </a>{' '}
                first.
              </p>
            </>
          ) : (
            <>
              <select
                id="cc-aws-account-id"
                value={awsAccountId}
                onChange={(e) => onAwsAccountIdChange(e.target.value)}
                aria-describedby="cc-aws-hint"
              >
                <option value="">— select an account —</option>
                {(awsAccountGroups || []).map((g) => (
                  <optgroup key={g.project.id} label={g.project.name}>
                    {g.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}{a.region ? ` · ${a.region}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="field-hint" id="cc-aws-hint">
                AWS account credentials will be used to authenticate with CodeCommit.
              </p>
            </>
          )}
        </div>
      )}

      {credSource === 'keys' && (
        <>
          {/* ── Paste area ── */}
          <div className="field">
            <label htmlFor="cc-paste">
              Paste from AWS access portal{' '}
              <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              id="cc-paste"
              value={pasteText}
              onChange={(e) => { setPasteText(e.target.value); setPasteFeedback(null); }}
              onPaste={handlePasteEvent}
              placeholder="Paste all lines from IAM Identity Center → Access keys (any format)…"
              rows={3}
              aria-describedby="cc-paste-hint"
              autoComplete="off"
              spellCheck={false}
            />
            {pasteText && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ justifySelf: 'start' }}
                onClick={handleFillButton}
              >
                Fill from pasted text
              </button>
            )}
            {pasteFeedback?.type === 'ok' && (
              <p style={{ fontSize: '0.79rem', color: 'var(--ok)', margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon name="check" size={12} />{pasteFeedback.msg}
              </p>
            )}
            {pasteFeedback?.type === 'error' && (
              <p className="field-error" role="alert">{pasteFeedback.msg}</p>
            )}
            <p className="field-hint" id="cc-paste-hint">
              Supports macOS/Linux, Windows CMD, PowerShell and credentials file formats.
            </p>
          </div>

          {/* ── Access key ID ── */}
          <div className="field">
            <label htmlFor="cc-key-id">
              Access key ID{isEditing && <span className="muted" style={{ fontWeight: 400 }}> (optional)</span>}
            </label>
            <input
              id="cc-key-id"
              type="text"
              value={accessKeyId}
              onChange={(e) => onAccessKeyIdChange(e.target.value)}
              placeholder="AKIA… or ASIA…"
              autoComplete="off"
            />
            {isAsia && (
              <p className="field-hint" style={{ color: 'var(--warn)', display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                <Icon name="warning" size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                Temporary credentials (ASIA… keys) expire, typically within 1–12 hours. For long-lived access use "Portal AWS SSO identity".
              </p>
            )}
          </div>

          {/* ── Secret access key ── */}
          <div className="field">
            <label htmlFor="cc-secret-key">
              Secret access key{isEditing && <span className="muted" style={{ fontWeight: 400 }}> (optional)</span>}
            </label>
            <input
              id="cc-secret-key"
              type="password"
              value={secretAccessKey}
              onChange={(e) => onSecretAccessKeyChange(e.target.value)}
              placeholder={isEditing ? 'Stored — leave blank to keep' : undefined}
              autoComplete="new-password"
            />
          </div>

          {/* ── Session token (optional; required for ASIA keys) ── */}
          <div className="field">
            <label htmlFor="cc-session-token">
              Session token{' '}
              <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              id="cc-session-token"
              type="password"
              value={sessionToken}
              onChange={(e) => onSessionTokenChange(e.target.value)}
              placeholder={isEditing && hasSessionToken ? 'Stored — leave blank to keep' : undefined}
              autoComplete="off"
            />
            {isAsia && !sessionToken && !(isEditing && hasSessionToken) && (
              <p className="field-error" role="alert">
                Temporary credentials (ASIA…) require a session token — paste fresh credentials or switch to "Portal AWS SSO identity".
              </p>
            )}
          </div>
        </>
      )}

      {credSource === 'portal-sso' && (
        <div className="sso-status-row">
          <Icon name="cloud" size={14} />
          <span style={{ fontSize: '0.84rem' }}>
            {ssoSettings?.signedIn ? (
              <>
                <span style={{ color: 'var(--ok)' }}>✓ Signed in</span>
                {ssoSettings.accountId && <> · {ssoSettings.accountId}</>}
                {ssoSettings.roleName  && <> · {ssoSettings.roleName}</>}
                {ssoSettings.expiresAt && <> · {formatExpiry(ssoSettings.expiresAt)}</>}
              </>
            ) : (
              <>
                Not signed in — go to{' '}
                <a href="#/settings" style={{ color: 'var(--link, var(--accent))' }}>
                  Settings › Provider › Amazon Bedrock › AWS SSO
                </a>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Bitbucket form ────────────────────────────────────────────────────────────

function BitbucketForm({ email, onEmailChange, apiToken, onApiTokenChange, workspace, onWorkspaceChange, isEditing }) {
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="bb-email">
          Atlassian email {isEditing && <span className="muted" style={{ fontWeight: 400 }}>(optional — leave blank to keep existing)</span>}
        </label>
        <input
          id="bb-email"
          type="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          aria-required={!isEditing}
        />
      </div>
      <div className="field">
        <label htmlFor="bb-token">
          API token {isEditing && <span className="muted" style={{ fontWeight: 400 }}>(optional — leave blank to keep existing)</span>}
        </label>
        <input
          id="bb-token"
          type="password"
          value={apiToken}
          onChange={(e) => onApiTokenChange(e.target.value)}
          placeholder="API token"
          autoComplete="off"
          aria-required={!isEditing}
        />
        <p className="field-hint">
          Create a token at{' '}
          <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">
            id.atlassian.com → Security → API tokens
          </a>.
          {' '}Note: app passwords are not supported here — use an API token.
        </p>
      </div>
      <div className="field">
        <label htmlFor="bb-workspace">Workspace <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
        <input
          id="bb-workspace"
          type="text"
          value={workspace}
          onChange={(e) => onWorkspaceChange(e.target.value)}
          placeholder="my-workspace"
        />
        <p className="field-hint">Leave blank to use the default workspace for this account.</p>
      </div>
    </div>
  );
}

// ── Generic Git form ──────────────────────────────────────────────────────────

function GenericGitForm({ token, onTokenChange, username, onUsernameChange, password, onPasswordChange, isEditing }) {
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="git-token">
          Access token {isEditing
            ? <span className="muted" style={{ fontWeight: 400 }}>(optional — leave blank to keep existing)</span>
            : <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>}
        </label>
        <input
          id="git-token"
          type="password"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="Personal access token"
          autoComplete="off"
        />
        <p className="field-hint">Preferred over username + password when both are available.</p>
      </div>
      {!token && (
        <>
          <div className="field">
            <label htmlFor="git-user">Username <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              id="git-user"
              type="text"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="git-pass">Password <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              id="git-pass"
              type="password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </>
      )}
    </div>
  );
}

// ── Connection modal ──────────────────────────────────────────────────────────

function ConnectionModal({ connection, onClose, onSave, githubDeviceFlowEnabled, isAdmin, ssoSettings }) {
  const dialogRef = useFocusTrap();

  const isEditing = Boolean(connection);

  // ── Common fields ─────────────────────────────────────────────────────────
  const [step,     setStep]     = useState(isEditing ? 'details' : 'provider');
  const [provider, setProvider] = useState(connection?.provider ?? 'github');
  const [name,     setName]     = useState(connection?.name ?? '');
  const [scope,    setScope]    = useState(connection?.scope ?? 'personal');
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState(null);

  // ── GitHub fields ─────────────────────────────────────────────────────────
  const [githubMode,    setGithubMode]    = useState('pat');
  const [githubPat,     setGithubPat]     = useState('');
  const [flowPhase,     setFlowPhase]     = useState('idle'); // idle|authorizing|done
  const [flowId,        setFlowId]        = useState(null);
  const [challenge,     setChallenge]     = useState(null);
  const [pollStatus,    setPollStatus]    = useState('pending');
  const [flowStarting,  setFlowStarting]  = useState(false);
  const [flowAccount,   setFlowAccount]   = useState(null); // account info after device flow
  const [flowConnection,setFlowConnection]= useState(null); // saved connection after device flow

  // ── CodeCommit fields ─────────────────────────────────────────────────────
  const [ccRegion,          setCcRegion]          = useState('us-east-1');
  const [ccCredSource,      setCcCredSource]      = useState('keys');
  const [ccAwsAccountId,    setCcAwsAccountId]    = useState('');
  const [ccAccessKeyId,     setCcAccessKeyId]     = useState('');
  const [ccSecretAccessKey, setCcSecretAccessKey] = useState('');
  const [ccSessionToken,    setCcSessionToken]    = useState('');

  // ── AWS accounts for CodeCommit aws-account dropdown ──────────────────────
  const [awsAccountGroups,   setAwsAccountGroups]   = useState(null); // null=not loaded
  const [awsAccountsLoading, setAwsAccountsLoading] = useState(false);

  // ── Bitbucket fields ──────────────────────────────────────────────────────
  const [bbEmail,     setBbEmail]     = useState('');
  const [bbApiToken,  setBbApiToken]  = useState('');
  const [bbWorkspace, setBbWorkspace] = useState('');

  // ── Generic Git fields ────────────────────────────────────────────────────
  const [gitToken,    setGitToken]    = useState('');
  const [gitUsername, setGitUsername] = useState('');
  const [gitPassword, setGitPassword] = useState('');

  // ── GitHub device flow polling ────────────────────────────────────────────
  useEffect(() => {
    if (flowPhase !== 'authorizing' || !flowId) return;
    let cancelled = false;
    let currentInterval = (challenge?.interval || 5) * 1000;
    let tid;

    const poll = async () => {
      if (cancelled) return;
      try {
        const result = await api.post('/api/git-connections/github/device/poll', { flowId });
        if (cancelled) return;

        // Honour slowDown / updated interval from server
        if (typeof result.interval === 'number' && result.interval > 0) {
          currentInterval = result.interval * 1000;
        }

        setPollStatus(result.status);

        if (result.status === 'complete') {
          setFlowPhase('done');
          const savedConn = result.connection;
          if (savedConn) {
            setFlowConnection(savedConn);
            // Show connected account info
            api.post(`/api/git-connections/${savedConn.id}/test`, {})
              .then((tr) => { if (!cancelled) setFlowAccount(tr.account ?? null); })
              .catch(() => {});
          }
          return; // stop polling
        }
        if (result.status === 'expired' || result.status === 'denied') {
          return; // stop polling
        }
      } catch {
        // Non-fatal — keep polling
      }
      if (!cancelled) {
        tid = setTimeout(poll, currentInterval);
      }
    };

    tid = setTimeout(poll, currentInterval);
    return () => { cancelled = true; clearTimeout(tid); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowPhase, flowId]);

  // ── Load AWS accounts for CodeCommit aws-account dropdown ─────────────────
  useEffect(() => {
    if (provider !== 'codecommit' || ccCredSource !== 'aws-account') return;
    if (awsAccountGroups !== null) return; // already loaded
    let cancelled = false;
    setAwsAccountsLoading(true);
    api.get('/api/projects')
      .then(async (r) => {
        const projects = r.projects || [];
        const groups = await Promise.all(
          projects.map(async (p) => {
            const ar = await api.get(`/api/projects/${p.id}/aws-accounts`).catch(() => ({ accounts: [] }));
            return { project: p, accounts: ar.accounts || [] };
          }),
        );
        if (!cancelled) setAwsAccountGroups(groups.filter((g) => g.accounts.length > 0));
      })
      .catch(() => { if (!cancelled) setAwsAccountGroups([]); })
      .finally(() => { if (!cancelled) setAwsAccountsLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, ccCredSource, awsAccountGroups]);

  const startDeviceFlow = async () => {
    if (!name.trim()) { setError('Please enter a connection name before signing in.'); return; }
    setFlowStarting(true);
    setError(null);
    try {
      const result = await api.post('/api/git-connections/github/device/start', {
        name: name.trim(),
        scope,
      });
      setFlowId(result.flowId);
      setChallenge(result);
      setPollStatus('pending');
      setFlowPhase('authorizing');
    } catch (err) {
      setError(err.message);
    } finally {
      setFlowStarting(false);
    }
  };

  const cancelDeviceFlow = () => {
    // When flow is done, "Close" in DeviceCodeBox should finalise saving the connection
    if (flowPhase === 'done' && flowConnection) {
      onSave(flowConnection);
      return;
    }
    setFlowPhase('idle');
    setFlowId(null);
    setChallenge(null);
    setPollStatus('pending');
    setFlowConnection(null);
    setFlowAccount(null);
  };

  // ── Escape to close ───────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Form submit ───────────────────────────────────────────────────────────
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required.'); return; }
    // Device flow completes via polling — no explicit submit needed
    if (provider === 'github' && githubMode === 'device' && !isEditing) return;

    setSaving(true);
    setError(null);

    let credentials;
    if (provider === 'github') {
      if (githubPat.trim()) credentials = { token: githubPat.trim() };
    } else if (provider === 'codecommit') {
      // Block ASIA keys submitted without a session token.
      if (ccCredSource === 'keys' && ccAccessKeyId.trim().startsWith('ASIA') && !ccSessionToken.trim()) {
        const hasStored = isEditing && Boolean(connection?.hasSessionToken);
        if (!hasStored) {
          setError('ASIA keys are temporary credentials — a session token is required. Paste fresh credentials from IAM Identity Center or switch to "Portal AWS SSO identity".');
          setSaving(false);
          return;
        }
      }
      credentials = {
        mode: ccCredSource,
        region: ccRegion.trim() || 'us-east-1',
        ...(ccCredSource === 'keys' ? {
          accessKeyId:     ccAccessKeyId.trim(),
          secretAccessKey: ccSecretAccessKey,
          sessionToken:    ccSessionToken.trim(),
        } : {}),
        ...(ccCredSource === 'aws-account' ? { awsAccountId: ccAwsAccountId.trim() } : {}),
      };
    } else if (provider === 'bitbucket') {
      if (!isEditing && (!bbEmail.trim() || !bbApiToken.trim())) {
        setError('Email and API token are required.');
        setSaving(false);
        return;
      }
      credentials = {
        ...(bbEmail.trim()     ? { email: bbEmail.trim() }         : {}),
        ...(bbApiToken.trim()  ? { apiToken: bbApiToken.trim() }   : {}),
        ...(bbWorkspace.trim() ? { workspace: bbWorkspace.trim() } : {}),
      };
    } else if (provider === 'git') {
      if (gitToken.trim()) credentials = { token: gitToken.trim() };
      else if (gitUsername.trim()) credentials = { username: gitUsername.trim(), password: gitPassword };
    }

    try {
      const body = {
        name: name.trim(),
        scope,
        ...(credentials ? { credentials } : {}),
      };
      const r = isEditing
        ? await api.put(`/api/git-connections/${connection.id}`, body)
        : await api.post('/api/git-connections', { ...body, provider });
      onSave(r.connection);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  const isDeviceFlowNew = provider === 'github' && githubMode === 'device' && !isEditing;
  const isFlowRunning   = flowPhase === 'authorizing';

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conn-modal-title"
    >
      <div
        className={`modal${step === 'details' ? ' modal-wide' : ''}`}
        ref={dialogRef}
      >
        <div className="modal-header">
          <h2 id="conn-modal-title">
            {isEditing
              ? `Edit — ${PROVIDER_LABEL[connection.provider] || connection.provider}`
              : step === 'provider'
                ? 'New Git connection'
                : `New ${PROVIDER_LABEL[provider] || provider} connection`}
          </h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* ── Step 1: choose provider ────────────────────────────────── */}
        {step === 'provider' && !isEditing && (
          <div className="stack">
            <ProviderPicker value={provider} onChange={setProvider} />
            {error && <p className="error-note" role="alert">{error}</p>}
            <div className="modal-footer" style={{ marginTop: 0 }}>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep('details')}
              >
                Continue
                <Icon name="chevron-right" size={14} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: credential details ─────────────────────────────── */}
        {step === 'details' && (
          <form onSubmit={submit} noValidate>
            <div className="stack">
              <div className="field">
                <label htmlFor="conn-name">Name <span aria-hidden="true">*</span></label>
                <input
                  id="conn-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. My GitHub"
                  autoFocus={!isEditing}
                  aria-required="true"
                />
              </div>

              <div className="field">
                <label htmlFor="conn-scope">Scope</label>
                <select
                  id="conn-scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="personal">Personal</option>
                  <option value="shared" disabled={!isAdmin}>
                    Shared{!isAdmin ? ' (admin only)' : ''}
                  </option>
                </select>
                <p className="field-hint">
                  Personal connections are only visible to you. Shared connections are available to all users.
                </p>
              </div>

              {/* Provider-specific fields */}
              {provider === 'github' && (
                <GitHubForm
                  isEditing={isEditing}
                  githubMode={githubMode}
                  onGithubModeChange={setGithubMode}
                  githubDeviceFlowEnabled={githubDeviceFlowEnabled}
                  flowPhase={flowPhase}
                  challenge={challenge}
                  pollStatus={pollStatus}
                  onStartDeviceFlow={startDeviceFlow}
                  onCancelDeviceFlow={cancelDeviceFlow}
                  flowStarting={flowStarting}
                  pat={githubPat}
                  onPatChange={setGithubPat}
                  flowAccount={flowAccount}
                />
              )}
              {provider === 'codecommit' && (
                <CodeCommitForm
                  region={ccRegion}
                  onRegionChange={setCcRegion}
                  credSource={ccCredSource}
                  onCredSourceChange={setCcCredSource}
                  awsAccountId={ccAwsAccountId}
                  onAwsAccountIdChange={setCcAwsAccountId}
                  accessKeyId={ccAccessKeyId}
                  onAccessKeyIdChange={setCcAccessKeyId}
                  secretAccessKey={ccSecretAccessKey}
                  onSecretAccessKeyChange={setCcSecretAccessKey}
                  sessionToken={ccSessionToken}
                  onSessionTokenChange={setCcSessionToken}
                  hasSessionToken={Boolean(connection?.hasSessionToken)}
                  onNamePrefill={(profileName) => { if (!name.trim()) setName(profileName); }}
                  isEditing={isEditing}
                  awsAccountGroups={awsAccountGroups}
                  awsAccountsLoading={awsAccountsLoading}
                  ssoSettings={ssoSettings}
                />
              )}
              {provider === 'bitbucket' && (
                <BitbucketForm
                  email={bbEmail}
                  onEmailChange={setBbEmail}
                  apiToken={bbApiToken}
                  onApiTokenChange={setBbApiToken}
                  workspace={bbWorkspace}
                  onWorkspaceChange={setBbWorkspace}
                  isEditing={isEditing}
                />
              )}
              {provider === 'git' && (
                <GenericGitForm
                  token={gitToken}
                  onTokenChange={setGitToken}
                  username={gitUsername}
                  onUsernameChange={setGitUsername}
                  password={gitPassword}
                  onPasswordChange={setGitPassword}
                  isEditing={isEditing}
                />
              )}

              {error && <p className="error-note" role="alert">{error}</p>}
            </div>

            <div className="modal-footer">
              {!isEditing && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => { setStep('provider'); setError(null); }}
                  disabled={isFlowRunning}
                >
                  <Icon name="chevron-left" size={14} />
                  Back
                </button>
              )}
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              {/* For GitHub device flow, form submit is not used — polling completes it */}
              {!isDeviceFlowNew && (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving}
                >
                  {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Create connection'}
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function Connections({ user }) {
  const [connections,  setConnections]  = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [modal,        setModal]        = useState(null); // null | 'new' | { connection }
  const [testResults,  setTestResults]  = useState({}); // id → { ok, account?, error? }
  const [testing,      setTesting]      = useState({}); // id → bool
  const [deleteId,     setDeleteId]     = useState(null);
  const [deleteError,  setDeleteError]  = useState(null);
  const [githubDeviceFlowEnabled, setGithubDeviceFlowEnabled] = useState(false);
  const [ssoSettings, setSsoSettings] = useState(null);
  const [testUrls, setTestUrls] = useState({}); // id → url string for generic git tests
  const [bulkBusy, setBulkBusy] = useState(false);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();
  const bulk = useBulkSelect(connections);

  const isAdmin = Boolean(user?.is_admin);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [connsR, settingsR] = await Promise.all([
        api.get('/api/git-connections'),
        api.get('/api/settings').catch(() => ({})),
      ]);
      setConnections(connsR.connections || []);
      setGithubDeviceFlowEnabled(Boolean(settingsR?.github?.deviceFlowEnabled));
      setSsoSettings(settingsR?.provider?.sso ?? null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const testConnection = async (conn, testUrl) => {
    setTesting((t) => ({ ...t, [conn.id]: true }));
    setTestResults((r) => ({ ...r, [conn.id]: null }));
    try {
      const body = testUrl ? { url: testUrl } : {};
      const result = await api.post(`/api/git-connections/${conn.id}/test`, body);
      setTestResults((r) => ({ ...r, [conn.id]: result }));
    } catch (e) {
      setTestResults((r) => ({ ...r, [conn.id]: { ok: false, error: e.message } }));
    } finally {
      setTesting((t) => ({ ...t, [conn.id]: false }));
    }
  };

  const deleteConnection = async (id) => {
    setDeleteError(null);
    try {
      await api.delete(`/api/git-connections/${id}`);
      setConnections((prev) => prev.filter((c) => c.id !== id));
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleteId(null);
    }
  };

  const handleBulkDelete = async () => {
    const n = bulk.selected.size;
    if (!await requestConfirm(
      `Delete ${n} connection${n === 1 ? '' : 's'}? This cannot be undone.`,
      'Delete', 'danger',
    )) return;
    setBulkBusy(true);
    const ids = [...bulk.selected];
    const failed = [];
    await Promise.all(ids.map(async (id) => {
      try {
        await api.delete(`/api/git-connections/${id}`);
      } catch {
        failed.push(id);
      }
    }));
    setConnections((prev) => prev.filter((c) => !ids.includes(c.id) || failed.includes(c.id)));
    bulk.clearAll();
    if (failed.length > 0) toast(`${failed.length} connection${failed.length === 1 ? '' : 's'} could not be deleted.`, 'error');
    setBulkBusy(false);
  };

  const handleSave = (saved) => {
    setConnections((prev) => {
      const idx = prev.findIndex((c) => c.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
    setModal(null);
  };

  return (
    <>
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
      <div className="page-actions" style={{ marginBottom: '0.5rem' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setModal('new')}
        >
          <Icon name="plus" size={14} />
          New connection
        </button>
      </div>

      <p className="muted" style={{ fontSize: '0.84rem' }}>
        Saved Git credentials shared across all projects.
      </p>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--ink-3)', fontSize: '0.84rem' }}>
          <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading connections…" />
          Loading…
        </div>
      )}
      {error && (
        <div>
          <p className="error-note" role="alert">{error}</p>
          <button type="button" className="btn" style={{ marginTop: 8 }} onClick={load}>Retry</button>
        </div>
      )}
      {deleteError && (
        <p className="error-note" role="alert">{deleteError}</p>
      )}

      {!loading && !error && connections.length === 0 && (
        <div className="card">
          <p className="muted">No connections yet. Click <strong>New connection</strong> to add one.</p>
        </div>
      )}

      {!loading && connections.length > 0 && (
        <div style={{ position: 'relative' }}>
          <table className="data-table" aria-label="Git connections">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all connections"
                    checked={bulk.allSelected}
                    ref={(el) => { if (el) el.indeterminate = bulk.someSelected; }}
                    onChange={bulk.toggleAll}
                  />
                </th>
                <th>Name</th>
                <th>Provider</th>
                <th>Scope</th>
                <th>Account</th>
                <th>Created</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {connections.map((conn) => {
                const result  = testResults[conn.id];
                const account = result?.account;
                return (
                  <tr key={conn.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${conn.name}`}
                        checked={bulk.selected.has(conn.id)}
                        onChange={() => bulk.toggle(conn.id)}
                      />
                    </td>
                    <td style={{ fontWeight: 600 }}>{conn.name}</td>
                  <td style={{ fontWeight: 600 }}>{conn.name}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="conn-provider-icon" aria-hidden="true">
                        <Icon name={PROVIDER_ICON[conn.provider] || 'branch'} size={12} />
                      </span>
                      <span className={`badge ${conn.provider === 'github' ? 'badge-info' : 'badge-neutral'}`}>
                        {PROVIDER_LABEL[conn.provider] || conn.provider}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${conn.scope === 'shared' ? 'badge-info' : 'badge-neutral'}`}>
                      {conn.scope}
                    </span>
                  </td>
                  <td>
                    {conn.provider === 'git' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <input
                          type="url"
                          value={testUrls[conn.id] || ''}
                          onChange={(e) => setTestUrls((p) => ({ ...p, [conn.id]: e.target.value }))}
                          placeholder="https://… (test URL)"
                          style={{ fontSize: '0.79rem', minWidth: 0, width: '100%', maxWidth: 240 }}
                          aria-label={`Test repository URL for ${conn.name}`}
                        />
                        {result && !result.ok && (
                          <span className="conn-test-err small" title={result.error}>
                            {result.error || 'Test failed'}
                          </span>
                        )}
                      </div>
                    ) : (
                      <>
                        {account && (
                          <span className="conn-account" title={account.name}>
                            {account.login || account.email || account.name}
                          </span>
                        )}
                        {result && !account && result.ok === false && (
                          <span className="conn-test-err" title={result.error}>
                            {result.error || 'Test failed'}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="muted">{formatRelative(conn.created_at)}</td>
                  <td>
                    <div className="row tight">
                      {result?.ok && (
                        <span className="conn-test-ok" role="status" aria-label="Connection test passed">
                          ✓ OK
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => testConnection(conn, conn.provider === 'git' ? (testUrls[conn.id] || undefined) : undefined)}
                        disabled={testing[conn.id]}
                        aria-label={`Test connection ${conn.name}`}
                      >
                        {testing[conn.id] ? 'Testing…' : 'Test'}
                      </button>
                      <button
                        type="button"
                        className="btn-icon"
                        title="Edit"
                        aria-label={`Edit ${conn.name}`}
                        onClick={() => setModal({ connection: conn })}
                      >
                        <Icon name="edit" size={14} />
                      </button>
                      {deleteId === conn.id ? (
                        <div className="row tight" role="group" aria-label={`Confirm delete ${conn.name}`}>
                          <span style={{ fontSize: '0.79rem', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>
                            Delete?
                          </span>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => deleteConnection(conn.id)}
                            autoFocus
                          >
                            Yes, delete
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn-icon"
                          title="Delete"
                          aria-label={`Delete ${conn.name}`}
                          onClick={() => setDeleteId(conn.id)}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <BulkActionBar
          selected={bulk.selected}
          onDelete={handleBulkDelete}
          onClear={bulk.clearAll}
          busy={bulkBusy}
          noun="connection"
        />
        </div>
      )}

      {modal && (
        <ConnectionModal
          connection={modal === 'new' ? null : modal.connection}
          onClose={() => setModal(null)}
          onSave={handleSave}
          githubDeviceFlowEnabled={githubDeviceFlowEnabled}
          isAdmin={isAdmin}
          ssoSettings={ssoSettings}
        />
      )}
    </>
  );
}

export default Connections;
