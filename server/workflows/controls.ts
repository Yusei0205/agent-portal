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
 * The abort reason of runs stopped by abortAllRuns, so the runner can say why the run stopped: no person pressed
 * Stop, the portal process ended (a restart or, on Lambda, the end of the invocation the run lives in).
 */
const PORTAL_SHUTDOWN = new DOMException('The portal stopped while this run was going.', 'AbortError');

/** True when the run's signal was aborted by abortAllRuns (the portal shutting down), not by a person or a limit. */
export function abortedByShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === PORTAL_SHUTDOWN;
}

/**
 * Abort every active run. Called by closeDb(): on shutdown (SIGTERM: a restart, or the end of a Lambda invocation),
 * and in tests to prevent background runs from inserting into a replaced in-memory database.
 */
export function abortAllRuns(): void {
  for (const ctrl of controllers.values()) {
    try { ctrl.abort(PORTAL_SHUTDOWN); } catch { /* ignore */ }
  }
  controllers.clear();
}
