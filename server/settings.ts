/**
 * Settings module.
 *
 * Provides:
 *   getSetting / setSetting    — low-level key/value access
 *   getSettings                — typed Settings object
 *   getAgentEnv                — env vars for agent runs
 *   registerSettingsRoutes     — HTTP routes for settings CRUD + connection test
 */

import { router, sendJson, requireAuth, registerBackgroundWrite } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, getDb } from './db.ts';
import type { DatabaseSync } from 'node:sqlite';
import { encrypt, decrypt } from './secrets.ts';
import { config } from './config.ts';
import { badRequest, HttpError, now } from './util.ts';
import { getDelegationSettings, setDelegationSettings } from './delegation.ts';
import { getDelegationSettingsRepository } from './repositories/delegation-settings.ts';
import type { DelegationSettings } from './repositories/delegation-settings.ts';
import { spawn } from 'node:child_process';
import { resolveKiroCmd } from './kiro-cmd.ts';
import { spawnKiroListModels } from './kiro-list-models.ts';
import type { KiroModelRaw } from './kiro-list-models.ts';
import {
  getSettingsRepository,
  getSettingFromSnapshot,
  isSnapshotReady,
  _updateSnapshotKey,
  _updateSnapshotKeys,
} from './repositories/settings.ts';
import { usesDynamoDb } from './repositories/backend.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderMode = 'demo' | 'anthropic' | 'bedrock' | 'kiro' | 'litellm';
export type AwsAuth = 'ambient' | 'profile' | 'keys' | 'bedrock-key' | 'sso';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface Settings {
  provider: {
    mode: ProviderMode;
    hasKey: boolean;
    bedrockRegion: string;
    bedrockAuth: AwsAuth;
    bedrockProfile: string;
    bedrockAccessKeyId: string;
    bedrockSecretKey: string;
    anthropicKeyEnc: string;
    bedrockKeyEnc: string;
    ssoStartUrl: string;
    ssoRegion: string;
    ssoAccountId: string;
    ssoRoleName: string;
  };
  /** Agent-run behaviour limits and defaults. */
  agents: {
    /** Minutes an agent's question or tool approval waits for a person before the run carries on without it (0 = until the run is stopped). */
    approvalExpiryMinutes: number;
    /** Spend cap for one run in USD, subagents included (null = none). */
    maxBudgetUsdPerRun: number | null;
    /** Minutes one run may work, not counting time spent waiting for a person (null = no limit). */
    runTimeoutMinutes: number | null;
    /** Default thinking effort ('' = the model's own default). */
    effort: '' | EffortLevel;
    /** Minutes one MCP tool call (an integration) may take before Claude Code gives up on it. 0 or null = no limit. */
    mcpToolTimeoutMinutes: number;
  };
  deployTarget: string | null;
  trustProxy: boolean;
  cookieSecure: string;
  monthlyBudget: number | null;
  models: { sonnet: string; haiku: string; opus: string };
  /** The single default model ID used for all AI calls. Empty = use built-in default. */
  defaultModel: string;
  headroomProxyUrl: string;
  kiroApiKeySet: boolean;
  kiroApiKeyEnc: string;
  lastChangedAt: string | null;
  lastChangedBy: string | null;
  githubOauthClientId: string;
  litellm: {
    baseUrl: string;
    hasKey: boolean;
    model: string;
    showGatewayWarning: boolean;
  };
}

const DEFAULTS: Settings = {
  provider: {
    mode: 'demo',
    hasKey: false,
    bedrockRegion: 'us-east-1',
    bedrockAuth: 'ambient',
    bedrockProfile: '',
    bedrockAccessKeyId: '',
    bedrockSecretKey: '',
    anthropicKeyEnc: '',
    bedrockKeyEnc: '',
    ssoStartUrl: '',
    ssoRegion: '',
    ssoAccountId: '',
    ssoRoleName: '',
  },
  agents: {
    approvalExpiryMinutes: 60,
    maxBudgetUsdPerRun: 5,
    runTimeoutMinutes: 60,
    effort: '',
    mcpToolTimeoutMinutes: 10,
  },
  deployTarget: null,
  trustProxy: false,
  cookieSecure: 'auto',
  monthlyBudget: null,
  models: { sonnet: '', haiku: '', opus: '' },
  defaultModel: '',
  headroomProxyUrl: '',
  kiroApiKeySet: false,
  kiroApiKeyEnc: '',
  lastChangedAt: null,
  lastChangedBy: null,
  githubOauthClientId: '',
  litellm: {
    baseUrl: '',
    hasKey: false,
    model: 'gpt-4o',
    showGatewayWarning: true,
  },
};

// ── Low-level key/value helpers ───────────────────────────────────────────────

/**
 * Get a setting by key.
 *
 * DynamoDB mode: reads from the in-memory snapshot (version-checked per
 * request via refreshSnapshotIfStale) for cross-instance freshness.
 *
 * SQLite mode: always reads directly from the database so that any write —
 * including raw SQL in test setup, migrations, or manual edits — is
 * immediately visible on the next read.
 *
 * The `db` parameter is kept for backward compatibility; it is ignored when
 * the snapshot is used (DynamoDB mode with the global db).
 */
