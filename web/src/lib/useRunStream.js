import { useEffect, useRef, useState } from 'react';
import { api, stream } from './api.js';

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
    reloadDetail()
      .then((r) => {
        if (!alive) return;
        if (!['completed', 'failed', 'stopped'].includes(r.run.status) || r.active) {
          close = stream(() => `/api/runs/${runId}/stream?after=${lastSeq.current}`, {
            event: (e) => {
              if (e.seq <= lastSeq.current) return;
              lastSeq.current = e.seq;
              setState((s) => ({ ...s, events: [...s.events, e] }));
              if (e.type === 'portal:input' || e.type === 'portal:input_answered') api.get(`/api/runs/${runId}`).then((r2) => setState((s) => ({ ...s, inputs: r2.inputs })));
            },
            run: (summary) => {
              setState((s) => ({ ...s, run: { ...s.run, ...summary } }));
              if (['completed', 'failed', 'stopped'].includes(summary.status)) reloadDetail();
            },
          });
        }
      })
      .catch((error) => setState((s) => ({ ...s, loading: false, error })));
    return () => {
      alive = false;
      close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);
  return { ...state, reload: reloadDetail };
}
