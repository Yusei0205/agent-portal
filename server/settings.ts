/**
 * Settings module.
 *
 * Provides:
 *   getSetting / setSetting    — low-level key/value access
 *   getSettings                — typed Settings object
 *   getAgentEnv                — env vars for agent runs
 *   registerSettingsRoutes     — HTTP routes for settings CRUD + connection test
 */

import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, getDb } from './db.ts';
import type { DatabaseSync } from 'node:sqlite';
import { encrypt, decrypt } from './secrets.ts';
import { config } from './config.ts';
import { badRequest, HttpError } from './util.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderMode = 'demo' | 'anthropic' | 'bedrock' | 'kiro';
export type AwsAuth = 'ambient' | 'profile' | 'keys' | 'bedrock-key' | 'sso';

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
  };
  deployTarget: string | null;
  trustProxy: boolean;
  cookieSecure: string;
  monthlyBudget: number | null;
  models: { sonnet: string; haiku: string; opus: string };
  headroomProxyUrl: string;
  kiroApiKeySet: boolean;
  kiroApiKeyEnc: string;
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
  },
  deployTarget: null,
  trustProxy: false,
  cookieSecure: 'auto',
  monthlyBudget: null,
  models: { sonnet: '', haiku: '', opus: '' },
  headroomProxyUrl: '',
  kiroApiKeySet: false,
  kiroApiKeyEnc: '',
};

// ── Low-level key/value helpers ───────────────────────────────────────────────

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// ── Typed settings ────────────────────────────────────────────────────────────

export function getSettings(db?: DatabaseSync): Settings {
  const d = db ?? getDb();
  const out: Settings = JSON.parse(JSON.stringify(DEFAULTS));

  const providerMode = getSetting(d, 'provider.mode');
  if (providerMode) {
    out.provider.mode = providerMode as ProviderMode;
  }

  const anthropicKeyEnc = getSetting(d, 'anthropic.key.enc');
  if (anthropicKeyEnc) {
    out.provider.hasKey = true;
    out.provider.anthropicKeyEnc = anthropicKeyEnc;
  }

  const bedrockRegion = getSetting(d, 'bedrock.region');
  if (bedrockRegion) out.provider.bedrockRegion = bedrockRegion;

  const bedrockAuth = getSetting(d, 'bedrock.auth');
  if (bedrockAuth) out.provider.bedrockAuth = bedrockAuth as AwsAuth;

  const bedrockProfile = getSetting(d, 'bedrock.profile');
  if (bedrockProfile) out.provider.bedrockProfile = bedrockProfile;

  const bedrockAccessKeyId = getSetting(d, 'bedrock.access_key_id');
  if (bedrockAccessKeyId) out.provider.bedrockAccessKeyId = bedrockAccessKeyId;

  const bedrockKeyEnc = getSetting(d, 'bedrock.secret_key.enc');
  if (bedrockKeyEnc) out.provider.bedrockKeyEnc = bedrockKeyEnc;

  const deployTarget = getSetting(d, 'deploy.target');
  if (deployTarget) out.deployTarget = deployTarget;

  const trustProxy = getSetting(d, 'trust.proxy');
  if (trustProxy) out.trustProxy = trustProxy === 'true';

  const cookieSecure = getSetting(d, 'cookie.secure');
  if (cookieSecure) out.cookieSecure = cookieSecure;

  const monthlyBudget = getSetting(d, 'budget.monthly_usd');
  if (monthlyBudget !== null) {
    const v = parseFloat(monthlyBudget);
    out.monthlyBudget = isNaN(v) ? null : v;
  }

  const modelSonnet = getSetting(d, 'model.sonnet');
  if (modelSonnet) out.models.sonnet = modelSonnet;

  const modelHaiku = getSetting(d, 'model.haiku');
  if (modelHaiku) out.models.haiku = modelHaiku;

  const modelOpus = getSetting(d, 'model.opus');
  if (modelOpus) out.models.opus = modelOpus;

  const headroomProxyUrl = getSetting(d, 'headroom.proxy_url');
  if (headroomProxyUrl) out.headroomProxyUrl = headroomProxyUrl;

  const kiroKeyEnc = getSetting(d, 'kiro.key.enc');
  if (kiroKeyEnc) {
    out.kiroApiKeySet = true;
    out.kiroApiKeyEnc = kiroKeyEnc;
  }

  return out;
}

// ── Public (safe) settings view ───────────────────────────────────────────────

function publicSettings(db?: DatabaseSync): object {
  const s = getSettings(db);
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
    },
    deployTarget: s.deployTarget,
    trustProxy: s.trustProxy,
    cookieSecure: s.cookieSecure,
    monthlyBudget: s.monthlyBudget,
    models: s.models,
    headroomProxyUrl: s.headroomProxyUrl,
    kiroApiKeySet: s.kiroApiKeySet,
  };
}

