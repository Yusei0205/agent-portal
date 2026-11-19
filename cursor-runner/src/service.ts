import http from 'node:http';
import { startKeepalive } from './sse-keepalive.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cloneRunnerRepos, parseRunnerRepos } from '../../server/agent/runner-repos.ts';
import { parseSnapshot, restoreWorkspace, flushWorkspaceStrict as flushWorkspace } from '../../server/agent/runner-snapshot.ts';
import { inspectWorkspace } from '../../server/agent/runner-inspect.ts';
import { runFinalize, validateFinalizeRequest, reportRepoChanges } from '../../server/agent/runner-finalize-run.ts';
import { writeInputFilesAsync, emitRunnerFiles } from '../../server/agent/runner-files.ts';
import { runCheckSteps, validateCheckSteps } from '../../server/agent/runner-checks.ts';
import { createRunnerTerminal } from '../../server/agent/runner-terminal.ts';
import { applyCursorRules, parseCursorFiles } from '../../server/agent/cursor-config.ts';
import { CursorArgError, cursorArgs, driveCursorTurn, turnFailure } from '../../server/agent/cursor-turn.ts';
import { listCursorModels } from '../../server/cursor-models.ts';
import { restoreCursorState, saveCursorState, sessionExists } from './state.ts';
import { cursorAuthEnv, looksLikeLoginToken, type CursorAuth } from '../../server/cursor-login-token.ts';

type Event = Record<string, any>;
type ServiceOptions = {
  root?: string;
  restoreState?: typeof restoreCursorState;
  saveState?: typeof saveCursorState;
};
const MAX_BODY = 16 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,256}$/;
const MODES = ['cursor-run', 'cursor-models', 'cursor-text', 'prepare-repos', 'inspect', 'finalize', 'flush-workspace'];

/**
 * The Cursor runner inside an AgentCore microVM. Same HTTP/SSE contract as the Codex runner (GET /ping, POST /invocations),
 * minus ChatGPT device sign-in and per-call approvals: Cursor's print mode has neither. The workspace path is fixed
 * (root/work), because the CLI files its chats under a hash of it and a resumed chat is only found at the same path.
 */
