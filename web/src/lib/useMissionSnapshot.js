import { useEffect, useState } from 'react';
import { api } from './api.js';
import { subscribeProject } from './events.js';

/** A bounded view of one session. Each resource keeps its last successful answer on a refresh failure. */
export function useMissionSnapshot(id, projectId) {
  const [snapshot, setSnapshot] = useState({ loading: true, refreshing: false, errors: {}, updatedAt: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let busy = false;
    let timer;
    const base = `/api/workflows/${encodeURIComponent(id)}`;
    const urls = {
      workflow: `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(id)}`,
      agents: `${base}/agents`,
      events: `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(id)}/transcript?limit=50`,
      files: `${base}/output-files`,
    };
    const load = async () => {
      if (busy || disposed) return;
      busy = true;
      setSnapshot((previous) => ({ ...previous, refreshing: true }));
      const keys = Object.keys(urls);
      const results = await Promise.allSettled(keys.map((key) => api.get(urls[key])));
      if (!disposed) setSnapshot((previous) => {
        const next = { ...previous, loading: false, refreshing: false, errors: {} };
        results.forEach((result, index) => {
          const key = keys[index];
          if (result.status === 'rejected') next.errors[key] = result.reason?.message || 'Unavailable';
          else {
            const value = result.value;
            next[key] = key === 'workflow' ? value.workflow : key === 'events' ? [...(value.events || [])].reverse() : value[key] || [];
          }
        });
        // A partial refresh must never claim the entire snapshot is current.
        if (!Object.keys(next.errors).length) next.updatedAt = new Date().toISOString();
        return next;
      });
      busy = false;
    };
    load();
    const interval = setInterval(() => { if (!document.hidden) load(); }, 10000);
    const visible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', visible);
    const unsubscribe = subscribeProject(projectId, (event) => {
      if (event.workflowId === id || event.parentWorkflowId === id) {
        clearTimeout(timer);
        timer = setTimeout(load, 400);
      }
    });
    return () => { disposed = true; clearTimeout(timer); clearInterval(interval); unsubscribe(); document.removeEventListener('visibilitychange', visible); };
  }, [id, projectId, retry]);
  return { ...snapshot, refresh: () => setRetry((value) => value + 1) };
}
