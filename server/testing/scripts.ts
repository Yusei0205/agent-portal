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
  router.get('/api/projects/:pid/tests/:tpid/groups', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const groups = all<TestGroup>(
      'SELECT * FROM test_groups WHERE test_project_id = ? ORDER BY sort_order, name',
      tp.id,
    );
    sendJson(res, 200, { groups: groups.map(groupView) });
  });

  // POST /api/projects/:pid/tests/:tpid/groups
  router.post('/api/projects/:pid/tests/:tpid/groups', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 200 }).trim();
    const maxOrder = one<{ n: number }>(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM test_groups WHERE test_project_id = ?',
      tp.id,
    );
    const sortOrder = typeof body.sortOrder === 'number' ? body.sortOrder : (maxOrder?.n ?? 0);

    const id = generateId();
    const ts = now();
    insert('test_groups', { id, test_project_id: tp.id, name, sort_order: sortOrder, created_at: ts, updated_at: ts });

    const group = one<TestGroup>('SELECT * FROM test_groups WHERE id = ?', id)!;
    sendJson(res, 201, { group: groupView(group) });
  });

  // PUT /api/projects/:pid/tests/:tpid/groups/:gid
  router.put('/api/projects/:pid/tests/:tpid/groups/:gid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const group = one<TestGroup>('SELECT * FROM test_groups WHERE id = ? AND test_project_id = ?', req.params.gid, tp.id);
    if (!group) { sendJson(res, 404, { error: 'Group not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: now() };
    if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 200);
    if (typeof body.sortOrder === 'number') patch.sort_order = body.sortOrder;

    const keys = Object.keys(patch);
    run(`UPDATE test_groups SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k] as string), group.id);

    const updated = one<TestGroup>('SELECT * FROM test_groups WHERE id = ?', group.id)!;
    sendJson(res, 200, { group: groupView(updated) });
  });

  // DELETE /api/projects/:pid/tests/:tpid/groups/:gid
  router.delete('/api/projects/:pid/tests/:tpid/groups/:gid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const group = one<TestGroup>('SELECT * FROM test_groups WHERE id = ? AND test_project_id = ?', req.params.gid, tp.id);
    if (!group) { sendJson(res, 404, { error: 'Group not found' }); return; }
    run('DELETE FROM test_groups WHERE id = ?', group.id);
    sendJson(res, 200, { ok: true });
  });

  // ── Scripts ───────────────────────────────────────────────────────────────────

  // GET /api/projects/:pid/tests/:tpid/scripts — all scripts
  router.get('/api/projects/:pid/tests/:tpid/scripts', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const scripts = all<TestScript>(
      'SELECT * FROM test_scripts WHERE test_project_id = ? ORDER BY test_group_id, sort_order',
      tp.id,
    );
    sendJson(res, 200, { scripts: scripts.map(scriptView) });
  });

  // GET /api/projects/:pid/tests/:tpid/groups/:gid/scripts — scripts in group
  router.get('/api/projects/:pid/tests/:tpid/groups/:gid/scripts', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const group = one<TestGroup>('SELECT id FROM test_groups WHERE id = ? AND test_project_id = ?', req.params.gid, tp.id);
    if (!group) { sendJson(res, 404, { error: 'Group not found' }); return; }
    const scripts = all<TestScript>(
      'SELECT * FROM test_scripts WHERE test_group_id = ? AND test_project_id = ? ORDER BY sort_order',
      group.id, tp.id,
    );
    sendJson(res, 200, { scripts: scripts.map(scriptView) });
  });

  // POST /api/projects/:pid/tests/:tpid/groups/:gid/scripts — create script
  router.post('/api/projects/:pid/tests/:tpid/groups/:gid/scripts', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const group = one<TestGroup>('SELECT id FROM test_groups WHERE id = ? AND test_project_id = ?', req.params.gid, tp.id);
    if (!group) { sendJson(res, 404, { error: 'Group not found' }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 200 }).trim();
    let steps: unknown[] = [];
    if (body.steps !== undefined) {
      try { steps = validateSteps(body.steps); }
      catch (err) { sendJson(res, 400, { error: (err as Error).message }); return; }
    }
    const maxOrder = one<{ n: number }>(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM test_scripts WHERE test_group_id = ?',
      group.id,
    );
    const sortOrder = typeof body.sortOrder === 'number' ? body.sortOrder : (maxOrder?.n ?? 0);

    const id = generateId();
    const ts = now();
    insert('test_scripts', {
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
    const script = one<TestScript>('SELECT * FROM test_scripts WHERE id = ?', id)!;
    sendJson(res, 201, { script: scriptView(script) });
  });

  // GET /api/projects/:pid/tests/:tpid/scripts/:sid — get script
  router.get('/api/projects/:pid/tests/:tpid/scripts/:sid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const script = one<TestScript>('SELECT * FROM test_scripts WHERE id = ? AND test_project_id = ?', req.params.sid, tp.id);
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }
    sendJson(res, 200, { script: scriptView(script) });
  });

  // PUT /api/projects/:pid/tests/:tpid/scripts/:sid — update script
  router.put('/api/projects/:pid/tests/:tpid/scripts/:sid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const script = one<TestScript>('SELECT * FROM test_scripts WHERE id = ? AND test_project_id = ?', req.params.sid, tp.id);
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
      const newGroup = one<Row>('SELECT id FROM test_groups WHERE id = ? AND test_project_id = ?', body.testGroupId, tp.id);
      if (!newGroup) { sendJson(res, 400, { error: 'Group not found in this test project' }); return; }
      patch.test_group_id = body.testGroupId;
    }

    const keys = Object.keys(patch);
    run(`UPDATE test_scripts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k] as string), script.id);

    auditRaw(req.user!.id, 'test_script.update', `test_script:${script.id}`, {});
    const updated = one<TestScript>('SELECT * FROM test_scripts WHERE id = ?', script.id)!;
    sendJson(res, 200, { script: scriptView(updated) });
  });

  // DELETE /api/projects/:pid/tests/:tpid/scripts/:sid
  router.delete('/api/projects/:pid/tests/:tpid/scripts/:sid', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;
    const script = one<TestScript>('SELECT * FROM test_scripts WHERE id = ? AND test_project_id = ?', req.params.sid, tp.id);
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }
    run('DELETE FROM test_scripts WHERE id = ?', script.id);
    auditRaw(req.user!.id, 'test_script.delete', `test_script:${script.id}`, { name: script.name });
    sendJson(res, 200, { ok: true });
  });

  // GET /api/projects/:pid/tests/:tpid/scripts/:sid/history — run history + trend
  router.get('/api/projects/:pid/tests/:tpid/scripts/:sid/history', (req: PortalRequest, res: PortalResponse): void => {
    if (!hasScope(req, 'read')) { sendJson(res, 403, { error: 'read scope required' }); return; }
    const tp = requireTestProject(req, res, req.params.pid, req.params.tpid);
    if (!tp) return;
    const script = one<TestScript>('SELECT id FROM test_scripts WHERE id = ? AND test_project_id = ?', req.params.sid, tp.id);
    if (!script) { sendJson(res, 404, { error: 'Script not found' }); return; }

    const limit = Math.min(100, Math.max(1, Number(req.query.get('limit') || 20)));
    const runs = all<Row>(
      `SELECT id, status, created_at, started_at, finished_at, error
       FROM test_runs
       WHERE script_id = ? AND status IN ('passed','failed','error','cancelled')
       ORDER BY created_at DESC LIMIT ?`,
      script.id, limit,
    );

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
