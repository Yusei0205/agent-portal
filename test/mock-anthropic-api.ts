// A stand-in for the Anthropic Messages API, so tests can drive the real Claude Code engine with scripted replies.
// Each request that offers tools (the agent's own turns) takes the next step of the script:
//   { tool: 'Bash', input: { command: 'ls' } }   the model calls a tool
//   { text: 'done' }                              the model ends its turn
// Requests without tools (titles, summaries) get a short text reply. Every request is kept in `requests`.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockStep = { tool: string; input?: Record<string, unknown> } | { text: string; tool?: undefined; input?: undefined };
export interface MockRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export async function startMockAnthropic({ script = [{ text: 'done' }] as MockStep[], usage = { input_tokens: 100, output_tokens: 20 } } = {}) {
  let steps: MockStep[] = script;
  let step = 0;
  const requests: MockRequest[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* not JSON */
      }
      const url = req.url ?? '/';
      requests.push({ method: req.method ?? 'GET', url, headers: req.headers, body });
      if (!url.startsWith('/v1/messages') || url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(url.includes('count_tokens') ? { input_tokens: 100 } : {}));
        return;
      }
      const offersTools = Array.isArray(body.tools) && body.tools.length > 0;
      const s: MockStep = offersTools ? steps[Math.min(step++, steps.length - 1)] : { text: 'ok' };
      type Block = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'text'; text: string };
      const blocks: Block[] = s.tool
        ? [{ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2, 12)}`, name: s.tool, input: s.input ?? {} }]
        : [{ type: 'text', text: 'text' in s ? s.text : 'done' }];
      const stop = s.tool ? 'tool_use' : 'end_turn';
      const message = {
        id: `msg_${Math.random().toString(36).slice(2, 12)}`,
        type: 'message',
        role: 'assistant',
        model: body.model || 'claude-sonnet-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...message, content: blocks, stop_reason: stop, usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message });
      blocks.forEach((b, index) => {
        if (b.type === 'tool_use') {
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
        } else {
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
        }
        send('content_block_stop', { type: 'content_block_stop', index });
      });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Start a new script for the next run. */
    setScript(next: MockStep[]) {
      steps = next;
      step = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
