/**
 * Which MCP integrations a run gets, and in what form the runner receives them.
 *
 * Integrations are stored per project (server/integrations.ts) with an encrypted config. A run gets every enabled
 * remote (HTTP) integration of its project, plus the personal ones that belong to the person running it. The secret
 * headers are decrypted here, only when a run starts, and travel to the runner in the invoke payload (TLS); the
 * runner keeps them in a proxy process's environment (see runner-mcp.ts).
 */

import { decrypt } from '../secrets.ts';
import { config } from '../config.ts';
import { getIntegrationsRepository } from '../repositories/integrations.ts';
import { parseMcpServers, type McpServerSpec } from './runner-mcp.ts';
import { workspaceMcpSpec } from '../google-workspace.ts';
import { gmailMcpSpec } from '../gmail.ts';
import { mcpAccessToken } from '../mcp-oauth.ts';

/** What is stored (encrypted) for a remote MCP integration. */
export interface HttpIntegrationConfig {
  url: string;
  /** 'oauth' = the person signs in (server/mcp-oauth.ts); the run gets a short-lived bearer token. Default 'headers'. */
  auth?: 'headers' | 'oauth';
  /** Secret headers, e.g. Authorization. Never sent back to a browser. */
  headers?: Record<string, string>;
  allowWrites?: boolean;
  /** Only the person who created it may use it. */
  personal?: boolean;
  /** Result of the last test. */
  lastTest?: { ok: boolean; message: string; at: string; tools: number };
}

export function integrationIsPersonal(i: { config_enc: string | null }): boolean {
  return readHttpConfig(i.config_enc)?.personal === true;
}

export function readHttpConfig(configEnc: string | null): HttpIntegrationConfig | null {
  if (!configEnc) return null;
  try {
    const c = JSON.parse(decrypt(configEnc, config.secretKey)) as HttpIntegrationConfig;
    return c && typeof c.url === 'string' ? c : null;
  } catch {
    return null;
  }
}

/** Tool-name prefix for an integration: lower case, letters/digits/dash, starts with a letter. */
export function serverName(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (!/^[a-z]/.test(base)) base = `mcp-${base}`.replace(/-+$/, '');
  let out = base || 'mcp';
  for (let i = 2; taken.has(out); i++) out = `${base}-${i}`.slice(0, 32);
  taken.add(out);
  return out;
}

/**
 * What a session stored for its integrations: null = the project's enabled ones (the default),
 * a list = only those (an empty list = none).
 */
export function parseSessionIntegrations(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.trim() === '[]') return null;
  try {
    const v = JSON.parse(raw) as { ids?: unknown };
    if (v && Array.isArray(v.ids)) return v.ids.map(String).slice(0, 20);
  } catch { /* fall through */ }
  return null;
}

export function encodeSessionIntegrations(ids: string[] | null): string {
  return ids === null ? '[]' : JSON.stringify({ ids });
}

/** The OAuth integrations a run would use that this person has not signed in to yet. */
export async function pendingMcpSignIns(
  projectId: string | null,
  userId: string | null,
  selected: string[] | null = null,
): Promise<Array<{ id: string; name: string }>> {
  if (!projectId || !userId) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const it of await getIntegrationsRepository().listByProject(projectId)) {
    if (it.enabled !== 1 || it.type !== 'http') continue;
    if (selected && !selected.includes(it.id)) continue;
    const cfg = readHttpConfig(it.config_enc);
    if (!cfg || cfg.auth !== 'oauth') continue;
    if (cfg.personal && it.created_by !== userId) continue;
    if (!(await mcpAccessToken(it.id, userId).catch(() => null))) out.push({ id: it.id, name: it.name });
  }
  return out;
}

export async function buildRunnerMcpServers(
  projectId: string | null,
  userId: string | null,
  /** The session's own selection (null = the project's enabled ones). */
  selected: string[] | null = null,
): Promise<McpServerSpec[]> {
  if (!projectId) return [];
  const items = await getIntegrationsRepository().listByProject(projectId);
  const taken = new Set<string>(['browser']);
  const specs: unknown[] = [];
  for (const it of items) {
    if (it.enabled !== 1 || it.type !== 'http') continue;
    if (selected && !selected.includes(it.id)) continue;
    const cfg = readHttpConfig(it.config_enc);
    if (!cfg) continue;
    if (cfg.personal && it.created_by !== userId) continue;
    const name = serverName(it.name, taken);
    let headers = cfg.headers ?? {};
    if (cfg.auth === 'oauth') {
      // Signed-in people get a fresh short-lived token; anyone else runs without this server.
      const token = userId ? await mcpAccessToken(it.id, userId).catch(() => null) : null;
      if (!token) continue;
      headers = { ...headers, Authorization: `Bearer ${token}` };
    }
    specs.push({ name, url: cfg.url, headers, allowWrites: cfg.allowWrites === true });
  }
  // The person's own Google Drive, Docs, Sheets and Slides, when they have connected Google. The runner only gets a
  // short-lived token for this portal, never a Google credential.
  if (!selected) {
    const g = await workspaceMcpSpec(userId, process.env.PORTAL_PUBLIC_URL).catch(() => null);
    if (g && !taken.has(g.name)) specs.push(g);
    // The person's own Gmail, the same way.
    const m = await gmailMcpSpec(userId, process.env.PORTAL_PUBLIC_URL).catch(() => null);
    if (m && !taken.has(m.name)) specs.push(m);
  }
  return parseMcpServers(specs);
}
