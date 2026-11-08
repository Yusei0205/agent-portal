/**
 * The "/" commands of a session's chat box, beyond the ones the portal answers itself (slash-commands.ts):
 *   - /init and /review, prompts the portal writes for every engine;
 *   - the session owner's own commands and skills from Agent setup, the same files their runs get:
 *       Claude Code  commands/<name>.md (commands/a/b.md is /a:b) and skills/<name>/SKILL.md
 *       Kiro         prompts/<name>.md and skills/<name>/SKILL.md
 *       Codex        skills/<name>/SKILL.md
 *
 * The portal turns such a command into the text the agent gets, so it works on every engine and in every run:
 * a cloud run starts each turn with a recap of earlier turns, so a "/name" never reached the engine as a command,
 * and runs load no commands from disk. The chat keeps what the person typed; the event's data holds the prompt.
 */

import { parseFrontMatter, SKILL_NAME } from '../agent/agent-defs.ts';
import { readOwnerConfigFiles } from '../user-config.ts';
import type { WorkflowRecord } from '../repositories/sessions.ts';
import { PORTAL_COMMANDS } from './slash-commands.ts';

export type CommandSource = 'portal' | 'prompt' | 'command' | 'skill';

/** One entry of the chat box's command menu. */
export interface SessionCommand {
  name: string;
  usage: string;
  description: string;
  source: CommandSource;
}

interface OwnCommand extends SessionCommand { body: string }

/** The longest prompt a command may become (a skill's whole SKILL.md goes with it). */
export const MAX_COMMAND_PROMPT = 50_000;

/** A command name as typed after "/": letters, digits, ".", "_" and "-", with ":" between folder levels. */
const COMMAND_NAME = /^[A-Za-z0-9][\w.-]{0,63}(?::[A-Za-z0-9][\w.-]{0,63}){0,3}$/;

/**
 * "/name the rest" as { name, args }, or null when the text is not a command. A message that starts with a path
 * ("/src/app.ts fails") is not one: it goes to the agent as an ordinary message.
 */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !COMMAND_NAME.test(m[1])) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() };
}

function guideFile(engine: string): string {
  return engine === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
}

/** Prompts the portal provides in every engine session, under the names people know from Claude Code. */
const PROMPTS: Array<SessionCommand & { prompt: (args: string, engine: string) => string }> = [
  {
    name: 'init',
    usage: '/init [notes]',
    description: 'Write a guide for coding agents (CLAUDE.md or AGENTS.md) for the repositories',
    source: 'prompt',
    prompt: (args, engine) => [
      `Read this session's repositories and write a short guide for coding agents working in them: ${guideFile(engine)} `
        + 'at the root of each repository (update it if one is there already). Cover how to install, build, test and '
        + 'run the project, how the code is organised, and the conventions a contributor must follow. Keep it short and '
        + 'specific to this code, and only name commands you have seen in the repository.',
      args ? `Also: ${args}` : '',
    ].filter(Boolean).join('\n\n'),
  },
  {
    name: 'review',
    usage: '/review [focus]',
    description: 'Review the changes in the repositories for bugs, without changing files',
    source: 'prompt',
    prompt: (args) => [
      "Review the changes in this session's repositories: uncommitted changes, and the commits on the current branch "
        + 'since it left its base branch. Look for bugs, security problems, missing error handling and missing tests. '
        + 'For each finding give the file and line, what goes wrong and a suggested fix, most serious first. '
        + 'Do not change any files.',
      args ? `Focus on: ${args}` : '',
    ].filter(Boolean).join('\n\n'),
  },
];

/** Front matter and body of a Markdown file; a file without front matter is all body. */
function splitFrontMatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  return fm ? { meta: parseFrontMatter(fm[1]), body: fm[2] } : { meta: {}, body: text.replace(/^﻿/, '') };
}

