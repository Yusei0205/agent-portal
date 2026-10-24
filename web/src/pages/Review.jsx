import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href, runHref } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, timeAgo } from '../lib/util.js';
import { useSortable } from '../lib/useSortable.js';
import { DiffView } from '../components/DiffView.jsx';
import { Icon } from '../components/Icon.jsx';
import { SortHeader } from '../components/SortHeader.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Modal, PageHeader, Segmented, Spinner, Toggle, useUi } from '../components/ui.jsx';
// Inline repo-connection sheet (same form as ProjectSetup RepositoryFix)
import { useRef } from 'react';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * Inline add-repository form shown when no repos are connected yet.
 * Renders inline (no sheet backdrop) inside the modal.
 */
function AddRepoInlineSheet({ projectId, onAdded }) {
  const { toast } = useUi();
  const conns = useLoad(() => api.get('/api/git-connections'), []);
  const [mode, setMode] = useState('direct');
  const [form, setForm] = useState({ provider: 'git', url: '', name: '', token: '', connectionId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const connections = conns.data?.connections || [];

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'connection'
        ? { connectionId: form.connectionId, url: form.url, name: form.name }
        : { provider: form.provider, url: form.url, name: form.name, token: form.token || undefined };
      const r = await api.post(`/api/projects/${projectId}/repos`, body);
      toast('Repository connected — cloning…');
      onAdded(r.repo);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={save} noValidate>
      <p className="field-label">Connect a repository</p>
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
            {(id) => <input id={id} className="input" value={form.name} onChange={set('name')} />}
          </Field>
          {(form.provider === 'github' || form.provider === 'git') ? (
            <Field label="Token (optional)">
              {(id) => <input id={id} type="password" className="input mono" value={form.token} onChange={set('token')} autoComplete="off" />}
            </Field>
          ) : null}
        </>
      ) : (
        <>
          {!connections.length ? (
            <p className="muted small">No git connections yet. <a href="#/connections">Add one first.</a></p>
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
        </>
      )}
      <ErrorNote error={error} />
      <div className="row">
        <Button type="submit" variant="primary" busy={busy}>Connect and clone</Button>
      </div>
      <p className="muted small">After cloning, the repository will appear in the picker above. This may take a moment.</p>
    </form>
  );
}

export function Review({ route }) {
  const id = route.rest[0];
  return id ? <ReviewDetail id={id} /> : <ReviewList route={route} />;
}

function ReviewList({ route }) {
  const { project, canEdit } = useProject();
  const reviews = useLoad(() => api.get(`/api/projects/${project.id}/reviews`), [project.id]);
  useProjectEvents(['review.updated'], () => reviews.reload(true));

  // Parse optional pre-fill params from the URL query (e.g. review?repo=<id>&pr=<n>&branch=<head>).
  const queryRepoId = route?.query?.get('repo') || '';
  const queryPrNumber = route?.query?.get('pr') || '';
  const queryBranch = route?.query?.get('branch') || '';

  // Auto-open the modal when the URL carries pre-fill params.
  const [creating, setCreating] = useState(Boolean(queryRepoId && (queryPrNumber || queryBranch)));

  const list = reviews.data?.reviews || [];

  // Clear the query params when the modal closes so the URL stays clean.
  const handleClose = () => {
    setCreating(false);
    if (queryRepoId || queryPrNumber || queryBranch) {
      // Strip query from hash without triggering a navigation.
      const hash = window.location.hash;
      const qi = hash.indexOf('?');
      if (qi !== -1) window.location.replace(hash.slice(0, qi));
    }
  };

  const REVIEW_COLS = [
    { key: 'change',   label: 'Change',       accessor: (r) => r.pr_number ? `PR #${r.pr_number}` : `${r.head} into ${r.base}`, type: 'text' },
    { key: 'repo',     label: 'Repository',   accessor: 'repo_name',     type: 'text' },
    { key: 'status',   label: 'Status',       accessor: 'status',        type: 'status' },
    { key: 'findings', label: 'Open findings',accessor: 'open_findings', type: 'number' },
    { key: 'started',  label: 'Started',      accessor: 'created_at',    type: 'date' },
  ];
  const { sorted, sortKey, sortDir, toggle } = useSortable(list, {
    columns: REVIEW_COLS,
    storageKey: `sort:reviews:${project.id}`,
  });

  return (
    <div className="page">
      <PageHeader
        title="Code review"
        sub="Agents review a branch or pull request against the project documents, security and testing checklists."
        actions={canEdit ? <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New review</Button> : null}
      />
      {reviews.loading && !reviews.data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty icon="review" title="No reviews yet" action={canEdit ? <Button variant="primary" onClick={() => setCreating(true)}>Review a branch</Button> : null}>
          Pick two branches, or a GitHub or CodeCommit pull request. Findings show up next to the changed lines.
        </Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <SortHeader col={REVIEW_COLS[0]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={REVIEW_COLS[1]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={REVIEW_COLS[2]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
              <SortHeader col={REVIEW_COLS[3]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} className="num" />
              <SortHeader col={REVIEW_COLS[4]} sortKey={sortKey} sortDir={sortDir} onSort={toggle} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td>
                  <a className="strong-link" href={href(project.id, 'review', r.id)}>
                    {r.pr_number ? `Pull request #${r.pr_number}` : <><code>{r.head}</code> into <code>{r.base}</code></>}
                  </a>
                  {r.deep ? <span className="muted small"> with deep look</span> : null}
                  {r.source === 'auto' ? <span className="muted small"> · From PR #{r.pr_number} (auto)</span> : null}
                </td>
                <td>{r.repo_name}</td>
                <td>
                  <Badge status={r.status} />
                  {r.post_state === 'awaiting' ? <Badge tone="warn">Awaiting approval</Badge> : null}
                </td>
                <td className="num">
                  {r.open_findings}
                  {r.serious ? <Badge tone="danger">{r.serious} serious</Badge> : null}
                </td>
                <td className="muted">
                  {timeAgo(r.created_at)}, {r.created_by_name}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating ? (
        <NewReview
          onClose={handleClose}
          initialRepoId={queryRepoId}
          initialPrNumber={queryPrNumber}
          initialBranch={queryBranch}
          existingReviews={list}
        />
      ) : null}
    </div>
  );
}

/**
 * Modal for creating a new review.
 * Props:
 *   onClose         – called when the modal is dismissed
 *   initialRepoId   – pre-select this repo (from URL query ?repo=)
 *   initialPrNumber – pre-fill this PR number and switch to PR mode (from URL query ?pr=)
 *   existingReviews – the already-loaded reviews list, used to detect duplicates
 */
function NewReview({ onClose, initialRepoId = '', initialPrNumber = '', initialBranch = '', existingReviews = [] }) {
  const { project } = useProject();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const ready = (repos.data?.repos || []).filter((r) => r.status === 'ready');
  const [repoId, setRepoId] = useState(initialRepoId || '');
  // Start in PR mode when a PR number was supplied; branches mode when a branch was supplied.
  const [mode, setMode] = useState(initialPrNumber ? 'pr' : 'branches');
  const [branches, setBranches] = useState([]);
  const [pulls, setPulls] = useState(null);
  const [form, setForm] = useState({ base: '', head: initialBranch || '', prNumber: initialPrNumber || '', deep: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const repo = ready.find((r) => r.id === repoId);

  // Set a default repo once the list loads, but don't overwrite the pre-filled value.
  useEffect(() => {
    if (!repoId && ready[0]) setRepoId(ready[0].id);
  }, [ready, repoId]);

  // Fetch branches whenever the repo changes.
  useEffect(() => {
    if (!repoId) return;
    api.get(`/api/repos/${repoId}/branches`).then((r) => {
      setBranches(r.branches);
      setForm((f) => ({
        ...f,
        base: r.defaultBranch,
        // Preserve the initialBranch (from ?branch= param) if it's valid; otherwise pick the first non-default.
        head: f.head || r.branches.find((b) => b.name !== r.defaultBranch)?.name || '',
      }));
    });
    // Reset pulls so they reload for the new repo.
    setPulls(null);
  }, [repoId]);

  // Fetch open PRs when PR mode is active and we haven't loaded them yet (GitHub and CodeCommit).
  const prCapable = repo?.provider === 'github' || repo?.provider === 'codecommit';
  useEffect(() => {
    if (mode === 'pr' && prCapable && !pulls) {
      // On failure the picker still shows (with the pre-filled PR, if any) instead of spinning forever.
      api.get(`/api/repos/${repoId}/pulls`).then((r) => setPulls(r.pulls)).catch((e) => {
        setPulls([]);
        setError(e);
      });
    }
  }, [mode, prCapable, repoId, pulls]);

  // Check whether a review for this repo + PR already exists.
  const prNum = Number(form.prNumber);
  const existing = mode === 'pr' && prNum
    ? existingReviews.find((r) => r.repo_id === repoId && r.pr_number === prNum)
    : null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'pr' ? { repoId, prNumber: prNum, deep: form.deep } : { repoId, base: form.base, head: form.head, deep: form.deep };
      const { review } = await api.post(`/api/projects/${project.id}/reviews`, body);
      go(project.id, 'review', review.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  // Build the PR select options, ensuring the pre-filled PR is always present even if it
  // hasn't been returned by the open-pulls list (still loading, or already merged/closed).
  const prefilled = initialPrNumber ? [{ number: Number(initialPrNumber), title: `Pull request #${initialPrNumber}`, head: '', base: '' }] : [];
  const prOptions = pulls
    ? (initialPrNumber && !pulls.some((p) => String(p.number) === String(initialPrNumber)) ? [...prefilled, ...pulls] : pulls)
    : prefilled.length
      ? prefilled
      : null;

  return (
    <Modal
      title="New review"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {existing ? (
            <Button variant="primary" icon="review" onClick={() => go(project.id, 'review', existing.id)}>
              Open existing review
            </Button>
          ) : (
            <Button variant="primary" busy={busy} onClick={start} disabled={!repoId || (mode === 'pr' ? !form.prNumber : !form.base || !form.head)}>
              Start review
            </Button>
          )}
        </>
      }
    >
      {repos.data && !ready.length ? (
        <div className="stack">
          <p>
            No repositories are connected yet. Connect one to start a code review.
          </p>
          <AddRepoInlineSheet projectId={project.id} onAdded={() => repos.reload(true)} />
        </div>
      ) : (
        <div className="stack">
          {existing ? (
            <p className="muted small">
              A review for pull request #{prNum} already exists. Open it to see the findings, or start a new one.{' '}
              <Button variant="ghost" onClick={start} busy={busy} disabled={!repoId}>
                Start new anyway
              </Button>
            </p>
          ) : null}
          <Field label="Repository">
            {(id) => (
              <select id={id} className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
                {ready.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {prCapable ? (
            <Segmented value={mode} onChange={setMode} label="What to review" options={[{ value: 'branches', label: 'Two branches' }, { value: 'pr', label: 'Pull request' }]} />
          ) : null}
          {mode === 'pr' ? (
            <Field label="Pull request">
              {(id) =>
                prOptions ? (
                  <>
                    <select id={id} className="input" value={form.prNumber} onChange={(e) => setForm({ ...form, prNumber: e.target.value })}>
                      <option value="">Choose a pull request</option>
                      {prOptions.map((p) => (
                        <option key={p.number} value={p.number}>
                          #{p.number}{p.title ? ` ${p.title}` : ''}{p.head && p.base ? ` (${p.head} into ${p.base})` : ''}
                        </option>
                      ))}
                    </select>
                    {!pulls ? <p className="muted small" role="status">Loading the other open pull requests…</p> : null}
                  </>
                ) : (
                  <Spinner small />
                )
              }
            </Field>
          ) : (
            <div className="row">
              <Field label="Changes on">
                {(id) => (
                  <select id={id} className="input" value={form.head} onChange={(e) => setForm({ ...form, head: e.target.value })}>
                    <option value="">Choose a branch</option>
                    {branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Compared with">
                {(id) => (
                  <select id={id} className="input" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })}>
                    {branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
          )}
          <Toggle checked={form.deep} onChange={(deep) => setForm({ ...form, deep })} label="Deep look at risky files" />
          <p className="muted small">
            Haiku reviews the whole change. With a deep look, Sonnet re-checks files that have medium or more serious findings. Costs a little more, finds subtler problems.
          </p>
          <ErrorNote error={error} />
        </div>
      )}
    </Modal>
  );
}

function ReviewDetail({ id }) {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const r = useLoad(() => api.get(`/api/reviews/${id}`), [id]);
  useProjectEvents(['review.updated'], (_e, d) => d?.id === id && r.reload(true));
  const [sevFilter, setSevFilter] = useState(new Set(SEVERITIES));
  const [showDismissed, setShowDismissed] = useState(false);
  const [focus, setFocus] = useState(null);
  const [posting, setPosting] = useState(false);

  if (r.error) return <div className="page"><ErrorNote error={r.error} /></div>;
  if (!r.data) return <div className="page"><Spinner /></div>;
  const { review, diff, findings, run } = r.data;
  const visible = findings.filter((f) => sevFilter.has(f.severity) && (showDismissed || f.status !== 'dismissed'));
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s && f.status !== 'dismissed').length]));

  const setStatus = async (f, status) => {
    try {
      await api.patch(`/api/findings/${f.id}`, { status });
      r.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  const renderFinding = (f) => (
    <div className={cx('finding', `sev-${f.severity}`, f.status !== 'open' && `is-${f.status}`)}>
      <div className="finding-head">
        <Badge status={f.severity} />
        <span className="muted small">{f.category}</span>
        {f.source === 'deep' ? <span className="muted small">deep look</span> : null}
        {f.line ? <span className="muted small">line {f.line}</span> : null}
        {f.status !== 'open' ? <Badge status={f.status} /> : null}
        {f.posted_at ? <span className="muted small">posted</span> : null}
      </div>
      <p>{f.message}</p>
      {f.suggestion ? (
        <p className="finding-fix">
          <strong>Fix:</strong> {f.suggestion}
        </p>
      ) : null}
      {canEdit ? (
        <div className="row tight">
          {f.status !== 'accepted' ? <Button size="sm" icon="check" onClick={() => setStatus(f, 'accepted')}>Accept</Button> : null}
          {f.status !== 'dismissed' ? <Button size="sm" variant="ghost" onClick={() => setStatus(f, 'dismissed')}>Dismiss</Button> : null}
          {f.status !== 'open' ? <Button size="sm" variant="ghost" onClick={() => setStatus(f, 'open')}>Reopen</Button> : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="page wide">
      <a className="back" href={href(project.id, 'review')}>
        ← All reviews
      </a>
      <PageHeader
        title={review.pr_number ? `Pull request #${review.pr_number}` : `${review.head} into ${review.base}`}
        sub={`${review.repo_name}, started ${timeAgo(review.created_at)}${review.source === 'auto' ? ` · From PR #${review.pr_number} (auto)` : ''}`}
        actions={
          <>
            {run ? (
              <a className="btn btn-default" href={runHref(project.id, run.id)}>
                <Icon name="runs" size={17} />
                <span>Watch the reviewer</span>
              </a>
            ) : null}
            {canEdit && review.pr_number && review.status === 'done' && (review.provider === 'github' || review.provider === 'codecommit') ? (
              <Button
                icon="external"
                variant={review.post_state === 'awaiting' ? 'primary' : undefined}
                busy={posting}
                onClick={async () => {
                  setPosting(true);
                  try {
                    const out = await api.post(`/api/reviews/${review.id}/post-github`);
                    toast(out.message || `Posted ${out.posted} findings`);
                    r.reload(true);
                  } catch (e) {
                    toast(e.message, 'danger');
                  } finally {
                    setPosting(false);
                  }
                }}
              >
                {review.post_state === 'awaiting' ? 'Approve and post' : review.posted_at ? `Post again to ${review.provider === 'github' ? 'GitHub' : 'CodeCommit'}` : `Post to ${review.provider === 'github' ? 'GitHub' : 'CodeCommit'}`}
              </Button>
            ) : null}
            {canEdit && review.post_state === 'awaiting' ? (
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await api.post(`/api/reviews/${review.id}/skip-post`);
                    toast('Nothing will be posted for this review');
                    r.reload(true);
                  } catch (e) {
                    toast(e.message, 'danger');
                  }
                }}
              >
                Do not post
              </Button>
            ) : null}
            {canEdit && review.status !== 'running' ? (
              <Button
                variant="ghost"
                icon="trash"
                onClick={async () => {
                  if (!(await confirm({ title: 'Delete review', message: 'Delete this review and its findings?', confirmLabel: 'Delete', danger: true }))) return;
                  await api.del(`/api/reviews/${review.id}`);
                  go(project.id, 'review');
                }}
              >
                Delete
              </Button>
            ) : null}
          </>
        }
      />
      {review.status === 'running' ? (
        <div className="note note-info">
          <Spinner small /> <span>Reviewing {diff.length} changed files. Findings appear here when the agent finishes.</span>
        </div>
      ) : null}
      {review.error ? <ErrorNote error={new Error(review.error)} /> : null}
      {review.post_state === 'awaiting' ? (
        <div className="note note-info">
          <span>
            Draft: nothing is on the pull request yet. Approving posts the findings at {review.post_options?.minSeverity || 'medium'} severity or above that are not already there (at most {review.post_options?.maxComments || 20} per pull request). Findings you accept are always included; dismissed ones never are.
          </span>
        </div>
      ) : null}
      {review.summary ? <p className="lead">{review.summary}</p> : null}

      {review.status !== 'running' ? (
        <div className="sev-bar" role="group" aria-label="Filter by severity">
          {SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              className={cx('sev-chip', `sev-${s}`, sevFilter.has(s) && 'is-on')}
              aria-pressed={sevFilter.has(s)}
              onClick={() => {
                const next = new Set(sevFilter);
                next.has(s) ? next.delete(s) : next.add(s);
                setSevFilter(next);
              }}
            >
              <span className="sev-n">{counts[s]}</span> {s}
            </button>
          ))}
          <Toggle checked={showDismissed} onChange={setShowDismissed} label="Show dismissed" />
        </div>
      ) : null}

      <div className="review-layout">
        <nav className="review-files" aria-label="Changed files">
          <ol>
            {diff.map((f) => {
              const n = visible.filter((x) => x.file === f.newPath).length;
              return (
                <li key={f.newPath}>
                  <button
                    type="button"
                    className={cx('linkish', focus === f.newPath && 'is-active')}
                    onClick={() => {
                      setFocus(f.newPath);
                      document.getElementById(`file-${f.newPath}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                    }}
                  >
                    <span className="file-name">{f.newPath}</span>
                    {n ? <span className="file-count">{n}</span> : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <DiffView files={diff} findings={visible} renderFinding={renderFinding} focusFile={focus} />
      </div>
    </div>
  );
}