export function getSetting(_db: DatabaseSync, key: string): string | null {
  // DynamoDB: use snapshot for cross-instance freshness.
  // SQLite: always read directly — raw-SQL writes must be visible immediately.
  if (isSnapshotReady() && _db === getDb() && usesDynamoDb()) {
    return getSettingFromSnapshot(key);
  }
  const row = _db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Set a setting by key.
 *
 * Returns a `Promise<void>` that resolves when the write is durable (SQLite:
 * the transaction is committed; DynamoDB: the TransactWriteItems call
 * completes).  Callers inside async route handlers should `await` the result
 * so write failures are surfaced as HTTP errors rather than swallowed.
 *
 * When the repository is initialized: updates the snapshot optimistically
 * (synchronous, visible to the next getSetting call) and fires an async
 * write through the repository.  The write is also tracked via
 * registerBackgroundWrite so it completes before the HTTP response is sent.
 *
 * When the repository is not yet initialized (pre-startup test setup):
 * falls back to a direct synchronous SQLite write via `db` and returns a
 * resolved promise.
 *
 * The `db` parameter is kept for backward compatibility; it is ignored when
 * the repository is active.
 *
 * For atomic multi-key writes (e.g. the PUT /api/settings route), prefer
 * collecting pairs and calling repo.setKeys(pairs) directly.
 */
export function setSetting(_db: DatabaseSync, key: string, value: string): Promise<void> {
  const repo = getSettingsRepository();
  if (repo) {
    // Update snapshot optimistically (synchronous, visible to the next getSetting call)
    _updateSnapshotKey(key, value);
    // Fire async write through repository (SQLite: effectively sync; DynamoDB: truly async)
    const p = repo.setKey(key, value);
    // Register a silenced copy for background-write draining (no unhandled-rejection warning)
    try { registerBackgroundWrite(p.catch(() => {})); } catch { /* outside request context — best-effort */ }
    return p; // expose to caller: routes should await this to surface write errors
  } else {
    // Repository not yet initialized — direct SQLite fallback for test setup
    _db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
    return Promise.resolve();
  }
}

// ── Typed settings ────────────────────────────────────────────────────────────

/**
 * Build a typed Settings object.
 *
 * When called without a `db` argument (production code), reads from the
 * in-memory snapshot (no SQL).
 *
 * When called with an explicit `db` argument (test helpers that set up state
 * directly on a fresh in-memory database), reads from `db` to preserve test
 * isolation.  Pass `db` only in test code; production handlers should call
 * `getSettings()` without arguments.
 */
export function getSettings(_db?: DatabaseSync): Settings {
  // DynamoDB: use snapshot for cross-instance freshness (no explicit db).
  // SQLite: always read directly from the database.
  const useSnapshot = !_db && isSnapshotReady() && usesDynamoDb();
  const get = (key: string): string | null => {
    if (useSnapshot) return getSettingFromSnapshot(key);
    const d = _db ?? getDb();
    const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  };

  const out: Settings = JSON.parse(JSON.stringify(DEFAULTS));

  const providerMode = get('provider.mode');
  if (providerMode) {
    out.provider.mode = providerMode as ProviderMode;
  }

  const anthropicKeyEnc = get('anthropic.key.enc');
  if (anthropicKeyEnc) {
    out.provider.hasKey = true;
    out.provider.anthropicKeyEnc = anthropicKeyEnc;
  }

  const bedrockRegion = get('bedrock.region');
  if (bedrockRegion) out.provider.bedrockRegion = bedrockRegion;

  const bedrockAuth = get('bedrock.auth');
  if (bedrockAuth) out.provider.bedrockAuth = bedrockAuth as AwsAuth;

  const bedrockProfile = get('bedrock.profile');
  if (bedrockProfile) out.provider.bedrockProfile = bedrockProfile;

  const bedrockAccessKeyId = get('bedrock.access_key_id');
  if (bedrockAccessKeyId) out.provider.bedrockAccessKeyId = bedrockAccessKeyId;

  const bedrockKeyEnc = get('bedrock.secret_key.enc');
  if (bedrockKeyEnc) out.provider.bedrockKeyEnc = bedrockKeyEnc;

  const ssoStartUrl = get('bedrock.sso.startUrl');
  if (ssoStartUrl) out.provider.ssoStartUrl = ssoStartUrl;

  const ssoRegion = get('bedrock.sso.region');
  if (ssoRegion) out.provider.ssoRegion = ssoRegion;

  const ssoAccountId = get('bedrock.sso.accountId');
  if (ssoAccountId) out.provider.ssoAccountId = ssoAccountId;

  const ssoRoleName = get('bedrock.sso.roleName');
  if (ssoRoleName) out.provider.ssoRoleName = ssoRoleName;

  const deployTarget = get('deploy.target');
  if (deployTarget) out.deployTarget = deployTarget;

  // Agent-run limits
  const approvalExpiry = get('agents.approvalExpiryMinutes');
  if (approvalExpiry !== null) {
    const v = parseFloat(approvalExpiry);
    if (!isNaN(v)) out.agents.approvalExpiryMinutes = v;
  }
  const maxBudget = get('agents.maxBudgetUsdPerRun');
  if (maxBudget !== null) {
    const v = parseFloat(maxBudget);
    out.agents.maxBudgetUsdPerRun = isNaN(v) ? null : v;
  }
  const runTimeout = get('agents.runTimeoutMinutes');
  if (runTimeout !== null) {
    const v = parseFloat(runTimeout);
    out.agents.runTimeoutMinutes = isNaN(v) ? null : v;
  }
  const effortVal = get('agents.effort');
  if (effortVal !== null) out.agents.effort = effortVal as ('' | EffortLevel);

  const mcpTimeout = get('agents.mcpToolTimeoutMinutes');
  if (mcpTimeout !== null) {
    const v = parseInt(mcpTimeout, 10);
    if (!isNaN(v) && v >= 0) out.agents.mcpToolTimeoutMinutes = v;
  }


  const trustProxy = get('trust.proxy');
  if (trustProxy) out.trustProxy = trustProxy === 'true';

  const cookieSecure = get('cookie.secure');
  if (cookieSecure) out.cookieSecure = cookieSecure;

  const monthlyBudget = get('budget.monthly_usd');
  if (monthlyBudget !== null) {
    const v = parseFloat(monthlyBudget);
    out.monthlyBudget = isNaN(v) ? null : v;
  }

  const modelSonnet = get('model.sonnet');
  if (modelSonnet) out.models.sonnet = modelSonnet;

  const modelHaiku = get('model.haiku');
  if (modelHaiku) out.models.haiku = modelHaiku;

  const modelOpus = get('model.opus');
  if (modelOpus) out.models.opus = modelOpus;

  // defaultModel: explicit setting wins, then fall back to legacy model.sonnet for backward compat
  const defaultModelKey = get('default.model');
  if (defaultModelKey && defaultModelKey.trim()) {
    out.defaultModel = defaultModelKey.trim();
  } else {
    out.defaultModel = out.models.sonnet;
  }

  const headroomProxyUrl = get('headroom.proxy_url');
  if (headroomProxyUrl) out.headroomProxyUrl = headroomProxyUrl;

  const kiroKeyEnc = get('kiro.key.enc');
  if (kiroKeyEnc) {
    out.kiroApiKeySet = true;
    out.kiroApiKeyEnc = kiroKeyEnc;
  }

  const lastChangedAt = get('settings.last_changed_at');
  if (lastChangedAt) out.lastChangedAt = lastChangedAt;

  const lastChangedBy = get('settings.last_changed_by');
  if (lastChangedBy) out.lastChangedBy = lastChangedBy;

  const githubOauthClientId = get('github.oauth.clientId');
  if (githubOauthClientId) out.githubOauthClientId = githubOauthClientId;

  // LiteLLM gateway
  const litellmBaseUrl = get('litellm.baseUrl');
  if (litellmBaseUrl) out.litellm.baseUrl = litellmBaseUrl;
  const litellmKeyEnc = get('litellm.key.enc');
  if (litellmKeyEnc) out.litellm.hasKey = true;
  const litellmModel = get('litellm.model');
  if (litellmModel) {
    try { out.litellm.model = JSON.parse(litellmModel); } catch { /* keep default */ }
  }

  return out;
}

// ── Public (safe) settings view ───────────────────────────────────────────────

function publicSettings(_db?: DatabaseSync): object {
  const s = getSettings(_db);
  // Import lazily to avoid circular reference (bedrock-sso imports settings)
  let ssoState: { signedIn: boolean; expiresAt: string | null; accountId: string | null; roleName: string | null } = {
    signedIn: false, expiresAt: null, accountId: null, roleName: null,
  };
  try {
    // We read directly from the settings table rather than importing bedrock-sso
    // to avoid a circular dependency at module load time.
    const hasToken = Boolean(getSetting(_db ?? getDb(), 'bedrock.sso.accessToken.enc'));
    ssoState = {
      signedIn: hasToken,
      expiresAt: getSetting(_db ?? getDb(), 'bedrock.sso.accessToken.expiry') ?? null,
      accountId: getSetting(_db ?? getDb(), 'bedrock.sso.accountId') ?? null,
      roleName: getSetting(_db ?? getDb(), 'bedrock.sso.roleName') ?? null,
    };
  } catch { /* ignore */ }

  return {
    provider: {
      mode: s.provider.mode,
      hasKey: s.provider.hasKey,
      bedrockRegion: s.provider.bedrockRegion,
      bedrockAuth: s.provider.bedrockAuth,
      bedrockProfile: s.provider.bedrockProfile,
      // Only show whether keys are set — never the actual encrypted values
      anthropicKey: s.provider.hasKey ? '***' : '',
      bedrockKey: s.provider.bedrockKeyEnc ? '***' : '',
      bedrockAccessKeyId: s.provider.bedrockAccessKeyId || '',
      ssoStartUrl: s.provider.ssoStartUrl,
      ssoRegion: s.provider.ssoRegion,
      ssoAccountId: s.provider.ssoAccountId,
      ssoRoleName: s.provider.ssoRoleName,
      sso: ssoState,
    },
    deployTarget: s.deployTarget,
    trustProxy: s.trustProxy,
    cookieSecure: s.cookieSecure,
    monthlyBudget: s.monthlyBudget,
    models: s.models,
    defaultModel: s.defaultModel,
    headroomProxyUrl: s.headroomProxyUrl,
    kiroApiKeySet: s.kiroApiKeySet,
    lastChangedAt: s.lastChangedAt,
    lastChangedBy: s.lastChangedBy,
    github: {
      oauthClientId: s.githubOauthClientId,
      deviceFlowEnabled: Boolean(s.githubOauthClientId),
    },
    litellm: {
      baseUrl: s.litellm.baseUrl,
      hasKey: s.litellm.hasKey,
      model: s.litellm.model,
      showGatewayWarning: s.litellm.showGatewayWarning,
    },
    agents: {
      approvalExpiryMinutes: s.agents.approvalExpiryMinutes,
      maxBudgetUsdPerRun: s.agents.maxBudgetUsdPerRun,
      runTimeoutMinutes: s.agents.runTimeoutMinutes,
      effort: s.agents.effort,
    },
  };
}

// ── Agent environment ─────────────────────────────────────────────────────────

/**
 * Returns the environment variables to inject into agent runs.
 * Decrypts stored secrets using the portal's secret key.
 */
export async function getAgentEnv(db?: DatabaseSync, _projectId?: string): Promise<Record<string, string>> {
  const d = db ?? getDb();
  const s = getSettings(d);
  const env: Record<string, string> = {};

  // All Claude runs share one config folder; auto-memory would carry notes across
  // projects unreviewed. Project knowledge uses CLAUDE.md and the decisions log.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';

  // MCP (integration) tool calls have no built-in time limit in Claude Code.
  // A hung integration would hold the run and its slot indefinitely.
  const mcpMinutes = s.agents.mcpToolTimeoutMinutes ?? 10;
  if (mcpMinutes > 0) {
    env.MCP_TOOL_TIMEOUT = String(mcpMinutes * 60_000);
  }

  if (s.provider.mode === 'anthropic' && s.provider.anthropicKeyEnc) {
    try {
      const key = decrypt(s.provider.anthropicKeyEnc, config.secretKey);
      if (key) env.ANTHROPIC_API_KEY = key;
    } catch {
      // Failed to decrypt — agent will error with a clear message
    }
  }

  if (s.provider.mode === 'bedrock') {
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    env.AWS_REGION = s.provider.bedrockRegion;
    env.AWS_DEFAULT_REGION = s.provider.bedrockRegion;

    if (s.provider.bedrockAuth === 'keys') {
      if (s.provider.bedrockAccessKeyId) {
        env.AWS_ACCESS_KEY_ID = s.provider.bedrockAccessKeyId;
      }
      if (s.provider.bedrockKeyEnc) {
        try {
          const secretKey = decrypt(s.provider.bedrockKeyEnc, config.secretKey);
          if (secretKey) env.AWS_SECRET_ACCESS_KEY = secretKey;
        } catch {
          // decrypt failure
        }
      }
    } else if (s.provider.bedrockAuth === 'profile' && s.provider.bedrockProfile) {
      env.AWS_PROFILE = s.provider.bedrockProfile;
    } else if (s.provider.bedrockAuth === 'bedrock-key' && s.provider.bedrockKeyEnc) {
      try {
        const bedrockKey = decrypt(s.provider.bedrockKeyEnc, config.secretKey);
        if (bedrockKey) env.AWS_BEARER_TOKEN_BEDROCK = bedrockKey;
      } catch {
        // decrypt failure
      }
    } else if (s.provider.bedrockAuth === 'sso') {
      // Fetch short-lived role credentials from the portal SSO session
      const { getBedrockSsoCredentials } = await import('./bedrock-sso.ts');
      try {
        const creds = await getBedrockSsoCredentials();
        env.AWS_ACCESS_KEY_ID = creds.accessKeyId;
        env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
        if (creds.sessionToken) env.AWS_SESSION_TOKEN = creds.sessionToken;
      } catch (e: unknown) {
        // Propagate the clear SSO error — agent run should fail with it
        throw e;
      }
    }
  }

  if (s.kiroApiKeySet && s.kiroApiKeyEnc) {
    try {
      const kiroKey = decrypt(s.kiroApiKeyEnc, config.secretKey);
      if (kiroKey) env.KIRO_API_KEY = kiroKey;
    } catch {
      // decrypt failure
    }
  }

  if (s.headroomProxyUrl) {
    env.ANTHROPIC_BASE_URL = s.headroomProxyUrl;
  }

  // Credential scrubbing: keep model keys out of the agent's shell commands.
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 makes Claude Code drop *_KEY, *_SECRET, *_TOKEN
  // vars from the environment it passes to shell commands and MCP servers.
  // On Windows this only hides the variables. On Linux/macOS it also activates
  // Claude Code's sandbox mode, which requires bubblewrap+socat; without them every
  // shell command fails. So on Linux/macOS it is off by default (PORTAL_AGENT_ENV_SCRUB=1
  // enables it for operators who have set up the sandbox).
  // server/agent/env-scrub.ts's scrubEnvForShell() is used for AgentCore containers.
  if (s.provider.mode === 'anthropic' || s.provider.mode === 'bedrock') {
    const { shouldScrubSdkEnv } = await import('./agent/env-scrub.ts');
    if (shouldScrubSdkEnv()) {
      env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
    }
  }

  return env;
}

// ── Auth helper ───────────────────────────────────────────────────────────────

function requireAdmin(req: PortalRequest, res: PortalResponse): boolean {
  if (!req.user?.is_admin) {
    sendJson(res, 403, { error: 'Admin access required' });
    return false;
  }
  return true;
}

// ── Kiro CLI status check (for testConnection / listModels) ───────────────────

async function checkKiroSignedIn(): Promise<{ installed: boolean; signedIn: boolean }> {
  const { cmd, fullArgs: args } = resolveKiroCmd(['whoami']);

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, shell: false });
    } catch {
      resolve({ installed: false, signedIn: false });
      return;
    }
    child.on('error', (e: NodeJS.ErrnoException) => {
      resolve({ installed: e.code !== 'ENOENT', signedIn: false });
    });
    child.on('close', (code) => resolve({ installed: code !== 127, signedIn: code === 0 }));
    setTimeout(() => {
      try { child.kill(); } catch { /* ok */ }
      resolve({ installed: false, signedIn: false });
    }, 6_000).unref();
  });
}

