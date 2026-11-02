/**
 * kiro-runner — Amazon Bedrock AgentCore Runtime server.
 *
 * Implements the AgentCore Runtime HTTP service contract:
 *   GET  /ping        — health check (Healthy / HealthyBusy)
 *   POST /invocations — kiro-run or kiro-login, streamed as SSE
 *
 * Port: 8080 (default AgentCore serving port).
 * Platform: linux/arm64 (AgentCore Runtime requirement).
 *
 * Payload modes:
 *   kiro-run   — materialise temp IdC DB, run `kiro-cli chat --no-interactive`
 *   kiro-login — run `kiro-cli login --use-device-flow`, stream verification URL/code
 *   kiro-list-models — run `kiro-cli chat --list-models --format json` with the user's token
 */

import http from 'node:http';
import { validatePayload } from './validate.js';
import { runKiroRun } from './run.js';
import { runKiroLogin } from './login.js';
import { runKiroListModels } from './list-models.js';

const PORT = Number(process.env.AGENT_RUNNER_PORT ?? 8080);
const processStartMs = Date.now();

let runActive = false;
let lastStatusChange = Math.floor(Date.now() / 1000);

function setRunActive(active: boolean): void {
  if (runActive !== active) {
    runActive = active;
    lastStatusChange = Math.floor(Date.now() / 1000);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  if (method === 'GET' && url === '/ping') {
    const status = runActive ? 'HealthyBusy' : 'Healthy';
    const body: Record<string, unknown> = { status };
    if (lastStatusChange > 0) {
      body.time_of_last_update = lastStatusChange;
      lastStatusChange = 0;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  if (method === 'POST' && (url === '/invocations' || url === '/invocations/')) {
    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read request body' }));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body is not valid JSON' }));
      return;
    }

    const validation = validatePayload(parsed);
    if (!validation.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    if (runActive) {
      res.writeHead(409, {
        'Content-Type': 'application/json',
        'x-amzn-ErrorType': 'RetryableConflictException',
      });
      res.end(JSON.stringify({ error: 'Session operation in progress, please retry' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const emit = (event: Record<string, unknown>): void => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    setRunActive(true);
    try {
      const { payload } = validation;
      if (payload.mode === 'kiro-run') {
        await runKiroRun(payload, emit, processStartMs);
      } else if (payload.mode === 'kiro-list-models') {
        await runKiroListModels(payload, emit);
      } else {
        await runKiroLogin(payload, emit, processStartMs);
      }
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      emit({ type: 'error', message: msg.slice(0, 500) });
      process.stderr.write(JSON.stringify({ event: 'invocation_error', error: msg.slice(0, 500) }) + '\n');
    } finally {
      setRunActive(false);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(
    JSON.stringify({
      event: 'server_ready',
      port: PORT,
      pid: process.pid,
      nodeVersion: process.version,
      startedAt: new Date().toISOString(),
    }) + '\n',
  );
});

server.on('error', (err) => {
  process.stderr.write(JSON.stringify({ event: 'server_error', error: String(err) }) + '\n');
  process.exit(1);
});

process.on('SIGTERM', () => {
  process.stdout.write(JSON.stringify({ event: 'shutdown', signal: 'SIGTERM' }) + '\n');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  process.stdout.write(JSON.stringify({ event: 'shutdown', signal: 'SIGINT' }) + '\n');
  server.close(() => process.exit(0));
});
