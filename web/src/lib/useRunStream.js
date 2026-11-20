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
import { realtimeAvailable, subscribeChannel } from './realtime.js';
import { insertRunEvent, mergeRunEvents } from './runEventOrder.js';

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
  const esRef = useRef(/** @type {EventSource | null} */ (null));

  const connect = useCallback((id, alive) => {
    const url = `/api/runs/${encodeURIComponent(id)}/events`;
    const es = new EventSource(url, { withCredentials: true });
    esRef.current = es;

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
    let unsubRealtime = null;
    let pollTimer = null;
    let onVisible = null;
    let done = false;

    const addEvent = (ev) => {
      if (!alive.v || !ev) return;
      if (ev.type === 'run-complete' || ev.type === 'run-failed') done = true;
      const key = ev.id ?? `${ev.type}-${ev.created_at}`;
      if (ev.id && seen.current.has(key)) return;
      if (ev.id) seen.current.add(key);
      setState((s) => ({ ...s, events: insertRunEvent(s.events, ev) }));
    };

    realtimeAvailable().then(async (enabled) => {
      if (!alive.v) return;
      if (!enabled) { connect(runId, alive); return; }

      // Cloud portal: subscribe first so nothing is missed, then load the stored history and merge by id.
      const queued = [];
      let historyLoaded = false;
      unsubRealtime = subscribeChannel(`/run/${runId}`, (ev) => {
        if (!historyLoaded) queued.push(ev); else addEvent(ev);
      });
      setState((s) => ({ ...s, connected: true, error: null }));

      // The stored events after the last one shown, in pages: a long run has tens of thousands of events, and one
      // request used to return only the first 5000, so a reloaded page stopped part of the way through the run.
      let lastId = 0;
      const loadHistory = async () => {
        for (let page = 0; page < 200 && alive.v; page += 1) {
          const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/events/history?after=${lastId}&limit=2000`, { credentials: 'include' });
          if (!res.ok) return;
          const body = await res.json();
          const events = body.events ?? [];
          if (!events.length) return;
          // One state update per page: a long run is read in many pages of thousands of events.
          const fresh = [];
          for (const ev of events) {
            if (typeof ev.id === 'number' && ev.id > lastId) lastId = ev.id;
            if (ev.type === 'run-complete' || ev.type === 'run-failed') done = true;
            const key = ev.id ?? `${ev.type}-${ev.created_at}`;
            if (ev.id && seen.current.has(key)) continue;
            if (ev.id) seen.current.add(key);
            fresh.push(ev);
          }
          if (fresh.length && alive.v) setState((s) => ({ ...s, events: mergeRunEvents(s.events, fresh) }));
        }
      };
      try { await loadHistory(); } catch { /* live events still arrive */ }
      historyLoaded = true;
      for (const ev of queued) addEvent(ev);

      // Safety net: the live channel can miss events (a dropped connection, a late subscribe, a token that ran out
      // on a page left open). Until the run reports it has ended, ask for what is new every few seconds: cheap now,
      // since only events after the last one shown come back. Slower after 20 minutes, and never given up on while the
      // page is open and the run is going (a run can last hours). Every ask is a database read, so it backs off with the age of
      // the run (2.5 s, then 5 s after 2 minutes, then 15 s after 20 minutes) and does not ask at all while the tab is hidden:
      // coming back to the tab asks at once.
      const started = Date.now();
      const pollDelay = () => { const age = Date.now() - started; return age > 20 * 60_000 ? 15_000 : age > 2 * 60_000 ? 5000 : 2500; };
      const poll = async () => {
        if (!alive.v || done || Date.now() - started > 6 * 3600_000) return;
        if (!document.hidden) { try { await loadHistory(); } catch { /* try again */ } }
        if (alive.v && !done) pollTimer = setTimeout(poll, pollDelay());
      };
      pollTimer = setTimeout(poll, 2500);
      onVisible = () => {
        if (document.hidden || !alive.v || done) return;
        clearTimeout(pollTimer);
        poll();
      };
      document.addEventListener('visibilitychange', onVisible);
    });

    return () => {
      alive.v = false;
      if (onVisible) document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(retryTimer.current);
      if (pollTimer) clearTimeout(pollTimer);
      esRef.current?.close();
      esRef.current = null;
      if (unsubRealtime) unsubRealtime();
    };
  }, [runId, connect]);

  return state;
}

export default useRunStream;
