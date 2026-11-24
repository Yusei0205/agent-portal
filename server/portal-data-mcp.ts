/**
 * The portal's own data for agents: project Knowledge and the Vault, read-only, as an MCP server (docs/superpowers/specs/
 * 2026-11-24-portal-tools-for-agents-design.md).
 *
 * A session's agent gets this server like any integration (runner-integrations.ts adds it to every cloud run), and it calls
 * back to the portal over HTTPS with a short-lived signed token naming the person and the project. Every call checks again
 * that the person may see the project, and only lists Vault files the person can already see in the Files panel (their own
 * personal files, the project's files and the portal-wide ones). Nothing here writes.
 *
 *   POST /api/mcp/portal-data   MCP endpoint used by sessions (Bearer pd_<token>)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { config } from './config.ts';
import { restoreFile } from './durable-files.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getKnowledgeRepository } from './repositories/knowledge.ts';
import { getVaultFilesRepository, type VaultFileRecord } from './repositories/vault-files.ts';
import { getAuthRepository } from './repositories/auth.ts';
import { retrieve } from './knowledge-search.ts';
import { convertToMarkdown } from './convert.ts';

export const PORTAL_DATA_SERVER = 'portal-data';
const TOKEN_TTL_SECONDS = 12 * 3600; // longer than the longest cloud turn
const MAX_TEXT = 120_000;

// ── Run tokens ────────────────────────────────────────────────────────────────

function sign(payload: string): string {
  return createHmac('sha256', config.secretKey).update(`portal-data:${payload}`).digest('base64url');
}

/** A token for one person in one project, valid for 12 hours. */
export function issuePortalDataToken(userId: string, projectId: string, now = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, p: projectId, e: now + TOKEN_TTL_SECONDS })).toString('base64url');
  return `pd_${payload}.${sign(payload)}`;
}

export function verifyPortalDataToken(token: string, now = Math.floor(Date.now() / 1000)): { userId: string; projectId: string } | null {
  if (!token.startsWith('pd_')) return null;
  const [payload, mac] = token.slice(3).split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: string; p?: string; e?: number };
    if (!p.u || !p.p || !p.e || p.e < now) return null;
    return { userId: p.u, projectId: p.p };
  } catch { return null; }
}

/** The MCP server entry for a run, or null without a project or an https address the runner can reach. */
export function portalDataMcpSpec(userId: string | null, projectId: string | null, publicUrl: string | undefined):
  { name: string; url: string; headers: Record<string, string>; allowWrites: boolean } | null {
  if (!userId || !projectId || !publicUrl || !/^https:\/\//i.test(publicUrl)) return null;
  return {
    name: PORTAL_DATA_SERVER,
    url: `${publicUrl.replace(/\/+$/, '')}/api/mcp/portal-data`,
    headers: { Authorization: `Bearer ${issuePortalDataToken(userId, projectId)}` },
    allowWrites: false,
  };
}

// ── Access ────────────────────────────────────────────────────────────────────

/** The project, when the person may see it now (a member, or a portal admin); else null. */
async function visibleProject(userId: string, projectId: string): Promise<{ id: string; slug: string } | null> {
  const projects = getProjectRepository();
  const project = await projects.getProjectById(projectId);
  if (!project || project.archived) return null;
  const user = await getAuthRepository().getUserById(userId).catch(() => null);
  if (!user || (user as { disabled?: number | boolean }).disabled) return null;
  if (!(user as { is_admin?: number | boolean }).is_admin && !(await projects.isMember(projectId, userId))) return null;
  return { id: String(project.id), slug: String(project.slug) };
}

/** The Vault files the person can see in this project: "mine" (personal) or "team" (project and portal-wide). */
async function visibleVault(userId: string, projectId: string, scope: 'mine' | 'team'): Promise<VaultFileRecord[]> {
  const repo = getVaultFilesRepository();
  if (scope === 'mine') return repo.listByProject(projectId, userId, 'personal');
  return [...(await repo.listByProject(projectId, userId, 'project')), ...(await repo.listByProject(projectId, userId, 'portal'))];
}

const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|java|go|rb|rs|sql|sh|ini|toml|env\.example|log)$/i;
const CONVERTIBLE = /\.(pdf|docx|xlsx|pptx)$/i;

