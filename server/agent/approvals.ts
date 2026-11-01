/**
 * In-memory approval resolution map.
 *
 * Extracted from runner.ts so inbox.ts can resolve approvals without creating
 * a runner→inbox→runner circular import chain.
 *
 * Both crud.ts (POST /runs/:rid/input) and inbox.ts (POST /inbox/:id/resolve)
 * import resolveApproval from here, guaranteeing the two approval paths share
 * one implementation and cannot drift.
 */

export interface PendingApproval {
  resolve: (v: { decision: 'allow' | 'deny'; remember: boolean; message: string; expired?: boolean }) => void;
  reject:  (e: unknown) => void;
  /** Cancels the wait when nobody answers in time. */
  timer?: ReturnType<typeof setTimeout>;
}

/** runId → inputId → resolver */
export const pendingApprovals = new Map<string, Map<string, PendingApproval>>();

/**
 * Resolve a pending approval input.
 *
 * Called by:
 *   - crud.ts  POST /api/projects/:id/workflows/:wid/runs/:rid/input
 *   - inbox.ts POST /api/inbox/:id/resolve  (approval items)
 *
 * Returns false if the run is not waiting for this input (already answered or
 * the run ended before anyone responded).
 */
export function resolveApproval(
  runId: string,
  inputId: string,
  decision: 'allow' | 'deny',
  opts?: { remember?: boolean; message?: string },
): boolean {
  const runMap = pendingApprovals.get(runId);
  const pending = runMap?.get(inputId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  runMap!.delete(inputId);
  if (runMap!.size === 0) pendingApprovals.delete(runId);
  pending.resolve({ decision, remember: Boolean(opts?.remember), message: opts?.message ?? '' });
  return true;
}