// ── Connection test ───────────────────────────────────────────────────────────

async function testConnection(
  modeOverride?: string,
  db?: DatabaseSync,
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const d = db ?? getDb();
  const s = getSettings(d);
  const mode = (modeOverride as ProviderMode) ?? s.provider.mode;

  if (mode === 'demo') {
    return { ok: true, models: ['demo-model'] };
  }

  if (mode === 'kiro') {
    const status = await checkKiroSignedIn();
    if (!status.installed) {
      return { ok: false, error: 'kiro-cli is not installed or not on PATH. Install it via Settings › Tool packs › Kiro CLI.' };
    }
    if (!status.signedIn) {
      return { ok: false, error: 'Kiro CLI is not signed in. Sign in via Settings › Provider › Kiro sign-in.' };
    }
    // Get real model list so the UI shows actual model IDs and count
    const kiroEnv: Record<string, string> = {};
    if (s.kiroApiKeySet && s.kiroApiKeyEnc) {
      try { kiroEnv.KIRO_API_KEY = decrypt(s.kiroApiKeyEnc, config.secretKey); } catch { /* ok */ }
    }
    const listResult = await spawnKiroListModels({ ...process.env, ...kiroEnv });
    if (listResult.models.length > 0) {
      return { ok: true, models: listResult.models.map((m) => m.model_id) };
    }
    return { ok: true, models: [] };
  }

  if (mode === 'anthropic') {
    if (!s.provider.anthropicKeyEnc) {
      return { ok: false, error: 'No Anthropic API key set. Add one in Settings.' };
    }
    let apiKey: string;
    try {
      apiKey = decrypt(s.provider.anthropicKeyEnc, config.secretKey);
    } catch {
      return { ok: false, error: 'Could not decrypt Anthropic API key.' };
    }

    try {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const msg = (body as { error?: { message?: string } }).error?.message || res.statusText;
        return { ok: false, error: `Anthropic API error: ${msg}` };
      }
      const data = await res.json() as { data?: Array<{ id: string }> };
      const models = (data.data ?? []).map((m) => m.id).slice(0, 10);
      return { ok: true, models };
    } catch (e: unknown) {
      return { ok: false, error: `Connection failed: ${String((e as Error)?.message ?? e)}` };
    }
  }

  if (mode === 'bedrock') {
    const region = s.provider.bedrockRegion || 'us-east-1';
    try {
      // Lazy import of AWS SDK to avoid startup cost when not using Bedrock
      type BedrockModule = {
        BedrockClient: new (opts: object) => {
          send: (cmd: object) => Promise<{ foundationModelSummaries?: Array<{ modelId: string }> }>;
        };
        ListFoundationModelsCommand: new (opts?: object) => object;
      };
      const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-bedrock') as Promise<BedrockModule>);

      const clientOpts: Record<string, unknown> = { region };
      if (s.provider.bedrockAuth === 'sso') {
        const { getBedrockSsoCredentials } = await import('./bedrock-sso.ts');
        try {
          const creds = await getBedrockSsoCredentials();
          clientOpts.credentials = {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken,
          };
        } catch (e: unknown) {
          return { ok: false, error: String((e as Error)?.message ?? e) };
        }
      } else if (s.provider.bedrockAuth === 'profile' && s.provider.bedrockProfile) {
        const credMod = await (Function('m', 'return import(m)')('@aws-sdk/credential-providers') as Promise<{
          fromIni: (opts: object) => unknown;
        }>);
        clientOpts.credentials = credMod.fromIni({ profile: s.provider.bedrockProfile });
      } else if (s.provider.bedrockAuth === 'keys') {
        const accessKeyId = s.provider.bedrockAccessKeyId;
        let secretAccessKey = '';
        if (s.provider.bedrockKeyEnc) {
          try {
            secretAccessKey = decrypt(s.provider.bedrockKeyEnc, config.secretKey);
          } catch {
            // ignore
          }
        }
        if (accessKeyId && secretAccessKey) {
          clientOpts.credentials = { accessKeyId, secretAccessKey };
        }
      } else if (s.provider.bedrockAuth === 'bedrock-key' && s.provider.bedrockKeyEnc) {
        try {
          const bedrockKey = decrypt(s.provider.bedrockKeyEnc, config.secretKey);
          // Pass bearer token via client options only — never write to process.env
          clientOpts.token = { token: bedrockKey };
        } catch {
          // ignore
        }
      }

      const client = new mod.BedrockClient(clientOpts);
      const result = await client.send(new mod.ListFoundationModelsCommand({}));
      const models = (result.foundationModelSummaries ?? [])
        .map((m) => m.modelId)
        .filter((id) => /claude/i.test(id))
        .slice(0, 20);
      return { ok: true, models };
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      // Provide a clear message for SSO profile token expiry
      if (
        s.provider.bedrockAuth === 'profile' &&
        (
          ['UnauthorizedException', 'ExpiredTokenException', 'InvalidClientTokenIdException',
            'TokenRefreshRequired', 'AuthorizationErrorException'].includes((e as { name?: string }).name ?? '') ||
          msg.includes('SSO') || msg.includes('sso login') || msg.includes('expired') || msg.includes('InvalidGrant')
        )
      ) {
        return {
          ok: false,
          error: `AWS SSO cached token for profile '${s.provider.bedrockProfile}' is missing or expired. ` +
            `Run 'aws sso login --profile ${s.provider.bedrockProfile}' on the server to refresh it.`,
        };
      }
      return { ok: false, error: `Bedrock connection failed: ${msg}` };
    }
  }

  return { ok: false, error: `Unknown provider mode: ${mode}` };
}

