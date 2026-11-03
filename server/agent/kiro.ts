/**
 * Kiro engine — runs agent workflows via kiro-cli ACP (Agent Client Protocol).
 *
 * Primary path: `kiro-cli acp` — JSON-RPC 2.0 over stdio.
 *   initialize → session/new {cwd} → session/prompt {sessionId, prompt}
 *   → stream session/update notifications → session/prompt response.
 *
 * Fallback: `kiro-cli chat --no-interactive` when ACP is unsupported (older CLI).
 *   Detected once per process and cached.
 *
 * Auth: KIRO_API_KEY from portal settings, or KIRO_TEST_DB_PATH for IDC.
 *
 * Event mapping (ACP → portal):
 *   agent_message_chunk  → assistant-text  {text}
 *   agent_thought_chunk  → agent-thought   {text}
 *   tool_call            → tool-start      {toolCallId, toolName, toolInput, status}
 *   tool_call_update     → tool-end        {toolCallId, toolName, status, output}
 *   plan                 → plan            {entries}
 *   usage_update         → (internal: credits recorded)
 *   image content        → browser-screenshot {screenshotBase64, url?}
 *   browser tool rawInput → browser-navigate  {url}
 *   turn start/end       → status          {state:'thinking'|'idle'}
 *   session/request_permission → approval flow → option response
 */

import { getCredentialsRepository } from '../repositories/credentials.ts';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run as dbRun, insert, one, getDb, all } from '../db.ts';
import type { Row } from '../db.ts';
import { now, generateId, HttpError } from '../util.ts';
import { getAgentEnv, getSettings, getSetting } from '../settings.ts';
import { guardToolCall } from './guard.ts';
import {
  resolveCredentialEnv,
  IDC_TOKEN_KEY, IDC_REGION_KEY, IDC_EXPIRY_KEY, IDC_START_URL_KEY,
  IDC_REFRESH_TOKEN_KEY, IDC_CLIENT_ID_KEY, IDC_CLIENT_SECRET_KEY,
  IDC_CLIENT_SECRET_EXPIRES_AT_KEY, IDC_PROFILE_ARN_KEY, IDC_PROFILE_NAME_KEY,
  refreshIdcCredentialToken,
} from '../credentials.ts';
import { getRunHomeDir } from '../user-config.ts';
import { buildConversationRecap } from './recap.ts';
import type { RunContext } from './types.ts';
import { createRunToken, revokeRunToken } from '../delegation.ts';
import { getDelegationSettingsRepository } from '../repositories/delegation-settings.ts';
import { config } from '../config.ts';
import {
  materialiseKiroAuthDb, cleanupKiroAuthDb, KIRO_TEST_DB_ENV, readKiroAuthDbToken,
} from '../kiro-idc.ts';
import { checkKiroIdcHookSupport } from '../kiro-idc-check.ts';
import { resolveKiroCmd } from '../kiro-cmd.ts';
import {
  rewritePlaywrightMcpHeadless,
  hasPlaywrightMcpEntry,
  rewritePlaywrightMcpCdp,
} from './browser-headless.ts';
import {
  launchSessionBrowser,
  shutdownSessionBrowser,
  markAgentActivity,
} from './browser-manager.ts';
import {
  runKiroViaAgentCore,
  saveRefreshedTokenConditional,
} from './kiro-agentcore.ts';
import type { KiroTokenPayload } from './kiro-agentcore.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Screenshot base64 data cap: 1 MB decoded ≈ 1.33 MB base64. */
const MAX_SCREENSHOT_BASE64_LEN = 1_400_000;

/** Kiro is assumed to be working if no update arrives within this interval. */
const FALLBACK_HEARTBEAT_MS = 30_000;

// ── ACP support detection ─────────────────────────────────────────────────────

let _acpSupportPromise: Promise<boolean> | null = null;

/**
 * Returns true if the installed kiro-cli supports the `acp` subcommand.
 * Result is cached for the lifetime of the process in production.
 *
 * In test mode (PORTAL_KIRO_FAKE set): always re-evaluates based on current
 * env vars (no caching) so tests can toggle PORTAL_KIRO_TEXT_MODE freely.
 * In production: spawns `kiro-cli acp --help` to probe support and caches.
 */
function isAcpSupported(): Promise<boolean> {
  // Test mode: always re-check; env vars may change between test suites
  if (process.env.PORTAL_KIRO_FAKE) {
    return Promise.resolve(!process.env.PORTAL_KIRO_TEXT_MODE && !process.env.PORTAL_KIRO_LEGACY);
  }

  if (process.env.PORTAL_KIRO_TEXT_MODE) return Promise.resolve(false);
  if (process.env.PORTAL_KIRO_LEGACY) return Promise.resolve(false);

  if (_acpSupportPromise) return _acpSupportPromise;
  _acpSupportPromise = new Promise<boolean>((resolve) => {
    const { cmd, fullArgs } = resolveKiroCmd(['acp', '--help']);
    try {
      const child = spawn(cmd, fullArgs, { stdio: 'ignore', shell: false, windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      setTimeout(() => { try { child.kill(); } catch { /* ok */ } resolve(false); }, 5_000).unref();
    } catch {
      resolve(false);
    }
  });
  return _acpSupportPromise;
}

// ── Availability check ────────────────────────────────────────────────────────

function spawnCheck(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', shell: false, windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      setTimeout(() => { try { child.kill(); } catch { /* ok */ } resolve(false); }, 5_000).unref();
    } catch {
      resolve(false);
    }
  });
}

async function assertKiroAvailable(): Promise<void> {
  const ok = await spawnCheck('kiro-cli', ['--version']);
  if (!ok) {
    throw new HttpError(
      502,
      'kiro-cli is not installed or not on PATH. ' +
        'Install it via Settings › Tool packs › Kiro CLI, or visit https://kiro.dev/downloads.',
    );
  }
}

// ── JSON-RPC 2.0 ACP client ───────────────────────────────────────────────────

type JsonRpcPending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type ServerRequestHandler = (method: string, params: unknown, id: number) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

