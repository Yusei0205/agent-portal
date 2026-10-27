/**
 * Guardrails — permission evaluation for agent runs.
 *
 * Data model:
 *   permission_rule_groups  — named sets of rules (built-in: 'core-safe', 'standard')
 *   permission_rules        — ordered rules with pattern/category, action, scope
 *   portal_permissions      — portal-wide default group
 *   project_permissions     — per-project group override
 *   project_tool_rules      — per-project per-tool overrides
 *
 * Evaluation flow:
 *   1. loadRunPermissions(projectId) — build the effective rule set for a run
 *   2. evaluateCommand(cmd, perms, trusted) — first-match wins, returns allow/block/ask
 *   3. isAlwaysBlocked(command) — synchronous check from cached core-safe rules
 */

import { one, all } from './db.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PermissionRuleGroup {
  id: string;
  name: string;
  description: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export interface PermissionRule {
  id: string;
  group_id: string;
  name: string;
  pattern: string | null;
  category: string | null;
  action: 'allow' | 'block' | 'ask';
  scope: 'always' | 'untrusted';
  reason: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectToolRule {
  id: string;
  project_id: string;
  tool_name: string;
  action: 'allow' | 'block' | 'ask';
  command_pattern: string | null;
  scope: 'always' | 'untrusted';
  created_at: string;
  updated_at: string;
}

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

// ── Module-level cache for isAlwaysBlocked ────────────────────────────────────

/**
 * Cached 'always' scope rules from all built-in groups.
 * Loaded once on first call to isAlwaysBlocked().
 */
let alwaysBlockedRules: Array<{ pattern: string | null; id: string }> | null = null;

function getAlwaysBlockedRules(): Array<{ pattern: string | null; id: string }> {
  if (alwaysBlockedRules !== null) return alwaysBlockedRules;
  try {
    alwaysBlockedRules = all<{ pattern: string | null; id: string }>(
      `SELECT id, pattern FROM permission_rules
       WHERE action = 'block' AND scope = 'always'`,
    );
  } catch {
    // DB not yet open or migration not applied — return empty
    alwaysBlockedRules = [];
  }
  return alwaysBlockedRules;
}

/** Clear the always-blocked cache (used in tests to pick up fresh seed data). */
export function clearAlwaysBlockedCache(): void {
  alwaysBlockedRules = null;
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
  // Step 1: portal-wide default
  const portalRow = one<{ default_group_id: string }>(
    'SELECT default_group_id FROM portal_permissions WHERE id = 1',
  );
  let effectiveGroupId = portalRow?.default_group_id ?? 'standard';

  // Step 2: project override
  if (projectId) {
    const projectRow = one<{ rule_group_id: string }>(
      'SELECT rule_group_id FROM project_permissions WHERE project_id = ?',
      projectId,
    );
    if (projectRow) {
      effectiveGroupId = projectRow.rule_group_id;
    }
  }

  // Step 3: load rules for the effective group
  const rules = all<PermissionRule>(
    'SELECT * FROM permission_rules WHERE group_id = ? ORDER BY sort_order',
    effectiveGroupId,
  );

  // Step 4: load project tool rules
  const toolRules = projectId
    ? all<ProjectToolRule>(
        'SELECT * FROM project_tool_rules WHERE project_id = ?',
        projectId,
      )
    : [];

  return { rules, toolRules, projectId };
}

/**
 * Evaluate a command against the loaded permissions.
 *
 * Rules are tested in sort_order. First match wins.
 * Rules with scope='untrusted' are skipped when trusted=true.
 * Returns allow if no rule matches.
 */
export function evaluateCommand(
  cmd: CommandContext,
  perms: RunPermissions,
  trusted: boolean,
): PermissionDecision {
  for (const rule of perms.rules) {
    // Skip untrusted-only rules for trusted runs
    if (rule.scope === 'untrusted' && trusted) continue;

    let matched = false;

    // Pattern match (case-insensitive)
    if (rule.pattern) {
      try {
        matched = new RegExp(rule.pattern, 'i').test(cmd.command);
      } catch {
        // Invalid regex — skip this rule
        continue;
      }
    }

    // Category match (if not already matched by pattern)
    if (!matched && rule.category) {
      matched = rule.category === cmd.category;
    }

    if (matched) {
      return {
        action: rule.action,
        reason: rule.reason ?? '',
        ruleId: rule.id,
      };
    }
  }

  return { action: 'allow', reason: '', ruleId: null };
}

/**
 * Synchronous check: returns true if the command matches any 'always' + 'block'
 * rule across all groups. Used as a last-resort safety check before executing any command.
 *
 * Results are cached after the first DB read.
 */
export function isAlwaysBlocked(command: string): boolean {
  const rules = getAlwaysBlockedRules();
  for (const rule of rules) {
    if (!rule.pattern) continue;
    try {
      if (new RegExp(rule.pattern, 'i').test(command)) return true;
    } catch {
      // Invalid regex — skip
    }
  }
  return false;
}
