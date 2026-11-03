/**
 * Core type definitions for P6 agent runs.
 */

import type { RunPermissions } from '../guardrails.ts';

// ── Agent run descriptor ──────────────────────────────────────────────────────

export interface AgentRun {
  runId: string;
  workflowId: string;
  projectId: string | null;
  goal: string;
  /** Explicit workflow kind — 'review' for code-review runs; null for generic runs. */
  kind: string | null;
  engine: 'claude-code' | 'kiro' | 'demo';
  trusted: boolean;
  dataDir: string;
  /** Absolute path: DATA_DIR/projects/<slug>/work/<runId>/ */
  workDir: string;
  repoIds: string[];
  /** The session's own choice of MCP integrations; null = the project's enabled ones. */
  integrationIds?: string[] | null;
  /** Set when the run goes to an AgentCore runner: the repositories it must clone (see runner-repos.ts). */
  runnerRepos?: import('./runner-repos.ts').RunnerRepo[];
  /** Set when the run goes to an AgentCore runner: the project's enabled MCP integrations (see runner-integrations.ts). */
  runnerMcpServers?: import('./runner-mcp.ts').McpServerSpec[];
  /** Set for a loop session's runs on an AgentCore runner: the check steps the runner runs after the agent finishes. */
  runnerChecks?: import('./runner-checks.ts').CheckStep[];
  leadAgent: string | null;
  permissions: RunPermissions;
  /** Optional per-user credential to use for this run (F4). */
  credentialId: string | null;
  /** User ID of the workflow owner — used to look up their default credential. */
  credentialOwnerId: string | null;
  /**
   * Optional model ID chosen by the user when creating the session (F-MODEL).
   * Empty/null means engine default.  Engines pass --model <id> (kiro) or
   * set model in the SDK options (claude-code).
   */
  model: string | null;
  /**
   * Engine session ID stored from the previous run (F-SESSION-RESUME).
   * Kiro: passed to session/load; Claude Code: passed as SDK resume option.
   * Null on first run or after /clear.
   */
  engineSessionId: string | null;
}

// ── Tool call ─────────────────────────────────────────────────────────────────

export interface ToolCall {
  toolName: string;
  toolInput: string;
  category: string | null;
}

// ── Run context ───────────────────────────────────────────────────────────────

export interface RunContext {
  run: AgentRun;
  emit: (type: string, payload: object) => void;
  awaitInput: (toolName: string, toolInput: Record<string, unknown>) => Promise<{
    decision: 'allow' | 'deny';
    remember: boolean;
    message: string;
    expired?: boolean;
  }>;
  /**
   * Keys already allowed for the rest of the run, keyed by rememberKey().
   * One exact shell command, one web host for WebFetch, or one other tool name.
   */
  allowed: Set<string>;
  /** Abort signal for the run; engines must propagate this to child processes and SDK calls. */
  signal: AbortSignal | null;
}