interface AcpClient {
  sendRequest(method: string, params?: unknown): Promise<unknown>;
  sendNotification(method: string, params?: unknown): void;
  sendResponse(id: number, result: unknown): void;
  sendError(id: number, code: number, message: string): void;
  onNotification(handler: NotificationHandler): void;
  onServerRequest(handler: ServerRequestHandler): void;
  close(): void;
}

function createAcpClient(child: ReturnType<typeof spawn>): AcpClient {
  let nextId = 1;
  let lineBuf = '';
  const pending = new Map<number, JsonRpcPending>();
  const notifHandlers: NotificationHandler[] = [];
  let reqHandler: ServerRequestHandler | null = null;

  function writeLine(obj: unknown): void {
    try {
      child.stdin?.write(JSON.stringify(obj) + '\n');
    } catch {
      // stdin may already be closed on abort
    }
  }

  function handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if ('id' in msg && 'method' in msg) {
      // Server → client request (e.g. session/request_permission)
      const id = msg.id as number;
      const method = String(msg.method);
      const params = msg.params;
      if (reqHandler) {
        reqHandler(method, params, id).then(
          (result) => writeLine({ jsonrpc: '2.0', id, result }),
          (err: unknown) => writeLine({ jsonrpc: '2.0', id, error: { code: -32000, message: String((err as Error)?.message ?? err) } }),
        );
      } else {
        writeLine({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      }
    } else if ('id' in msg && ('result' in msg || 'error' in msg)) {
      // Response to a client request
      const id = msg.id as number;
      const p = pending.get(id);
      if (p) {
        pending.delete(id);
        if (msg.error) {
          const e = msg.error as { code: number; message: string; data?: string };
          const detail = e.data ? ` (${e.data})` : '';
          p.reject(new Error(`ACP error ${e.code}: ${e.message}${detail}`));
        } else {
          p.resolve(msg.result);
        }
      }
    } else if ('method' in msg) {
      // Notification from server (no id)
      const method = String(msg.method);
      for (const h of notifHandlers) {
        try { h(method, msg.params); } catch { /* handler errors must not crash */ }
      }
    }
  }

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    lineBuf += chunk;
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl).trimEnd();
      lineBuf = lineBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  // Reject all pending requests when process closes
  child.on('close', () => {
    for (const p of pending.values()) {
      p.reject(new Error('kiro-cli process exited before responding'));
    }
    pending.clear();
  });

  return {
    sendRequest(method, params) {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writeLine({ jsonrpc: '2.0', id, method, params });
      });
    },
    sendNotification(method, params) {
      writeLine(params !== undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method });
    },
    sendResponse(id, result) {
      writeLine({ jsonrpc: '2.0', id, result });
    },
    sendError(id, code, message) {
      writeLine({ jsonrpc: '2.0', id, error: { code, message } });
    },
    onNotification(handler) {
      notifHandlers.push(handler);
    },
    onServerRequest(handler) {
      reqHandler = handler;
    },
    close() {
      try { child.stdin?.end(); } catch { /* ok */ }
    },
  };
}

// ── ACP update → portal event mapping ────────────────────────────────────────

const BROWSER_TOOL_NAMES_RE = /browser|playwright|navigate|screenshot|snapshot/i;

type AcpContentBlock = { type: string; text?: string; data?: string; mimeType?: string; uri?: string; content?: AcpContentBlock };

interface SessionUpdatePayload {
  sessionUpdate: string;
  /**
   * ACP sends `content` as a single block for message/thought chunks
   * ({type:'text', text}) and as an array for tool calls, where each item is
   * usually wrapped: {type:'content', content:{type:'text'|'image', …}}.
   */
  content?: AcpContentBlock | AcpContentBlock[];
  toolCallId?: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  entries?: Array<{ content: string; priority?: string; status?: string }>;
  used?: number;
  cost?: { amount: number; currency: string };
}

/** Normalise ACP content (single block or array, possibly wrapped) to a flat list of blocks. */
function contentBlocks(content: SessionUpdatePayload['content']): AcpContentBlock[] {
  if (!content) return [];
  const list = Array.isArray(content) ? content : [content];
  return list
    .map((c) => (c && c.type === 'content' && c.content ? c.content : c))
    .filter((c): c is AcpContentBlock => Boolean(c) && typeof c === 'object');
}

function extractTextFromContent(content: SessionUpdatePayload['content']): string {
  return contentBlocks(content)
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('');
}

function extractImagesFromContent(content: SessionUpdatePayload['content']): Array<{ data: string; mimeType: string }> {
  return contentBlocks(content)
    .filter((c) => c.type === 'image' && c.data)
    .map((c) => ({ data: c.data!, mimeType: c.mimeType ?? 'image/png' }));
}

function parseRawInput(rawInput: unknown): Record<string, unknown> {
  if (!rawInput) return {};
  if (typeof rawInput === 'object') return rawInput as Record<string, unknown>;
  if (typeof rawInput === 'string') {
    try { return JSON.parse(rawInput) as Record<string, unknown>; } catch { /* ok */ }
  }
  return {};
}

function parseRawOutput(rawOutput: unknown): string {
  if (!rawOutput) return '';
  if (typeof rawOutput === 'string') return rawOutput;
  return JSON.stringify(rawOutput);
}

