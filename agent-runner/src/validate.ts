/**
 * Payload validation for POST /invocations.
 *
 * Pure module — no imports outside Node.js built-ins.
 * Shared with test/agent-runner-validation.test.ts.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RepoConfig {
  /** Public HTTPS clone URL (shallow clone into session work dir). */
  url: string;
  branch?: string;
}

/**
 * Portal callback stub — populated by the portal when invoking via AgentCore.
 * Not required for the spike; leave the interface here for part 2.
 */
export interface PortalConfig {
  url: string;
  runToken: string;
}

/**
 * Anthropic credential supplied by the portal for this run (the user's own key or subscription token).
 * When present the run uses Anthropic directly instead of Amazon Bedrock. NEVER log or echo `secret`.
 */
export interface AuthConfig {
  kind: 'api_key' | 'oauth_token';
  secret: string;
}

/** One permission rule, as the portal stores it (only the fields the decision needs). */
export interface PolicyRulePayload {
  id: string;
  pattern: string | null;
  category: string | null;
  action: 'allow' | 'block' | 'ask';
  scope: 'always' | 'untrusted';
  reason: string | null;
}

/** The run's permission policy: the same rules and trust level the portal's local engine applies. */
export interface PolicyPayload {
  trusted: boolean;
  rules: PolicyRulePayload[];
}

/** How a tool call that needs a person is handled. Absent: it is declined (nobody to ask). */
export interface ApprovalsPayload {
  /** The portal relays approval-request events and answers with a mode "answer" invocation. */
  via: 'portal';
  /** Minutes before an unanswered request is declined (the portal's own expiry plus a margin). */
  expiryMinutes: number;
}

/** A subagent Claude can hand work to with the Agent tool (the SDK's AgentDefinition, a subset). */
export interface AgentDefinitionPayload {
  description: string;
  /** The agent's system prompt. */
  prompt: string;
  /** Tools it may use. Absent: the same tools as the main agent. */
  tools?: string[];
  disallowedTools?: string[];
  /** haiku | sonnet | opus | inherit, or a Bedrock model ID. Absent: the main agent's model. */
  model?: string;
  maxTurns?: number;
}

/** Child sessions: the agent may start new portal sessions, each a run of its own in its own microVM. */
export interface DelegationPayload {
  /** The runner streams delegate-request events; the portal creates the session and answers. */
  via: 'portal';
}

export interface InvocationPayload {
  /** Unique run ID provided by the caller. */
  runId: string;
  prompt: string;
  /** Bedrock model ID. Defaults to DEFAULT_MODEL. */
  model?: string;
  /** Maximum agent turns (default 10). */
  maxTurns?: number;
  /** Maximum spend in USD (default 0.50). */
  maxBudgetUsd?: number;
  /** Thinking effort (low | medium | high | xhigh | max); the model's own default when absent. */
  effort?: string;
  /** Check steps to run after the agent finishes (checked again by shared/runner-checks.ts before they run). */
  checks?: unknown[];
  /** Wall-clock timeout in minutes (default 10). */
  maxMinutes?: number;
  repo?: RepoConfig;
  /** The session's repositories to clone under repos/ (checked in run.ts by shared/runner-repos.ts). */
  repos?: unknown[];
  /** Remote MCP integrations (checked in run.ts by shared/runner-mcp.ts). */
  mcpServers?: unknown[];
  /** AWS_* variables for the agent's shell: the project's AWS account. */
  awsEnv?: Record<string, string>;
  /** Staged files to write into the work folder first (checked again by shared/runner-files.ts). */
  inputFiles?: unknown[];
  /** Presigned S3 URLs for saving / restoring the workspace (checked by shared/runner-snapshot.ts). */
  snapshot?: unknown;
  /** true = only put the repositories in place (no prompt, no agent run). */
  prepareOnly?: boolean;
  /** true = at the end of the run, report which cloned repositories have changes (read-only; nothing is committed or pushed). */
  finalizeCheck?: boolean;
  portal?: PortalConfig;
  /** Anthropic credential; without it the run uses Bedrock through the execution role. */
  auth?: AuthConfig;
  /**
   * false = only read-only tools run (a one-shot invocation cannot ask for approval). Undefined/true = all tools
   * run after the guard checks.
   */
  trustTools?: boolean;
  /** true = give the agent the AgentCore Browser tools (mcp__browser__*). Off by default: a browser session bills while open. */
  browser?: boolean;
  /** Permission rules and trust. Absent: no rules (everything the guard allows runs), untrusted. */
  policy?: PolicyPayload;
  approvals?: ApprovalsPayload;
  /** The project's subagents, by name. */
  agents?: Record<string, AgentDefinitionPayload>;
  delegation?: DelegationPayload;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
/** Model used when an Anthropic credential is supplied and no model was asked for. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const MAX_SECRET_LENGTH = 4_096;
export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_MAX_BUDGET_USD = 0.5;
export const DEFAULT_MAX_MINUTES = 10;

const MAX_PROMPT_LENGTH = 100_000;
const MAX_REPO_URL_LENGTH = 1_024;
const MAX_RUN_ID_LENGTH = 256;
const KNOWN_FIELDS = new Set([
  'mode', 'runId', 'prompt', 'model', 'maxTurns', 'maxBudgetUsd', 'effort', 'maxMinutes', 'repo', 'repos', 'mcpServers', 'awsEnv', 'inputFiles', 'checks', 'snapshot', 'prepareOnly', 'finalizeCheck', 'portal', 'auth', 'trustTools', 'browser', 'policy', 'approvals',
  'agents', 'delegation',
]);
const AWS_ENV_KEYS = new Set(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION']);

/** Only the five AWS variables, as short plain strings; anything else is dropped. */
export function cleanAwsEnv(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (AWS_ENV_KEYS.has(k) && typeof val === 'string' && val.length > 0 && val.length <= 4096 && !/[\r\n\0]/.test(val)) out[k] = val;
  }
  return out.AWS_ACCESS_KEY_ID && out.AWS_SECRET_ACCESS_KEY ? out : undefined;
}

