import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useLoad } from '../../lib/useAsync.js';
import { href, withQuery } from '../../lib/router.js';
import { Changes } from '../../components/run/Changes.jsx';
import { PushDialog } from '../../components/run/PushDialog.jsx';
import { Button, Empty, ErrorNote, Spinner } from '../../components/ui.jsx';

/* ---------------- Changes ---------------- */

/** Every iteration resumes the same working copy, so the latest run's changes are the session's changes. */
export function ChangesTab({ w, canEdit }) {
  const run = useLoad(() => (w.last_run_id ? api.get(`/api/runs/${w.last_run_id}`) : Promise.resolve(null)), [w.last_run_id, w.updated_at]);
  const [pushing, setPushing] = useState(false);
  if (!w.last_run_id) return <Empty icon="file" title="No changes yet">Changes appear here after the first iteration.</Empty>;
  if (run.error) return <ErrorNote error={run.error} />;
  const r = run.data?.run;
  if (!r) return <Spinner />;
  const active = ['queued', 'running', 'waiting'].includes(r.status);
  return (
    <div className="stack">
      <div className="row between wrap">
        <p className="muted small">{r.worktree ? (r.meta?.repos?.length > 1 ? `All changes the session made so far, across ${r.meta.repos.length} repositories.` : 'All changes the session made in its working copy so far.') : 'Files the session wrote to its run folder.'}</p>
        {canEdit && r.worktree ? (
          <Button icon="branch" disabled={active} title={active ? 'Wait for the current iteration to finish' : undefined} onClick={() => setPushing(true)}>
            Push changes
          </Button>
        ) : null}
      </div>
      <Changes run={r} />
      {pushing ? <PushDialog run={r} onClose={() => setPushing(false)} /> : null}
    </div>
  );
}

/* ---------------- Code review link for push results ---------------- */

/**
 * Renders a "Code review" link next to a push result's pull request URL.
 * Resolves repoId + prNumber from the result; falls back to parsing the URL and
 * matching repo by name for older events that predate the repoId/prNumber fields.
 * Renders nothing when resolution fails.
 */
export function PushReviewLink({ pr, repoId, prNumber, repoName, repoList, projectId, branch }) {
  // Prefer the values that were stored alongside the event.
  let resolvedRepoId = repoId || null;
  let resolvedPrNumber = prNumber || null;

  // Fallback: parse PR number from the URL (/.../pull/<n>).
  if (!resolvedPrNumber && pr) {
    const m = String(pr).match(/\/pull(?:-requests)?\/(\d+)/);
    if (m) resolvedPrNumber = Number(m[1]);
  }
  // Fallback: match repo by name.
  if (!resolvedRepoId && repoName && repoList.length) {
    const found = repoList.find((r) => r.name === repoName);
    if (found) resolvedRepoId = found.id;
  }

  if (!resolvedRepoId) return null;

  let reviewHref;
  if (resolvedPrNumber) {
    reviewHref = withQuery(href(projectId, 'review'), { repo: resolvedRepoId, pr: resolvedPrNumber });
  } else if (branch) {
    reviewHref = withQuery(href(projectId, 'review'), { repo: resolvedRepoId, branch });
  } else {
    return null;
  }

  return (
    <a
      href={reviewHref}
      className="small"
      aria-label={resolvedPrNumber ? `Start code review for pull request #${resolvedPrNumber}` : `Start code review for branch ${branch}`}
    >
      Code review
    </a>
  );
}
