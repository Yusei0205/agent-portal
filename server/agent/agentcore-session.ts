/**
 * One AgentCore session per portal session.
 *
 * Every message of a portal session, and the "prepare repositories" step, use the id derived here, so they reach the
 * same machine while it is warm (its workspace folder is still there) and the same saved workspace afterwards
 * (runner-snapshot.ts). Ids must be at least 33 characters.
 */

import { createHash } from 'node:crypto';

export function agentCoreSessionId(workflowId: string, engine: 'kiro' | 'claude-code' | 'codex'): string {
  const h = createHash('sha256').update(`${engine}|${workflowId}`).digest('hex');
  return `wf-${engine === 'kiro' ? 'k' : engine === 'codex' ? 'x' : 'c'}-${h.slice(0, 40)}`;
}
