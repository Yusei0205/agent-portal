import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../../server/codex-client.ts';
import { driveCodexTurn, type CodexSessionContext } from '../../server/agent/codex-session.ts';
import { ApprovalBroker, parseApprovalAnswer } from '../../server/agent/agentcore-approvals.ts';
import { inputFingerprint, toPolicyRules } from '../../server/agent/tool-policy.ts';
import { cloneRunnerRepos, parseRunnerRepos } from '../../server/agent/runner-repos.ts';
import { parseSnapshot, restoreWorkspace, flushWorkspaceStrict as flushWorkspace } from '../../server/agent/runner-snapshot.ts';
import { inspectWorkspace } from '../../server/agent/runner-inspect.ts';
import { runFinalize, validateFinalizeRequest, reportRepoChanges } from '../../server/agent/runner-finalize-run.ts';
import { writeInputFiles, emitRunnerFiles } from '../../server/agent/runner-files.ts';
import { runCheckSteps, validateCheckSteps } from '../../server/agent/runner-checks.ts';
import { parseMcpServers } from '../../server/agent/runner-mcp.ts';
import { restoreCodexState, saveCodexState } from './state.ts';
import { applyCodexConfig } from '../../server/agent/codex-config.ts';

type Event = Record<string, any>;
type ServiceOptions = {
  root?: string;
  openClient?: typeof CodexClient.start;
  restoreState?: typeof restoreCodexState;
  saveState?: typeof saveCodexState;
};
const MAX_BODY = 16 * 1024 * 1024;
export function createCodexRunnerServer(options: ServiceOptions = {}): http.Server {
  const root = options.root ?? path.join(os.tmpdir(), 'agent-portal-codex');
  const workDir = path.join(root, 'work'), home = path.join(root, 'home');
  const broker = new ApprovalBroker();
  let active: { runId: string; controller: AbortController } | null = null;
  let boundWorkflow: string | null = null;
  const open = options.openClient ?? CodexClient.start;
  const environment = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    SYSTEMROOT: process.env.SYSTEMROOT, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA,
    TMP: os.tmpdir(), TEMP: os.tmpdir(), LANG: 'C.UTF-8', SSL_CERT_FILE: process.env.SSL_CERT_FILE });

  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: active ? 'HealthyBusy' : 'Healthy' })); return;
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
    if (body.mode === 'answer') {
      const answer = parseApprovalAnswer(body);
      const outcome = typeof answer === 'string' ? { ok: false, error: answer } : broker.answer(answer);
      reply({ ...outcome, type: outcome.ok ? 'answer-accepted' : 'answer-rejected' }); return;
    }
    if (body.mode === 'cancel') {
      if (!active || active.runId !== body.runId) { json(409, { error: 'Run is not active' }); return; }
      active.controller.abort(); reply({ type: 'cancelled' }); return;
    }
    if (active) { json(409, { error: 'A run is already active in this session' }); return; }
    if (!['codex-run', 'codex-text', 'codex-models', 'prepare-repos', 'inspect', 'finalize', 'flush-workspace'].includes(body.mode)) { json(400, { error: 'Unsupported mode' }); return; }
    if ('refreshToken' in body || 'refresh_token' in body || 'clientSecret' in body) { json(400, { error: 'Renewable credentials must stay in the portal' }); return; }
    if (['codex-run', 'codex-text', 'codex-models'].includes(body.mode) && (typeof body.accessToken !== 'string' || !body.accessToken || body.accessToken.length > 64_000 || /[\r\n\0]/.test(body.accessToken))) {
      json(400, { error: 'A short-lived OAuth access token is required' }); return;
    }
    if (body.mode === 'codex-text' && (typeof body.prompt !== 'string' || body.prompt.length > 250_000
      || (body.model != null && (typeof body.model !== 'string' || !/^[A-Za-z0-9._:/@-]{1,120}$/.test(body.model))))) {
      json(400, { error: 'Invalid Codex text request' }); return;
    }
    if (body.mode === 'codex-run' && (typeof body.prompt !== 'string' || body.prompt.length > 250_000
      || typeof body.workflowId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(body.workflowId)
      || typeof body.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(body.runId)
      || (body.model != null && (typeof body.model !== 'string' || !/^[A-Za-z0-9._:/@-]{1,120}$/.test(body.model)))
      || (body.threadId != null && (typeof body.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(body.threadId))))) {
      json(400, { error: 'Invalid Codex run fields' }); return;
    }
    if (body.workflowId && boundWorkflow && body.workflowId !== boundWorkflow) { json(403, { error: 'This runner is bound to another workflow' }); return; }
    if (body.workflowId) boundWorkflow = body.workflowId;
    const controller = new AbortController();
    active = { runId: body.runId || body.mode, controller };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    const secrets = [body.accessToken, ...parseMcpServers(body.mcpServers).flatMap(s => Object.values(s.headers))].filter((s): s is string => typeof s === 'string' && s.length > 0);
    const send = (event: Event) => {
      let text = JSON.stringify(event);
      for (const secret of secrets) text = text.split(secret).join('***');
      if (!res.writableEnded && !res.destroyed) res.write('data: ' + text + '\n\n');
    };
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    const heartbeat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': working\n\n'); }, 15_000);
    let client: CodexClient | undefined;
    let usage: Event | undefined;
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
      } else if (body.mode === 'codex-text') {
        const result = await driveCodexTurn({
          run: { workDir, goal: body.prompt, model: body.model || null, engineSessionId: null, trusted: false, permissions: { rules: [] } },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]), allowed: new Set(), emit: () => {},
          awaitInput: async () => ({ decision: 'deny', remember: false, message: 'Portal AI generation cannot approve tools.' }),
        }, { managedAuth: false, openClient: () => open(home, environment(), workDir, { accessToken: body.accessToken }),
          config: { 'features.shell_tool': false, 'features.multi_agent': false } });
        send({ type: 'result', exitCode: 0, text: result.text });
      } else if (body.mode === 'codex-models') {
        client = await open(home, environment(), workDir, { accessToken: body.accessToken });
        const models: Event[] = []; let cursor: string | null = null;
        do { const page = await client.request('model/list', { cursor, limit: 100 }); models.push(...(page.data ?? [])); cursor = page.nextCursor ?? null; } while (cursor);
        send({ type: 'models', models });
      } else {
        const stateSnapshot = parseSnapshot(body.stateSnapshot);
        if (body.stateSnapshot && !stateSnapshot) throw new Error('Invalid Codex conversation snapshot capability');
        const restored = await (options.restoreState ?? restoreCodexState)(home, stateSnapshot);
        if (body.threadId && !restored) throw new Error('Codex conversation state is missing. Restore the state snapshot or start a fresh thread with /compact.');
        await restoreWorkspace(snapshot, workDir, send);
        const parsed = parseRunnerRepos(body.repos);
        if (!parsed.ok) throw new Error(parsed.error);
        const repos = parsed.repos;
        await cloneRunnerRepos(repos, workDir, send);
        writeInputFiles(workDir, body.inputFiles);
        const connections = Object.fromEntries(parseMcpServers(body.mcpServers).map(s => [s.name, s]));
        const mcp = Object.fromEntries(Object.keys(connections).map(name => [name, {
          command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-proxy.mjs')],
          env_vars: ['PORTAL_MCP_CONNECTIONS_JSON'], env: { PORTAL_MCP_NAME: name },
        }]));
        const ctx: CodexSessionContext = {
          run: { workDir, goal: body.prompt, model: body.model || null, engineSessionId: body.threadId || null,
            trusted: body.trusted === true, permissions: { rules: toPolicyRules(Array.isArray(body.rules) ? body.rules : []) } },
          signal: controller.signal, allowed: new Set(), emit: (eventType, payload) => send({ type: 'portal-event', eventType, payload }),
          awaitInput: (toolName, input) => {
            const inputHash = inputFingerprint(toolName, input);
            const minutes = Number.isFinite(body.approvals?.expiryMinutes) ? Math.min(1440, Math.max(0.1, body.approvals.expiryMinutes)) : 60;
            const waiting = broker.open(body.runId, inputHash, minutes * 60_000, controller.signal);
            send({ type: 'approval-request', requestId: waiting.requestId, toolName, input, inputHash, expiresAt: waiting.expiresAt });
            return waiting.outcome;
          },
        };
        const result = await driveCodexTurn(ctx, {
          managedAuth: false,
          openClient: () => open(home, environment(), workDir, { accessToken: body.accessToken, extraEnv: { PORTAL_MCP_CONNECTIONS_JSON: JSON.stringify(connections) } }),
          ...(() => { const setup = applyCodexConfig(home, body.codexConfig ?? [], body.leadAgent); return { config: { ...setup.config, mcp_servers: mcp }, instructions: setup.instructions }; })(),
          onUsage: async value => { usage = value; },
        });
        if (controller.signal.aborted) throw new DOMException('Run cancelled', 'AbortError');
        if (body.checks) send({ type: 'check-result', ...await runCheckSteps(validateCheckSteps(body.checks), workDir) });
        emitRunnerFiles(workDir, send);
        if (body.finalizeCheck) await reportRepoChanges(body.repos, workDir, send);
        await flushWorkspace(snapshot, workDir);
        const stateSaved = await (options.saveState ?? saveCodexState)(home, stateSnapshot);
        if (stateSnapshot && !stateSaved) throw new Error('Codex conversation state was not saved');
        send({ type: 'result', exitCode: 0, ...result, stateSaved });
      }
    } catch (error) {
      const aborted = controller.signal.aborted || (error as Error).name === 'AbortError';
      send({ type: 'error', message: aborted ? 'Codex run cancelled' : 'Codex runner failed: ' + String((error as Error).message).slice(0, 500) });
      send({ type: 'result', exitCode: aborted ? 130 : 1, cancelled: aborted, ...(usage ? { usage } : {}) });
    } finally {
      clearInterval(heartbeat);
      broker.closeRun(active?.runId || '', 'The run ended');
      client?.close(); await client?.waitClosed();
      active = null; res.off('close', disconnected); res.end();
    }
  });
}
