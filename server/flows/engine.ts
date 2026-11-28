/**
 * Runs a flow recipe: one child session per step, started when the steps it waits for are done.
 *
 * The state lives in the parent session's `flow_state` and moves on when a child session finishes
 * (delegation.ts calls onFlowChildFinished), so nothing waits in memory: it works on Lambda, where each run is its own
 * invocation, as well as on a local install. Child sessions are ordinary delegated sessions (delegation.ts): they
 * inherit the parent's project, workspace, engine and credential, count against the delegation limits, and show up in
 * the session's agents. A step the limits hold back stays pending and starts when another step ends.
 */

import { getSessionsRepository } from '../repositories/sessions.ts';
import type { WorkflowRecord } from '../repositories/sessions.ts';
import { createChildSession } from '../delegation.ts';
import { cancelRun } from '../workflows/controls.ts';
import { emit } from '../events.ts';
import { generateId, now, HttpError } from '../util.ts';
import { FLOW_LIMITS, type FlowRecipe } from './recipe.ts';
import {
  newFlowState, readySteps, stepPrompt, markStarted, applyStepResult, applyStop, flowSummary, publicFlow,
  type FlowState,
} from './state.ts';

/** One change at a time per session: two steps finishing together must not overwrite each other. */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

export function readFlowState(w: Pick<WorkflowRecord, 'flow_state'>): FlowState | null {
  const raw = String(w.flow_state ?? '').trim();
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as FlowState;
    return j && typeof j === 'object' && j.recipe && j.steps ? j : null;
  } catch { return null; }
}

async function save(parentId: string, state: FlowState): Promise<void> {
  await getSessionsRepository().updateWorkflow(parentId, { flow_state: JSON.stringify(state), updated_at: now() });
}

function notify(projectId: string | null, workflowId: string): void {
  if (projectId) emit(projectId, { type: 'workflow.flow-updated', workflowId });
}

async function note(parent: WorkflowRecord, command: string, text: string): Promise<void> {
  await getSessionsRepository().appendWorkflowEvent({
    workflow_id: parent.id,
    kind: 'command-result',
    body: `${command}\n---\n${text}`,
    data: JSON.stringify({ command, by: 'flow' }),
    created_at: now(),
  });
  if (parent.project_id) emit(parent.project_id, { type: 'workflow.command-result', workflowId: parent.id, command, result: text });
}

/** Starts the steps that are ready. A step the delegation limits hold back stays pending; any other error fails the flow. */
async function launch(parent: WorkflowRecord, state: FlowState): Promise<void> {
  for (const step of readySteps(state)) {
    try {
      const child = await createChildSession(parent.id, state.startedBy, stepPrompt(state, step), {
        title: `${state.name}: ${step.id}`.slice(0, 120),
        ...(step.agent ? { leadAgent: step.agent } : {}),
      });
      markStarted(state, step.id, child.id, now());
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) {
        // At the limit: if nothing is running, nothing will ever free a slot, so say so instead of waiting forever.
        const anyRunning = Object.values(state.steps).some((s) => s.status === 'running');
        if (!anyRunning) {
          state.status = 'failed';
          state.finishedAt = now();
          state.note = `Could not start "${step.id}": ${String(e.message).slice(0, 300)}`;
          for (const st of Object.values(state.steps)) if (st.status === 'pending') st.status = 'skipped';
        }
        return;
      }
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      state.steps[step.id].status = 'failed';
      state.steps[step.id].error = msg;
      state.note = `Could not start "${step.id}": ${msg}`;
      for (const st of Object.values(state.steps)) if (st.status === 'pending') st.status = 'skipped';
      if (!Object.values(state.steps).some((s) => s.status === 'running')) { state.status = 'failed'; state.finishedAt = now(); }
      return;
    }
  }
}

async function stopChildren(childIds: string[]): Promise<void> {
  const repo = getSessionsRepository();
  for (const id of childIds) {
    try {
      const run = await repo.getActiveRun(id);
      if (run) cancelRun(run.id);
      // Same as the session's own Stop (crud.ts): paused in the record, which is what reaches a run that is in another process.
      await repo.updateWorkflow(id, { status: 'paused', updated_at: now() });
    } catch { /* best effort */ }
  }
}

/** Starts a flow in a session. Throws an HttpError when one is already running or the input is too long. */
export async function startFlow(parent: WorkflowRecord, recipe: FlowRecipe, input: string, userId: string): Promise<FlowState> {
  if (input.length > FLOW_LIMITS.maxInputChars) throw new HttpError(400, `The input is longer than ${FLOW_LIMITS.maxInputChars} characters`);
  return withLock(parent.id, async () => {
    const fresh = await getSessionsRepository().getWorkflowById(parent.id);
    if (!fresh) throw new HttpError(404, 'Session not found');
    const existing = readFlowState(fresh);
    if (existing?.status === 'running') throw new HttpError(409, `The flow ${existing.name} is still running. Stop it with /flow stop first.`);
    const state = newFlowState(generateId(), recipe, input, userId, now());
    await launch(fresh, state);
    await save(fresh.id, state);
    notify(fresh.project_id, fresh.id);
    if (state.status !== 'running') await note(fresh, `/flow run ${recipe.name}`, flowSummary(state));
    return state;
  });
}

/** Stops the flow of a session and the sessions of its running steps. Returns null when there is no running flow. */
export async function stopFlow(parentId: string): Promise<FlowState | null> {
  const { state, children } = await withLock(parentId, async () => {
    const parent = await getSessionsRepository().getWorkflowById(parentId);
    const st = parent ? readFlowState(parent) : null;
    if (!parent || !st || st.status !== 'running') return { state: null, children: [] as string[] };
    const ids = applyStop(st, now());
    const childIds = ids.map((id) => st.steps[id].childId).filter((c): c is string => Boolean(c));
    await save(parentId, st);
    notify(parent.project_id, parentId);
    await note(parent, '/flow stop', flowSummary(st));
    return { state: st, children: childIds };
  });
  await stopChildren(children);
  return state;
}

/**
 * Called when a child session finishes (delegation.ts). Returns true when the child was a step of the parent's flow:
 * the caller then leaves the result to the flow instead of posting it to the parent's agent.
 */
export async function onFlowChildFinished(parentId: string, childId: string, status: string, result: string): Promise<boolean> {
  let toStop: string[] = [];
  const handled = await withLock(parentId, async () => {
    const parent = await getSessionsRepository().getWorkflowById(parentId);
    const state = parent ? readFlowState(parent) : null;
    if (!parent || !state) return false;
    const stepId = Object.keys(state.steps).find((id) => state.steps[id].childId === childId);
    if (!stepId) return false;
    // Only the run that is current counts: later chat in a finished step's session must not move the flow.
    if (state.steps[stepId].status !== 'running') return true;
    const ok = status !== 'failed' && status !== 'cancelled' && status !== 'error';
    const before = state.status;
    const running = applyStepResult(state, stepId, ok, result, now());
    toStop = running.map((id) => state.steps[id].childId).filter((c): c is string => Boolean(c));
    await launch(parent, state);
    await save(parentId, state);
    notify(parent.project_id, parentId);
    if (before === 'running' && state.status !== 'running') await note(parent, `/flow run ${state.name}`, flowSummary(state));
    return true;
  });
  if (toStop.length) await stopChildren(toStop);
  return handled;
}

/** The flow of a session as the page shows it, or null. */
export function flowForPage(w: Pick<WorkflowRecord, 'flow_state'>): object | null {
  const s = readFlowState(w);
  return s ? publicFlow(s) : null;
}
