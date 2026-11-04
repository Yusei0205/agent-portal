/**
 * kiro-agentcore.ts — AgentCore execution path for Kiro runs and IdC sign-in.
 *
 * When PORTAL_KIRO_AGENTCORE_RUNTIME_ARN is set, Kiro runs that use an
 * Identity Center credential invoke the deployed AgentCore runtime instead of
 * spawning kiro-cli locally.  The local path is unchanged when the env var is
 * absent.
 *
 * HTTP contract (InvokeAgentRuntime REST API):
 *   POST https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{arn}/invocations
 *   Headers: Content-Type: application/json
 *            Accept: text/event-stream
 *            X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: {sessionId}
 *   Body:    JSON invocation payload (kiro-run | kiro-login)
 *   Auth:    AWS SigV4, service = bedrock-agentcore
 *
 * Portal event mapping (kiro-runner SSE → portal events):
 *   text       → assistant-text  { text, stream: true }
 *   thought    → agent-thought   { text }
 *   tool       → tool-start      { toolName, toolCallId:'', toolInput:'', status:'in_progress' }
 *              + tool-end        { toolName, toolCallId:'', status:'completed', output:'' }
 *   status     → status          { text }
 *   error      → throws
 *   result     → end signal (carries refreshedToken if kiro-cli refreshed the token)
 *   verification → login challenge { verificationUri, userCode }
 *
 * Token write-back (conditional):
 *   After a kiro-run, if the result carries a refreshedToken we re-encrypt it
 *   and persist it — only if the credential's stored ciphertext is still the one
 *   used for this run.  A concurrent run that already wrote a newer token keeps
 *   its value.  Token values never appear in logs.
 *
 * Safety invariants:
 *   - Token fields never appear in log output.
 *   - AbortSignal cancels the HTTP connection and stops processing.
 *   - Errors from AgentCore are converted to HttpError or thrown as-is.
 */

import https from 'node:https';
import http from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createFileReceiver } from './runner-files.ts';
import { persistFile } from '../durable-files.ts';
import { encrypt, decrypt } from '../secrets.ts';
import { getCredentialsRepository } from '../repositories/credentials.ts';
import { snapshotAccess } from './runner-snapshot-access.ts';
import { agentCoreSessionId } from './agentcore-session.ts';
import { waitForRepoPrep } from './repo-prep.ts';
import { getAgentcoreLoginRepository, clearAgentcoreLoginRepository } from '../repositories/agentcore-login.ts';
import { usesDynamoDb } from '../repositories/backend.ts';
import { now, HttpError, generateId } from '../util.ts';
import { config } from '../config.ts';
import type { RunContext } from './types.ts';
import { getSettings } from '../settings.ts';
import { ApprovalRelay, isApprovalRequest, type ControlSender } from './agentcore-bridge.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface KiroTokenPayload {
  accessToken: string;
  expiresAt: string;
  region: string;
  startUrl: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  clientSecretExpiresAt?: number;
  profileArn?: string;
  profileName?: string;
}

export type AgentCoreSSEEvent =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'context'; percent: number }
  | { type: 'tool'; name: string }
  | { type: 'check-result'; ok: boolean; ranAt: string; steps: unknown[] }
  | { type: 'browser-session'; browserId: string; sessionId: string; width: number; height: number }
  | { type: 'browser-navigate'; url: string }
  | { type: 'browser-screenshot'; screenshotBase64: string; url?: string }
  | { type: 'status'; text: string }
  | { type: 'error'; message: string }
  | { type: 'models'; stdout: string }
  | { type: 'login-status'; state: 'pending' | 'complete' | 'failed' | 'unknown'; tokenPayload?: AgentCoreLoginResult['tokenPayload']; error?: string }
  | { type: 'verification'; verificationUri: string; userCode: string }
  | { type: 'approval-request'; requestId: string; toolName: string; input: Record<string, unknown>; inputHash: string; expiresAt?: string }
  | { type: 'tool-blocked'; toolName: string; toolInput?: string; reason: string }
  | {
      type: 'result';
      runId: string;
      exitCode: number;
      durationMs: number;
      coldStartMs: number;
      tokenRefreshed: boolean;
      refreshedToken?: { accessToken: string; expiresAt: string; refreshToken?: string };
    };

