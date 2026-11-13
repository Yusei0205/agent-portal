/**
 * build-graph mode: build one repository's code graph on its own (the Repositories page's "Build code graph") and save it for
 * sessions to download. No Kiro sign-in is involved. See shared/runner-graph-build.ts.
 */

import { parseRunnerRepos } from '../shared/runner-repos.js';
import { buildAndStoreGraph } from '../shared/runner-graph-build.js';
import type { KiroBuildGraphPayload } from './validate.js';

export type EmitFn = (event: Record<string, unknown>) => void;

/** graphify may run this long when the portal does not say (the portal sets it from where the job runs). */
const DEFAULT_MAX_MS = 20 * 60_000;

export async function runBuildGraph(payload: KiroBuildGraphPayload, emit: EmitFn): Promise<void> {
  const parsed = parseRunnerRepos(payload.repos);
  if (!parsed.ok || parsed.repos.length !== 1) {
    emit({ type: 'result', runId: payload.runId, success: false, error: parsed.ok ? 'Exactly one repository is needed' : parsed.error });
    return;
  }
  const r = await buildAndStoreGraph(parsed.repos[0], (ev) => emit(ev as unknown as Record<string, unknown>), {
    ...(payload.putUrl ? { putUrl: payload.putUrl } : {}),
    maxMs: payload.maxMs ?? DEFAULT_MAX_MS,
  });
  emit({ type: 'result', runId: payload.runId, ...r });
}
