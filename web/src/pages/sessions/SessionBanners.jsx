import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useLoad, useAction } from '../../lib/useAsync.js';
import { href } from '../../lib/router.js';
import { cx, timeAgo } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { Badge, Button, ErrorNote, Field, Spinner, useUi } from '../../components/ui.jsx';
import { PushReviewLink } from './SessionChanges.jsx';

/* ---------------- Push / approval sticky banner ---------------- */

/**
 * Sticky banner at the top of every workspace tab showing push-pending or blocked state.
 * Visible on all tabs so users never miss an approval.
 */
export function PendingBanner({ w, canEdit, onDone }) {
  const { toast } = useUi();
  const { project } = useProject();
  const [busy, setBusy] = useState('');

  if (!canEdit) return null;

  // Kiro could not run: the person decides whether the session continues on Claude Code
  if (w.engine_switch) {
    const answer = async (accept) => {
      setBusy(accept ? 'switch' : 'keep');
      try {
        await api.post(`/api/workflows/${w.id}/engine-switch`, { accept });
        toast(accept ? 'Switched to Claude Code; the session carries on' : 'Kept on Kiro; the session stays stopped', 'ok');
        onDone();
      } catch (e) { toast(e.message, 'danger'); } finally { setBusy(''); }
    };
    return (
      <div className="ws-pending-banner ws-blocked-banner" role="alert">
        <Icon name="alert" size={14} aria-hidden="true" />
        <span>
          Kiro cannot run this session: {w.engine_switch.reason} Switch this session to Claude Code mode?
          {w.engine_switch.claudeReady ? '' : ' Claude is not set up yet (Settings › Model provider).'}
        </span>
        <div className="row tight">
          <Button variant="primary" size="sm" busy={busy === 'switch'} disabled={!w.engine_switch.claudeReady} onClick={() => answer(true)}>Switch to Claude Code</Button>
          <Button variant="danger" size="sm" busy={busy === 'keep'} onClick={() => answer(false)}>No, keep stopped</Button>
        </div>
      </div>
    );
  }

  // Push pending
  if (w.pending_push && typeof w.pending_push === 'object' && w.pending_push.branch) {
    const req = w.pending_push;
    const allow = async () => {
      setBusy('allow');
      try {
        const r = await api.post(`/api/workflows/${w.id}/push/allow`, {});
        toast(r.push?.ok ? `Pushed to ${req.branch}` : 'Push completed with warnings', r.push?.ok ? 'ok' : 'warn');
        onDone();
      } catch (e) { toast(e.message, 'danger'); } finally { setBusy(''); }
    };
    const decline = async () => {
      setBusy('decline');
      try {
        await api.post(`/api/workflows/${w.id}/push/deny`, {});
        toast('Push declined', 'ok');
        onDone();
      } catch (e) { toast(e.message, 'danger'); } finally { setBusy(''); }
    };
    return (
      <div className="ws-pending-banner ws-push-banner" role="alert">
        <Icon name="branch" size={14} aria-hidden="true" />
        <span>Push to <strong>{req.branch}</strong> is waiting for your approval.</span>
        <div className="row tight">
          <Button variant="primary" size="sm" busy={busy === 'allow'} onClick={allow}>Push</Button>
          <Button variant="danger" size="sm" busy={busy === 'decline'} onClick={decline}>Decline</Button>
          <a className="btn btn-ghost btn-sm" href={`#/p/${project.id}/sessions/${w.id}?tab=changes`}>Review changes</a>
        </div>
      </div>
    );
  }

  // Plan pending
  if (w.planning_gate && w.status === 'paused' && String(w.stop_reason ?? '').startsWith('Plan ready')) {
    const approve = async () => {
      setBusy('approve');
      try {
        await api.post(`/api/workflows/${w.id}/approve-plan`, {});
        toast('Plan approved — session will carry on', 'ok');
        onDone();
      } catch (e) { toast(e.message, 'danger'); } finally { setBusy(''); }
    };
    return (
      <div className="ws-pending-banner ws-plan-banner" role="alert">
        <Icon name="settings" size={14} aria-hidden="true" />
        <span>Plan is ready for your approval before the agents carry on.</span>
        <Button variant="primary" size="sm" busy={busy === 'approve'} onClick={approve}>Approve plan</Button>
      </div>
    );
  }

  // Blocked / failed / stopped
  if (['blocked', 'failed', 'stopped'].includes(w.status) && w.stop_reason) {
    return (
      <div className="ws-pending-banner ws-blocked-banner" role="status">
        <Icon name="alert" size={14} aria-hidden="true" />
        <span>{w.status === 'blocked' ? 'Blocked' : w.status === 'failed' ? 'Failed' : 'Stopped'}: {w.stop_reason}</span>
      </div>
    );
  }

  return null;
}