export type AgentCoreLoginResultEvent =
  | { type: 'result'; success: boolean; tokenPayload?: { access_token: string; expires_at: string; refresh_token?: string; region?: string; start_url?: string; client_id?: string; client_secret?: string; client_secret_expires_at?: number }; tokenSizeBytes: number; durationMs: number; coldStartMs: number; exitCode: number }
  | { type: 'error'; message: string }
  | { type: 'verification'; verificationUri: string; userCode: string }
  | { type: 'status'; text: string };

// ── Test override hooks ────────────────────────────────────────────────────────

/**
 * An invoker function that produces AgentCore SSE events from a payload.
 * Used by unit tests to avoid real AWS calls.
 */
export type AgentCoreInvoker = (
  runtimeArn: string,
  sessionId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => AsyncGenerator<AgentCoreSSEEvent | AgentCoreLoginResultEvent>;

let _invokerOverride: AgentCoreInvoker | null = null;

/**
 * Override the AgentCore invoker for tests.
 * Pass null to restore the real HTTP implementation.
 */
export function _setAgentCoreInvokerOverride(fn: AgentCoreInvoker | null): void {
  _invokerOverride = fn;
}

// ── AWS credential + SigV4 helpers ────────────────────────────────────────────

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Minimal SHA-256 / HMAC-SHA256 compatible with @smithy/signature-v4 HashConstructor. */
class NodeSha256 {
  private _updates: Array<string | Uint8Array> = [];
  private _secret: Buffer | null = null;

  constructor(secret?: string | ArrayBuffer | ArrayBufferView | Uint8Array) {
    if (secret !== undefined && secret !== null) {
      if (secret instanceof Uint8Array) {
        this._secret = Buffer.from(secret);
      } else if (ArrayBuffer.isView(secret)) {
        this._secret = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
      } else if (secret instanceof ArrayBuffer) {
        this._secret = Buffer.from(secret);
      } else if (typeof secret === 'string') {
        this._secret = Buffer.from(secret, 'utf8');
      }
    }
  }

  update(data: string | Uint8Array, _encoding?: string): void {
    this._updates.push(data);
  }

  async digest(): Promise<Uint8Array> {
    if (this._secret !== null) {
      // HMAC-SHA256
      const hmac = createHmac('sha256', this._secret);
      for (const chunk of this._updates) {
        if (typeof chunk === 'string') hmac.update(chunk, 'utf8');
        else hmac.update(chunk);
      }
      return new Uint8Array(hmac.digest());
    } else {
      // Regular SHA-256
      const hash = createHash('sha256');
      for (const chunk of this._updates) {
        if (typeof chunk === 'string') hash.update(chunk, 'utf8');
        else hash.update(chunk);
      }
      return new Uint8Array(hash.digest());
    }
  }
}

/**
 * Resolve AWS credentials from the default provider chain or a named profile.
 * Uses @aws-sdk/credential-providers (already in portal deps).
 */
async function resolveAwsCredentials(profile?: string): Promise<AwsCreds> {
  type CredsModule = {
    fromNodeProviderChain: () => () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
    fromIni: (opts: { profile: string }) => () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }>;
  };
  const mod = await (Function('m', 'return import(m)')('@aws-sdk/credential-providers') as Promise<CredsModule>);
  const provider = profile
    ? mod.fromIni({ profile })
    : mod.fromNodeProviderChain();
  return provider();
}

/**
 * Sign an HTTP request using AWS Signature V4.
 * Returns the signed headers to add to the request.
 */
async function signRequest(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  service: string;
  region: string;
  credentials: AwsCreds;
}): Promise<Record<string, string>> {
  type SigV4Module = {
    SignatureV4: new (cfg: {
      credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
      region: string;
      service: string;
      sha256: new () => NodeSha256;
    }) => {
      sign(request: {
        method: string;
        headers: Record<string, string>;
        hostname: string;
        path: string;
        body?: string;
        protocol: string;
        port?: number;
      }): Promise<{
        headers: Record<string, string>;
        method: string;
        path: string;
        hostname: string;
        protocol: string;
        body?: string;
      }>;
    };
  };

  const sv4Mod = await (Function('m', 'return import(m)')('@smithy/signature-v4') as Promise<SigV4Module>);

  const signer = new sv4Mod.SignatureV4({
    credentials: {
      accessKeyId: opts.credentials.accessKeyId,
      secretAccessKey: opts.credentials.secretAccessKey,
      ...(opts.credentials.sessionToken ? { sessionToken: opts.credentials.sessionToken } : {}),
    },
    region: opts.region,
    service: opts.service,
    sha256: NodeSha256 as unknown as new () => NodeSha256,
  });

  const signed = await signer.sign({
    method: opts.method,
    headers: {
      ...opts.headers,
      host: opts.url.hostname,
    },
    hostname: opts.url.hostname,
    path: opts.url.pathname + opts.url.search,
    body: opts.body,
    protocol: opts.url.protocol,
    ...(opts.url.port ? { port: Number(opts.url.port) } : {}),
  });

  return signed.headers as Record<string, string>;
}

