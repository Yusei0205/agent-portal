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
 *
 * Child sessions (delegation): with delegation on, the runner offers Claude delegate_session
 * (mcp__portal__delegate_session) and streams each call as a `delegate-request`. DelegationRelay
 *   1. checks the request's fingerprint against the call it describes,
 *   2. re-checks the block rules for mcp__portal__delegate_session with the portal's own copy,
 *   3. starts the child session (createChildSession: its own run, so its own microVM), run by the
 *      agent the call names (one of the run's agents) or else by the parent's lead agent,
 *   4. answers the microVM like an approval: the child's ID and title, or why none was started.
 * The child runs on its own; when it finishes, its result is posted to the parent session
 * (deliverChildResult in delegation.ts).
 */

import { decideToolCall, inputFingerprint, type PolicyRule } from './tool-policy.ts';
import { AGENT_NAME } from './agent-defs.ts';
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

// ── Child sessions (delegate_session) ─────────────────────────────────────────

/** The runner's tool that asks the portal for a child session (agent-runner/src/run.ts). */
export const DELEGATE_TOOL = 'delegate_session';
/** The name the model and the permission rules see for it (MCP server "portal"). */
export const DELEGATE_TOOL_FULL_NAME = 'mcp__portal__delegate_session';

export interface DelegateRequestEvent {
  type: 'delegate-request';
  requestId: string;
  input: { task: string; title?: string; agent?: string };
  inputHash: string;
}

export function isDelegateRequest(ev: Record<string, unknown>): ev is DelegateRequestEvent & Record<string, unknown> {
  const input = ev.input as Record<string, unknown> | null;
  return ev.type === 'delegate-request'
    && typeof ev.requestId === 'string'
    && typeof ev.inputHash === 'string'
    && !!input && typeof input === 'object' && !Array.isArray(input)
    && typeof input.task === 'string';
}

/**
 * Starts a child session of this run's session, run by `agent` when given (one of the run's agents).
 * Throws with a message the agent can read.
 */
export type StartChildSession = (task: string, title: string | undefined, agent: string | undefined) => Promise<{ id: string; title: string }>;

/** Longest answer the runner accepts (agentcore-approvals.ts parseApprovalAnswer). */
const MAX_ANSWER = 4000;

/**
 * Starts child sessions for a run's delegate_session calls and sends each result back to the
 * microVM as a mode "answer" invocation (the runner holds the call open in its broker).
 * Each child is a portal session of its own: its own run, so on AgentCore its own microVM.
 * When it finishes, the portal posts its result to the parent session (delegation.ts).
 */
export class DelegationRelay {
  constructor(
    private readonly ctx: RunContext,
    private readonly send: ControlSender,
    private readonly rules: readonly PolicyRule[],
    /** Null when this run may not start child sessions: every request is declined. */
    private readonly start: StartChildSession | null,
  ) {}

  /** The answer to one request: the new session as JSON, or why none was started. */
  async decide(ev: DelegateRequestEvent): Promise<{ decision: 'allow' | 'deny'; message: string }> {
    const input = ev.input as Record<string, unknown>;
    const fields = Object.keys(input);
    const exact = fields.every((k) => k === 'task' || k === 'title' || k === 'agent')
      && (input.title === undefined || typeof input.title === 'string')
      && (input.agent === undefined || (typeof input.agent === 'string' && AGENT_NAME.test(input.agent)))
      && inputFingerprint(DELEGATE_TOOL, input) === ev.inputHash;
    if (!exact) return { decision: 'deny', message: 'The request did not match the call it describes, so no session was started.' };
    if (!this.start) return { decision: 'deny', message: 'Child sessions are turned off for this run.' };

    // The runner already applied the rules; the portal re-checks with its own copy (block rules).
    const again = decideToolCall({ toolName: DELEGATE_TOOL_FULL_NAME, input, workDir: null, rules: this.rules, trusted: this.ctx.run.trusted, allowed: new Set() });
    if (again.action === 'deny') return { decision: 'deny', message: again.reason };

    const task = String(input.task).trim();
    if (!task) return { decision: 'deny', message: 'The task is empty.' };
    const agent = typeof input.agent === 'string' ? input.agent : undefined;
    try {
      const child = await this.start(task, typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined, agent);
      this.ctx.emit('status', { text: `Started child session "${child.title}"${agent ? ` (lead agent: ${agent})` : ''}` });
      const message = JSON.stringify({
        childWorkflowId: child.id,
        title: child.title,
        status: 'started',
        note: 'It runs on its own. Its result is posted to this session when it finishes.',
      });
      return { decision: 'allow', message: message.slice(0, MAX_ANSWER) };
    } catch (e) {
      const reason = String((e as Error)?.message ?? e);
      return { decision: 'deny', message: `No session was started: ${reason}`.slice(0, MAX_ANSWER) };
    }
  }

  handle(ev: DelegateRequestEvent): void {
    void (async () => {
      const outcome = await this.decide(ev);
      if (this.ctx.signal?.aborted) return;
      const answer: ApprovalAnswerPayload = {
        mode: 'answer',
        runId: this.ctx.run.runId,
        requestId: ev.requestId,
        decision: outcome.decision,
        inputHash: ev.inputHash,
        remember: false,
        message: outcome.message,
      };
      try {
        const replies = await this.send(answer as unknown as Record<string, unknown>);
        const rejected = replies.find((r) => r.type === 'answer-rejected');
        if (rejected) this.ctx.emit('status', { text: `The agent did not take the session result: ${String(rejected.error ?? 'unknown reason')}` });
      } catch (e) {
        this.ctx.emit('status', { text: `Could not send the session result to the agent: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
      }
    })();
  }
}
