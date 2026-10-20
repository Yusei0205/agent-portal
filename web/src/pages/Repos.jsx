import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { useLoad } from '../lib/useAsync.js';
import { href } from '../lib/router.js';
import { cx, timeAgo } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { AWS_REGIONS, RegionSelect } from './Settings.jsx';
import { AwsAccount } from './ProjectSettings.jsx';
import { Badge, Button, Empty, ErrorNote, Field, IconButton, Modal, PageHeader, Segmented, Spinner, useUi } from '../components/ui.jsx';

const PROVIDERS = {
  github: {
    label: 'GitHub',
    placeholder: 'https://github.com/owner/repository',
    help: 'Use a fine-grained personal access token with Contents (read and write) and Pull requests (read and write) for this repository. Leave empty to use the GitHub token from Settings.',
    token: true,
  },
  codecommit: {
    label: 'AWS CodeCommit',
    placeholder: 'https://git-codecommit.ap-southeast-1.amazonaws.com/v1/repos/refund-service',
    help: 'Uses this project’s AWS account (Project and team › AWS account), or the AWS credentials from Settings when the project has none. The server needs the AWS CLI for https:// addresses, or git-remote-codecommit for codecommit:: addresses.',
    token: false,
  },
  git: {
    label: 'Other Git',
    placeholder: 'https://gitlab.com/group/repository.git',
    help: 'Any Git server over HTTPS (token) or SSH (the server’s own SSH key).',
    token: true,
    username: true,
  },
};

const LOCAL_PROVIDER = {
  label: 'Local folder',
  help: 'GitHub repositories use the GitHub token from Settings. CodeCommit uses the AWS sign-in from Settings. Only committed work is picked up, so commit or stash changes first.',
  token: false,
};

