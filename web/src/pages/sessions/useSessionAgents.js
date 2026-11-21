/**
 * The agents working under a session (sub-agents and delegated sessions), kept current.
 *
 * Loads the list, refreshes it every 5 seconds while the page is visible, and refreshes at once when the project
 * stream reports a sub-agent or child session starting or finishing. `agents` is null until the first answer.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { subscribeProject } from '../../lib/events.js';

export function useSessionAgents(workflowId, projectId) {
  const [agents, setAgents] = useState(null);

  const load = useCallback(async () => {
    if (!workflowId) return;
    try {
      const data = await api.get(`/api/workflows/${workflowId}/agents`);
      setAgents(data.agents || []);
    } catch {
      // A dropped connection: keep what is shown and try again on the next tick.
      setAgents((current) => current ?? []);
    }
  }, [workflowId]);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!projectId) return undefined;
    return subscribeProject(projectId, (event) => {
      const child = (event.type === 'workflow.child-started' || event.type === 'workflow.child-finished') && event.parentWorkflowId === workflowId;
      const sub = event.type === 'run.event' && event.workflowId === workflowId && typeof event.eventType === 'string' && event.eventType.startsWith('subagent-');
      if (child || sub) load();
    });
  }, [projectId, workflowId, load]);

  return { agents, reload: load };
}
