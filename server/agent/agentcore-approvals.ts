/**
 * Approvals inside an AgentCore runner (the microVM side).
 *
 * Pure module: depends only on node:crypto. Copied into agent-runner and kiro-runner
 * at image build time, like guard.ts and tool-policy.ts.
 *
 * How a person approves a tool call that runs in a microVM:
 *   1. The runner opens a request here and streams an `approval-request` event
 *      (requestId, tool, exact input, its SHA-256 fingerprint) on the run's SSE stream.
 *   2. The portal shows it to a person through its normal approval flow
 *      (fingerprint binding, expiry, one answer wins: runner.ts awaitApproval).
 *   3. The portal sends the answer as a second InvokeAgentRuntime call on the same
 *      session: { mode: 'answer', runId, requestId, decision, inputHash, ... }.
 *      AgentCore routes it to the same microVM, and the runner settles the request here.
 *
 * The microVM never holds a portal credential: answers only arrive through
 * InvokeAgentRuntime, which needs the portal's IAM permissions.
 *
 * An answer counts only when it names this run, an open request, and the exact
 * fingerprint of the call that was shown. A request settles once: by the first valid
 * answer, by expiry (declined), or when the run stops (declined).
 */

import { randomUUID } from 'node:crypto';

export interface ApprovalOutcome {
  decision: 'allow' | 'deny';
  remember: boolean;
  message: string;
  expired?: boolean;
}

export interface ApprovalAnswer {
  runId: string;
  requestId: string;
  decision: 'allow' | 'deny';
  inputHash: string;
  remember?: boolean;
  message?: string;
}

export type AnswerResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409; error: string };

interface Pending {
  runId: string;
  inputHash: string;
  settle: (o: ApprovalOutcome) => void;
}

export interface OpenedApproval {
  requestId: string;
  /** ISO time after which the request is declined. */
  expiresAt: string;
  outcome: Promise<ApprovalOutcome>;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  /** Open a request for one exact tool call. Settles on a valid answer, on expiry, or on abort. */
  open(runId: string, inputHash: string, expiryMs: number, signal?: AbortSignal | null): OpenedApproval {
    const requestId = randomUUID();
    const expiresAt = new Date(Date.now() + expiryMs).toISOString();
    const minutes = Math.round((expiryMs / 60_000) * 10) / 10;
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => settle({ decision: 'deny', remember: false, message: 'The run stopped before anyone answered.' });
      const settle = (o: ApprovalOutcome): void => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(o);
      };
      this.pending.set(requestId, { runId, inputHash, settle });
      timer = setTimeout(
        () => settle({ decision: 'deny', remember: false, expired: true, message: `Nobody answered within ${minutes} minutes, so this call was not run.` }),
        expiryMs,
      );
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    return { requestId, expiresAt, outcome };
  }

  /** Apply an answer. A wrong fingerprint is refused and leaves the request open. */
  answer(a: ApprovalAnswer): AnswerResult {
    const p = this.pending.get(a.requestId);
    if (!p) return { ok: false, status: 404, error: 'This run is not waiting for that approval (already answered, expired, or the run ended).' };
    if (p.runId !== a.runId) return { ok: false, status: 403, error: 'That approval belongs to another run.' };
    if (p.inputHash !== a.inputHash) return { ok: false, status: 409, error: 'The answer is for a different tool call than the one waiting.' };
    p.settle({ decision: a.decision, remember: a.decision === 'allow' && Boolean(a.remember), message: a.message ?? '' });
    return { ok: true };
  }

  /** Decline every open request of a run (the run ended). */
  closeRun(runId: string, message = 'The run ended before anyone answered.'): void {
    for (const p of [...this.pending.values()]) {
      if (p.runId === runId) p.settle({ decision: 'deny', remember: false, message });
    }
  }

  get openCount(): number {
    return this.pending.size;
  }
}

/** Validate the body of an answer invocation. Returns the answer or an error message. */
export function parseApprovalAnswer(raw: Record<string, unknown>): ApprovalAnswer | string {
  const known = new Set(['mode', 'runId', 'requestId', 'decision', 'inputHash', 'remember', 'message']);
  for (const k of Object.keys(raw)) if (!known.has(k)) return `Unknown field: "${k}"`;
  const str = (k: string, max: number): string | null =>
    typeof raw[k] === 'string' && (raw[k] as string).length > 0 && (raw[k] as string).length <= max ? (raw[k] as string) : null;
  const runId = str('runId', 256);
  const requestId = str('requestId', 64);
  const inputHash = str('inputHash', 64);
  if (!runId) return '"runId" must be a non-empty string';
  if (!requestId) return '"requestId" must be a non-empty string';
  if (!inputHash || !/^[0-9a-f]{64}$/.test(inputHash)) return '"inputHash" must be a SHA-256 hex string';
  if (raw.decision !== 'allow' && raw.decision !== 'deny') return '"decision" must be "allow" or "deny"';
  if (raw.remember !== undefined && typeof raw.remember !== 'boolean') return '"remember" must be a boolean';
  if (raw.message !== undefined && (typeof raw.message !== 'string' || raw.message.length > 4000)) return '"message" must be a string of at most 4000 characters';
  return {
    runId,
    requestId,
    inputHash,
    decision: raw.decision,
    remember: raw.remember as boolean | undefined,
    message: raw.message as string | undefined,
  };
}
