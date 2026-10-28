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
  agents: {
    defaultPermissionMode: 'default' | 'acceptEdits' | 'plan';
    maxTurns: number;
    resumeAfterRestart: boolean;
    defaultPushMode: 'never' | 'ask' | 'auto';
    /** Off by default: agents may read only inside their own project folder. */
    allowReadsOutsideProject: boolean;
    /** Minutes one MCP tool call (an integration) may take before Claude Code gives up on it. Unbounded by default in Claude Code. */
    mcpToolTimeoutMinutes: number;
  };
  /** Extra Claude models for the model picker, one per line as "model id | label"; added without a deploy. */
  modelList: { extra: string };
  /** Sessions handing tasks to separate sessions: limits for everyone. */
  delegation: { enabled: boolean; maxPerParent: number; maxPerUser: number; allowNested: boolean; nudgeThreshold: number };
  /**
   * Interface switches. `advanced` shows the parked multi-user features (teams, SCIM, Google sign-in setup) in the
   * Admin panel. It only changes what the UI offers: the routes and the code behind them stay on.
   */
  ui: { advanced: boolean };
  /** Session control plane: concurrency caps, drain, SLA, TTL. */
  controlPlane: {
    /** Max top-level running sessions globally (0 = no cap). */
    globalMax: number;
    /** Max top-level running sessions per user (0 = no cap). Default 5. */
    perUserMax: number;
    /** Max top-level running sessions per project (0 = no cap). */
    perProjectMax: number;
    /** Minutes before an unanswered approval is flagged as overdue. Default 30. */
    approvalSlaMinutes: number;
    /** Days to keep work/<runId>/ folders for finished sessions. Default 30. */
    worktreeTtlDays: number;
    /** Seconds to wait for running iterations to finish on SIGTERM. Default 60. */
    drainTimeoutSeconds: number;
  };
}