const KNOWN_AUTH_FIELDS = new Set(['kind', 'secret']);
/** Same limits as the portal's server/agent/agent-defs.ts. */
const MAX_AGENTS = 50;
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_AGENT_DESCRIPTION = 2_000;
const MAX_AGENT_PROMPT = 50_000;
const MAX_AGENT_TOOLS = 100;
const MAX_TOOL_NAME = 200;
const KNOWN_AGENT_FIELDS = new Set(['description', 'prompt', 'tools', 'disallowedTools', 'model', 'maxTurns']);
const MAX_RULES = 1_000;
const MAX_RULE_PATTERN = 2_000;
/** Branch names git accepts and that cannot be read as an option. */
const SAFE_BRANCH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,254}$/;
const KNOWN_REPO_FIELDS = new Set(['url', 'branch']);
const KNOWN_PORTAL_FIELDS = new Set(['url', 'runToken']);

// ── Validation result ─────────────────────────────────────────────────────────

export type ValidationOk = { ok: true; payload: InvocationPayload };
export type ValidationErr = { ok: false; error: string };
export type ValidationResult = ValidationOk | ValidationErr;

// ── validatePayload ───────────────────────────────────────────────────────────

/**
 * Validate and normalise the JSON body of POST /invocations.
 *
 * Returns { ok: true, payload } on success, or { ok: false, error } on any
 * validation failure. Unknown or oversized fields are rejected immediately.
 */
