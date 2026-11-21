/**
 * The state of a running flow and the decisions that move it on. Pure: engine.ts keeps it in the session record and
 * starts the child sessions.
 */

import { renderPrompt, type FlowRecipe, type FlowStep } from './recipe.ts';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type FlowStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface StepState {
  status: StepStatus;
  /** Runs started so far (a step with `until` may run more than once). */
  runs: number;
  /** The child session of the current or last run. */
  childId: string | null;
  /** The answer of the last finished run. */
  result: string;
  /** Why the step failed. */
  error: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface FlowState {
  /** Changes with each start, so a page can tell one flow from the next. */
  id: string;
  name: string;
  description: string;
  input: string;
  status: FlowStatus;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  /** Shown with the end of the flow: why it failed or was stopped. */
  note: string;
  recipe: FlowRecipe;
  steps: Record<string, StepState>;
}

/** Longest answer of a step that is kept and passed on to later steps. */
export const MAX_STEP_RESULT = 8_000;

export function newFlowState(id: string, recipe: FlowRecipe, input: string, startedBy: string, at: string): FlowState {
  const steps: Record<string, StepState> = {};
  for (const s of recipe.steps) steps[s.id] = { status: 'pending', runs: 0, childId: null, result: '', error: '', startedAt: null, finishedAt: null };
  return { id, name: recipe.name, description: recipe.description, input, status: 'running', startedBy, startedAt: at, finishedAt: null, note: '', recipe, steps };
}

/** The steps that can start now: pending, with every step they wait for done. */
export function readySteps(state: FlowState): FlowStep[] {
  if (state.status !== 'running') return [];
  return state.recipe.steps.filter((s) => state.steps[s.id].status === 'pending' && s.needs.every((n) => state.steps[n].status === 'done'));
}

/** The prompt a step's session gets: the step's own text, filled in, with what the flow is and what to leave behind. */
export function stepPrompt(state: FlowState, step: FlowStep): string {
  const results: Record<string, string> = {};
  for (const [id, st] of Object.entries(state.steps)) results[id] = st.result;
  const own = state.steps[step.id];
  const parts = [
    `You are step "${step.id}" of the flow "${state.name}". Your last message is handed to the steps that follow, so make it a complete answer.`,
    renderPrompt(step.prompt, state.input, results),
  ];
  if (step.until && own.runs > 1) {
    parts.push(
      `This is run ${own.runs} of at most ${step.maxRuns}. The previous answer did not yet contain "${step.until}".`,
      `Previous answer:\n${own.result}`,
      `Improve on it, and end your answer with "${step.until}" when the work is done.`,
    );
  } else if (step.until) {
    parts.push(`End your answer with "${step.until}" when the work is done.`);
  }
  return parts.join('\n\n');
}

/** Records that a step's session has started. */
export function markStarted(state: FlowState, stepId: string, childId: string, at: string): void {
  const st = state.steps[stepId];
  st.status = 'running';
  st.runs += 1;
  st.childId = childId;
  st.error = '';
  st.startedAt = at;
  st.finishedAt = null;
}

/** Ends the flow when nothing is left to do: failed if a step failed, else done. */
function settle(state: FlowState, at: string): void {
  if (state.status !== 'running') return;
  const open = Object.values(state.steps).some((s) => s.status === 'pending' || s.status === 'running');
  if (open) return;
  state.status = Object.values(state.steps).some((s) => s.status === 'failed') ? 'failed' : 'done';
  state.finishedAt = at;
}

/** Marks every step that has not started as skipped. */
function skipPending(state: FlowState): void {
  for (const st of Object.values(state.steps)) if (st.status === 'pending') st.status = 'skipped';
}

/**
 * A step's session finished. Returns the ids of the steps still running that the caller should stop (a failure stops
 * the flow) — empty otherwise.
 */
export function applyStepResult(state: FlowState, stepId: string, ok: boolean, text: string, at: string): string[] {
  const step = state.recipe.steps.find((s) => s.id === stepId);
  const st = state.steps[stepId];
  if (!step || !st || st.status !== 'running' || state.status !== 'running') return [];
  st.finishedAt = at;
  const answer = String(text ?? '').trim().slice(0, MAX_STEP_RESULT);
  if (!ok) {
    st.status = 'failed';
    st.error = answer.slice(0, 500) || 'The session failed';
    state.note = `Step "${stepId}" failed: ${st.error}`;
    skipPending(state);
    const running = Object.entries(state.steps).filter(([, s]) => s.status === 'running').map(([id]) => id);
    state.status = running.length ? 'running' : 'failed';
    if (!running.length) state.finishedAt = at;
    return running;
  }
  st.result = answer;
  const met = !step.until || answer.toLowerCase().includes(step.until.toLowerCase());
  if (!met && st.runs < step.maxRuns) st.status = 'pending'; // goes again, with its last answer
  else st.status = 'done';
  settle(state, at);
  return [];
}

/** The person stopped the flow. Returns the steps whose sessions should be stopped. */
export function applyStop(state: FlowState, at: string): string[] {
  if (state.status !== 'running') return [];
  const running = Object.entries(state.steps).filter(([, s]) => s.status === 'running').map(([id]) => id);
  skipPending(state);
  for (const id of running) { state.steps[id].status = 'skipped'; state.steps[id].finishedAt = at; }
  state.status = 'stopped';
  state.finishedAt = at;
  state.note = 'Stopped';
  return running;
}

/** A few lines for the chat: how the flow ended. */
export function flowSummary(state: FlowState): string {
  const mark = (s: StepStatus): string => (s === 'done' ? '✓' : s === 'failed' ? '✗' : s === 'running' ? '…' : s === 'skipped' ? '–' : '·');
  const lines = state.recipe.steps.map((s) => {
    const st = state.steps[s.id];
    return `  ${mark(st.status)} ${s.id}${st.runs > 1 ? ` (${st.runs} runs)` : ''}${st.error ? `: ${st.error}` : ''}`;
  });
  const head = state.status === 'done' ? `Flow ${state.name} finished.`
    : state.status === 'failed' ? `Flow ${state.name} failed. ${state.note}`.trim()
    : state.status === 'stopped' ? `Flow ${state.name} was stopped.`
    : `Flow ${state.name} is running.`;
  return [head, ...lines].join('\n');
}

/** What the page and API show: the state without the full recipe prompts and answers (those stay in the sessions). */
export function publicFlow(state: FlowState): object {
  return {
    id: state.id, name: state.name, description: state.description, status: state.status, note: state.note,
    startedAt: state.startedAt, finishedAt: state.finishedAt, input: state.input,
    steps: state.recipe.steps.map((s) => ({
      id: s.id, needs: s.needs, agent: s.agent, until: s.until, maxRuns: s.maxRuns,
      status: state.steps[s.id].status, runs: state.steps[s.id].runs, childId: state.steps[s.id].childId,
      error: state.steps[s.id].error, startedAt: state.steps[s.id].startedAt, finishedAt: state.steps[s.id].finishedAt,
      resultPreview: state.steps[s.id].result.slice(0, 300),
    })),
  };
}
