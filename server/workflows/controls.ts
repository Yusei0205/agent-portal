/**
 * In-memory run lifecycle controls: cancel and abort-signal tracking.
 */

// ── Active run registry ───────────────────────────────────────────────────────

const controllers = new Map<string, AbortController>();

/**
 * Register a new AbortController for a run.
 * Returns the controller so the caller can pass its signal to the runner.
 */
export function registerRun(runId: string): AbortController {
  const ctrl = new AbortController();
  controllers.set(runId, ctrl);
  return ctrl;
}

/** Cancel a running run by runId. Returns true if the run was found and aborted. */
export function cancelRun(runId: string): boolean {
  const ctrl = controllers.get(runId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

/** Check whether a run has been cancelled. */
export function isRunCancelled(runId: string): boolean {
  const ctrl = controllers.get(runId);
  return ctrl ? ctrl.signal.aborted : false;
}

/** Remove a run from the registry (called when the run finishes). */
export function deregisterRun(runId: string): void {
  controllers.delete(runId);
}

/** Number of currently active run controllers (for testing / concurrency checks). */
export function activeRunCount(): number {
  return controllers.size;
}

/**
 * Abort every active run. Called by closeDb() to prevent background runs from
 * inserting into a replaced in-memory database (FK violations in test isolation).
 */
export function abortAllRuns(): void {
  for (const ctrl of controllers.values()) {
    try { ctrl.abort(); } catch { /* ignore */ }
  }
  controllers.clear();
}
