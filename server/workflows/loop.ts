/**
 * Loop sessions: a session that goes on from one run to the next by itself until a stop rule says to stop.
 *
 * A loop session keeps its state (rules, failures in a row, summaries, progress) in `loop_state` on the workflow, as
 * JSON, so it survives between runs. That also suits Lambda, where each run is its own invocation: after a run ends,
 * `afterRun` decides, and for "continue" it starts the next run through the normal start path.
 *
 * The decisions themselves are in ../loop-iteration.ts (pure and tested).
 */

import { getSessionsRepository } from '../repositories/sessions.ts';
import type { WorkflowRecord } from '../repositories/sessions.ts';
import { emit } from '../events.ts';
import { now } from '../util.ts';
import {
  parseStatus, nextStep, composeIterationPrompt, addProgress, recentProgressText,
  type LoopDecision, type ProgressEntry, type StopRules,
} from '../loop-iteration.ts';

export interface LoopSessionState {
  enabled: true;
  rules: StopRules;
  /** Failed runs in a row. */
  failures: number;
  /** Summaries of the finished iterations, oldest first. */
  summaries: string[];
  progress: ProgressEntry[];
  /** When the loop started (ISO), for the time limit. */
  startedAt: string;
  /** Spend left in USD when the loop was started with one; null for none. */
  budgetUsd?: number | null;
  spentUsd?: number;
  /** Set to false in the spec to leave the progress record out of the next prompts. */
  progressFile?: boolean;
}

/** The state of a loop session, or null for an ordinary session. */
export function readLoopState(w: Pick<WorkflowRecord, 'loop_state'>): LoopSessionState | null {
  const raw = String(w.loop_state ?? '').trim();
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<LoopSessionState>;
    if (!j || j.enabled !== true) return null;
    return {
      enabled: true,
      rules: (j.rules && typeof j.rules === 'object' ? j.rules : {}) as StopRules,
      failures: Number(j.failures ?? 0) || 0,
      summaries: Array.isArray(j.summaries) ? j.summaries.map(String).slice(-20) : [],
      progress: Array.isArray(j.progress) ? j.progress.slice(-20) : [],
      startedAt: typeof j.startedAt === 'string' ? j.startedAt : now(),
      budgetUsd: j.budgetUsd ?? null,
      spentUsd: Number(j.spentUsd ?? 0) || 0,
      progressFile: j.progressFile !== false,
    };
  } catch {
    return null;
  }
}

/** Stop rules from a request: only the known keys, with sane limits. */
export function readStopRules(raw: unknown): StopRules {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: StopRules = {};
  const num = (v: unknown, min: number, max: number): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : undefined;
  };
  const f = num(o.maxConsecutiveFailures, 1, 20);
  if (f !== undefined) out.maxConsecutiveFailures = f;
  const w = num(o.stagnationWindow, 2, 20);
  if (w !== undefined) out.stagnationWindow = w;
  const m = num(o.wallClockMinutes, 1, 24 * 60);
  if (m !== undefined) out.wallClockMinutes = m;
  if (typeof o.requireVerification === 'boolean') out.requireVerification = o.requireVerification;
  return out;
}

/** The JSON stored on a new loop session. */
export function newLoopState(rules: unknown, opts: { progressFile?: boolean } = {}): string {
  const state: LoopSessionState = {
    enabled: true, rules: readStopRules(rules), failures: 0, summaries: [], progress: [], startedAt: now(),
    progressFile: opts.progressFile !== false,
  };
  return JSON.stringify(state);
}

/**
 * The prompt of the next iteration of a loop session: the goal, the recent progress, and what people sent since.
 * `instructions` are the unconsumed messages (already read by the runner).
 */
export function loopPrompt(w: WorkflowRecord, state: LoopSessionState, instructions: string[], repoNames: string[] = []): string {
  const progress = state.progressFile === false ? '' : recentProgressText(state.progress);
  return composeIterationPrompt({
    title: w.title,
    goal: w.goal,
    progress: progress || state.summaries[state.summaries.length - 1] || '',
    instructions,
    iteration: (w.iteration_count ?? 0) + 1,
    maxIterations: w.max_iterations ?? 0,
    repos: repoNames.map((name) => ({ name })),
  });
}

/** What happened to the iteration that just ended. */
export interface IterationOutcome {
  /** The agent's reply text (the status line is read from it). */
  result: string;
  /** The run ended in an error rather than normally. */
  failed: boolean;
  /** Whether the checks passed, when there were any. */
  checkPassed?: boolean | null;
}

/**
 * Called when a run of a loop session has ended and the session has been counted (iteration_count already includes
 * it). Records the iteration, decides, and either starts the next run or stops the session with the reason.
 * Returns the decision (null when the session is not a loop).
 */
export async function afterRun(workflowId: string, outcome: IterationOutcome): Promise<LoopDecision | null> {
  const repo = getSessionsRepository();
  const w = await repo.getWorkflowById(workflowId);
  if (!w) return null;
  const state = readLoopState(w);
  if (!state) return null;

  const status = outcome.failed ? null : parseStatus(outcome.result);
  const summary = (status?.summary || outcome.result.replace(/WORKFLOW_STATUS\s*\{[^\n]*\}/g, '').trim().slice(0, 600) || (outcome.failed ? 'The run failed.' : 'No summary.')).slice(0, 2000);
  // A failed run is not counted in iteration_count, but it is an attempt: number it as the next one.
  const iteration = Math.max(1, Number(w.iteration_count ?? 0) + (outcome.failed ? 1 : 0));

  state.failures = outcome.failed ? state.failures + 1 : 0;
  if (!outcome.failed) state.summaries = [...state.summaries, summary].slice(-20);
  state.progress = addProgress(state.progress, { iteration, summary, at: now() });

  const decision = nextStep({
    iteration,
    maxIterations: Number(w.max_iterations ?? 0),
    failures: state.failures,
    summaries: state.summaries,
    status,
    runFailed: outcome.failed,
    checkPassed: outcome.checkPassed ?? null,
    minutesElapsed: (Date.now() - Date.parse(state.startedAt)) / 60_000,
  }, state.rules);

  const ts = now();
  const patch: Partial<WorkflowRecord> = { loop_state: JSON.stringify(state), updated_at: ts };
  if (decision.action === 'stop') {
    patch.status = decision.outcome === 'done' ? 'done' : decision.outcome === 'failed' ? 'failed' : decision.outcome === 'blocked' ? 'blocked' : 'paused';
    patch.stop_reason = decision.outcome === 'done' ? '' : decision.reason.slice(0, 500);
    await repo.updateWorkflow(workflowId, patch);
    if (w.project_id) emit(w.project_id, { type: 'workflow.updated', workflowId, status: String(patch.status) });
    return decision;
  }

  // Continue: keep the session "running" and start the next run. If starting fails the session pauses with the reason.
  await repo.updateWorkflow(workflowId, patch);
  try {
    // Loaded here because the driver imports the runner, which imports this module.
    const { startRun } = await import('./driver.ts');
    await startRun(workflowId);
  } catch (e: unknown) {
    await repo.updateWorkflow(workflowId, {
      status: 'paused',
      stop_reason: `The loop could not start the next iteration: ${String((e as { message?: string })?.message ?? e).slice(0, 300)}`,
      updated_at: now(),
    });
    if (w.project_id) emit(w.project_id, { type: 'workflow.updated', workflowId, status: 'paused' });
  }
  return decision;
}
