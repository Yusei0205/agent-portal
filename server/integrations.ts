/**
 * MCP Integrations API routes — per-project integration store.
 *
 * Routes:
 *   GET    /api/projects/:id/integrations            — list
 *   POST   /api/projects/:id/integrations            — create
 *   PUT    /api/projects/:id/integrations/:iid       — update
 *   DELETE /api/projects/:id/integrations/:iid       — delete
 *   POST   /api/projects/:id/integrations/:iid/test  — test connection
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one } from './db.ts';
import { generateId, now, str } from './util.ts';
import { encrypt, decrypt } from './secrets.ts';
import { config } from './config.ts';
import { getIntegrationsRepository } from './repositories/integrations.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

const VALID_TYPES = ['http', 'stdio', 'atlassian', 'aws', 'browser', 'drawio'] as const;
type IntegrationType = (typeof VALID_TYPES)[number];

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = one<{ id: string }>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = one<{ user_id: string }>(
    'SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId, req.user.id,
  );
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

function safeIntegration(i: { config_enc?: string | null; enabled: number; [k: string]: unknown }) {
  const { config_enc: _c, ...rest } = i;
  return { ...rest, enabled: Boolean(i.enabled) };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerIntegrationRoutes(): void {

  // GET /api/projects/:id/integrations
  router.get('/api/projects/:id/integrations', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;
    const items = await getIntegrationsRepository().listByProject(req.params.id);
    sendJson(res, 200, { integrations: items.map(safeIntegration) });
  });

  // POST /api/projects/:id/integrations
  router.post('/api/projects/:id/integrations', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const type = str(body.type, 'type', { max: 32 }).trim() as IntegrationType;

    if (!VALID_TYPES.includes(type)) {
      sendJson(res, 400, { error: `type must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }

    let configEnc: string | null = null;
    if (body.config && typeof body.config === 'object') {
      configEnc = encrypt(JSON.stringify(body.config), config.secretKey);
    }

    const item = await getIntegrationsRepository().create({
      id: generateId(),
      project_id: req.params.id,
      name,
      type,
      config_enc: configEnc,
      enabled: 1,
      created_by: req.user!.id,
      created_at: now(),
    });

    sendJson(res, 201, { integration: safeIntegration(item) });
  });

  // PUT /api/projects/:id/integrations/:iid
  router.put('/api/projects/:id/integrations/:iid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const existing = await getIntegrationsRepository().getByIdAndProject(req.params.iid, req.params.id);
    if (!existing) { sendJson(res, 404, { error: 'Integration not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const fields: { name?: string; enabled?: number; config_enc?: string | null } = {};

    if (body.name !== undefined) fields.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.enabled !== undefined) fields.enabled = body.enabled ? 1 : 0;
    if (body.config !== undefined && typeof body.config === 'object') {
      fields.config_enc = encrypt(JSON.stringify(body.config), config.secretKey);
    }

    if (Object.keys(fields).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const updated = await getIntegrationsRepository().update(req.params.iid, req.params.id, fields);
    sendJson(res, 200, { integration: updated ? safeIntegration(updated) : null });
  });

  // DELETE /api/projects/:id/integrations/:iid
  router.delete('/api/projects/:id/integrations/:iid', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const deleted = await getIntegrationsRepository().delete(req.params.iid, req.params.id);
    if (!deleted) { sendJson(res, 404, { error: 'Integration not found' }); return; }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/integrations/:iid/test
  router.post('/api/projects/:id/integrations/:iid/test', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const item = await getIntegrationsRepository().getByIdAndProject(req.params.iid, req.params.id);
    if (!item) { sendJson(res, 404, { error: 'Integration not found' }); return; }

    // For HTTP type: try to GET the config URL + /health
    if (item.type === 'http' && item.config_enc) {
      try {
        const plain = decrypt(item.config_enc, config.secretKey);
        const cfg = JSON.parse(plain) as Record<string, string>;
        const url = cfg.url ? `${cfg.url.replace(/\/$/, '')}/health` : null;

        if (url) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const resp = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            sendJson(res, 200, { ok: resp.ok, status: resp.status });
          } catch (fetchErr: unknown) {
            clearTimeout(timeout);
            const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            sendJson(res, 200, { ok: false, error: msg });
          }
          return;
        }
      } catch {
        // fall through to manual note
      }
    }

    sendJson(res, 200, { ok: true, note: 'Manual verification required' });
  });
}