function handleAcpUpdate(
  update: SessionUpdatePayload,
  ctx: RunContext,
  textParts: string[],
  lastUrl: { value: string | null },
  toolNames: Map<string, string> = new Map(),
): void {
  const { emit } = ctx;
  const type = update.sessionUpdate;

  switch (type) {
    case 'agent_message_chunk': {
      const text = extractTextFromContent(update.content);
      if (text) {
        // ACP streams partial text (often mid-word). `stream: true` tells the
        // viewer to join chunks as-is instead of one line per event.
        emit('assistant-text', { text, stream: true });
        if (textParts.length) textParts[textParts.length - 1] += text;
        else textParts.push(text);
      }
      break;
    }

    case 'agent_thought_chunk': {
      const text = extractTextFromContent(update.content);
      if (text) emit('agent-thought', { text });
      break;
    }

    case 'tool_call': {
      // A tool call ends the current text segment; the next chunk starts a new one.
      if (textParts.length && textParts[textParts.length - 1] !== '') textParts.push('');
      const toolName = update.title ?? update.name ?? 'Tool';
      // tool_call_update notifications often omit the title, so remember it by id.
      if (update.toolCallId) toolNames.set(update.toolCallId, toolName);
      const input = parseRawInput(update.rawInput);
      const toolInput = JSON.stringify(input);
      emit('tool-start', {
        toolCallId: update.toolCallId ?? '',
        toolName,
        toolInput,
        status: update.status ?? 'in_progress',
      });

      // Browser navigation: detect URL in rawInput
      if (BROWSER_TOOL_NAMES_RE.test(toolName)) {
        const url = String(input.url ?? input.URL ?? input.href ?? '').trim();
        if (url) {
          lastUrl.value = url;
          emit('browser-navigate', { url });
        }
      }
      break;
    }

    case 'tool_call_update': {
      const toolName = update.title ?? update.name
        ?? (update.toolCallId ? toolNames.get(update.toolCallId) : undefined)
        ?? 'Tool';
      const output = parseRawOutput(update.rawOutput).slice(0, 500);
      emit('tool-end', {
        toolCallId: update.toolCallId ?? '',
        toolName,
        status: update.status ?? 'completed',
        output,
      });

      // Browser screenshots: image content in tool_call_update. Images from any
      // browser-named tool are kept; an oversized image is skipped (a truncated
      // base64 string would not render) and a note is shown instead.
      if (BROWSER_TOOL_NAMES_RE.test(toolName)) {
        for (const img of extractImagesFromContent(update.content)) {
          if (img.data.length > MAX_SCREENSHOT_BASE64_LEN) {
            emit('status', { text: 'Browser screenshot too large to show in the portal (over 1 MB).' });
            continue;
          }
          emit('browser-screenshot', { screenshotBase64: img.data, url: lastUrl.value ?? undefined });
        }
      }
      break;
    }

    case 'plan': {
      if (update.entries && update.entries.length > 0) {
        emit('plan', { entries: update.entries });
      }
      break;
    }

    case 'usage_update':
      // Handled separately for credit tracking
      break;

    default:
      // Unknown update type — ignore
      break;
  }
}

// ── ACP runner ────────────────────────────────────────────────────────────────

