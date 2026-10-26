import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { href } from '../lib/router.js';
import { timeAgo } from '../lib/util.js';
import { useLoad } from '../lib/useAsync.js';
import { Icon } from '../components/Icon.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Modal, Note, PageHeader, Spinner, useUi } from '../components/ui.jsx';
import { RegionSelect } from './Settings.jsx';

/* ── helpers ──────────────────────────────────────────────────── */

function shortAccount(account) {
  if (!account) return null;
  return account.length > 8 ? account.slice(0, 6) + '…' : account;
}

/* ── Connection form (add / edit) ─────────────────────────────── */

const AUTH_OPTIONS = [
  { value: 'ambient', label: "Server's own AWS identity", hint: 'EC2 instance role, ECS task role, or environment variables. Recommended on AWS.' },
  { value: 'profile', label: 'Named profile', hint: 'A profile from ~/.aws on the server, including SSO profiles.' },
  { value: 'keys', label: 'Access keys', hint: 'An access key and secret, optionally with a session token. Stored encrypted.' },
  { value: 'sso', label: 'AWS SSO account and role', hint: 'Sign in under Settings › Amazon Bedrock › AWS SSO first.' },
];

/**
 * Parse a pasted AWS credentials block in any of the three standard formats:
 *
 *   1. AWS Console "Export credentials" / aws configure export:
 *      [default]
 *      aws_access_key_id = ASIA...
 *      aws_secret_access_key = ...
 *      aws_session_token = ...
 *
 *   2. AWS CLI environment-variable block (shown in the Console after assuming a role):
 *      export AWS_ACCESS_KEY_ID=ASIA...
 *      export AWS_SECRET_ACCESS_KEY=...
 *      export AWS_SESSION_TOKEN=...
 *
 *   3. Windows cmd set block:
 *      set AWS_ACCESS_KEY_ID=ASIA...
 *      set AWS_SECRET_ACCESS_KEY=...
 *      set AWS_SESSION_TOKEN=...
 *
 *   4. Raw JSON (from aws sts assume-role --output json):
 *      {"AccessKeyId":"ASIA...","SecretAccessKey":"...","SessionToken":"...","Expiration":"..."}
 *      or nested under "Credentials": { ... }
 *
 * Returns { accessKeyId, secretAccessKey, sessionToken } with empty strings for anything not found.
 */
function parseCredentialsBlock(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  // JSON
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t);
      const creds = obj.Credentials ?? obj.credentials ?? obj;
      const keyId = creds.AccessKeyId ?? creds.access_key_id ?? creds.accessKeyId ?? '';
      const secret = creds.SecretAccessKey ?? creds.secret_access_key ?? creds.secretAccessKey ?? '';
      const token = creds.SessionToken ?? creds.session_token ?? creds.sessionToken ?? '';
      if (keyId) return { accessKeyId: keyId.trim(), secretAccessKey: secret.trim(), sessionToken: token.trim() };
    } catch {
      // not JSON
    }
  }

  // Ini / export / set  — case-insensitive key matching
  const patterns = [
    // ini: aws_access_key_id = VALUE
    [/aws_access_key_id\s*=\s*(\S+)/i, /aws_secret_access_key\s*=\s*(\S+)/i, /aws_session_token\s*=\s*(\S+)/i],
    // export/set: AWS_ACCESS_KEY_ID=VALUE
    [/AWS_ACCESS_KEY_ID[=\s]+(\S+)/i, /AWS_SECRET_ACCESS_KEY[=\s]+(\S+)/i, /AWS_SESSION_TOKEN[=\s]+(\S+)/i],
  ];
  for (const [keyRe, secretRe, tokenRe] of patterns) {
    const keyMatch = t.match(keyRe);
    const secretMatch = t.match(secretRe);
    if (keyMatch && secretMatch) {
      const tokenMatch = t.match(tokenRe);
      return {
        accessKeyId: keyMatch[1].trim(),
        secretAccessKey: secretMatch[1].trim(),
        sessionToken: tokenMatch ? tokenMatch[1].trim() : '',
      };
    }
  }
  return null;
}

