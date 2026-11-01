/**
 * AgentCore Runtime HTTP server — entry point.
 *
 * Implements the Amazon Bedrock AgentCore Runtime HTTP service contract:
 *   GET  /ping        — health check (Healthy / HealthyBusy)
 *   POST /invocations — run one Claude Code agent turn, streamed as SSE
 *
 * Port: 8080 (default AgentCore serving port).
 * Platform: linux/arm64 (AgentCore Runtime requirement).
 *
 * Session routing:
 *   AgentCore passes X-Amzn-Bedrock-AgentCore-Runtime-Session-Id on every
 *   request to route it to the same microVM. We use this value as the work-dir
 *   key so repeated invocations to the same session share state.
 *
 * /ping status semantics (from the contract):
 *   "Healthy"     — idle, ready for new work.
 *   "HealthyBusy" — a run is in progress; the runtime keeps the session alive.
 *   time_of_last_update must NOT be updated on every ping (prevents idle-timeout
 *   from ever firing). We omit it and let AgentCore track state changes itself.
 */

import http from 'node:http';
import { runInvocation } from './run.js';
import { validatePayload } from './validate.js';

const PORT = Number(process.env.AGENT_RUNNER_PORT ?? 8080);
const processStartMs = Date.now();

// Track current run state for /ping.
// Only one run at a time in the spike (AgentCore creates one microVM per session).
let runActive = false;
let lastStatusChange = Math.floor(Date.now() / 1000); // Unix seconds

function setRunActive(active: boolean): void {
  if (runActive !== active) {
    runActive = active;
    lastStatusChange = Math.floor(Date.now() / 1000);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  // ── GET /ping ────────────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/ping') {
    const status = runActive ? 'HealthyBusy' : 'Healthy';
    // Only include time_of_last_update on an actual state change (per contract warning).
    const body: Record<string, unknown> = { status };
    if (lastStatusChange > 0) {
      body.time_of_last_update = lastStatusChange;
      // Reset so we don't keep re-sending the same timestamp on every poll
      lastStatusChange = 0;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // ── POST /invocations ────────────────────────────────────────────────────────
  if (method === 'POST' && (url === '/invocations' || url === '/invocations/')) {
    // Extract session ID from AgentCore header
    const sessionId = req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as string | undefined;

    // Read and parse body
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

    // Validate payload
    const validation = validatePayload(parsed);
    if (!validation.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    // Check if already busy (only one concurrent run per microVM in the spike)
    if (runActive) {
      res.writeHead(409, {
        'Content-Type': 'application/json',
        'x-amzn-ErrorType': 'RetryableConflictException',
      });
      res.end(JSON.stringify({ error: 'Session operation in progress, please retry' }));
      return;
    }

    // Start SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const emit = (event: Record<string, unknown>): void => {
      // Each SSE event is: data: <json>\n\n
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    setRunActive(true);
    try {
      await runInvocation(validation.payload, sessionId, emit, processStartMs);
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      emit({ type: 'error', message: msg.slice(0, 500) });
      // Log error (no sensitive data, just the error message)
      process.stderr.write(JSON.stringify({ event: 'run_error', error: msg.slice(0, 500) }) + '\n');
    } finally {
      setRunActive(false);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // ── 404 for everything else ──────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ── Start ─────────────────────────────────────────────────────────────────────

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

// Graceful shutdown
process.on('SIGTERM', () => {
  process.stdout.write(JSON.stringify({ event: 'shutdown', signal: 'SIGTERM' }) + '\n');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  process.stdout.write(JSON.stringify({ event: 'shutdown', signal: 'SIGINT' }) + '\n');
  server.close(() => process.exit(0));
});
