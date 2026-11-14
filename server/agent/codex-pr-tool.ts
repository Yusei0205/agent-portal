import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { decideToolCall } from './tool-policy.ts';
import type { CodexSessionContext } from './codex-session.ts';

export interface CodexPrRequest { repo: string; base: string }
export const CODEX_PR_TOOL = 'mcp__portal_pr__create_pull_request';
export const CODEX_PR_INSTRUCTIONS = 'For a user-requested pull request, use portal_pr.create_pull_request with the attached repository name and the exact requested base branch. GitHub authentication and pushing are handled by the portal after this turn finishes. Do not run gh auth login, request GitHub credentials, or claim that missing shell GitHub authentication blocks the portal. The tool queues publication; report it as queued, not as an already opened PR.';

export function parseCodexPrRequest(value: unknown, repos: readonly string[]): CodexPrRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Repository and base branch are required');
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(k => k !== 'repo' && k !== 'base') || typeof p.repo !== 'string' || !repos.includes(p.repo)
    || typeof p.base !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(p.base)
    || p.base.includes('..') || p.base.includes('//') || p.base.endsWith('/') || p.base.endsWith('.lock') || p.base.includes('/.')) {
    throw new Error('Choose an attached repository and a valid base branch');
  }
  return { repo: p.repo, base: p.base };
}

/** Per-turn loopback MCP endpoint. Holds no GitHub credential and only queues work. */
export async function openCodexPrTool(ctx: CodexSessionContext, repos: string[], queue: (request: CodexPrRequest) => void) {
  const route = '/' + randomUUID();
  const server = http.createServer(async (req, res) => {
    if (req.url !== route) { res.writeHead(404); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let msg: any;
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 16_384) throw new Error('Too large'); chunks.push(chunk); }
      msg = JSON.parse(Buffer.concat(chunks).toString());
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') throw new Error('Invalid request');
    } catch { res.writeHead(400); res.end(); return; }
    if (msg.id == null) { res.writeHead(202); res.end(); return; }
    const reply = (result: object) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
    const content = (text: string, isError = false) => reply({ content: [{ type: 'text', text }], isError });
    if (msg.method === 'initialize') {
      reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'portal_pr', version: '1.0.0' } }); return;
    }
    if (msg.method === 'ping') { reply({}); return; }
    if (msg.method === 'tools/list') {
      reply({ tools: [{ name: 'create_pull_request', description: 'Queue a user-requested PR using the portal GitHub connection after this turn finishes. Supply the exact target base branch. No shell login is needed.',
        inputSchema: { type: 'object', properties: { repo: { type: 'string', enum: repos }, base: { type: 'string', description: 'Requested target branch, e.g. main_v3' } }, required: ['repo', 'base'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } }] }); return;
    }
    if (msg.method !== 'tools/call' || msg.params?.name !== 'create_pull_request') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unsupported method or tool' } })); return;
    }
    try {
      const request = parseCodexPrRequest(msg.params.arguments, repos);
      if (ctx.signal?.aborted) throw new Error('Run cancelled');
      const decision = decideToolCall({ toolName: CODEX_PR_TOOL, input: { ...request }, workDir: ctx.run.workDir,
        rules: ctx.run.permissions.rules, trusted: ctx.run.trusted, allowed: ctx.allowed });
      if (decision.action === 'deny') throw new Error(decision.reason);
      if (!ctx.run.trusted || decision.action === 'ask') {
        const answer = await ctx.awaitInput(CODEX_PR_TOOL, { ...request });
        if (answer.decision !== 'allow') throw new Error('PR publication was declined');
      }
      if (ctx.signal?.aborted) throw new Error('Run cancelled');
      queue(request);
      content(`PR publication queued for ${request.repo} against ${request.base}. The portal will push and open it after this turn and its snapshots finish. Check the portal PR card for the result.`);
    } catch (e) { content((e as Error).message, true); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}${route}`,
    close: () => { server.closeAllConnections(); server.close(); } };
}