async function runKiroAcp(
  ctx: RunContext,
  childEnv: NodeJS.ProcessEnv,
  extraArgs: string[],
  prompt: string,
  homeDir: string | null,
  workDir: string,
  engineSessionId: string | null,
  workflowId: string,
): Promise<{ textParts: string[]; credits: number }> {
  const { emit } = ctx;
  const textParts: string[] = [];
  let credits = 0;
  const lastUrl: { value: string | null } = { value: null };
  // toolCallId → tool name, for tool_call_update notifications that omit the title
  const toolNames = new Map<string, string>();

  // Signal start of thinking immediately
  emit('status', { state: 'thinking' });

  // Spawn kiro-cli acp
  const { cmd, fullArgs } = resolveKiroCmd(['acp', ...extraArgs]);
  const child = spawn(cmd, fullArgs, {
    cwd: workDir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2_000);
    if (process.env.PORTAL_DEBUG_SDK) process.stderr.write(`[kiro-acp] ${chunk}`);
  });

  // Abort: kill child on signal
  const onAbort = (): void => {
    try { child.kill('SIGTERM'); } catch { /* ok */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ok */ } }, 2_000).unref();
  };
  if (ctx.signal?.aborted) {
    onAbort();
  } else if (ctx.signal) {
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  }

  const acp = createAcpClient(child);

  // Fallback heartbeat: fires only if no update arrives for FALLBACK_HEARTBEAT_MS
  const heartbeatMs = Number(process.env.PORTAL_KIRO_HEARTBEAT_MS) || FALLBACK_HEARTBEAT_MS;
  let lastUpdateTime = Date.now();
  let heartbeatElapsed = 0;
  const heartbeatTimer = setInterval(() => {
    const idle = Date.now() - lastUpdateTime;
    if (idle >= heartbeatMs) {
      heartbeatElapsed += heartbeatMs;
      emit('status', { text: `Kiro is working… (${Math.round(heartbeatElapsed / 1000)}s)` });
    }
  }, heartbeatMs);
  if (typeof heartbeatTimer === 'object' && heartbeatTimer !== null && 'unref' in heartbeatTimer) {
    (heartbeatTimer as { unref(): void }).unref();
  }

  try {
    // ── ACP handshake ───────────────────────────────────────────────────────
    const initResult = await acp.sendRequest('initialize', {
      protocolVersion: '0.1',
      capabilities: {},
      clientInfo: { name: 'portal', version: '1.0' },
    }) as {
      agentCapabilities?: { loadSession?: boolean };
      capabilities?: { agentCapabilities?: { loadSession?: boolean } };
    };
    acp.sendNotification('notifications/initialized');

    // Check if the CLI supports session/load.
    // kiro-cli 2.37.0 puts agentCapabilities at the result root level.
    // Some versions nest it inside capabilities. Support both.
    const canLoadSession = Boolean(
      initResult?.agentCapabilities?.loadSession ??
      initResult?.capabilities?.agentCapabilities?.loadSession,
    );

    // ── Register handlers (before session setup so replay can be suppressed) ─
    //
    // isReplaying: set to true while session/load is in-flight (and until
    // session/prompt is about to be sent). Notifications received during that
    // window are silently dropped — they are history replays, not new events.
    let isReplaying = false;

    acp.onNotification((method, params) => {
      lastUpdateTime = Date.now();
      heartbeatElapsed = 0; // reset elapsed counter when real updates arrive

      if (isReplaying) return; // suppress replayed history from session/load

      if (method === 'session/update') {
        const p = params as { sessionId?: string; update?: SessionUpdatePayload };
        if (p?.update) {
          handleAcpUpdate(p.update, ctx, textParts, lastUrl, toolNames);
          // Track credits from usage_update
          if (p.update.sessionUpdate === 'usage_update' && p.update.cost) {
            credits = p.update.cost.amount;
          }
        }
      }
    });

    // Handle server→client requests (session/request_permission, fs/*)
    acp.onServerRequest(async (method, params, id) => {
      lastUpdateTime = Date.now();

      if (method === 'session/request_permission') {
        const p = params as {
          toolCall?: { toolCallId?: string; title?: string; name?: string; rawInput?: unknown };
          options?: Array<{ optionId: string; kind: string; name: string }>;
        };
        const toolCall = p?.toolCall ?? {};
        const options = p?.options ?? [];
        const toolName = toolCall.title ?? toolCall.name ?? 'Tool';
        const toolInputParsed = parseRawInput(toolCall.rawInput);

        // Guard: check protected files and commands regardless of trust.
        // NOTE: This only fires for tool calls kiro-cli escalates for permission.
        // Kiro CLI gap: file writes that kiro-cli performs without asking for
        // permission (e.g. writes it deems safe) bypass this check. A post-run
        // verification of .claude/ and .git/ directories would be needed for full
        // coverage. Pre-run setup can also write-protect these paths at the OS level.
        const guardReason = guardToolCall(toolName, toolInputParsed, workDir);
        if (guardReason) {
          const denyOpt = options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
          const chosenOptionId = denyOpt?.optionId ?? options[options.length - 1]?.optionId ?? 'reject_once';
          emit('tool-blocked', { toolName, toolInput: JSON.stringify(toolInputParsed), reason: guardReason });
          return { optionId: chosenOptionId };
        }

        let chosenOptionId: string;

        if (ctx.run.trusted) {
          // Trusted run → auto-allow
          const allowOpt = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
          chosenOptionId = allowOpt?.optionId ?? options[0]?.optionId ?? 'allow_once';
        } else {
          // Untrusted → ask user via approval flow
          let decision: 'allow' | 'deny';
          try {
            const resp = await ctx.awaitInput(toolName, toolInputParsed);
            decision = resp.decision;
          } catch {
            decision = 'deny';
          }
          if (decision === 'allow') {
            const allowOpt = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
            chosenOptionId = allowOpt?.optionId ?? options[0]?.optionId ?? 'allow_once';
          } else {
            const denyOpt = options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
            chosenOptionId = denyOpt?.optionId ?? options[options.length - 1]?.optionId ?? 'reject_once';
          }
        }

        return { optionId: chosenOptionId };
      }

      // Unhandled server request
      throw new Error(`Unhandled server request: ${method}`);
    });

    // ── Session setup (load or new) ─────────────────────────────────────────
    let sessionId: string;
    let activePrompt = prompt;

    if (engineSessionId && canLoadSession) {
      // Try to resume the previous session
      isReplaying = true;
      try {
        const loadResult = await acp.sendRequest('session/load', {
          sessionId: engineSessionId,
          cwd: workDir,
          mcpServers: [],
        }) as { sessionId?: string };
        const loadedId = loadResult?.sessionId ?? engineSessionId;
        sessionId = loadedId;
        // Store immediately (before prompt) so a crash still preserves the ID
        const repo = getSessionsRepository();
        await repo.updateWorkflow(workflowId, {
          engine_session_id: sessionId,
          engine_session_engine: 'kiro',
          updated_at: now(),
        });
        emit('status', { text: 'Continuing the previous Kiro session' });
      } catch (loadErr: unknown) {
        const reason = String((loadErr as Error)?.message ?? loadErr).slice(0, 200);
        // Fallback: new session + recap of prior conversation
        const recap = await buildConversationRecap(workflowId, ctx.run.runId);
        if (recap) activePrompt = recap + prompt;
        emit('status', { text: `Started a new session with a recap of earlier turns (could not resume: ${reason})` });
        const newResult = await acp.sendRequest('session/new', {
          cwd: workDir,
          mcpServers: [],
        }) as { sessionId?: string };
        sessionId = newResult?.sessionId ?? '';
        if (!sessionId) throw new HttpError(502, 'kiro-cli ACP did not return a sessionId');
        {
          const repoNew = getSessionsRepository();
          await repoNew.updateWorkflow(workflowId, {
            engine_session_id: sessionId,
            engine_session_engine: 'kiro',
            updated_at: now(),
          });
        }
      }
    } else {
      // No stored session ID (first run, old session before this feature, or after /clear).
      // If there are prior completed runs since the last /clear, prepend a recap so the
      // engine has context. buildConversationRecap returns '' when there's nothing to recap.
      const recap = await buildConversationRecap(workflowId, ctx.run.runId);
      if (recap) {
        activePrompt = recap + prompt;
        emit('status', { text: 'Started a new session with a recap of earlier turns' });
      }
      const sessionResult = await acp.sendRequest('session/new', {
        cwd: workDir,
        mcpServers: [],
      }) as { sessionId?: string };
      sessionId = sessionResult?.sessionId ?? '';
      if (!sessionId) throw new HttpError(502, 'kiro-cli ACP did not return a sessionId');
      // Store immediately so a crash still preserves the ID
      {
        const repoS = getSessionsRepository();
        await repoS.updateWorkflow(workflowId, {
          engine_session_id: sessionId,
          engine_session_engine: 'kiro',
          updated_at: now(),
        });
      }
    }
    // Resume/replay window is over — notifications from here on are live events
    isReplaying = false;

    // ── Send prompt ─────────────────────────────────────────────────────────
    await acp.sendRequest('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: activePrompt }],
    });

  } finally {
    clearInterval(heartbeatTimer);
    if (ctx.signal) {
      ctx.signal.removeEventListener('abort', onAbort);
    }
    acp.close();
  }

  // ── Wait for child exit ─────────────────────────────────────────────────
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        reject(new HttpError(502, 'kiro-cli was not found on PATH (ENOENT). Install it via Settings › Tool packs › Kiro CLI.'));
      } else {
        reject(new HttpError(502, `Could not start kiro-cli: ${e.message}`));
      }
    });
    child.on('close', (code) => resolve(code));
  });

  if (ctx.signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');

  if (exitCode !== 0 && exitCode !== null) {
    const tail = stderrTail.trim().slice(-500);
    throw new HttpError(502, `kiro-cli exited with code ${exitCode}.` + (tail ? ` ${tail}` : ''));
  }

  emit('status', { state: 'idle' });
  return { textParts, credits };
}

// ── Legacy (chat --no-interactive) runner ─────────────────────────────────────

interface KiroJsonLine {
  type: string;
  text?: string;
  tool?: string;
  toolInput?: string;
  toolOutput?: string;
  tokens?: number;
  credits?: number;
  [k: string]: unknown;
}