export function validatePayload(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err('Payload must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  // Reject unknown top-level fields
  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(key)) return err(`Unknown field: "${key}"`);
  }

  // runId — required string
  if (obj.mode !== undefined && obj.mode !== 'run') {
    return err('"mode" must be "run" for a run (answers use mode "answer")');
  }

  if (typeof obj.runId !== 'string' || !obj.runId.trim()) {
    return err('"runId" must be a non-empty string');
  }
  if (obj.runId.length > MAX_RUN_ID_LENGTH) {
    return err(`"runId" exceeds maximum length of ${MAX_RUN_ID_LENGTH}`);
  }

  // prompt — required string
  if (obj.prepareOnly !== undefined && typeof obj.prepareOnly !== 'boolean') {
    return err('"prepareOnly" must be a boolean');
  }
  if (obj.finalizeCheck !== undefined && typeof obj.finalizeCheck !== 'boolean') {
    return err('"finalizeCheck" must be a boolean');
  }
  if (obj.prepareOnly === true && obj.prompt === undefined) {
    obj.prompt = 'prepare';
  }
  if (typeof obj.prompt !== 'string' || !obj.prompt.trim()) {
    return err('"prompt" must be a non-empty string');
  }
  if (obj.prompt.length > MAX_PROMPT_LENGTH) {
    return err(`"prompt" exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
  }

  // model — optional string
  if (obj.model !== undefined) {
    if (typeof obj.model !== 'string' || !obj.model.trim()) {
      return err('"model" must be a non-empty string when provided');
    }
  }

  // maxTurns — optional positive integer
  if (obj.maxTurns !== undefined) {
    if (typeof obj.maxTurns !== 'number' || !Number.isInteger(obj.maxTurns) || obj.maxTurns < 1 || obj.maxTurns > 200) {
      return err('"maxTurns" must be a positive integer ≤ 200');
    }
  }

  // maxBudgetUsd — optional positive number
  if (obj.maxBudgetUsd !== undefined) {
    if (typeof obj.maxBudgetUsd !== 'number' || obj.maxBudgetUsd <= 0 || obj.maxBudgetUsd > 100) {
      return err('"maxBudgetUsd" must be a positive number ≤ 100');
    }
  }

  // effort — optional, one of the known levels
  if (obj.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(obj.effort))) {
    return err('"effort" must be low, medium, high, xhigh or max');
  }

  // maxMinutes — optional positive number
  if (obj.maxMinutes !== undefined) {
    if (typeof obj.maxMinutes !== 'number' || obj.maxMinutes <= 0 || obj.maxMinutes > 480) {
      return err('"maxMinutes" must be a positive number ≤ 480');
    }
  }

  // repo — optional object
  let repo: RepoConfig | undefined;
  if (obj.repo !== undefined) {
    if (typeof obj.repo !== 'object' || obj.repo === null || Array.isArray(obj.repo)) {
      return err('"repo" must be an object');
    }
    const r = obj.repo as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!KNOWN_REPO_FIELDS.has(key)) return err(`Unknown field in "repo": "${key}"`);
    }
    if (typeof r.url !== 'string' || !r.url.trim()) {
      return err('"repo.url" must be a non-empty string');
    }
    const trimmedUrl = r.url.trim();
    if (!trimmedUrl.startsWith('https://')) {
      return err('"repo.url" must be a public HTTPS URL');
    }
    if (/[\s\x00-\x1f]/.test(trimmedUrl)) {
      return err('"repo.url" must not contain spaces or control characters');
    }
    if (trimmedUrl.length > MAX_REPO_URL_LENGTH) {
      return err(`"repo.url" exceeds maximum length of ${MAX_REPO_URL_LENGTH}`);
    }
    if (r.branch !== undefined && (typeof r.branch !== 'string' || !r.branch.trim())) {
      return err('"repo.branch" must be a non-empty string when provided');
    }
    if (typeof r.branch === 'string' && (!SAFE_BRANCH.test(r.branch.trim()) || r.branch.includes('..'))) {
      return err('"repo.branch" must be a plain branch name (letters, digits, . _ / -)');
    }
    repo = {
      url: trimmedUrl,
      branch: typeof r.branch === 'string' ? r.branch.trim() : undefined,
    };
  }

  // portal — optional object (stub; required fields are url + runToken)
  let portal: PortalConfig | undefined;
  if (obj.portal !== undefined) {
    if (typeof obj.portal !== 'object' || obj.portal === null || Array.isArray(obj.portal)) {
      return err('"portal" must be an object');
    }
    const p = obj.portal as Record<string, unknown>;
    for (const key of Object.keys(p)) {
      if (!KNOWN_PORTAL_FIELDS.has(key)) return err(`Unknown field in "portal": "${key}"`);
    }
    if (typeof p.url !== 'string' || !p.url.trim()) {
      return err('"portal.url" must be a non-empty string');
    }
    if (typeof p.runToken !== 'string' || !p.runToken.trim()) {
      return err('"portal.runToken" must be a non-empty string');
    }
    portal = { url: p.url.trim(), runToken: p.runToken };
  }

  if (obj.trustTools !== undefined && typeof obj.trustTools !== 'boolean') {
    return err('"trustTools" must be a boolean');
  }

  if (obj.repos !== undefined && !Array.isArray(obj.repos)) {
    return err('"repos" must be an array');
  }
  if (obj.browser !== undefined && typeof obj.browser !== 'boolean') {
    return err('"browser" must be a boolean');
  }

  // auth — optional object { kind, secret }
  let auth: AuthConfig | undefined;
  if (obj.auth !== undefined) {
    if (typeof obj.auth !== 'object' || obj.auth === null || Array.isArray(obj.auth)) {
      return err('"auth" must be an object');
    }
    const a = obj.auth as Record<string, unknown>;
    for (const key of Object.keys(a)) {
      if (!KNOWN_AUTH_FIELDS.has(key)) return err(`Unknown field in "auth": "${key}"`);
    }
    if (a.kind !== 'api_key' && a.kind !== 'oauth_token') {
      return err('"auth.kind" must be "api_key" or "oauth_token"');
    }
    if (typeof a.secret !== 'string' || !a.secret.trim()) {
      return err('"auth.secret" must be a non-empty string');
    }
    if (a.secret.length > MAX_SECRET_LENGTH) {
      return err(`"auth.secret" exceeds maximum length of ${MAX_SECRET_LENGTH}`);
    }
    auth = { kind: a.kind, secret: a.secret.trim() };
  }

  let policy: PolicyPayload | undefined;
  if (obj.policy !== undefined) {
    const r = validatePolicy(obj.policy);
    if (typeof r === 'string') return err(r);
    policy = r;
  }

  let approvals: ApprovalsPayload | undefined;
  if (obj.approvals !== undefined) {
    const a = obj.approvals as Record<string, unknown>;
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return err('"approvals" must be an object');
    for (const key of Object.keys(a)) {
      if (key !== 'via' && key !== 'expiryMinutes') return err(`Unknown field in "approvals": "${key}"`);
    }
    if (a.via !== 'portal') return err('"approvals.via" must be "portal"');
    if (typeof a.expiryMinutes !== 'number' || !(a.expiryMinutes > 0) || a.expiryMinutes > 1440) {
      return err('"approvals.expiryMinutes" must be a positive number ≤ 1440');
    }
    approvals = { via: 'portal', expiryMinutes: a.expiryMinutes };
  }

  let agents: Record<string, AgentDefinitionPayload> | undefined;
  if (obj.agents !== undefined) {
    const r = validateAgents(obj.agents);
    if (typeof r === 'string') return err(r);
    agents = r;
  }

  let delegation: DelegationPayload | undefined;
  if (obj.delegation !== undefined) {
    const d = obj.delegation as Record<string, unknown>;
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return err('"delegation" must be an object');
    for (const key of Object.keys(d)) {
      if (key !== 'via') return err(`Unknown field in "delegation": "${key}"`);
    }
    if (d.via !== 'portal') return err('"delegation.via" must be "portal"');
    delegation = { via: 'portal' };
  }

  return {
    ok: true,
    payload: {
      runId: obj.runId.trim(),
      prompt: obj.prompt,
      model: typeof obj.model === 'string' ? obj.model.trim() : undefined,
      maxTurns: typeof obj.maxTurns === 'number' ? obj.maxTurns : undefined,
      maxBudgetUsd: typeof obj.maxBudgetUsd === 'number' ? obj.maxBudgetUsd : undefined,
      ...(typeof obj.effort === 'string' ? { effort: obj.effort } : {}),
      ...(Array.isArray(obj.checks) && obj.checks.length <= 8 ? { checks: obj.checks as unknown[] } : {}),
      maxMinutes: typeof obj.maxMinutes === 'number' ? obj.maxMinutes : undefined,
      repo,
      ...(Array.isArray(obj.repos) ? { repos: obj.repos as unknown[] } : {}),
      ...(Array.isArray(obj.mcpServers) ? { mcpServers: obj.mcpServers as unknown[] } : {}),
      ...(cleanAwsEnv(obj.awsEnv) ? { awsEnv: cleanAwsEnv(obj.awsEnv) } : {}),
      ...(Array.isArray(obj.inputFiles) && obj.inputFiles.length <= 30 ? { inputFiles: obj.inputFiles as unknown[] } : {}),
      ...(obj.snapshot ? { snapshot: obj.snapshot } : {}),
      ...(obj.prepareOnly === true ? { prepareOnly: true } : {}),
      ...(obj.finalizeCheck === true ? { finalizeCheck: true } : {}),
      portal,
      auth,
      trustTools: typeof obj.trustTools === 'boolean' ? obj.trustTools : undefined,
      browser: obj.browser === true ? true : undefined,
      policy,
      approvals,
      agents,
      delegation,
    },
  };
}

function validateAgents(raw: unknown): Record<string, AgentDefinitionPayload> | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '"agents" must be an object of agent definitions by name';
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_AGENTS) return `"agents" has more than ${MAX_AGENTS} agents`;
  const out: Record<string, AgentDefinitionPayload> = {};
  const toolList = (v: unknown, where: string): string[] | string => {
    if (!Array.isArray(v) || v.length > MAX_AGENT_TOOLS) return `${where} must be an array of at most ${MAX_AGENT_TOOLS} tool names`;
    for (const t of v) {
      if (typeof t !== 'string' || !t || t.length > MAX_TOOL_NAME) return `${where} must hold tool names of 1 to ${MAX_TOOL_NAME} characters`;
    }
    return v as string[];
  };
  for (const [name, value] of entries) {
    const at = `"agents.${name.slice(0, 64)}"`;
    if (!AGENT_NAME.test(name)) return `${at}: an agent name is 1 to 64 letters, digits, ".", "_" or "-"`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${at} must be an object`;
    const a = value as Record<string, unknown>;
    for (const key of Object.keys(a)) {
      if (!KNOWN_AGENT_FIELDS.has(key)) return `Unknown field in ${at}: "${key}"`;
    }
    if (typeof a.description !== 'string' || !a.description.trim() || a.description.length > MAX_AGENT_DESCRIPTION) {
      return `${at}.description must be a non-empty string of at most ${MAX_AGENT_DESCRIPTION} characters`;
    }
    if (typeof a.prompt !== 'string' || !a.prompt.trim() || a.prompt.length > MAX_AGENT_PROMPT) {
      return `${at}.prompt must be a non-empty string of at most ${MAX_AGENT_PROMPT} characters`;
    }
    const def: AgentDefinitionPayload = { description: a.description, prompt: a.prompt };
    if (a.tools !== undefined) {
      const t = toolList(a.tools, `${at}.tools`);
      if (typeof t === 'string') return t;
      def.tools = t;
    }
    if (a.disallowedTools !== undefined) {
      const t = toolList(a.disallowedTools, `${at}.disallowedTools`);
      if (typeof t === 'string') return t;
      def.disallowedTools = t;
    }
    if (a.model !== undefined) {
      if (typeof a.model !== 'string' || !a.model.trim() || a.model.length > 200) return `${at}.model must be a non-empty string of at most 200 characters`;
      def.model = a.model.trim();
    }
    if (a.maxTurns !== undefined) {
      if (typeof a.maxTurns !== 'number' || !Number.isInteger(a.maxTurns) || a.maxTurns < 1 || a.maxTurns > 200) {
        return `${at}.maxTurns must be a positive integer ≤ 200`;
      }
      def.maxTurns = a.maxTurns;
    }
    out[name] = def;
  }
  return out;
}

