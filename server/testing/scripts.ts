/**
 * Test groups and scripts CRUD.
 *
 * Routes:
 *   GET    /api/projects/:pid/tests/:tpid/groups               — list groups
 *   POST   /api/projects/:pid/tests/:tpid/groups               — create group (editor+)
 *   PUT    /api/projects/:pid/tests/:tpid/groups/:gid          — update group (editor+)
 *   DELETE /api/projects/:pid/tests/:tpid/groups/:gid          — delete group (editor+)
 *   GET    /api/projects/:pid/tests/:tpid/scripts              — list all scripts in test project
 *   GET    /api/projects/:pid/tests/:tpid/groups/:gid/scripts  — list scripts in group
 *   POST   /api/projects/:pid/tests/:tpid/groups/:gid/scripts  — create script (editor+)
 *   GET    /api/projects/:pid/tests/:tpid/scripts/:sid         — get script
 *   PUT    /api/projects/:pid/tests/:tpid/scripts/:sid         — update script (editor+)
 *   DELETE /api/projects/:pid/tests/:tpid/scripts/:sid         — delete script (editor+)
 *   GET    /api/projects/:pid/tests/:tpid/scripts/:sid/history — run history with trend
 */

import { testingRepo } from './data.ts';
import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { all, one, run, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now, str } from '../util.ts';
import { auditRaw } from '../audit.ts';
import {
  requireTestProject,
  hasScope,
} from './helpers.ts';
import type { TestGroup, TestScript } from './helpers.ts';
import { validateSteps } from './types.ts';

// ── Helpers ────────────────────────────────────────────────────────────────────

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(String(s)) as T; } catch { return fallback; }
}