// ── Model listing ────────────────────────────────────────────────────────────

export interface ModelEntry {
  id: string;
  label: string;
}

export interface ModelGroup {
  label: string;
  models: ModelEntry[];
}

export interface ModelListResponse {
  provider: string;
  source: 'live' | 'fallback';
  error: string | null;
  groups: ModelGroup[];
}

// ── Cache (5-minute TTL per provider) ────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  expiry: number;
  response: ModelListResponse;
}

const modelListCache = new Map<string, CacheEntry>();

/** @internal Test hook — clear the model list cache. */
export function _clearModelListCache(): void {
  modelListCache.clear();
}

// ── Bedrock listing mock injection (tests) ────────────────────────────────────

export interface FoundationModelSummary {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
}

export interface InferenceProfileSummary {
  inferenceProfileId?: string;
  inferenceProfileName?: string;
  type?: string;
  status?: string;
}

export interface BedrockListingMock {
  foundationModels?: FoundationModelSummary[];
  inferenceProfiles?: InferenceProfileSummary[];
  throwError?: string;
}

let _bedrockListingMock: BedrockListingMock | null = null;

/** @internal Test hook — inject mock Bedrock listing data. Pass null to restore real SDK. */
export function setBedrockListingMock(mock: BedrockListingMock | null): void {
  _bedrockListingMock = mock;
}

// ── Static fallback model lists ───────────────────────────────────────────────

