import { useEffect, useRef, useState } from 'react';
import { api, pausedWhenHidden, stream } from './api.js';

/** A run's detail plus its live event stream while it is active. */
export function useRunStream(runId) {
  const [state, setState] = useState({ loading: true, run: null, events: [], inputs: [], continuations: [] });
  const lastSeq = useRef(0);
  const reloadDetail = async () => {
    const r = await api.get(`/api/runs/${runId}`);
    lastSeq.current = Math.max(lastSeq.current, ...r.events.map((e) => e.seq), 0);
    setState({ loading: false, ...r });
    return r;
  };
  useEffect(() => {
    let close = () => {};
    let alive = true;
    // Events arrive in bursts (a tool call, its result, a subagent's first message); render them once per frame.
    let queue = [];
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batch = queue;
      queue = [];
      if (alive && batch.length) setState((s) => ({ ...s, events: s.events.concat(batch) }));
    };
    const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    reloadDetail()
      .then((r) => {
        if (!alive) return;
        if (!['completed', 'failed', 'stopped'].includes(r.run.status) || r.active) {
          // Paused while the tab is in the background (it resumes from the last event it saw), so hidden tabs hold
          // none of the browser's few connections to the portal.
          close = pausedWhenHidden(() => stream(() => `/api/runs/${runId}/stream?after=${lastSeq.current}`, {
            event: (e) => {
              if (e.seq <= lastSeq.current) return;
              lastSeq.current = e.seq;
              queue.push(e);
              if (!frame) frame = schedule(flush);
              if (e.type === 'portal:input' || e.type === 'portal:input_answered') api.get(`/api/runs/${runId}`).then((r2) => setState((s) => ({ ...s, inputs: r2.inputs })));
            },
            run: (summary) => {
              flush();
              setState((s) => ({ ...s, run: { ...s.run, ...summary } }));
              if (['completed', 'failed', 'stopped'].includes(summary.status)) reloadDetail();
            },
          }));
        }
      })
      .catch((error) => setState((s) => ({ ...s, loading: false, error })));
    return () => {
      alive = false;
      if (frame) cancel(frame);
      close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);
  return { ...state, reload: reloadDetail };
}
