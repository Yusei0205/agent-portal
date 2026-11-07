/**
 * The Claude agents a run can use, and its lead agent.
 *
 * Agents come from the owner's (or team's) Claude config, materialised into the run's home (~/.claude/agents), then the
 * project's own .claude/agents/, which win on a name clash. An agent's `skills:` are preloaded from ~/.claude/skills and
 * the project's .claude/skills (see agent-defs.ts). Used by every Claude Code path: local SDK, AgentCore with an
 * Anthropic credential, and AgentCore on Bedrock.
 */

import path from 'node:path';
import { config } from '../config.ts';
import { one, type Row } from '../db.ts';
import { getRunHomeDir } from '../user-config.ts';
import { loadAgentDefinitions, type AgentDefinitionPayload } from './agent-defs.ts';
import type { AgentRun } from './types.ts';

function projectClaudeDir(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  try {
    const project = one<Row>('SELECT slug FROM projects WHERE id = ?', projectId);
    return project?.slug ? path.join(config.dataDir, 'projects', String(project.slug), '.claude') : null;
  } catch {
    return null; // no project folder: the owner's agents only
  }
}

/** The run's agents, by name. `mapModel` turns an agent's `model:` into one this path can run (undefined: the run's model). */
export function loadRunAgents(
  run: Pick<AgentRun, 'runId' | 'projectId'>,
  mapModel?: (model: string) => string | undefined,
): Record<string, AgentDefinitionPayload> {
  const home = getRunHomeDir(run.runId);
  const homeClaude = home ? path.join(home, '.claude') : null;
  const project = projectClaudeDir(run.projectId);
  const sub = (dir: string | null, name: string): string | null => (dir ? path.join(dir, name) : null);
  return loadAgentDefinitions(
    [sub(homeClaude, 'agents'), sub(project, 'agents')],
    mapModel,
    [sub(homeClaude, 'skills'), sub(project, 'skills')],
  );
}

/** The session's lead agent when it is one of the run's agents (the SDK's `agent` option), else null. */
export function leadAgentFor(run: Pick<AgentRun, 'leadAgent'>, agents: Record<string, AgentDefinitionPayload>): string | null {
  const name = run.leadAgent?.trim();
  return name && Object.prototype.hasOwnProperty.call(agents, name) ? name : null;
}

/** Model names the Agent SDK understands for an agent, for the Anthropic API (and subscription) paths. */
export function anthropicAgentModel(model: string): string | undefined {
  const m = model.trim();
  if (!m) return undefined;
  if (/^(inherit|haiku|sonnet|opus|fable)$/i.test(m)) return m.toLowerCase();
  return /^claude-[a-z0-9.-]+$/i.test(m) ? m : undefined;
}
