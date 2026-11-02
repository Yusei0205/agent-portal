/**
 * Stdio MCP server that gives kiro-cli the AgentCore Browser tools (goto, snapshot, get_text, screenshot, click, type).
 *
 * kiro-runner starts it as a child of kiro-cli by listing it in ACP session/new `mcpServers`. The tool code is the
 * same module the Claude runner uses (shared/browser-tools.ts, copied at image build time). The browser session is
 * started on the first tool call and stopped when kiro-cli closes stdin or the process is terminated.
 *
 * Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0. Nothing but protocol messages may go to stdout.
 */

import readline from 'node:readline';
import { z } from 'zod';
import { AgentCoreBrowser, browserToolSpecs } from '../shared/browser-tools.js';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-southeast-1';
const browser = new AgentCoreBrowser(() => { /* status events are not forwarded from here */ }, region);
const tools = browserToolSpecs(browser);

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

function toolList() {
  return tools.map((t) => {
    const schema = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description,
      inputSchema: schema,
      annotations: t.readOnly ? { readOnlyHint: true } : {},
    };
  });
}

async function handle(req: { id?: number | string; method?: string; params?: Record<string, unknown> }): Promise<void> {
  const { id, method, params } = req;
  if (id === undefined) return; // notification (e.g. notifications/initialized): no reply

  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: (params?.protocolVersion as string) ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'browser', version: '1.0.0' },
        },
      });
      return;
    case 'ping':
      send({ id, result: {} });
      return;
    case 'tools/list':
      send({ id, result: { tools: toolList() } });
      return;
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const spec = tools.find((t) => t.name === name);
      if (!spec) { send({ id, error: { code: -32602, message: `Unknown tool: ${name}` } }); return; }
      const parsed = z.object(spec.shape).safeParse(params?.arguments ?? {});
      if (!parsed.success) {
        send({ id, result: { content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.issues[0]?.message ?? 'bad input'}` }], isError: true } });
        return;
      }
      send({ id, result: await spec.handler(parsed.data) });
      return;
    }
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req: Parameters<typeof handle>[0];
  try { req = JSON.parse(line); } catch { return; }
  handle(req).catch((e) => {
    if (req.id !== undefined) send({ id: req.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  });
});

async function shutdown(): Promise<void> {
  await browser.close();
  process.exit(0);
}
rl.on('close', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
