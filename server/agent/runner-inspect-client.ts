/**
 * Asking a cloud session's runner machine about its workspace (read-only). The session IDE's Explorer and Source
 * Control tabs use this for sessions that run on AgentCore, because their files are on that machine, not on the portal.
 * The request goes to the session's own AgentCore session, so each portal session looks at its own machine.
 */

import { randomUUID } from 'node:crypto';
import { invokeAgentCore } from './kiro-agentcore.ts';
import { agentCoreSessionId } from './agentcore-session.ts';
import { snapshotAccess } from './runner-snapshot-access.ts';
import { runtimeFor } from './repo-prep.ts';
import type { InspectRequest, InspectResult } from './runner-inspect.ts';

/** True when this session's engine runs on an AgentCore runner (so its files are on that machine). */
export function isCloudSession(engine: string): boolean {
  return runtimeFor(engine) !== null;
}

export async function inspectViaRunner(workflowId: string, engine: string, req: InspectRequest): Promise<InspectResult> {
  const rt = runtimeFor(engine);
  if (!rt) return { ok: false, status: 404, error: 'This session does not run on a cloud machine' };
  const snapshot = await snapshotAccess(workflowId).catch(() => null);
  const payload: Record<string, unknown> = {
    mode: 'inspect',
    runId: `inspect-${randomUUID()}`,
    op: req.op,
    ...(req.path ? { path: req.path } : {}),
    ...(req.repo ? { repo: req.repo } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
  const ac = new AbortController();
  // A machine that is waking up needs a while; the page asks again rather than hang.
  const timer = setTimeout(() => ac.abort(new Error('timed out')), 25_000);
  try {
    for await (const raw of invokeAgentCore(rt.arn, agentCoreSessionId(workflowId, rt.kind), payload, ac.signal)) {
      const ev = raw as unknown as Record<string, unknown>;
      if (ev.type === 'inspect') {
        if (ev.ok === true) return { ok: true, data: (ev.data ?? {}) as Record<string, unknown> };
        return { ok: false, status: Number(ev.status ?? 500), error: String(ev.error ?? 'The runner could not answer') };
      }
    }
    return { ok: false, status: 502, error: 'The session machine returned no answer' };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, status: 503, error: "The session's machine is starting. Try again in a few seconds." };
    return { ok: false, status: 502, error: e instanceof Error ? e.message.slice(0, 200) : 'The session machine could not be reached' };
  } finally {
    clearTimeout(timer);
  }
}

export type FlushResult = { ok: true; skipped?: string } | { ok: false; error: string };

/**
 * Asks the session's machine for `engine` to save its workspace now and waits until it is saved. Used when the
 * session is switched to another engine: that engine's machine then restores these files (the saved copy is per
 * session, see runner-snapshot.ts). Nothing to do when `engine` does not run on AgentCore or snapshots are off.
 */
export async function flushWorkspaceViaRunner(workflowId: string, engine: string, timeoutMs = 3 * 60_000): Promise<FlushResult> {
  const rt = runtimeFor(engine);
  if (!rt) return { ok: true, skipped: 'not a cloud engine' };
  const snapshot = await snapshotAccess(workflowId).catch(() => null);
  if (!snapshot) return { ok: true, skipped: 'workspace snapshots are off' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timed out')), timeoutMs);
  try {
    const payload = { mode: 'flush-workspace', runId: `flush-${randomUUID()}`, snapshot };
    for await (const raw of invokeAgentCore(rt.arn, agentCoreSessionId(workflowId, rt.kind), payload, ac.signal)) {
      const ev = raw as unknown as Record<string, unknown>;
      if (ev.type === 'flush') return ev.ok === true ? { ok: true } : { ok: false, error: String(ev.error ?? 'The runner could not save the workspace') };
    }
    // A runner image from before this request existed answers nothing we know.
    return { ok: false, error: 'the runner did not confirm the save (its image may need updating)' };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, error: 'saving took too long' };
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'the machine could not be reached' };
  } finally {
    clearTimeout(timer);
  }
}
