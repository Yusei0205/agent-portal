/**
 * Check steps for loop sessions: commands (tests, lint, build) run after an agent iteration to see whether the work
 * holds up. The runner executes them where the code is (the AgentCore runner, or the portal for local runs); the portal
 * validates them when a loop is created and feeds the result into the next iteration.
 *
 * Self-contained (node built-ins only) because the Docker images copy this file into the runners as shared/.
 * Ported from the loop-engineering verification pipeline and harness PR 1.2 (a check command runs without a person
 * looking at it, so commands the agents' guard would refuse are refused here too).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

// ── What a check command may not be ──────────────────────────────────────────

/** Never allowed: deploys and infrastructure or cloud changes. */
const ALWAYS_BLOCKED: [RegExp, string][] = [
  [/\b(?:terraform|tofu)\s+(?:apply|destroy|import|state\s+(?:rm|mv))\b/i, 'Deploying infrastructure is not allowed in a check.'],
  [/\b(?:cdk|sam|serverless|sls|pulumi)\s+(?:deploy|destroy|remove|up)\b/i, 'Deploying is not allowed in a check.'],
  [/\baws\s+cloudformation\s+(?:deploy|create-stack|update-stack|delete-stack)\b/i, 'Changing CloudFormation stacks is not allowed in a check.'],
  [/\baws\s+lambda\s+(?:update-function-code|update-function-configuration|create-function|delete-function|publish-version)\b/i, 'Changing Lambda functions is not allowed in a check.'],
  [/\bkubectl\s+(?:apply|delete|replace|patch|scale|rollout)\b/i, 'Changing a cluster is not allowed in a check.'],
  [/\bhelm\s+(?:install|upgrade|uninstall|rollback)\b/i, 'Changing a cluster with Helm is not allowed in a check.'],
  [/\bdocker\s+push\b/i, 'Pushing an image is not allowed in a check.'],
  [/\baws\s+(?:--\S+\s+\S+\s+)*[a-z0-9-]+\s+(?:delete|terminate|remove|put|create|update|modify|attach|detach|invoke|publish|send|start|stop|reboot|run|register|deregister|tag|untag|set|enable|disable|import|restore|reset|revoke|associate|disassociate|authorize|deploy|execute)\S*/i, 'Changing AWS resources is not allowed in a check. Read-only commands (describe, list, get) are fine.'],
  [/\baws\s+s3\s+(?:rm|mv|sync|rb|mb|website)\b/i, 'Changing S3 is not allowed in a check.'],
];

/** Also refused: things that act outside the working copy or hand control to the network. */
const ALSO_BLOCKED: [RegExp, string][] = [
  [/\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+\s+|-\S+\s+)*push\b/i, 'Pushing is done by a person after reviewing the changes.'],
  [/\bsudo\b/i, 'sudo is not allowed.'],
  [/\brm\s+(?:-\S*\s+)*-\S*[rf]\S*\s+(?:-\S+\s+)*(?:\/|~|\$home|\.\.|[a-z]:[\\/]|\*)(?:\s|$)/i, 'Deleting outside the working copy is not allowed.'],
  [/\b(?:npm|yarn|pnpm)\s+publish\b/i, 'Publishing a package is not allowed.'],
  [/\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i, 'Piping a download into a shell is not allowed.'],
  [/\b(?:mkfs|shutdown|reboot|halt)\b|\bdd\s+if=|\bformat\s+[a-z]:/i, 'System commands are not allowed.'],
  // Tool settings, MCP config and git hooks are protected from agents; a check must not write them either.
  [/(?:>|tee\s+(?:-a\s+)?)\s*\S*(?:\.claude\/settings|\.mcp\.json|\.kiro\/settings|\.git\/(?:hooks|config))/i, 'Writing tool settings or git hooks is not allowed.'],
  [/\bgit\s+config\b[^\n;&|]*\b(?:core\.(?:hookspath|fsmonitor|sshcommand)|alias\.|filter\.|include)/i, 'Setting a git option that runs a program is not allowed.'],
];

/** Why this check command is refused, or null when it may run. */
export function blockedCheckCommand(command: string): string | null {
  const text = String(command ?? '');
  for (const [re, why] of ALWAYS_BLOCKED) if (re.test(text)) return why;
  for (const [re, why] of ALSO_BLOCKED) if (re.test(text)) return why;
  return null;
}

// ── Steps ────────────────────────────────────────────────────────────────────

export interface CheckStep {
  /** A short name shown with the result ("tests", "lint"). */
  step: string;
  cmd: string;
  /** Seconds before the step is stopped (default 300). */
  timeout?: number;
  /** Optional: run inside repos/<name> instead of the work folder. */
  workRepo?: string;
  /** A failing step that is not required is reported but does not fail the checks (default: required). */
  required?: boolean;
}

