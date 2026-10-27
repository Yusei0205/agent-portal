/**
 * Client-side SSE subscriptions.
 *
 * subscribeProject(projectId, onEvent) — subscribes to project-scoped SSE events.
 * Returns an unsubscribe function that closes the connection.
 *
 * The server emits JSON objects as SSE data frames. Each call opens one
 * EventSource connection; multiple components can subscribe independently.
 */

/**
 * Subscribe to the project's SSE channel.
 *
 * @param {string} projectId
 * @param {(event: Record<string, unknown>) => void} onEvent
 * @returns {() => void} unsubscribe function
 */
export function subscribeProject(projectId, onEvent) {
  const url = `/api/projects/${encodeURIComponent(projectId)}/events`;
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
      // EventSource will auto-retry; we close and re-open ourselves after 3s
      // to have explicit control.
      if (es) {
        es.close();
        es = null;
      }
      if (!closed) {
        retryTimer = setTimeout(connect, 3000);
      }
    };
  }

  connect();

  return function unsubscribe() {
    closed = true;
    clearTimeout(retryTimer);
    if (es) {
      es.close();
      es = null;
    }
  };
}
