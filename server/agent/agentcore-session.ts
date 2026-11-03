/**
 * One AgentCore session per portal session.
 *
 * AgentCore keeps a session's persistent folder (see infra: filesystemConfigurations) only for invocations that use
 * the same runtime session id, so every message of a portal session, and the "prepare repositories" step, use the
 * id derived here. Ids must be at least 33 characters.
 */

import { createHash } from 'node:crypto';

export function agentCoreSessionId(workflowId: string, engine: 'kiro' | 'claude-code'): string {
  const h = createHash('sha256').update(`${engine}|${workflowId}`).digest('hex');
  return `wf-${engine === 'kiro' ? 'k' : 'c'}-${h.slice(0, 40)}`;
}
