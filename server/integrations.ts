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
import type { IntegrationRecord } from './repositories/integrations.ts';
import { McpHttpClient, MCP_LIMITS, isReadOnlyTool } from './agent/runner-mcp.ts';
import { readHttpConfig } from './agent/runner-integrations.ts';
import type { HttpIntegrationConfig } from './agent/runner-integrations.ts';
import { assertNotBlocked } from './testing/ssrf.ts';

import { getMemberRow, getProjectRow } from './project-access.ts';
// ── Types ─────────────────────────────────────────────────────────────────────

const VALID_TYPES = ['http', 'stdio', 'atlassian', 'aws', 'browser', 'drawio'] as const;
type IntegrationType = (typeof VALID_TYPES)[number];

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

/** What a browser may see: never the config itself. A remote MCP server shows its URL, header names and settings. */
function safeIntegration(i: IntegrationRecord) {
  const { config_enc: _c, ...rest } = i;
  const base = { ...rest, enabled: Boolean(i.enabled) };
  if (i.type !== 'http') return base;
  const cfg = readHttpConfig(i.config_enc);
  return {
    ...base,
    url: cfg?.url ?? '',
    headerNames: Object.keys(cfg?.headers ?? {}),
    allowWrites: cfg?.allowWrites === true,
    personal: cfg?.personal === true,
    lastTest: cfg?.lastTest ?? null,
  };
}

/** Personal integrations are only visible to the person who created them. */
function visibleTo(i: IntegrationRecord, userId: string): boolean {
  if (i.type !== 'http') return true;
  const cfg = readHttpConfig(i.config_enc);
  return !cfg?.personal || i.created_by === userId;
}

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Builds the stored config of a remote MCP integration from what the form sent.
 * `headers` is a list of {name, value}; an empty value keeps the value already stored under that name (secrets are
 * write-only, so the form never has them to send back).
 */
function httpConfigFromBody(body: Record<string, unknown>, existing: HttpIntegrationConfig | null): HttpIntegrationConfig {
  const url = String(body.url ?? existing?.url ?? '').trim();
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Server URL must be a full https:// address'); }
  if (parsed.protocol !== 'https:') throw new Error('Server URL must start with https://');
  if (parsed.username || parsed.password) throw new Error('Put credentials in a secret header, not in the URL');
  if (url.length > 2000) throw new Error('Server URL is too long');

  const headers: Record<string, string> = {};
  const list = Array.isArray(body.headers) ? body.headers : [];
  if (list.length > MCP_LIMITS.headers) throw new Error(`At most ${MCP_LIMITS.headers} headers`);
  for (const h of list as Array<Record<string, unknown>>) {
    const name = String(h?.name ?? '').trim();
    if (!name) continue;
    if (!HEADER_NAME_RE.test(name)) throw new Error(`"${name}" is not a valid header name`);
    const value = String(h?.value ?? '');
    const finalValue = value === '' ? existing?.headers?.[name] : value;
    if (!finalValue) throw new Error(`Header "${name}" needs a value`);
    if (finalValue.length > MCP_LIMITS.headerValue || /[\r\n]/.test(finalValue)) throw new Error(`Header "${name}" has an invalid value`);
    headers[name] = finalValue;
  }
  return {
    url,
    headers,
    allowWrites: body.allowWrites === undefined ? existing?.allowWrites === true : body.allowWrites === true,
    personal: body.personal === undefined ? existing?.personal === true : body.personal === true,
  };
}

type TestOutcome = NonNullable<HttpIntegrationConfig['lastTest']> & { total: number; offered: number };