function tryParseJsonLine(line: string): KiroJsonLine | null {
  if (!line.startsWith('{')) return null;
  try { return JSON.parse(line) as KiroJsonLine; } catch { return null; }
}

function handleLegacyJsonLine(line: KiroJsonLine, ctx: RunContext, textParts: string[]): void {
  const { emit } = ctx;
  switch (line.type) {
    case 'text':
    case 'assistant_text':
    case 'message': {
      const text = String(line.text ?? '').trim();
      if (text) { emit('assistant-text', { text }); textParts.push(text); }
      break;
    }
    case 'tool_start':
    case 'tool_use': {
      const toolName = String(line.tool ?? line.toolName ?? 'Tool');
      const toolInput = typeof (line.toolInput ?? line.input) === 'string'
        ? (line.toolInput ?? line.input ?? '') as string
        : JSON.stringify(line.toolInput ?? line.input ?? '');
      emit('tool-start', { toolCallId: '', toolName, toolInput, status: 'in_progress' });
      break;
    }
    case 'tool_end':
    case 'tool_result': {
      const toolName = String(line.tool ?? line.toolName ?? 'Tool');
      const output = String(line.toolOutput ?? line.output ?? line.result ?? '').slice(0, 500);
      emit('tool-end', { toolCallId: '', toolName, status: 'completed', output });
      break;
    }
    case 'tool_blocked': {
      const toolName = String(line.tool ?? line.toolName ?? 'Tool');
      const reason = String(line.reason ?? 'Blocked');
      const toolInput = typeof (line.toolInput ?? line.input) === 'string'
        ? (line.toolInput ?? line.input ?? '') as string
        : JSON.stringify(line.toolInput ?? line.input ?? '');
      emit('tool-blocked', { toolName, toolInput, reason });
      break;
    }
    default:
      break;
  }
}

async function runKiroLegacy(
  ctx: RunContext,
  childEnv: NodeJS.ProcessEnv,
  extraArgs: string[],
  prompt: string,
  workDir: string,
): Promise<{ textParts: string[]; credits: number }> {
  const { emit } = ctx;
  const textParts: string[] = [];
  let credits = 0;

  // Legacy mode: tell the UI updates are limited
  emit('status', { state: 'thinking' });
  emit('status', { text: 'Live updates unavailable — this kiro-cli version does not support ACP. Upgrade kiro-cli for streaming.' });

  const useJson = Boolean(process.env.PORTAL_KIRO_FAKE) && !process.env.PORTAL_KIRO_TEXT_MODE;
  const jsonArgs = useJson ? ['--output-format', 'json'] : [];

  const { cmd, fullArgs } = resolveKiroCmd(['chat', '--no-interactive', ...extraArgs, ...jsonArgs]);
  const child = spawn(cmd, fullArgs, {
    cwd: workDir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const onAbort = (): void => {
    try { child.kill('SIGTERM'); } catch { /* ok */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ok */ } }, 2_000).unref();
  };
  if (ctx.signal?.aborted) {
    onAbort();
  } else if (ctx.signal) {
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    child.stdin.write(prompt + '\n');
    child.stdin.end();
  } catch { /* ok */ }

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2_000);
    if (process.env.PORTAL_DEBUG_SDK) process.stderr.write(`[kiro] ${chunk}`);
  });

  let lineBuf = '';
  let jsonModeFailed = false;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    lineBuf += chunk;
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl).trimEnd();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      if (useJson && !jsonModeFailed) {
        const parsed = tryParseJsonLine(line);
        if (parsed) {
          handleLegacyJsonLine(parsed, ctx, textParts);
          if (parsed.credits) credits = parsed.credits;
          continue;
        }
        jsonModeFailed = true;
      }
      if (line.trim()) {
        emit('assistant-text', { text: line + '\n' });
        textParts.push(line);
      }
    }
  });

  const heartbeatMs = Number(process.env.PORTAL_KIRO_HEARTBEAT_MS) || FALLBACK_HEARTBEAT_MS;
  let heartbeatElapsed = 0;
  const heartbeatTimer = setInterval(() => {
    heartbeatElapsed += heartbeatMs;
    emit('status', { text: `Kiro is working… (${Math.round(heartbeatElapsed / 1000)}s)` });
  }, heartbeatMs);
  if (typeof heartbeatTimer === 'object' && heartbeatTimer !== null && 'unref' in heartbeatTimer) {
    (heartbeatTimer as { unref(): void }).unref();
  }

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') {
          reject(new HttpError(502, 'kiro-cli was not found on PATH (ENOENT). Install it via Settings › Tool packs › Kiro CLI.'));
        } else {
          reject(new HttpError(502, `Could not start kiro-cli: ${e.message}`));
        }
      });
      child.on('close', (code) => resolve(code));
    });
  } finally {
    clearInterval(heartbeatTimer);
    if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
  }

  if (ctx.signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');

  if (lineBuf.trim()) {
    emit('assistant-text', { text: lineBuf.trim() + '\n' });
    textParts.push(lineBuf.trim());
  }

  if (exitCode !== 0 && exitCode !== null) {
    const tail = stderrTail.trim().slice(-500);
    throw new HttpError(502, `kiro-cli exited with code ${exitCode}.` + (tail ? ` ${tail}` : ''));
  }

  emit('status', { state: 'idle' });
  return { textParts, credits };
}

// ── Review instructions ───────────────────────────────────────────────────────

const REVIEW_INSTRUCTIONS = `
You are performing a code review. Read diff.patch (if present) and the source files it touches.
Identify real defects, security risks, reliability issues, and best-practice violations.

At the end of your response output all findings as a JSON array in a markdown code block:

\`\`\`json
[
  {
    "file": "path/to/file.ext",
    "line": 42,
    "severity": "critical|high|medium|low|info",
    "title": "Short description",
    "body": "Detailed explanation and suggestion.",
    "confidence": 0.9
  }
]
\`\`\`

Use severities: critical, high, medium, low, info.
Set confidence 0.0–1.0. Output [] when the diff is clean.
`.trim();

/**
 * The Identity Center token a Kiro runner needs, from the sentinel env vars that resolveCredentialEnv('kiro', ...) sets.
 */