function metaText(meta: Record<string, string | string[]>, key: string): string {
  const v = meta[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** The front matter's description, else the body's first line. */
function describe(meta: Record<string, string | string[]>, body: string): string {
  const first = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return (metaText(meta, 'description') || first).slice(0, 200);
}

/** Where each engine keeps its commands and skills in Agent setup. */
const SETUP: Record<string, { folder: 'claude' | 'kiro' | 'codex'; commandsDir: string | null }> = {
  'claude-code': { folder: 'claude', commandsDir: 'commands' },
  kiro: { folder: 'kiro', commandsDir: 'prompts' },
  codex: { folder: 'codex', commandsDir: null },
};

/** Where a person adds their own commands, for the help text. */
export function setupHint(engine: string): string {
  if (engine === 'claude-code') return 'Agent setup › Claude: commands/<name>.md or skills/<name>/SKILL.md';
  if (engine === 'kiro') return 'Agent setup › Kiro: prompts/<name>.md or skills/<name>/SKILL.md';
  if (engine === 'codex') return 'Agent setup › Codex: skills/<name>/SKILL.md';
  return 'Agent setup';
}

/** The session owner's commands and skills for the session's engine (commands first; the first of a name wins). */
async function ownCommands(w: WorkflowRecord): Promise<OwnCommand[]> {
  const setup = SETUP[String(w.engine)];
  const owner = w.created_by ? String(w.created_by) : '';
  if (!setup || !owner) return [];
  const commandFile = setup.commandsDir ? new RegExp(`^${setup.commandsDir}/(.+)\\.md$`, 'i') : null;
  const skillFile = /^skills\/([^/]+)\/SKILL\.md$/;
  const files = await readOwnerConfigFiles(
    owner,
    setup.folder,
    [...(setup.commandsDir ? [setup.commandsDir] : []), 'skills'],
    (rel) => Boolean(commandFile?.test(rel)) || skillFile.test(rel),
  ).catch(() => []);

  const out: OwnCommand[] = [];
  for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
    const { meta, body } = splitFrontMatter(f.content);
    if (!body.trim()) continue;
    const cmd = commandFile?.exec(f.path);
    if (cmd) {
      const name = cmd[1].split('/').join(':');
      if (!COMMAND_NAME.test(name)) continue;
      const hint = metaText(meta, 'argument-hint');
      out.push({ name: name.toLowerCase(), usage: `/${name}${hint ? ` ${hint}` : ''}`, description: describe(meta, body), source: 'command', body });
      continue;
    }
    const skill = skillFile.exec(f.path);
    const name = [metaText(meta, 'name'), skill?.[1] ?? ''].map((n) => n.toLowerCase()).find((n) => SKILL_NAME.test(n));
    if (!name) continue;
    out.push({ name, usage: `/${name} [request]`, description: describe(meta, body), source: 'skill', body });
  }
  // Commands before skills, so a command wins over a skill of the same name.
  out.sort((a, b) => (a.source === b.source ? 0 : a.source === 'command' ? -1 : 1));
  return out;
}

/** Every command of this session: the portal's, its prompts, then the owner's own (a name is taken once). */
async function allCommands(w: WorkflowRecord): Promise<Array<SessionCommand | OwnCommand>> {
  const list: Array<SessionCommand | OwnCommand> = PORTAL_COMMANDS.map((c) => ({ ...c, source: 'portal' as const }));
  if (w.engine === 'demo') return list;
  list.push(...PROMPTS.map(({ name, usage, description, source }) => ({ name, usage, description, source })));
  const taken = new Set(list.map((c) => c.name));
  for (const c of await ownCommands(w)) {
    if (taken.has(c.name)) continue;
    taken.add(c.name);
    list.push(c);
  }
  return list;
}

/** The chat box's menu for this session. */
export async function sessionCommands(w: WorkflowRecord): Promise<SessionCommand[]> {
  return (await allCommands(w)).map(({ name, usage, description, source }) => ({ name, usage, description, source }));
}

/** `$ARGUMENTS` and `$1`…`$9` filled in as Claude Code does; with no placeholder, the arguments follow the text. */
export function fillArguments(body: string, args: string): string {
  const positional = args.split(/\s+/).filter(Boolean);
  let used = false;
  let out = body.replace(/\$ARGUMENTS\b/g, () => { used = true; return args; });
  out = out.replace(/\$([1-9])(?!\d)/g, (_m, n: string) => { used = true; return positional[Number(n) - 1] ?? ''; });
  out = out.trim();
  if (!used && args) out = `${out}\n\nARGUMENTS: ${args}`;
  return out;
}

function skillPrompt(name: string, body: string, args: string): string {
  return [
    `Use the "${name}" skill for this request. Its instructions:`,
    `<skill name="${name}">\n${body.trim()}\n</skill>`,
    args ? `Request: ${args}` : '',
  ].filter(Boolean).join('\n\n');
}

export type ResolvedCommand =
  | { type: 'prompt'; name: string; source: CommandSource; prompt: string }
  | { type: 'unknown'; name: string };

/**
 * What a "/name" message becomes: the prompt for the agent, or unknown. Null when the message is not a command or
 * is one the portal answers itself (the caller handles those first).
 */
export async function resolveSessionCommand(w: WorkflowRecord, message: string): Promise<ResolvedCommand | null> {
  const parsed = parseSlashCommand(message);
  if (!parsed || PORTAL_COMMANDS.some((c) => c.name === parsed.name)) return null;
  const engine = String(w.engine);
  const builtIn = PROMPTS.find((p) => p.name === parsed.name);
  if (builtIn) return { type: 'prompt', name: parsed.name, source: 'prompt', prompt: builtIn.prompt(parsed.args, engine) };
  const own = (await ownCommands(w)).find((c) => c.name === parsed.name);
  if (!own) return { type: 'unknown', name: parsed.name };
  const prompt = own.source === 'skill' ? skillPrompt(own.name, own.body, parsed.args) : fillArguments(own.body, parsed.args);
  return { type: 'prompt', name: own.name, source: own.source, prompt: prompt.slice(0, MAX_COMMAND_PROMPT) };
}

/** The answer to a "/name" that is not a command in this session. */
export function unknownCommandText(name: string, engine: string): string {
  return [
    `/${name} is not a command in this session, so nothing was sent to the agent.`,
    'Type /help to see the commands you can use.',
    `To add your own: ${setupHint(engine)}.`,
  ].join('\n');
}

/**
 * The text a run gives the agent when no chat message is waiting: the session's goal, or, for a goal that is a
 * command ("/review security", started from the New session form or the API), the prompt it stands for.
 */
export async function goalPrompt(w: WorkflowRecord): Promise<string> {
  const goal = String(w.goal ?? '');
  if (w.engine === 'demo' || !parseSlashCommand(goal)) return goal;
  const resolved = await resolveSessionCommand(w, goal).catch(() => null);
  return resolved?.type === 'prompt' ? resolved.prompt : goal;
}

/** The text a run gives the agent for a saved chat message: a command's prompt, else what was typed. */
export function eventPrompt(ev: { body: string; data?: string | null }): string {
  if (ev.data) {
    try {
      const d = JSON.parse(ev.data) as { prompt?: unknown };
      if (typeof d.prompt === 'string' && d.prompt.trim()) return d.prompt;
    } catch { /* not JSON: the body */ }
  }
  return ev.body;
}
