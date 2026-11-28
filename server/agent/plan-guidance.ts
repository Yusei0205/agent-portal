/**
 * Plan mode for a session: the agent reads and plans, and changes nothing until the person turns it off (/plan off).
 *
 * Like terse replies (caveman-guidance.ts) it is a per-session setting, so it needs no schema change and works for every
 * engine. Two layers: the agent is told to plan only (every engine), and where the portal decides each tool call itself
 * (Claude Code and Codex on this server) writes, shell commands that are not plain reads, and other tools are refused
 * (tool-policy.ts planModeDenial).
 */

import { getDb } from '../db.ts';
import { getSetting, setSetting } from '../settings.ts';

const key = (workflowId: string): string => `session.${workflowId}.plan`;

/** Is plan mode on for this session? */
export function planMode(workflowId: string | null | undefined): boolean {
  if (!workflowId) return false;
  try { return getSetting(getDb(), key(workflowId)) === '1'; } catch { return false; }
}

export async function setPlanMode(workflowId: string, on: boolean): Promise<void> {
  await setSetting(getDb(), key(workflowId), on ? '1' : '0');
}

export const PLAN_GUIDANCE = [
  'PLAN MODE is on for this session, set by the person you are working with.',
  'Do not edit or create files, do not run commands that change anything, and do not call tools that change state.',
  'Read and search as much as you need, then reply with a plan: the steps, the files you would change and why, the risks.',
  'End by asking whether to go ahead. Work only starts after the person turns plan mode off (/plan off).',
].join(' ');

/** The prompt with the plan-mode instructions added (every turn, so a resumed engine session cannot forget them). */
export function withPlanGuidance(prompt: string, on: boolean): string {
  return on ? `${prompt}\n\n${PLAN_GUIDANCE}` : prompt;
}
