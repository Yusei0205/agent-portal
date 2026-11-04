/**
 * The portal side of approvals for runs inside AgentCore microVMs.
 *
 * A runner streams `approval-request` events (see agentcore-approvals.ts). For each one:
 *   1. Check the request: the fingerprint must match the call it describes.
 *   2. Decide again here with the portal's own copy of the rules (guard, block rules), so a
 *      call the portal would refuse is refused without asking anyone.
 *   3. Ask a person through the normal approval flow (ctx.awaitInput: the inbox and live
 *      session card, fingerprint binding, expiry, one answer wins).
 *   4. Send the answer back to the same microVM as a mode "answer" invocation.
 *
 * Requests are handled concurrently, so one open approval never holds up the run's stream.
 */

import { decideToolCall, inputFingerprint, type PolicyRule } from './tool-policy.ts';
import type { RunContext } from './types.ts';

export interface ApprovalRequestEvent {
  type: 'approval-request';
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  inputHash: string;
}

export interface ApprovalAnswerPayload {
  mode: 'answer';
  runId: string;
  requestId: string;
  decision: 'allow' | 'deny';
  inputHash: string;
  remember: boolean;
  message: string;
}

/** Sends one control invocation (answer or cancel) to the run's microVM and returns its reply events. */
export type ControlSender = (payload: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;

export function isApprovalRequest(ev: Record<string, unknown>): ev is ApprovalRequestEvent & Record<string, unknown> {
  return ev.type === 'approval-request'
    && typeof ev.requestId === 'string'
    && typeof ev.toolName === 'string'
    && typeof ev.inputHash === 'string'
    && !!ev.input && typeof ev.input === 'object' && !Array.isArray(ev.input);
}

/**
 * Decide the answer to one approval request.
 * `rules` are the rules the portal re-checks (an empty list re-checks only the guard).
 */
export async function decideApprovalRequest(
  ctx: RunContext,
  ev: ApprovalRequestEvent,
  rules: readonly PolicyRule[],
): Promise<{ decision: 'allow' | 'deny'; remember: boolean; message: string }> {
  const { toolName, input } = ev;
  const inputStr = JSON.stringify(input);

  if (inputFingerprint(toolName, input) !== ev.inputHash) {
    const message = 'The approval request did not match the tool call it describes, so it was declined.';
    ctx.emit('tool-blocked', { toolName, toolInput: inputStr, reason: message });
    return { decision: 'deny', remember: false, message };
  }

  // The working folder is inside the microVM, so the runner checks it; the portal re-checks the rest.
  const again = decideToolCall({ toolName, input, workDir: null, rules, trusted: ctx.run.trusted, allowed: new Set() });
  if (again.action === 'deny') {
    ctx.emit('tool-blocked', { toolName, toolInput: inputStr, reason: again.reason });
    return { decision: 'deny', remember: false, message: again.reason };
  }

  try {
    const resp = await ctx.awaitInput(toolName, input);
    if (resp.decision === 'allow') return { decision: 'allow', remember: resp.remember, message: '' };
    const message = resp.expired ? resp.message : (resp.message ? `The user declined: ${resp.message}` : 'The user declined this action.');
    return { decision: 'deny', remember: false, message };
  } catch {
    return { decision: 'deny', remember: false, message: 'The run stopped before anyone answered.' };
  }
}

/** Relays a run's approval requests to people and their answers back to the microVM. */
export class ApprovalRelay {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly ctx: RunContext,
    private readonly send: ControlSender,
    private readonly rules: readonly PolicyRule[],
  ) {}

  handle(ev: ApprovalRequestEvent): void {
    const job = (async () => {
      const outcome = await decideApprovalRequest(this.ctx, ev, this.rules);
      if (this.ctx.signal?.aborted) return;
      const answer: ApprovalAnswerPayload = {
        mode: 'answer',
        runId: this.ctx.run.runId,
        requestId: ev.requestId,
        decision: outcome.decision,
        inputHash: ev.inputHash,
        remember: outcome.remember,
        message: outcome.message,
      };
      try {
        const replies = await this.send(answer as unknown as Record<string, unknown>);
        const rejected = replies.find((r) => r.type === 'answer-rejected');
        if (rejected) this.ctx.emit('status', { text: `The agent did not take the answer: ${String(rejected.error ?? 'unknown reason')}` });
      } catch (e) {
        this.ctx.emit('status', { text: `Could not send the answer to the agent: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
      }
    })();
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
  }

}