function validatePolicy(raw: unknown): PolicyPayload | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '"policy" must be an object';
  const p = raw as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (key !== 'trusted' && key !== 'rules') return `Unknown field in "policy": "${key}"`;
  }
  if (typeof p.trusted !== 'boolean') return '"policy.trusted" must be a boolean';
  if (!Array.isArray(p.rules)) return '"policy.rules" must be an array';
  if (p.rules.length > MAX_RULES) return `"policy.rules" has more than ${MAX_RULES} rules`;
  const rules: PolicyRulePayload[] = [];
  for (const [i, r] of p.rules.entries()) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return `"policy.rules[${i}]" must be an object`;
    const x = r as Record<string, unknown>;
    if (typeof x.id !== 'string' || !x.id) return `"policy.rules[${i}].id" must be a non-empty string`;
    if (x.pattern !== null && x.pattern !== undefined && (typeof x.pattern !== 'string' || x.pattern.length > MAX_RULE_PATTERN)) {
      return `"policy.rules[${i}].pattern" must be a string of at most ${MAX_RULE_PATTERN} characters or null`;
    }
    if (x.category !== null && x.category !== undefined && typeof x.category !== 'string') return `"policy.rules[${i}].category" must be a string or null`;
    if (x.action !== 'allow' && x.action !== 'block' && x.action !== 'ask') return `"policy.rules[${i}].action" must be allow, block or ask`;
    if (x.scope !== 'always' && x.scope !== 'untrusted') return `"policy.rules[${i}].scope" must be always or untrusted`;
    if (x.reason !== null && x.reason !== undefined && typeof x.reason !== 'string') return `"policy.rules[${i}].reason" must be a string or null`;
    rules.push({
      id: x.id,
      pattern: (x.pattern as string | null | undefined) ?? null,
      category: (x.category as string | null | undefined) ?? null,
      action: x.action,
      scope: x.scope,
      reason: (x.reason as string | null | undefined) ?? null,
    });
  }
  return { trusted: p.trusted, rules };
}

function err(message: string): ValidationErr {
  return { ok: false, error: message };
}
