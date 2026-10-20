/**
 * List the Claude models the configured provider offers, for the Settings dropdowns.
 *
 * Endpoint: GET /api/settings/models   (admin)
 *  - anthropic: GET https://api.anthropic.com/v1/models with the stored API key
 *  - bedrock:   ListInferenceProfiles + ListFoundationModels (Anthropic only) with the configured AWS sign-in
 *  - demo:      empty list
 *
 * Endpoint: GET /api/models  (any signed-in user)
 *  - Same list, but errors are non-fatal (people can still type an ID).
 *  - Only successful lists are cached (5 min). Errors are never cached so a
 *    re-sign-in or settings change immediately allows a successful fetch.
 *  - ?refresh=1 bypasses the cache unconditionally.
 *  - clearModelListCache() is re-exported from model-cache.ts so that settings.ts
 *    and sso.ts can call it without creating a circular import.
 */

import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { get } from './http.ts';
import { agentEnv, awsEnv, getSettings, SECRET_NAMES } from './settings.ts';
import { dataPath } from './config.ts';
import { getSecret } from './secrets.ts';
import { badRequest, HttpError } from './util.ts';
import { clearModelListCache, modelListCacheRef } from './model-cache.ts';
import { effectiveProvider, projectAwsEnv, projectModelUsesOwnAws } from './project-aws.ts';
import { requireProject } from './projects.ts';

export interface ModelOption {
  id: string;
  name: string;
  family: 'haiku' | 'sonnet' | 'opus' | 'other';
}

// Re-export so callers that import from models.ts still get the function.
export { clearModelListCache };

function familyOf(s: string): ModelOption['family'] {
  const t = s.toLowerCase();
  if (t.includes('haiku')) return 'haiku';
  if (t.includes('sonnet')) return 'sonnet';
  if (t.includes('opus')) return 'opus';
  return 'other';
}

async function anthropicModels(): Promise<ModelOption[]> {
  const key = await getSecret(SECRET_NAMES.anthropicKey);
  if (!key) throw badRequest('Add your Anthropic API key first');
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new HttpError(502, `Anthropic returned ${res.status} when listing models`);
  const body: any = await res.json();
  return (body.data ?? []).map((m: any) => ({
    id: m.id,
    name: m.display_name ?? m.id,
    family: familyOf(m.id),
  }));
}

// ---- Bedrock client factory seam (overrideable in tests) ----------------

type BedrockFactory = (region: string, credentials: any) => BedrockClient;

let _bedrockFactory: BedrockFactory = (region, credentials) =>
  new BedrockClient({ region, credentials });

/** Override the Bedrock client factory (test seam). */
export function setBedrockClientFactory(f: BedrockFactory): void {
  _bedrockFactory = f;
}

// ---- Friendly error mapping for bedrockModels() -------------------------

/**
 * Map AWS error codes / messages to a short, actionable user-facing message.
 * Returns empty string if no known pattern matches (caller uses the raw message).
 */
function friendlyBedrockError(e: any, auth: string): string {
  const code: string = e?.name ?? e?.code ?? e?.Code ?? '';
  const msg: string = String(e?.message ?? e ?? '').toLowerCase();

  // Expired / invalid session token
  if (
    code === 'ExpiredTokenException' ||
    code === 'ExpiredToken' ||
    msg.includes('security token') ||
    msg.includes('token is expired') ||
    msg.includes('token has expired') ||
    msg.includes('sso session expired')
  ) {
    return 'Your AWS session has expired. Sign in again in Settings › AWS sign-in, then press Reload list.';
  }

  // Access denied / insufficient permissions
  if (
    code === 'AccessDeniedException' ||
    code === 'AccessDenied' ||
    msg.includes('access denied') ||
    msg.includes('not authorized') ||
    msg.includes('is not authorized')
  ) {
    return (
      'Access denied — the IAM role needs bedrock:ListInferenceProfiles and bedrock:ListFoundationModels. ' +
      'You can still type a model ID directly.'
    );
  }

  // SSO not configured: no account/role selected yet
  if (
    auth === 'sso' &&
    (msg.includes('select an aws account') || msg.includes('account and role'))
  ) {
    return 'Select an AWS account and role in Settings › AWS sign-in first, then press Reload list.';
  }

  return '';
}