/** Connects to the server, lists its tools and says how many an agent would be offered. */
async function testHttpIntegration(cfg: HttpIntegrationConfig): Promise<TestOutcome> {
  const at = new Date().toISOString();
  try {
    await assertNotBlocked(cfg.url, false);
    const tools = await new McpHttpClient(cfg.url, cfg.headers ?? {}).listTools();
    const offered = cfg.allowWrites ? tools.length : tools.filter(isReadOnlyTool).length;
    const message = tools.length === 0
      ? 'Connected, but the server lists no tools.'
      : `Connected. ${offered} of ${tools.length} tools offered${cfg.allowWrites ? '' : ' (read-only)'}.`;
    return { ok: true, message, at, tools: tools.length, total: tools.length, offered };
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    const message = /abort|timeout/i.test(raw) ? 'The server did not answer in time.' : raw.replace(/https?:\/\/\S+/g, '[url]').slice(0, 200);
    return { ok: false, message: `Could not connect: ${message}`, at, tools: 0, total: 0, offered: 0 };
  }
}

function withTest(cfg: HttpIntegrationConfig, t: TestOutcome): HttpIntegrationConfig {
  return { ...cfg, lastTest: { ok: t.ok, message: t.message, at: t.at, tools: t.tools } };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerIntegrationRoutes(): void {

  // GET /api/projects/:id/integrations
  router.get('/api/projects/:id/integrations', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const items = await getIntegrationsRepository().listByProject(req.params.id);
    sendJson(res, 200, { integrations: items.filter((i) => visibleTo(i, req.user!.id)).map(safeIntegration) });
  });

  // POST /api/projects/:id/integrations
  router.post('/api/projects/:id/integrations', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const type = str(body.type, 'type', { max: 32 }).trim() as IntegrationType;

    if (!VALID_TYPES.includes(type)) {
      sendJson(res, 400, { error: `type must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }

    let configEnc: string | null = null;
    if (type === 'http') {
      // A remote MCP server: checked, then tested right away so the card shows whether it works.
      let cfg: HttpIntegrationConfig;
      try { cfg = httpConfigFromBody((body.config ?? {}) as Record<string, unknown>, null); } catch (e) {
        sendJson(res, 400, { error: (e as Error).message });
        return;
      }
      configEnc = encrypt(JSON.stringify(withTest(cfg, await testHttpIntegration(cfg))), config.secretKey);
    } else if (body.config && typeof body.config === 'object') {
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
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const existing = await getIntegrationsRepository().getByIdAndProject(req.params.iid, req.params.id);
    if (!existing) { sendJson(res, 404, { error: 'Integration not found' }); return; }

    const body = req.body as Record<string, unknown>;
    const fields: { name?: string; enabled?: number; config_enc?: string | null } = {};

    if (body.name !== undefined) fields.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.enabled !== undefined) fields.enabled = body.enabled ? 1 : 0;
    if (body.config !== undefined && typeof body.config === 'object') {
      if (existing.type === 'http') {
        try {
          const cfg = httpConfigFromBody(body.config as Record<string, unknown>, readHttpConfig(existing.config_enc));
          fields.config_enc = encrypt(JSON.stringify(withTest(cfg, await testHttpIntegration(cfg))), config.secretKey);
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }
      } else {
        fields.config_enc = encrypt(JSON.stringify(body.config), config.secretKey);
      }
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
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const deleted = await getIntegrationsRepository().delete(req.params.iid, req.params.id);
    if (!deleted) { sendJson(res, 404, { error: 'Integration not found' }); return; }

    sendJson(res, 200, { ok: true });
  });

  // POST /api/projects/:id/integrations/:iid/test
  router.post('/api/projects/:id/integrations/:iid/test', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;

    const item = await getIntegrationsRepository().getByIdAndProject(req.params.iid, req.params.id);
    if (!item) { sendJson(res, 404, { error: 'Integration not found' }); return; }

    if (item.type === 'http') {
      const cfg = readHttpConfig(item.config_enc);
      if (!cfg) { sendJson(res, 200, { ok: false, error: 'This integration has no valid settings; edit it and save again.' }); return; }
      const t = await testHttpIntegration(cfg);
      await getIntegrationsRepository().update(item.id, req.params.id, { config_enc: encrypt(JSON.stringify(withTest(cfg, t)), config.secretKey) });
      sendJson(res, 200, { ok: t.ok, note: t.ok ? t.message : undefined, error: t.ok ? undefined : t.message, tools: t.total, offered: t.offered });
      return;
    }

    sendJson(res, 200, { ok: true, note: 'Manual verification required' });
  });
}
