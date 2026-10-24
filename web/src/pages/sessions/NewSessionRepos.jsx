import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { Button, ErrorNote, Field, useUi } from '../../components/ui.jsx';

/**
 * Inline sheet for adding a repository without leaving the dialog.
 * Uses the same form as RepositoryFix in ProjectSetup.jsx.
 */
function AddRepositorySheet({ projectId, onClose, onAdded }) {
  const { toast } = useUi();
  const sheetRef = useRef(null);
  const conns = useLoad(() => api.get('/api/git-connections'), []);
  const [mode, setMode] = useState('direct');
  const [form, setForm] = useState({ provider: 'git', url: '', name: '', token: '', username: '', connectionId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const connections = conns.data?.connections || [];

  useEffect(() => {
    const prev = document.activeElement;
    sheetRef.current?.querySelector('input,select,button')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'connection'
        ? { connectionId: form.connectionId, url: form.url, name: form.name }
        : { provider: form.provider, url: form.url, name: form.name, token: form.token || undefined, username: form.username || undefined };
      const r = await api.post(`/api/projects/${projectId}/repos`, body);
      toast('Repository connected — cloning…');
      onAdded(r.repo);
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add repository"
      ref={sheetRef}
      onMouseDown={(e) => {
        // Clicking on the dimming backdrop (not the sheet panel) closes the sheet.
        if (e.target === e.currentTarget) onClose();
        // Always stop propagation so the launcher modal's backdrop handler doesn't fire.
        e.stopPropagation();
      }}
    >
      <div className="sheet">
        <header className="sheet-head">
          <h2>Add repository</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={17} />
          </button>
        </header>
        <div className="sheet-body">
          <form className="stack" onSubmit={save} noValidate>
            <div className="row tight" role="group" aria-label="Repository type">
              <button type="button" className={cx('btn btn-sm', mode === 'direct' && 'btn-primary')} onClick={() => setMode('direct')}>Direct URL</button>
              <button type="button" className={cx('btn btn-sm', mode === 'connection' && 'btn-primary')} onClick={() => setMode('connection')}>Via a connection</button>
            </div>
            {mode === 'direct' ? (
              <>
                <Field label="Repository type">
                  {(id) => (
                    <select id={id} className="input" value={form.provider} onChange={set('provider')}>
                      <option value="git">Other Git (HTTPS / SSH)</option>
                      <option value="github">GitHub</option>
                      <option value="codecommit">AWS CodeCommit</option>
                    </select>
                  )}
                </Field>
                <Field label="Repository address">
                  {(id) => <input id={id} className="input mono" value={form.url} onChange={set('url')} placeholder="https://github.com/owner/repo" required />}
                </Field>
                <Field label="Display name (optional)">
                  {(id) => <input id={id} className="input" value={form.name} onChange={set('name')} placeholder="Leave blank to use the repo name" />}
                </Field>
                {(form.provider === 'github' || form.provider === 'git') ? (
                  <Field label="Token (optional)" hint="Stored encrypted.">
                    {(id) => <input id={id} type="password" className="input mono" value={form.token} onChange={set('token')} autoComplete="off" />}
                  </Field>
                ) : null}
              </>
            ) : (
              <>
                {!connections.length ? (
                  <p className="muted small">No git connections yet. <a href="#/connections" onClick={onClose}>Add one on the Git connections page</a>.</p>
                ) : (
                  <Field label="Git connection">
                    {(id) => (
                      <select id={id} className="input" value={form.connectionId} onChange={set('connectionId')} required>
                        <option value="">Choose a connection…</option>
                        {connections.map((c) => (
                          <option key={c.id} value={c.id}>{c.name} · {c.provider}</option>
                        ))}
                      </select>
                    )}
                  </Field>
                )}
                <Field label="Repository URL">
                  {(id) => <input id={id} className="input mono" value={form.url} onChange={set('url')} placeholder="https://github.com/owner/repo" required />}
                </Field>
                <Field label="Display name (optional)">
                  {(id) => <input id={id} className="input" value={form.name} onChange={set('name')} />}
                </Field>
              </>
            )}
            <ErrorNote error={error} />
            <div className="row">
              <Button type="submit" variant="primary" busy={busy}>Connect and clone</Button>
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export const KINDS = [
  { value: 'session', label: 'Session', hint: 'Keeps working toward the goal on its own, iteration after iteration, until it is done or needs you.' },
  { value: 'single', label: 'Single run', hint: 'One run. You choose whether edits and commands wait for your approval.' },
  { value: 'document', label: 'Document a repository', hint: 'Maps a repository and writes cited documentation into its own folder. No code changes.' },
];

/** The provider new work in this project uses (sessions keep the one they were made with). */
export function useProjectProvider(projectId) {
  const conn = useLoad(() => api.get(`/api/projects/${projectId}/connection`), [projectId]);
  return conn.data?.provider ?? null;
}

/** Branches of a repository and its default branch. */
function useBranches(repoId) {
  const [b, setB] = useState({ list: [], def: '' });
  useEffect(() => {
    if (!repoId) return setB({ list: [], def: '' });
    let alive = true;
    api.get(`/api/repos/${repoId}/branches`).then((r) => alive && setB({ list: r.branches.map((x) => x.name), def: r.defaultBranch })).catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoId]);
  return b;
}

/** The repositories a session or run works in: one row each, with the branch its working copy starts from. */
export function RepoRows({ rows, setRows, ready, session, projectId, onRepoAdded }) {
  const [addingRepo, setAddingRepo] = useState(false);
  const update = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => setRows((rs) => rs.filter((_, j) => j !== i));
  const used = new Set(rows.map((r) => r.repoId).filter(Boolean));
  const free = ready.filter((r) => !used.has(r.id));
  const handleAdded = (repo) => {
    if (onRepoAdded) onRepoAdded(repo);
    // Auto-select the newly added repo
    if (repo?.id) setRows((rs) => [...rs, { repoId: repo.id, branch: '' }]);
  };
  return (
    <fieldset className="repo-rows">
      <legend className="field-label">Repositories (optional)</legend>
      {rows.length ? (
        <ul className="repo-rows-list">
          {rows.map((row, i) => (
            <RepoRow key={i} row={row} options={ready.filter((r) => r.id === row.repoId || !used.has(r.id))} onChange={(p) => update(i, p)} onRemove={() => remove(i)} index={i} />
          ))}
        </ul>
      ) : (
        <p className="muted small">No repository: the agents work with the project documents only.</p>
      )}
      <div className="row between wrap">
        <span className="muted small">
          {rows.length > 1
            ? 'Each repository gets its own working copy. The changes go to one new branch name in every repository; pushing follows the Agent pushes setting.'
            : session
              ? 'The agents change a working copy on a new branch they name. Pushing follows the Agent pushes setting.'
              : 'The run gets its own working copy of the base branch.'}
        </span>
        <div className="row tight">
          <Button size="sm" icon="plus" disabled={!free.length} onClick={() => setRows((rs) => [...rs, { repoId: free[0].id, branch: '' }])} title={free.length ? undefined : ready.length ? 'Every repository is already added' : 'Connect a repository below or on the Repositories page first'}>
            Add repository
          </Button>
          {!ready.length && projectId ? (
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setAddingRepo(true)} title="Connect a new repository inline">
              Connect repo
            </Button>
          ) : null}
        </div>
      </div>
      {!ready.length ? (
        <p className="muted small">
          No repositories connected yet.{' '}
          {projectId ? (
            <button type="button" className="btn-link small" onClick={() => setAddingRepo(true)}>Add one here</button>
          ) : (
            <a href="#" className="small">Connect a repository first.</a>
          )}
        </p>
      ) : null}
      {addingRepo && projectId ? (
        <AddRepositorySheet
          projectId={projectId}
          onClose={() => setAddingRepo(false)}
          onAdded={handleAdded}
        />
      ) : null}
    </fieldset>
  );
}

export function RepoRow({ row, options, onChange, onRemove, index }) {
  const branches = useBranches(row.repoId);
  return (
    <li className="repo-row">
      <select className="input" aria-label={`Repository ${index + 1}`} value={row.repoId} onChange={(e) => onChange({ repoId: e.target.value, branch: '' })}>
        {options.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <select className="input mono" aria-label={`Base branch for repository ${index + 1}`} title="Work starts from this branch, and a pull request goes into it. It is never pushed to directly." value={row.branch} onChange={(e) => onChange({ branch: e.target.value })}>
        <option value="">{`Default branch${branches.def ? ` (${branches.def})` : ''}`}</option>
        {branches.list.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <button type="button" className="icon-btn" onClick={onRemove} aria-label={`Remove repository ${index + 1}`} title="Remove">
        <Icon name="x" size={15} />
      </button>
    </li>
  );
}
