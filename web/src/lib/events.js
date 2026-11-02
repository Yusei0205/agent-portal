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
 * @param {string} url
 * @param {(event: Record<string, unknown>) => void} onEvent
 * @returns {() => void} unsubscribe
 */
function subscribe(url, onEvent) {
  let es = null;
  let closed = false;
  let retryTimer = null;

  function connect() {
    if (closed) return;
    es = new EventSource(url, { withCredentials: true });

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent(data);
      } catch {
        // ignore malformed frames
      }
    };

    es.onerror = () => {
      if (es) { es.close(); es = null; }
      if (!closed) retryTimer = setTimeout(connect, 3000);
    };
  }

  connect();

  return function unsubscribe() {
    closed = true;
    clearTimeout(retryTimer);
    if (es) { es.close(); es = null; }
  };
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
