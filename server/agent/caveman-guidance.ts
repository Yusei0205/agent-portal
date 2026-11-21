/**
 * Terse replies ("caveman" style) for a Claude session, chosen when the session is started.
 *
 * The portal bundles the caveman skill (server/bundled-skills.ts), but a Claude session loads no skills from disk, so the
 * skill alone changes nothing. When a session is started with the option on, the skill's instructions are added to its
 * first message (and a one-line reminder to later ones). The person can end it by saying "stop caveman" or "normal mode",
 * as the skill says. Nothing changes for a session that did not ask for it.
 */

import { getDb } from '../db.ts';
import { getSetting, setSetting } from '../settings.ts';
import { BUNDLED_SKILLS } from '../bundled-skills.ts';

const key = (workflowId: string): string => `session.${workflowId}.caveman`;

/** Is terse mode on for this session? */
export function cavemanMode(workflowId: string | null | undefined): boolean {
  if (!workflowId) return false;
  try { return getSetting(getDb(), key(workflowId)) === '1'; } catch { return false; }
}

export async function setCavemanMode(workflowId: string, on: boolean): Promise<void> {
  await setSetting(getDb(), key(workflowId), on ? '1' : '0');
}

/** The skill's instructions without its front matter. */
export function cavemanInstructions(): string {
  const skill = BUNDLED_SKILLS.find((s) => s.name === 'caveman')?.files['SKILL.md'] ?? '';
  return skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

export const CAVEMAN_REMINDER = 'Reply style: caveman (terse), as set at the start of this session, until the person says "stop caveman" or "normal mode". Code, commands, paths, numbers and error text stay exact.';

/** The prompt with the terse-reply instructions added: in full on a session's first turn, as a reminder after that. */
export function withCavemanGuidance(prompt: string, on: boolean, firstTurn: boolean): string {
  if (!on) return prompt;
  const text = firstTurn
    ? `Reply style for this whole session, chosen by the person who started it. Follow these instructions in every reply:\n\n${cavemanInstructions()}`
    : CAVEMAN_REMINDER;
  return `${prompt}\n\n${text}`;
}
