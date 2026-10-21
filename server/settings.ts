import path from 'node:path';
import { one, run, all } from './db.ts';
import { get, put, post, del } from './http.ts';
import { config, dataPath } from './config.ts';
import { deleteSecret, getSecret, secretInfo, setSecret } from './secrets.ts';
import { badRequest, monthStart } from './util.ts';
import { ssoCredentials, ssoStatus } from './sso.ts';
import { clearModelListCache } from './model-cache.ts';

export type ProviderMode = 'demo' | 'anthropic' | 'bedrock' | 'kiro';
export type AwsAuth = 'ambient' | 'profile' | 'keys' | 'bedrock-key' | 'sso';

export interface Settings {
  provider: {
    mode: ProviderMode;
    /** Optional exact model IDs behind the sonnet / haiku / opus aliases (needed on Bedrock for newer models). */
    models: { sonnet: string; haiku: string; opus: string };
  };
  /** Kiro CLI provider: runs go through `kiro-cli acp` with the server's Kiro sign-in (or a Kiro API key). */
  kiro: {
    /** Full path to kiro-cli; blank finds it on PATH. */
    command: string;
    /** Kiro model IDs behind the aliases; blank picks Kiro's newest model of that family. */
    models: { sonnet: string; haiku: string; opus: string };
  };
  aws: {
    region: string;
    auth: AwsAuth;
    profile: string;
    /** AWS IAM Identity Center (SSO) settings — non-secret */
    ssoStartUrl?: string;
    ssoRegion?: string;
    ssoAccountId?: string;
    ssoRoleName?: string;
  };
  budget: { monthlyUsd: number | null };
  secrets: { mode: 'local' | 'aws-ssm'; prefix: string; region: string };
  agents: { defaultPermissionMode: 'default' | 'acceptEdits' | 'plan'; maxTurns: number; resumeAfterRestart: boolean };
  /** Sessions handing tasks to separate sessions: limits for everyone. */
  delegation: { enabled: boolean; maxPerParent: number; maxPerUser: number; allowNested: boolean; nudgeThreshold: number };
}

const DEFAULTS: Settings = {
  provider: { mode: 'demo', models: { sonnet: '', haiku: '', opus: '' } },
  kiro: { command: '', models: { sonnet: '', haiku: '', opus: '' } },
  aws: { region: 'us-east-1', auth: 'ambient', profile: '' },
  budget: { monthlyUsd: 50 },
  secrets: { mode: 'local', prefix: '/agent-portal/', region: '' },
  agents: { defaultPermissionMode: 'default', maxTurns: 40, resumeAfterRestart: true },
  delegation: { enabled: true, maxPerParent: 3, maxPerUser: 6, allowNested: false, nudgeThreshold: 4 },
};

export const SECRET_NAMES = {
  anthropicKey: 'anthropic.api_key',
  awsAccessKeyId: 'aws.access_key_id',
  awsSecretAccessKey: 'aws.secret_access_key',
  awsSessionToken: 'aws.session_token',
  bedrockApiKey: 'aws.bedrock_api_key',
  githubToken: 'github.token',
  kiroApiKey: 'kiro.api_key',
} as const;

const ALLOWED_SECRETS = new Set<string>(Object.values(SECRET_NAMES));

export function getSettings(): Settings {
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const out: any = structuredClone(DEFAULTS);
  for (const r of rows) {
    if (!(r.key in out)) continue;
    try {
      const v = JSON.parse(r.value);
      out[r.key] = typeof v === 'object' && v && !Array.isArray(v) ? { ...out[r.key], ...v } : v;
    } catch {
      /* ignore corrupt row */
    }
  }
  out.provider.models = { ...DEFAULTS.provider.models, ...(out.provider.models || {}) };
  out.kiro.models = { ...DEFAULTS.kiro.models, ...(out.kiro.models || {}) };
  return out as Settings;
}

