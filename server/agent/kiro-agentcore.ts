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
import { encrypt, decrypt } from '../secrets.ts';
import { one, run as dbRun } from '../db.ts';
import type { Row } from '../db.ts';
import { now, HttpError, generateId } from '../util.ts';
import { config } from '../config.ts';
import type { RunContext } from './types.ts';

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
  | { type: 'tool'; name: string }
  | { type: 'status'; text: string }
  | { type: 'error'; message: string }
  | { type: 'verification'; verificationUri: string; userCode: string }
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
  | { type: 'result'; success: boolean; tokenPayload?: { access_token: string; expires_at: string; refresh_token?: string; region?: string; start_url?: string }; tokenSizeBytes: number; durationMs: number; coldStartMs: number; exitCode: number }
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
  const profile = process.env.PORTAL_KIRO_AGENTCORE_AWS_PROFILE;
  const overrideRegion = process.env.PORTAL_KIRO_AGENTCORE_REGION;
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
async function* invokeAgentCore(
  runtimeArn: string,
  sessionId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<AgentCoreSSEEvent | AgentCoreLoginResultEvent> {
  const invoker = _invokerOverride ?? invokeAgentCoreReal;
  yield* invoker(runtimeArn, sessionId, payload, signal);
}

// ── Token write-back ───────────────────────────────────────────────────────────

interface CredentialRow extends Row {
  id: string;
  mode: string;
  secret_enc: string | null;
  extra_config: string;
}

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
    const cred = one<CredentialRow>(
      "SELECT id, mode, secret_enc, extra_config FROM engine_credentials WHERE id = ? AND mode = 'identity_center'",
      credentialId,
    );
    if (!cred) return;

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
    dbRun(
      `UPDATE engine_credentials
          SET secret_enc = ?, extra_config = ?, last4 = ?, updated_at = ?
        WHERE id = ? AND secret_enc = ?`,
      tokenEnc,
      JSON.stringify(newExtra),
      newAccessToken.slice(-4),
      now(),
      credentialId,
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
  const sessionId = randomUUID();

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
    const payload: Record<string, unknown> = {
      mode: 'kiro-run',
      runId: opts.runId,
      prompt: opts.prompt,
      token: opts.token,
    };

    for await (const ev of invokeAgentCore(opts.runtimeArn, sessionId, payload, merged)) {
      if (signal?.aborted) break;

      switch (ev.type) {
        case 'text': {
          const textEv = ev as { type: 'text'; text: string };
          if (textEv.text) {
            emit('assistant-text', { text: textEv.text, stream: true });
            if (textParts.length) textParts[textParts.length - 1] += textEv.text;
            else textParts.push(textEv.text);
          }
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

export interface AgentCoreLoginChallenge {
  verificationUri: string;
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
  };
  error?: string;
}

/**
 * Per-credential pending AgentCore login state.
 * Keyed by credentialId; cleaned up after poll completes.
 */
interface PendingLogin {
  settled: boolean;
  result: AgentCoreLoginResult | null;
  err: Error | null;
}

export const _agentCoreLoginState = new Map<string, PendingLogin>();

/**
 * Invoke AgentCore kiro-login, wait for the verification challenge, and start
 * a background promise that resolves when login completes.
 *
 * Returns the challenge (verificationUri, userCode) so the caller can surface
 * it to the user immediately — exactly as the existing device-code flow does.
 *
 * The background promise populates _agentCoreLoginState[credentialId] when done.
 * device-poll checks this state to decide when to mark the credential complete.
 *
 * Never logs token values.
 */
export async function startAgentCoreLogin(
  runtimeArn: string,
  credentialId: string,
  startUrl: string,
  region: string,
): Promise<AgentCoreLoginChallenge> {
  const sessionId = randomUUID();
  const runId = `login-${generateId()}`;
  const payload: Record<string, unknown> = {
    mode: 'kiro-login',
    runId,
    startUrl,
    region,
  };

  // Clean up any leftover state from a previous attempt for the same credential
  _agentCoreLoginState.delete(credentialId);

  const pending: PendingLogin = { settled: false, result: null, err: null };
  _agentCoreLoginState.set(credentialId, pending);

  // Run the login as a streaming operation — first wait for the verification event
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
                userCode: vEv.userCode,
                expiresIn: 900,   // 15 min default (kiro-cli uses 15 min)
                interval: 5,
              });
            }
          } else if (ev.type === 'result') {
            const rEv = ev as AgentCoreLoginResultEvent & { type: 'result' };
            pending.settled = true;
            if (rEv.success && rEv.tokenPayload) {
              pending.result = { state: 'complete', tokenPayload: rEv.tokenPayload };
            } else {
              pending.result = { state: 'failed', error: 'Login did not complete' };
            }
          } else if (ev.type === 'error') {
            const errEv = ev as { type: 'error'; message: string };
            pending.settled = true;
            pending.result = { state: 'failed', error: errEv.message };
            if (!challengeResolved) {
              challengeResolved = true;
              reject(new HttpError(502, `AgentCore kiro-login error: ${errEv.message}`));
            }
          }
        }
      } catch (e) {
        pending.settled = true;
        pending.err = e as Error;
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
 * Returns:
 *   'pending'  — still waiting for user approval
 *   'complete' — login succeeded; tokenPayload contains the new token
 *   'failed'   — login failed; errorMessage describes why
 *   'unknown'  — no pending login for this credential (timed out or never started)
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
