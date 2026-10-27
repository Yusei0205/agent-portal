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
import { one, all, run, insert } from './db.ts';
import { generateId, now, str } from './util.ts';
import { encrypt, decrypt } from './secrets.ts';
import { config } from './config.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

const VALID_TYPES = ['http', 'stdio', 'atlassian', 'aws', 'browser', 'drawio'] as const;
type IntegrationType = (typeof VALID_TYPES)[number];

interface McpIntegration {
  id: string;
  project_id: string | null;
  name: string;
  type: IntegrationType;
  config_enc: string | null;
  enabled: number;
  created_by: string | null;
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
    projectId, req.user.id,
  );
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

function safeIntegration(i: McpIntegration) {
  const { config_enc: _c, ...rest } = i;
  return { ...rest, enabled: Boolean(i.enabled) };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerIntegrationRoutes(): void {

  // GET /api/projects/:id/integrations
  router.get('/api/projects/:id/integrations', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;
    const items = all<McpIntegration>(
      'SELECT * FROM mcp_integrations WHERE project_id = ? ORDER BY created_at',
      req.params.id,
    );
    sendJson(res, 200, { integrations: items.map(safeIntegration) });
  });

  // POST /api/projects/:id/integrations
  router.post('/api/projects/:id/integrations', (req: PortalRequest, res: PortalResponse): void => {
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

    const id = generateId();
    const ts = now();

    insert('mcp_integrations', {
      id,
      project_id: req.params.id,
      name,
      type,
      config_enc: configEnc,
      enabled: 1,
      created_by: req.user!.id,
      created_at: ts,
    });

    const item = one<McpIntegration>('SELECT * FROM mcp_integrations WHERE id = ?', id);
    sendJson(res, 201, { integration: item ? safeIntegration(item) : null });
  });

  // PUT /api/projects/:id/integrations/:iid
  router.put('/api/projects/:id/integrations/:iid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const item = one<McpIntegration>(
      'SELECT * FROM mcp_integrations WHERE id = ? AND project_id = ?',
      req.params.iid, req.params.id,
    );
    if (!item) { sendJson(res, 404, { error: 'Integration not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const patch: Record<string, string | number | null> = {};

    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
    if (body.config !== undefined && typeof body.config === 'object') {
      patch.config_enc = encrypt(JSON.stringify(body.config), config.secretKey);
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const keys = Object.keys(patch);
    run(
      `UPDATE mcp_integrations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k]),
      item.id,
    );

    const updated = one<McpIntegration>('SELECT * FROM mcp_integrations WHERE id = ?', item.id);
    sendJson(res, 200, { integration: updated ? safeIntegration(updated) : null });
  });

  // DELETE /api/projects/:id/integrations/:iid
  router.delete('/api/projects/:id/integrations/:iid', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const result = run(
      'DELETE FROM mcp_integrations WHERE id = ? AND project_id = ?',
      req.params.iid, req.params.id,
    );
    if (result.changes === 0) { sendJson(res, 404, { error: 'Integration not found' }); return; }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/integrations/:iid/test
  router.post('/api/projects/:id/integrations/:iid/test', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!requireProjectAccess(req, res, req.params.id)) return;

    const item = one<McpIntegration>(
      'SELECT * FROM mcp_integrations WHERE id = ? AND project_id = ?',
      req.params.iid, req.params.id,
    );
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
