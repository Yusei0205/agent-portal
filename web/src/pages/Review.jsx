import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, timeAgo } from '../lib/util.js';
import { useSortable } from '../lib/useSortable.js';
import { DiffView } from '../components/DiffView.jsx';
import { Icon } from '../components/Icon.jsx';
import { SortHeader } from '../components/SortHeader.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Modal, PageHeader, Segmented, Spinner, Toggle, useUi } from '../components/ui.jsx';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

export function Review({ route }) {
  const id = route.rest[0];
  return id ? <ReviewDetail id={id} /> : <ReviewList />;
}

function ReviewList() {
  const { project, canEdit } = useProject();
  const reviews = useLoad(() => api.get(`/api/projects/${project.id}/reviews`), [project.id]);
  useProjectEvents(['review.updated'], () => reviews.reload(true));
  const [creating, setCreating] = useState(false);
  const list = reviews.data?.reviews || [];

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
          Pick two branches, or a GitHub pull request. Findings show up next to the changed lines.
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
                </td>
                <td>{r.repo_name}</td>
                <td>
                  <Badge status={r.status} />
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
      {creating ? <NewReview onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function NewReview({ onClose }) {
  const { project } = useProject();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const ready = (repos.data?.repos || []).filter((r) => r.status === 'ready');
  const [repoId, setRepoId] = useState('');
  const [mode, setMode] = useState('branches');
  const [branches, setBranches] = useState([]);
  const [pulls, setPulls] = useState(null);
  const [form, setForm] = useState({ base: '', head: '', prNumber: '', deep: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const repo = ready.find((r) => r.id === repoId);
  useEffect(() => {
    if (!repoId && ready[0]) setRepoId(ready[0].id);
  }, [ready, repoId]);
  useEffect(() => {
    if (!repoId) return;
    api.get(`/api/repos/${repoId}/branches`).then((r) => {
      setBranches(r.branches);
      setForm((f) => ({ ...f, base: r.defaultBranch, head: r.branches.find((b) => b.name !== r.defaultBranch)?.name || '' }));
    });
    setPulls(null);
  }, [repoId]);
  useEffect(() => {
    if (mode === 'pr' && repo?.provider === 'github' && !pulls) {
      api.get(`/api/repos/${repoId}/pulls`).then((r) => setPulls(r.pulls)).catch((e) => setError(e));
    }
  }, [mode, repo, repoId, pulls]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'pr' ? { repoId, prNumber: Number(form.prNumber), deep: form.deep } : { repoId, base: form.base, head: form.head, deep: form.deep };
      const { review } = await api.post(`/api/projects/${project.id}/reviews`, body);
      go(project.id, 'review', review.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New review"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={start} disabled={!repoId || (mode === 'pr' ? !form.prNumber : !form.base || !form.head)}>
            Start review
          </Button>
        </>
      }
    >
      {repos.data && !ready.length ? (
        <p>
          Connect a repository first on the <a href={href(project.id, 'repos')}>Repositories</a> page.
        </p>
      ) : (
        <div className="stack">
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
          {repo?.provider === 'github' ? (
            <Segmented value={mode} onChange={setMode} label="What to review" options={[{ value: 'branches', label: 'Two branches' }, { value: 'pr', label: 'Pull request' }]} />
          ) : null}
          {mode === 'pr' ? (
            <Field label="Pull request">
              {(id) =>
                pulls ? (
                  <select id={id} className="input" value={form.prNumber} onChange={(e) => setForm({ ...form, prNumber: e.target.value })}>
                    <option value="">Choose an open pull request</option>
                    {pulls.map((p) => (
                      <option key={p.number} value={p.number}>
                        #{p.number} {p.title} ({p.head} into {p.base})
                      </option>
                    ))}
                  </select>
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
        sub={`${review.repo_name}, started ${timeAgo(review.created_at)}`}
        actions={
          <>
            {run ? (
              <a className="btn btn-default" href={href(project.id, 'runs', run.id)}>
                <Icon name="runs" size={17} />
                <span>Watch the reviewer</span>
              </a>
            ) : null}
            {canEdit && review.pr_number && review.status === 'done' ? (
              <Button
                icon="external"
                busy={posting}
                onClick={async () => {
                  setPosting(true);
                  try {
                    const out = await api.post(`/api/reviews/${review.id}/post-github`);
                    toast(`Posted ${out.posted} findings to GitHub`);
                    r.reload(true);
                  } catch (e) {
                    toast(e.message, 'danger');
                  } finally {
                    setPosting(false);
                  }
                }}
              >
                {review.posted_at ? 'Post again to GitHub' : 'Post to GitHub'}
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
