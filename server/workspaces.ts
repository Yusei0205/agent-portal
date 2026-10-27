/**
 * Workspaces API routes.
 *
 * Routes:
 *   GET    /api/projects/:id/workspaces       — list workspaces for a project
 *   POST   /api/projects/:id/workspaces       — create workspace
 *   PUT    /api/projects/:id/workspaces/:wid  — update workspace
 *   DELETE /api/projects/:id/workspaces/:wid  — delete workspace
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert } from './db.ts';
import { generateId, now, str, parseJson } from './util.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  project_id: string;
  name: string;
  repo_ids: string; // JSON array stored as TEXT
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = one<{ id: string }>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string }>(
    'SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    req.user.id,
  );
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

function parseWorkspace(w: Workspace) {
  return { ...w, repo_ids: parseJson<string[]>(w.repo_ids, []) };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerWorkspaceRoutes(): void {

  // GET /api/projects/:id/workspaces
  router.get('/api/projects/:id/workspaces', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;
    const workspaces = all<Workspace>(
      'SELECT * FROM workspaces_v2 WHERE project_id = ? ORDER BY created_at',
      req.params.id,
    );
    sendJson(res, 200, { workspaces: workspaces.map(parseWorkspace) });
  });

  // POST /api/projects/:id/workspaces
  router.post('/api/projects/:id/workspaces', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const repoIds: string[] = Array.isArray(body.repoIds) ? (body.repoIds as string[]) : [];

    const id = generateId();
    const ts = now();

    insert('workspaces_v2', {
      id,
      project_id: req.params.id,
      name,
      repo_ids: JSON.stringify(repoIds),
      created_at: ts,
    });

    const workspace = one<Workspace>('SELECT * FROM workspaces_v2 WHERE id = ?', id);
    sendJson(res, 201, { workspace: workspace ? parseWorkspace(workspace) : null });
  });

  // PUT /api/projects/:id/workspaces/:wid
  router.put('/api/projects/:id/workspaces/:wid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const ws = one<Workspace>(
      'SELECT * FROM workspaces_v2 WHERE id = ? AND project_id = ?',
      req.params.wid,
      req.params.id,
    );
    if (!ws) { sendJson(res, 404, { error: 'Workspace not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const patch: Record<string, string> = {};
    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.repoIds !== undefined) {
      const ids = Array.isArray(body.repoIds) ? (body.repoIds as string[]) : [];
      patch.repo_ids = JSON.stringify(ids);
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const keys = Object.keys(patch);
    run(
      `UPDATE workspaces_v2 SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k]),
      ws.id,
    );

    const updated = one<Workspace>('SELECT * FROM workspaces_v2 WHERE id = ?', ws.id);
    sendJson(res, 200, { workspace: updated ? parseWorkspace(updated) : null });
  });

  // DELETE /api/projects/:id/workspaces/:wid
  router.delete('/api/projects/:id/workspaces/:wid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const result = run(
      'DELETE FROM workspaces_v2 WHERE id = ? AND project_id = ?',
      req.params.wid,
      req.params.id,
    );
    if (result.changes === 0) { sendJson(res, 404, { error: 'Workspace not found' }); return; }

    sendJson(res, 200, { ok: true });
  });
}
