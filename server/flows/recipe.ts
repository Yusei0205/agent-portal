/**
 * Flow recipes: a declarative plan that coordinates several agent sessions on work too big for one.
 *
 * A recipe is a JSON or YAML file in the "workflows" folder of Agent setup (kiro/workflows/<name>.yaml,
 * claude/workflows/<name>.json). The portal runs it itself, on any engine (see engine.ts): each step is its own
 * session with fresh context, so a reviewer does not inherit the builder's reasoning.
 *
 *   name: feature-pipeline
 *   description: Design, build and review a change
 *   steps:
 *     - id: design
 *       prompt: "Design this change: {{input}}"
 *     - id: build                       # runs after "design" (the step before it, when `needs` is left out)
 *       prompt: "Implement this design:\n{{steps.design.result}}"
 *     - id: tests
 *       needs: [design]                 # same `needs` as "build": the two run side by side
 *       prompt: "Write tests for:\n{{steps.design.result}}"
 *     - id: review
 *       needs: [build, tests]
 *       prompt: "Review the work. End with APPROVED or CHANGES NEEDED."
 *       until: APPROVED                 # run again (with the last answer) until the answer has this text ...
 *       maxRuns: 3                      # ... or this many runs have been made
 *
 * A recipe written for Kiro's own workflow feature (a different schema, no `steps` with prompts) is not a flow here:
 * it stays a Kiro-native recipe, which the Kiro agent runs itself (see catalog.ts).
 *
 * Pure: no database, no files.
 */

import { parse as parseYaml } from 'yaml';

export const FLOW_LIMITS = { maxSteps: 20, maxPromptChars: 20_000, maxRuns: 10, maxInputChars: 10_000, maxFileChars: 200_000 } as const;

export interface FlowStep {
  id: string;
  prompt: string;
  /** Custom agent for this step's session; the session's own lead agent when empty. */
  agent: string;
  /** Steps that must be done first. Steps with the same `needs` run in parallel. */
  needs: string[];
  /** Run the step again until its answer contains this text (case-insensitive); '' = run once. */
  until: string;
  /** Most runs of the step when `until` is set (default 3). */
  maxRuns: number;
}

export interface FlowRecipe {
  name: string;
  description: string;
  steps: FlowStep[];
}

const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const FLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** True when the parsed file has the portal's schema: `steps` as a list of objects that each have a `prompt`. */
export function looksLikeFlow(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const steps = (doc as { steps?: unknown }).steps;
  return Array.isArray(steps) && steps.length > 0 && steps.every((s) => s && typeof s === 'object' && typeof (s as { prompt?: unknown }).prompt === 'string');
}

/** The text of a recipe file as an object. Throws a short message for text that is neither JSON nor YAML. */
export function parseRecipeText(text: string, fileName: string): unknown {
  if (text.length > FLOW_LIMITS.maxFileChars) throw new Error('The recipe file is too large');
  const clean = text.replace(/^﻿/, '');
  try {
    return /\.json$/i.test(fileName) ? JSON.parse(clean) : parseYaml(clean, { maxAliasCount: 20 });
  } catch (e) {
    throw new Error(`Not valid ${/\.json$/i.test(fileName) ? 'JSON' : 'YAML'}: ${String((e as Error).message ?? e).split('\n')[0].slice(0, 160)}`);
  }
}

/** Template references `{{input}}` and `{{steps.<id>.result}}` in a prompt. */
const REF = /\{\{\s*(input|steps\.([A-Za-z][A-Za-z0-9_-]{0,39})\.result)\s*\}\}/g;

export function referencedSteps(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(REF)) if (m[2]) out.push(m[2]);
  return out;
}

/** Everything a step depends on, directly or not. */
export function ancestors(steps: FlowStep[], id: string): Set<string> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const walk = (sid: string): void => {
    for (const n of byId.get(sid)?.needs ?? []) if (!seen.has(n)) { seen.add(n); walk(n); }
  };
  walk(id);
  return seen;
}

/**
 * Checks a parsed recipe and returns it in full form (defaults filled in). Throws an Error whose message says what is
 * wrong, in terms a person writing the file can act on.
 */
