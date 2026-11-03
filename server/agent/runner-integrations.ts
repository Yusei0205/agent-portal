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

/** What is stored (encrypted) for a remote MCP integration. */
export interface HttpIntegrationConfig {
  url: string;
  /** Secret headers, e.g. Authorization. Never sent back to a browser. */
  headers?: Record<string, string>;
  allowWrites?: boolean;
  /** Only the person who created it may use it. */
  personal?: boolean;
  /** Result of the last test. */
  lastTest?: { ok: boolean; message: string; at: string; tools: number };
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

export async function buildRunnerMcpServers(projectId: string | null, userId: string | null): Promise<McpServerSpec[]> {
  if (!projectId) return [];
  const items = await getIntegrationsRepository().listByProject(projectId);
  const taken = new Set<string>(['browser']);
  const specs: unknown[] = [];
  for (const it of items) {
    if (it.enabled !== 1 || it.type !== 'http') continue;
    const cfg = readHttpConfig(it.config_enc);
    if (!cfg) continue;
    if (cfg.personal && it.created_by !== userId) continue;
    specs.push({ name: serverName(it.name, taken), url: cfg.url, headers: cfg.headers ?? {}, allowWrites: cfg.allowWrites === true });
  }
  return parseMcpServers(specs);
}
