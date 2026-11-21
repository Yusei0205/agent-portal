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

/**
 * Which sessions are running, from the live events: a `workflow.updated` with status running (or pending) adds the session,
 * any other status (done, failed, blocked, stopped, paused, cancelled ...) removes it. Pure: returns the same set when nothing changed,
 * a new set when it did, so a caller can compare by identity. Events without a workflow id, and other event types, change nothing.
 * @param {ReadonlySet<string>} running
 * @returns {ReadonlySet<string>}
 */
export function trackRunning(running, event) {
  if (!event || typeof event !== 'object' || event.type !== 'workflow.updated') return running;
  const id = event.workflowId;
  if (typeof id !== 'string' || !id || typeof event.status !== 'string') return running;
  const on = event.status === 'running' || event.status === 'pending';
  if (on === running.has(id)) return running;
  const next = new Set(running);
  if (on) next.add(id); else next.delete(id);
  return next;
}

/** The cat works while at least one session of the open project is running. */
export const isWorking = (running) => running.size > 0;

/**
 * Which animation the cat shows: a reaction (celebrate / worried / alert) wins, then a wave while hovered, then walking, then working
 * (a running session), then idle. Working also stops it roaming (see `roamPaused`).
 */
export function pickMotion({ reaction = null, walking = false, hovered = false, working = false } = {}) {
  if (reaction) return reaction;
  if (walking) return 'walk';
  if (hovered) return 'wave';
  return working ? 'working' : 'idle';
}

/** Roaming pauses while the cat works (it stays at its laptop). */
export const roamPaused = (working) => Boolean(working);
