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
import { runFinalize, validateFinalizeRequest } from './finalize.js';
import { parseSnapshot, snapshotBusy, cancelSnapshot, saveWorkspaceInBackground, restoreWorkspace } from '../shared/runner-snapshot.js';
import { inspectWorkspace, hasWorkspaceContent } from '../shared/runner-inspect.js';
import { usablePersistRoot, PERSIST_ROOT } from '../shared/runner-repos.js';
import { ApprovalBroker, parseApprovalAnswer } from '../shared/agent/agentcore-approvals.ts';

const PORT = Number(process.env.AGENT_RUNNER_PORT ?? 8080);
const processStartMs = Date.now();

// Track current run state for /ping.
// Only one run at a time in the spike (AgentCore creates one microVM per session).
let runActive = false;
/** The run in progress: its id and the way to stop it. */
let activeRun: { runId: string; stop: AbortController } | null = null;
/** Approval requests of the run in progress, settled by "answer" invocations. */
const broker = new ApprovalBroker();
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
    const status = runActive || snapshotBusy() ? 'HealthyBusy' : 'Healthy';
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


    // ── Control invocations: an approval answer or a cancel for the run in progress ──
    // They arrive on the same session (AgentCore routes them to this microVM) while the
    // run's own invocation is still streaming, so they skip the busy check.
    const body = parsed as Record<string, unknown> | null;

    // ── Read-only look into the workspace (Explorer / Source Control of a cloud session) ──
    // Runs beside a run in progress; it never writes to the workspace.
    if (body && typeof body === 'object' && !Array.isArray(body) && body.mode === 'inspect') {
      let reply: Record<string, unknown>;
      try {
        const persist = usablePersistRoot(PERSIST_ROOT);
        const roots = persist ? [persist] : [];
        // A fresh machine of this session has no workspace yet: bring back the saved one first.
        if (!hasWorkspaceContent(roots) && body.snapshot && persist && !runActive && !snapshotBusy()) {
          await restoreWorkspace(parseSnapshot(body.snapshot), persist, () => { /* quiet */ }).catch(() => { /* an empty workspace is shown */ });
        }
        reply = { type: 'inspect', ...(await inspectWorkspace(roots, { op: body.op as never, path: typeof body.path === 'string' ? body.path : undefined, repo: typeof body.repo === 'string' ? body.repo : undefined })) };
      } catch (e) {
        reply = { type: 'inspect', ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.end(`data: ${JSON.stringify(reply)}

`);
      return;
    }
    // ── Push one new branch for a repository the session changed (the "open a pull request" feature) ──
    if (body && typeof body === 'object' && !Array.isArray(body) && body.mode === 'finalize') {
      const v = validateFinalizeRequest(body);
      if (!v.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: v.error }));
        return;
      }
      await cancelSnapshot();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      const send = (event: Record<string, unknown>): void => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
      if (runActive) {
        send({ type: 'repo-pushed', repo: v.request.repo, branch: v.request.branch, error: 'A run is still in progress in this session; try again when it has finished.' });
        res.end();
        return;
      }
      setRunActive(true);
      try {
        await runFinalize(v.request, sessionId, send);
      } finally {
        setRunActive(false);
        if (!res.writableEnded) res.end();
        // The branch and commit changed the repository: save the workspace again once the reply is out.
        saveWorkspaceInBackground(parseSnapshot(v.request.snapshot), usablePersistRoot(PERSIST_ROOT), () => { lastStatusChange = Math.floor(Date.now() / 1000); });
      }
      return;
    }
    if (body && typeof body === 'object' && !Array.isArray(body) && (body.mode === 'answer' || body.mode === 'cancel')) {
      let reply: Record<string, unknown>;
      if (body.mode === 'answer') {
        const answer = parseApprovalAnswer(body);
        if (typeof answer === 'string') {
          reply = { type: 'answer-rejected', status: 400, error: answer };
        } else {
          const r = broker.answer(answer);
          reply = r.ok ? { type: 'answer-ack', requestId: answer.requestId } : { type: 'answer-rejected', status: r.status, error: r.error };
        }
      } else if (activeRun && typeof body.runId === 'string' && body.runId === activeRun.runId) {
        activeRun.stop.abort();
        reply = { type: 'cancel-ack', runId: body.runId };
      } else {
        reply = { type: 'cancel-ack', runId: body.runId ?? null, note: 'no such run in progress' };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.end(`data: ${JSON.stringify(reply)}\n\n`);
      return;
    }

    // Validate payload
    const validation = validatePayload(parsed);
    if (!validation.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    // A save of the workspace may still be running from the previous message: cancel it (this message saves again).
    await cancelSnapshot();

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
    const stop = new AbortController();
    activeRun = { runId: validation.payload.runId, stop };
    // The caller hung up before the run finished: stop the run rather than carry on unseen.
    res.on('close', () => { if (!res.writableFinished) stop.abort(); });
    try {
      await runInvocation(validation.payload, sessionId, emit, processStartMs, broker, stop.signal);
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      emit({ type: 'error', message: msg.slice(0, 500) });
      // Log error (no sensitive data, just the error message)
      process.stderr.write(JSON.stringify({ event: 'run_error', error: msg.slice(0, 500) }) + '\n');
    } finally {
      activeRun = null;
      setRunActive(false);
      if (!res.writableEnded) res.end();
      // Save the workspace once the reply is out; the machine stays "busy" until that is done.
      saveWorkspaceInBackground(parseSnapshot(validation.payload.snapshot), usablePersistRoot(PERSIST_ROOT), () => { lastStatusChange = Math.floor(Date.now() / 1000); });
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