export function Repos() {
  const { project, canEdit } = useProject();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  // Live clone / fetch progress per repo id: { phase, percent }. Cleared when the repo leaves cloning / syncing.
  const [progress, setProgress] = useState({});
  useProjectEvents(['repo.updated', 'repo.deleted', 'repo.progress'], (event, data) => {
    if (event === 'repo.progress') {
      setProgress((p) => ({ ...p, [data.id]: { phase: data.phase, percent: data.percent } }));
      return;
    }
    if (event === 'repo.updated' && !['cloning', 'syncing'].includes(data?.status)) {
      setProgress((p) => {
        const { [data.id]: _gone, ...rest } = p;
        return rest;
      });
    }
    repos.reload(true);
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [awsOpen, setAwsOpen] = useState(false);
  const { toast, confirm } = useUi();
  const list = repos.data?.repos || [];
  const aws = useLoad(() => api.get(`/api/projects/${project.id}/aws`), [project.id, awsOpen]);
  const hasCodeCommit = list.some((r) => r.provider === 'codecommit');
  return (
    <div className="page">
      <PageHeader
        title="Repositories"
        sub="Agents read these, and each run that changes code gets its own working copy on a branch."
        actions={canEdit ? <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Connect repository</Button> : null}
      />
      {aws.data && (hasCodeCommit || aws.data.auth !== 'inherit') ? (
        <div className="note note-info aws-strip">
          <Icon name="lock" size={16} />
          <span>
            CodeCommit sign-in: <strong>{aws.data.auth === 'inherit' ? 'the Settings credentials' : aws.data.auth === 'profile' ? `profile ${aws.data.profile}` : 'this project’s own access keys'}</strong>.{' '}
            <a href="#/aws">See all AWS accounts</a>
          </span>
          <Button size="sm" onClick={() => setAwsOpen(true)}>{canEdit ? 'AWS account' : 'View'}</Button>
        </div>
      ) : null}
      {repos.loading && !repos.data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty icon="repos" title="No repositories connected" action={canEdit ? <Button variant="primary" onClick={() => setAdding(true)}>Connect a repository</Button> : null}>
          Connect GitHub, AWS CodeCommit or any Git server.
        </Empty>
      ) : (
        <div className="repo-list">
          {list.map((r) => (
            <article key={r.id} className="panel repo">
              <div className="repo-head">
                <Icon name="repos" />
                <h2>{r.name}</h2>
                <Badge tone="muted">{PROVIDERS[r.provider]?.label}</Badge>
                <Badge status={r.status} />
              </div>
              <p className="mono small break">{r.url}</p>
              {['cloning', 'syncing'].includes(r.status) ? <SyncProgress status={r.status} progress={progress[r.id]} /> : null}
              {r.error ? <ErrorNote error={new Error(r.error)} /> : null}
              <dl className="kv">
                <div><dt>Default branch</dt><dd><code>{r.default_branch || '…'}</code></dd></div>
                <div><dt>Last synced</dt><dd>{r.last_sync ? timeAgo(r.last_sync) : 'never'}</dd></div>
                <div><dt>Token</dt><dd>{r.token.set ? `saved (${r.token.hint})` : r.provider === 'codecommit' ? 'uses AWS sign-in' : 'none'}</dd></div>
              </dl>
              <Branches repo={r} canEdit={canEdit} />
              {canEdit ? (
                <div className="row">
                  <Button
                    size="sm"
                    icon="refresh"
                    busy={['cloning', 'syncing'].includes(r.status)}
                    onClick={async () => {
                      try {
                        await api.post(`/api/repos/${r.id}/sync`);
                      } catch (e) {
                        toast(e.message, 'danger');
                      }
                    }}
                  >
                    Sync
                  </Button>
                  <Button size="sm" icon="edit" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    onClick={async () => {
                      if (!(await confirm({ title: 'Disconnect repository', message: `Remove the portal’s clone of ${r.name}? The remote repository is not touched.`, confirmLabel: 'Disconnect', danger: true }))) return;
                      try {
                        await api.del(`/api/repos/${r.id}`);
                        toast('Repository disconnected');
                      } catch (e) {
                        toast(e.message, 'danger');
                      }
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
      {awsOpen ? (
        <Modal title="AWS account for this project" onClose={() => setAwsOpen(false)} wide>
          <AwsAccount />
        </Modal>
      ) : null}
      {adding ? <AddRepo onClose={() => setAdding(false)} onAdded={() => repos.reload(true)} /> : null}
      {editing ? <EditRepo repo={editing} onClose={() => setEditing(null)} onSaved={() => repos.reload(true)} /> : null}
    </div>
  );
}

/** Progress bar for a clone or sync. Indeterminate until the first progress event arrives. */
function SyncProgress({ status, progress }) {
  const pct = progress?.percent;
  const label = `${status === 'cloning' ? 'Cloning' : 'Syncing'}${progress ? `: ${progress.phase.toLowerCase()}` : '…'}`;
  return (
    <div className="sync-progress" role="status">
      <div className="sync-progress-head small">
        <span>{label}</span>
        <span className="muted">{pct != null ? `${pct}%` : ''}</span>
      </div>
      <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={cx('progress-bar', pct == null && 'is-indeterminate')} style={pct != null ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}

const PAGE_SIZES = [10, 25, 50];

function Branches({ repo, canEdit }) {
  const { toast, confirm } = useUi();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  // Search after a short pause, and go back to page 1 for a new search.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(text.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [text]);
  const b = useLoad(
    () => (open ? api.get(`/api/repos/${repo.id}/branches?page=${page}&pageSize=${pageSize}&q=${encodeURIComponent(query)}`) : Promise.resolve(null)),
    [open, page, pageSize, query, repo.last_sync],
  );
  if (repo.status !== 'ready' && repo.status !== 'syncing') return null;
  const d = b.data;
  const from = d && d.total ? (d.page - 1) * d.pageSize + 1 : 0;
  const to = d ? Math.min(d.total, d.page * d.pageSize) : 0;

  const remove = async (name) => {
    const ok = await confirm({
      title: 'Delete branch',
      message: `Delete “${name}” from the remote repository? This removes it for everyone and cannot be undone from here. The remote may refuse if you lack permission or the branch is protected.`,
      confirmLabel: 'Delete branch',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/repos/${repo.id}/branches?name=${encodeURIComponent(name)}`);
      toast(`Deleted ${name}`);
      b.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  return (
    <details className="branches" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Branches{d ? ` (${d.total}${query ? ' found' : ''})` : ''}</summary>
      <div className="stack">
        <input className="input input-md" type="search" placeholder="Filter branches" aria-label="Filter branches" value={text} onChange={(e) => setText(e.target.value)} />
        {d ? (
          d.branches.length ? (
            <ul className="plain-list small branch-list">
              {d.branches.map((x) => (
                <li key={x.name} className="branch-row">
                  <span className="branch-main">
                    <code>{x.name}</code>
                    {x.name === d.defaultBranch ? <Badge tone="muted">default</Badge> : null}
                    <span className="muted"> {x.subject} ({timeAgo(x.date)})</span>
                  </span>
                  {canEdit && x.name !== d.defaultBranch ? <IconButton icon="trash" label={`Delete branch ${x.name}`} onClick={() => remove(x.name)} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{query ? 'No branches match.' : 'No branches.'}</p>
          )
        ) : (
          <Spinner small />
        )}
        {d && d.total > 0 ? (
          <div className="pager small">
            <span className="muted">
              {from}–{to} of {d.total}
            </span>
            <label className="pager-size">
              <span className="muted">Per page</span>
              <select
                className="input"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <span className="pager-nav">
              <Button size="sm" disabled={d.page <= 1} onClick={() => setPage(d.page - 1)}>
                Previous
              </Button>
              <span className="muted">
                Page {d.page} of {d.pages}
              </span>
              <Button size="sm" disabled={d.page >= d.pages} onClick={() => setPage(d.page + 1)}>
                Next
              </Button>
            </span>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * Detect from an error message whether it indicates that AWS sign-in is not
 * configured or is unsupported (bedrock-key).
 */
function isAwsNotConfigured(err) {
  if (!err) return false;
  const msg = err.message || '';
  return (
    msg.includes('bedrock-key') ||
    msg.includes('Bedrock API key') ||
    msg.includes('not configured') ||
    msg.includes('Set an AWS') ||
    msg.includes('Add an AWS') ||
    msg.includes('Select an AWS account')
  );
}

/**
 * CodeCommit repository picker shown inside AddRepo when provider = 'codecommit'.
 *
 * Props:
 *   projectId    – current project id
 *   settingsRegion – default region from settings (may be empty string)
 *   onSelect     – called with { url, name, defaultBranch }
 *   manualMode   – boolean: show manual URL input instead of picker
 *   setManualMode – toggle between picker and manual
 */
function CodeCommitPicker({ projectId, settingsRegion, onSelect, manualMode, setManualMode }) {
  // Use the settings region as the initial region value (or empty to let the user pick)
  const [region, setRegion] = useState(settingsRegion || '');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');

  const repos = useLoad(
    () =>
      region
        ? api.get(`/api/projects/${projectId}/codecommit/repos?region=${encodeURIComponent(region)}`)
        : Promise.resolve(null),
    [projectId, region],
  );

  const list = repos.data?.repos || [];
  const filtered = search
    ? list.filter(
        (r) =>
          r.name.toLowerCase().includes(search.toLowerCase()) ||
          (r.description || '').toLowerCase().includes(search.toLowerCase()),
      )
    : list;

  // True when the error indicates AWS is not configured / bedrock-key
  const awsNotConfigured = isAwsNotConfigured(repos.error);

  function handleSelect(repo) {
    setSelected(repo.name);
    onSelect({
      url: repo.cloneUrlHttp,
      name: repo.name,
      defaultBranch: repo.defaultBranch || '',
    });
  }

  if (manualMode) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setManualMode(false)}
      >
        ← Pick from list
      </button>
    );
  }

  return (
    <div className="stack">
      {/* Region selector */}
      <Field label="AWS region">
        {(id) => (
          <RegionSelect
            id={id}
            value={region}
            onChange={(v) => {
              setRegion(v);
              setSelected('');
              setSearch('');
            }}
            className="input mono input-sm"
            placeholder="Select a region…"
          />
        )}
      </Field>

      {/* Repository list */}
      {region ? (
        <div className="field">
          <div className="field-label" id="cc-picker-label">
            Repository
          </div>

          {/* Loading */}
          {repos.loading && !repos.data ? (
            <div aria-live="polite" aria-busy="true">
              <Spinner />
            </div>
          ) : awsNotConfigured ? (
            /* AWS not configured hint */
            <div className="note note-info" role="status">
              <Icon name="alert" size={16} />
              <span>
                AWS sign-in is not configured.{' '}
                <a href={href(projectId, 'team')}>Add this project’s AWS account</a> (or set the Settings credentials), then come
                back here. <a href="#/aws">See all AWS accounts</a>.
              </span>
            </div>
          ) : repos.error ? (
            <ErrorNote error={repos.error} />
          ) : list.length === 0 ? (
            <div className="note note-info" role="status" aria-live="polite">
              No CodeCommit repositories found in {region}.
            </div>
          ) : (
            <>
              {/* Search */}
              <label className="sr-only" htmlFor="cc-search">
                Search repositories
              </label>
              <input
                id="cc-search"
                className="input"
                type="search"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-controls="cc-repo-list"
              />

              {/* Result count for screen readers */}
              <p
                className="sr-only"
                aria-live="polite"
                aria-atomic="true"
              >
                {filtered.length === list.length
                  ? `${list.length} repositor${list.length === 1 ? 'y' : 'ies'}`
                  : `${filtered.length} of ${list.length} repositories`}
              </p>

              <div
                id="cc-repo-list"
                className="cc-repo-list"
                role="listbox"
                aria-labelledby="cc-picker-label"
                aria-activedescendant={selected ? `cc-repo-${selected}` : undefined}
              >
                {filtered.map((repo) => (
                  <button
                    key={repo.name}
                    id={`cc-repo-${repo.name}`}
                    type="button"
                    role="option"
                    aria-selected={selected === repo.name}
                    className={`cc-repo-item ${selected === repo.name ? 'is-selected' : ''}`}
                    onClick={() => handleSelect(repo)}
                  >
                    <span className="cc-repo-name">{repo.name}</span>
                    {repo.description ? (
                      <span className="cc-repo-desc muted small">{repo.description}</span>
                    ) : null}
                    {repo.defaultBranch ? (
                      <span className="cc-repo-branch muted small">
                        <code>{repo.defaultBranch}</code>
                      </span>
                    ) : null}
                  </button>
                ))}
                {filtered.length === 0 && search ? (
                  <p className="muted small pad-sm">No repositories match "{search}"</p>
                ) : null}
              </div>

              {/* Refresh button */}
              <Button
                size="sm"
                icon="refresh"
                busy={repos.loading}
                onClick={() => repos.reload(false)}
                aria-label="Refresh repository list"
              >
                Refresh
              </Button>
            </>
          )}
        </div>
      ) : null}

      {/* Manual fallback toggle */}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setManualMode(true)}
      >
        Enter address manually
      </button>
    </div>
  );
}

function AddRepo({ onClose, onAdded }) {
  const { project } = useProject();
  const { user } = useApp();
  const [form, setForm] = useState({ provider: 'github', url: '', localPath: '', name: '', token: '', username: '', defaultBranch: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // CodeCommit picker state
  const [ccManualMode, setCcManualMode] = useState(false);

  const isLocal = form.provider === 'local';
  const p = isLocal ? LOCAL_PROVIDER : PROVIDERS[form.provider];

  // When switching away from codecommit, reset manual mode
  const handleProviderChange = (provider) => {
    setForm({ ...form, provider, url: '', localPath: '', name: '', defaultBranch: '' });
    setCcManualMode(false);
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/projects/${project.id}/repos`, {
        ...(isLocal ? { localPath: form.localPath } : { provider: form.provider, url: form.url }),
        name: form.name || undefined,
        token: form.token || undefined,
        username: form.username || undefined,
        defaultBranch: form.defaultBranch || undefined,
      });
      onAdded();
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Connect a repository"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!(isLocal ? form.localPath : form.url).trim()} onClick={submit}>
            Connect and clone
          </Button>
        </>
      }
    >
      <div className="stack">
        <Segmented
          value={form.provider}
          onChange={handleProviderChange}
          label="Where is it hosted?"
          options={[
            ...Object.entries(PROVIDERS).map(([value, x]) => ({ value, label: x.label })),
            ...(user.is_admin ? [{ value: 'local', label: LOCAL_PROVIDER.label }] : []),
          ]}
        />

        {isLocal ? (
          <Field label="Folder on this computer" hint="The full path of the folder that contains the repository. Its GitHub, CodeCommit or Git remote is read from the folder, so you do not need to type the address.">
            {(id) => (
              <input
                id={id}
                className="input mono"
                value={form.localPath}
                onChange={(e) => setForm({ ...form, localPath: e.target.value })}
                placeholder="C:\Users\you\projects\my-repo"
                aria-required="true"
              />
            )}
          </Field>
        ) : null}

        {form.provider === 'codecommit' && !ccManualMode ? (
          <CodeCommitPicker
            projectId={project.id}
            settingsRegion=""
            onSelect={({ url, name, defaultBranch }) => {
              setForm((f) => ({
                ...f,
                url,
                name: f.name || name,
                defaultBranch: f.defaultBranch || defaultBranch || '',
              }));
            }}
            manualMode={ccManualMode}
            setManualMode={setCcManualMode}
          />
        ) : null}

        {!isLocal && (form.provider !== 'codecommit' || ccManualMode) ? (
          <Field label="Repository address" hint={user.is_admin && form.provider === 'git' ? 'Admins can also use a path on the server, like file:///srv/git/app.git.' : undefined}>
            {(id) => (
              <input
                id={id}
                className="input mono"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={p.placeholder}
                aria-required="true"
              />
            )}
          </Field>
        ) : null}

        {/* When a repo is selected from the picker, show the resolved URL as read-only */}
        {form.provider === 'codecommit' && !ccManualMode && form.url ? (
          <Field label="Clone URL (from selected repository)">
            {(id) => (
              <input
                id={id}
                className="input mono"
                value={form.url}
                readOnly
                aria-label="Resolved clone URL"
              />
            )}
          </Field>
        ) : null}

        <div className="row">
          <Field label="Display name (optional)" hint="Defaults to the repository name.">
            {(id) => (
              <input
                id={id}
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Default branch (optional)" hint="Detected automatically.">
            {(id) => (
              <input
                id={id}
                className="input mono"
                value={form.defaultBranch}
                onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
                placeholder="main"
              />
            )}
          </Field>
        </div>

        {p.token && !isLocal ? (
          <Field label="Access token" hint="Stored encrypted. Never shown again.">
            {(id) => (
              <input
                id={id}
                type="password"
                className="input mono"
                autoComplete="off"
                value={form.token}
                onChange={(e) => setForm({ ...form, token: e.target.value })}
              />
            )}
          </Field>
        ) : null}
        {p.username ? (
          <Field label="Username for the token (optional)" hint="Some servers, like Bitbucket, need the account name with an app password.">
            {(id) => (
              <input
                id={id}
                className="input"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            )}
          </Field>
        ) : null}
        <p className="muted small">{p.help}</p>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

function EditRepo({ repo, onClose, onSaved }) {
  const [form, setForm] = useState({ name: repo.name, defaultBranch: repo.default_branch, token: '', username: repo.auth_user || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async (extra = {}) => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: form.name, defaultBranch: form.defaultBranch, username: form.username, ...extra };
      if (form.token) body.token = form.token;
      await api.patch(`/api/repos/${repo.id}`, body);
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Edit ${repo.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Display name">{(id) => <input id={id} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Default branch">{(id) => <input id={id} className="input mono" value={form.defaultBranch} onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })} />}</Field>
        {repo.provider !== 'codecommit' ? (
          <>
            <Field label={repo.token.set ? `Replace token (saved, ${repo.token.hint})` : 'Access token'}>
              {(id) => <input id={id} type="password" className="input mono" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />}
            </Field>
            {repo.token.set ? (
              <Button size="sm" variant="ghost" onClick={() => save({ token: null })}>
                Remove saved token
              </Button>
            ) : null}
            <Field label="Username for the token (optional)">{(id) => <input id={id} className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />}</Field>
          </>
        ) : null}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
