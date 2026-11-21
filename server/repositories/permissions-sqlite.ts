/**
 * SQLite implementation of PermissionsRepository.
 *
 * All SQL for permission_rule_groups, permission_rules, portal_permissions,
 * project_permissions, and project_tool_rules lives here.
 */

import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  PermissionsRepository,
  PermissionRuleGroup,
  PermissionRule,
  ProjectToolRule,
  CreateRuleInput,
  CreateToolRuleInput,
} from './permissions.ts';

function toGroup(row: Row): PermissionRuleGroup {
  return {
    id:          String(row.id),
    name:        String(row.name),
    description: String(row.description ?? ''),
    is_builtin:  Number(row.is_builtin ?? 0),
    created_at:  String(row.created_at),
    updated_at:  String(row.updated_at),
  };
}

function toRule(row: Row): PermissionRule {
  return {
    id:         String(row.id),
    group_id:   String(row.group_id),
    name:       String(row.name),
    pattern:    row.pattern != null ? String(row.pattern) : null,
    category:   row.category != null ? String(row.category) : null,
    action:     String(row.action) as 'allow' | 'block' | 'ask',
    scope:      String(row.scope) as 'always' | 'untrusted',
    reason:     row.reason != null ? String(row.reason) : null,
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function toToolRule(row: Row): ProjectToolRule {
  return {
    id:              String(row.id),
    project_id:      String(row.project_id),
    tool_name:       String(row.tool_name),
    action:          String(row.action) as 'allow' | 'block' | 'ask',
    command_pattern: row.command_pattern != null ? String(row.command_pattern) : null,
    scope:           String(row.scope) as 'always' | 'untrusted',
    created_at:      String(row.created_at),
    updated_at:      String(row.updated_at),
  };
}

export class SqlitePermissionsRepository implements PermissionsRepository {
  async listGroups(): Promise<PermissionRuleGroup[]> {
    return all<Row>('SELECT * FROM permission_rule_groups').map(toGroup);
  }

  async getGroupById(id: string): Promise<PermissionRuleGroup | null> {
    const row = one<Row>('SELECT * FROM permission_rule_groups WHERE id = ?', id);
    return row ? toGroup(row) : null;
  }

  async getRulesForGroup(groupId: string): Promise<PermissionRule[]> {
    return all<Row>(
      'SELECT * FROM permission_rules WHERE group_id = ? ORDER BY sort_order',
      groupId,
    ).map(toRule);
  }

  async getAllBlockRules(): Promise<Array<{ id: string; pattern: string | null }>> {
    return all<Row>(
      `SELECT id, pattern FROM permission_rules WHERE action = 'block' AND scope = 'always'`,
    ).map((r) => ({ id: String(r.id), pattern: r.pattern != null ? String(r.pattern) : null }));
  }

  async createRule(input: CreateRuleInput): Promise<PermissionRule> {
    insert('permission_rules', {
      id:         input.id,
      group_id:   input.group_id,
      name:       input.name,
      pattern:    input.pattern,
      category:   input.category,
      action:     input.action,
      scope:      input.scope,
      reason:     input.reason,
      sort_order: input.sort_order,
      created_at: input.created_at,
      updated_at: input.updated_at,
    });
    return toRule(one<Row>('SELECT * FROM permission_rules WHERE id = ?', input.id)!);
  }

  async deleteRule(ruleId: string): Promise<void> {
    dbRun('DELETE FROM permission_rules WHERE id = ?', ruleId);
  }

  async getPortalDefaultGroupId(): Promise<string | null> {
    const row = one<{ default_group_id: string }>(
      'SELECT default_group_id FROM portal_permissions WHERE id = 1',
    );
    return row?.default_group_id ?? null;
  }

  async setPortalDefaultGroupId(groupId: string): Promise<void> {
    const { now } = await import('../util.ts');
    dbRun(
      'UPDATE portal_permissions SET default_group_id = ?, updated_at = ? WHERE id = 1',
      groupId,
      now(),
    );
  }

  async getProjectPermissions(projectId: string): Promise<{ rule_group_id: string } | null> {
    const row = one<{ rule_group_id: string }>(
      'SELECT rule_group_id FROM project_permissions WHERE project_id = ?',
      projectId,
    );
    return row ?? null;
  }

  async setProjectPermissions(projectId: string, ruleGroupId: string): Promise<void> {
    const { now } = await import('../util.ts');
    dbRun(
      `INSERT INTO project_permissions (project_id, rule_group_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE
         SET rule_group_id = excluded.rule_group_id, updated_at = excluded.updated_at`,
      projectId,
      ruleGroupId,
      now(),
    );
  }

  async clearProjectPermissions(projectId: string): Promise<void> {
    dbRun('DELETE FROM project_permissions WHERE project_id = ?', projectId);
  }

  async getProjectToolRules(projectId: string): Promise<ProjectToolRule[]> {
    return all<Row>(
      'SELECT * FROM project_tool_rules WHERE project_id = ?',
      projectId,
    ).map(toToolRule);
  }

  async createProjectToolRule(input: CreateToolRuleInput): Promise<ProjectToolRule> {
    insert('project_tool_rules', {
      id:              input.id,
      project_id:      input.project_id,
      tool_name:       input.tool_name,
      action:          input.action,
      command_pattern: input.command_pattern,
      scope:           input.scope,
      created_at:      input.created_at,
      updated_at:      input.updated_at,
    });
    return toToolRule(one<Row>('SELECT * FROM project_tool_rules WHERE id = ?', input.id)!);
  }

  async deleteProjectToolRule(projectId: string, ruleId: string): Promise<void> {
    dbRun('DELETE FROM project_tool_rules WHERE id = ? AND project_id = ?', ruleId, projectId);
  }
}
