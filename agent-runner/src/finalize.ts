/**
 * The Claude runner's side of the "open a pull request" feature. The engine-neutral logic (reportRepoChanges,
 * runFinalize, validateFinalizeRequest) is shared with the Kiro runner in shared/runner-finalize-run.ts (from
 * server/agent/runner-finalize-run.ts); only where the work folder is stays here.
 */

import path from 'node:path';
import { runFinalize as runFinalizeIn } from '../shared/runner-finalize-run.js';
import type { FinalizeRequest } from '../shared/runner-finalize-run.js';
import { usablePersistRoot, PERSIST_ROOT } from '../shared/runner-repos.js';

export { reportRepoChanges, validateFinalizeRequest, WORKSPACE_GONE } from '../shared/runner-finalize-run.js';
export type { FinalizeRequest } from '../shared/runner-finalize-run.js';

/** The session's work folder, named the same way run.ts names it. */
export function workDirFor(sessionId: string | undefined, runId: string): string {
  const sessionKey = (sessionId ?? `run-${runId}`).replace(/[^A-Za-z0-9._-]/g, '_');
  const workRoot = process.env.AGENT_RUNNER_WORK_ROOT || path.join('/tmp', 'agent-sessions');
  return path.join(workRoot, sessionKey, 'work');
}

/** Contract C: push one new branch (see runFinalize in the shared module). */
export function runFinalize(req: FinalizeRequest, sessionId: string | undefined, emit: (event: Record<string, unknown>) => void): Promise<void> {
  return runFinalizeIn(req, { workDir: workDirFor(sessionId, `finalize-${req.repo}`), persist: usablePersistRoot(PERSIST_ROOT) }, emit);
}
