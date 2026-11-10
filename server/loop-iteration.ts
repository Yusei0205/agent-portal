/**
 * Loop iteration logic: what an agent reports at the end of an iteration, whether the loop is going nowhere, the prompt
 * for the next iteration, and the decision to go on or stop.
 *
 * Pure functions only (no database, no I/O) so they behave the same on the local server and in a Lambda, and can be
 * tested alone. Ported from the loop-engineering driver (refactor/core-model) and the harness PR 1.7 (progress fed
 * into each iteration, loose stagnation check, stop rules that take effect).
 */

/** What an iteration ends with: WORKFLOW_STATUS {"state":"continue|done|blocked","summary":"..."}. */
export interface WorkflowStatus {
  state: 'continue' | 'done' | 'blocked';
  summary: string;
  next: string;
  needs: string;
}

/** The status line an agent ends an iteration with. The last one in the text counts. */
export function parseStatus(text: string | null | undefined): WorkflowStatus | null {
  const all = [...String(text ?? '').matchAll(/WORKFLOW_STATUS\s*(\{[^\n]*\})/g)];
  const last = all[all.length - 1];
  if (!last) return null;
  try {
    const j = JSON.parse(last[1]) as Record<string, unknown>;
    const state = ['continue', 'done', 'blocked'].includes(String(j.state)) ? (String(j.state) as WorkflowStatus['state']) : null;
    if (!state) return null;
    return {
      state,
      summary: String(j.summary ?? '').slice(0, 2000),
      next: String(j.next ?? '').slice(0, 1000),
      needs: String(j.needs ?? '').slice(0, 1000),
    };
  } catch {
    return null;
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** True when two summaries say nearly the same: at least 85% of their words in common (Jaccard), or equal. */
export function sameReport(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const wa = new Set(x.split(' '));
  const wb = new Set(y.split(' '));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common) >= 0.85;
}

/**
 * True when the last iterations keep reporting the same thing, so another one is unlikely to help. "The same" allows
 * small rewording. The window is at least 2: a window of 1 would stop every session after its first iteration.
 */
export function stagnated(summaries: string[], window = 3): boolean {
  const size = Math.max(2, Math.round(window) || 3);
  const recent = summaries.slice(-size).filter((s) => norm(s));
  if (recent.length < size) return false;
  const last = recent[recent.length - 1];
  return recent.every((s) => sameReport(s, last));
}

// ── Stop rules ───────────────────────────────────────────────────────────────

/** The rules a loop declares for when to stop. Missing values take the defaults. */
export interface StopRules {
  maxConsecutiveFailures?: number;
  stagnationWindow?: number;
  requireVerification?: boolean;
  wallClockMinutes?: number;
}

/** The state of a loop after an iteration has ended. */
export interface LoopState {
  /** Iterations finished so far, this one included. */
  iteration: number;
  maxIterations: number;
  /** Failed runs in a row, this one included. */
  failures: number;
  /** Summaries of the finished iterations, oldest first. */
  summaries: string[];
  /** What the agent reported this time (null when it gave no status line). */
  status: WorkflowStatus | null;
  /** The run itself failed (crash, error), as opposed to ending normally. */
  runFailed: boolean;
  /** The result of the checks run after the iteration (null when there are none). */
  checkPassed: boolean | null;
  budgetLeftUsd?: number | null;
  /** Minutes since the loop started. */
  minutesElapsed?: number;
}

export type LoopDecision =
  | { action: 'continue'; reason: string }
  | { action: 'stop'; outcome: 'done' | 'paused' | 'blocked' | 'failed'; reason: string };

/**
 * Decide what happens after an iteration, in this order: a failed run counts toward the failure limit; the agent says
 * it is blocked; the agent says it is done (a failing check keeps the loop going unless the rules accept "done"
 * without passing checks); the loop has stopped making progress; the iteration, budget or time limit is reached.
 */
export function nextStep(state: LoopState, rules: StopRules = {}): LoopDecision {
  const maxFailures = Math.max(1, Number(rules.maxConsecutiveFailures ?? 2) || 2);
  if (state.runFailed) {
    if (state.failures >= maxFailures) {
      return { action: 'stop', outcome: 'failed', reason: `${state.failures} runs failed in a row, so the loop stopped.` };
    }
    return { action: 'continue', reason: 'The run failed; trying again.' };
  }

  if (state.status?.state === 'blocked') {
    return { action: 'stop', outcome: 'blocked', reason: state.status.needs || 'The agent is blocked and needs something from a person.' };
  }

  if (state.status?.state === 'done') {
    if (state.checkPassed === false && rules.requireVerification !== false) {
      return { action: 'continue', reason: 'The agent says it is done but the checks fail.' };
    }
    return { action: 'stop', outcome: 'done', reason: state.status.summary || 'The agent reports the work is done.' };
  }

  if (stagnated(state.summaries, Number(rules.stagnationWindow ?? 3))) {
    return { action: 'stop', outcome: 'paused', reason: 'The last iterations reported the same thing, so the loop stopped. Review it, then send an instruction to go on.' };
  }

  if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
    return { action: 'stop', outcome: 'paused', reason: `Reached ${state.maxIterations} iterations without finishing. Review it, then send an instruction to go on.` };
  }
  if (state.budgetLeftUsd != null && state.budgetLeftUsd <= 0) {
    return { action: 'stop', outcome: 'paused', reason: 'The budget is used up. Raise it, then send an instruction to go on.' };
  }
  const wall = Number(rules.wallClockMinutes ?? 0);
  if (wall > 0 && (state.minutesElapsed ?? 0) > wall) {
    return { action: 'stop', outcome: 'paused', reason: `Reached the ${wall}-minute time limit. Resume to go on.` };
  }
  return { action: 'continue', reason: 'More to do.' };
}