async function bedrockModels(projectId?: string): Promise<ModelOption[]> {
  const s = getSettings().aws;
  const own = projectId && projectModelUsesOwnAws(projectId);
  const env = own ? await projectAwsEnv(projectId) : await awsEnv();
  const region = own ? env.AWS_REGION || s.region : s.region;
  let credentials: any;
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    credentials = {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    };
  } else if (env.AWS_PROFILE) {
    // ignoreCache: the SDK otherwise keeps the parsed ~/.aws files for the life of the process,
    // so keys refreshed on disk would never be seen by this long-running server.
    credentials = fromIni({ profile: env.AWS_PROFILE, ignoreCache: true });
  } else if (!own && s.auth === 'bedrock-key') {
    throw badRequest(
      'Listing models is not supported with a Bedrock API key. Type the model ID instead.',
    );
  } else {
    credentials = fromNodeProviderChain({ ignoreCache: true });
  }

  const client = _bedrockFactory(region, credentials);
  const out = new Map<string, ModelOption>();
  try {
    // Inference profiles first: newer models are only callable through them.
    let token: string | undefined;
    do {
      const r = await client.send(
        new ListInferenceProfilesCommand({ maxResults: 100, nextToken: token }),
      );
      for (const p of r.inferenceProfileSummaries ?? []) {
        if (p.inferenceProfileId?.includes('anthropic.claude')) {
          out.set(p.inferenceProfileId, {
            id: p.inferenceProfileId,
            name: p.inferenceProfileName ?? p.inferenceProfileId,
            family: familyOf(p.inferenceProfileId),
          });
        }
      }
      token = r.nextToken;
    } while (token);
    const r = await client.send(new ListFoundationModelsCommand({ byProvider: 'Anthropic' }));
    for (const m of r.modelSummaries ?? []) {
      if (m.modelId && !out.has(m.modelId)) {
        out.set(m.modelId, {
          id: m.modelId,
          name: m.modelName ?? m.modelId,
          family: familyOf(m.modelId),
        });
      }
    }
  } catch (e: any) {
    const friendly = friendlyBedrockError(e, s.auth);
    const detail = String(e?.message ?? e).slice(0, 200);
    throw new HttpError(502, friendly || `Could not list Bedrock models: ${detail}`);
  }
  return [...out.values()];
}

/** Models offered by the Kiro account the server's kiro-cli is signed in with. */
async function kiroProviderModels(projectId?: string): Promise<ModelOption[]> {
  const { kiroModels } = await import('./agent/kiro.ts');
  const list = await kiroModels(await agentEnv(projectId), dataPath('kiro-models'));
  return list.map((m) => ({ id: m.modelId, name: m.description ? `${m.name ?? m.modelId} — ${m.description}` : (m.name ?? m.modelId), family: familyOf(m.modelId) }));
}

function providerModels(mode: string, projectId?: string): Promise<ModelOption[]> {
  if (mode === 'anthropic') return anthropicModels();
  if (mode === 'kiro') return kiroProviderModels(projectId);
  return bedrockModels(projectId);
}

/** The three tiers the portal maps to model IDs in Settings, and the shape of a model ID that is passed through as is. */
const TIERS = ['haiku', 'sonnet', 'opus'];
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{2,199}$/;

/** A model choice from a request: a tier name or a full model ID. Anything else falls back. */
export function cleanModel(raw: unknown, fallback = 'sonnet'): string {
  const m = typeof raw === 'string' ? raw.trim() : '';
  return TIERS.includes(m) || MODEL_ID_RE.test(m) ? m : fallback;
}

/** Like cleanModel, but a bad value is an error instead of a quiet fallback. */
export function requireModel(raw: unknown): string {
  const m = typeof raw === 'string' ? raw.trim() : '';
  if (!TIERS.includes(m) && !MODEL_ID_RE.test(m))
    throw badRequest(
      'That is not a model ID. Pick one from the list or paste the full ID.',
    );
  return m;
}

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export function registerModelRoutes(): void {
  // The same list as Settings, for the model picker everywhere else. A failure is not an error
  // here: people can still type an ID. ?projectId= lists what that project's connection offers.
  get('/api/models', async (ctx) => {
    const pid = ctx.query.get('projectId') || '';
    if (pid) requireProject(ctx, pid);
    const mode = effectiveProvider(pid || null);
    if (mode === 'demo') return { mode, models: [], error: '' };
    // Projects that bring their own Bedrock account see their own list.
    const key = pid && mode === 'bedrock' && projectModelUsesOwnAws(pid) ? `${mode}:${pid}` : mode;

    const forceRefresh = ctx.query.get('refresh') === '1';
    const cache = modelListCacheRef.value as { at: number; mode: string; key?: string; models: ModelOption[] } | null;

    // Serve from cache if fresh and not bypassed
    if (
      !forceRefresh &&
      cache &&
      cache.mode === mode &&
      (cache.key ?? cache.mode) === key &&
      Date.now() - cache.at < CACHE_TTL_MS
    ) {
      return { mode, models: cache.models, error: '' };
    }

    let models: ModelOption[] = [];
    let error = '';
    try {
      models = await providerModels(mode, pid || undefined);
      models.sort((a, b) => a.id.localeCompare(b.id));
      // Only cache successes — errors are never stored
      modelListCacheRef.value = { at: Date.now(), mode, key, models };
    } catch (e: any) {
      // Do not cache errors — next call will try again immediately
      error = String(e?.message ?? e).slice(0, 400);
    }
    return { mode, models, error };
  });

  get(
    '/api/settings/models',
    async () => {
      const mode = getSettings().provider.mode;
      if (mode === 'demo') return { mode, models: [] };
      const models =
        await providerModels(mode);
      models.sort((a, b) => a.id.localeCompare(b.id));
      return { mode, models };
    },
    { auth: 'admin' },
  );
}