function groupView(g: TestGroup) {
  return {
    id: g.id,
    testProjectId: g.test_project_id,
    name: g.name,
    sortOrder: g.sort_order,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

function scriptView(s: TestScript) {
  return {
    id: s.id,
    testProjectId: s.test_project_id,
    testGroupId: s.test_group_id,
    name: s.name,
    sortOrder: s.sort_order,
    steps: safeJson(s.steps, []),
    createdBy: s.created_by ?? null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerScriptRoutes(): void {

  // ── Groups ────────────────────────────────────────────────────────────────────

  // GET /api/projects/:pid/tests/:tpid/groups
  router.get('/api/projects/:pid/tests/:tpid/groups', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const groups = ((await testingRepo().listGroupsByTestProject(tp.id)) as unknown as TestGroup[])
      .sort((a, b) => a.sort_order - b.sort_order || String(a.name).localeCompare(String(b.name)));
    sendJson(res, 200, { groups: groups.map(groupView) });
  });

  // POST /api/projects/:pid/tests/:tpid/groups
  router.post('/api/projects/:pid/tests/:tpid/groups', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 200 }).trim();
    const sortOrder = typeof body.sortOrder === 'number' ? body.sortOrder : (await testingRepo().getMaxGroupSortOrder(tp.id)) + 1;

    const id = generateId();
    const ts = now();
    await testingRepo().createTestGroup({ id, test_project_id: tp.id, name, sort_order: sortOrder, created_at: ts, updated_at: ts });

    const group = (await testingRepo().getTestGroupById(id)) as unknown as TestGroup;
    sendJson(res, 201, { group: groupView(group) });
  });

  // PUT /api/projects/:pid/tests/:tpid/groups/:gid
  router.put('/api/projects/:pid/tests/:tpid/groups/:gid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const group = (await testingRepo().getTestGroupByTestProjectAndId(tp.id, req.params.gid)) as unknown as TestGroup | null;
    if (!group) { sendJson(res, 404, { error: 'Group not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: now() };
    if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 200);
    if (typeof body.sortOrder === 'number') patch.sort_order = body.sortOrder;

    await testingRepo().updateTestGroup(group.id, patch as Partial<TestGroup>);

    const updated = (await testingRepo().getTestGroupById(group.id)) as unknown as TestGroup;
    sendJson(res, 200, { group: groupView(updated) });
  });

  // DELETE /api/projects/:pid/tests/:tpid/groups/:gid
  router.delete('/api/projects/:pid/tests/:tpid/groups/:gid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const group = (await testingRepo().getTestGroupByTestProjectAndId(tp.id, req.params.gid)) as unknown as TestGroup | null;
    if (!group) { sendJson(res, 404, { error: 'Group not found' }); return; }
    // SQLite removes a group's scripts through a cascade; do it explicitly so DynamoDB behaves the same.
    for (const sc of await testingRepo().listScriptsByGroup(group.id)) await testingRepo().deleteTestScript(sc.id);
    await testingRepo().deleteTestGroup(group.id);
    sendJson(res, 200, { ok: true });
  });

  // ── Scripts ───────────────────────────────────────────────────────────────────

  // GET /api/projects/:pid/tests/:tpid/scripts — all scripts
  router.get('/api/projects/:pid/tests/:tpid/scripts', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const scripts = ((await testingRepo().listScriptsByTestProject(tp.id)) as unknown as TestScript[])
      .sort((a, b) => String(a.test_group_id).localeCompare(String(b.test_group_id)) || a.sort_order - b.sort_order);
    sendJson(res, 200, { scripts: scripts.map(scriptView) });
  });

  // GET /api/projects/:pid/tests/:tpid/groups/:gid/scripts — scripts in group
  router.get('/api/projects/:pid/tests/:tpid/groups/:gid/scripts', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const group = (await testingRepo().getTestGroupByTestProjectAndId(tp.id, req.params.gid)) as unknown as TestGroup | null;
    if (!group) { sendJson(res, 404, { error: 'Group not found' }); return; }
    const scripts = ((await testingRepo().listScriptsByGroup(group.id)) as unknown as TestScript[])
      .filter((x) => x.test_project_id === tp.id)
      .sort((a, b) => a.sort_order - b.sort_order);
    sendJson(res, 200, { scripts: scripts.map(scriptView) });
  });

  // POST /api/projects/:pid/tests/:tpid/groups/:gid/scripts — create script
  router.post('/api/projects/:pid/tests/:tpid/groups/:gid/scripts', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const group = (await testingRepo().getTestGroupByTestProjectAndId(tp.id, req.params.gid)) as unknown as TestGroup | null;
    if (!group) { sendJson(res, 404, { error: 'Group not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 200 }).trim();
    let steps: unknown[] = [];
    if (body.steps !== undefined) {
      try { steps = validateSteps(body.steps); }
      catch (err) { sendJson(res, 400, { error: (err as Error).message }); return; }
    }
    const groupScripts = await testingRepo().listScriptsByGroup(group.id);
    const nextOrder = groupScripts.reduce((m, x) => Math.max(m, x.sort_order), -1) + 1;
    const sortOrder = typeof body.sortOrder === 'number' ? body.sortOrder : nextOrder;

    const id = generateId();
    const ts = now();
    await testingRepo().createTestScript({
      id,
      test_project_id: tp.id,
      test_group_id: group.id,
      name,
      sort_order: sortOrder,
      steps: JSON.stringify(steps),
      created_by: req.user!.id,
      created_at: ts,
      updated_at: ts,
    });

    auditRaw(req.user!.id, 'test_script.create', `test_script:${id}`, { name, groupId: group.id });
    const script = (await testingRepo().getTestScriptById(id)) as unknown as TestScript;
    sendJson(res, 201, { script: scriptView(script) });
  });

  // GET /api/projects/:pid/tests/:tpid/scripts/:sid — get script
  router.get('/api/projects/:pid/tests/:tpid/scripts/:sid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const script = (await testingRepo().getTestScriptByTestProjectAndId(tp.id, req.params.sid)) as unknown as TestScript | null;
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }
    sendJson(res, 200, { script: scriptView(script) });
  });

  // PUT /api/projects/:pid/tests/:tpid/scripts/:sid — update script
  router.put('/api/projects/:pid/tests/:tpid/scripts/:sid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const script = (await testingRepo().getTestScriptByTestProjectAndId(tp.id, req.params.sid)) as unknown as TestScript | null;
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: now() };
    if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 200);
    if (typeof body.sortOrder === 'number') patch.sort_order = body.sortOrder;
    if (body.steps !== undefined) {
      let validated: unknown[];
      try { validated = validateSteps(body.steps); }
      catch (err) { sendJson(res, 400, { error: (err as Error).message }); return; }
      patch.steps = JSON.stringify(validated);
    }
    if (typeof body.testGroupId === 'string') {
      const newGroup = await testingRepo().getTestGroupByTestProjectAndId(tp.id, body.testGroupId);
      if (!newGroup) { sendJson(res, 400, { error: 'Group not found in this test project' }); return; }
      patch.test_group_id = body.testGroupId;
    }

    await testingRepo().updateTestScript(script.id, patch as Partial<TestScript>);

    auditRaw(req.user!.id, 'test_script.update', `test_script:${script.id}`, {});
    const updated = (await testingRepo().getTestScriptById(script.id)) as unknown as TestScript;
    sendJson(res, 200, { script: scriptView(updated) });
  });

  // DELETE /api/projects/:pid/tests/:tpid/scripts/:sid
  router.delete('/api/projects/:pid/tests/:tpid/scripts/:sid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const script = (await testingRepo().getTestScriptByTestProjectAndId(tp.id, req.params.sid)) as unknown as TestScript | null;
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }
    await testingRepo().deleteTestScript(script.id);
    auditRaw(req.user!.id, 'test_script.delete', `test_script:${script.id}`, { name: script.name });
    sendJson(res, 200, { ok: true });
  });

  // GET /api/projects/:pid/tests/:tpid/scripts/:sid/history — run history + trend
  router.get('/api/projects/:pid/tests/:tpid/scripts/:sid/history', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const script = (await testingRepo().getTestScriptByTestProjectAndId(tp.id, req.params.sid)) as unknown as TestScript | null;
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }

    const limit = Math.min(100, Math.max(1, Number(req.query.get('limit') || 20)));
    const FINISHED = new Set(['passed', 'failed', 'error', 'cancelled']);
    const runs = (await testingRepo().listRunsByTestProject(tp.id, 5000, 0))
      .filter((r) => r.script_id === script.id && FINISHED.has(r.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((r) => ({ id: r.id, status: r.status, created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at, error: r.error })) as Row[];

    // Trend: last 20 runs
    const trend = runs.slice(0, 20).map((r) => ({
      runId: r.id,
      status: r.status,
      createdAt: r.created_at,
    }));
    const passed = trend.filter((t) => t.status === 'passed').length;
    const total = trend.length;

    sendJson(res, 200, { runs, trend, passRate: total > 0 ? passed / total : null });
  });
}
