/**
 * Client-side SSE subscriptions.
 *
 * subscribeProject(projectId, onEvent) — project-scoped SSE stream.
 * subscribeGlobal(onEvent)             — portal-level SSE stream (no project).
 *
 * Both return an unsubscribe function that closes the connection.
 */

import { realtimeAvailable, subscribeChannel } from './realtime.js';

/**
 * One EventSource per URL, shared by every subscriber on the page.
 *
 * The local portal is served over HTTP/1.1, where a browser allows only six open connections to one host across all
 * its tabs. The session page alone used to open a separate project stream for the page, the cat, the flow strip and
 * the agents list; with the global stream and the run stream that used up every connection, so plain requests such as
 * the file explorer's never got sent and spun forever. Sharing the stream keeps it to one connection per channel.
 *
 * @type {Map<string, { listeners: Set<(event: Record<string, unknown>) => void>, es: EventSource | null, retryTimer: ReturnType<typeof setTimeout> | null }>}
 */
const shared = new Map();

/** @param {string} url */
function connectShared(url) {
  const entry = shared.get(url);
  if (!entry) return;
  const es = new EventSource(url, { withCredentials: true });
  entry.es = es;

  es.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return; // ignore malformed frames
    }
    for (const listener of [...entry.listeners]) {
      try {
        listener(data);
      } catch (err) {
        console.error('[events] listener failed', err);
      }
    }
  };

  es.onerror = () => {
    es.close();
    if (entry.es === es) entry.es = null;
    if (shared.get(url) === entry) entry.retryTimer = setTimeout(() => connectShared(url), 3000);
  };
}

/**
 * @param {string} url
 * @param {(event: Record<string, unknown>) => void} onEvent
 * @returns {() => void} unsubscribe
 */
function subscribe(url, onEvent) {
  let entry = shared.get(url);
  if (!entry) {
    entry = { listeners: new Set(), es: null, retryTimer: null };
    shared.set(url, entry);
    entry.listeners.add(onEvent);
    connectShared(url);
  } else {
    entry.listeners.add(onEvent);
  }
  const mine = entry;
  let closed = false;

  return function unsubscribe() {
    if (closed) return;
    closed = true;
    mine.listeners.delete(onEvent);
    if (mine.listeners.size > 0 || shared.get(url) !== mine) return;
    shared.delete(url);
    if (mine.retryTimer) clearTimeout(mine.retryTimer);
    if (mine.es) { mine.es.close(); mine.es = null; }
  };
}

/** Number of open shared streams (for tests). */
export function _sharedStreamCount() {
  return shared.size;
}

/**
 * Use AppSync Events when the server has it enabled (cloud portal), otherwise Server-Sent Events.
 *
 * @param {string} channel AppSync channel
 * @param {string} sseUrl  SSE endpoint used when realtime is not enabled
 * @param {(event: Record<string, unknown>) => void} onEvent
 * @returns {() => void} unsubscribe
 */
function subscribeViaRealtimeOrSse(channel, sseUrl, onEvent) {
  let closed = false;
  let unsub = null;
  realtimeAvailable().then((enabled) => {
    if (closed) return;
    unsub = enabled ? subscribeChannel(channel, onEvent) : subscribe(sseUrl, onEvent);
  });
  return function unsubscribe() {
    closed = true;
    if (unsub) { unsub(); unsub = null; }
  };
}

/**
 * Subscribe to the project's SSE channel.
 *
 * @param {string} projectId
 * @param {(event: Record<string, unknown>) => void} onEvent
 * @returns {() => void} unsubscribe function
 */
export function subscribeProject(projectId, onEvent) {
  return subscribeViaRealtimeOrSse(
    `/project/${projectId}`,
    `/api/projects/${encodeURIComponent(projectId)}/events`,
    onEvent,
  );
}

/**
 * Subscribe to the global (portal-level) SSE channel.
 * The server sends events like { type: 'theme.changed', etag } here.
 *
 * @param {(event: Record<string, unknown>) => void} onEvent
 * @returns {() => void} unsubscribe function
 */
export function subscribeGlobal(onEvent) {
  return subscribeViaRealtimeOrSse('/global/portal', '/api/events', onEvent);
}
