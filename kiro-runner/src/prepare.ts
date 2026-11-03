/**
 * prepare-repos mode: put the session's repositories into the session's persistent folder before the first
 * message, so the run itself only has to bring them up to date. No Kiro sign-in is involved.
 */

import { parseRunnerRepos, cloneRunnerRepos, usablePersistRoot, PERSIST_ROOT } from '../shared/runner-repos.js';
import type { KiroPreparePayload } from './validate.js';

export type EmitFn = (event: Record<string, unknown>) => void;

export async function runPrepareRepos(payload: KiroPreparePayload, emit: EmitFn): Promise<void> {
  const parsed = parseRunnerRepos(payload.repos);
  if (!parsed.ok) {
    emit({ type: 'result', runId: payload.runId, success: false, persisted: false, error: parsed.error });
    return;
  }
  const persist = usablePersistRoot(PERSIST_ROOT);
  if (!persist) {
    emit({ type: 'status', text: 'Persistent storage is not available; repositories will be cloned when a message is sent.' });
    emit({ type: 'result', runId: payload.runId, success: true, persisted: false, repos: [] });
    return;
  }
  const names = await cloneRunnerRepos(parsed.repos, persist, (ev) => emit(ev), { persistRoot: persist });
  emit({ type: 'result', runId: payload.runId, success: names.length === parsed.repos.length, persisted: true, repos: names });
}
