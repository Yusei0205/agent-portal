import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { go } from '../lib/router.js';
import { money } from '../lib/util.js';
import { Badge, Button, ErrorNote, Field, IconButton, Note, PageHeader, Spinner, useUi } from '../components/ui.jsx';
import { useAction, useLoad } from '../lib/useAsync.js';
import { JiraConnection } from './Tickets.jsx';

const ROLE_SUGGESTIONS = ['Business analyst', 'Solution architect', 'Backend developer', 'Frontend developer', 'QA engineer', 'Reviewer', 'Technical writer', 'Product owner', 'Stakeholder'];

const PROVIDER_LABELS = {
  demo: 'Demo',
  anthropic: 'Anthropic API',
  bedrock: 'Amazon Bedrock',
  kiro: 'Kiro CLI',
};

/**
 * Connection card — lets an owner pick the model provider and which AWS account
 * this project uses. AWS accounts are set up once on the global AWS accounts page;
 * here the project just picks one.
 */
export function Connection() {
  const { project, isOwner, canEdit } = useProject();
  const { user } = useApp();
  const isAdmin = Boolean(user?.is_admin);
  const { toast } = useUi();

  const cfg = useLoad(() => api.get(`/api/projects/${project.id}/aws`), [project.id]);
  const conns = useLoad(() => api.get('/api/aws/connections'), []);

  // form state
  const [form, setForm] = useState(null);

  // action state
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingAws, setTestingAws] = useState(false);
  const [error, setError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [awsResult, setAwsResult] = useState(null);

  const blank = (c) => ({
    provider: c.provider || 'inherit',
    connectionId: c.connectionId || 'inherit',
  });

  useEffect(() => {
    if (cfg.data) setForm(blank(cfg.data));
  }, [cfg.data]);

  if (!cfg.data || !form) {
    return (
      <section className="panel">
        <h2>Connection</h2>
        <Spinner />
      </section>
    );
  }

  const c = cfg.data;
  const connections = conns.data?.connections || [];

  // Is this project using a legacy per-project auth (not yet converted or conversion failed)?
  const isLegacyAuth = c.auth && c.auth !== 'inherit' && c.auth !== 'connection';

  const dirty =
    form.provider !== (c.provider || 'inherit') ||
    form.connectionId !== (c.connectionId || 'inherit');

  const save = async () => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    setAwsResult(null);
    try {
      const body = { provider: form.provider };
      if (form.connectionId === 'inherit') {
        body.auth = 'inherit';
      } else {
        body.auth = 'connection';
        body.connectionId = form.connectionId;
      }
      await api.put(`/api/projects/${project.id}/aws`, body);
      toast('Connection saved');
      await cfg.reload(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const testModel = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const r = await api.post(`/api/projects/${project.id}/connection/test`);
      setTestResult({ ok: r.ok, provider: r.provider, model: r.model, ms: r.ms, reply: r.reply });
    } catch (e) {
      setTestResult({ ok: false, error: e.message || String(e) });
    } finally {
      setTesting(false);
    }
  };

  const testAws = async () => {
    setTestingAws(true);
    setError(null);
    setAwsResult(null);
    try {
      setAwsResult(await api.post(`/api/projects/${project.id}/aws/test`));
    } catch (e) {
      setError(e);
    } finally {
      setTestingAws(false);
    }
  };

  const defaultProviderLabel = PROVIDER_LABELS[c.defaultProvider] || c.defaultProvider || 'Demo';
  const effectiveProvider = form.provider === 'inherit' ? c.defaultProvider : form.provider;
  const selectedConn = connections.find((cn) => cn.id === form.connectionId) || null;
  const hasOwnAws = form.connectionId !== 'inherit';

  // Usage note
  let usageNote = null;
  if (form.provider === 'bedrock' && hasOwnAws) {
    usageNote = "Bedrock model, CodeCommit and agents' AWS commands all use this project's AWS account.";
  } else if (effectiveProvider === 'bedrock' && hasOwnAws) {
    usageNote = "Bedrock model uses the Settings AWS account; CodeCommit and agents' AWS commands use this project's account. Choose Amazon Bedrock above to use this account for the model too.";
  } else if (effectiveProvider === 'bedrock' && !hasOwnAws) {
    usageNote = 'Bedrock model uses the Settings AWS account. No separate project account.';
  } else if (effectiveProvider === 'kiro') {
    usageNote = hasOwnAws
      ? "Model uses Kiro CLI. CodeCommit and agents' AWS commands use this project's AWS account."
      : "Model uses Kiro CLI. CodeCommit and agents' AWS commands use the Settings AWS credentials.";
  } else if (effectiveProvider === 'anthropic') {
    usageNote = hasOwnAws
      ? "Model uses the Anthropic API. CodeCommit and agents' AWS commands use this project's AWS account."
      : 'Model uses the Anthropic API. AWS commands use the Settings credentials.';
  } else if (effectiveProvider === 'demo') {
    usageNote = 'Demo mode: agents are simulated.';
  } else if (hasOwnAws) {
    usageNote = "The model uses the Settings provider. CodeCommit and agents' AWS commands use this project's AWS account.";
  }

  return (
    <section className="panel stack">
      <h2>Connection</h2>
      <p className="muted small">
        By default this project uses the provider and AWS credentials from Settings. Override them here to run on a different model provider or AWS account.
      </p>

      {/* Model provider */}
      <Field label="Model provider">
        {(id) => (
          <select
            id={id}
            className="input"
            style={{ maxWidth: 480 }}
            value={form.provider}
            disabled={!isOwner}
            onChange={(e) => setForm({ ...form, provider: e.target.value })}
          >
            <option value="inherit">Same as Settings ({defaultProviderLabel})</option>
            <option value="kiro">Kiro CLI</option>
            <option value="bedrock">Amazon Bedrock</option>
            <option value="anthropic">Anthropic API</option>
            <option value="demo">Demo</option>
          </select>
        )}
      </Field>

      {/* AWS account */}
      {isLegacyAuth ? (
        /* Legacy per-project auth — show read-only, explain an admin can switch */
        <div className="stack">
          <p className="field-label">AWS account</p>
          <p className="muted small">
            This project has its own AWS credentials ({c.auth === 'profile' ? `named profile "${c.profile || ''}"` : c.auth === 'keys' ? 'access keys' : c.auth === 'sso' ? 'AWS SSO' : c.auth}).
            A portal admin can switch it to a shared AWS account below.
          </p>
          {isAdmin ? (
            <Field label="Switch to a shared AWS account" hint="Picking one here replaces the per-project credentials.">
              {(id) => (
                <select
                  id={id}
                  className="input"
                  style={{ maxWidth: 480 }}
                  value={form.connectionId}
                  onChange={(e) => setForm({ ...form, connectionId: e.target.value })}
                >
                  <option value="inherit">Keep per-project credentials</option>
                  {connections.map((cn) => (
                    <option key={cn.id} value={cn.id}>
                      {cn.name}
                      {cn.account ? ` · ${cn.account}` : ' · not checked'}
                      {cn.region ? ` · ${cn.region}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
        </div>
      ) : (
        <Field label="AWS account">
          {(id) => (
            <>
              <select
                id={id}
                className="input"
                style={{ maxWidth: 480 }}
                value={form.connectionId}
                disabled={!isAdmin}
                onChange={(e) => setForm({ ...form, connectionId: e.target.value })}
                aria-describedby="aws-account-desc"
              >
                <option value="inherit">Same as Settings (no separate account)</option>
                {connections.map((cn) => (
                  <option key={cn.id} value={cn.id}>
                    {cn.name}
                    {cn.account ? ` · ${cn.account}` : ' · not checked'}
                    {cn.region ? ` · ${cn.region}` : ''}
                  </option>
                ))}
              </select>
              <p id="aws-account-desc" className="field-hint">
                {connections.length === 0 ? (
                  <>
                    No AWS accounts set up yet.{' '}
                    {isAdmin ? (
                      <a href="#/aws">Add one on the AWS accounts page.</a>
                    ) : (
                      <>Ask an admin to <a href="#/aws">set up an AWS account</a> first.</>
                    )}
                  </>
                ) : (
                  <>
                    <a href="#/aws">Set up or manage AWS accounts.</a>
                    {!isAdmin ? ' Only admins can change the AWS account.' : null}
                  </>
                )}
              </p>
            </>
          )}
        </Field>
      )}

      {/* Non-admin note when a connection is selected */}
      {!isAdmin && !isLegacyAuth && (
        <Note tone="info" icon="lock">
          Only a portal admin can change the AWS account for this project.
        </Note>
      )}

      {/* Usage note */}
      {usageNote ? <p className="muted small">{usageNote}</p> : null}

      <ErrorNote error={error} />

      {/* Test results */}
      {testResult ? (
        testResult.ok ? (
          <div className="note note-ok" role="status" aria-live="polite">
            <div>
              <strong>
                {testResult.provider ? PROVIDER_LABELS[testResult.provider] ?? testResult.provider : 'Model'} replied
                {testResult.model ? ` (${testResult.model})` : ''} in {Math.round((testResult.ms || 0) / 100) / 10}s
              </strong>
              {testResult.reply ? <p className="muted small">{testResult.reply}</p> : null}
            </div>
          </div>
        ) : (
          <div className="note note-danger" role="alert" aria-live="polite">
            <span>{testResult.error || 'Connection test failed'}</span>
          </div>
        )
      ) : null}

      {awsResult ? (
        <div className="note note-ok" role="status" aria-live="polite">
          <div>
            <strong>Connected to AWS account {awsResult.account}</strong>
            <p className="muted small mono break">{awsResult.arn}</p>
          </div>
        </div>
      ) : null}

      <div className="row wrap">
        {isOwner ? (
          <Button variant="primary" busy={busy} disabled={!dirty} onClick={save}>
            Save
          </Button>
        ) : (
          <span className="muted small">Only project owners can change this.</span>
        )}
        {canEdit ? (
          <Button
            busy={testing}
            disabled={Boolean(dirty)}
            onClick={testModel}
            title={dirty ? 'Save your changes first' : 'Test the model connection for this project'}
          >
            Test model
          </Button>
        ) : null}
        {canEdit && (hasOwnAws || isLegacyAuth) ? (
          <Button
            busy={testingAws}
            disabled={Boolean(dirty)}
            onClick={testAws}
            title={dirty ? 'Save your changes first' : 'Check which AWS account these credentials belong to'}
          >
            Test AWS
          </Button>
        ) : null}
        {dirty && canEdit ? <span className="muted small">Save before testing.</span> : null}
      </div>
    </section>
  );
}

/**
 * Backward-compatible alias so Repos.jsx (which imports AwsAccount) keeps working.
 * Repos uses it to let users configure AWS quickly without going to Project and team.
 */
export { Connection as AwsAccount };

export function ProjectSettings() {
  const { project, members, counts, monthUsd, isOwner, reload } = useProject();
  const { reloadProjects, user } = useApp();
  const { toast, confirm } = useUi();
  const [form, setForm] = useState({ name: project.name, description: project.description, notes: project.notes });
  useEffect(() => setForm({ name: project.name, description: project.description, notes: project.notes }), [project]);
  const save = useAction();
  const add = useAction();
  const [member, setMember] = useState({ email: '', access: 'editor', role: '' });
  const [users, setUsers] = useState([]);
  useEffect(() => {
    api.get('/api/users').then((r) => setUsers(r.users)).catch(() => undefined);
  }, []);

  const dirty = form.name !== project.name || form.description !== project.description || form.notes !== project.notes;

  return (
    <div className="page">
      <PageHeader title="Project and team" sub="Details agents read in CLAUDE.md, and who can do what." />
      <div className="two-col">
        <section className="panel">
          <h2>Details</h2>
          <div className="stack">
            <Field label="Name">{(id) => <input id={id} className="input" value={form.name} disabled={!isOwner} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Description">{(id) => <textarea id={id} className="input" rows={3} value={form.description} disabled={!isOwner} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <Field label="Project notes for agents" hint="Conventions, constraints and links. Added to CLAUDE.md, which every agent reads first.">
              {(id) => <textarea id={id} className="input mono" rows={8} value={form.notes} disabled={!isOwner} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="- Use the refunds table, never payments directly&#10;- Amounts are in minor units (cents)" />}
            </Field>
            <ErrorNote error={save.error} />
            {isOwner ? (
              <div className="row">
                <Button
                  variant="primary"
                  disabled={!dirty}
                  busy={save.busy}
                  onClick={() =>
                    save.run(async () => {
                      await api.patch(`/api/projects/${project.id}`, form);
                      await reload();
                      await reloadProjects();
                      toast('Project saved');
                    })
                  }
                >
                  Save changes
                </Button>
              </div>
            ) : (
              <p className="muted small">Only project owners can change these.</p>
            )}
          </div>
          <dl className="kv">
            <div><dt>Documents</dt><dd>{counts.docs}</dd></div>
            <div><dt>Repositories</dt><dd>{counts.repos}</dd></div>
            <div><dt>Runs</dt><dd>{counts.runs}</dd></div>
            <div><dt>Spend this month</dt><dd>{money(monthUsd, 2)}</dd></div>
          </dl>
        </section>

        <section className="panel">
          <h2>Members</h2>
          <p className="muted small">Viewers read documents, take quizzes and answer agent questions. Editors also run agents, upload and approve. Owners manage members.</p>
          <ul className="member-list">
            {members.map((m) => (
              <li key={m.id}>
                <div>
                  <strong>{m.name}</strong>
                  <span className="muted small"> {m.email}</span>
                  {m.role ? <div className="small">{m.role}</div> : null}
                </div>
                {isOwner ? (
                  <div className="row tight">
                    <select
                      className="input input-sm"
                      aria-label={`Access for ${m.name}`}
                      value={m.access}
                      onChange={async (e) => {
                        try {
                          await api.patch(`/api/projects/${project.id}/members/${m.id}`, { access: e.target.value });
                          reload();
                        } catch (err) {
                          toast(err.message, 'danger');
                        }
                      }}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </select>
                    <IconButton
                      icon="x"
                      label={`Remove ${m.name}`}
                      onClick={async () => {
                        if (!(await confirm({ title: 'Remove member', message: `Remove ${m.name} from ${project.name}?`, confirmLabel: 'Remove', danger: true }))) return;
                        try {
                          await api.del(`/api/projects/${project.id}/members/${m.id}`);
                          reload();
                        } catch (err) {
                          toast(err.message, 'danger');
                        }
                      }}
                    />
                  </div>
                ) : (
                  <Badge tone="muted">{m.access}</Badge>
                )}
              </li>
            ))}
          </ul>
          {isOwner ? (
            <form
              className="stack add-member"
              onSubmit={(e) => {
                e.preventDefault();
                add.run(async () => {
                  await api.post(`/api/projects/${project.id}/members`, member);
                  setMember({ email: '', access: 'editor', role: '' });
                  reload();
                  toast('Member added');
                });
              }}
            >
              <h3>Add a member</h3>
              <Field label="Email">
                {(id) => (
                  <>
                    <input id={id} className="input" type="email" list="user-emails" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} required />
                    <datalist id="user-emails">
                      {users.filter((u) => !members.some((m) => m.id === u.id)).map((u) => (
                        <option key={u.id} value={u.email}>{u.name}</option>
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
              <div className="row">
                <Field label="Access">
                  {(id) => (
                    <select id={id} className="input" value={member.access} onChange={(e) => setMember({ ...member, access: e.target.value })}>
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </select>
                  )}
                </Field>
                <Field label="Role in the project">
                  {(id) => (
                    <>
                      <input id={id} className="input" list="role-names" value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value })} placeholder="Backend developer" />
                      <datalist id="role-names">{ROLE_SUGGESTIONS.map((r) => <option key={r} value={r} />)}</datalist>
                    </>
                  )}
                </Field>
              </div>
              <ErrorNote error={add.error} />
              <div className="row">
                <Button type="submit" variant="primary" busy={add.busy}>
                  Add member
                </Button>
              </div>
              {user.is_admin ? <p className="muted small">People need an account first. Create one in Settings › Users.</p> : null}
            </form>
          ) : null}
        </section>
      </div>

      <Connection />
      <JiraConnection />

      {isOwner ? (
        <section className="panel danger-zone">
          <h2>Archive or delete</h2>
          <div className="row">
            <Button
              onClick={async () => {
                await api.patch(`/api/projects/${project.id}`, { archived: !project.archived });
                await reload();
                await reloadProjects();
                toast(project.archived ? 'Project restored' : 'Project archived');
              }}
            >
              {project.archived ? 'Restore project' : 'Archive project'}
            </Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                const typed = await confirm({
                  title: 'Delete project',
                  message: 'The project folder moves to the trash folder on the server. Runs, documents and learning content are removed from the portal.',
                  typeToConfirm: project.name,
                  confirmLabel: 'Delete project',
                  danger: true,
                });
                if (!typed) return;
                try {
                  await api.del(`/api/projects/${project.id}`, { confirm: typed });
                  await reloadProjects();
                  go(null, 'projects');
                } catch (err) {
                  toast(err.message, 'danger');
                }
              }}
            >
              Delete project
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
