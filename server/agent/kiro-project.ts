/**
 * A project's own Kiro agents: <project>/.kiro/agents/<name>.json, with prompt files next to them and the skills and
 * steering they load under .kiro/skills and .kiro/steering. Disabled agents are moved to .kiro/agents-disabled so Kiro
 * itself does not load them either.
 *
 * The portal's per-run profiles (agent-portal-<id>*.json) live in the same folder and are never listed here.
 *
 * This module only reads files, so the Kiro engine can use it without the HTTP layer.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The portal's generated per-run profiles. */
export const GENERATED_RE = /^agent-portal-/;

/** A project Kiro agent. */
export interface KiroAgentFile {
  name: string;
  description: string;
  enabled: boolean;
  /** The prompt text: inline, or read from a prompt file inside .kiro. */
  prompt: string;
  /** The prompt file (project-relative) when the prompt is a file:// reference, otherwise null. */
  promptFile: string | null;
  tools: string[];
  allowedTools: string[];
  toolsSettings: Record<string, unknown>;
  hooks: Record<string, unknown>;
  resources: string[];
  model: string;
  /** Names from toolsSettings.subagent.availableAgents. */
  team: string[];
  /** The whole definition as stored. */
  json: Record<string, unknown>;
}

export const kiroAgentsDir = (base: string, enabled = true) => path.join(base, '.kiro', enabled ? 'agents' : 'agents-disabled');

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** True when `target` is `dir` or inside it. */
export function isInside(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The file a prompt reference points to, when it is a relative file:// path that stays inside the project's .kiro
 * folder. Home (~) and absolute paths are never followed: a prompt must not read files from the server's home folder.
 */
export function promptFileOf(promptRef: string, agentFile: string, base: string): string | null {
  if (!promptRef.startsWith('file://')) return null;
  const ref = promptRef.slice('file://'.length);
  if (!ref || ref.startsWith('~') || path.isAbsolute(ref) || /^[A-Za-z]:/.test(ref)) return null;
  const file = path.resolve(path.dirname(agentFile), ref);
  return isInside(path.join(base, '.kiro'), file) ? file : null;
}

/** Parse one agent file. */
export function readKiroAgentFile(file: string, base: string, enabled = true): KiroAgentFile | null {
  let json: Record<string, unknown>;
  try {
    json = obj(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  const name = path.basename(file, '.json');
  if (GENERATED_RE.test(name)) return null;
  const promptRef = typeof json.prompt === 'string' ? json.prompt : '';
  const promptPath = promptFileOf(promptRef, file, base);
  let prompt = promptRef;
  if (promptPath) {
    try {
      prompt = fs.readFileSync(promptPath, 'utf8');
    } catch {
      prompt = '';
    }
  } else if (promptRef.startsWith('file://')) prompt = '';
  const toolsSettings = obj(json.toolsSettings);
  return {
    name,
    description: typeof json.description === 'string' ? json.description : '',
    enabled,
    prompt,
    promptFile: promptPath ? path.relative(base, promptPath).split(path.sep).join('/') : null,
    tools: strings(json.tools),
    allowedTools: strings(json.allowedTools),
    toolsSettings,
    hooks: obj(json.hooks),
    resources: strings(json.resources),
    model: typeof json.model === 'string' ? json.model : '',
    team: strings(obj(toolsSettings.subagent).availableAgents),
    json,
  };
}

/** The project's Kiro agents, enabled first; generated per-run profiles are left out. */
export function listKiroAgentsAt(base: string, { includeDisabled = true } = {}): KiroAgentFile[] {
  const out: KiroAgentFile[] = [];
  for (const enabled of includeDisabled ? [true, false] : [true]) {
    const dir = kiroAgentsDir(base, enabled);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !GENERATED_RE.test(x)).sort()) {
      const a = readKiroAgentFile(path.join(dir, f), base, enabled);
      if (a) out.push(a);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Per-run safety                                                      */
/* ------------------------------------------------------------------ */

/** Tools that only read: the only ones a run profile may pre-approve. */
const READ_ONLY = new Set(['read', 'grep', 'glob', 'fs_read', '@builtin/read', '@builtin/grep', '@builtin/glob', '@builtin/fs_read']);
/** Built-in tools a profile may use; "*" and "@builtin" are replaced by these so subagent is never included by accident. */
const BUILTIN = ['read', 'write', 'shell', 'grep', 'glob', 'web_fetch', 'web_search', 'knowledge'];
/** Definition keys the portal sets itself (or drops) in a run profile. */
const PORTAL_KEYS = new Set(['name', 'description', 'prompt', 'tools', 'allowedTools', 'toolsSettings', 'permissions', 'mcpServers', 'includeMcpJson', 'useLegacyMcpJson', 'resources', 'hooks', 'model', 'toolAliases']);

/**
 * toolsSettings without anything that runs a tool without asking: shell.allowedCommands, write.allowedPaths,
 * autoAllowReadonly, trustedAgents and the like. Read settings stay. The subagent entry is rebuilt by the caller.
 */
export function safeToolsSettings(ts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [tool, raw] of Object.entries(ts)) {
    if (tool === 'subagent') continue;
    const settings = obj(raw);
    if (READ_ONLY.has(tool)) {
      out[tool] = settings;
      continue;
    }
    const kept = Object.fromEntries(Object.entries(settings).filter(([k]) => !/^(allowed|autoAllow|autoApprove|trusted)/i.test(k)));
    if (Object.keys(kept).length) out[tool] = kept;
  }
  return out;
}

/** The tools a run profile gets: wildcards made explicit, subagent only when the caller adds it, MCP only from the run. */
export function safeTools(tools: string[]): string[] {
  const out = new Set<string>();
  for (const t of tools) {
    if (t === '*' || t === '@builtin') BUILTIN.forEach((b) => out.add(b));
    else if (t === 'subagent' || t === '@builtin/subagent' || t.startsWith('@')) continue;
    else out.add(t);
  }
  return [...out];
}

/** Resources that stay inside the project: no home (~) or absolute paths. */
export function safeResources(resources: string[]): string[] {
  return resources.filter((r) => {
    const rest = r.replace(/^(file|skill):\/\//, '');
    return !(rest.startsWith('~') || path.isAbsolute(rest) || /^[A-Za-z]:/.test(rest) || rest.split('/').includes('..'));
  });
}

/**
 * The part of a project agent a run profile keeps: its prompt, tools, resources, model, hooks and tool settings, with
 * every pre-approval of writes and commands removed. Approvals for write and shell always reach the portal.
 */
export function runProfileOf(a: KiroAgentFile): Record<string, unknown> {
  const extra = Object.fromEntries(Object.entries(a.json).filter(([k]) => !PORTAL_KEYS.has(k)));
  return {
    ...extra,
    description: a.description,
    prompt: a.prompt,
    tools: safeTools(a.tools),
    allowedTools: a.allowedTools.filter((t) => READ_ONLY.has(t)),
    toolsSettings: safeToolsSettings(a.toolsSettings),
    ...(Object.keys(a.hooks).length ? { hooks: a.hooks } : {}),
    resources: safeResources(a.resources),
    ...(a.model ? { model: a.model } : {}),
    includeMcpJson: false,
    permissions: { rules: [{ capability: 'fs_read', match: ['**'], effect: 'allow' }] },
  };
}
