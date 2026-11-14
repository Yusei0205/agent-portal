/**
 * Guard — settings, hook, and path protection for agent tool calls.
 *
 * Pure module: no DB, HTTP, or portal-specific imports. Depends only on
 * node:path (available in any Node.js runtime, including AgentCore microVMs).
 *
 * AgentCore reuse: deploy this file unchanged inside the AgentCore container.
 * Import guardToolCall() from the Claude Code PreToolUse hook that executes
 * before every agent tool call. The same function runs in the local runner's
 * canUseTool callback (server/agent/claude-code.ts). The workDir argument must
 * be the real path of the working copy (resolved through symlinks).
 */

import path from 'node:path';

// ── Write-tool names ───────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'write', 'edit', 'str_replace_editor',
]);

const BASH_TOOLS = new Set([
  'Bash', 'bash', 'execute_bash', 'execute_command', 'computer',
]);

// ── Protected file patterns ────────────────────────────────────────────────────

/**
 * Returns a denial reason if the given relative or absolute file path targets
 * a protected configuration file that agents must not change:
 *   - .claude/settings*.json, .claude/hooks/
 *   - .kiro/settings/, .kiro/agents/, .kiro/hooks/
 *   - .mcp.json under .kiro or .claude, or at the root
 *   - Anything inside .git/ (hooks, config, attributes, modules…)
 *   - .husky/ (git hook manager)
 *
 * Returns null if the path is safe to write.
 */
export function protectedConfigReason(file: string): string | null {
  const parts = path.normalize(file).split(/[\\/]+/).map((x) => x.toLowerCase());
  const name = parts[parts.length - 1] ?? '';
  const parent = parts[parts.length - 2] ?? '';
  const hit =
    parts.includes('.git') ||
    parts.includes('.husky') ||
    (parent === '.claude' && (name === 'settings.json' || name === 'settings.local.json')) ||
    name === '.mcp.json' ||
    parts.some((x, i) => x === '.claude' && parts[i + 1] === 'hooks') ||
    parts.some((x, i) => x === '.kiro' && (
      parts[i + 1] === 'settings' ||
      parts[i + 1] === 'agents' ||
      parts[i + 1] === 'hooks'
    )) ||
    // mcp.json directly under .kiro or .claude
    (parent === '.kiro' && name === 'mcp.json') ||
    (parent === '.claude' && name === 'mcp.json');
  return hit
    ? `${file} configures tools that run commands or skip approvals, so agents may not change it. Ask a person to make the change.`
    : null;
}

// ── Protected command patterns ─────────────────────────────────────────────────

/**
 * Matches protected config paths in a shell command.
 * Covers .claude/settings*.json|hooks, .mcp.json, .git/hooks|config|…,
 * .kiro/settings|agents|hooks, .husky/.
 */
const PROTECTED_IN_COMMAND =
  /(?:\.claude[\\/]+(?:settings(?:\.local)?\.json|hooks)|\.mcp\.json|\.git[\\/]+(?:hooks|config|modules|info[\\/]+attributes)\b|\.kiro[\\/]+(?:settings|agents|hooks)|\.husky[\\/])/i;

/**
 * Matches shell write/modify patterns: >, tee, cp, mv, ln, sed -i, perl -i,
 * chmod (makes hooks executable), rm, install, rsync,
 * PowerShell Set-Content/Add-Content/Out-File/Copy-Item/Move-Item/New-Item.
 */
const WRITES_IN_COMMAND =
  /(?:>|\btee\b|\bcp\b|\bmv\b|\bln\b|\binstall\b|\brsync\b|\bchmod\b|\bdd\b|\btruncate\b|\btouch\b|\bsed\b[^|;&\n]*\s-[a-z]*i|\bperl\b[^|;&\n]*\s-[a-z]*i|\b(?:Set|Add|Out)-Content\b|\bOut-File\b|\b(?:Copy|Move|New)-Item\b|\bWrite-File\b|\bwriteFile\b)/i;

/**
 * Matches git config commands that set options running external programs:
 * core.hooksPath, core.fsmonitor, core.sshCommand, diff.external, filter.*,
 * alias.*, includeIf.*, include.path, core.editor, core.pager.
 */
const GIT_CONFIG_RUNS_COMMANDS =
  /\bgit\b[^|;&\n]*\bconfig\b[^|;&\n]*\b(?:core\.hookspath|core\.fsmonitor|core\.sshcommand|core\.editor|core\.pager|diff\.external|filter\.|alias\.|includeif\.|include\.path)/i;

/**
 * Returns a denial reason if the given shell command clearly writes to a
 * protected configuration file, or sets a git option that runs external programs.
 *
 * Best-effort seat-belt check: reads command text only. A sandbox is the proper
 * wall. Catches common patterns and blocks them regardless of trust level.
 *
 * Returns null if the command is safe or the pattern is not recognised.
 */
export function protectedCommandReason(command: string): string | null {
  const text = String(command ?? '');
  if (PROTECTED_IN_COMMAND.test(text) && WRITES_IN_COMMAND.test(text)) {
    return 'agents may not change tool settings, MCP server lists, Kiro config, git hooks/config, or husky hooks (they run commands or skip approvals). Ask a person to make the change.';
  }
  if (GIT_CONFIG_RUNS_COMMANDS.test(text)) {
    return 'agents may not set git options that run programs (hooks, fsmonitor, filters, aliases, includes). Ask a person to make the change.';
  }
  return null;
}

// ── Ready hook ─────────────────────────────────────────────────────────────────

/**
 * Single entry point for Claude Code canUseTool / PreToolUse hooks.
 *
 * Returns null to allow the call, or a non-empty string (the denial reason) to
 * block it. Covers Write/Edit/MultiEdit/NotebookEdit and Bash/execute_bash.
 *
 * For write tools the caller is responsible for the inside-workDir check; this
 * function only checks whether the target is a protected config file.
 * Use isReallyInsideDir from server/real-path.ts for the boundary check.
 *
 * AgentCore: pass the container's workDir as-is; it is already the real path.
 */
export function guardToolCall(
  toolName: string,
  input: Record<string, unknown>,
  _workDir: string,
): string | null {
  if (WRITE_TOOLS.has(toolName)) {
    const relPath = String(
      input.file_path ?? input.path ?? input.new_path ?? input.notebook_path ?? '',
    );
    if (relPath) {
      const reason = protectedConfigReason(relPath);
      if (reason) return `Blocked by Agent Portal: ${reason}`;
    }
  }
  if (BASH_TOOLS.has(toolName)) {
    const command = String(input.command ?? input.cmd ?? '');
    if (command) {
      const reason = protectedCommandReason(command);
      if (reason) return `Blocked by Agent Portal: ${reason}`;
    }
  }
  return null;
}