/* ---------------- Verification results panel ---------------- */

export function VerifResults({ check }) {
  if (!check || !check.steps) return null;
  return (
    <div className="ws-verif-results">
      <div className="row tight wrap">
        {check.steps.map((s, i) => (
          <span
            key={i}
            className={cx(
              'ws-verif-chip',
              s.ok === true ? 'ws-verif-ok' : s.ok === false ? 'ws-verif-fail' : 'ws-verif-skip',
              s.kind === 'llm' && 'ws-verif-advisory',
            )}
            title={s.output ? s.output.slice(0, 200) : undefined}
          >
            {s.ok === true ? '✅' : s.ok === false ? '❌' : '⏭'}
            {' '}{s.step}
            {s.kind === 'llm' ? ' (advisory)' : null}
          </span>
        ))}
      </div>
      {check.steps.some((s) => s.kind === 'llm' && s.output) ? (
        <div className="ws-verif-judge">
          {check.steps.filter((s) => s.kind === 'llm' && s.output).map((s, i) => (
            <details key={i} className="ws-verif-judge-item">
              <summary className="small">LLM judge notes for "{s.step}" <Badge tone="muted">advisory</Badge></summary>
              <p className="small mono ws-verif-output">{s.output}</p>
            </details>
          ))}
        </div>
      ) : null}
      <p className="muted small">
        {check.overall_ok === true ? '✅ All required steps passed' : check.overall_ok === false ? '❌ One or more required steps failed' : 'Partial results'}
        {check.ran_at ? ` · ${timeAgo(check.ran_at)}` : null}
      </p>
    </div>
  );
}

/* ---------------- Spec info panel ---------------- */

export function SpecInfoPanel({ specId, projectId }) {
  const spec = useLoad(() => api.get(`/api/projects/${projectId}/loop-specs/${specId}`), [specId, projectId]);
  if (spec.loading) return <Spinner />;
  if (!spec.data?.spec) return <p className="muted small">Spec not found.</p>;
  const s = spec.data.spec;
  return (
    <div className="stack-sm">
      <p className="small"><strong>{s.name}</strong>{s.description ? ` — ${s.description}` : ''}</p>
      <p className="small muted">Trigger: {s.trigger_kind}{s.trigger_config?.cron ? ` (${s.trigger_config.cron})` : ''}</p>
      <a className="small" href={`#/p/${projectId}/sessions?tab=specs`}>View all loop specs →</a>
    </div>
  );
}