export const MAX_CHECK_STEPS = 8;
const MAX_CMD_CHARS = 1000;

/** Check and clean the steps from a request. Throws an Error with a message fit to show a person. */
export function validateCheckSteps(raw: unknown): CheckStep[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) throw new Error('Checks must be a list of steps');
  if (raw.length > MAX_CHECK_STEPS) throw new Error(`At most ${MAX_CHECK_STEPS} check steps`);
  return raw.map((r, i) => {
    const s = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const step = String(s.step ?? `step ${i + 1}`).trim().slice(0, 60) || `step ${i + 1}`;
    const cmd = String(s.cmd ?? '').trim();
    if (!cmd) throw new Error(`Check "${step}" needs a command`);
    if (cmd.length > MAX_CMD_CHARS) throw new Error(`Check "${step}" is too long (max ${MAX_CMD_CHARS} characters)`);
    const why = blockedCheckCommand(cmd);
    if (why) throw new Error(`Check "${step}" is not allowed: ${why}`);
    const out: CheckStep = { step, cmd };
    const t = Number(s.timeout);
    if (Number.isFinite(t) && t >= 1) out.timeout = Math.min(Math.round(t), 1800);
    if (typeof s.workRepo === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(s.workRepo)) out.workRepo = s.workRepo;
    if (s.required === false) out.required = false;
    return out;
  });
}

// ── Running ──────────────────────────────────────────────────────────────────

export interface CheckStepResult {
  step: string;
  ok: boolean;
  /** The end of the output, at most 4,000 characters. */
  output: string;
  durationMs: number;
  required: boolean;
}

export interface CheckResult {
  steps: CheckStepResult[];
  /** True when every required step passed. */
  ok: boolean;
  ranAt: string;
}

const OUTPUT_TAIL = 4000;

/** The environment a check runs in: no credentials, only what a build or test needs. */
function checkEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV', 'UV_CACHE_DIR', 'UV_PYTHON_PREFERENCE', 'npm_config_cache'];
  const env: NodeJS.ProcessEnv = { CI: '1' };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function runOne(cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  if (signal?.aborted) return Promise.resolve({ ok: false, output: '[check cancelled]' });
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    // Windows' system bash.exe may be a WSL launcher with no Linux distribution.
    // Prefer Git Bash when it is installed with the Git used by the portal.
    const gitBash = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    const bash = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';
    const child = spawn(bash, ['-c', cmd], { cwd, env: checkEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const add = (d: Buffer): void => { out = (out + d.toString('utf8')).slice(-OUTPUT_TAIL * 4); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const finish = (ok: boolean, extra = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ ok, output: (out + extra).slice(-OUTPUT_TAIL) });
    };
    const timer = setTimeout(() => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone */ }
      finish(false, `\n[stopped after ${Math.round(timeoutMs / 1000)} s]`);
    }, timeoutMs);
    const abort = (): void => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* gone */ }
      finish(false, '\n[check cancelled]');
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', (e) => finish(false, `\n[could not start: ${e.message}]`));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * Run the steps in order inside `workDir` (or `workDir/repos/<workRepo>`). A failing required step stops the rest.
 * The steps are checked again here, because what runs must never be more than what the portal allows.
 */
export async function runCheckSteps(steps: CheckStep[], workDir: string, signal?: AbortSignal): Promise<CheckResult> {
  const results: CheckStepResult[] = [];
  let ok = true;
  const ranAt = new Date().toISOString();
  for (const s of validateCheckSteps(steps)) {
    const cwd = s.workRepo ? path.join(workDir, 'repos', s.workRepo) : workDir;
    const started = Date.now();
    const r = await runOne(s.cmd, cwd, (s.timeout ?? 300) * 1000, signal);
    const required = s.required !== false;
    results.push({ step: s.step, ok: r.ok, output: r.output, durationMs: Date.now() - started, required });
    if (!r.ok && required) { ok = false; break; }
  }
  return { steps: results, ok, ranAt };
}

/** The result as text for the next iteration's prompt. */
export function formatCheckResult(result: CheckResult): string {
  const lines = [`Checks ${result.ok ? 'PASSED' : 'FAILED'} (${result.ranAt}).`];
  for (const s of result.steps) {
    lines.push(`${s.ok ? 'pass' : 'FAIL'} ${s.step} (${s.durationMs} ms)${s.required ? '' : ' [optional]'}`);
    if (!s.ok) lines.push(s.output.slice(-1500));
  }
  return lines.join('\n');
}
