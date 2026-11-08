/**
 * What one agent in the node view is doing: its task, its result once it has one, and how much it has used.
 * Shown under the graph for the selected node.
 */
import { useEffect, useState } from 'react';
import { href } from '../../lib/router.js';
import { formatRelative } from '../../lib/util.js';

const STATUS_TEXT = { running: 'Running', pending: 'Starting', done: 'Done', failed: 'Failed', stopped: 'Stopped', paused: 'Paused' };

export function agentStatusClass(status) {
  if (status === 'running' || status === 'pending') return 'is-running';
  if (status === 'failed') return 'is-failed';
  return 'is-done';
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Elapsed time: ticks while the agent runs; afterwards its reported duration, or finish minus start. */
function useElapsed(agent) {
  const live = (agent.status === 'running' || agent.status === 'pending') && agent.startedAt;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  if (live) return formatDuration(Date.now() - new Date(agent.startedAt).getTime());
  if (agent.durationMs != null) return formatDuration(agent.durationMs);
  if (agent.startedAt && agent.finishedAt) return formatDuration(new Date(agent.finishedAt) - new Date(agent.startedAt));
  return null;
}

/**
 * @param {{ agent: object, projectId?: string }} props agent is a row from /api/workflows/:id/agents, or the session itself
 */
export function AgentDetail({ agent, projectId }) {
  const elapsed = useElapsed(agent);
  return (
    <section className="agent-detail" aria-label={`Details for ${agent.name}`}>
      <div className="agent-detail-head">
        <span className={`agent-detail-pill ${agentStatusClass(agent.status)}`}>{STATUS_TEXT[agent.status] || agent.status || 'Unknown'}</span>
        <strong className="agent-detail-name">{agent.name}</strong>
      </div>
      <h4 className="agent-detail-label">Task</h4>
      <p className="agent-detail-text">{agent.description || 'This agent did not report a task.'}</p>
      {agent.summary && (
        <>
          <h4 className="agent-detail-label">Result</h4>
          <p className="agent-detail-text">{agent.summary}</p>
        </>
      )}
      <dl className="agent-detail-stats">
        {elapsed && (<><dt>Time</dt><dd>{elapsed}</dd></>)}
        {agent.toolUses != null && (<><dt>Tool calls</dt><dd>{agent.toolUses}</dd></>)}
        {agent.tokens != null && (<><dt>Tokens</dt><dd>{agent.tokens.toLocaleString()}</dd></>)}
        {agent.startedAt && (<><dt>Started</dt><dd>{formatRelative(agent.startedAt)}</dd></>)}
        {agent.finishedAt && (<><dt>Finished</dt><dd>{formatRelative(agent.finishedAt)}</dd></>)}
      </dl>
      {agent.source === 'session' && agent.sessionId && projectId && (
        <a className="agent-detail-open" href={href(projectId, 'sessions', agent.sessionId)}>Open this session</a>
      )}
    </section>
  );
}
