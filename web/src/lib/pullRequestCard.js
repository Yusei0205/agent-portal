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
        ev.inboxId
          ? [{ kind: 'button', id: 'approve', label: 'Open pull request' }, { kind: 'button', id: 'decline', label: 'Not now' }, { kind: 'link', label: 'Open Inbox', href: '#/inbox' }]
          : [{ kind: 'link', label: 'Open Inbox', href: '#/inbox' }]);
    case 'declined':
      return out('info', `No pull request for ${repo}`, 'The question was declined or dismissed in the Inbox, so nothing was pushed. You can still open one now.', [createBtn()]);
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
          [{ kind: 'link', label: ev.provider === 'github' ? 'Reconnect GitHub' : 'Open Git connections', href: '#/connect/git' }, createBtn('Try again')]);
      }
      if (code === 'unsupported') {
        return out('warn', `No pull request for ${repo}`,
          `Pull requests on ${ev.provider ?? 'this host'} are not supported yet. The branch ${branch} was pushed.`);
      }
      if (code === 'protected-path') {
        // An auto-fix change that touches a protected path: a person decides (the finding is in Needs attention); no retry button.
        return out('danger', `Auto-fix blocked for ${repo}`, ev.error ?? 'The change touches a protected path, so no pull request was opened.');
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

/**
 * Identifies one state of a repository's card, so that dismissing it hides that state only: a newer event for the repository (a new
 * question, a push, a failure) has another key and shows again.
 */
export function prCardKey(event, workflowId) {
  const ev = flat(event);
  return [workflowId ?? '', ev.repoId ?? ev.repo ?? '', ev.state ?? '', ev.created_at ?? ev.id ?? ev.number ?? ''].join('|');
}

/** A card that is still working has nothing to dismiss yet. */
export function canDismissPullRequestCard(event) {
  return flat(event).state !== 'pushing';
}

const DISMISSED_KEY = 'portal.pr-cards.dismissed';
const DISMISSED_MAX = 200;

/** The keys the person dismissed on this browser (best effort: storage may be unavailable). */
export function readDismissedCards() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(DISMISSED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
  } catch { return []; }
}

export function saveDismissedCards(keys) {
  try { globalThis.localStorage?.setItem(DISMISSED_KEY, JSON.stringify(keys.slice(-DISMISSED_MAX))); } catch { /* storage unavailable: it stays hidden until the page reloads */ }
}

/** Only project live events trigger a handoff; stored/replayed run history never does. */
export function reviewHandoffHref(event, workflowId, projectId) {
  if (!projectId || !workflowId || event?.type !== 'run.event' ||
      event.workflowId !== workflowId || event.eventType !== 'pull-request') return null;
  const pr = event.payload;
  if (pr?.state !== 'review-started' || typeof pr.reviewId !== 'string' || !pr.reviewId.trim()) return null;
  return href(projectId, 'reviews', 'code', pr.reviewId);
}

/**
 * What the session shows for each repository: the pending question (answerable here and in the Inbox), progress, PR links
 * and results. Only the latest state per repository counts, so an answered question never leaves an old card behind.
 */
export function sessionPullRequestCards(events) {
  return latestPullRequestStates(events);
}
