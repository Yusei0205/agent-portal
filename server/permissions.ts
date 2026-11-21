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
import { one } from './db.ts';
import { generateId, now, str, badRequest, notFound, forbidden } from './util.ts';
import { getPermissionsRepository } from './repositories/permissions.ts';
import {
  loadRunPermissions,
  evaluateCommand,
} from './guardrails.ts';
import type { PermissionRuleGroup, PermissionRule, ProjectToolRule } from './repositories/permissions.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
// ── Auth helpers ──────────────────────────────────────────────────────────────

function requireAdmin(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user?.is_admin) {
    sendJson(res, 403, { error: 'Admin access required' });
    return false;
  }
  return true;
}

/** Returns the project if the authenticated user is a member with role='owner'. */
async function requireProjectOwner(
  req: PortalRequest,
  res: PortalResponse,
  projectId: string,
): Promise<boolean> {
  const project = await getProjectRow(projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  const membership = await getMemberRow(projectId, req.user!.id);
  if (!membership || membership.role !== 'owner') {
    sendJson(res, 403, { error: 'Project owner access required' });
    return false;
  }
  return true;
}

/** Get the currently active default group id from the repository. */
async function getDefaultGroupId(): Promise<string> {
  return (await getPermissionsRepository().getPortalDefaultGroupId()) ?? 'standard';
}

// ── Portal-wide admin routes ──────────────────────────────────────────────────

export function registerPermissionRoutes(): void {
  /**
   * GET /api/admin/permissions
   */
  router.get(
    '/api/admin/permissions',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const groupId = await getDefaultGroupId();
      const group = await getPermissionsRepository().getGroupById(groupId);
      if (!group) {
        sendJson(res, 404, { error: `Permission group '${groupId}' not found` });
        return;
      }

      const rules = await getPermissionsRepository().getRulesForGroup(groupId);
      sendJson(res, 200, { group, rules });
    }),
  );

  /**
   * PUT /api/admin/permissions
   * Body: { defaultGroupId: string }
   */
  router.put(
    '/api/admin/permissions',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const body = req.body as Record<string, unknown>;
      const defaultGroupId = str(body.defaultGroupId, 'defaultGroupId');

      const group = await getPermissionsRepository().getGroupById(defaultGroupId);
      if (!group) {
        sendJson(res, 400, { error: `Permission group '${defaultGroupId}' not found` });
        return;
      }

      await getPermissionsRepository().setPortalDefaultGroupId(defaultGroupId);
      sendJson(res, 200, { ok: true, defaultGroupId });
    }),
  );

  /**
   * POST /api/admin/permissions/rules
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

      const groupId = await getDefaultGroupId();
      const group = await getPermissionsRepository().getGroupById(groupId);
      if (!group) {
        sendJson(res, 404, { error: `Permission group '${groupId}' not found` });
        return;
      }
      if (group.is_builtin) {
        throw badRequest('Cannot add rules to a built-in group. Create a custom group first.');
      }

      const id = generateId();
      const ts = now();
      const rule = await getPermissionsRepository().createRule({
        id,
        group_id: groupId,
        name,
        pattern: body.pattern != null ? String(body.pattern) : null,
        category: body.category != null ? String(body.category) : null,
        action: action as 'allow' | 'block' | 'ask',
        scope: scope as 'always' | 'untrusted',
        reason: body.reason != null ? String(body.reason) : null,
        sort_order: body.sortOrder != null ? Number(body.sortOrder) : 0,
        created_at: ts,
        updated_at: ts,
      });

      sendJson(res, 201, { rule });
    }),
  );

  /**
   * DELETE /api/admin/permissions/rules/:id
   */
  router.delete(
    '/api/admin/permissions/rules/:id',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      if (!requireAdmin(req, res)) return;

      const ruleId = req.params.id;
      // Find the rule and its group to check is_builtin
      const groups = await getPermissionsRepository().listGroups();
      let foundRule: PermissionRule | null = null;
      let foundGroup: PermissionRuleGroup | null = null;

      for (const group of groups) {
        const rules = await getPermissionsRepository().getRulesForGroup(group.id);
        const rule = rules.find((r) => r.id === ruleId);
        if (rule) {
          foundRule = rule;
          foundGroup = group;
          break;
        }
      }

      if (!foundRule || !foundGroup) throw notFound('Permission rule not found');
      if (foundGroup.is_builtin) {
        throw forbidden('Cannot delete rules from a built-in group');
      }

      await getPermissionsRepository().deleteRule(ruleId);
      sendJson(res, 200, { ok: true });
    }),
  );

  /**
   * POST /api/admin/permissions/test
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

      // Include the matched rule if available
      let matchedRule: PermissionRule | null = null;
      if (decision.ruleId) {
        const groups = await getPermissionsRepository().listGroups();
        for (const group of groups) {
          const rules = await getPermissionsRepository().getRulesForGroup(group.id);
          matchedRule = rules.find((r) => r.id === decision.ruleId) ?? null;
          if (matchedRule) break;
        }
      }

      sendJson(res, 200, { decision, matchedRule });
    }),
  );

  // ── Project-scoped routes ───────────────────────────────────────────────────

  /**
   * GET /api/projects/:id/permissions
   */
  router.get(
    '/api/projects/:id/permissions',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const projectId = req.params.id;
      if (!await requireProjectOwner(req, res, projectId)) return;

      const override = await getPermissionsRepository().getProjectPermissions(projectId);
      const toolRules = await getPermissionsRepository().getProjectToolRules(projectId);

      sendJson(res, 200, {
        groupOverride: override?.rule_group_id ?? null,
        toolRules,
      });
    }),
  );

  /**
   * PUT /api/projects/:id/permissions
   */
  router.put(
    '/api/projects/:id/permissions',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const projectId = req.params.id;
      if (!await requireProjectOwner(req, res, projectId)) return;

      const body = req.body as Record<string, unknown>;
      const ruleGroupId = body.ruleGroupId != null ? String(body.ruleGroupId) : null;

      if (ruleGroupId === null) {
        await getPermissionsRepository().clearProjectPermissions(projectId);
        sendJson(res, 200, { ok: true, groupOverride: null });
        return;
      }

      const group = await getPermissionsRepository().getGroupById(ruleGroupId);
      if (!group) {
        sendJson(res, 400, { error: `Permission group '${ruleGroupId}' not found` });
        return;
      }

      await getPermissionsRepository().setProjectPermissions(projectId, ruleGroupId);
      sendJson(res, 200, { ok: true, groupOverride: ruleGroupId });
    }),
  );

  /**
   * POST /api/projects/:id/tool-rules
   */
  router.post(
    '/api/projects/:id/tool-rules',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const projectId = req.params.id;
      if (!await requireProjectOwner(req, res, projectId)) return;

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
      const rule = await getPermissionsRepository().createProjectToolRule({
        id,
        project_id: projectId,
        tool_name: toolName,
        action: action as 'allow' | 'block' | 'ask',
        command_pattern: body.commandPattern != null ? String(body.commandPattern) : null,
        scope: scope as 'always' | 'untrusted',
        created_at: ts,
        updated_at: ts,
      });

      sendJson(res, 201, { rule });
    }),
  );

  /**
   * DELETE /api/projects/:id/tool-rules/:rid
   */
  router.delete(
    '/api/projects/:id/tool-rules/:rid',
    requireAuth(async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const projectId = req.params.id;
      if (!await requireProjectOwner(req, res, projectId)) return;

      const ruleId = req.params.rid;
      const toolRules = await getPermissionsRepository().getProjectToolRules(projectId);
      const rule = toolRules.find((r: ProjectToolRule) => r.id === ruleId);
      if (!rule) throw notFound('Tool rule not found');

      await getPermissionsRepository().deleteProjectToolRule(projectId, ruleId);
      sendJson(res, 200, { ok: true });
    }),
  );
}