// ── ARN parsing ────────────────────────────────────────────────────────────────

/**
 * Extract the region and runtime ID from a bedrock-agentcore runtime ARN.
 * ARN format: arn:aws:bedrock-agentcore:{region}:{account}:runtime/{runtimeId}
 */
function parseRuntimeArn(arn: string): { region: string; runtimeId: string } {
  const parts = arn.split(':');
  if (parts.length < 6) throw new Error(`Invalid AgentCore runtime ARN: ${arn}`);
  const region = parts[3];
  const resourcePart = parts.slice(5).join(':');
  const runtimeId = resourcePart.replace(/^runtime\//, '');
  return { region, runtimeId };
}

// ── AgentCore HTTP invocation ─────────────────────────────────────────────────

/**
 * Invoke the AgentCore runtime and stream back SSE events.
 * Resolves the endpoint from the ARN, signs the request, and parses SSE lines.
 */
async function* invokeAgentCoreReal(
  runtimeArn: string,
  sessionId: string,
  invocationPayload: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<AgentCoreSSEEvent | AgentCoreLoginResultEvent> {
  const { region } = parseRuntimeArn(runtimeArn);
  // PORTAL_AGENTCORE_* apply to every runtime; the older PORTAL_KIRO_AGENTCORE_* names still work.
  const profile = process.env.PORTAL_AGENTCORE_AWS_PROFILE || process.env.PORTAL_KIRO_AGENTCORE_AWS_PROFILE;
  const overrideRegion = process.env.PORTAL_AGENTCORE_REGION || process.env.PORTAL_KIRO_AGENTCORE_REGION;
  const effectiveRegion = overrideRegion || region;

  const credentials = await resolveAwsCredentials(profile);

  // Build the URL — ARN goes in the path as a URI label (percent-encoded)
  const encodedArn = encodeURIComponent(runtimeArn);
  const baseUrl = `https://bedrock-agentcore.${effectiveRegion}.amazonaws.com`;
  const path = `/runtimes/${encodedArn}/invocations`;
  const url = new URL(`${baseUrl}${path}`);

  const bodyStr = JSON.stringify(invocationPayload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
    'Content-Length': Buffer.byteLength(bodyStr).toString(),
  };

  const signedHeaders = await signRequest({
    method: 'POST',
    url,
    headers,
    body: bodyStr,
    service: 'bedrock-agentcore',
    region: effectiveRegion,
    credentials,
  });

  // Make the HTTP(S) request and yield events as they arrive (live streaming).
  const queue: Array<AgentCoreSSEEvent | AgentCoreLoginResultEvent> = [];
  let done = false;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const notify = (): void => { const w = wake; wake = null; w?.(); };

  {
    let lineBuf = '';
    let aborted = false;

    const onAbort = (): void => {
      aborted = true;
      req.destroy(new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (err: unknown): void => {
      signal?.removeEventListener('abort', onAbort);
      if (err) failure = aborted ? new DOMException('Aborted', 'AbortError') : err;
      done = true;
      notify();
    };

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: signedHeaders,
      },
      (res: http.IncomingMessage) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => { errBody += c; });
          res.on('end', () => finish(new HttpError(
            res.statusCode ?? 502,
            `AgentCore returned HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`,
          )));
          return;
        }

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          lineBuf += chunk;
          let nl: number;
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trimEnd();
            lineBuf = lineBuf.slice(nl + 1);
            if (line.startsWith('data:')) {
              const jsonStr = line.slice(5).trim();
              if (jsonStr) {
                try {
                  queue.push(JSON.parse(jsonStr) as AgentCoreSSEEvent | AgentCoreLoginResultEvent);
                  notify();
                } catch { /* skip malformed lines */ }
              }
            }
          }
        });
        res.on('end', () => finish(null));
        res.on('error', (err: Error) => finish(err));
      },
    );

    req.on('error', (err: Error) => finish(err));
    req.write(bodyStr);
    req.end();
  }

  while (true) {
    if (queue.length > 0) { yield queue.shift()!; continue; }
    if (done) break;
    await new Promise<void>((r) => { wake = r; });
  }
  if (failure) throw failure;
}

