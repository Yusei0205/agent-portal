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
 *   finalize   — push one new branch for a repository the session changed (pull requests)
 */

import http from 'node:http';
import { validatePayload } from './validate.js';
import { ApprovalBroker, parseApprovalAnswer } from '../shared/agent/agentcore-approvals.ts';
import { runKiroRun, kiroWorkspaceRoot } from './run.js';
import { runKiroLogin } from './login.js';
import { runKiroListModels } from './list-models.js';
import { runPrepareRepos } from './prepare.js';
import { validateFinalizeRequest, runFinalize } from '../shared/runner-finalize-run.js';
import { parseSnapshot, snapshotBusy, cancelSnapshot, saveWorkspaceInBackground, restoreWorkspace, flushWorkspace } from '../shared/runner-snapshot.js';
import { inspectWorkspace, hasWorkspaceContent } from '../shared/runner-inspect.js';
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

    // ── Save the workspace now and wait for it (the session is being switched to another engine) ──
    // The portal asks before the other engine's first run, so that engine restores the latest files.
    if (body && typeof body === 'object' && !Array.isArray(body) && body.mode === 'flush-workspace') {
      let reply: Record<string, unknown>;
      if (runActive) {
        reply = { type: 'flush', ok: false, error: 'A run is in progress in this session.' };
      } else {
        try {
          await flushWorkspace(parseSnapshot(body.snapshot), kiroWorkspaceRoot() ?? usablePersistRoot(PERSIST_ROOT), () => { lastStatusChange = Math.floor(Date.now() / 1000); });
          reply = { type: 'flush', ok: true };
        } catch (e) {
          reply = { type: 'flush', ok: false, error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.end(`data: ${JSON.stringify(reply)}\n\n`);
      return;
    }

    // ── Read-only look into the workspace (Explorer / Source Control of a cloud session) ──
    // Runs beside a run in progress; it never writes to the workspace.
    if (body && typeof body === 'object' && !Array.isArray(body) && body.mode === 'inspect') {
      let reply: Record<string, unknown>;
      try {
        const persist = usablePersistRoot(PERSIST_ROOT);
        const roots = [kiroWorkspaceRoot(), persist].filter((r): r is string => Boolean(r));
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
        // The warm session's work folder holds repos/ while it lives; otherwise they are in (or restored to) the persistent folder.
        await runFinalize(v.request, { workDir: kiroWorkspaceRoot(), persist: usablePersistRoot(PERSIST_ROOT) }, send);
      } finally {
        setRunActive(false);
        if (!res.writableEnded) res.end();
        // The branch and commit changed the repository: save the workspace again once the reply is out.
        saveWorkspaceInBackground(parseSnapshot(v.request.snapshot), kiroWorkspaceRoot() ?? usablePersistRoot(PERSIST_ROOT), () => { lastStatusChange = Math.floor(Date.now() / 1000); });
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
        saveWorkspaceInBackground(parseSnapshot(p.snapshot), kiroWorkspaceRoot() ?? usablePersistRoot(PERSIST_ROOT), () => { lastStatusChange = Math.floor(Date.now() / 1000); });
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
