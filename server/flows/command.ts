/**
 * The /flow command of a session's chat box:
 *
 *   /flow                     the recipes of this session and how to run them
 *   /flow run <name> [input]  run a recipe (also: /flow <name> [input])
 *   /flow status              where the running or last flow is
 *   /flow stop                stop the running flow
 *
 * A portal recipe is run by the portal (engine.ts). A Kiro-native recipe becomes a prompt for the Kiro agent, which
 * has its own workflow feature: it is given the recipe's text, so it works without the file on the runner's disk.
 */

import type { WorkflowRecord } from '../repositories/sessions.ts';
import { HttpError } from '../util.ts';
import { parseSlashCommand } from '../workflows/session-commands.ts';
import { findFlow, flowFolderHint, listFlowEntries, type FlowEntry } from './catalog.ts';
import { readFlowState, startFlow, stopFlow } from './engine.ts';
import { flowSummary } from './state.ts';

export type FlowCommandResult =
  | { type: 'answer'; text: string }
  | { type: 'prompt'; name: string; prompt: string };

const USAGE = '/flow [list | run <name> [input] | status | stop]';

function listText(entries: FlowEntry[], engine: string): string {
  if (!entries.length) {
    return [
      'No recipes yet.',
      `Add one in ${flowFolderHint(engine)} (YAML or JSON), then type /flow run <name>.`,
      'A recipe is a list of steps; each step is its own session with fresh context:',
      '  name: review-change',
      '  steps:',
      '    - id: build',
      '      prompt: "Implement: {{input}}"',
      '    - id: review',
      '      prompt: "Review this work: {{steps.build.result}}"',
    ].join('\n');
  }
  return [
    'Recipes:',
    ...entries.map((e) => {
      const what = e.error ? `  (cannot run: ${e.error})` : e.kind === 'native' ? '  (Kiro runs it)' : `  (${e.recipe!.steps.length} steps)`;
      return `  ${e.name}${e.description ? ` — ${e.description}` : ''}${what}`;
    }),
    '',
    'Run one with: /flow run <name> [input]',
  ].join('\n');
}

function nativePrompt(entry: FlowEntry, input: string): string {
  return [
    `Run the workflow "${entry.name}" with your workflow feature. Its recipe (${entry.file}):`,
    '```',
    String(entry.text ?? '').slice(0, 20_000),
    '```',
    input ? `Input for the workflow: ${input}` : '',
    'Plan it from the recipe, run its steps (each in its own session with fresh context, in parallel where the recipe allows), '
      + 'and report what each step did and the final result.',
  ].filter(Boolean).join('\n\n');
}

/** The result of a "/flow ..." message, or null when the message is not a /flow command. */
export async function resolveFlowCommand(w: WorkflowRecord, message: string, userId: string): Promise<FlowCommandResult | null> {
  const parsed = parseSlashCommand(message);
  if (!parsed || parsed.name !== 'flow') return null;
  const engine = String(w.engine);
  const answer = (text: string): FlowCommandResult => ({ type: 'answer', text });
  if (engine !== 'kiro' && engine !== 'claude-code' && engine !== 'codex' && engine !== 'cursor') return answer('Flows run in Kiro, Claude Code, Codex and Cursor sessions.');

  const words = parsed.args.split(/\s+/).filter(Boolean);
  const head = (words[0] ?? '').toLowerCase();

  if (!head || head === 'list') return answer(listText(await listFlowEntries(w), engine));

  if (head === 'status') {
    const state = readFlowState(w);
    return answer(state ? flowSummary(state) : 'No flow has run in this session.');
  }

  if (head === 'stop') {
    const state = await stopFlow(w.id);
    return answer(state ? 'Stopping the flow.' : 'No flow is running in this session.');
  }

  // "/flow run <name> [input]" or "/flow <name> [input]"
  const rest = head === 'run' ? words.slice(1) : words;
  const name = rest[0] ?? '';
  // The input keeps the person's own spacing and line breaks: it is everything after the name.
  const afterName = parsed.args.slice(parsed.args.indexOf(name, head === 'run' ? 3 : 0) + name.length).trim();
  if (!name) return answer(`Usage: ${USAGE}`);
  const entry = await findFlow(w, name);
  if (!entry) return answer(`No recipe named "${name}".\n\n${listText(await listFlowEntries(w), engine)}`);
  if (entry.error) return answer(`The recipe ${entry.file} cannot run: ${entry.error}`);
  if (entry.kind === 'native') return { type: 'prompt', name: entry.name, prompt: nativePrompt(entry, afterName) };

  try {
    const state = await startFlow(w, entry.recipe!, afterName, userId);
    const n = entry.recipe!.steps.length;
    return answer(state.status === 'running'
      ? `Flow ${entry.name} started: ${n} step${n === 1 ? '' : 's'}, each in its own session. Follow it in the Flow panel; /flow status and /flow stop work too.`
      : flowSummary(state));
  } catch (e) {
    if (e instanceof HttpError) return answer(e.message);
    throw e;
  }
}