const DEFAULTS: Settings = {
  provider: { mode: 'demo', models: { sonnet: '', haiku: '', opus: '' } },
  kiro: { command: '', models: { sonnet: '', haiku: '', opus: '' } },
  aws: { region: 'us-east-1', auth: 'ambient', profile: '' },
  budget: { monthlyUsd: 50 },
  secrets: { mode: 'local', prefix: '/agent-portal/', region: '' },
  agents: { defaultPermissionMode: 'default', maxTurns: 40, resumeAfterRestart: true, defaultPushMode: 'ask', allowReadsOutsideProject: false, mcpToolTimeoutMinutes: 10 },
  delegation: { enabled: true, maxPerParent: 3, maxPerUser: 6, allowNested: false, nudgeThreshold: 4 },
  modelList: { extra: '' },
  ui: { advanced: false },
  controlPlane: {
    globalMax: 0,
    perUserMax: 5,
    perProjectMax: 0,
    approvalSlaMinutes: 30,
    worktreeTtlDays: 30,
    drainTimeoutSeconds: 60,
  },
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

/** Lines of "model id | label" (label optional); an invalid id is refused with its line number. */
export function parseExtraModels(text: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [idPart, ...rest] = line.split('|');
    const id = idPart.trim();
    if (!id || !MODEL_RE.test(id)) throw badRequest(`Line ${i + 1}: "${id}" is not a model ID`);
    if (!out.some((o) => o.id === id)) out.push({ id, label: rest.join('|').trim().slice(0, 80) || id });
  });
  return out;
}

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
    if (!['never', 'ask', 'auto'].includes(a.defaultPushMode)) throw badRequest('Agent pushes must be never, ask or auto');
    a.allowReadsOutsideProject = Boolean(a.allowReadsOutsideProject);
    const mcpMinutes = Number(a.mcpToolTimeoutMinutes);
    if (!Number.isInteger(mcpMinutes) || mcpMinutes < 1 || mcpMinutes > 240) throw badRequest('Time limit for one integration tool call must be a whole number of minutes from 1 to 240');
    a.mcpToolTimeoutMinutes = mcpMinutes;
    saveSection('agents', a);
  }
  if (patch.modelList) {
    const text = String(patch.modelList.extra ?? '');
    const lines = parseExtraModels(text);
    if (lines.length > 50) throw badRequest('List at most 50 extra models');
    saveSection('modelList', { extra: lines.map((l) => (l.label !== l.id ? `${l.id} | ${l.label}` : l.id)).join('\n') });
    clearModelListCache();
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
  if (patch.ui) {
    saveSection('ui', { advanced: patch.ui.advanced === true });
  }
  if (patch.controlPlane) {
    const cp = { ...cur.controlPlane, ...patch.controlPlane };
    const n = (v: unknown, lo: number, hi: number, name: string) => {
      const x = Number(v);
      if (!Number.isInteger(x) || x < lo || x > hi) throw badRequest(`${name} must be a whole number from ${lo} to ${hi}`);
      return x;
    };
    // PORTAL_DRAIN_MAX_SECONDS is set by compose.yml to (stop_grace_period - a safety buffer).
    // It clamps drainTimeoutSeconds so the portal never waits longer than Docker will allow.
    const drainMax = Number(process.env.PORTAL_DRAIN_MAX_SECONDS ?? 3600);
    const drainLo = 5;
    const drainHi = Math.max(drainLo, Math.min(3600, Number.isFinite(drainMax) ? drainMax : 3600));
    saveSection('controlPlane', {
      globalMax: n(cp.globalMax, 0, 1000, 'Global session cap'),
      perUserMax: n(cp.perUserMax, 0, 100, 'Per-user session cap'),
      perProjectMax: n(cp.perProjectMax, 0, 100, 'Per-project session cap'),
      approvalSlaMinutes: n(cp.approvalSlaMinutes, 0, 10080, 'Approval SLA minutes'),
      worktreeTtlDays: n(cp.worktreeTtlDays, 1, 3650, 'Worktree retention days'),
      drainTimeoutSeconds: n(cp.drainTimeoutSeconds, drainLo, drainHi, 'Drain timeout seconds'),
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

/**
 * Whether Claude runs set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (see agentEnv). On Windows it only hides the variables. On
 * Linux and macOS Claude Code also runs every shell command in its sandbox then: with bubblewrap and socat missing it
 * refuses to run any command, and without socat the sandbox has no network at all (checked with the real engine), so
 * agents could not install packages or fetch. There it comes with the sandbox change, which sets up the network
 * allowlists. PORTAL_AGENT_ENV_SCRUB=1 turns it on anyway, 0 turns it off.
 */
export function scrubAgentEnv(): boolean {
  const v = process.env.PORTAL_AGENT_ENV_SCRUB;
  if (v === '1') return true;
  if (v === '0') return false;
  return process.platform === 'win32';
}

/**
 * Full environment for a Claude Agent SDK run. With a project, its own connection (provider, AWS account) applies.
 * With a run id, the project's own AWS keys are written to that run's private credentials file for the agent.
 */
export async function agentEnv(projectId?: string, modeOverride?: ProviderMode, opts: { runId?: string } = {}): Promise<Record<string, string>> {
  const s = getSettings();
  const env = baseEnv();
  env.CLAUDE_CONFIG_DIR = dataPath('claude-home');
  // All projects share one Claude config folder, so Claude Code's automatic memory would carry notes from one
  // project into the next, unreviewed. Project knowledge lives in CLAUDE.md and the decisions log instead.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  // An MCP tool call has no time limit in Claude Code; a hung integration would hold the run (and its slot) for ever.
  env.MCP_TOOL_TIMEOUT = String((s.agents.mcpToolTimeoutMinutes || 10) * 60_000);

  // Tools and CLI config live on the data volume.
  // Inside the container, HOME is already set to /data/home (Dockerfile ENV), and DATA_DIR
  // is set to /data.  In a managed bare-metal install a user may also set DATA_DIR.
  // In both cases we override HOME to the data home so Claude Code and the AWS CLI use
  // config that persists across restarts.
  //
  // On a bare `npm start` where DATA_DIR is not explicitly set, we leave HOME as-is so
  // ~/.aws, ~/.ssh and the Kiro sign-in in the real home directory are used.
  //
  // Detection: DATA_DIR is set in the environment (container or managed install).
  // When DATA_DIR is absent, dataPath() falls back to ./data — in that case we do not
  // override HOME to avoid breaking local development.
  const dataHome = dataPath('home');
  const toolsBin = dataPath('tools', 'bin');
  const localBin = path.join(dataHome, '.local', 'bin');
  const insideContainer = Boolean(process.env.DATA_DIR);
  if (insideContainer) {
    env.HOME = dataHome;
  }
  // Normalise to uppercase PATH; on Windows the process key may be 'Path' — remove it and set 'PATH'.
  const pathKeySrc = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const existingPath: string = pathKeySrc ? env[pathKeySrc] : (process.env.PATH ?? '');
  if (pathKeySrc && pathKeySrc !== 'PATH') delete env[pathKeySrc];
  // Build the prefix, deduplicated so we never prepend the same path twice.
  // Tool directories are only prepended when running in a managed install (DATA_DIR set);
  // outside that context uvx/kiro-cli must already be on the user's own PATH.
  const prefix = insideContainer
    ? [toolsBin, localBin].filter((d) => !existingPath.split(path.delimiter).includes(d)).join(path.delimiter)
    : '';
  env.PATH = prefix ? prefix + path.delimiter + existingPath : existingPath;

  const pa = projectId ? await import('./project-aws.ts') : null;
  // A run that picked its engine says which provider to set up; otherwise the project's connection decides.
  const mode = modeOverride ?? (pa ? pa.effectiveProvider(projectId) : s.provider.mode);
  if ((mode === 'anthropic' || mode === 'bedrock') && scrubAgentEnv()) {
    // The model's credentials are for Claude Code alone. With this set, the processes it starts (shell commands,
    // hooks, MCP servers) do not inherit ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
    // AWS_BEARER_TOKEN_BEDROCK or any other secret-looking variable, so `printenv` in a prompt-injected command finds
    // nothing to send away. An MCP server still gets the variables its integration sets for it. Side effect: Claude Code
    // then starts in "default" permission mode whatever was asked, so sdk.ts sets the run's own mode before the first
    // message (it does so on every platform).
    env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  }
  if (mode === 'anthropic') {
    const key = await getSecret(SECRET_NAMES.anthropicKey);
    if (!key) throw badRequest('Add your Anthropic API key in Settings first');
    env.ANTHROPIC_API_KEY = key;
    // An operator may send model calls through an LLM gateway (PORTAL_ANTHROPIC_BASE_URL); never a project file.
    if (config.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
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
    const { env: extra, pathPrefix } = await pa.projectRunEnv(projectId, mode === 'bedrock', opts.runId);
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

export function monthSpend(projectId?: string, userId?: string): number {
  const since = monthStart();
  if (projectId && userId) {
    const r = one<{ s: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_runs WHERE created_at >= ? AND project_id = ? AND created_by = ?', since, projectId, userId);
    return r?.s ?? 0;
  }
  if (projectId) {
    const r = one<{ s: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_runs WHERE created_at >= ? AND project_id = ?', since, projectId);
    return r?.s ?? 0;
  }
  if (userId) {
    const r = one<{ s: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_runs WHERE created_at >= ? AND created_by = ?', since, userId);
    return r?.s ?? 0;
  }
  const r = one<{ s: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_runs WHERE created_at >= ?', since);
  return r?.s ?? 0;
}

/** Refuse new runs once the monthly dollar cap is used. Demo and Kiro CLI runs cost no dollars, so they are not capped. */
export function assertBudget(mode: ProviderMode = getSettings().provider.mode, userId?: string, projectId?: string): void {
  const s = getSettings();
  if (mode === 'demo' || mode === 'kiro') return;

  // Portal-wide monthly cap
  const cap = s.budget.monthlyUsd;
  if (cap !== null && cap !== undefined && monthSpend() >= cap) {
    throw badRequest(`This month's budget of $${cap} is used up. An admin can raise it in Settings.`);
  }

  // Per-user monthly cap
  if (userId) {
    const userRow = one<{ monthly_budget_usd: number | null }>('SELECT monthly_budget_usd FROM users WHERE id = ?', userId);
    const userCap = userRow?.monthly_budget_usd;
    if (userCap !== null && userCap !== undefined) {
      const userSpend = monthSpend(undefined, userId);
      if (userSpend >= userCap) {
        throw badRequest(`Your personal monthly budget of $${userCap} is used up. Contact an admin to raise it.`);
      }
    }
  }

  // Per-project monthly cap
  if (projectId) {
    const projRow = one<{ monthly_budget_usd: number | null }>('SELECT monthly_budget_usd FROM projects WHERE id = ?', projectId);
    const projCap = projRow?.monthly_budget_usd;
    if (projCap !== null && projCap !== undefined) {
      const projSpend = monthSpend(projectId);
      if (projSpend >= projCap) {
        throw badRequest(`This project's monthly budget of $${projCap} is used up. Contact an admin to raise it.`);
      }
    }
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
           FROM projects p LEFT JOIN agent_runs r ON r.project_id = p.id AND r.created_at >= ?
          GROUP BY p.id ORDER BY usd DESC`,
        since,
      ),
      byKind: all('SELECT kind, COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS runs FROM agent_runs WHERE created_at >= ? GROUP BY kind', since),
    };
  }, { auth: 'admin' });
}