/** A Vault file's text: plain text as is, Office and PDF converted to Markdown; null for files that are not text (images, archives). */
async function vaultFileText(vf: VaultFileRecord): Promise<string | null> {
  const abs = path.join(config.dataDir, vf.path);
  if (!(await restoreFile(abs))) throw new Error('The file is not available right now.');
  if (TEXT_EXT.test(vf.name) || /^text\//.test(vf.mime_type ?? '') || vf.mime_type === 'application/json') return fs.readFileSync(abs, 'utf8');
  if (CONVERTIBLE.test(vf.name)) return convertToMarkdown(abs, vf.mime_type ?? '');
  return null;
}

const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[… cut: the file has ${text.length} characters]` : text);

// ── The MCP server ────────────────────────────────────────────────────────────

export function createPortalDataMcpServer(userId: string, projectId: string): McpServer {
  const server = new McpServer({ name: 'portal-data', version: '1.0.0' });
  const ok = (text: string) => ({ content: [{ type: 'text' as const, text: clip(text) }] });
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true as const });
  const ro = { readOnlyHint: true, destructiveHint: false };
  const noAccess = 'You no longer have access to this project.';

  server.registerTool('search_knowledge', {
    description: "Search the project's Knowledge (the documents uploaded or built from the code under Knowledge) and return the best-matching passages with their document and section. Use it before answering from memory when a question is about this project.",
    inputSchema: { query: z.string().min(2).max(500), limit: z.number().int().min(1).max(10).optional() },
    annotations: ro,
  }, async ({ query, limit }) => {
    const project = await visibleProject(userId, projectId);
    if (!project) return fail(noAccess);
    try {
      const r = await retrieve(project, query, limit ?? 5);
      if (!r.passages.length) return ok('No passages in this project\'s Knowledge match that. Try other words, or list_knowledge to see the documents.');
      return ok(r.passages.map((p, i) => `[${i + 1}] ${p.docName} › ${p.heading}\n${p.text}`).join('\n\n---\n\n'));
    } catch (e) { return fail(`Knowledge search failed: ${e instanceof Error ? e.message : String(e)}`); }
  });

  server.registerTool('list_knowledge', {
    description: "List the documents in the project's Knowledge: name, type and whether it is ready to search.",
    inputSchema: {},
    annotations: ro,
  }, async () => {
    const project = await visibleProject(userId, projectId);
    if (!project) return fail(noAccess);
    const docs = await getKnowledgeRepository().listDocs(project.id);
    if (!docs.length) return ok('This project has no Knowledge documents yet.');
    return ok(docs.map((d) => `- ${d.original_name || d.name} (${d.mime_type ?? 'unknown type'}, ${d.status})`).join('\n'));
  });

  server.registerTool('list_vault', {
    description: 'List files in the portal Vault. scope "team" (default): the project\'s shared files and the portal-wide ones; "mine": the person\'s own files. Returns each file\'s id, name, folder and size.',
    inputSchema: { scope: z.enum(['team', 'mine']).optional() },
    annotations: ro,
  }, async ({ scope }) => {
    if (!(await visibleProject(userId, projectId))) return fail(noAccess);
    const files = await visibleVault(userId, projectId, scope ?? 'team');
    if (!files.length) return ok(`The ${scope === 'mine' ? 'personal' : 'team'} Vault has no files.`);
    return ok(files.map((f) => `- id ${f.id}: ${f.folder ? `${f.folder}/` : ''}${f.name} (${f.size_bytes ?? '?'} bytes)`).join('\n'));
  });

  server.registerTool('read_vault_file', {
    description: 'Read a Vault file by its id (from list_vault): text files as they are, Word, Excel, PowerPoint and PDF as Markdown. Images and archives cannot be read as text.',
    inputSchema: { fileId: z.string().min(1).max(200) },
    annotations: ro,
  }, async ({ fileId }) => {
    if (!(await visibleProject(userId, projectId))) return fail(noAccess);
    const vf = [...(await visibleVault(userId, projectId, 'mine')), ...(await visibleVault(userId, projectId, 'team'))].find((f) => f.id === fileId);
    if (!vf) return fail('No Vault file with that id is visible to you here. Use list_vault to see the files.');
    try {
      const text = await vaultFileText(vf);
      if (text === null) return fail(`"${vf.name}" is not a text document (images and archives cannot be read here). Ask the person to attach it to the chat instead.`);
      return ok(`# ${vf.name}\n\n${text}`);
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  });

  return server;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function registerPortalDataMcpRoutes(): void {
  router.rawPost('/api/mcp/portal-data', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const auth = String((req.headers as Record<string, unknown>).authorization ?? '');
    const who = auth.startsWith('Bearer pd_') ? verifyPortalDataToken(auth.slice(7)) : null;
    if (!who) { sendJson(res, 401, { error: 'Invalid or expired token' }); return; }
    const server = createPortalDataMcpServer(who.userId, who.projectId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: `MCP transport error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      await transport.close().catch(() => {});
    }
  });
  router.rawGet('/api/mcp/portal-data', (_req: PortalRequest, res: PortalResponse): void => {
    sendJson(res, 405, { error: 'This MCP endpoint is stateless. Use POST.' });
  });
}
