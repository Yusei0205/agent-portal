import { REACTION_GAP_MS } from './cat-brain.js';

/**
 * Which live events the cat reacts to (only the open project's stream is subscribed, so every event here is the current project's).
 * @returns {{ animation: 'celebrate'|'worried'|'alert', text: string, href: string|null } | null}
 */
export function moodForEvent(event, ctx) {
  if (!event || typeof event !== 'object') return null;
  const inbox = '#/inbox';
  if (event.type === 'inbox.created') {
    return { animation: 'alert', text: 'Something needs you in the Inbox.', href: inbox };
  }
  if (event.type !== 'workflow.updated') return null;
  const table = {
    done: { animation: 'celebrate', text: 'A session finished.' },
    failed: { animation: 'worried', text: 'A session failed.' },
    blocked: { animation: 'alert', text: 'A session is blocked and needs you.' },
  };
  const hit = table[event.status];
  if (!hit) return null;
  const id = event.workflowId;
  const href = typeof id === 'string' && id && ctx?.projectId
    ? `#/p/${ctx.projectId}/sessions/${id}`
    : inbox;
  return { ...hit, href };
}

/** True at most once per gap, never while the tab is hidden; a refused call does not consume the gap. */
export function createReactionGate(gapMs = REACTION_GAP_MS) {
  let last = -Infinity;
  return (nowMs, hidden) => {
    if (hidden) return false;
    if (nowMs - last < gapMs) return false;
    last = nowMs;
    return true;
  };
}