/** The agents asked the portal to push: show what and where, and let a person allow or decline it. */
export function PushRequestCard({ w, reload }) {
  const { toast } = useUi();
  const req = w.pending_push;
  const changes = useLoad(() => api.get(`/api/runs/${req.runId}/changes`), [req.runId]);
  const [message, setMessage] = useState(req.message || '');
  const [pr, setPr] = useState(Boolean(req.pr));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const counts = changes.data?.repos ?? [];
  const files = counts.reduce((n, r) => n + r.changed, 0);
  const act = async (what) => {
    setBusy(what);
    try {
      if (what === 'allow') {
        const r = await api.post(`/api/workflows/${w.id}/push/allow`, { message: message || undefined, pr });
        const failed = r.push.results.filter((x) => !x.ok);
        const prFailed = r.push.results.filter((x) => x.prError);
        toast(
          r.push.ok
            ? `Pushed to ${req.branch}${prFailed.length ? `. No pull request: ${prFailed.map((x) => x.prError).join('; ')}` : ''}`
            : `Nothing was pushed: ${failed.map((x) => x.error).join('; ')}`,
          r.push.ok && !prFailed.length ? 'ok' : 'danger',
        );
      } else {
        await api.post(`/api/workflows/${w.id}/push/deny`, { reason });
        toast('Push declined; the agents were told why');
      }
      reload();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="note note-warn push-request" aria-label="Push waiting for you">
      <div className="stack">
        <strong>
          The agents ask to push {changes.data ? `${files} changed file${files === 1 ? '' : 's'}` : 'their changes'} to <code>{req.branch}</code>
          {counts.length > 1 ? ` in ${counts.filter((c) => c.changed).length} repositories` : ''}.
        </strong>
        {counts.length > 1 ? (
          <span className="small">
            {counts.map((c) => `${c.name}: ${c.changed ? `${c.changed} file${c.changed === 1 ? '' : 's'}` : 'no changes'}`).join(' · ')}
          </span>
        ) : null}
        <a className="small" href={`#/p/${w.project_id}/sessions/${w.id}?tab=changes`}>
          Review the changes first
        </a>
        <div className="row wrap">
          <Field label="Commit message">{(id) => <input id={id} className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Agent Portal: …" />}</Field>
          <label className="row tight small push-pr">
            <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} /> Open a pull request (GitHub or CodeCommit)
          </label>
        </div>
        <div className="row wrap">
          <Button variant="primary" icon="branch" busy={busy === 'allow'} disabled={Boolean(busy)} onClick={() => act('allow')}>
            Allow push
          </Button>
          <input className="input input-sm push-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not? (optional, sent to the agents)" aria-label="Reason for declining" />
          <Button variant="danger-ghost" busy={busy === 'deny'} disabled={Boolean(busy)} onClick={() => act('deny')}>
            Decline
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Base-like branch names that shouldn't be used as the new push branch. */
const BASE_BRANCHES = new Set(['main', 'master', 'develop', 'development', 'staging', 'production', 'release', 'trunk']);

/**
 * Shown when a session has no repositories and is blocked/done/stopped: lets the user push
 * one of its working copies to a repository they choose, or just attach a repository.
 */
export function RescuePushCard({ w, reload }) {
  const { project, canEdit } = useProject();
  const { toast } = useUi();

  // Working copies: handle both { copies: [...] } and a bare array.
  const copies = useLoad(() => api.get(`/api/workflows/${w.id}/working-copies`), [w.id]);
  const rawCopiesAll = copies.data
    ? Array.isArray(copies.data) ? copies.data : (copies.data.copies || [])
    : [];
  // A4: dedupe by path to avoid duplicate option keys.
  const rawCopies = rawCopiesAll.filter((c, i, arr) => arr.findIndex((x) => x.path === c.path) === i);

  // Connected repos for the project.
  const reposLoad = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const readyRepos = (reposLoad.data?.repos || []).filter((r) => r.status === 'ready');

  // Pick the newest copy whose repoId is set, else the newest copy overall.
  const defaultCopy = rawCopies.find((c) => c.repoId) ?? rawCopies[0] ?? null;

  const [selectedPath, setSelectedPath] = useState('');
  const [repoId, setRepoId] = useState('');
  const [branch, setBranch] = useState('');
  const [message, setMessage] = useState('');
  const [openPr, setOpenPr] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Track the last successful push result so we can offer a "Code review" link.
  const [lastPushResult, setLastPushResult] = useState(null);

  // When copies load, pre-fill from the best copy.
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (prefilled || !rawCopies.length) return;
    const c = defaultCopy;
    if (!c) return;
    setSelectedPath(c.path);
    setRepoId(c.repoId || (readyRepos[0]?.id ?? ''));
    // Prefill branch only if the copy's branch isn't a base/shared branch.
    const isSafe = c.branch && !BASE_BRANCHES.has(c.branch.toLowerCase());
    setBranch(isSafe ? c.branch : '');
    setPrefilled(true);
  }, [rawCopies.length, readyRepos.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the selected copy changes, update repoId and branch.
  const handleCopyChange = useCallback((path) => {
    setSelectedPath(path);
    const c = rawCopies.find((x) => x.path === path);
    if (!c) return;
    setRepoId(c.repoId || (readyRepos[0]?.id ?? ''));
    const isSafe = c.branch && !BASE_BRANCHES.has(c.branch.toLowerCase());
    setBranch(isSafe ? c.branch : '');
  }, [rawCopies, readyRepos]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedCopy = rawCopies.find((c) => c.path === selectedPath) ?? defaultCopy;
  const needsMessage = Boolean(selectedCopy?.dirty);

  const pushAction = useAction();
  const attachAction = useAction();

  const handlePush = async () => {
    await pushAction.run(async () => {
      const r = await api.post(`/api/workflows/${w.id}/push-copy`, {
        path: selectedCopy.path,
        repoId,
        branch: branch || undefined,
        message: message || undefined,
        pr: openPr || undefined,
      });
      const results = r.push?.results || [];
      const failed = results.filter((x) => !x.ok);
      if (r.push?.ok) {
        // pr is a URL string (same shape as history entries), not an object.
        const prResult = results.find((x) => x.pr);
        const prFailed = results.find((x) => x.prError);
        toast(
          prResult
            ? `Pushed — pull request at ${prResult.pr}`
            : `Pushed to ${branch || 'new branch'}${prFailed ? `. No pull request: ${prFailed.prError}` : ''}`,
          prFailed ? 'danger' : 'ok',
        );
        if (prResult) setLastPushResult(prResult);
      } else {
        toast(failed.map((x) => x.error).join('; ') || 'Push failed', 'danger');
      }
      reload();
    });
  };

  // A3: post only { repoId } — branch is the new branch name and must not be sent as base branch.
  const handleAttach = async () => {
    await attachAction.run(async () => {
      await api.post(`/api/workflows/${w.id}/attach-repo`, { repoId });
      toast('Repository attached');
      reload();
    });
  };

  if (dismissed) return null;

  const canPush = Boolean(selectedCopy && repoId && (!needsMessage || message.trim()));
  // Attach only requires a repo; no working copy needed.
  const canAttach = Boolean(repoId);

  return (
    <section className="note note-info push-request" aria-label="Push this work to a repository">
      <div className="stack">
        <div className="row between wrap">
          <strong>Push this work to a repository</strong>
          <button type="button" className="icon-btn" onClick={() => setDismissed(true)} aria-label="Dismiss">
            <Icon name="x" size={15} />
          </button>
        </div>

        {/* A2: repo picker and Attach always visible, regardless of working copies */}
        <div className="row wrap">
          <Field label="Target repository">
            {(id) => (
              <select
                id={id}
                className="input"
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
                aria-required="true"
              >
                <option value="">Choose a repository…</option>
                {readyRepos.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="New branch name" hint="Leave empty and the server will derive one.">
            {(id) => (
              <input
                id={id}
                className="input mono"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="agent/feature-name (derived if empty)"
              />
            )}
          </Field>
        </div>

        {copies.loading ? (
          <p className="muted small">Loading working copies…</p>
        ) : rawCopies.length > 0 ? (
          <>
            {rawCopies.length > 1 ? (
              <Field label="Working copy">
                {(id) => (
                  <select id={id} className="input" value={selectedPath} onChange={(e) => handleCopyChange(e.target.value)}>
                    {rawCopies.map((c) => (
                      <option key={c.path} value={c.path}>
                        {c.repoName ? `${c.repoName} · ` : ''}{c.branch || 'unknown branch'}{c.dirty ? ' · uncommitted changes' : ''}
                        {c.subject ? ` — ${c.subject.slice(0, 60)}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : selectedCopy ? (
              <p className="small muted">
                {selectedCopy.repoName ? <><strong>{selectedCopy.repoName}</strong> · </> : null}
                {selectedCopy.branch ? <><code>{selectedCopy.branch}</code>{selectedCopy.subject ? ` — ${selectedCopy.subject.slice(0, 80)}` : ''}</> : 'No branch yet'}
                {selectedCopy.dirty ? ' · uncommitted changes' : ''}
              </p>
            ) : null}
            <Field
              label={needsMessage ? 'Commit message (required — there are uncommitted changes)' : 'Commit message (optional)'}
              error={needsMessage && !message.trim() ? 'Required when there are uncommitted changes' : undefined}
            >
              {(id) => (
                <input
                  id={id}
                  className="input"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Agent Portal: …"
                  aria-required={needsMessage}
                />
              )}
            </Field>
            <label className="row tight small push-pr">
              <input type="checkbox" checked={openPr} onChange={(e) => setOpenPr(e.target.checked)} />
              Open a pull request (GitHub or CodeCommit)
            </label>
            <a className="small" href={`#/p/${w.project_id}/sessions/${w.id}?tab=changes`}>
              Review changes first
            </a>
          </>
        ) : (
          <p className="muted small">No working copies found. Use "Attach repository only" to connect this session to a repository.</p>
        )}

        {pushAction.error ? <ErrorNote error={pushAction.error} onClose={() => pushAction.setError(null)} /> : null}
        {attachAction.error ? <ErrorNote error={attachAction.error} onClose={() => attachAction.setError(null)} /> : null}
        <div className="row wrap">
          {rawCopies.length > 0 ? (
            <Button
              variant="primary"
              icon="branch"
              busy={pushAction.busy}
              disabled={!canPush || attachAction.busy}
              onClick={handlePush}
            >
              Push
            </Button>
          ) : null}
          <Button
            variant="ghost"
            busy={attachAction.busy}
            disabled={!canAttach || pushAction.busy}
            onClick={handleAttach}
            title="Attach the repository to this session without pushing"
          >
            Attach repository only
          </Button>
          {lastPushResult && canEdit ? (
            <PushReviewLink
              pr={lastPushResult.pr}
              repoId={lastPushResult.repoId}
              prNumber={lastPushResult.prNumber}
              repoName={lastPushResult.repo}
              repoList={readyRepos}
              projectId={project.id}
            />
          ) : null}
        </div>
        {!readyRepos.length && !reposLoad.loading ? (
          <p className="muted small">
            No repositories connected. <a href={href(project.id, 'repos')}>Connect one on the Repositories page.</a>
          </p>
        ) : null}
      </div>
    </section>
  );
}
