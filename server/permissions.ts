/**
 * Permission system API routes.
 *
 * Portal-wide admin routes (require is_admin):
 *   GET    /api/admin/permissions               — get active group + rules
 *   PUT    /api/admin/permissions               — set default group
 *   POST   /api/admin/permissions/rules         — add rule to active group
 *   DELETE /api/admin/permissions/rules/:id     — delete rule (not allowed for built-in groups)
 *   POST   /api/admin/permissions/test          — test a command against effective permissions
 *
 * Project-scoped routes (require project owner role):
 *   GET    /api/projects/:id/permissions        — get project override + tool rules
 *   PUT    /api/projects/:id/permissions        — set project group override
 *   POST   /api/projects/:id/tool-rules         — add a project tool rule
 *   DELETE /api/projects/:id/tool-rules/:rid    — delete a project tool rule
 */

import { router, requireAuth, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert } from './db.ts';
import { generateId, now, str, badRequest, notFound, forbidden } from './util.ts';
import {
  loadRunPermissions,
  evaluateCommand,
  type PermissionRuleGroup,
  type PermissionRule,
  type ProjectToolRule,
} from './guardrails.ts';

// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireAdmin(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user?.is_admin) {
    sendJson(res, 403, { error: 'Admin access required' });
    return false;
  }
  return true;
}

