/**
 * MCP HTTP routes (F11).
 *
 * POST /api/mcp        — Streamable HTTP MCP endpoint (stateless, Bearer-token only)
 * GET  /api/mcp/info   — MCP server info for the API Access page
 *
 * Security:
 *   - Only Bearer ap_... tokens are accepted; cookie auth returns 401.
 *   - New McpServer + StreamableHTTPServerTransport per request → no shared state
 *     (avoids CVE-2026-25536 transport reuse vulnerability).
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { now } from './util.ts';
import { createMcpServer } from './mcp-server.ts';
import { getApiTokenRepository } from './repositories/api-tokens.ts';

// ── Tool catalogue (for /info endpoint) ───────────────────────────────────────

interface ToolInfo {
  name: string;
  scope: string;
  description: string;
}

const TOOL_CATALOGUE: ToolInfo[] = [
  { name: 'list_sessions',           scope: 'read',   description: 'List sessions (workflows) in a project' },
  { name: 'get_transcript',          scope: 'read',   description: 'Get events (transcript) for a session' },
  { name: 'list_reviews',            scope: 'read',   description: 'List code reviews for a project' },
  { name: 'get_review',              scope: 'read',   description: 'Get a code review with its findings' },
  { name: 'get_review_usage',        scope: 'read',   description: 'Get cost and token usage for a review' },
  { name: 'list_test_projects',      scope: 'read',   description: 'List test projects in a project' },
  { name: 'list_test_scripts',       scope: 'read',   description: 'List test scripts in a test project' },
  { name: 'get_test_run',            scope: 'read',   description: 'Get a test run with its step results' },
  { name: 'start_session',           scope: 'write',  description: 'Create and start a new session in a project' },
  { name: 'prompt_session',          scope: 'write',  description: 'Send a follow-up message to a running session' },
  { name: 'stop_session',            scope: 'write',  description: 'Stop (pause) a running session' },
  { name: 'delegate_session',        scope: 'write',  description: 'Delegate a task to a new child session' },
  { name: 'start_review',            scope: 'review', description: 'Start a code review for a pull request or branch diff' },
  { name: 'wait_for_review',         scope: 'review', description: 'Poll a review until it completes (max 25 s)' },
  { name: 'post_review_comments',    scope: 'review', description: 'Post review findings as PR comments' },
  { name: 'start_scan',             scope: 'review', description: 'Start a branch scan (estimate phase)' },
  { name: 'confirm_scan',           scope: 'review', description: 'Confirm the budget and queue a scan' },
  { name: 'resume_scan',            scope: 'review', description: 'Resume a failed or stopped scan' },
  { name: 'merge_pull_request',     scope: 'merge',  description: 'Merge the PR associated with a completed review' },
  { name: 'start_test_run',         scope: 'tests',  description: 'Start a test run for a script or group' },
  { name: 'cancel_test_run',        scope: 'tests',  description: 'Cancel a running test run' },
  { name: 'generate_test_script',   scope: 'tests',  description: 'Generate a test script from a natural-language description' },
];

// ── Token stats helper ─────────────────────────────────────────────────────────

async function tokenStats(): Promise<{ active: number; withWrite: number; withMerge: number; neverUsed: number }> {
  const validNow = now();
  let active = 0;
  let withWrite = 0;
  let withMerge = 0;
  let neverUsed = 0;

  // listAll() excludes delegate tokens; for DynamoDB it returns [] with a warning.
  const rows = await getApiTokenRepository().listAll();

  for (const t of rows) {
    if (t.revoked_at || t.expires_at < validNow) continue;
    active++;
    const scopes: string[] = t.scopes
      ? ((): string[] => { try { return JSON.parse(t.scopes!) as string[]; } catch { return [t.scope]; } })()
      : (t.scope === 'write' ? ['read', 'write'] : ['read']);
    if (scopes.includes('write')) withWrite++;
    if (scopes.includes('merge')) withMerge++;
    if (!t.last_used_at) neverUsed++;
  }

  return { active, withWrite, withMerge, neverUsed };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerMcpRoutes(): void {

  // GET /api/mcp/info — info for the API Access page (requires browser session or token)
  router.get('/api/mcp/info', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) {
      sendJson(res, 401, { error: 'Sign in to continue' });
      return;
    }

    const url = '/api/mcp';
    const transport = 'Streamable HTTP (stateless)';

    const clientConfigExample = {
      mcpServers: {
        'agent-portal': {
          transport: 'http',
          url: `${url}`,
          headers: { Authorization: 'Bearer <your-token>' },
        },
      },
    };

    const stats = await tokenStats();

    sendJson(res, 200, {
      url,
      transport,
      tools: TOOL_CATALOGUE,
      clientConfigExample,
      tokenStats: stats,
    });
  });

  // POST /api/mcp — Streamable HTTP MCP endpoint (stateless, Bearer-token only)
  // bypassCsrf: true — MCP clients send Bearer tokens, not the custom header.
  router.rawPost('/api/mcp', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    // Only Bearer token auth accepted — cookie auth is explicitly rejected
    const authHeader = String((req.headers as Record<string, unknown>).authorization ?? '');
    if (!authHeader.startsWith('Bearer ap_')) {
      sendJson(res, 401, { error: 'Bearer token required. Cookie authentication is not accepted on this endpoint.' });
      return;
    }

    if (!req.user || !req.tokenScopes) {
      sendJson(res, 401, { error: 'Invalid or expired token' });
      return;
    }

    const scopes = new Set(req.tokenScopes);
    const mcpServer = createMcpServer(req.user, scopes, req.tokenWorkflowId ?? null);

    // Create a fresh transport per request — never reuse across requests
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err: unknown) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { error: `MCP transport error: ${msg}` });
      }
    } finally {
      // Clean up the transport to avoid memory leaks
      await transport.close().catch(() => { /* ignore close errors */ });
    }
  });

  // GET /api/mcp — SSE notification stream (optional for stateless; returns 405 for now)
  router.rawGet('/api/mcp', (_req: PortalRequest, res: PortalResponse): void => {
    sendJson(res, 405, { error: 'This MCP endpoint is stateless. Use POST with your JSON-RPC request.' });
  });
}
