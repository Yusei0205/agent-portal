/**
 * useRunStream(runId)
 *
 * Subscribes to GET /api/runs/:id/events (SSE).
 * Replays historical events first (the server sends them on connect),
 * then receives live events as the run progresses.
 *
 * Returns:
 *   events    — array of event objects { id, run_id, type, payload, created_at }
 *   connected — true once the EventSource is open
 *   error     — string | null
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @param {string | null | undefined} runId
 * @returns {{ events: object[], connected: boolean, error: string | null }}
 */
export function useRunStream(runId) {
  const [state, setState] = useState({
    events: [],
    connected: false,
    error: null,
  });

  // Keep a ref to the set of event IDs we've already received so we can
  // deduplicate the historical replay if the stream reconnects.
  const seen = useRef(/** @type {Set<string | number>} */ (new Set()));
  const retryTimer = useRef(null);

  const connect = useCallback((id, alive) => {
    const url = `/api/runs/${encodeURIComponent(id)}/events`;
    const es = new EventSource(url, { withCredentials: true });

    es.onopen = () => {
      if (!alive.v) return;
      setState((s) => ({ ...s, connected: true, error: null }));
    };

    es.onmessage = (e) => {
      if (!alive.v) return;
      try {
        const frame = JSON.parse(e.data);
        // The server wraps each event as { type: 'event', event: {...} }
        if (frame.type === 'event' && frame.event) {
          const ev = frame.event;
          const key = ev.id ?? `${ev.type}-${ev.created_at}`;
          if (seen.current.has(key)) return;
          seen.current.add(key);
          setState((s) => ({ ...s, events: [...s.events, ev] }));
        }
      } catch {
        // ignore malformed frames
      }
    };

    es.onerror = () => {
      if (!alive.v) return;
      es.close();
      setState((s) => ({ ...s, connected: false }));
      // Auto-reconnect after 3 s
      retryTimer.current = setTimeout(() => {
        if (alive.v) connect(id, alive);
      }, 3000);
    };

    return es;
  }, []);

  useEffect(() => {
    if (!runId) {
      setState({ events: [], connected: false, error: null });
      return;
    }

    // Reset state on runId change
    seen.current = new Set();
    setState({ events: [], connected: false, error: null });

    const alive = { v: true };
    const es = connect(runId, alive);

    return () => {
      alive.v = false;
      clearTimeout(retryTimer.current);
      es.close();
    };
  }, [runId, connect]);

  return state;
}

export default useRunStream;