const ANTHROPIC_FALLBACK: ModelGroup[] = [
  {
    label: 'Anthropic',
    models: [
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
];

const LITELLM_FALLBACK: ModelGroup[] = [
  {
    label: 'LiteLLM',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    ],
  },
];

// ── Region-aware Bedrock fallback ─────────────────────────────────────────────

/**
 * Maps an AWS Bedrock source region to its geo prefix for system-defined
 * cross-region inference profiles.
 *
 * Mapping is derived from AWS documentation (GetInferenceProfile source/dest tables):
 *   us/ca  → us   (US geographic profile)
 *   eu     → eu   (EU geographic profile)
 *   ap-southeast-2/-4/-6 → au  (Australia geographic profile)
 *   ap-northeast-1/-3    → jp  (Japan geographic profile)
 *   ap-south-1/-2        → in  (India geographic profile — Haiku 4.5 only)
 *   everything else      → global (all other APAC, ME, AF, SA, MX)
 */
export function regionToGeoPrefix(region: string): string {
  if (region.startsWith('us-') || region.startsWith('ca-')) return 'us';
  if (region.startsWith('eu-')) return 'eu';
  if (region === 'ap-southeast-2' || region === 'ap-southeast-4' || region === 'ap-southeast-6') return 'au';
  if (region === 'ap-northeast-1' || region === 'ap-northeast-3') return 'jp';
  if (region === 'ap-south-1' || region === 'ap-south-2') return 'in';
  return 'global';
}

function geoPrefixLabel(prefix: string): string {
  switch (prefix) {
    case 'us': return 'US cross-region';
    case 'eu': return 'EU cross-region';
    case 'au': return 'AU cross-region';
    case 'jp': return 'JP cross-region';
    case 'in': return 'India cross-region';
    default:   return 'global cross-region';
  }
}

interface FallbackModelSpec {
  name: string;
  baseId: string;
  /** Geo prefixes this model actually supports (global is always supported). */
  geoSupport: string[];
}

const BEDROCK_FALLBACK_SPECS: FallbackModelSpec[] = [
  {
    name: 'Claude Opus 4.5',
    baseId: 'anthropic.claude-opus-4-5-20251101-v1:0',
    geoSupport: ['us', 'eu'],
  },
  {
    name: 'Claude Sonnet 4.5',
    baseId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    geoSupport: ['us', 'eu', 'au', 'jp'],
  },
  {
    name: 'Claude Haiku 4.5',
    baseId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    geoSupport: ['us', 'eu', 'au', 'jp', 'in'],
  },
];

/**
 * Returns a region-appropriate static fallback model list for Bedrock.
 * Uses geo-prefixed inference profile IDs where available, falling back to
 * the global cross-region profile for regions without a dedicated geo prefix.
 *
 * If `defaultModel` is provided and is a cross-region profile ID not already
 * in the generated list, it is appended under its own group so the user can
 * see their saved default model even when it belongs to a different region.
 */
export function bedrockFallbackForRegion(region: string, defaultModel?: string): ModelGroup[] {
  const prefix = regionToGeoPrefix(region);
  const entries: ModelEntry[] = BEDROCK_FALLBACK_SPECS.map((spec) => {
    const effectivePrefix = spec.geoSupport.includes(prefix) ? prefix : 'global';
    return {
      id: `${effectivePrefix}.${spec.baseId}`,
      label: `${spec.name} (${geoPrefixLabel(effectivePrefix)})`,
    };
  });

  const groups: ModelGroup[] = [{ label: 'Anthropic', models: entries }];

  if (defaultModel) {
    const allIds = entries.map((e) => e.id);
    const hasCrossRegionPrefix = /^(us|eu|au|jp|in|global)\./.test(defaultModel);
    if (!allIds.includes(defaultModel) && hasCrossRegionPrefix) {
      groups.push({
        label: 'Other region (current default)',
        models: [{ id: defaultModel, label: `${defaultModel} (other region)` }],
      });
    }
  }

  return groups;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Kiro model grouping helpers ───────────────────────────────────────────────

function inferKiroVendor(modelId: string): string {
  if (modelId === 'auto') return 'Auto';
  if (modelId.startsWith('claude-')) return 'Anthropic';
  if (modelId.startsWith('gpt-')) return 'OpenAI';
  if (modelId.startsWith('deepseek-')) return 'DeepSeek';
  if (modelId.startsWith('minimax-')) return 'MiniMax';
  if (modelId.startsWith('glm-')) return 'GLM';
  if (modelId.startsWith('qwen')) return 'Qwen';
  return 'Other';
}

function formatKiroContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    const s = m % 1 === 0 ? String(m) : m.toFixed(1).replace(/\.0$/, '');
    return `${s}M ctx`;
  }
  return `${Math.round(tokens / 1_000)}K ctx`;
}

function formatKiroCreditsMultiplier(r: number): string {
  const s = String(r);
  return (s.includes('.') ? s : `${s}.0`) + '×';
}