// ── Agent environment ─────────────────────────────────────────────────────────

/**
 * Returns the environment variables to inject into agent runs.
 * Decrypts stored secrets using the portal's secret key.
 */
export function getAgentEnv(db?: DatabaseSync, _projectId?: string): Record<string, string> {
  const d = db ?? getDb();
  const s = getSettings(d);
  const env: Record<string, string> = {};

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
    return { ok: true, models: ['kiro-default'] };
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
      if (s.provider.bedrockAuth === 'profile' && s.provider.bedrockProfile) {
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
          // Bedrock API keys use a bearer token — set via env for the SDK
          process.env.AWS_BEARER_TOKEN_BEDROCK = bedrockKey;
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
      return { ok: false, error: `Bedrock connection failed: ${String((e as Error)?.message ?? e)}` };
    }
  }

  return { ok: false, error: `Unknown provider mode: ${mode}` };
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

    if (body.provider) {
      const p = body.provider as Record<string, unknown>;
      if (p.mode !== undefined) {
        const mode = String(p.mode);
        if (!['demo', 'anthropic', 'bedrock', 'kiro'].includes(mode)) {
          throw badRequest('Unknown provider mode');
        }
        setSetting(db, 'provider.mode', mode);
      }
      if (typeof p.anthropicKey === 'string' && p.anthropicKey && p.anthropicKey !== '***') {
        const enc = encrypt(p.anthropicKey.trim(), config.secretKey);
        setSetting(db, 'anthropic.key.enc', enc);
      }
      if (typeof p.bedrockRegion === 'string' && p.bedrockRegion) {
        setSetting(db, 'bedrock.region', p.bedrockRegion.trim());
      }
      if (typeof p.bedrockAuth === 'string' && p.bedrockAuth) {
        if (!['ambient', 'profile', 'keys', 'bedrock-key', 'sso'].includes(p.bedrockAuth)) {
          throw badRequest('Unknown AWS auth method');
        }
        setSetting(db, 'bedrock.auth', p.bedrockAuth);
      }
      if (typeof p.bedrockProfile === 'string') {
        setSetting(db, 'bedrock.profile', p.bedrockProfile.trim());
      }
      if (typeof p.bedrockAccessKeyId === 'string' && p.bedrockAccessKeyId !== '***') {
        setSetting(db, 'bedrock.access_key_id', p.bedrockAccessKeyId.trim());
      }
      if (typeof p.bedrockKey === 'string' && p.bedrockKey && p.bedrockKey !== '***') {
        const enc = encrypt(p.bedrockKey.trim(), config.secretKey);
        setSetting(db, 'bedrock.secret_key.enc', enc);
      }
    }

    if (body.deployTarget !== undefined) {
      setSetting(db, 'deploy.target', body.deployTarget ? String(body.deployTarget) : '');
    }

    if (body.trustProxy !== undefined) {
      setSetting(db, 'trust.proxy', body.trustProxy ? 'true' : 'false');
    }

    if (body.cookieSecure !== undefined) {
      const v = String(body.cookieSecure);
      if (!['auto', 'true', 'false'].includes(v)) throw badRequest('cookieSecure must be auto, true or false');
      setSetting(db, 'cookie.secure', v);
    }

    if (body.monthlyBudget !== undefined) {
      if (body.monthlyBudget === null) {
        setSetting(db, 'budget.monthly_usd', '');
      } else {
        const v = Number(body.monthlyBudget);
        if (isNaN(v) || v < 0) throw badRequest('monthlyBudget must be a non-negative number');
        setSetting(db, 'budget.monthly_usd', String(v));
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
          setSetting(db, `model.${alias}`, (m[alias] as string).trim());
        }
      }
    }

    if (typeof body.headroomProxyUrl === 'string') {
      setSetting(db, 'headroom.proxy_url', body.headroomProxyUrl.trim());
    }

    if (body.kiroApiKey !== undefined && typeof body.kiroApiKey === 'string' && body.kiroApiKey !== '***') {
      if (body.kiroApiKey.trim()) {
        const enc = encrypt(body.kiroApiKey.trim(), config.secretKey);
        setSetting(db, 'kiro.key.enc', enc);
      }
    }

    sendJson(res, 200, publicSettings(db));
  }));

  // POST /api/settings/test — test provider connection
  router.post('/api/settings/test', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!requireAdmin(req, res)) return;

    const body = req.body as Record<string, unknown>;
    const modeOverride = body.modeOverride ? String(body.modeOverride) : undefined;

    const result = await testConnection(modeOverride);
    sendJson(res, 200, result);
  }));
}
