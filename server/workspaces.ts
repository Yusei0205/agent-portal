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
import { one } from './db.ts';
import { generateId, now, str, parseJson } from './util.ts';
import { getWorkspacesRepository } from './repositories/workspaces.ts';
import type { WorkspaceRecord } from './repositories/workspaces.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
// ── Types ─────────────────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  project_id: string;
  name: string;
  repo_ids: string; // JSON array stored as TEXT
  created_at: string;
  default_engine: string;
  default_agent: string;
  default_model: string;
}

// ── Validation constants ───────────────────────────────────────────────────────

const VALID_ENGINES = ['claude-code', 'kiro', 'codex', 'demo'] as const;
const MODEL_RE = /^[A-Za-z0-9._:/@-]{0,200}$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = await getProjectRow(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

function parseWorkspace(w: WorkspaceRecord) {
  return { ...w, repo_ids: parseJson<string[]>(w.repo_ids, []) };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerWorkspaceRoutes(): void {

  // GET /api/projects/:id/workspaces
  router.get('/api/projects/:id/workspaces', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const workspaces = await getWorkspacesRepository().listByProject(req.params.id);
    sendJson(res, 200, { workspaces: workspaces.map(parseWorkspace) });
  });

  // POST /api/projects/:id/workspaces
  router.post('/api/projects/:id/workspaces', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const repoIds: string[] = Array.isArray(body.repoIds) ? (body.repoIds as string[]) : [];

    const rawDefaultEngine = body.defaultEngine !== undefined
      ? str(body.defaultEngine, 'defaultEngine', { max: 30, optional: true }).trim()
      : '';
    if (rawDefaultEngine && !(VALID_ENGINES as readonly string[]).includes(rawDefaultEngine)) {
      sendJson(res, 400, { error: `defaultEngine must be '' or one of: ${VALID_ENGINES.join(', ')}` });
      return;
    }
    const defaultEngine: string = rawDefaultEngine;

    const defaultAgent: string = body.defaultAgent !== undefined
      ? str(body.defaultAgent, 'defaultAgent', { max: 200, optional: true }).trim()
      : '';

    const rawDefaultModel = body.defaultModel !== undefined
      ? str(body.defaultModel, 'defaultModel', { max: 200, optional: true }).trim()
      : '';
    if (rawDefaultModel && !MODEL_RE.test(rawDefaultModel)) {
      sendJson(res, 400, { error: 'defaultModel is not a valid model ID (allowed: A-Z a-z 0-9 . _ : / @ -)' });
      return;
    }
    const defaultModel: string = rawDefaultModel;

    const id = generateId();
    const ts = now();

    const workspace = await getWorkspacesRepository().create({
      id, project_id: req.params.id, name, repo_ids: JSON.stringify(repoIds),
      default_engine: defaultEngine, default_agent: defaultAgent, default_model: defaultModel,
      created_at: ts,
    });

    sendJson(res, 201, { workspace: parseWorkspace(workspace) });
  });

  // PUT /api/projects/:id/workspaces/:wid
  router.put('/api/projects/:id/workspaces/:wid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const existing = await getWorkspacesRepository().getByIdForProject(req.params.wid, req.params.id);
    if (!existing) { sendJson(res, 404, { error: 'Workspace not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const patch: Partial<WorkspaceRecord> = {};
    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.repoIds !== undefined) {
      const ids = Array.isArray(body.repoIds) ? (body.repoIds as string[]) : [];
      patch.repo_ids = JSON.stringify(ids);
    }

    if (body.defaultEngine !== undefined) {
      const rawDE = str(body.defaultEngine, 'defaultEngine', { max: 30, optional: true }).trim();
      if (rawDE && !(VALID_ENGINES as readonly string[]).includes(rawDE)) {
        sendJson(res, 400, { error: `defaultEngine must be '' or one of: ${VALID_ENGINES.join(', ')}` });
        return;
      }
      patch.default_engine = rawDE;
    }

    if (body.defaultAgent !== undefined) {
      patch.default_agent = str(body.defaultAgent, 'defaultAgent', { max: 200, optional: true }).trim();
    }

    if (body.defaultModel !== undefined) {
      const rawDM = str(body.defaultModel, 'defaultModel', { max: 200, optional: true }).trim();
      if (rawDM && !MODEL_RE.test(rawDM)) {
        sendJson(res, 400, { error: 'defaultModel is not a valid model ID (allowed: A-Z a-z 0-9 . _ : / @ -)' });
        return;
      }
      patch.default_model = rawDM;
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const updated = await getWorkspacesRepository().update(req.params.wid, req.params.id, patch);
    sendJson(res, 200, { workspace: updated ? parseWorkspace(updated) : null });
  });

  // DELETE /api/projects/:id/workspaces/:wid
  router.delete('/api/projects/:id/workspaces/:wid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const deleted = await getWorkspacesRepository().delete(req.params.wid, req.params.id);
    if (!deleted) { sendJson(res, 404, { error: 'Workspace not found' }); return; }

    sendJson(res, 200, { ok: true });
  });
}