/** Returns the project if the authenticated user is a member with role='owner'. */
function requireProjectOwner(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): boolean {
  const project = one<{ id: string }>('SELECT id FROM projects WHERE id = ?', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  const membership = one<{ role: string }>(
    "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
    projectId,
    req.user!.id,
  );
  if (!membership || membership.role !== 'owner') {
    sendJson(res, 403, { error: 'Project owner access required' });
    return false;
  }
  return true;
}

/** Get the currently active default group id from portal_permissions. */
function getDefaultGroupId(): string {
  return (
    one<{ default_group_id: string }>(
      'SELECT default_group_id FROM portal_permissions WHERE id = 1',
    )?.default_group_id ?? 'standard'
  );
}

// ── Portal-wide admin routes ──────────────────────────────────────────────────

export function registerPermissionRoutes(): void {
  /**
   * GET /api/admin/permissions
   * Returns the active permission rule group and its rules.
   */
  router.get(
    '/api/admin/permissions',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const groupId = getDefaultGroupId();
      const group = one<PermissionRuleGroup>(
        'SELECT * FROM permission_rule_groups WHERE id = ?',
        groupId,
      );
      if (!group) {
        sendJson(res, 404, { error: `Permission group '${groupId}' not found` });
        return;
      }

      const rules = all<PermissionRule>(
        'SELECT * FROM permission_rules WHERE group_id = ? ORDER BY sort_order',
        groupId,
      );

      sendJson(res, 200, { group, rules });
    }),
  );

  /**
   * PUT /api/admin/permissions
   * Body: { defaultGroupId: string }
   * Updates the portal-wide default permission group.
   */
  router.put(
    '/api/admin/permissions',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const body = req.body as Record<string, unknown>;
      const defaultGroupId = str(body.defaultGroupId, 'defaultGroupId');

      // Verify the group exists
      const group = one<{ id: string }>(
        'SELECT id FROM permission_rule_groups WHERE id = ?',
        defaultGroupId,
      );
      if (!group) {
        sendJson(res, 400, { error: `Permission group '${defaultGroupId}' not found` });
        return;
      }

      run(
        'UPDATE portal_permissions SET default_group_id = ?, updated_at = ? WHERE id = 1',
        defaultGroupId,
        now(),
      );

      sendJson(res, 200, { ok: true, defaultGroupId });
    }),
  );

  /**
   * POST /api/admin/permissions/rules
   * Body: { name, pattern?, category?, action, scope, reason?, sortOrder? }
   * Adds a new rule to the currently active group.
   * Fails if the active group is built-in (is_builtin = 1).
   */
  router.post(
    '/api/admin/permissions/rules',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const body = req.body as Record<string, unknown>;
      const name = str(body.name, 'name');
      const action = str(body.action, 'action');
      if (!['allow', 'block', 'ask'].includes(action)) {
        throw badRequest("action must be 'allow', 'block', or 'ask'");
      }
      const scope = body.scope ? str(body.scope as string, 'scope') : 'always';
      if (!['always', 'untrusted'].includes(scope)) {
        throw badRequest("scope must be 'always' or 'untrusted'");
      }

      const groupId = getDefaultGroupId();
      const group = one<{ id: string; is_builtin: number }>(
        'SELECT id, is_builtin FROM permission_rule_groups WHERE id = ?',
        groupId,
      );
      if (!group) {
        sendJson(res, 404, { error: `Permission group '${groupId}' not found` });
        return;
      }
      if (group.is_builtin) {
        throw badRequest(
          'Cannot add rules to a built-in group. Create a custom group first.',
        );
      }

      const id = generateId();
      const ts = now();
      insert('permission_rules', {
        id,
        group_id: groupId,
        name,
        pattern: body.pattern != null ? String(body.pattern) : null,
        category: body.category != null ? String(body.category) : null,
        action,
        scope,
        reason: body.reason != null ? String(body.reason) : null,
        sort_order: body.sortOrder != null ? Number(body.sortOrder) : 0,
        created_at: ts,
        updated_at: ts,
      });

      const rule = one<PermissionRule>('SELECT * FROM permission_rules WHERE id = ?', id);
      sendJson(res, 201, { rule });
    }),
  );

  /**
   * DELETE /api/admin/permissions/rules/:id
   * Deletes a rule. Fails if the rule belongs to a built-in group.
   */
  router.delete(
    '/api/admin/permissions/rules/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const ruleId = req.params.id;
      const rule = one<PermissionRule & { is_builtin: number }>(
        `SELECT r.*, g.is_builtin
           FROM permission_rules r
           JOIN permission_rule_groups g ON g.id = r.group_id
          WHERE r.id = ?`,
        ruleId,
      );
      if (!rule) throw notFound('Permission rule not found');
      if (rule.is_builtin) {
        throw forbidden('Cannot delete rules from a built-in group');
      }

      run('DELETE FROM permission_rules WHERE id = ?', ruleId);
      sendJson(res, 200, { ok: true });
    }),
  );

  /**
   * POST /api/admin/permissions/test
   * Body: { command, trusted?, projectId? }
   * Tests a command against the effective permission rules and returns the decision.
   */
  router.post(
    '/api/admin/permissions/test',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const body = req.body as Record<string, unknown>;
      const command = str(body.command, 'command');
      const trusted = body.trusted === true;
      const projectId = body.projectId != null ? String(body.projectId) : null;

      const perms = await loadRunPermissions(projectId);
      const decision = evaluateCommand(
        { command, category: (body.category as string | null) ?? null },
        perms,
        trusted,
      );

      // Include the matched rule details if available
      let matchedRule: PermissionRule | null = null;
      if (decision.ruleId) {
        matchedRule = one<PermissionRule>(
          'SELECT * FROM permission_rules WHERE id = ?',
          decision.ruleId,
        ) ?? null;
      }

      sendJson(res, 200, { decision, matchedRule });
    }),
  );

  // ── Project-scoped routes ───────────────────────────────────────────────────

  /**
   * GET /api/projects/:id/permissions
   * Returns the project's group override (or null) and its tool rules.
   */
  router.get(
    '/api/projects/:id/permissions',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const projectId = req.params.id;
      if (!requireProjectOwner(req, res, projectId)) return;

      const override = one<{ rule_group_id: string }>(
        'SELECT rule_group_id FROM project_permissions WHERE project_id = ?',
        projectId,
      );

      const toolRules = all<ProjectToolRule>(
        'SELECT * FROM project_tool_rules WHERE project_id = ?',
        projectId,
      );

      sendJson(res, 200, {
        groupOverride: override?.rule_group_id ?? null,
        toolRules,
      });
    }),
  );

  /**
   * PUT /api/projects/:id/permissions
   * Body: { ruleGroupId: string | null }
   * Sets (or clears) the project's rule group override.
   */
  router.put(
    '/api/projects/:id/permissions',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const projectId = req.params.id;
      if (!requireProjectOwner(req, res, projectId)) return;

      const body = req.body as Record<string, unknown>;
      const ruleGroupId = body.ruleGroupId != null ? String(body.ruleGroupId) : null;

      if (ruleGroupId === null) {
        // Clear the project override
        run('DELETE FROM project_permissions WHERE project_id = ?', projectId);
        sendJson(res, 200, { ok: true, groupOverride: null });
        return;
      }

      // Verify the group exists
      const group = one<{ id: string }>(
        'SELECT id FROM permission_rule_groups WHERE id = ?',
        ruleGroupId,
      );
      if (!group) {
        sendJson(res, 400, { error: `Permission group '${ruleGroupId}' not found` });
        return;
      }

      run(
        `INSERT INTO project_permissions (project_id, rule_group_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET rule_group_id = excluded.rule_group_id, updated_at = excluded.updated_at`,
        projectId,
        ruleGroupId,
        now(),
      );

      sendJson(res, 200, { ok: true, groupOverride: ruleGroupId });
    }),
  );

  /**
   * POST /api/projects/:id/tool-rules
   * Body: { toolName, action, commandPattern?, scope? }
   * Adds a tool rule to the project.
   */
  router.post(
    '/api/projects/:id/tool-rules',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const projectId = req.params.id;
      if (!requireProjectOwner(req, res, projectId)) return;

      const body = req.body as Record<string, unknown>;
      const toolName = str(body.toolName, 'toolName');
      const action = str(body.action, 'action');
      if (!['allow', 'block', 'ask'].includes(action)) {
        throw badRequest("action must be 'allow', 'block', or 'ask'");
      }
      const scope = body.scope ? str(body.scope as string, 'scope') : 'always';
      if (!['always', 'untrusted'].includes(scope)) {
        throw badRequest("scope must be 'always' or 'untrusted'");
      }

      const id = generateId();
      const ts = now();
      insert('project_tool_rules', {
        id,
        project_id: projectId,
        tool_name: toolName,
        action,
        command_pattern: body.commandPattern != null ? String(body.commandPattern) : null,
        scope,
        created_at: ts,
        updated_at: ts,
      });

      const rule = one<ProjectToolRule>(
        'SELECT * FROM project_tool_rules WHERE id = ?',
        id,
      );
      sendJson(res, 201, { rule });
    }),
  );

  /**
   * DELETE /api/projects/:id/tool-rules/:rid
   * Deletes a project tool rule.
   */
  router.delete(
    '/api/projects/:id/tool-rules/:rid',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const projectId = req.params.id;
      if (!requireProjectOwner(req, res, projectId)) return;

      const ruleId = req.params.rid;
      const rule = one<ProjectToolRule>(
        'SELECT id FROM project_tool_rules WHERE id = ? AND project_id = ?',
        ruleId,
        projectId,
      );
      if (!rule) throw notFound('Tool rule not found');

      run('DELETE FROM project_tool_rules WHERE id = ?', ruleId);
      sendJson(res, 200, { ok: true });
    }),
  );
}