// ── Prompt for the next iteration ────────────────────────────────────────────

export interface IterationInput {
  title?: string;
  goal: string;
  rules?: string;
  /** What the earlier iterations did (the recent progress file, or the last summary). */
  progress?: string;
  /** Instructions people sent since the last iteration. */
  instructions?: string[];
  /** The last check result, when there was one. */
  check?: { ok: boolean; output: string } | null;
  iteration: number;
  maxIterations: number;
  budgetLeftUsd?: number | null;
  repos?: { name: string; branch?: string }[];
}

export const STATUS_INSTRUCTION =
  'End your reply with one line: WORKFLOW_STATUS {"state":"continue|done|blocked","summary":"what you did","next":"what is left","needs":"what you need from a person"}';

/** The prompt of one iteration: the goal, what happened before, and how to report back. */
export function composeIterationPrompt(i: IterationInput): string {
  const parts: string[] = [];
  parts.push(`# Goal\n${i.goal.trim()}`);
  if (i.title?.trim()) parts.unshift(`# Session: ${i.title.trim()}`);
  if (i.rules?.trim()) parts.push(`# Rules\n${i.rules.trim()}`);
  const budget = i.budgetLeftUsd != null ? `, about $${Math.max(0, i.budgetLeftUsd).toFixed(2)} budget left` : '';
  parts.push(`# This iteration\nIteration ${i.iteration} of at most ${i.maxIterations}${budget}.`);
  if (i.repos?.length) parts.push(`# Repositories\n${i.repos.map((r) => `- repos/${r.name}${r.branch ? ` (branch ${r.branch})` : ''}`).join('\n')}`);
  if (i.progress?.trim()) parts.push(`# Progress so far\n${i.progress.trim()}`);
  if (i.check) parts.push(`# Last check: ${i.check.ok ? 'passed' : 'FAILED'}\n${i.check.output.trim().slice(-2000)}`);
  if (i.instructions?.length) parts.push(`# New instructions from people\n${i.instructions.map((x) => `- ${x.trim()}`).join('\n')}`);
  parts.push(`# Reporting\n${STATUS_INSTRUCTION}\nUse "done" only when the goal is met, and "blocked" only when you cannot go on without a person.`);
  return parts.join('\n\n');
}

// ── Progress entries ─────────────────────────────────────────────────────────

/** One entry of a loop's progress record: what an iteration did. */
export interface ProgressEntry {
  iteration: number;
  summary: string;
  at: string;
}

/** Add an entry and keep only the newest `maxEntries`. */
export function addProgress(entries: ProgressEntry[], entry: ProgressEntry, maxEntries = 20): ProgressEntry[] {
  return [...entries.filter((e) => e.iteration !== entry.iteration), entry].slice(-Math.max(1, maxEntries));
}

/** The last few entries as text for the next iteration's prompt, at most `maxChars` (the newest are kept). */
export function recentProgressText(entries: ProgressEntry[], count = 3, maxChars = 6000): string {
  const lines = entries.slice(-count).map((e) => `- Iteration ${e.iteration}: ${e.summary.trim()}`);
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return text;
}
