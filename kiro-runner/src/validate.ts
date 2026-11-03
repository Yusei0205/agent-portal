/**
 * Payload validation for POST /invocations (kiro-runner).
 *
 * Two modes:
 *   kiro-run   — run kiro-cli headless with a prompt and an IdC token payload.
 *   kiro-login — run kiro-cli device-flow login and stream the verification URL/code.
 *
 * Token fields are validated for presence but NEVER logged anywhere in this module.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Decrypted IdC token fields passed into kiro-run.
 * All secret fields (accessToken, refreshToken, clientSecret) must NEVER be logged.
 */
export interface KiroTokenInput {
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

export interface KiroRunPayload {
  mode: 'kiro-run';
  runId: string;
  prompt: string;
  token: KiroTokenInput;
  /** true = give kiro-cli the AgentCore Browser tools as an MCP server. */
  browser?: boolean;
  /** The session's repositories to clone under repos/ (checked in run.ts by shared/runner-repos.ts). */
  repos?: unknown[];
}

export interface KiroLoginPayload {
  mode: 'kiro-login';
  runId: string;
  startUrl: string;
  region: string;
}

export interface KiroListModelsPayload {
  mode: 'kiro-list-models';
  runId: string;
  token: KiroTokenInput;
}

/** Asks for the outcome of a kiro-login started earlier in the same session (answered even while that login is still running). */
export interface KiroLoginStatusPayload {
  mode: 'kiro-login-status';
  runId: string;
}

export type KiroPayload = KiroRunPayload | KiroLoginPayload | KiroListModelsPayload | KiroLoginStatusPayload;

export type ValidationResult =
  | { ok: true; payload: KiroPayload }
  | { ok: false; error: string };

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_PROMPT = 100_000;
const MAX_RUN_ID = 256;
const MAX_URL = 2_048;

// ── validatePayload ───────────────────────────────────────────────────────────

export function validatePayload(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err('Payload must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const mode = obj.mode;
  if (mode !== 'kiro-run' && mode !== 'kiro-login' && mode !== 'kiro-list-models' && mode !== 'kiro-login-status') {
    return err('"mode" must be "kiro-run", "kiro-login", "kiro-list-models" or "kiro-login-status"');
  }

  if (typeof obj.runId !== 'string' || !obj.runId.trim()) {
    return err('"runId" must be a non-empty string');
  }
  if (obj.runId.length > MAX_RUN_ID) {
    return err(`"runId" exceeds maximum length of ${MAX_RUN_ID}`);
  }

  if (mode === 'kiro-login-status') {
    return { ok: true, payload: { mode: 'kiro-login-status', runId: (obj.runId as string).trim() } };
  }
  if (mode === 'kiro-run') {
    return validateKiroRun(obj);
  }
  if (mode === 'kiro-list-models') {
    const r = validateKiroRun({ ...obj, prompt: 'list-models' });
    if (!r.ok) return r;
    const run = r.payload as KiroRunPayload;
    return { ok: true, payload: { mode: 'kiro-list-models', runId: run.runId, token: run.token } };
  }
  return validateKiroLogin(obj);
}

function validateKiroRun(obj: Record<string, unknown>): ValidationResult {
  if (typeof obj.prompt !== 'string' || !obj.prompt.trim()) {
    return err('"prompt" must be a non-empty string');
  }
  if (obj.prompt.length > MAX_PROMPT) {
    return err(`"prompt" exceeds maximum length of ${MAX_PROMPT}`);
  }

  const t = obj.token;
  if (typeof t !== 'object' || t === null || Array.isArray(t)) {
    return err('"token" must be an object');
  }
  const tok = t as Record<string, unknown>;

  // Required token fields — validate presence only, never log values
  if (typeof tok.accessToken !== 'string' || !tok.accessToken) {
    return err('"token.accessToken" must be a non-empty string');
  }
  if (typeof tok.expiresAt !== 'string' || !tok.expiresAt) {
    return err('"token.expiresAt" must be a non-empty string');
  }
  if (typeof tok.region !== 'string' || !tok.region.trim()) {
    return err('"token.region" must be a non-empty string');
  }
  if (typeof tok.startUrl !== 'string' || !tok.startUrl.startsWith('https://')) {
    return err('"token.startUrl" must be a valid https URL');
  }
  if (tok.startUrl.length > MAX_URL) {
    return err(`"token.startUrl" exceeds maximum length of ${MAX_URL}`);
  }

  return {
    ok: true,
    payload: {
      mode: 'kiro-run',
      runId: (obj.runId as string).trim(),
      prompt: obj.prompt as string,
      ...(obj.browser === true ? { browser: true } : {}),
      ...(Array.isArray(obj.repos) ? { repos: obj.repos as unknown[] } : {}),
      token: {
        accessToken: tok.accessToken as string,
        expiresAt: tok.expiresAt as string,
        region: (tok.region as string).trim(),
        startUrl: tok.startUrl as string,
        refreshToken: typeof tok.refreshToken === 'string' && tok.refreshToken ? tok.refreshToken : undefined,
        clientId: typeof tok.clientId === 'string' && tok.clientId ? tok.clientId : undefined,
        clientSecret: typeof tok.clientSecret === 'string' && tok.clientSecret ? tok.clientSecret : undefined,
        clientSecretExpiresAt: typeof tok.clientSecretExpiresAt === 'number' ? tok.clientSecretExpiresAt : undefined,
        profileArn: typeof tok.profileArn === 'string' && tok.profileArn ? tok.profileArn : undefined,
        profileName: typeof tok.profileName === 'string' && tok.profileName ? tok.profileName : undefined,
      },
    },
  };
}

function validateKiroLogin(obj: Record<string, unknown>): ValidationResult {
  if (typeof obj.startUrl !== 'string' || !obj.startUrl.startsWith('https://')) {
    return err('"startUrl" must be a valid https URL');
  }
  if (obj.startUrl.length > MAX_URL) {
    return err(`"startUrl" exceeds maximum length of ${MAX_URL}`);
  }
  if (typeof obj.region !== 'string' || !obj.region.trim()) {
    return err('"region" must be a non-empty string');
  }

  return {
    ok: true,
    payload: {
      mode: 'kiro-login',
      runId: (obj.runId as string).trim(),
      startUrl: obj.startUrl as string,
      region: (obj.region as string).trim(),
    },
  };
}

function err(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}
