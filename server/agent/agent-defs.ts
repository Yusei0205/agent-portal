/**
 * Claude subagent definitions for a run, read from agent files (.claude/agents/*.md).
 *
 * An agent file is Markdown with YAML front matter, as Claude Code writes them:
 *
 *   ---
 *   name: code-reviewer
 *   description: Reviews a diff for bugs. Use after making changes.
 *   tools: Read, Grep, Glob          (or a YAML list)
 *   model: sonnet                    (haiku | sonnet | opus | inherit | a model ID)
 *   ---
 *   You are a careful reviewer…      (the agent's system prompt)
 *
 * AgentCore runs get these as the Agent SDK's `agents` option, so Claude in the microVM can
 * hand work to the project's own agents with the Agent tool. Files are read where a run's
 * agents live: the owner's (or team's) Claude config, materialised into the run's home, then
 * the project's own .claude/agents/, which wins on a name clash (Claude Code's precedence).
 */

import fs from 'node:fs';
import path from 'node:path';

/** What the runner passes to the Agent SDK for one agent (a subset of AgentDefinition). */
export interface AgentDefinitionPayload {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
}

export const AGENT_LIMITS = {
  maxAgents: 50,
  maxNameLength: 64,
  maxDescription: 2_000,
  maxPrompt: 50_000,
  maxTools: 100,
  maxToolName: 200,
  maxFileBytes: 200_000,
} as const;

/** Names Claude Code accepts for an agent (it is also the Agent tool's subagent_type). */
export const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// ── Front matter ──────────────────────────────────────────────────────────────

type FrontValue = string | string[];

/** A small YAML subset: `key: value`, `key: [a, b]`, a `- item` list, and `>` / `|` block text. */
export function parseFrontMatter(yaml: string): Record<string, FrontValue> {
  const out: Record<string, FrontValue> = {};
  const lines = yaml.split(/\r?\n/);
  const unquote = (s: string): string => s.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    // Indented lines that follow belong to this key.
    const block: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
      block.push(lines[++i]);
    }
    while (block.length && block[block.length - 1].trim() === '') block.pop();
    if (/^[>|][+-]?$/.test(rest)) {
      const text = block.map((l) => l.trim());
      out[key] = rest.startsWith('>') ? text.join(' ').replace(/\s+/g, ' ').trim() : text.join('\n').trim();
    } else if (rest === '' && block.length && block.every((l) => /^\s*-\s+/.test(l) || l.trim() === '')) {
      out[key] = block.filter((l) => l.trim()).map((l) => unquote(l.replace(/^\s*-\s+/, '')));
    } else if (/^\[.*\]$/.test(rest)) {
      out[key] = rest.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      out[key] = unquote([rest, ...block.map((l) => l.trim())].filter(Boolean).join(' '));
    }
  }
  return out;
}

function asList(v: FrontValue | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const items = (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean);
  return items.length ? items.slice(0, AGENT_LIMITS.maxTools).filter((t) => t.length <= AGENT_LIMITS.maxToolName) : undefined;
}

// ── One file ──────────────────────────────────────────────────────────────────

/**
 * One agent from a file's text, or null when it is not a usable agent (no front matter,
 * no name or description, a name Claude Code would refuse, or an empty prompt).
 * `fallbackName` is the file name without .md, used when the front matter has no name.
 * `mapModel` turns the file's model into one the run can use (undefined: the main model).
 */
export function parseAgentFile(
  text: string,
  fallbackName: string,
  mapModel: (model: string) => string | undefined = (m) => m,
): { name: string; def: AgentDefinitionPayload } | null {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!fm) return null;
  const meta = parseFrontMatter(fm[1]);
  const str = (k: string): string => (typeof meta[k] === 'string' ? (meta[k] as string).trim() : '');
  const name = str('name') || fallbackName;
  const description = str('description');
  const prompt = fm[2].trim();
  if (!AGENT_NAME.test(name) || !description || !prompt) return null;

  const def: AgentDefinitionPayload = {
    description: description.slice(0, AGENT_LIMITS.maxDescription),
    prompt: prompt.slice(0, AGENT_LIMITS.maxPrompt),
  };
  const tools = asList(meta.tools);
  if (tools) def.tools = tools;
  const disallowed = asList(meta.disallowedTools ?? meta['disallowed-tools']);
  if (disallowed) def.disallowedTools = disallowed;
  const model = str('model');
  if (model) {
    const mapped = mapModel(model);
    if (mapped) def.model = mapped;
  }
  const turns = Number(str('maxTurns') || str('max-turns'));
  if (Number.isInteger(turns) && turns >= 1 && turns <= 200) def.maxTurns = turns;
  return { name, def };
}

// ── A run's agents ────────────────────────────────────────────────────────────

/**
 * Agents from the given folders, later folders winning on a name clash. Missing folders are
 * skipped; unreadable, oversized or invalid files are skipped. At most AGENT_LIMITS.maxAgents.
 */
export function loadAgentDefinitions(
  dirs: ReadonlyArray<string | null | undefined>,
  mapModel?: (model: string) => string | undefined,
): Record<string, AgentDefinitionPayload> {
  const found = new Map<string, AgentDefinitionPayload>();
  for (const dir of dirs) {
    if (!dir) continue;
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
    } catch {
      continue;
    }
    for (const file of names) {
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > AGENT_LIMITS.maxFileBytes) continue;
        const agent = parseAgentFile(fs.readFileSync(full, 'utf8'), file.slice(0, -3), mapModel);
        if (!agent) continue;
        found.delete(agent.name); // a later folder's agent replaces it (and moves to the end)
        found.set(agent.name, agent.def);
      } catch {
        /* skip unreadable files */
      }
    }
  }
  return Object.fromEntries([...found].slice(-AGENT_LIMITS.maxAgents));
}