export function createCursorRunnerServer(options: ServiceOptions = {}): http.Server {
  const root = options.root ?? path.join(os.tmpdir(), 'agent-portal-cursor');
  const workDir = path.join(root, 'work'), home = path.join(root, 'home');
  let active: { runId: string; controller: AbortController } | null = null;
  let boundWorkflow: string | null = null;
  const restore = options.restoreState ?? restoreCursorState;
  const save = options.saveState ?? saveCursorState;
  // Nothing from the runner's own environment reaches the CLI (or the agent's shell) except what it needs.
  const environment = (auth: CursorAuth): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    SYSTEMROOT: process.env.SYSTEMROOT, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
    TMP: os.tmpdir(), TEMP: os.tmpdir(), LANG: 'C.UTF-8', SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    ...cursorAuthEnv(auth) });
  const terminal = createRunnerTerminal({
    engine: 'cursor',
    prepare: async (snapshot, status) => {
      await fs.mkdir(workDir, { recursive: true });
      if (!active) await restoreWorkspace(snapshot, workDir, event => { if (event.type === 'status') status(String(event.text)); });
      return workDir;
    },
    save: snapshot => flushWorkspace(snapshot, workDir),
  });

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: active || terminal.busy() ? 'HealthyBusy' : 'Healthy' })); return;
    }
    if (req.method !== 'POST' || !['/invocations', '/invocations/'].includes(req.url || '')) { res.writeHead(404); res.end(); return; }
    let body: Event;
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) throw new Error('Invocation is too large'); chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid invocation');
    } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid or oversized invocation' })); return; }
    const json = (status: number, value: object) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const reply = (value: object) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.end('data: ' + JSON.stringify(value) + '\n\n'); };
    if (body.mode === 'terminal-ticket') {
      if (boundWorkflow && body.workflowId !== boundWorkflow) { json(403, { error: 'This runner belongs to another workflow' }); return; }
      try { const result = await terminal.issue(body); boundWorkflow = body.workflowId; reply(result); }
      catch (e) { json(400, { error: (e as Error).message }); }
      return;
    }
    if (body.mode === 'cancel') {
      if (!active || active.runId !== body.runId) { json(409, { error: 'Run is not active' }); return; }
      active.controller.abort(); reply({ type: 'cancelled' }); return;
    }
    if (active || terminal.preparing()) { json(409, { error: 'The session is busy preparing or running work' }); return; }
    if (!MODES.includes(body.mode)) { json(400, { error: 'Unsupported mode' }); return; }
    // Exactly one credential per call: an API key, or a login token (the CLI's CURSOR_AUTH_TOKEN).
    const goodKey = typeof body.apiKey === 'string' && body.apiKey.length > 0 && body.apiKey.length <= 4096 && !/[\r\n\0\s]/.test(body.apiKey);
    if (['cursor-run', 'cursor-models', 'cursor-text'].includes(body.mode)
      && ((body.apiKey != null && body.authToken != null) || !(goodKey && body.authToken == null) && !(looksLikeLoginToken(body.authToken) && body.apiKey == null))) {
      json(400, { error: 'A Cursor API key or login token is required' }); return;
    }
    if (body.mode === 'cursor-run' && (typeof body.prompt !== 'string' || body.prompt.length > 250_000
      || typeof body.workflowId !== 'string' || !ID.test(body.workflowId)
      || typeof body.runId !== 'string' || !ID.test(body.runId)
      || (body.model != null && (typeof body.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(body.model)))
      || (body.sessionId != null && (typeof body.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/.test(body.sessionId))))) {
      json(400, { error: 'Invalid Cursor run fields' }); return;
    }
    if (body.workflowId && boundWorkflow && body.workflowId !== boundWorkflow) { json(403, { error: 'This runner is bound to another workflow' }); return; }
    if (body.workflowId) boundWorkflow = body.workflowId;
    const controller = new AbortController();
    active = { runId: body.runId || body.mode, controller };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    // A line every 20 s, so a quiet stretch is not mistaken for a dropped connection (see sse-keepalive.ts).
    startKeepalive(res);
    const auth: CursorAuth = { ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}), ...(typeof body.authToken === 'string' ? { authToken: body.authToken } : {}) };
    const secrets = [auth.apiKey, auth.authToken].filter((s): s is string => typeof s === 'string' && s.length > 0);
    const send = (event: Event) => {
      let text = JSON.stringify(event);
      for (const secret of secrets) text = text.split(secret).join('***');
      if (!res.writableEnded && !res.destroyed) res.write('data: ' + text + '\n\n');
    };
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    const heartbeat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': working\n\n'); }, 15_000);
    // What an interrupted turn needs to be continued: where the workspace and the chat are saved, and the chat's id.
    let resumeInfo: { snapshot: ReturnType<typeof parseSnapshot>; stateSnapshot: ReturnType<typeof parseSnapshot>; sessionId: string } | null = null;
    let usage: Event | undefined;
    let modelUsed: string | undefined;
    try {
      await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      const snapshot = parseSnapshot(body.snapshot);
      if (body.mode === 'inspect') {
        await restoreWorkspace(snapshot, workDir, send);
        send({ type: 'inspect', ...await inspectWorkspace([workDir], { op: body.op, path: body.path, repo: body.repo }) });
      } else if (body.mode === 'flush-workspace') {
        await flushWorkspace(snapshot, workDir); send({ type: 'flush', ok: true });
      } else if (body.mode === 'finalize') {
        const checked = validateFinalizeRequest(body);
        if (!checked.ok) throw new Error(checked.error);
        await runFinalize(checked.request, { workDir, persist: workDir }, send);
      } else if (body.mode === 'prepare-repos') {
        await restoreWorkspace(snapshot, workDir, send);
        const parsed = parseRunnerRepos(body.repos);
        if (!parsed.ok) throw new Error(parsed.error);
        const ready = await cloneRunnerRepos(parsed.repos, workDir, send);
        await flushWorkspace(snapshot, workDir);
        send({ type: 'result', success: true, persisted: true, repos: ready });
      } else if (body.mode === 'cursor-text') {
        // One prompt, one answer: no repository, no saved chat, and not trusted, so no shell command runs.
        if (typeof body.prompt !== 'string' || !body.prompt || body.prompt.length > 250_000
          || (body.model != null && (typeof body.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(body.model)))) throw new Error('Invalid Cursor text request');
        const textDir = await fs.mkdtemp(path.join(root, 'text-'));
        try {
          const answer = await driveCursorTurn({ args: cursorArgs({ trusted: false, model: body.model || null, resumeId: null }), prompt: body.prompt, cwd: textDir, env: environment(auth),
            emit: () => {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(170_000)]) });
          const failure = turnFailure(answer);
          if (failure) throw new Error(failure);
          send({ type: 'result', exitCode: 0, text: answer.state.resultText ?? answer.state.text, ...(answer.state.usage ? { usage: answer.state.usage } : {}) });
        } finally { await fs.rm(textDir, { recursive: true, force: true }); }
      } else if (body.mode === 'cursor-models') {
        const listed = await listCursorModels(auth, 45_000, environment(auth));
        if (listed.error) throw new Error(listed.error);
        send({ type: 'models', models: listed.models, text: listed.models.map(m => `${m.id} - ${m.label}${m.default ? ' (default)' : ''}`).join('\n') });
      } else {
        const stateSnapshot = parseSnapshot(body.stateSnapshot);
        if (body.stateSnapshot && !stateSnapshot) throw new Error('Invalid Cursor conversation snapshot capability');
        const restored = await restore(home, stateSnapshot);
        if (body.sessionId && !restored && !sessionExists(home, body.sessionId)) throw new Error('Cursor conversation state is missing. Restore the state snapshot or start a fresh conversation with /compact.');
        resumeInfo = { snapshot, stateSnapshot, sessionId: body.sessionId || '' };
        await restoreWorkspace(snapshot, workDir, send);
        const parsed = parseRunnerRepos(body.repos);
        if (!parsed.ok) throw new Error(parsed.error);
        await cloneRunnerRepos(parsed.repos, workDir, send);
        await writeInputFilesAsync(workDir, body.inputFiles, send);
        try { applyCursorRules(workDir, parseCursorFiles(body.cursorConfig ?? [])); }
        catch (e) { send({ type: 'status', text: `Your Cursor rules were not applied: ${(e as Error).message}` }); }
        // Project MCP integrations carry sign-in headers; Cursor reads its MCP list from a file the agent could read, so they are not passed to it.
        if (Array.isArray(body.mcpServers) && body.mcpServers.length) send({ type: 'status', text: 'MCP integrations are not available to Cursor sessions yet; continuing without them.' });
        const result = await driveCursorTurn({
          args: cursorArgs({ trusted: body.trusted === true, model: body.model || null, resumeId: body.sessionId || null }),
          prompt: body.prompt, cwd: workDir, env: environment(auth),
          emit: (eventType, payload) => send({ type: 'portal-event', eventType, payload }),
          signal: controller.signal, heartbeatLabel: 'Cursor',
          onSession: (id) => { if (resumeInfo) resumeInfo.sessionId = id; },
        });
        usage = result.state.usage ?? undefined; modelUsed = result.state.model ?? undefined;
        if (controller.signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
        const failure = turnFailure(result);
        if (failure) throw new Error(failure);
        if (body.checks) send({ type: 'check-result', ...await runCheckSteps(validateCheckSteps(body.checks), workDir) });
        emitRunnerFiles(workDir, send);
        if (body.finalizeCheck) await reportRepoChanges(body.repos, workDir, send);
        await flushWorkspace(snapshot, workDir);
        const stateSaved = await save(home, stateSnapshot);
        if (stateSnapshot && !stateSaved) throw new Error('Cursor conversation state was not saved');
        send({ type: 'result', exitCode: 0, text: result.state.resultText ?? result.state.text, sessionId: result.state.sessionId ?? resumeInfo.sessionId,
          model: modelUsed ?? '', ...(usage ? { usage } : {}), stateSaved });
      }
    } catch (error) {
      const aborted = controller.signal.aborted || (error as Error).name === 'AbortError';
      // Esc or Stop: the turn is ended but the conversation is kept, so the next message goes on from it.
      let kept: { stateSaved: boolean; sessionId: string } | null = null;
      if (aborted && resumeInfo?.sessionId) {
        try {
          await flushWorkspace(resumeInfo.snapshot, workDir);
          kept = { stateSaved: await save(home, resumeInfo.stateSnapshot), sessionId: resumeInfo.sessionId };
        } catch { kept = null; }
      }
      const message = error instanceof CursorArgError ? error.message : String((error as Error).message).slice(0, 500);
      send({ type: 'error', message: aborted ? 'Cursor run cancelled' : 'Cursor runner failed: ' + message });
      send({ type: 'result', exitCode: aborted ? 130 : 1, cancelled: aborted, ...(kept ?? {}), ...(usage ? { usage } : {}), ...(modelUsed ? { model: modelUsed } : {}) });
    } finally {
      clearInterval(heartbeat);
      active = null; res.off('close', disconnected); res.end();
    }
  });
  terminal.attach(server);
  return server;
}