/**
 * Entry point for AgentCore invocations — uses the real HTTP path or a test override.
 */
export async function* invokeAgentCore(
  runtimeArn: string,
  sessionId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<AgentCoreSSEEvent | AgentCoreLoginResultEvent> {
  const invoker = _invokerOverride ?? invokeAgentCoreReal;
  yield* invoker(runtimeArn, sessionId, payload, signal);
}

/**
 * A sender for control invocations (approval answers, cancel) on a run's session.
 * AgentCore routes them to the run's microVM while the run's own invocation is still streaming.
 */
export function agentCoreControlSender(runtimeArn: string, sessionId: string): ControlSender {
  return async (payload) => {
    const replies: Array<Record<string, unknown>> = [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      for await (const ev of invokeAgentCore(runtimeArn, sessionId, payload, ac.signal)) {
        replies.push(ev as unknown as Record<string, unknown>);
      }
    } finally {
      clearTimeout(timer);
    }
    return replies;
  };
}

/** The approval settings sent to a runner: the portal's expiry (the runner adds a margin). */
export function runnerApprovals(): { via: 'portal'; expiryMinutes: number } {
  const minutes = Number(getSettings().agents.approvalExpiryMinutes) || 60;
  return { via: 'portal', expiryMinutes: Math.min(Math.max(minutes, 0.1), 1440) };
}

// ── Token write-back ───────────────────────────────────────────────────────────

import type { CredentialRecord } from '../repositories/credentials.ts';
type CredentialRow = CredentialRecord;

function safeJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(String(s)) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Persist a refreshed IdC access token after an AgentCore run.
 *
 * Conditional update: only writes if the stored ciphertext is still the one
 * used for this run (i.e. no concurrent run has already stored a newer token).
 * If the stored value has changed, silently skips the update.
 * Never logs token values.
 */
export async function saveRefreshedTokenConditional(
  credentialId: string,
  newAccessToken: string,
  newExpiresAt: string,
  newRefreshToken: string | undefined,
  expectedCiphertext: string,
): Promise<void> {
  try {
    const cred = await getCredentialsRepository().getById(credentialId);
    if (!cred || cred.mode !== 'identity_center') return;

    // Conditional: skip if the stored ciphertext changed (another run won)
    if (cred.secret_enc !== expectedCiphertext) return;

    const extra = safeJson(cred.extra_config);
    const newExtra: Record<string, unknown> = { ...extra, tokenExpiry: newExpiresAt };
    if (newRefreshToken) {
      newExtra.refreshTokenEnc = encrypt(newRefreshToken, config.secretKey);
    }
    delete newExtra.pendingClientId;
    delete newExtra.pendingClientSecret;
    delete newExtra.pendingDeviceCode;
    delete newExtra.pendingExpireAt;
    delete newExtra.pendingClientSecretExpiresAt;

    const tokenEnc = encrypt(newAccessToken, config.secretKey);
    await getCredentialsRepository().updateTokenConditional(
      credentialId,
      tokenEnc,
      JSON.stringify(newExtra),
      newAccessToken.slice(-4),
      now(),
      expectedCiphertext,
    );
  } catch {
    // Non-fatal — token refresh write-back is best-effort
  }
}

// ── AgentCore run path ─────────────────────────────────────────────────────────

export interface AgentCoreRunOpts {
  runtimeArn: string;
  runId: string;
  prompt: string;
  token: KiroTokenPayload;
  credentialId: string | null;
  expectedCiphertext: string | null;
  /** Give kiro-cli the AgentCore Browser tools (MCP server in the runner). */
  browser?: boolean;
  /** The session's repositories for the runner to clone under repos/. */
  repos?: import('./runner-repos.ts').RunnerRepo[];
  /** The project's remote MCP integrations (runner starts a proxy for each). */
  mcpServers?: import('./runner-mcp.ts').McpServerSpec[];
  /** The project's AWS account as AWS_* variables for the agent's shell. */
  awsEnv?: Record<string, string>;
  /** Staged files (attachments, project documents) the runner writes into the work folder first. */
  inputFiles?: import('./runner-files.ts').InputFile[];
  /** A loop session's check steps, run by the runner after kiro finishes. */
  checks?: import('./runner-checks.ts').CheckStep[];
  /** The model to use (a Kiro model id); kiro's own default when absent. */
  model?: string | null;
}

/**
 * Run kiro-cli via AgentCore and map the SSE events onto portal run events.
 * Returns the concatenated text output (same shape as runKiroAcp / runKiroLegacy).
 *
 * Timeout: honours PORTAL_RUN_TIMEOUT_MS env var (default 5 min).
 * Cancel:  ctx.signal abort destroys the HTTP connection.
 */
export async function runKiroViaAgentCore(
  ctx: RunContext,
  opts: AgentCoreRunOpts,
): Promise<{ textParts: string[]; credits: number }> {
  const { emit, signal } = ctx;
  const textParts: string[] = [];
  const credits = 0;
  // One AgentCore session per portal session, so the session's persistent folder (repositories) is found again.
  const sessionId = ctx.run?.workflowId ? agentCoreSessionId(ctx.run.workflowId, 'kiro') : randomUUID();
  if (ctx.run?.workflowId && opts.repos?.length) await waitForRepoPrep(ctx.run.workflowId);

  emit('status', { state: 'thinking' });
  emit('status', { text: 'Running via AgentCore…' });

  // Default 29 min: just under the AgentCore runtime maxLifetime (30 min).
  const timeoutMs = Number(process.env.PORTAL_RUN_TIMEOUT_MS) || 29 * 60_000;
  const ac = new AbortController();
  const merged = signal ? mergeAbortSignals([signal, ac.signal]) : ac.signal;

  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    ac.abort(new Error('AgentCore run timed out'));
  }, timeoutMs);

  try {
    const snapshot = opts.repos?.length && ctx.run?.workflowId ? await snapshotAccess(ctx.run.workflowId) : null;
    const payload: Record<string, unknown> = {
      mode: 'kiro-run',
      runId: opts.runId,
      prompt: opts.prompt,
      token: opts.token,
      ...(opts.browser ? { browser: true } : {}),
      ...(opts.repos?.length ? { repos: opts.repos } : {}),
      ...(opts.mcpServers?.length ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.awsEnv && Object.keys(opts.awsEnv).length ? { awsEnv: opts.awsEnv } : {}),
      ...(opts.inputFiles?.length ? { inputFiles: opts.inputFiles } : {}),
      ...(opts.checks?.length ? { checks: opts.checks } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(snapshot ? { snapshot } : {}),
      // Same rule as the local Kiro engine: trusted runs allow what kiro-cli asks about,
      // untrusted runs ask a person (relayed below).
      policy: { trusted: ctx.run.trusted },
      approvals: runnerApprovals(),
    };

    const fileReceiver = ctx.run?.workDir ? createFileReceiver(ctx.run.workDir, (abs) => persistFile(abs)) : null;

    const send = agentCoreControlSender(opts.runtimeArn, sessionId);
    // Kiro's local engine checks the guard and trust only (no permission rules), so the relay re-checks the guard.
    const relay = new ApprovalRelay(ctx, send, []);
    const onCancel = (): void => {
      void send({ mode: 'cancel', runId: opts.runId }).catch(() => { /* the stream is closing anyway */ });
    };
    signal?.addEventListener('abort', onCancel, { once: true });

    try {
    for await (const ev of invokeAgentCore(opts.runtimeArn, sessionId, payload, merged)) {
      if (signal?.aborted) break;
      if ((ev as { type: string }).type === 'file') {
        await fileReceiver?.handle(ev as unknown as Record<string, unknown>);
        continue;
      }

      switch (ev.type) {
        case 'approval-request': {
          const raw = ev as unknown as Record<string, unknown>;
          if (isApprovalRequest(raw)) relay.handle(raw);
          break;
        }

        case 'tool-blocked': {
          const b = ev as { toolName?: string; toolInput?: string; reason?: string };
          emit('tool-blocked', { toolName: b.toolName ?? 'Tool', toolInput: b.toolInput ?? '', reason: b.reason ?? '' });
          break;
        }

        case 'text': {
          const textEv = ev as { type: 'text'; text: string };
          if (textEv.text) {
            emit('assistant-text', { text: textEv.text, stream: true });
            if (textParts.length) textParts[textParts.length - 1] += textEv.text;
            else textParts.push(textEv.text);
          }
          break;
        }

        case 'context': {
          const percent = Number((ev as { type: 'context'; percent: number }).percent);
          if (Number.isFinite(percent)) emit('context-usage', { percent });
          break;
        }

        case 'thought': {
          const thoughtEv = ev as { type: 'thought'; text: string };
          if (thoughtEv.text) emit('agent-thought', { text: thoughtEv.text });
          break;
        }

        case 'tool': {
          const toolEv = ev as { type: 'tool'; name: string };
          const toolName = toolEv.name || 'Tool';
          if (textParts.length && textParts[textParts.length - 1] !== '') textParts.push('');
          emit('tool-start', { toolCallId: '', toolName, toolInput: '{}', status: 'in_progress' });
          emit('tool-end', { toolCallId: '', toolName, status: 'completed', output: '' });
          break;
        }

        case 'check-result': {
          const chk = ev as { type: 'check-result'; ok?: boolean; ranAt?: string; steps?: unknown[] };
          emit('check-result', { ok: Boolean(chk.ok), ranAt: String(chk.ranAt ?? ''), steps: Array.isArray(chk.steps) ? chk.steps : [] });
          break;
        }

        case 'browser-session': {
          const sesEv = ev as { type: 'browser-session'; browserId?: string; sessionId?: string; width?: number; height?: number };
          if (sesEv.sessionId) emit('browser-session', { browserId: sesEv.browserId || 'aws.browser.v1', sessionId: sesEv.sessionId, width: Number(sesEv.width) || 1280, height: Number(sesEv.height) || 800 });
          break;
        }

        case 'browser-navigate': {
          const navEv = ev as { type: 'browser-navigate'; url: string };
          if (navEv.url) emit('browser-navigate', { url: navEv.url });
          break;
        }

        case 'browser-screenshot': {
          const shotEv = ev as { type: 'browser-screenshot'; screenshotBase64: string; url?: string };
          if (shotEv.screenshotBase64) emit('browser-screenshot', { screenshotBase64: shotEv.screenshotBase64, ...(shotEv.url ? { url: shotEv.url } : {}) });
          break;
        }

        case 'status': {
          const statusEv = ev as { type: 'status'; text: string };
          if (statusEv.text) emit('status', { text: statusEv.text });
          break;
        }

        case 'error': {
          const errEv = ev as { type: 'error'; message: string };
          throw new HttpError(502, `AgentCore kiro-run error: ${errEv.message}`);
        }

        case 'result': {
          const resultEv = ev as Extract<AgentCoreSSEEvent, { type: 'result' }>;
          // Token write-back: conditional update if kiro-cli refreshed the token
          if (
            resultEv.tokenRefreshed &&
            resultEv.refreshedToken &&
            opts.credentialId &&
            opts.expectedCiphertext
          ) {
            await saveRefreshedTokenConditional(
              opts.credentialId,
              resultEv.refreshedToken.accessToken,
              resultEv.refreshedToken.expiresAt,
              resultEv.refreshedToken.refreshToken,
              opts.expectedCiphertext,
            );
          }
          break;
        }

        default:
          break;
      }
    }
    } finally {
      signal?.removeEventListener('abort', onCancel);
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (timedOut) {
    throw new HttpError(504, 'AgentCore kiro-run timed out');
  }

  if (signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');

  emit('status', { state: 'idle' });
  return { textParts, credits };
}

// ── AgentCore login path ───────────────────────────────────────────────────────

/**
 * The sign-in link with the code already in it. Opening the bare /start page while signed in to IAM Identity Center
 * just shows the app portal and never asks for the code; the device page takes it from the URL instead.
 */
export function deviceUrlWithCode(verificationUri: string, userCode: string): string {
  if (/user_code=/i.test(verificationUri)) return verificationUri;
  const base = verificationUri.replace(/#.*$/, '').replace(/\/+$/, '');
  return `${base}/#/device?user_code=${encodeURIComponent(userCode)}`;
}

export interface AgentCoreLoginChallenge {
  verificationUri: string;
  /** Same link with the code filled in; use this one for the clickable link. */
  verificationUriComplete?: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export interface AgentCoreLoginResult {
  state: 'complete' | 'failed';
  tokenPayload?: {
    access_token: string;
    expires_at: string;
    refresh_token?: string;
    region?: string;
    start_url?: string;
    client_id?: string;
    client_secret?: string;
    client_secret_expires_at?: number;
  };
  error?: string;
}

/**
 * In-memory login state map (backward compat + single-instance fast path).
 * Used by pollAgentCoreLogin (sync) and as test injection point.
 * In DynamoDB mode, state is ALSO written to the repository for cross-Lambda polling.
 */
interface PendingLogin {
  settled: boolean;
  result: AgentCoreLoginResult | null;
  err: Error | null;
}

export const _agentCoreLoginState = new Map<string, PendingLogin>();

/**
 * Start an AgentCore kiro-login, wait for the verification challenge, and start
 * a background promise that resolves when login completes.
 *
 * The background result is stored in both the in-memory map (fast sync poll)
 * and the AgentcoreLoginRepository (DynamoDB cross-Lambda poll).
 */
/** Session and run ids are derived from the credential and start time so any Lambda instance can find the login again. */
function loginIds(credentialId: string, createdAt: string): { sessionId: string; runId: string } {
  const h = createHash('sha256').update(`${credentialId}|${createdAt}`).digest('hex');
  return { sessionId: `kirologin-${h.slice(0, 40)}`, runId: `login-${h.slice(0, 24)}` };
}

export async function startAgentCoreLogin(
  runtimeArn: string,
  credentialId: string,
  startUrl: string,
  region: string,
): Promise<AgentCoreLoginChallenge> {
  const createdAt = now();
  const { sessionId, runId } = loginIds(credentialId, createdAt);
  const payload: Record<string, unknown> = {
    mode: 'kiro-login',
    runId,
    startUrl,
    region,
  };

  // Clean up any leftover state from a previous attempt for the same credential
  _agentCoreLoginState.delete(credentialId);
  if (usesDynamoDb()) {
    await getAgentcoreLoginRepository().delete(credentialId);
    await getAgentcoreLoginRepository().create(credentialId, createdAt);
  }

  const pending: PendingLogin = { settled: false, result: null, err: null };
  _agentCoreLoginState.set(credentialId, pending);

  return new Promise<AgentCoreLoginChallenge>((resolve, reject) => {
    let challengeResolved = false;

    async function run(): Promise<void> {
      try {
        for await (const ev of invokeAgentCore(runtimeArn, sessionId, payload)) {
          if (ev.type === 'verification') {
            const vEv = ev as { type: 'verification'; verificationUri: string; userCode: string };
            if (!challengeResolved) {
              challengeResolved = true;
              resolve({
                verificationUri: vEv.verificationUri,
                verificationUriComplete: deviceUrlWithCode(vEv.verificationUri, vEv.userCode),
                userCode: vEv.userCode,
                expiresIn: 900,
                interval: 5,
              });
            }
          } else if (ev.type === 'result') {
            const rEv = ev as AgentCoreLoginResultEvent & { type: 'result' };
            pending.settled = true;
            if (rEv.success && rEv.tokenPayload) {
              pending.result = { state: 'complete', tokenPayload: rEv.tokenPayload };
              if (usesDynamoDb()) {
                await getAgentcoreLoginRepository().complete(credentialId, rEv.tokenPayload).catch(() => {});
              }
            } else {
              pending.result = { state: 'failed', error: 'Login did not complete' };
              if (usesDynamoDb()) {
                await getAgentcoreLoginRepository().fail(credentialId, 'Login did not complete').catch(() => {});
              }
            }
          } else if (ev.type === 'error') {
            const errEv = ev as { type: 'error'; message: string };
            pending.settled = true;
            pending.result = { state: 'failed', error: errEv.message };
            if (usesDynamoDb()) {
              await getAgentcoreLoginRepository().fail(credentialId, errEv.message).catch(() => {});
            }
            if (!challengeResolved) {
              challengeResolved = true;
              reject(new HttpError(502, `AgentCore kiro-login error: ${errEv.message}`));
            }
          }
        }
      } catch (e) {
        pending.settled = true;
        pending.err = e as Error;
        if (usesDynamoDb()) {
          await getAgentcoreLoginRepository().fail(credentialId, (e as Error).message ?? 'Unknown error').catch(() => {});
        }
        if (!challengeResolved) {
          challengeResolved = true;
          reject(e);
        }
      } finally {
        if (!pending.settled) {
          pending.settled = true;
          pending.result = { state: 'failed', error: 'Login stream ended without result' };
        }
        if (!challengeResolved) {
          challengeResolved = true;
          reject(new HttpError(502, 'AgentCore kiro-login did not emit verification URL'));
        }
      }
    }

    run().catch(() => { /* handled above */ });
  });
}

/**
 * Poll the AgentCore login state for a credential.
 *
 * Synchronous for single-instance (SQLite) mode — reads from the in-memory map.
 * In DynamoDB mode, returns a sync result from the map if available, else 'unknown'.
 * For true cross-Lambda polling in DynamoDB mode, callers should use
 * getAgentcoreLoginRepository().get(credentialId) directly.
 */
export function pollAgentCoreLogin(credentialId: string): {
  status: 'pending' | 'complete' | 'failed' | 'unknown';
  tokenPayload?: AgentCoreLoginResult['tokenPayload'];
  errorMessage?: string;
} {
  const pending = _agentCoreLoginState.get(credentialId);
  if (!pending) return { status: 'unknown' };
  if (!pending.settled) return { status: 'pending' };

  // Remove from map once consumed
  _agentCoreLoginState.delete(credentialId);
  if (usesDynamoDb()) {
    getAgentcoreLoginRepository().delete(credentialId).catch(() => {});
  }

  if (pending.err) {
    return { status: 'failed', errorMessage: pending.err.message };
  }
  const result = pending.result;
  if (!result) return { status: 'failed', errorMessage: 'No result' };
  if (result.state === 'complete' && result.tokenPayload) {
    return { status: 'complete', tokenPayload: result.tokenPayload };
  }
  return { status: 'failed', errorMessage: result.error ?? 'Login failed' };
}

/**
 * Like pollAgentCoreLogin, but also works when the poll lands on a different Lambda instance than the one
 * that started the login: with no in-memory entry it reads the shared repository (DynamoDB mode).
 */
export async function pollAgentCoreLoginShared(credentialId: string): Promise<ReturnType<typeof pollAgentCoreLogin>> {
  const local = pollAgentCoreLogin(credentialId);
  if (local.status !== 'unknown' || !usesDynamoDb()) return local;

  const repo = getAgentcoreLoginRepository();
  const entry = await repo.get(credentialId);
  if (!entry) return { status: 'unknown' };
  if (!entry.settled) {
    // The Lambda that started the login is frozen once its response ends, so it cannot record the outcome.
    // Ask the runner (same AgentCore session) directly.
    const runtimeArn = process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN;
    if (!runtimeArn) return { status: 'pending' };
    const { sessionId, runId } = loginIds(credentialId, entry.createdAt);
    try {
      for await (const ev of invokeAgentCore(runtimeArn, sessionId, { mode: 'kiro-login-status', runId })) {
        if (ev.type !== 'login-status') continue;
        if (ev.state === 'complete' && ev.tokenPayload) {
          await repo.delete(credentialId).catch(() => {});
          return { status: 'complete', tokenPayload: ev.tokenPayload };
        }
        if (ev.state === 'failed') {
          await repo.delete(credentialId).catch(() => {});
          return { status: 'failed', errorMessage: ev.error ?? 'Login failed' };
        }
        break;
      }
    } catch (e) {
      console.error('[kiro-login] status check failed:', e instanceof Error ? e.message : e);
    }
    return { status: 'pending' };
  }

  await repo.delete(credentialId).catch(() => {});
  if (entry.state === 'complete' && entry.tokenPayload) {
    return { status: 'complete', tokenPayload: entry.tokenPayload };
  }
  return { status: 'failed', errorMessage: entry.errorMessage ?? 'Login failed' };
}

/**
 * List the Kiro models available to a credential by running `kiro-cli chat --list-models` inside the
 * AgentCore runtime (the portal itself has no kiro-cli on Lambda). Returns the raw CLI output.
 */
export async function listKiroModelsViaAgentCore(
  runtimeArn: string,
  token: KiroTokenPayload,
  signal?: AbortSignal,
): Promise<{ stdout?: string; error?: string }> {
  const sessionId = randomUUID();
  const payload: Record<string, unknown> = {
    mode: 'kiro-list-models',
    runId: `models-${generateId()}`,
    token,
  };
  try {
    for await (const ev of invokeAgentCore(runtimeArn, sessionId, payload, signal)) {
      if (ev.type === 'models') return { stdout: String((ev as { stdout?: string }).stdout ?? '') };
      if (ev.type === 'error') return { error: String((ev as { message?: string }).message ?? 'Listing models failed') };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { error: 'The Kiro runtime returned no model list.' };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Merge multiple AbortSignals: fires as soon as any of them fires. */
function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) { ac.abort(sig.reason); break; }
    sig.addEventListener('abort', () => ac.abort(sig.reason), { once: true });
  }
  return ac.signal;
}
