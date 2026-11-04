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
import { ApprovalBroker, parseApprovalAnswer } from '../shared/agent/agentcore-approvals.ts';
import { runKiroRun } from './run.js';
import { runKiroLogin } from './login.js';
import { runKiroListModels } from './list-models.js';
import { runPrepareRepos } from './prepare.js';
import { parseSnapshot, snapshotBusy, cancelSnapshot, saveWorkspaceInBackground } from '../shared/runner-snapshot.js';
import { usablePersistRoot, PERSIST_ROOT } from '../shared/runner-repos.js';

const PORT = Number(process.env.AGENT_RUNNER_PORT ?? 8080);
const processStartMs = Date.now();

/** Outcome of each kiro-login, kept here so any later request in this session can read it. */
const loginOutcomes = new Map<string, { state: 'pending' | 'complete' | 'failed'; tokenPayload?: unknown; error?: string; at: number }>();
const LOGIN_OUTCOME_TTL_MS = 30 * 60_000;

let runActive = false;
/** The run in progress: its id and the way to stop it. */
let activeRun: { runId: string; stop: AbortController } | null = null;
/** Approval requests of the run in progress, settled by "answer" invocations. */
const broker = new ApprovalBroker();
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
    const status = runActive || snapshotBusy() ? 'HealthyBusy' : 'Healthy';
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

    // ── Control invocations: an approval answer or a cancel for the run in progress ──
    // They arrive on the same session (AgentCore routes them to this microVM) while the
    // run's own invocation is still streaming, so they skip the busy check.
    const body = parsed as Record<string, unknown> | null;
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

    const validation = validatePayload(parsed);
    if (!validation.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: validation.error }));
      return;
    }

    if (validation.payload.mode === 'kiro-login-status') {
      const o = loginOutcomes.get(validation.payload.runId);
      for (const [k, v] of loginOutcomes) if (Date.now() - v.at > LOGIN_OUTCOME_TTL_MS) loginOutcomes.delete(k);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const ev = o
        ? { type: 'login-status', state: o.state, ...(o.tokenPayload ? { tokenPayload: o.tokenPayload } : {}), ...(o.error ? { error: o.error } : {}) }
        : { type: 'login-status', state: 'unknown' };
      res.end(`data: ${JSON.stringify(ev)}

`);
      return;
    }

    // A save of the workspace may still be running from the previous message: cancel it (this message saves again).
    await cancelSnapshot();

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
    const stop = new AbortController();
    activeRun = { runId: validation.payload.runId, stop };
    // The caller hung up before the run finished: stop the run rather than carry on unseen.
    res.on('close', () => { if (!res.writableFinished) stop.abort(); });
    try {
      const { payload } = validation;
      if (payload.mode === 'kiro-run') {
        await runKiroRun(payload, emit, processStartMs, broker, stop.signal);
      } else if (payload.mode === 'kiro-list-models') {
        await runKiroListModels(payload, emit);
      } else if (payload.mode === 'prepare-repos') {
        await runPrepareRepos(payload, emit);
      } else if (payload.mode === 'kiro-login') {
        loginOutcomes.set(payload.runId, { state: 'pending', at: Date.now() });
        const recording = (event: Record<string, unknown>): void => {
          if (event.type === 'result') {
            loginOutcomes.set(payload.runId, event.success && event.tokenPayload
              ? { state: 'complete', tokenPayload: event.tokenPayload, at: Date.now() }
              : { state: 'failed', error: 'Login did not complete', at: Date.now() });
          } else if (event.type === 'error') {
            loginOutcomes.set(payload.runId, { state: 'failed', error: String(event.message ?? 'Login failed'), at: Date.now() });
          }
          emit(event);
        };
        await runKiroLogin(payload, recording, processStartMs);
      }
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      emit({ type: 'error', message: msg.slice(0, 500) });
      process.stderr.write(JSON.stringify({ event: 'invocation_error', error: msg.slice(0, 500) }) + '\n');
    } finally {
      activeRun = null;
      setRunActive(false);
      if (!res.writableEnded) res.end();
      // Save the workspace once the reply is out; the machine stays "busy" until that is done.
      const p = validation.payload;
      if (p.mode === 'kiro-run' || p.mode === 'prepare-repos') {
        saveWorkspaceInBackground(parseSnapshot(p.snapshot), usablePersistRoot(PERSIST_ROOT), () => { lastStatusChange = Math.floor(Date.now() / 1000); });
      }
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
