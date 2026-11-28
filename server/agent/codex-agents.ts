import type { RpcParams } from '../codex-client.ts';

/** Translate native collaboration items into the portal's existing agent lifecycle. */
export function createCodexAgentTracker(emit: (type: string, payload: object) => void) {
  const agents = new Map<string, { parentId?: string; name: string; description?: string; status: string }>();
  return {
    has: (id: string) => agents.has(id),
    accept(item: RpcParams) {
      if (item.type !== 'collabAgentToolCall') return;
      const states = item.agentsStates ?? {};
      const ids = new Set<string>([...(item.receiverThreadIds ?? []), ...Object.keys(states)]);
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue;
        const state = states[id];
        const previous = agents.get(id);
        // A completed spawn operation means the child was created, not that its work finished.
        const nativeStatus = state?.status ?? (item.tool === 'spawnAgent' && item.status === 'completed' ? 'running' : null);
        if (!nativeStatus) continue;
        const status = nativeStatus === 'completed' ? 'done'
          : ['errored', 'notFound'].includes(nativeStatus) ? 'failed'
          : ['shutdown', 'interrupted'].includes(nativeStatus) ? 'stopped'
          : nativeStatus === 'pendingInit' ? 'pending' : 'running';
        const agent = previous ?? { ...(item.tool === 'spawnAgent' ? { parentId: String(item.senderThreadId ?? '') } : {}), name: `Codex agent ${id.slice(0, 8)}`,
          ...(item.tool === 'spawnAgent' && typeof item.prompt === 'string' ? { description: item.prompt.slice(0, 2000) } : {}), status: '' };
        if (agent.status === status) continue;
        agent.status = status;
        agents.set(id, agent);
        emit(status === 'done' ? 'subagent-finished' : status === 'failed' || status === 'stopped' ? 'subagent-failed' : 'subagent-started', {
          id, engine: 'codex', ...agent, ...(typeof state?.message === 'string' ? { summary: state.message.slice(0, 4000) } : {}),
        });
      }
    },
  };
}
