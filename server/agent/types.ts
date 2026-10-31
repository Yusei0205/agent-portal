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
  awaitInput: (toolName: string, toolInput: string) => Promise<'approve' | 'deny'>;
  /** Tool names that are auto-approved for this run (remember=true). */
  allowAll: Set<string>;
  /** Abort signal for the run; engines must propagate this to child processes and SDK calls. */
  signal: AbortSignal | null;
}