function saveSection(key: keyof Settings, value: unknown): void {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

export function providerMode(): ProviderMode {
  return getSettings().provider.mode;
}

const MODEL_RE = /^[A-Za-z0-9._:\/@-]{0,200}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function updateSettings(patch: any): Settings {
  const cur = getSettings();
  if (patch.provider) {
    const mode = patch.provider.mode ?? cur.provider.mode;
    if (!['demo', 'anthropic', 'bedrock', 'kiro'].includes(mode)) throw badRequest('Unknown provider');
    const models = { ...cur.provider.models, ...(patch.provider.models || {}) };
    for (const [k, v] of Object.entries(models)) {
      if (typeof v !== 'string' || !MODEL_RE.test(v)) throw badRequest(`Model ID for ${k} is not valid`);
    }
    saveSection('provider', { mode, models });
    clearModelListCache();
  }
  if (patch.kiro) {
    const command = typeof patch.kiro.command === 'string' ? patch.kiro.command.trim() : cur.kiro.command;
    // Only a kiro-cli executable may be configured: this path is started by the server.
    if (command && (command.length > 500 || /[\0\r\n"'`$;&|<>]/.test(command) || !/^kiro-cli(\.exe)?$/i.test(path.basename(command)))) {
      throw badRequest('Kiro CLI path must point to the kiro-cli program (for example C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe)');
    }
    const models = { ...cur.kiro.models, ...(patch.kiro.models || {}) };
    for (const [k, v] of Object.entries(models)) {
      if (typeof v !== 'string' || !MODEL_RE.test(v)) throw badRequest(`Kiro model ID for ${k} is not valid`);
    }
    saveSection('kiro', { command, models });
    clearModelListCache();
  }
  if (patch.aws) {
    const aws = { ...cur.aws, ...patch.aws };
    if (!REGION_RE.test(aws.region)) throw badRequest('AWS region looks wrong (for example ap-southeast-1)');
    if (!['ambient', 'profile', 'keys', 'bedrock-key', 'sso'].includes(aws.auth)) throw badRequest('Unknown AWS sign-in method');
    if (aws.profile && !/^[A-Za-z0-9_.-]{1,64}$/.test(aws.profile)) throw badRequest('AWS profile name is not valid');
    if (aws.ssoStartUrl !== undefined && aws.ssoStartUrl !== '') {
      if (!/^https:\/\/.+/.test(aws.ssoStartUrl)) throw badRequest('SSO start URL must begin with https://');
    }
    if (aws.ssoRegion !== undefined && aws.ssoRegion !== '') {
      if (!REGION_RE.test(aws.ssoRegion)) throw badRequest('SSO region looks wrong (for example us-east-1)');
    }
    saveSection('aws', aws);
    clearModelListCache();
  }
  if (patch.budget) {
    const v = patch.budget.monthlyUsd;
    if (v !== null && (typeof v !== 'number' || v < 0 || v > 1_000_000)) throw badRequest('Budget must be a number of dollars, or empty for no cap');
    saveSection('budget', { monthlyUsd: v });
  }
  if (patch.secrets) {
    const s = { ...cur.secrets, ...patch.secrets };
    if (!['local', 'aws-ssm'].includes(s.mode)) throw badRequest('Unknown secrets storage');
    if (!/^\/[A-Za-z0-9_.\/-]{0,100}\/$/.test(s.prefix)) throw badRequest('SSM prefix must start and end with /');
    if (s.region && !REGION_RE.test(s.region)) throw badRequest('SSM region looks wrong');
    saveSection('secrets', s);
  }
  if (patch.agents) {
    const a = { ...cur.agents, ...patch.agents };
    if (!['default', 'acceptEdits', 'plan'].includes(a.defaultPermissionMode)) throw badRequest('Unknown permission mode');
    a.maxTurns = Math.max(1, Math.min(500, Number(a.maxTurns) || 40));
    a.resumeAfterRestart = a.resumeAfterRestart !== false;
    saveSection('agents', a);
  }
  if (patch.delegation) {
    const d = { ...cur.delegation, ...patch.delegation };
    const n = (v: unknown, lo: number, hi: number, name: string) => {
      const x = Number(v);
      if (!Number.isInteger(x) || x < lo || x > hi) throw badRequest(`${name} must be a whole number from ${lo} to ${hi}`);
      return x;
    };
    saveSection('delegation', {
      enabled: d.enabled !== false,
      maxPerParent: n(d.maxPerParent, 0, 10, 'Running per session'),
      maxPerUser: n(d.maxPerUser, 0, 20, 'Running per person'),
      allowNested: d.allowNested === true,
      nudgeThreshold: n(d.nudgeThreshold, 0, 20, 'Subagent advice threshold'),
    });
  }
  return getSettings();
}

/** Environment variables that must never reach an agent process. */
const STRIP = [/^PORTAL_/, /^ADMIN_/, /^ANTHROPIC_/, /^CLAUDE_CODE_USE_/, /^AWS_/, /^GH_TOKEN$/, /^GITHUB_TOKEN$/];

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (STRIP.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  return env;
}

/** AWS variables for the configured sign-in method (Bedrock, CodeCommit, AWS CLI). */
export async function awsEnv(): Promise<Record<string, string>> {
  const s = getSettings().aws;
  const env: Record<string, string> = { AWS_REGION: s.region, AWS_DEFAULT_REGION: s.region };
  if (s.auth === 'ambient') {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
  } else if (s.auth === 'profile') {
    if (!s.profile) throw badRequest('Set an AWS profile name in Settings');
    env.AWS_PROFILE = s.profile;
    for (const k of ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']) if (process.env[k]) env[k] = process.env[k]!;
  } else if (s.auth === 'keys') {
    const id = await getSecret(SECRET_NAMES.awsAccessKeyId);
    const secret = await getSecret(SECRET_NAMES.awsSecretAccessKey);
    if (!id || !secret) throw badRequest('Add an AWS access key ID and secret access key in Settings');
    env.AWS_ACCESS_KEY_ID = id;
    env.AWS_SECRET_ACCESS_KEY = secret;
    const token = await getSecret(SECRET_NAMES.awsSessionToken);
    if (token) env.AWS_SESSION_TOKEN = token;
  } else if (s.auth === 'sso') {
    const ssoCreds = await ssoCredentials();
    Object.assign(env, ssoCreds);
    // Use SSO region for SDK calls if specified
    if (s.ssoRegion) {
      env.AWS_REGION = s.region; // keep the Bedrock region; SSO region is internal
      env.AWS_DEFAULT_REGION = s.region;
    }
  }
  return env;
}

/** Full environment for a Claude Agent SDK run. With a project, its own connection (provider, AWS account) applies. */
export async function agentEnv(projectId?: string, modeOverride?: ProviderMode): Promise<Record<string, string>> {
  const s = getSettings();
  const env = baseEnv();
  env.CLAUDE_CONFIG_DIR = dataPath('claude-home');
  const pa = projectId ? await import('./project-aws.ts') : null;
  // A run that picked its engine says which provider to set up; otherwise the project's connection decides.
  const mode = modeOverride ?? (pa ? pa.effectiveProvider(projectId) : s.provider.mode);
  if (mode === 'anthropic') {
    const key = await getSecret(SECRET_NAMES.anthropicKey);
    if (!key) throw badRequest('Add your Anthropic API key in Settings first');
    env.ANTHROPIC_API_KEY = key;
  } else if (mode === 'bedrock') {
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    if (pa && pa.projectModelUsesOwnAws(projectId)) {
      // One AWS connection for the whole project: Bedrock uses the project's own account.
      Object.assign(env, await pa.projectAwsEnv(projectId!));
    } else if (s.aws.auth === 'bedrock-key') {
      const key = await getSecret(SECRET_NAMES.bedrockApiKey);
      if (!key) throw badRequest('Add your Amazon Bedrock API key in Settings first');
      env.AWS_BEARER_TOKEN_BEDROCK = key;
      env.AWS_REGION = s.aws.region;
    } else {
      Object.assign(env, await awsEnv());
    }
  } else if (mode === 'kiro') {
    // kiro-cli uses the server user's own Kiro sign-in (HOME / APPDATA are kept). A stored API key wins.
    const key = await getSecret(SECRET_NAMES.kiroApiKey);
    if (key) env.KIRO_API_KEY = key;
  }
  // A project with its own AWS account: the agent's AWS commands go there. The model keeps the Settings credentials
  // unless the project chose Bedrock on its own account (then both already use it).
  if (pa && projectId) {
    const { env: extra, pathPrefix } = await pa.projectRunEnv(projectId, mode === 'bedrock');
    Object.assign(env, extra);
    if (pathPrefix) {
      const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      env[key] = pathPrefix + path.delimiter + (env[key] ?? '');
    }
  }
  const m = s.provider.models;
  if (m.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet;
  if (m.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku;
  if (m.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus;
  return env;
}

export async function githubToken(): Promise<string | null> {
  return getSecret(SECRET_NAMES.githubToken);
}

export function monthSpend(projectId?: string): number {
  const since = monthStart();
  const r = projectId
    ? one<{ s: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE created_at >= ? AND project_id = ?', since, projectId)
    : one<{ s: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE created_at >= ?', since);
  return r?.s ?? 0;
}

/** Refuse new runs once the monthly dollar cap is used. Demo and Kiro CLI runs cost no dollars, so they are not capped. */
export function assertBudget(mode: ProviderMode = getSettings().provider.mode): void {
  const s = getSettings();
  if (mode === 'demo' || mode === 'kiro') return;
  const cap = s.budget.monthlyUsd;
  if (cap !== null && cap !== undefined && monthSpend() >= cap) {
    throw badRequest(`This month's budget of $${cap} is used up. An admin can raise it in Settings.`);
  }
}

function publicSettings() {
  const s = getSettings();
  return {
    ...s,
    secretsInfo: Object.fromEntries(Object.values(SECRET_NAMES).map((n) => [n, secretInfo(n)])),
    usage: { monthUsd: monthSpend() },
    dataDir: config.dataDir,
    ssoStatus: ssoStatus(),
  };
}

export function registerSettingsRoutes(): void {
  get('/api/settings', (ctx) => {
    if (ctx.user!.is_admin) return publicSettings();
    const s = getSettings();
    return { provider: { mode: s.provider.mode }, budget: s.budget, usage: { monthUsd: monthSpend() } };
  });

  put('/api/settings', async (ctx) => {
    updateSettings(await ctx.json());
    return publicSettings();
  }, { auth: 'admin' });

  post('/api/settings/secrets/:name', async (ctx) => {
    const name = ctx.params.name;
    if (!ALLOWED_SECRETS.has(name)) throw badRequest('Unknown secret');
    const body = await ctx.json();
    const value = typeof body.value === 'string' ? body.value.trim() : '';
    if (!value || value.length > 4000) throw badRequest('Enter a value');
    await setSecret(name, value);
    return secretInfo(name);
  }, { auth: 'admin' });

  del('/api/settings/secrets/:name', (ctx) => {
    if (!ALLOWED_SECRETS.has(ctx.params.name)) throw badRequest('Unknown secret');
    deleteSecret(ctx.params.name);
    return { set: false };
  }, { auth: 'admin' });

  get('/api/usage', () => {
    const since = monthStart();
    return {
      since,
      totalUsd: monthSpend(),
      byProject: all(
        `SELECT p.id, p.name, COALESCE(SUM(r.cost_usd), 0) AS usd, COUNT(r.id) AS runs
           FROM projects p LEFT JOIN runs r ON r.project_id = p.id AND r.created_at >= ?
          GROUP BY p.id ORDER BY usd DESC`,
        since,
      ),
      byKind: all('SELECT kind, COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS runs FROM runs WHERE created_at >= ? GROUP BY kind', since),
    };
  }, { auth: 'admin' });
}