/** The access-key fields with an optional "paste credentials block" shortcut. */
function KeysFields({ form, setForm, isEdit, initial }) {
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState('');

  function applyPaste() {
    const parsed = parseCredentialsBlock(pasteText);
    if (!parsed) {
      setPasteError('Could not read these credentials. Paste the full block from the AWS Console, CLI, or aws sts assume-role output.');
      return;
    }
    setForm((f) => ({
      ...f,
      accessKeyId: parsed.accessKeyId || f.accessKeyId,
      secretAccessKey: parsed.secretAccessKey || f.secretAccessKey,
      sessionToken: parsed.sessionToken,
    }));
    setPasteText('');
    setPasteError('');
    setShowPaste(false);
  }

  return (
    <div className="stack">
      {/* Paste shortcut toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => { setShowPaste((v) => !v); setPasteError(''); }}
          aria-expanded={showPaste}
        >
          {showPaste ? '▲ Hide paste block' : '▼ Paste credentials block'}
        </button>
        <span className="muted small">Paste all three values at once from the AWS Console or CLI.</span>
      </div>

      {showPaste ? (
        <div className="stack" style={{ padding: '0.75rem', background: 'var(--bg-raised, #f5f5f5)', borderRadius: '6px', border: '1px solid var(--border)' }}>
          <p className="muted small" style={{ margin: 0 }}>
            Paste any of these formats:
          </p>
          <ul className="muted small" style={{ margin: '0.25rem 0 0.5rem 1.25rem', lineHeight: 1.6 }}>
            <li>AWS Console <strong>Export credentials</strong> block (ini format)</li>
            <li><code>export AWS_ACCESS_KEY_ID=…</code> lines from the CLI</li>
            <li>JSON from <code>aws sts assume-role --output json</code></li>
          </ul>
          <textarea
            className="input mono"
            rows={6}
            value={pasteText}
            onChange={(e) => { setPasteText(e.target.value); setPasteError(''); }}
            placeholder={`[default]\naws_access_key_id = ASIA...\naws_secret_access_key = ...\naws_session_token = ...`}
            autoComplete="off"
            spellCheck={false}
            style={{ fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
          />
          {pasteError ? <p className="note note-warn small" style={{ margin: 0 }}>{pasteError}</p> : null}
          <div className="row tight">
            <button type="button" className="btn btn-sm btn-primary" onClick={applyPaste}>
              Fill fields
            </button>
            <button type="button" className="btn btn-sm" onClick={() => { setShowPaste(false); setPasteError(''); setPasteText(''); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* Individual fields */}
      <Field
        label={
          isEdit && initial?.accessKey?.set
            ? `Access key ID (saved${initial.accessKey.hint ? `, ${initial.accessKey.hint}` : ''}; type to replace)`
            : 'Access key ID'
        }
      >
        {(id) => (
          <input
            id={id}
            className="input mono input-md"
            value={form.accessKeyId}
            autoComplete="off"
            onChange={(e) => setForm((f) => ({ ...f, accessKeyId: e.target.value.trim() }))}
            placeholder={isEdit && initial?.accessKey?.set ? '••••••••••••••••' : 'AKIA… or ASIA…'}
          />
        )}
      </Field>
      <Field label={isEdit ? 'Secret access key (saved; type to replace)' : 'Secret access key'}>
        {(id) => (
          <input
            id={id}
            type="password"
            className="input mono input-md"
            value={form.secretAccessKey}
            autoComplete="off"
            onChange={(e) => setForm((f) => ({ ...f, secretAccessKey: e.target.value.trim() }))}
            placeholder={isEdit ? '••••••••••••••••' : ''}
          />
        )}
      </Field>
      <Field
        label="Session token (only for temporary credentials)"
        hint="Replace the keys and the token together when temporary credentials expire."
      >
        {(id) => (
          <input
            id={id}
            type="password"
            className="input mono input-md"
            value={form.sessionToken}
            autoComplete="off"
            onChange={(e) => setForm((f) => ({ ...f, sessionToken: e.target.value.trim() }))}
            placeholder={form.sessionToken ? '••••••••••••••••' : ''}
          />
        )}
      </Field>
    </div>
  );
}

function ConnectionForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(() => ({
    name: initial?.name ?? '',
    auth: initial?.auth ?? 'ambient',
    region: initial?.region ?? '',
    profile: initial?.profile ?? '',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    ssoAccountId: initial?.ssoAccountId ?? '',
    ssoRoleName: initial?.ssoRoleName ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [checkResult, setCheckResult] = useState(null); // { ok, account, arn, error }

  // Profile autocomplete
  const [profiles, setProfiles] = useState(null);
  useEffect(() => {
    if (form.auth === 'profile' && profiles === null) {
      api.get('/api/aws/profiles').then((r) => setProfiles(r.profiles)).catch(() => setProfiles([]));
    }
  }, [form.auth, profiles]);

  // SSO accounts/roles
  const [ssoSignedIn, setSsoSignedIn] = useState(null);
  const [ssoAccounts, setSsoAccounts] = useState(null);
  const [ssoRoles, setSsoRoles] = useState(null);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingRoles, setLoadingRoles] = useState(false);

  useEffect(() => {
    if (form.auth !== 'sso') return;
    if (ssoAccounts !== null) return;
    checkSsoAndLoadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.auth]);

  useEffect(() => {
    if (form.auth !== 'sso' || !form.ssoAccountId) return;
    loadSsoRoles(form.ssoAccountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.ssoAccountId]);

  async function checkSsoAndLoadAccounts() {
    try {
      const s = await api.get('/api/settings');
      const signedIn = Boolean(s.ssoStatus?.signedIn);
      setSsoSignedIn(signedIn);
      if (signedIn) {
        setLoadingAccounts(true);
        const data = await api.get('/api/sso/accounts');
        setSsoAccounts(data.accounts);
        if (data.accounts.length === 1 && !form.ssoAccountId) {
          setForm((f) => ({ ...f, ssoAccountId: data.accounts[0].accountId }));
        }
      }
    } catch {
      setSsoSignedIn(false);
    } finally {
      setLoadingAccounts(false);
    }
  }

  async function loadSsoRoles(accountId) {
    setLoadingRoles(true);
    setSsoRoles(null);
    try {
      const data = await api.get(`/api/sso/roles?accountId=${encodeURIComponent(accountId)}`);
      setSsoRoles(data.roles);
      if (data.roles.length === 1 && !form.ssoRoleName) {
        setForm((f) => ({ ...f, ssoRoleName: data.roles[0].roleName }));
      }
    } catch {
      setSsoRoles([]);
    } finally {
      setLoadingRoles(false);
    }
  }

  const isEdit = Boolean(initial);
  const profilesListId = 'aws-profiles-list';

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCheckResult(null);
    try {
      const body = {
        name: form.name,
        auth: form.auth,
        region: form.region,
      };
      if (form.auth === 'profile') body.profile = form.profile;
      if (form.auth === 'keys') {
        if (form.accessKeyId) body.accessKeyId = form.accessKeyId;
        if (form.secretAccessKey) body.secretAccessKey = form.secretAccessKey;
        if (form.sessionToken) body.sessionToken = form.sessionToken;
      }
      if (form.auth === 'sso') {
        body.ssoAccountId = form.ssoAccountId;
        body.ssoRoleName = form.ssoRoleName;
      }

      let result;
      if (isEdit) {
        result = await api.put(`/api/aws/connections/${initial.id}`, body);
      } else {
        result = await api.post('/api/aws/connections', body);
      }
      setCheckResult(result.check);
      await onSave(result.connection, result.check);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    form.name.trim() &&
    form.region &&
    (form.auth !== 'profile' || form.profile.trim()) &&
    (form.auth !== 'sso' || (form.ssoAccountId && form.ssoRoleName));

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Field label="Name">
        {(id) => (
          <input
            id={id}
            className="input input-md"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Production, Staging…"
            required
            autoFocus
          />
        )}
      </Field>

      {/* Auth method */}
      <fieldset className="stack" style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="field-label">Sign-in method</legend>
        <div className="stack" style={{ gap: '0.5rem' }}>
          {AUTH_OPTIONS.map((opt) => (
            <label key={opt.value} className="radio-row">
              <input
                type="radio"
                name="auth-method"
                value={opt.value}
                checked={form.auth === opt.value}
                onChange={() => setForm({ ...form, auth: opt.value, ssoAccountId: '', ssoRoleName: '' })}
              />
              <span>
                <strong>{opt.label}</strong>
                <span className="muted small"> — {opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Region */}
      <Field label="Region">
        {(id) => (
          <RegionSelect
            id={id}
            value={form.region}
            onChange={(v) => setForm({ ...form, region: v })}
          />
        )}
      </Field>

      {/* Named profile */}
      {form.auth === 'profile' ? (
        <Field label="Profile name" hint="A profile from ~/.aws on the server.">
          {(id) => (
            <>
              <input
                id={id}
                className="input mono input-md"
                value={form.profile}
                onChange={(e) => setForm({ ...form, profile: e.target.value.trim() })}
                placeholder="default"
                list={profilesListId}
              />
              {profiles ? (
                <datalist id={profilesListId}>
                  {profiles.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              ) : null}
            </>
          )}
        </Field>
      ) : null}

      {/* Access keys */}
      {form.auth === 'keys' ? (
        <KeysFields form={form} setForm={setForm} isEdit={isEdit} initial={initial} />
      ) : null}

      {/* SSO */}
      {form.auth === 'sso' ? (
        <div className="stack">
          {ssoSignedIn === false ? (
            <Note tone="warn" icon="alert">
              Not signed in to AWS SSO. Go to{' '}
              <a href="#/settings">Settings › Amazon Bedrock › AWS SSO</a> and sign in first.
            </Note>
          ) : null}
          {ssoSignedIn === null || loadingAccounts ? (
            <div className="row tight">
              <Spinner small />
              <span className="muted small">Loading accounts…</span>
            </div>
          ) : ssoAccounts !== null ? (
            <>
              <Field label="SSO account">
                {(id) => (
                  <select
                    id={id}
                    className="input"
                    style={{ maxWidth: 480 }}
                    value={form.ssoAccountId}
                    onChange={(e) =>
                      setForm({ ...form, ssoAccountId: e.target.value, ssoRoleName: '' })
                    }
                    aria-busy={loadingAccounts}
                  >
                    <option value="">Select an account…</option>
                    {ssoAccounts.map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {a.accountName} ({a.accountId})
                        {a.emailAddress ? ` — ${a.emailAddress}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {form.ssoAccountId ? (
                <Field label="SSO role">
                  {(id) =>
                    loadingRoles ? (
                      <div className="row tight">
                        <Spinner small />
                        <span className="muted small">Loading roles…</span>
                      </div>
                    ) : (
                      <select
                        id={id}
                        className="input"
                        style={{ maxWidth: 480 }}
                        value={form.ssoRoleName}
                        onChange={(e) => setForm({ ...form, ssoRoleName: e.target.value })}
                        aria-busy={loadingRoles}
                      >
                        <option value="">Select a role…</option>
                        {(ssoRoles || []).map((r) => (
                          <option key={r.roleName} value={r.roleName}>
                            {r.roleName}
                          </option>
                        ))}
                      </select>
                    )
                  }
                </Field>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {/* Check result */}
      {checkResult ? (
        <div
          className={checkResult.ok ? 'note note-ok' : 'note note-warn'}
          role="status"
          aria-live="polite"
        >
          {checkResult.ok ? (
            <span>
              Reaches AWS account <strong>{checkResult.account}</strong>
              {checkResult.arn ? (
                <span className="muted small mono break"> · {checkResult.arn}</span>
              ) : null}
            </span>
          ) : (
            <span>Saved, but the check failed: {checkResult.error}</span>
          )}
        </div>
      ) : null}

      <ErrorNote error={error} />

      <div className="row">
        <Button type="submit" variant="primary" busy={busy} disabled={!canSubmit}>
          {isEdit ? 'Save changes' : 'Add account'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/* ── Single connection card ───────────────────────────────────── */

function ConnectionCard({ conn, canManage, onEdit, onDelete, onCheck, onRefreshKeys }) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(null);
  const [checkResult, setCheckResult] = useState(null);

  // Quick-refresh panel state (only for keys auth with temporary credentials)
  const [showRefresh, setShowRefresh] = useState(false);
  const [refreshText, setRefreshText] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshOk, setRefreshOk] = useState(false);

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    setCheckResult(null);
    try {
      const r = await onCheck(conn.id);
      setCheckResult(r);
    } catch (err) {
      setCheckError(err.message || String(err));
    } finally {
      setChecking(false);
    }
  };

  const doRefresh = async () => {
    const parsed = parseCredentialsBlock(refreshText);
    if (!parsed || !parsed.accessKeyId || !parsed.secretAccessKey) {
      setRefreshError('Could not read these credentials. Paste the full block from the AWS Console, CLI, or aws sts assume-role output.');
      return;
    }
    setRefreshing(true);
    setRefreshError('');
    setRefreshOk(false);
    try {
      await onRefreshKeys(conn.id, parsed);
      setRefreshOk(true);
      setRefreshText('');
      // Auto-close after a moment so the user sees the success feedback
      setTimeout(() => setShowRefresh(false), 1800);
    } catch (err) {
      setRefreshError(err.message || String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const identity = conn.identity ?? (conn.arn ?? null);
  const usedBy = typeof conn.usedBy === 'number' ? conn.usedBy : (conn.projects?.length ?? 0);
  // Show the quick-refresh button only for key-based connections (temporary or not)
  const canQuickRefresh = canManage && conn.auth === 'keys';

  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div className="stack" style={{ gap: '0.25rem' }}>
          <div className="row tight" style={{ flexWrap: 'wrap' }}>
            <Icon name="lock" />
            <strong style={{ fontSize: '1rem' }}>{conn.name}</strong>
            <Badge tone={conn.health === 'ok' ? 'ok' : 'muted'}>{conn.health === 'ok' ? 'Verified' : 'Not verified'}</Badge>
            <Badge tone="muted">{conn.how}</Badge>
            <Badge tone="muted">{conn.region}</Badge>
            {conn.temporary ? <Badge tone="warn">Temporary</Badge> : null}
          </div>
          <dl className="kv" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
            {identity ? (
              <div><dt>Identity</dt><dd className="mono break small">{identity}</dd></div>
            ) : conn.account ? (
              <div><dt>AWS account</dt><dd><strong>{conn.account}</strong></dd></div>
            ) : null}
            {conn.accessKeyHint ? <div><dt>Access key</dt><dd className="mono small">{conn.accessKeyHint}</dd></div> : null}
            <div>
              <dt>Used by</dt>
              <dd>{usedBy > 0 ? `${usedBy} project${usedBy === 1 ? '' : 's'}` : 'no projects'}</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>{conn.checkedAt ? timeAgo(conn.checkedAt) : 'never'}</dd>
            </div>
            {conn.updatedBy ? <div><dt>Last updated by</dt><dd>{conn.updatedBy}</dd></div> : null}
          </dl>
        </div>
        <div className="row tight" style={{ flexWrap: 'wrap' }}>
          <Button size="sm" busy={checking} onClick={check}>
            {conn.checkedAt ? 'Check again' : 'Check'}
          </Button>
          {canQuickRefresh ? (
            <Button size="sm" icon="edit" onClick={() => { setShowRefresh((v) => !v); setRefreshError(''); setRefreshOk(false); }}>
              Refresh credentials
            </Button>
          ) : null}
          {canManage ? (
            <>
              <Button size="sm" icon="edit" onClick={() => onEdit(conn)}>
                Edit
              </Button>
              <Button size="sm" icon="trash" variant="danger" onClick={() => onDelete(conn)}>
                Delete
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Quick-refresh panel */}
      {showRefresh ? (
        <div className="stack" style={{ padding: '0.75rem', background: 'var(--bg-raised, #f5f5f5)', borderRadius: '6px', border: '1px solid var(--border)' }}>
          <p className="small" style={{ margin: 0, fontWeight: 600 }}>Refresh credentials</p>
          <p className="muted small" style={{ margin: 0 }}>
            Paste any format — ini block, <code>export AWS_…</code> lines, or JSON from{' '}
            <code>aws sts assume-role</code>. The region and name stay unchanged.
          </p>
          <textarea
            className="input mono"
            rows={6}
            value={refreshText}
            onChange={(e) => { setRefreshText(e.target.value); setRefreshError(''); setRefreshOk(false); }}
            placeholder={`[default]\naws_access_key_id = ASIA...\naws_secret_access_key = ...\naws_session_token = ...`}
            autoComplete="off"
            spellCheck={false}
            style={{ fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
          />
          {refreshError ? <p className="note note-warn small" style={{ margin: 0 }}>{refreshError}</p> : null}
          {refreshOk ? <p className="note note-ok small" style={{ margin: 0 }}>Credentials updated and verified ✓</p> : null}
          <div className="row tight">
            <Button size="sm" variant="primary" busy={refreshing} onClick={doRefresh} disabled={!refreshText.trim()}>
              Save &amp; verify
            </Button>
            <Button size="sm" onClick={() => { setShowRefresh(false); setRefreshText(''); setRefreshError(''); setRefreshOk(false); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {/* Live check result */}
      {checkResult ? (
        <div
          className={checkResult.ok ? 'note note-ok' : 'note note-warn'}
          role="status"
          aria-live="polite"
        >
          {checkResult.ok ? (
            <span>
              AWS account <strong>{checkResult.account}</strong>
              {checkResult.arn ? (
                <span className="muted small mono break"> · {checkResult.arn}</span>
              ) : null}
            </span>
          ) : (
            <span>Check failed: {checkResult.error}</span>
          )}
        </div>
      ) : null}
      {checkError ? (
        <Note tone="danger" icon="alert">
          {checkError}
        </Note>
      ) : null}

      {/* Projects using this connection */}
      {conn.projects?.length > 0 ? (
        <div>
          <p className="muted small" style={{ marginBottom: '0.25rem' }}>
            Used by:
          </p>
          <p className="aws-chips">
            {conn.projects.map((p) => (
              <a key={p.id} className="aws-chip" href={href(p.id, 'setup', 'connection')}>
                {p.name}
              </a>
            ))}
          </p>
        </div>
      ) : (
        <p className="muted small">Not used by any projects.</p>
      )}
    </div>
  );
}

/* ── Grouped accounts view (existing "where repos sign in") ───── */

function GroupedView() {
  const groups = useLoad(() => api.get('/api/aws/accounts'), []);
  const { toast } = useUi();
  const [checking, setChecking] = useState(null);
  const list = groups.data?.groups || [];

  const check = async (key) => {
    setChecking(key);
    try {
      const r = await api.post('/api/aws/check', { key });
      toast(`Credentials belong to AWS account ${r.account}`);
      await groups.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setChecking(null);
    }
  };

  if (groups.loading && !groups.data) return <Spinner />;
  if (groups.error) return <ErrorNote error={groups.error} />;
  if (list.length === 0) return null;

  return (
    <section className="stack">
      <h2>Where your repositories sign in</h2>
      <p className="muted small">
        Projects and CodeCommit repositories, grouped by the AWS account their credentials reach.
      </p>
      <div className="aws-groups">
        {list.map((g) => (
          <section key={g.id} className="panel stack aws-group">
            <div className="aws-group-head">
              <Icon name="lock" />
              <h3>{g.title}</h3>
              {g.bedrock ? <Badge tone="accent">Bedrock model</Badge> : null}
              {!g.accountId ? <Badge tone="warn">Not checked</Badge> : null}
            </div>
            {g.arn ? <p className="muted small mono break">{g.arn}</p> : null}
            <ul className="aws-sources">
              {g.sources.map((s) => (
                <li key={s.key}>
                  <div className="aws-source-text">
                    <strong>{s.label}</strong>
                    <span className="muted small">
                      {s.how}
                      {s.checkedAt ? ` · checked ${timeAgo(s.checkedAt)}` : ''}
                    </span>
                  </div>
                  {s.canCheck ? (
                    <Button size="sm" busy={checking === s.key} onClick={() => check(s.key)}>
                      {s.checkedAt ? 'Check again' : 'Check account'}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            <div>
              <h4 className="aws-sub">Projects</h4>
              {g.projects.length ? (
                <p className="aws-chips">
                  {g.projects.map((p) => (
                    <a key={p.id} className="aws-chip" href={href(p.id, 'setup', 'connection')}>
                      {p.name}
                      {p.own ? <span className="muted small"> · own account</span> : null}
                    </a>
                  ))}
                </p>
              ) : (
                <p className="muted small">No projects.</p>
              )}
            </div>
            <div>
              <h4 className="aws-sub">CodeCommit repositories</h4>
              {g.repos.length ? (
                <ul className="aws-repos">
                  {g.repos.map((r) => (
                    <li key={r.id}>
                      <a href={href(r.projectId, 'repos')}>
                        <strong>{r.name}</strong>
                      </a>
                      <span className="muted small">{r.projectName}</span>
                      {r.viaAddress ? <Badge tone="muted">profile {r.viaAddress}</Badge> : null}
                      <Badge status={r.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No CodeCommit repositories use these credentials.</p>
              )}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

/* ── Main page ────────────────────────────────────────────────── */

export function AwsAccounts() {
  const { user } = useApp();
  const canManage = Boolean(user?.is_admin);
  const { toast, confirm } = useUi();

  const conns = useLoad(() => api.get('/api/aws/connections'), []);
  const connections = conns.data?.connections || [];

  // Modal state
  const [modal, setModal] = useState(null); // null | { mode: 'add' } | { mode: 'edit', conn }

  const handleCheck = async (id) => {
    const r = await api.post(`/api/aws/connections/${id}/test`);
    await conns.reload(true);
    return r;
  };

  const handleRefreshKeys = async (id, parsed) => {
    // PUT only the three key fields — name, region, auth stay unchanged
    const r = await api.put(`/api/aws/connections/${id}`, {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      sessionToken: parsed.sessionToken ?? '',
    });
    await conns.reload(true);
    if (!r.check?.ok) throw new Error(r.check?.error || 'Credentials saved but the check failed');
    return r;
  };

  const handleDelete = async (conn) => {
    const ok = await confirm({
      title: 'Delete AWS account',
      message: `Delete "${conn.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/aws/connections/${conn.id}`);
      toast(`"${conn.name}" deleted`);
      await conns.reload(true);
    } catch (err) {
      toast(err.message || 'Could not delete', 'danger');
    }
  };

  const handleSaved = async (_conn, check) => {
    await conns.reload(true);
    if (check?.ok) {
      toast('AWS account saved and verified');
    } else {
      toast('AWS account saved (check failed — see the form)', 'warn');
    }
    // Keep modal open so user can see check result, they can close it themselves
    // after reviewing. But we close on success for good UX.
    if (check?.ok) setModal(null);
  };

  return (
    <div className="page">
      <PageHeader
        title="AWS accounts"
        sub="Set up the AWS credentials the portal uses. Each project picks one of these accounts, or falls back to the Settings default."
        actions={
          canManage ? (
            <Button icon="plus" variant="primary" onClick={() => setModal({ mode: 'add' })}>
              Add AWS account
            </Button>
          ) : null
        }
      />

      {/* ── Counter strip ── */}
      {connections.length > 0 ? (() => {
        const workingCount = connections.filter((c) => c.health === 'ok').length;
        const attentionCount = connections.filter((c) => c.health === 'attention').length;
        const temporaryCount = connections.filter((c) => c.temporary).length;
        return (
          <div className="conn-strip">
            <span><strong>{connections.length}</strong> Connection{connections.length === 1 ? '' : 's'}</span>
            {workingCount > 0 ? <span className="ok"><strong>{workingCount}</strong> Working</span> : null}
            {attentionCount > 0 ? <span className="danger"><strong>{attentionCount}</strong> Need attention</span> : null}
            {temporaryCount > 0 ? <span className="warn"><strong>{temporaryCount}</strong> Temporary credentials</span> : null}
          </div>
        );
      })() : null}

      {/* ── Connection cards ── */}
      {conns.loading && !conns.data ? (
        <Spinner />
      ) : conns.error ? (
        <ErrorNote error={conns.error} />
      ) : connections.length === 0 ? (
        <Empty icon="lock" title="No AWS accounts yet">
          {canManage
            ? 'Add an AWS account to let projects use a specific set of credentials.'
            : 'An admin needs to add AWS accounts here.'}
          {canManage ? (
            <Button
              variant="primary"
              icon="plus"
              onClick={() => setModal({ mode: 'add' })}
              style={{ marginTop: '0.75rem' }}
            >
              Add AWS account
            </Button>
          ) : null}
        </Empty>
      ) : (
        <div className="stack">
          {connections.map((c) => (
            <ConnectionCard
              key={c.id}
              conn={c}
              canManage={canManage}
              onCheck={handleCheck}
              onRefreshKeys={handleRefreshKeys}
              onEdit={(conn) => setModal({ mode: 'edit', conn })}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* ── Existing grouped view ── */}
      <div style={{ marginTop: '2rem' }}>
        <GroupedView />
      </div>

      {/* ── Add / edit modal ── */}
      {modal ? (
        <Modal
          title={modal.mode === 'add' ? 'Add AWS account' : `Edit "${modal.conn.name}"`}
          onClose={() => setModal(null)}
          wide
        >
          <ConnectionForm
            initial={modal.mode === 'edit' ? modal.conn : null}
            onSave={handleSaved}
            onCancel={() => setModal(null)}
          />
        </Modal>
      ) : null}
    </div>
  );
}