export function kiroTokenFromEnv(childEnv: NodeJS.ProcessEnv): KiroTokenPayload {
  const accessToken = String(childEnv[IDC_TOKEN_KEY] ?? '');
  const idcRegion = String(childEnv[IDC_REGION_KEY] ?? 'us-east-1');
  const idcExpiry = String(childEnv[IDC_EXPIRY_KEY] ?? new Date(Date.now() + 28_800_000).toISOString());
  const idcStartUrl = String(childEnv[IDC_START_URL_KEY] ?? '');
  const idcRefreshToken = childEnv[IDC_REFRESH_TOKEN_KEY] ? String(childEnv[IDC_REFRESH_TOKEN_KEY]) : undefined;
  const idcClientId = childEnv[IDC_CLIENT_ID_KEY] ? String(childEnv[IDC_CLIENT_ID_KEY]) : undefined;
  const idcClientSecret = childEnv[IDC_CLIENT_SECRET_KEY] ? String(childEnv[IDC_CLIENT_SECRET_KEY]) : undefined;
  const idcClientSecretExpiresAt = childEnv[IDC_CLIENT_SECRET_EXPIRES_AT_KEY]
    ? Number(childEnv[IDC_CLIENT_SECRET_EXPIRES_AT_KEY]) : undefined;
  const idcProfileArn = childEnv[IDC_PROFILE_ARN_KEY] ? String(childEnv[IDC_PROFILE_ARN_KEY]) : undefined;
  const idcProfileName = childEnv[IDC_PROFILE_NAME_KEY] ? String(childEnv[IDC_PROFILE_NAME_KEY]) : undefined;
  return {
    accessToken,
    expiresAt: idcExpiry,
    region: idcRegion,
    startUrl: idcStartUrl,
    ...(idcRefreshToken ? { refreshToken: idcRefreshToken } : {}),
    ...(idcClientId ? { clientId: idcClientId } : {}),
    ...(idcClientSecret ? { clientSecret: idcClientSecret } : {}),
    ...(idcClientSecretExpiresAt ? { clientSecretExpiresAt: idcClientSecretExpiresAt } : {}),
    ...(idcProfileArn ? { profileArn: idcProfileArn } : {}),
    ...(idcProfileName ? { profileName: idcProfileName } : {}),
  };
}

// ── AgentCore adapter ─────────────────────────────────────────────────────────

/**
 * Run kiro via the deployed AgentCore runtime instead of the local kiro-cli.
 * Called from runKiro() when PORTAL_KIRO_AGENTCORE_RUNTIME_ARN is set and the
 * credential is an Identity Center credential.
 */
