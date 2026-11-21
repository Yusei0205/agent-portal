/**
 * The draw.io MCP server (@drawio/mcp, installed in the image under DRAWIO_MCP_HOME), run as a local stdio server for
 * an agent, with only its two lookup tools offered: search_shapes and get_drawio_reference. The server's other tools open
 * a browser or read local files, so they are hidden from the tool list and refused when called.
 *
 * It needs no network: the shape index is a pinned file in the image (DRAWIO_SHAPE_INDEX_URL points at it) and the icon
 * service is switched off. Protocol: MCP over stdio, newline-delimited JSON-RPC; nothing but protocol goes to stdout.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

const HOME = process.env.DRAWIO_MCP_HOME || '/opt/drawio-mcp';
const ALLOWED = new Set(['search_shapes', 'get_drawio_reference']);

const child = spawn(process.execPath, [path.join(HOME, 'node_modules', '@drawio', 'mcp', 'src', 'index.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '/tmp',
    XDG_CACHE_HOME: '/tmp/drawio-mcp-cache',
    DRAWIO_SHAPE_INDEX_URL: path.join(HOME, 'shape-index.json'),
    DRAWIO_ICON_SERVICE_URL: 'off',
  },
});
child.on('exit', (code) => process.exit(code ?? 0));

const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };

// Agent → server: refuse a call to any tool that is not allowed.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: { id?: number | string; method?: string; params?: { name?: unknown } } | null = null;
  try { msg = JSON.parse(line); } catch { /* pass it on as is */ }
  if (msg?.method === 'tools/call' && msg.id !== undefined && !ALLOWED.has(String(msg.params?.name ?? ''))) {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `"${String(msg.params?.name)}" is not available in this session; use search_shapes and get_drawio_reference.` }], isError: true } });
    return;
  }
  child.stdin.write(line + '\n');
});
process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* gone */ } });

// Server → agent: show only the allowed tools.
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const msg = JSON.parse(line) as { result?: { tools?: Array<{ name: string }> } };
    if (Array.isArray(msg.result?.tools)) msg.result.tools = msg.result.tools.filter((t) => ALLOWED.has(t.name));
    send(msg);
  } catch {
    // not JSON: never forward it (stdout is the protocol)
  }
});