function humanizeKiroModelName(modelId: string): string {
  if (modelId === 'auto') return 'Auto';
  if (modelId.startsWith('gpt-')) {
    const rest = modelId.slice(4).split('-').map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(' ');
    return `GPT ${rest}`;
  }
  if (modelId.startsWith('deepseek-')) {
    const rest = modelId.slice(9).split('-').map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(' ');
    return `DeepSeek ${rest}`;
  }
  if (modelId.startsWith('minimax-')) {
    const rest = modelId.slice(8).split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    return `MiniMax ${rest}`;
  }
  if (modelId.startsWith('glm-')) {
    return `GLM ${modelId.slice(4)}`;
  }
  if (modelId.startsWith('qwen')) {
    return modelId.split('-').map((p, i) => {
      if (i === 0) return p.charAt(0).toUpperCase() + p.slice(1);
      return /^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1);
    }).join(' ');
  }
  // Default / claude-*: split by hyphens, title-case words, leave version numbers as-is
  return modelId.split('-').map((p) => (/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(' ');
}

function buildKiroLabel(m: KiroModelRaw): string {
  if (m.model_id === 'auto') return 'Auto (Kiro picks per task)';
  const name = humanizeKiroModelName(m.model_id);
  const parts: string[] = [name];
  if (m.context_window_tokens != null && m.context_window_tokens > 0) {
    parts.push(formatKiroContextWindow(m.context_window_tokens));
  }
  if (m.rate_multiplier != null) {
    parts.push(`${formatKiroCreditsMultiplier(m.rate_multiplier)} credits`);
  }
  return parts.join(' · ');
}

const KIRO_VENDOR_ORDER = ['Auto', 'Anthropic', 'OpenAI', 'DeepSeek', 'MiniMax', 'GLM', 'Qwen', 'Other'] as const;
type KiroVendor = typeof KIRO_VENDOR_ORDER[number];

function groupKiroModels(models: KiroModelRaw[]): ModelGroup[] {
  const vendorMap = new Map<string, ModelEntry[]>();

  for (const m of models) {
    const vendor = inferKiroVendor(m.model_id);
    if (!vendorMap.has(vendor)) vendorMap.set(vendor, []);
    vendorMap.get(vendor)!.push({ id: m.model_id, label: buildKiroLabel(m) });
  }

  const groups: ModelGroup[] = [];
  for (const vendor of KIRO_VENDOR_ORDER) {
    if (vendorMap.has(vendor)) {
      groups.push({ label: vendor, models: vendorMap.get(vendor)! });
      vendorMap.delete(vendor);
    }
  }
  // Append any remaining unknown vendors
  for (const [vendor, entries] of vendorMap) {
    groups.push({ label: vendor, models: entries });
  }
  return groups;
}

function bedrockProviderLabel(id: string, providerName?: string): string {
  if (providerName) return providerName;
  const stripped = id.replace(/^(?:us|eu|ap|global)\./, '');
  const m = stripped.match(/^([^.]+)\./);
  if (!m) return 'Other';
  const p = m[1];
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function inferenceProfileLabel(profileId: string, profileName?: string): string {
  if (profileName) return profileName;
  const regionM = profileId.match(/^(us|eu|ap|global)\./);
  const regionSuffix = regionM
    ? ` (${regionM[1] === 'global' ? 'global cross-region' : `${regionM[1].toUpperCase()} cross-region`})`
    : '';
  const base = profileId
    .replace(/^(?:us|eu|ap|global)\./, '')
    .replace(/^[^.]+\./, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/-\d{8}-v\d+$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-/g, ' ')
    .trim();
  return base.replace(/\b\w/g, (c) => c.toUpperCase()) + regionSuffix;
}

/**
 * List available models for the given provider using saved credentials.
 * Returns a static fallback (source: "fallback") on failure.
 * Results are cached for 5 minutes; pass refresh=true to bypass.
 */
export async function listModelsForProvider(
  provider: string,
  db?: DatabaseSync,
  refresh = false,
): Promise<ModelListResponse> {
  const d = db ?? getDb();
  const s = getSettings(d);

  const cacheKey = provider;
  if (!refresh) {
    const entry = modelListCache.get(cacheKey);
    if (entry && Date.now() < entry.expiry) return entry.response;
  }

  const store = (result: ModelListResponse): ModelListResponse => {
    modelListCache.set(cacheKey, { expiry: Date.now() + CACHE_TTL_MS, response: result });
    return result;
  };

  if (provider === 'demo') {
    return store({ provider, source: 'fallback', error: null, groups: [] });
  }

  if (provider === 'kiro') {
    const kiroStatus = await checkKiroSignedIn();
    if (!kiroStatus.installed) {
      return store({
        provider,
        source: 'fallback',
        error: 'kiro-cli is not installed or not on PATH. Install it via Settings › Tool packs › Kiro CLI.',
        groups: [],
      });
    }
    if (!kiroStatus.signedIn) {
      return store({
        provider,
        source: 'fallback',
        error: 'Kiro CLI is not signed in. Sign in via Settings › Provider › Kiro sign-in.',
        groups: [],
      });
    }

    // Build portal env: use portal Kiro API key if configured
    const kiroEnv: Record<string, string> = {};
    if (s.kiroApiKeySet && s.kiroApiKeyEnc) {
      try { kiroEnv.KIRO_API_KEY = decrypt(s.kiroApiKeyEnc, config.secretKey); } catch { /* ok */ }
    }

    const listResult = await spawnKiroListModels({ ...process.env, ...kiroEnv });

    if (listResult.error) {
      return store({ provider, source: 'fallback', error: listResult.error, groups: [] });
    }

    const groups = groupKiroModels(listResult.models);
    return store({ provider, source: 'live', error: null, groups });
  }

  if (provider === 'anthropic') {
    if (!s.provider.anthropicKeyEnc) {
      return store({ provider, source: 'fallback', error: 'No Anthropic API key configured.', groups: ANTHROPIC_FALLBACK });
    }
    let apiKey: string;
    try {
      apiKey = decrypt(s.provider.anthropicKeyEnc, config.secretKey);
    } catch {
      return store({ provider, source: 'fallback', error: 'Could not decrypt Anthropic API key.', groups: ANTHROPIC_FALLBACK });
    }
    try {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const msg = (body as { error?: { message?: string } }).error?.message || res.statusText;
        return store({ provider, source: 'fallback', error: `Anthropic API error: ${msg}`, groups: ANTHROPIC_FALLBACK });
      }
      const data = await res.json() as { data?: Array<{ id: string; display_name?: string; type?: string }> };
      const all = (data.data ?? [])
        .filter((m) => !m.type || m.type === 'model')
        .map((m) => ({ id: m.id, label: m.display_name || m.id }))
        .sort((a, b) => b.id.localeCompare(a.id));
      return store({ provider, source: 'live', error: null, groups: all.length > 0 ? [{ label: 'Anthropic', models: all }] : [] });
    } catch (e: unknown) {
      return store({ provider, source: 'fallback', error: `Connection failed: ${String((e as Error)?.message ?? e)}`, groups: ANTHROPIC_FALLBACK });
    }
  }

  if (provider === 'bedrock') {
    const region = s.provider.bedrockRegion || 'us-east-1';
    try {
      let foundationModels: FoundationModelSummary[];
      let inferenceProfiles: InferenceProfileSummary[];

      if (_bedrockListingMock) {
        if (_bedrockListingMock.throwError) throw new Error(_bedrockListingMock.throwError);
        foundationModels = _bedrockListingMock.foundationModels ?? [];
        inferenceProfiles = _bedrockListingMock.inferenceProfiles ?? [];
      } else {
        type BM = {
          BedrockClient: new (opts: object) => { send(cmd: object): Promise<unknown> };
          ListFoundationModelsCommand: new (opts?: object) => object;
          ListInferenceProfilesCommand: new (opts?: object) => object;
        };
        const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-bedrock') as Promise<BM>);
        const clientOpts: Record<string, unknown> = { region };
        if (s.provider.bedrockAuth === 'sso') {
          const { getBedrockSsoCredentials } = await import('./bedrock-sso.ts');
          try {
            const creds = await getBedrockSsoCredentials();
            clientOpts.credentials = {
              accessKeyId: creds.accessKeyId,
              secretAccessKey: creds.secretAccessKey,
              sessionToken: creds.sessionToken,
            };
          } catch (e: unknown) {
            return store({
              provider,
              source: 'fallback',
              error: String((e as Error)?.message ?? e),
              groups: bedrockFallbackForRegion(region, s.defaultModel),
            });
          }
        } else if (s.provider.bedrockAuth === 'profile' && s.provider.bedrockProfile) {
          const credMod = await (Function('m', 'return import(m)')('@aws-sdk/credential-providers') as Promise<{ fromIni: (opts: object) => unknown }>);
          clientOpts.credentials = credMod.fromIni({ profile: s.provider.bedrockProfile });
        } else if (s.provider.bedrockAuth === 'keys') {
          const accessKeyId = s.provider.bedrockAccessKeyId;
          let secretAccessKey = '';
          if (s.provider.bedrockKeyEnc) {
            try { secretAccessKey = decrypt(s.provider.bedrockKeyEnc, config.secretKey); } catch { /* ignore */ }
          }
          if (accessKeyId && secretAccessKey) clientOpts.credentials = { accessKeyId, secretAccessKey };
        } else if (s.provider.bedrockAuth === 'bedrock-key' && s.provider.bedrockKeyEnc) {
          try {
            const bedrockKey = decrypt(s.provider.bedrockKeyEnc, config.secretKey);
            clientOpts.token = { token: bedrockKey };
          } catch { /* ignore */ }
        }
        const client = new mod.BedrockClient(clientOpts);
        const [fmResult, ipResult] = await Promise.all([
          client.send(new mod.ListFoundationModelsCommand({})) as Promise<{ foundationModelSummaries?: FoundationModelSummary[] }>,
          client.send(new mod.ListInferenceProfilesCommand({ type: 'SYSTEM_DEFINED' })).catch(() => ({ inferenceProfileSummaries: [] })) as Promise<{ inferenceProfileSummaries?: InferenceProfileSummary[] }>,
        ]);
        foundationModels = fmResult.foundationModelSummaries ?? [];
        inferenceProfiles = (ipResult as { inferenceProfileSummaries?: InferenceProfileSummary[] }).inferenceProfileSummaries ?? [];
      }

      const textModels = foundationModels.filter((m) => m.outputModalities?.includes('TEXT'));
      const activeProfiles = inferenceProfiles.filter(
        (p) => (!p.type || p.type === 'SYSTEM_DEFINED') && (!p.status || p.status === 'ACTIVE'),
      );

      const groupMap = new Map<string, ModelEntry[]>();
      const addToGroup = (groupLabel: string, entry: ModelEntry) => {
        if (!groupMap.has(groupLabel)) groupMap.set(groupLabel, []);
        groupMap.get(groupLabel)!.push(entry);
      };

      for (const m of textModels) {
        if (!m.modelId) continue;
        addToGroup(bedrockProviderLabel(m.modelId, m.providerName), { id: m.modelId, label: m.modelName ?? m.modelId });
      }
      for (const p of activeProfiles) {
        if (!p.inferenceProfileId) continue;
        addToGroup(bedrockProviderLabel(p.inferenceProfileId), {
          id: p.inferenceProfileId,
          label: inferenceProfileLabel(p.inferenceProfileId, p.inferenceProfileName),
        });
      }

      for (const models of groupMap.values()) {
        models.sort((a, b) => b.id.localeCompare(a.id));
      }

      const groups: ModelGroup[] = [...groupMap.entries()]
        .sort(([a], [b]) => {
          if (a === 'Anthropic') return -1;
          if (b === 'Anthropic') return 1;
          return a.localeCompare(b);
        })
        .map(([label, models]) => ({ label, models }));

      return store({ provider, source: 'live', error: null, groups });
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      if (
        s.provider.bedrockAuth === 'profile' &&
        (
          ['UnauthorizedException', 'ExpiredTokenException', 'InvalidClientTokenIdException',
            'TokenRefreshRequired', 'AuthorizationErrorException'].includes((e as { name?: string }).name ?? '') ||
          msg.includes('SSO') || msg.includes('sso login') || msg.includes('expired') || msg.includes('InvalidGrant')
        )
      ) {
        return store({
          provider,
          source: 'fallback',
          error: `AWS SSO cached token for profile '${s.provider.bedrockProfile}' is missing or expired. ` +
            `Run 'aws sso login --profile ${s.provider.bedrockProfile}' on the server to refresh it.`,
          groups: bedrockFallbackForRegion(region, s.defaultModel),
        });
      }
      return store({ provider, source: 'fallback', error: `Bedrock connection failed: ${msg}`, groups: bedrockFallbackForRegion(region, s.defaultModel) });
    }
  }

  if (provider === 'litellm') {
    const baseUrl = s.litellm.baseUrl;
    if (!baseUrl) {
      return store({ provider, source: 'fallback', error: 'No LiteLLM base URL configured.', groups: LITELLM_FALLBACK });
    }
    try {
      const keyEncRaw = getSetting(getDb(), 'litellm.key.enc');
      let apiKey = '';
      if (keyEncRaw) {
        try { apiKey = decrypt(keyEncRaw, config.secretKey); } catch { /* ignore */ }
      }
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return store({ provider, source: 'fallback', error: `LiteLLM gateway error: ${res.statusText}`, groups: LITELLM_FALLBACK });
      }
      const data = await res.json() as { data?: Array<{ id: string }> };
      const all = (data.data ?? []).map((m) => ({ id: m.id, label: m.id }));
      if (all.length === 0) return store({ provider, source: 'live', error: null, groups: [] });

      const groupMap = new Map<string, ModelEntry[]>();
      for (const m of all) {
        let g = 'LiteLLM';
        if (m.id.startsWith('claude')) g = 'Anthropic';
        else if (m.id.startsWith('gpt') || m.id.startsWith('o1') || m.id.startsWith('o3')) g = 'OpenAI';
        else if (m.id.startsWith('gemini')) g = 'Google';
        else if (m.id.startsWith('llama') || m.id.startsWith('meta.')) g = 'Meta';
        if (!groupMap.has(g)) groupMap.set(g, []);
        groupMap.get(g)!.push(m);
      }
      const groups: ModelGroup[] = [...groupMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, models]) => ({ label, models }));
      return store({ provider, source: 'live', error: null, groups });
    } catch (e: unknown) {
      return store({ provider, source: 'fallback', error: `LiteLLM connection failed: ${String((e as Error)?.message ?? e)}`, groups: LITELLM_FALLBACK });
    }
  }

  return { provider, source: 'fallback', error: 'Unknown provider', groups: [] };
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerSettingsRoutes(): void {
  // GET /api/settings — returns all settings (safe view)
  router.get('/api/settings', requireAuth((req, res) => {
    sendJson(res, 200, publicSettings());
  }));

  // PUT /api/settings — update settings (admin only)
  router.put('/api/settings', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const body = req.body as Record<string, unknown>;
    const db = getDb();

    // Collect all key-value pairs for a single atomic write
    const pairs: Array<[string, string]> = [];
    const set = (key: string, value: string) => pairs.push([key, value]);

    if (body.provider) {
      const p = body.provider as Record<string, unknown>;
      if (p.mode !== undefined) {
        const mode = String(p.mode);
        if (!['demo', 'anthropic', 'bedrock', 'kiro', 'litellm'].includes(mode)) {
          throw badRequest('Unknown provider mode');
        }
        set('provider.mode', mode);
      }
      if (typeof p.anthropicKey === 'string' && p.anthropicKey && p.anthropicKey !== '***') {
        const enc = encrypt(p.anthropicKey.trim(), config.secretKey);
        set('anthropic.key.enc', enc);
      }
      if (typeof p.bedrockRegion === 'string' && p.bedrockRegion) {
        set('bedrock.region', p.bedrockRegion.trim());
      }
      if (typeof p.bedrockAuth === 'string' && p.bedrockAuth) {
        if (!['ambient', 'profile', 'keys', 'bedrock-key', 'sso'].includes(p.bedrockAuth)) {
          throw badRequest('Unknown AWS auth method');
        }
        set('bedrock.auth', p.bedrockAuth);
      }
      if (typeof p.bedrockProfile === 'string') {
        set('bedrock.profile', p.bedrockProfile.trim());
      }
      if (typeof p.bedrockAccessKeyId === 'string' && p.bedrockAccessKeyId !== '***') {
        set('bedrock.access_key_id', p.bedrockAccessKeyId.trim());
      }
      if (typeof p.bedrockKey === 'string' && p.bedrockKey && p.bedrockKey !== '***') {
        const enc = encrypt(p.bedrockKey.trim(), config.secretKey);
        set('bedrock.secret_key.enc', enc);
      }
      // SSO config (non-secret; token sign-in happens via separate routes)
      if (typeof p.ssoStartUrl === 'string') {
        const url = p.ssoStartUrl.trim();
        if (url && !url.startsWith('https://')) {
          throw badRequest('ssoStartUrl must be a valid https URL');
        }
        set('bedrock.sso.startUrl', url);
      }
      if (typeof p.ssoRegion === 'string') {
        set('bedrock.sso.region', p.ssoRegion.trim());
      }
      if (typeof p.ssoAccountId === 'string') {
        set('bedrock.sso.accountId', p.ssoAccountId.trim());
      }
      if (typeof p.ssoRoleName === 'string') {
        set('bedrock.sso.roleName', p.ssoRoleName.trim());
      }
    }

    if (body.deployTarget !== undefined) {
      set('deploy.target', body.deployTarget ? String(body.deployTarget) : '');
    }

    if (body.trustProxy !== undefined) {
      set('trust.proxy', body.trustProxy ? 'true' : 'false');
    }

    if (body.cookieSecure !== undefined) {
      const v = String(body.cookieSecure);
      if (!['auto', 'true', 'false'].includes(v)) throw badRequest('cookieSecure must be auto, true or false');
      set('cookie.secure', v);
    }

    if (body.monthlyBudget !== undefined) {
      if (body.monthlyBudget === null) {
        set('budget.monthly_usd', '');
      } else {
        const v = Number(body.monthlyBudget);
        if (isNaN(v) || v < 0) throw badRequest('monthlyBudget must be a non-negative number');
        set('budget.monthly_usd', String(v));
      }
    }

    if (body.models) {
      const m = body.models as Record<string, unknown>;
      const MODEL_RE = /^[A-Za-z0-9._:\/@-]{0,200}$/;
      for (const alias of ['sonnet', 'haiku', 'opus'] as const) {
        if (typeof m[alias] === 'string') {
          if (m[alias] && !MODEL_RE.test(m[alias] as string)) {
            throw badRequest(`Model ID for ${alias} is not valid`);
          }
          set(`model.${alias}`, (m[alias] as string).trim());
        }
      }
    }

    if (typeof body.defaultModel === 'string') {
      const MODEL_RE = /^[A-Za-z0-9._:\/@-]{0,200}$/;
      if (body.defaultModel && !MODEL_RE.test(body.defaultModel)) {
        throw badRequest('defaultModel is not a valid model ID');
      }
      const PLACEHOLDER_IDS = ['kiro-default', 'demo-model'];
      if (PLACEHOLDER_IDS.includes(body.defaultModel.trim())) {
        throw badRequest(
          `"${body.defaultModel.trim()}" is a placeholder ID and cannot be set as the default model. ` +
            'Choose a real Claude model ID (e.g. from the model listing for your provider).',
        );
      }
      set('default.model', body.defaultModel.trim());
    }

    if (typeof body.headroomProxyUrl === 'string') {
      set('headroom.proxy_url', body.headroomProxyUrl.trim());
    }

    if (typeof body.githubOauthClientId === 'string') {
      set('github.oauth.clientId', body.githubOauthClientId.trim());
    }

    if (body.kiroApiKey !== undefined && typeof body.kiroApiKey === 'string' && body.kiroApiKey !== '***') {
      if (body.kiroApiKey.trim()) {
        const enc = encrypt(body.kiroApiKey.trim(), config.secretKey);
        set('kiro.key.enc', enc);
      }
    }

    // LiteLLM gateway settings
    if (body.litellm !== undefined && typeof body.litellm === 'object' && body.litellm !== null) {
      const ll = body.litellm as Record<string, unknown>;
      if (typeof ll.baseUrl === 'string') {
        set('litellm.baseUrl', ll.baseUrl.trim());
      }
      if (typeof ll.apiKey === 'string' && ll.apiKey && ll.apiKey !== '***') {
        const enc = encrypt(ll.apiKey.trim(), config.secretKey);
        set('litellm.key.enc', enc);
      }
      if (typeof ll.model === 'string' && ll.model) {
        set('litellm.model', JSON.stringify(ll.model.trim()));
      }
    }

    // Agent-run limits (FR-GUARD-8, FR-GUARD-10)
    if (body.agents !== undefined && typeof body.agents === 'object' && body.agents !== null) {
      const a = body.agents as Record<string, unknown>;
      if (a.approvalExpiryMinutes !== undefined) {
        const expiry = Number(a.approvalExpiryMinutes);
        if (!Number.isFinite(expiry) || expiry < 0 || expiry > 10080) throw badRequest('Minutes a question or approval waits must be from 0 (no limit) to 10080');
        set('agents.approvalExpiryMinutes', String(expiry));
      }
      if (a.maxBudgetUsdPerRun !== undefined) {
        if (a.maxBudgetUsdPerRun === null || a.maxBudgetUsdPerRun === '') {
          set('agents.maxBudgetUsdPerRun', '');
        } else {
          const v = Number(a.maxBudgetUsdPerRun);
          if (!Number.isFinite(v) || v < 0.01 || v > 1000) throw badRequest('Budget per run must be from $0.01 to $1000, or empty for no limit');
          set('agents.maxBudgetUsdPerRun', String(v));
        }
      }
      if (a.runTimeoutMinutes !== undefined) {
        if (a.runTimeoutMinutes === null || a.runTimeoutMinutes === '') {
          set('agents.runTimeoutMinutes', '');
        } else {
          const v = Number(a.runTimeoutMinutes);
          if (!Number.isFinite(v) || v < 0.01 || v > 1440) throw badRequest('Time limit per run must be from 0.01 to 1440 minutes, or empty for no limit');
          set('agents.runTimeoutMinutes', String(v));
        }
      }
      if (a.effort !== undefined) {
        const eff = String(a.effort ?? '');
        if (eff !== '' && !EFFORT_LEVELS.includes(eff as EffortLevel)) throw badRequest('Thinking effort must be low, medium, high, xhigh, max or empty for model default');
        set('agents.effort', eff);
      }
    }

    // Track who last changed settings (F8)
    set('settings.last_changed_at', now());
    set('settings.last_changed_by', req.user!.id);

    // Atomic write: all pairs in one transaction / one version bump
    const repo = getSettingsRepository();
    if (repo && pairs.length > 0) {
      await repo.setKeys(pairs);
      _updateSnapshotKeys(pairs);
    } else {
      // Fallback for pre-startup (shouldn't happen in production)
      for (const [key, value] of pairs) {
        db.prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run(key, value);
      }
    }

    sendJson(res, 200, publicSettings());
  }));

  // GET /api/settings/models — list models for a provider (admin only)
  router.get('/api/settings/models', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const qs = req.url ? new URL(req.url, 'http://localhost').searchParams : new URLSearchParams();
    const providerParam = qs.get('provider') ?? '';
    const refresh = qs.get('refresh') === '1';

    const validProviders = ['demo', 'anthropic', 'bedrock', 'kiro', 'litellm'];
    if (!validProviders.includes(providerParam)) {
      sendJson(res, 400, { error: `provider must be one of: ${validProviders.join(', ')}` });
      return;
    }

    const result = await listModelsForProvider(providerParam, undefined, refresh);
    sendJson(res, 200, result);
  }));

  // POST /api/settings/test — test provider connection
  router.post('/api/settings/test', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const body = req.body as Record<string, unknown>;
    const modeOverride = body.modeOverride ? String(body.modeOverride) : undefined;

    const result = await testConnection(modeOverride);
    sendJson(res, 200, result);
  }));

  // GET /api/admin/delegation — read delegation limits (admin write, everyone read)
  router.get('/api/admin/delegation', requireAuth(async (_req: PortalRequest, res: PortalResponse) => {
    const settings = await getDelegationSettingsRepository().get();
    sendJson(res, 200, settings);
  }));

  // PUT /api/admin/delegation — update delegation limits (admin only)
  router.put('/api/admin/delegation', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const body = req.body as Record<string, unknown>;
    const patch: Partial<DelegationSettings> = {};

    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);

    if (body.maxRunningPerParent !== undefined) {
      const v = Number(body.maxRunningPerParent);
      if (!Number.isFinite(v)) { sendJson(res, 400, { error: 'maxRunningPerParent must be a number' }); return; }
      patch.maxRunningPerParent = Math.max(0, Math.min(10, Math.round(v)));
    }

    if (body.maxRunningPerUser !== undefined) {
      const v = Number(body.maxRunningPerUser);
      if (!Number.isFinite(v)) { sendJson(res, 400, { error: 'maxRunningPerUser must be a number' }); return; }
      patch.maxRunningPerUser = Math.max(0, Math.min(20, Math.round(v)));
    }

    if (body.idleStopMinutes !== undefined) {
      const v = Number(body.idleStopMinutes);
      if (!Number.isFinite(v)) { sendJson(res, 400, { error: 'idleStopMinutes must be a number' }); return; }
      patch.idleStopMinutes = Math.max(1, Math.min(240, Math.round(v)));
    }

    if (body.allowNested !== undefined) patch.allowNested = Boolean(body.allowNested);

    if (body.nudgeThreshold !== undefined) {
      const v = Number(body.nudgeThreshold);
      if (!Number.isFinite(v)) { sendJson(res, 400, { error: 'nudgeThreshold must be a number' }); return; }
      patch.nudgeThreshold = Math.max(0, Math.min(20, Math.round(v)));
    }

    await getDelegationSettingsRepository().patch(patch);
    const updated = await getDelegationSettingsRepository().get();
    sendJson(res, 200, updated);
  }));
}
