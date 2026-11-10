/**
 * Tool policy — the one decision every agent tool call goes through.
 *
 * Pure module: depends only on node:crypto, node:path, ./guard.ts and ../real-path.ts.
 * The portal's local engines import it directly; the AgentCore runners get the same
 * file at image build time (agent-runner/build.mjs, the Dockerfiles), so a tool call
 * is judged the same way on this machine and inside an AgentCore microVM.
 *
 * Order of checks (first hit wins):
 *   1. A file write must land inside the working folder, links followed.
 *   2. guardToolCall(): tool settings, MCP lists, git hooks/config, Kiro config.
 *   3. The run's permission rules (first match: allow, ask or block).
 *   4. For "ask": allowed earlier in this run → allow; a command too long to review → deny.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { guardToolCall } from './guard.ts';
import { isReallyInsideDir } from '../real-path.ts';

// ── Tool families ─────────────────────────────────────────────────────────────

export const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'write', 'edit', 'str_replace_editor',
]);

export const BASH_TOOLS = new Set([
  'Bash', 'bash', 'execute_bash', 'execute_command', 'computer',
]);

export const READ_TOOLS = new Set([
  'Read', 'read', 'Glob', 'glob', 'Grep', 'grep',
  'LS', 'ls', 'view', 'cat',
  'WebSearch', 'WebFetch', 'web_search', 'web_fetch',
]);

export function toolCategory(name: string): string | null {
  if (WRITE_TOOLS.has(name)) return 'write';
  if (BASH_TOOLS.has(name)) return 'bash';
  if (READ_TOOLS.has(name)) return 'read';
  return null;
}

/** The text the permission rules are matched against. */
export function toolCommandStr(name: string, input: Record<string, unknown>): string {
  if (BASH_TOOLS.has(name)) return String(input.command ?? input.cmd ?? name);
  if (WRITE_TOOLS.has(name)) {
    const fp = String(input.file_path ?? input.path ?? input.new_path ?? '');
    return fp ? `${name} ${fp}` : name;
  }
  if (READ_TOOLS.has(name)) {
    const fp = String(input.file_path ?? input.path ?? input.query ?? '');
    return fp ? `${name} ${fp}` : name;
  }
  return name;
}

// ── Approval binding (FR-GUARD-8) ─────────────────────────────────────────────

/** The fields of a tool call that decide what it does. These are shown whole in the approval, never cut. */
const DECIDING_FIELDS = new Set(['command', 'url', 'file_path', 'notebook_path', 'path', 'pattern', 'branch']);

/** A shell command longer than this is refused instead of shown to a person: nobody can review it meaningfully. */
export const MAX_REVIEWABLE_COMMAND = 20_000;

/** JSON with sorted keys so the same tool call always produces the same text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** SHA-256 fingerprint of one exact tool call. An approval must send it back. */
export function inputFingerprint(toolName: string, input: unknown): string {
  return createHash('sha256').update(canonicalJson({ tool: toolName, input })).digest('hex');
}

/** What an approval shows: deciding fields whole, other long strings cut at 4,000 characters. */
export function approvalView(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = DECIDING_FIELDS.has(k) && typeof v === 'string' ? v : (typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) + `… (${v.length - 4000} more)` : v);
  }
  return out;
}

/**
 * What "allow for the rest of this run" covers: one exact shell command, one web host for WebFetch,
 * or one other tool name. This prevents a single approval from covering any later variant.
 */
export function rememberKey(toolName: string, input: Record<string, unknown>): { key: string; scope: 'command' | 'host' | 'tool'; label: string } {
  if (toolName === 'Bash' || toolName === 'bash' || toolName === 'execute_bash' || toolName === 'execute_command') {
    const command = String(input.command ?? input.cmd ?? '');
    return { key: `Bash\u0000${command}`, scope: 'command', label: command };
  }
  if (toolName === 'WebFetch' || toolName === 'web_fetch') {
    let host = '';
    try {
      host = new URL(String(input.url ?? '')).host.toLowerCase();
    } catch { /* not a URL — treat as exact */ }
    return host
      ? { key: `WebFetch\u0000${host}`, scope: 'host', label: host }
      : { key: `WebFetch\u0000${String(input.url ?? '')}`, scope: 'command', label: String(input.url ?? '') };
  }
  return { key: toolName, scope: 'tool', label: toolName };
}