export function validateRecipe(doc: unknown, fallbackName: string): FlowRecipe {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('The recipe must be an object with a "steps" list');
  const d = doc as Record<string, unknown>;
  const name = String(d.name ?? fallbackName ?? '').trim();
  if (!FLOW_NAME.test(name)) throw new Error('The recipe needs a name of letters, digits, ".", "_" and "-"');
  if (!Array.isArray(d.steps) || d.steps.length === 0) throw new Error('The recipe needs a "steps" list');
  if (d.steps.length > FLOW_LIMITS.maxSteps) throw new Error(`A recipe has at most ${FLOW_LIMITS.maxSteps} steps`);

  const steps: FlowStep[] = [];
  d.steps.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Step ${i + 1} must be an object`);
    const s = raw as Record<string, unknown>;
    const id = String(s.id ?? `step${i + 1}`).trim();
    if (!STEP_ID.test(id)) throw new Error(`Step ${i + 1}: the id "${id}" must start with a letter and use letters, digits, "_" and "-"`);
    if (steps.some((x) => x.id === id)) throw new Error(`Two steps have the id "${id}"`);
    const prompt = typeof s.prompt === 'string' ? s.prompt.trim() : '';
    if (!prompt) throw new Error(`Step "${id}" needs a prompt`);
    if (prompt.length > FLOW_LIMITS.maxPromptChars) throw new Error(`Step "${id}": the prompt is longer than ${FLOW_LIMITS.maxPromptChars} characters`);
    let needs: string[];
    if (s.needs === undefined || s.needs === null) needs = i === 0 ? [] : [steps[i - 1].id];
    else if (Array.isArray(s.needs)) needs = s.needs.map((n) => String(n).trim());
    else if (typeof s.needs === 'string') needs = s.needs.trim() ? [s.needs.trim()] : [];
    else throw new Error(`Step "${id}": "needs" must be a list of step ids`);
    const until = typeof s.until === 'string' ? s.until.trim() : '';
    const maxRunsRaw = s.maxRuns === undefined ? 3 : Number(s.maxRuns);
    if (!Number.isInteger(maxRunsRaw) || maxRunsRaw < 1 || maxRunsRaw > FLOW_LIMITS.maxRuns) {
      throw new Error(`Step "${id}": "maxRuns" must be a whole number from 1 to ${FLOW_LIMITS.maxRuns}`);
    }
    steps.push({ id, prompt, agent: typeof s.agent === 'string' ? s.agent.trim().slice(0, 100) : '', needs, until, maxRuns: until ? maxRunsRaw : 1 });
  });

  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    for (const n of s.needs) {
      if (n === s.id) throw new Error(`Step "${s.id}" cannot wait for itself`);
      if (!ids.has(n)) throw new Error(`Step "${s.id}" waits for "${n}", which is not a step`);
    }
  }
  // A step that waits (directly or not) for itself would never start.
  for (const s of steps) if (ancestors(steps, s.id).has(s.id)) throw new Error(`Step "${s.id}" is part of a cycle`);
  // A prompt may use the answer of a step that is certain to be done by then, and no other.
  for (const s of steps) {
    const before = ancestors(steps, s.id);
    for (const ref of referencedSteps(s.prompt)) {
      if (!ids.has(ref)) throw new Error(`Step "${s.id}" uses {{steps.${ref}.result}}, but there is no step "${ref}"`);
      if (!before.has(ref)) throw new Error(`Step "${s.id}" uses the answer of "${ref}", so it must wait for it (add "${ref}" to its "needs")`);
    }
  }
  return { name, description: typeof d.description === 'string' ? d.description.trim().slice(0, 300) : '', steps };
}

/** The prompt of a step with `{{input}}` and `{{steps.<id>.result}}` filled in. An unknown result is left empty. */
export function renderPrompt(prompt: string, input: string, results: Record<string, string>): string {
  return prompt.replace(REF, (_m, whole: string, id?: string) => (id ? (results[id] ?? '') : input));
}
