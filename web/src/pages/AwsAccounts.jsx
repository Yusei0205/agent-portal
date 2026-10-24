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
        <div className="stack">
          <Field
            label={
              isEdit && initial.accessKey?.set
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
                onChange={(e) => setForm({ ...form, accessKeyId: e.target.value.trim() })}
                placeholder={isEdit && initial.accessKey?.set ? '••••••••••••••••' : 'AKIA…'}
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
                onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value.trim() })}
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
                onChange={(e) => setForm({ ...form, sessionToken: e.target.value.trim() })}
              />
            )}
          </Field>
        </div>
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

function ConnectionCard({ conn, canManage, onEdit, onDelete, onCheck }) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(null);
  const [checkResult, setCheckResult] = useState(null);

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

  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div className="stack" style={{ gap: '0.25rem' }}>
          <div className="row tight" style={{ flexWrap: 'wrap' }}>
            <Icon name="lock" />
            <strong style={{ fontSize: '1rem' }}>{conn.name}</strong>
            <Badge tone="muted">{conn.how}</Badge>
            <Badge tone="muted">{conn.region}</Badge>
          </div>
          {conn.account ? (
            <p className="muted small">
              AWS account <strong>{conn.account}</strong>
              {conn.arn ? (
                <span className="mono break"> · {conn.arn}</span>
              ) : null}
              {conn.checkedAt ? (
                <span> · checked {timeAgo(conn.checkedAt)}</span>
              ) : null}
            </p>
          ) : (
            <p className="muted small">
              {conn.checkedAt ? `Checked ${timeAgo(conn.checkedAt)} — account unknown` : 'Not checked yet'}
            </p>
          )}
        </div>
        {canManage ? (
          <div className="row tight">
            <Button size="sm" busy={checking} onClick={check}>
              Check
            </Button>
            <Button size="sm" icon="edit" onClick={() => onEdit(conn)}>
              Edit
            </Button>
            <Button size="sm" icon="trash" variant="danger" onClick={() => onDelete(conn)}>
              Delete
            </Button>
          </div>
        ) : null}
      </div>

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
