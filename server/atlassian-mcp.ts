/**
 * Atlassian MCP v2 for sessions that read Jira.
 *
 * A project that is connected to Jira (Tickets page) uses that connection for its Tickets tab and workflows, but a chat session
 * has no Jira tool from it. A session gets Jira through the Atlassian remote MCP server, which each person signs in to (a card in
 * the session, see mcp-oauth.ts). Two things are done when a cloud session starts (ensureAtlassianMcp):
 *
 *  1. An Atlassian integration that still points at MCP v1 (`/v1/mcp`, `/v1/mcp/authv2`, `/v1/sse`) and signs in with OAuth is
 *     moved to v2 (`https://mcp.atlassian.com/v2/mcp`). v2 is a separate OAuth resource, so what was cached for v1 (the registered
 *     client, this person's token) is dropped and everyone signs in again. Integrations that use a token header stay on v1: Atlassian
 *     documents token authentication for v1 only.
 *  2. A project that is connected to Jira but has no Atlassian MCP integration gets one (read-only, OAuth), once: deleting it
 *     afterwards sticks.
 *
 * https://support.atlassian.com/atlassian-ai-gateway/docs/how-to-upgrade-from-atlassian-mcp-v1-to-atlassian-mcp-v2/
 */

import { encrypt } from './secrets.ts';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { getSetting, setSetting } from './settings.ts';
import { generateId, now } from './util.ts';
import { getIntegrationsRepository } from './repositories/integrations.ts';
import { readHttpConfig, type HttpIntegrationConfig } from './agent/runner-integrations.ts';
import { forgetMcpClient, mcpSignOut } from './mcp-oauth.ts';
import { jiraConnected } from './jira.ts';

export const ATLASSIAN_MCP_V2 = 'https://mcp.atlassian.com/v2/mcp';

function parse(url: string): URL | null { try { return new URL(url); } catch { return null; } }

/** True for any address of Atlassian's remote MCP server. */
export function isAtlassianMcpUrl(url: string): boolean {
  return parse(url)?.hostname.toLowerCase() === 'mcp.atlassian.com';
}

/** True for the v1 addresses (`/v1/mcp`, `/v1/mcp/authv2`, `/v1/sse`) and the older `/sse`. */
export function isAtlassianV1Url(url: string): boolean {
  const u = parse(url);
  if (!u || u.hostname.toLowerCase() !== 'mcp.atlassian.com') return false;
  return /^\/(v1(\/|$)|sse\/?$)/.test(u.pathname);
}

const offeredKey = (projectId: string): string => `atlassian-mcp-offered.${projectId}`;

export interface AtlassianMcpOutcome { migrated: string[]; added: boolean }

/**
 * Moves OAuth integrations of the project from MCP v1 to v2, and offers the Atlassian integration to a project that is connected
 * to Jira and has none. `userId` is the person running the session (the new integration is theirs, and their v1 token is dropped).
 * Never throws: a failure here must not stop a session.
 */
export async function ensureAtlassianMcp(projectId: string | null, userId: string | null): Promise<AtlassianMcpOutcome> {
  const out: AtlassianMcpOutcome = { migrated: [], added: false };
  if (!projectId) return out;
  try {
    const repo = getIntegrationsRepository();
    const items = (await repo.listByProject(projectId)).filter((i) => i.type === 'http');
    let hasAtlassian = false;
    for (const it of items) {
      const cfg = readHttpConfig(it.config_enc);
      if (!cfg || !isAtlassianMcpUrl(cfg.url)) continue;
      hasAtlassian = true;
      if (!isAtlassianV1Url(cfg.url) || cfg.auth !== 'oauth') continue;
      const next: HttpIntegrationConfig = { ...cfg, url: ATLASSIAN_MCP_V2 };
      delete next.lastTest;
      await repo.update(it.id, projectId, { config_enc: encrypt(JSON.stringify(next), config.secretKey) });
      // v2 is another OAuth resource: the client registered for v1 and the tokens issued for it do not carry over.
      await forgetMcpClient(it.id);
      if (userId) await mcpSignOut(it.id, userId);
      out.migrated.push(it.name);
    }
    if (!hasAtlassian && userId && !getSetting(getDb(), offeredKey(projectId)) && await jiraConnected(projectId)) {
      const cfg: HttpIntegrationConfig = { url: ATLASSIAN_MCP_V2, auth: 'oauth', allowWrites: false };
      await repo.create({
        id: generateId(), project_id: projectId, name: 'Atlassian', type: 'http',
        config_enc: encrypt(JSON.stringify(cfg), config.secretKey), enabled: 1, created_by: userId, created_at: now(),
      });
      await setSetting(getDb(), offeredKey(projectId), '1');
      out.added = true;
    }
  } catch (err) {
    console.warn('[atlassian-mcp] could not check the Atlassian MCP integration:', err instanceof Error ? err.message : err);
  }
  return out;
}