async function runKiroViaAgentCoreAdapter(
  ctx: RunContext,
  runtimeArn: string,
  childEnv: NodeJS.ProcessEnv,
): Promise<string> {
  const { run, emit } = ctx;

  // Capture the current stored ciphertext for the conditional token write-back.
  // If another run saves a newer token before this run finishes, we skip the update.
  let expectedCiphertext: string | null = null;
  if (run.credentialId) {
    try {
      const credRow = await getCredentialsRepository().getById(run.credentialId);
      expectedCiphertext = credRow?.secret_enc ?? null;
    } catch { /* non-fatal */ }
  }

  // Build prompt (same logic as the local path)
  let prompt = run.goal;
  if (run.kind === 'review') {
    prompt = `${run.goal}\n\n${REVIEW_INSTRUCTIONS}`;
  }
  // Every AgentCore session starts fresh, so earlier turns are passed along as a recap.
  const recap = await buildConversationRecap(run.workflowId, run.runId);
  if (recap) {
    prompt = recap + prompt;
    emit('status', { text: 'Included a recap of earlier turns' });
  }

  const token = kiroTokenFromEnv(childEnv);

  const { textParts, credits: kiroCredits } = await runKiroViaAgentCore(ctx, {
    runtimeArn,
    runId: run.runId,
    prompt,
    token,
    credentialId: run.credentialId,
    expectedCiphertext,
    browser: process.env.PORTAL_AGENTCORE_BROWSER === '1',
    repos: run.runnerRepos,
    mcpServers: run.runnerMcpServers,
  });

  if (ctx.signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');

  // Persist run stats (same as the local path)
  const approxCostUsd = Number(kiroCredits.toFixed(4));
  const repoKiro = getSessionsRepository();
  await repoKiro.updateRun(run.runId, {
    cost_usd: approxCostUsd,
    input_tokens: 0,
    output_tokens: 0,
    model: run.model ?? run.leadAgent ?? 'kiro',
  });

  if (approxCostUsd > 0) {
    const { getBudgetRepository } = await import('../repositories/budget.ts');
    const wfRow = await repoKiro.getWorkflowById(run.workflowId);
    await getBudgetRepository().record({
      user_id: wfRow?.created_by ?? null,
      project_id: run.projectId,
      workflow_id: run.workflowId,
      run_id: null,
      cost_usd: approxCostUsd,
      input_tokens: 0,
      output_tokens: 0,
      provider: 'kiro',
      model: run.leadAgent ?? 'kiro-default',
      created_at: now(),
    });
  }

  const summary = textParts.join('\n').trim() || 'Kiro run complete.';
  emit('run-complete', { result: summary, cost_usd: approxCostUsd });
  return summary;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run a workflow using kiro-cli (ACP by default, legacy chat fallback).
 * When PORTAL_KIRO_AGENTCORE_RUNTIME_ARN is set and the credential is an
 * Identity Center credential, the run goes to AgentCore instead.
 * Emits events via ctx.emit() and returns the final summary text.
 */
export async function runKiro(ctx: RunContext): Promise<string> {
  const { run, emit } = ctx;

  // ── Build env ──────────────────────────────────────────────────────────────
  const agentEnv = await resolveCredentialEnv('kiro', run.credentialOwnerId, run.credentialId);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...agentEnv };

  // ── AgentCore path ─────────────────────────────────────────────────────────
  // When configured and the credential is an Identity Center credential,
  // route the run through the deployed AgentCore runtime instead of local kiro-cli.
  const agentCoreRuntimeArn = process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN;
  if (agentCoreRuntimeArn && childEnv[IDC_TOKEN_KEY]) {
    return runKiroViaAgentCoreAdapter(ctx, agentCoreRuntimeArn, childEnv);
  }

  // D-12: fail with a clear error if kiro-cli is not installed.
  if (!process.env.PORTAL_KIRO_FAKE) {
    await assertKiroAvailable();
  }

  // ── Wire materialised home dir (F5) ────────────────────────────────────────
  const homeDir = getRunHomeDir(run.runId);
  if (homeDir) {
    childEnv.HOME = homeDir;
  }

  // ── IDC token file delivery (F4) ───────────────────────────────────────────
  let kiroAuthTmpDir: string | null = null;
  let originalIdcToken: string | null = null;
  if (childEnv[IDC_TOKEN_KEY]) {
    const idcToken = String(childEnv[IDC_TOKEN_KEY]);
    originalIdcToken = idcToken;
    const idcRegion = String(childEnv[IDC_REGION_KEY] ?? 'us-east-1');
    const idcExpiry = String(childEnv[IDC_EXPIRY_KEY] ?? new Date(Date.now() + 28_800_000).toISOString());
    const idcStartUrl = String(childEnv[IDC_START_URL_KEY] ?? '');
    const idcRefreshToken = childEnv[IDC_REFRESH_TOKEN_KEY] ? String(childEnv[IDC_REFRESH_TOKEN_KEY]) : undefined;
    const idcClientId = childEnv[IDC_CLIENT_ID_KEY] ? String(childEnv[IDC_CLIENT_ID_KEY]) : undefined;
    const idcClientSecret = childEnv[IDC_CLIENT_SECRET_KEY] ? String(childEnv[IDC_CLIENT_SECRET_KEY]) : undefined;
    const idcClientSecretExpiresAt = childEnv[IDC_CLIENT_SECRET_EXPIRES_AT_KEY]
      ? Number(childEnv[IDC_CLIENT_SECRET_EXPIRES_AT_KEY]) : undefined;

    if (homeDir) {
      try {
        const ssoCacheDir = path.join(homeDir, '.aws', 'sso', 'cache');
        await fsp.mkdir(ssoCacheDir, { recursive: true });
        await fsp.writeFile(
          path.join(ssoCacheDir, 'device-sso-lsp-token.json'),
          JSON.stringify({ accessToken: idcToken, expiresAt: idcExpiry, region: idcRegion }),
          'utf8',
        );
      } catch { /* Non-fatal */ }
    }

    const hookCheck = await checkKiroIdcHookSupport();
    if (!hookCheck.supported) {
      throw new HttpError(502,
        hookCheck.error ??
          `Your Kiro IAM Identity Center credential cannot be isolated from the portal machine's own ` +
          `kiro-cli session (kiro-cli ${hookCheck.version} does not honour the per-user authentication hook). ` +
          'Use a Kiro API key credential instead.',
      );
    }

    try {
      const idcProfileArn = childEnv[IDC_PROFILE_ARN_KEY] ? String(childEnv[IDC_PROFILE_ARN_KEY]) : undefined;
      const idcProfileName = childEnv[IDC_PROFILE_NAME_KEY] ? String(childEnv[IDC_PROFILE_NAME_KEY]) : undefined;
      const authDb = await materialiseKiroAuthDb({
        accessToken: idcToken,
        expiresAt: idcExpiry,
        region: idcRegion,
        startUrl: idcStartUrl,
        refreshToken: idcRefreshToken,
        clientId: idcClientId,
        clientSecret: idcClientSecret,
        clientSecretExpiresAt: idcClientSecretExpiresAt,
        profileArn: idcProfileArn,
        profileName: idcProfileName,
      });
      kiroAuthTmpDir = authDb.tmpDir;
      childEnv[KIRO_TEST_DB_ENV] = authDb.dbPath;
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      throw new HttpError(502,
        `Could not create the per-user Kiro authentication database: ${msg}. ` +
          'Ensure the system temp directory is writable and try again.',
      );
    }

    delete childEnv[IDC_TOKEN_KEY];
    delete childEnv[IDC_REGION_KEY];
    delete childEnv[IDC_EXPIRY_KEY];
    delete childEnv[IDC_START_URL_KEY];
    delete childEnv[IDC_REFRESH_TOKEN_KEY];
    delete childEnv[IDC_CLIENT_ID_KEY];
    delete childEnv[IDC_CLIENT_SECRET_KEY];
    delete childEnv[IDC_CLIENT_SECRET_EXPIRES_AT_KEY];
    delete childEnv[IDC_PROFILE_ARN_KEY];
    delete childEnv[IDC_PROFILE_NAME_KEY];
  }

  // ── Build CLI args ─────────────────────────────────────────────────────────
  const extraArgs: string[] = [];
  if (run.trusted) extraArgs.push('--trust-all-tools');
  if (run.leadAgent) extraArgs.push('--agent', run.leadAgent);

  if (run.model) {
    extraArgs.push('--model', run.model);
  } else {
    const settings = getSettings();
    if (settings.provider.mode === 'kiro') {
      const dm = (getSetting(getDb(), 'default.model') ?? '').trim();
      if (dm && dm !== 'auto') extraArgs.push('--model', dm);
    }
  }

  // ── Delegation: merge portal-delegation MCP into materialised home (F7) ────
  let delegationTokenId: string | null = null;
  let delegationUserId: string | null = null;
  if (homeDir && run.credentialOwnerId) {
    try {
      const delegationSettings = await getDelegationSettingsRepository().get();
      if (delegationSettings.enabled) {
        const { raw: tokenRaw, tokenId } = await createRunToken(run.credentialOwnerId, run.workflowId);
        delegationTokenId = tokenId;
        delegationUserId = run.credentialOwnerId;

        const newEntry = {
          url: `http://127.0.0.1:${config.port}/api/mcp`,
          headers: { Authorization: `Bearer ${tokenRaw}` },
        };

        const settingsDir = path.join(homeDir, '.kiro', 'settings');
        await fsp.mkdir(settingsDir, { recursive: true });
        const mcpJsonPath = path.join(settingsDir, 'mcp.json');

        let existingConfig: { mcpServers?: Record<string, unknown> } = {};
        let skipDelegation = false;
        try {
          const existing = await fsp.readFile(mcpJsonPath, 'utf8').catch(() => '');
          if (existing.trim()) existingConfig = JSON.parse(existing) as typeof existingConfig;
        } catch {
          emit('run', {
            text: 'Portal delegation skipped: ~/.kiro/settings/mcp.json contains invalid JSON.',
          });
          revokeRunToken(tokenId, run.credentialOwnerId).catch(() => {/* non-fatal */});
          delegationTokenId = null;
          delegationUserId = null;
          skipDelegation = true;
        }

        if (!skipDelegation) {
          const merged = {
            ...existingConfig,
            mcpServers: {
              ...(existingConfig.mcpServers ?? {}),
              'portal-delegation': newEntry,
            },
          };
          await fsp.writeFile(mcpJsonPath, JSON.stringify(merged, null, 2), 'utf8');
        }
      }
    } catch { /* Non-fatal */ }
  }

  // ── Live browser + Playwright MCP rewrite ──────────────────────────────────
  // When the materialised mcp.json contains a @playwright/mcp entry, start the
  // portal-managed live browser and rewrite the entry to use --cdp-endpoint so
  // the agent connects to it.  Fall back to the plain --headless rewrite if the
  // browser cannot be started (e.g. cap reached or Chromium unavailable).
  if (homeDir) {
    const mcpJsonPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json');
    const hasMcp = await hasPlaywrightMcpEntry(mcpJsonPath);
    if (hasMcp) {
      let cdpEndpoint: string | null = null;
      try {
        cdpEndpoint = await launchSessionBrowser(run.workflowId, run.workDir);
      } catch (launchErr: unknown) {
        emit('status', {
          text: `Live browser unavailable — ${String((launchErr as Error)?.message ?? launchErr)}. Falling back to headless.`,
        });
      }
      if (cdpEndpoint) {
        const rewrote = await rewritePlaywrightMcpCdp(mcpJsonPath, run.workDir, cdpEndpoint);
        if (!rewrote) {
          // CDP rewrite failed (parse error, write error) — fall back to headless
          emit('status', { text: 'Live browser rewrite failed. Falling back to headless.' });
          await rewritePlaywrightMcpHeadless(mcpJsonPath, run.workDir);
        }
      } else {
        await rewritePlaywrightMcpHeadless(mcpJsonPath, run.workDir);
      }
    } else {
      // No playwright entry present — existing headless rewrite is a no-op but
      // keeps idempotent behaviour for entries that already have --headless.
      await rewritePlaywrightMcpHeadless(mcpJsonPath, run.workDir);
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────────
  let prompt = run.goal;
  if (run.kind === 'review') {
    prompt = `${run.goal}\n\n${REVIEW_INSTRUCTIONS}`;
  }

  // ── Run (ACP or legacy) ────────────────────────────────────────────────────
  let textParts: string[];
  let kiroCredits: number;

  markAgentActivity(run.workflowId); // keep live browser alive while run executes
  const acpOk = await isAcpSupported();
  try {
    if (acpOk) {
      //       // kiro-cli ACP saves sessions to %USERPROFILE%\.kiro\sessions\cli\ on the
      // real user profile. The materialised temp HOME never contains Kiro session
      // data, so no restore step is needed here.
      ({ textParts, credits: kiroCredits } = await runKiroAcp(
        ctx, childEnv, extraArgs, prompt, homeDir, run.workDir,
        run.engineSessionId, run.workflowId,
      ));
    } else {
      ({ textParts, credits: kiroCredits } = await runKiroLegacy(ctx, childEnv, extraArgs, prompt, run.workDir));
    }
  } finally {
    // Always clean up delegation token and materialised secrets
    if (delegationTokenId && delegationUserId) {
      await revokeRunToken(delegationTokenId, delegationUserId);
      delegationTokenId = null;
      delegationUserId = null;
    }

    if (homeDir) {
      const mcpJsonPath = path.join(homeDir, '.kiro', 'settings', 'mcp.json');
      try {
        const raw = await fsp.readFile(mcpJsonPath, 'utf8').catch(() => '');
        if (raw.trim()) {
          const cfg = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
          if (cfg.mcpServers?.['portal-delegation']) {
            delete cfg.mcpServers['portal-delegation'];
            await fsp.writeFile(mcpJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
          }
        }
      } catch { /* Non-fatal */ }

      const awsDir = path.join(homeDir, '.aws');
      try { await fsp.rm(awsDir, { recursive: true, force: true }); } catch { /* Non-fatal */ }
    }

    if (kiroAuthTmpDir) {
      if (run.credentialId && originalIdcToken) {
        try {
          const dbPath = path.join(kiroAuthTmpDir, 'data.sqlite3');
          const newToken = readKiroAuthDbToken(dbPath);
          if (newToken && newToken.access_token !== originalIdcToken) {
            await refreshIdcCredentialToken(
              run.credentialId,
              newToken.access_token,
              newToken.expires_at,
              newToken.refresh_token,
            );
          }
        } catch { /* Non-fatal */ }
      }
      await cleanupKiroAuthDb(kiroAuthTmpDir);
      kiroAuthTmpDir = null;
    }
  }

  if (ctx.signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');

  // ── Persist run stats ──────────────────────────────────────────────────────
  const approxCostUsd = Number(kiroCredits.toFixed(4));
  const repoKiro2 = getSessionsRepository();
  await repoKiro2.updateRun(run.runId, {
    cost_usd: approxCostUsd,
    input_tokens: 0,
    output_tokens: 0,
    model: run.model ?? run.leadAgent ?? 'kiro',
  });

  if (approxCostUsd > 0) {
    const { getBudgetRepository } = await import('../repositories/budget.ts');
    const wfRowK = await repoKiro2.getWorkflowById(run.workflowId);
    await getBudgetRepository().record({
      user_id: wfRowK?.created_by ?? null,
      project_id: run.projectId,
      workflow_id: run.workflowId,
      run_id: null,
      cost_usd: approxCostUsd,
      input_tokens: 0,
      output_tokens: 0,
      provider: 'kiro',
      model: run.leadAgent ?? 'kiro-default',
      created_at: now(),
    });
  }

  const summary = textParts.join('\n').trim() || 'Kiro run complete.';
  emit('run-complete', { result: summary, cost_usd: approxCostUsd });
  return summary;
}