// ── Permission rules ──────────────────────────────────────────────────────────

/** The fields of a permission rule the decision needs (a subset of the stored row). */
export interface PolicyRule {
  id: string;
  pattern: string | null;
  category: string | null;
  action: 'allow' | 'block' | 'ask';
  scope: 'always' | 'untrusted';
  reason: string | null;
}

export interface RuleDecision {
  action: 'allow' | 'block' | 'ask';
  reason: string;
  ruleId: string | null;
}

/** First matching rule wins; no match allows. Rules scoped "untrusted" are skipped for trusted runs. */
export function evaluateRules(
  cmd: { command: string; category: string | null },
  rules: readonly PolicyRule[],
  trusted: boolean,
): RuleDecision {
  for (const rule of rules) {
    if (rule.scope === 'untrusted' && trusted) continue;
    let matched = false;
    if (rule.pattern) {
      try {
        matched = new RegExp(rule.pattern, 'i').test(cmd.command);
      } catch {
        continue;
      }
    }
    if (!matched && rule.category) matched = rule.category === cmd.category;
    if (matched) return { action: rule.action, reason: rule.reason ?? '', ruleId: rule.id };
  }
  return { action: 'allow', reason: '', ruleId: null };
}

/** Keep only the fields a rule needs, for sending a run's rules to an AgentCore runner. */
export function toPolicyRules(rules: readonly PolicyRule[]): PolicyRule[] {
  return rules.map((r) => ({
    id: String(r.id),
    pattern: r.pattern ?? null,
    category: r.category ?? null,
    action: r.action,
    scope: r.scope,
    reason: r.reason ?? null,
  }));
}

// ── The decision ──────────────────────────────────────────────────────────────

export type ToolDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; reason: string; rememberKey: string; scope: 'command' | 'host' | 'tool'; label: string; inputHash: string };

export interface ToolCallCheck {
  toolName: string;
  input: Record<string, unknown>;
  /** The run's working folder. Null skips the inside-the-folder check (the folder is elsewhere, e.g. in a microVM). */
  workDir: string | null;
  rules: readonly PolicyRule[];
  trusted: boolean;
  /** Keys allowed earlier in this run (rememberKey().key). */
  allowed: ReadonlySet<string>;
}

export function decideToolCall(c: ToolCallCheck): ToolDecision {
  const { toolName, input } = c;

  if (c.workDir && WRITE_TOOLS.has(toolName)) {
    const target = String(input.file_path ?? input.path ?? input.new_path ?? input.notebook_path ?? '');
    if (target && !isReallyInsideDir(c.workDir, path.resolve(c.workDir, target))) {
      return { action: 'deny', reason: `Write to "${target}" is outside the run working directory.` };
    }
  }

  const guardReason = guardToolCall(toolName, input, c.workDir ?? '');
  if (guardReason) return { action: 'deny', reason: guardReason };

  const rule = evaluateRules({ command: toolCommandStr(toolName, input), category: toolCategory(toolName) }, c.rules, c.trusted);
  if (rule.action === 'block') {
    return { action: 'deny', reason: rule.reason || `Tool "${toolName}" is blocked by portal guardrails.` };
  }
  if (rule.action === 'allow') return { action: 'allow' };

  const rk = rememberKey(toolName, input);
  if (c.allowed.has(rk.key)) return { action: 'allow' };

  if (BASH_TOOLS.has(toolName)) {
    const command = String(input.command ?? input.cmd ?? '');
    if (command.length > MAX_REVIEWABLE_COMMAND) {
      return {
        action: 'deny',
        reason: `This command is ${command.length} characters long, too long for a person to review. Write a script file first, or split it into smaller steps.`,
      };
    }
  }

  return { action: 'ask', reason: rule.reason, rememberKey: rk.key, scope: rk.scope, label: rk.label, inputHash: inputFingerprint(toolName, input) };
}
