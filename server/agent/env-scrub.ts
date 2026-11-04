/**
 * Credential scrubbing for agent shell commands.
 *
 * Pure module: no DB, HTTP, or portal-specific imports.
 *
 * AgentCore reuse: call scrubEnvForShell(env) inside the AgentCore microVM's
 * shell-tool wrapper before exec'ing any agent-requested command. This prevents
 * ANTHROPIC_API_KEY, AWS credential vars, portal secrets, and any other
 * *_SECRET / *_TOKEN / *_KEY var the portal set from leaking into agent shell
 * commands, even when the Claude Code sandbox is not active (Linux arm64 without
 * bubblewrap+socat). shouldScrubSdkEnv() governs whether CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
 * is injected; that env var is only safe on Windows (it activates sandbox mode on Linux).
 *
 * In AgentCore you do not set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB — instead call
 * scrubEnvForShell() explicitly on every shell invocation.
 */

// ── Credential denylist ────────────────────────────────────────────────────────

/**
 * Exact variable names that must never reach agent shell commands.
 * These are model-provider and portal credentials.
 */
const DENYLIST_EXACT = new Set([
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'PORTAL_SECRET_KEY',
  'PORTAL_RUN_TOKEN',
  'PORTAL_API_TOKEN',
  'GITHUB_TOKEN',           // scrubbed unless a push step explicitly re-injects it
  'KIRO_API_KEY',
  'LITELLM_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'COHERE_API_KEY',
]);

/**
 * Suffix patterns that identify credential variables (case-insensitive).
 * Matches anything ending in _SECRET, _TOKEN, or _KEY.
 * This catches portal-set vars like PROJECT_AWS_SECRET_ACCESS_KEY that the
 * subprocess env scrub would also drop.
 */
const DENYLIST_SUFFIX: RegExp[] = [
  /_SECRET$/i,
  /_TOKEN$/i,
  /_KEY$/i,
];

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Return a copy of `env` with all credential variables removed.
 *
 * Uses a combined denylist: exact names (above) plus *_SECRET, *_TOKEN, *_KEY
 * suffixes. Everything else (PATH, HOME, USER, NODE_*, etc.) passes through.
 *
 * This is the function to call in AgentCore shell-tool wrappers and in any
 * local runner path where CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is not in effect.
 */
export function scrubEnvForShell(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isDeniedVar(k)) continue;
    result[k] = v;
  }
  return result;
}

/**
 * Returns true if the variable name matches the denylist.
 * Exported for unit testing.
 */
export function isDeniedVar(name: string): boolean {
  if (DENYLIST_EXACT.has(name)) return true;
  if (DENYLIST_SUFFIX.some((r) => r.test(name))) return true;
  return false;
}

/**
 * Whether to inject CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 into the Claude Code SDK
 * process environment.
 *
 * On Windows this env var only hides the variables from subprocesses — safe.
 * On Linux/macOS it also activates Claude Code's sandbox mode, which requires
 * bubblewrap + socat; without them every shell command fails with "Sandbox is
 * required but failed to initialize". Therefore it is off by default on Linux/macOS.
 *
 * AgentCore (Linux arm64): do NOT set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB. Instead,
 * call scrubEnvForShell() explicitly on each shell tool invocation.
 *
 * PORTAL_AGENT_ENV_SCRUB=1 overrides to on; =0 overrides to off.
 */
export function shouldScrubSdkEnv(): boolean {
  const v = process.env.PORTAL_AGENT_ENV_SCRUB;
  if (v === '1') return true;
  if (v === '0') return false;
  return process.platform === 'win32';
}
