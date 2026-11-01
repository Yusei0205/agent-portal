/**
 * Repository interface for the permissions system.
 *
 * Covers access patterns C1–C5 from the data design doc:
 *   C1 Load all rule groups
 *   C2 Load rules for a group
 *   C3 Get portal default group
 *   C4 Get project permission override
 *   C5 List tool rules for project
 *
 * Also exposes write operations needed by permissions.ts and a helper for the
 * synchronous isAlwaysBlocked() cache in guardrails.ts.
 */

import { SqlitePermissionsRepository } from './permissions-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

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

export interface CreateRuleInput {
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

export interface CreateToolRuleInput {
  id: string;
  project_id: string;
  tool_name: string;
  action: 'allow' | 'block' | 'ask';
  command_pattern: string | null;
  scope: 'always' | 'untrusted';
  created_at: string;
  updated_at: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface PermissionsRepository {
  // ── Groups ─────────────────────────────────────────────────────────────────

  /** Load all permission rule groups (C1). */
  listGroups(): Promise<PermissionRuleGroup[]>;

  /** Get a single group by ID. */
  getGroupById(id: string): Promise<PermissionRuleGroup | null>;

  // ── Rules ──────────────────────────────────────────────────────────────────

  /** Load rules for a group ordered by sort_order (C2). */
  getRulesForGroup(groupId: string): Promise<PermissionRule[]>;

  /** Get all always+block rules across all groups (for isAlwaysBlocked cache). */
  getAllBlockRules(): Promise<Array<{ id: string; pattern: string | null }>>;

  /** Create a new rule in a group. */
  createRule(input: CreateRuleInput): Promise<PermissionRule>;

  /** Delete a rule by ID. */
  deleteRule(ruleId: string): Promise<void>;

  // ── Portal permissions ─────────────────────────────────────────────────────

  /** Get the portal-wide default permission group ID (C3). */
  getPortalDefaultGroupId(): Promise<string | null>;

  /** Set the portal-wide default permission group ID. */
  setPortalDefaultGroupId(groupId: string): Promise<void>;

  // ── Project permissions ────────────────────────────────────────────────────

  /** Get the project's rule group override (C4). */
  getProjectPermissions(projectId: string): Promise<{ rule_group_id: string } | null>;

  /** Set the project's rule group override (upsert). */
  setProjectPermissions(projectId: string, ruleGroupId: string): Promise<void>;

  /** Clear (delete) the project's rule group override. */
  clearProjectPermissions(projectId: string): Promise<void>;

  /** List all tool rules for a project (C5). */
  getProjectToolRules(projectId: string): Promise<ProjectToolRule[]>;

  /** Create a project tool rule. */
  createProjectToolRule(input: CreateToolRuleInput): Promise<ProjectToolRule>;

  /**
   * Delete a project tool rule.
   * projectId is required so DynamoDB can build the PK without a separate lookup.
   */
  deleteProjectToolRule(projectId: string, ruleId: string): Promise<void>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: PermissionsRepository | null = null;

export async function initPermissionsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbPermissionsRepository } = await import('./permissions-dynamodb.ts');
    _instance = new DynamoDbPermissionsRepository();
  } else {
    _instance = new SqlitePermissionsRepository();
  }
}

export function getPermissionsRepository(): PermissionsRepository {
  if (_instance) return _instance;
  if (usesDynamoDb()) {
    throw new Error(
      'DynamoDB permissions repository was not initialised. ' +
        'Call await initPermissionsRepository() at server startup.',
    );
  }
  _instance = new SqlitePermissionsRepository();
  return _instance;
}

export function setPermissionsRepository(repo: PermissionsRepository): void { _instance = repo; }
export function clearPermissionsRepository(): void { _instance = null; }
