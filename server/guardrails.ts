/**
 * Guardrails — permission evaluation for agent runs.
 *
 * Evaluation flow:
 *   1. loadRunPermissions(projectId) — build the effective rule set for a run
 *   2. evaluateCommand(cmd, perms, trusted) — first-match wins, returns allow/block/ask
 *
 * All SQL for permission tables now lives in the permissions repository.
 * Re-exports types from the repository interface so callers don't need two imports.
 */

import { getPermissionsRepository } from './repositories/permissions.ts';
import type { PermissionRule, ProjectToolRule } from './repositories/permissions.ts';
import { evaluateRules } from './agent/tool-policy.ts';

// Re-export types for callers that import from guardrails.ts
export type { PermissionRuleGroup, PermissionRule, ProjectToolRule } from './repositories/permissions.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RunPermissions {
  rules: PermissionRule[];
  toolRules: ProjectToolRule[];
  projectId: string | null;
}

export interface CommandContext {
  command: string;
  category: string | null;
}

export interface PermissionDecision {
  action: 'allow' | 'block' | 'ask';
  reason: string;
  ruleId: string | null;
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Load the effective permission rules for a run.
 *
 * 1. Read portal_permissions.default_group_id (fallback: 'standard').
 * 2. If projectId is provided, check project_permissions for an override.
 * 3. Load all rules for the effective group ordered by sort_order.
 * 4. Load project tool rules (empty if no projectId).
 */
export async function loadRunPermissions(projectId: string | null): Promise<RunPermissions> {
  const repo = getPermissionsRepository();

  // Step 1: portal-wide default
  let effectiveGroupId = (await repo.getPortalDefaultGroupId()) ?? 'standard';

  // Step 2: project override
  if (projectId) {
    const projectPerm = await repo.getProjectPermissions(projectId);
    if (projectPerm) {
      effectiveGroupId = projectPerm.rule_group_id;
    }
  }

  // Step 3: load rules for the effective group
  const rules = await repo.getRulesForGroup(effectiveGroupId);

  // Step 4: load project tool rules
  const toolRules = projectId ? await repo.getProjectToolRules(projectId) : [];

  return { rules, toolRules, projectId };
}

/**
 * Evaluate a command against the loaded permissions.
 * First-match wins; returns allow if no rule matches.
 */
export function evaluateCommand(
  cmd: CommandContext,
  perms: RunPermissions,
  trusted: boolean,
): PermissionDecision {
  // One implementation, shared with the AgentCore runners (server/agent/tool-policy.ts).
  return evaluateRules(cmd, perms.rules, trusted);
}
