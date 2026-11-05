/**
 * Pure state-to-display mapping for the session's pull request card.
 * Events are `pull-request` events (contract D); fields may sit at the top
 * level or inside `payload`.
 */

import { href } from './router.js';

function flat(ev) {
  const p = ev && ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
  return { ...ev, ...p };
}

/** Latest `pull-request` event per repo (later in the array wins). */
export function latestPullRequestStates(events) {
  const byRepo = new Map();
  for (const raw of events || []) {
    if (!raw) continue;
    const type = raw.type ?? raw.kind;
    if (type !== 'pull-request') continue;
    const ev = flat(raw);
    const key = ev.repo ?? ev.repoId ?? '';
    byRepo.delete(key); // keeps the order of each repo's latest event
    byRepo.set(key, ev);
  }
  return [...byRepo.values()];
}

function prLink(ev) {
  return ev.url ? { kind: 'link', label: `Open pull request #${ev.number}`, href: ev.url } : null;
}

/**
 * @param {object} event a pull-request event
 * @param {{ projectId?: string|null }} [ctx]
 * @returns {{ tone: 'info'|'ok'|'warn'|'danger', title: string, detail: string, actions: Array<{kind:'link'|'button', label:string, href?:string}> }}
 */
export function describePullRequest(event, ctx = {}) {
  const ev = flat(event);
  const repo = ev.repo ?? 'the repository';
  const branch = ev.branch ?? '';
  const createBtn = (label = 'Create pull request') => ({ kind: 'button', label });
  const out = (tone, title, detail = '', actions = []) => ({ tone, title, detail, actions });

  switch (ev.state) {
    case 'asked':
      return out('info', `Open a pull request for ${repo}?`,
        `${ev.files} files changed in ${ev.commits} commit(s) in ${repo}. Approve to push a new branch and open a pull request.`,
        [{ kind: 'link', label: 'Open Inbox', href: '#/inbox' }]);
    case 'declined':
      return out('info', `No pull request for ${repo}`, 'The request to open a pull request was declined or expired.', [createBtn()]);
    case 'available':
      return out('info', `Changes in ${repo}`, 'Changes are ready. Automatic pull requests are off for this project.', [createBtn()]);
    case 'pushing':
      return out('info', `Pushing changes in ${repo}`, branch ? `Pushing branch ${branch}` : 'Pushing a new branch');
    case 'pushed':
      return out('ok', `Branch pushed for ${repo}`, `The branch ${branch} was pushed.`);
    case 'opened': {
      const a = prLink(ev);
      return out('ok', `Pull request #${ev.number} opened for ${repo}`, ev.title ?? '', a ? [a] : []);
    }
    case 'review-started': {
      const a = prLink(ev);
      const actions = a ? [a] : [];
      if (ev.reviewId) actions.push({ kind: 'link', label: 'Open review', href: href(ctx.projectId ?? null, 'reviews', 'code', ev.reviewId) });
      return out('ok', `Pull request #${ev.number} opened for ${repo}`, `${ev.title ? `${ev.title}. ` : ''}A draft review was started.`, actions);
    }
    case 'review-failed': {
      const a = prLink(ev);
      const actions = a ? [a] : [];
      actions.push({ kind: 'link', label: 'Start a review', href: href(ctx.projectId ?? null, 'reviews', 'code') });
      return out('warn', `Pull request #${ev.number} opened for ${repo}`, `The review could not be started: ${ev.error ?? 'unknown error'}`, actions);
    }
    case 'failed': {
      const code = ev.errorCode;
      if (code === 'no-permission') {
        return out('danger', `Could not push ${repo}`,
          `No permission to push to ${repo}. A GitHub token needs repo write access; CodeCommit needs GitPush and CreatePullRequest.`,
          [createBtn('Try again')]);
      }
      if (code === 'unsupported') {
        return out('warn', `No pull request for ${repo}`,
          `Pull requests on ${ev.provider ?? 'this host'} are not supported yet. The branch ${branch} was pushed.`);
      }
      if (code === 'no-workspace') {
        return out('danger', `Nothing pushed for ${repo}`, "The session's saved files could not be restored, so nothing was pushed.");
      }
      if (branch) {
        return out('danger', `Pull request failed for ${repo}`,
          `The branch ${branch} was pushed, but the pull request could not be opened: ${ev.error ?? 'unknown error'}`,
          [createBtn('Try again')]);
      }
      return out('danger', `Pull request failed for ${repo}`, ev.error ?? 'The pull request could not be created.', [createBtn('Try again')]);
    }
    default:
      return out('info', `Pull request for ${repo}`, String(ev.state ?? ''));
  }
}
