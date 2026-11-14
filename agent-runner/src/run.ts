/**
 * Agent run — one Claude Code invocation against Bedrock.
 *
 * Shared portal code (copied into shared/ at build time, same source as the portal)
 * ──────────────────────────────────────────────────────────────────────────────
 * decideToolCall   : shared/agent/tool-policy.ts. The same decision the portal's local
 *                    engine makes: working folder (links followed), guard (tool settings,
 *                    MCP lists, git hooks/config), the run's permission rules, remembered
 *                    approvals, commands too long to review.
 * ApprovalBroker   : shared/agent/agentcore-approvals.ts. A call that needs a person is
 *                    streamed as an `approval-request`; the portal answers with a second
 *                    invocation (mode "answer") bound to the call's SHA-256 fingerprint.
 * scrubEnvForShell : shared/agent/env-scrub.ts. Removes *_KEY/*_TOKEN/*_SECRET
 *                    vars from the env passed to the SDK subprocess.
 * estimateCost     : shared/agent/pricing.ts, for runs that end without the SDK's total.
 *
 * Several agents, several sessions
 * ────────────────────────────────
 * Subagents   : the project's agents arrive in the payload (`agents`) and go to the SDK, so
 *               Claude can hand work to them with the Agent tool. Their tool calls go through
 *               the same canUseTool. Their start and end are streamed as subagent-started /
 *               subagent-finished / subagent-failed; their text carries `agent`.
 * Sessions    : with `delegation`, Claude gets the delegate_session tool. A call is streamed as
 *               a `delegate-request`; the portal starts a new session (its own run, in its own
 *               microVM) and answers through the broker, like an approval. The child's result is
 *               posted back to the parent session when it finishes.
 *
 * Environment scrubbing note
 * ───────────────────────────
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is NOT set — on Linux/arm64 it activates
 * sandbox mode (bubblewrap + socat required), which is not present in this image.
 * Instead, scrubEnvForShell() is applied to the env that the SDK receives, so
 * Claude Code and all shells it spawns start with credential vars removed.
 *
 * In AgentCore production the execution role delivers credentials via
 * AWS_CONTAINER_CREDENTIALS_RELATIVE_URI (not in the scrub denylist), so the
 * credential chain works without re-injecting direct AWS_ACCESS_KEY_ID values.
 * For local testing where explicit creds are passed via --env-file those values
 * ARE re-added so Claude Code can reach Bedrock; shell-level isolation of those
 * values requires a wrapper shell and is tracked as an open question for part 2.
 *
 * Session storage
 * ───────────────
 * Work dir is /tmp/agent-sessions/<sessionId>/work (ephemeral per microVM).
 * AgentCore's managed "Session Storage" (preview) can persist a mountPath across
 * stop/resume cycles — configure filesystemConfigurations.sessionStorage on the
 * Runtime ARN and mount it at /agent-workspace (no VPC needed). Size limit is not
 * published in the docs; empirical tests suggest several GB. The default /tmp is
 * ephemeral and typically 512 MB–2 GB in a microVM. See results doc for details.
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scrubEnvForShell } from '../shared/agent/env-scrub.ts';
import { decideToolCall, inputFingerprint } from '../shared/agent/tool-policy.ts';
import { estimateCost } from '../shared/agent/pricing.ts';
import type { ApprovalBroker } from '../shared/agent/agentcore-approvals.ts';
import { AgentCoreBrowser, BROWSER_SERVER_NAME, createBrowserMcpServer } from './browser-tools.js';
import { emitRunnerFiles, writeInputFilesAsync } from '../shared/runner-files.js';
import { runCheckSteps } from '../shared/runner-checks.js';
import { parseRunnerRepos, cloneRunnerRepos, usablePersistRoot, PERSIST_ROOT } from '../shared/runner-repos.js';
import { parseSnapshot, restoreWorkspace } from '../shared/runner-snapshot.js';
import { parseMcpServers } from '../shared/runner-mcp.js';
import { claudeCodeMemoryHooks } from '../shared/runner-memory.js';
import { reportRepoChanges } from './finalize.js';
import { fileURLToPath } from 'node:url';
import {
  type InvocationPayload,
  DEFAULT_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_BUDGET_USD,
  DEFAULT_MAX_MINUTES,
} from './validate.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmitFn = (event: Record<string, unknown>) => void;

interface RunMetrics {
  coldStartMs: number;
  startToFirstTokenMs: number | null;
  durationMs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  peakRssMb: number;
  workDirDiskMb: number;
}

/** Tools that only read: allowed even when the session does not trust all tools (a request without a policy). */
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite',
  // The agent's own task list: nothing leaves the run, so it needs no approval.
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
  'read', 'glob', 'grep', 'ls',
  // AgentCore Browser tools that only look (opening a page is like WebFetch). click/type need "Trust all tools".
  `mcp__${BROWSER_SERVER_NAME}__goto`, `mcp__${BROWSER_SERVER_NAME}__snapshot`,
  `mcp__${BROWSER_SERVER_NAME}__get_text`, `mcp__${BROWSER_SERVER_NAME}__screenshot`,
]);

// ── Disk usage helper ─────────────────────────────────────────────────────────

function dirSizeMb(dirPath: string): number {
  try {
    const out = execFileSync('du', ['-sm', dirPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const mb = parseInt(out.split('\t')[0] ?? '0', 10);
    return isNaN(mb) ? 0 : mb;
  } catch {
    return 0;
  }
}

/** How a run ended, for the portal: end_turn | max_turns | budget | time_limit | cancelled | error. */
function stopReasonOf(subtype: string, fallback: string): string {
  if (subtype === 'error_max_budget_usd') return 'budget';
  if (subtype === 'error_max_turns') return 'max_turns';
  if (subtype === 'error_during_execution') return 'error';
  return fallback;
}

/** The engine's tool that starts a subagent (named Task in older Claude Code versions). */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * Bedrock models behind the aliases a subagent may name (haiku, sonnet, opus): the global
 * profiles the runtime's role may call (infra/lib/harness-stack.ts).
 */
export const BEDROCK_ALIAS_MODELS = {
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'global.anthropic.claude-opus-4-5-20251101-v1:0',
} as const;

// ── Child sessions (delegate_session) ────────────────────────────────────────

export const DELEGATE_TOOL = 'delegate_session';
/** MCP server name: the model sees the tool as mcp__portal__delegate_session. */
export const PORTAL_MCP_SERVER = 'portal';
/** How long a delegate call waits for the portal to start the session. */
const DELEGATE_WAIT_MS = 120_000;

const DELEGATE_DESCRIPTION =
  'Start a new portal session for a separate piece of this task. The session runs on its own ' +
  '(its own run and machine) with the same project, model and permission rules, and its result is ' +
  'posted back to this session when it finishes. Use it for large, independent work that can go on ' +
  'in parallel; for a quick, focused piece of work use the Agent tool instead. Give the session a ' +
  "complete, self-contained task: it does not see this conversation. Returns the new session's ID and title.";

/**
 * The in-process MCP server with delegate_session, or undefined when the run has no delegation.
 * A call opens a broker request, streams a delegate-request event, and waits for the portal's answer.
 */
async function portalMcpServers(
  sdk: SdkModule,
  payload: InvocationPayload,
  emit: EmitFn,
  broker: ApprovalBroker | undefined,
  stop: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (!payload.delegation || !broker) return undefined;
  if (typeof sdk.tool !== 'function' || typeof sdk.createSdkMcpServer !== 'function') {
    emit({ type: 'status', text: 'Child sessions are not available: this Agent SDK has no in-process tools.' });
    return undefined;
  }
  const { z } = await import('zod');
  // The run's agents can each run a child session as its lead agent (a lead hands a whole piece to a specialist).
  const agentNames = Object.keys(payload.agents ?? {});
  const delegate = sdk.tool(
    DELEGATE_TOOL,
    agentNames.length
      ? `${DELEGATE_DESCRIPTION} Set "agent" to have one of this session's agents run the new session as its lead (its prompt, tools and skills); without it the session uses this session's lead agent.`
      : DELEGATE_DESCRIPTION,
    {
      task: z.string().min(1).max(20_000).describe('The complete task for the new session, with everything it needs to know'),
      title: z.string().max(200).optional().describe('A short title for the new session'),
      ...(agentNames.length
        ? { agent: z.enum(agentNames as [string, ...string[]]).optional().describe('The agent that runs the new session as its lead agent') }
        : {}),
    },
    async (args: { task?: string; title?: string; agent?: string }) => {
      const task = String(args.task ?? '').trim();
      if (!task) return { content: [{ type: 'text', text: 'Error: "task" is required.' }], isError: true };
      const input: Record<string, unknown> = { task };
      const title = String(args.title ?? '').trim();
      if (title) input.title = title;
      const agent = String(args.agent ?? '').trim();
      if (agent) {
        if (!agentNames.includes(agent)) {
          return { content: [{ type: 'text', text: `Error: "agent" must be one of: ${agentNames.join(', ') || '(none)'}.` }], isError: true };
        }
        input.agent = agent;
      }
      const inputHash = inputFingerprint(DELEGATE_TOOL, input);
      const req = broker.open(payload.runId, inputHash, DELEGATE_WAIT_MS, stop);
      emit({ type: 'delegate-request', requestId: req.requestId, input, inputHash });
      const outcome = await req.outcome;
      if (outcome.decision === 'allow') return { content: [{ type: 'text', text: outcome.message || 'The session was started.' }] };
      return { content: [{ type: 'text', text: outcome.message || 'The portal did not start the session.' }], isError: true };
    },
  );
  // alwaysLoad: the tool is always in the prompt, never deferred behind tool search, so
  // Claude sees delegate_session from its first turn.
  return {
    [PORTAL_MCP_SERVER]: sdk.createSdkMcpServer({ name: PORTAL_MCP_SERVER, version: '1.0.0', tools: [delegate], alwaysLoad: true }),
  };
}

// ── SDK loader ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkModule = Record<string, any>;

async function loadSdk(): Promise<SdkModule> {
  // Dynamic import so bundlers (esbuild with external:...) don't try to inline it.
  // @anthropic-ai/claude-agent-sdk is declared external in build.mjs and installed
  // separately in the container via npm ci.
  return import('@anthropic-ai/claude-agent-sdk') as Promise<SdkModule>;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run one agent invocation. Streams SSE events via emit(), then resolves.
 *
 * @param payload   Validated invocation payload.
 * @param sessionId Session ID from the AgentCore runtime header (used to key
 *                  the work dir for session affinity across multi-turn runs).
 * @param emit      SSE emit callback — called for each event JSON object.
 * @param processStartMs  Date.now() at process start (for cold-start metric).
 * @param broker    Open approval requests; the server settles them from "answer" invocations.
 * @param stop      Aborts when the caller cancels the run or disconnects.
 * @param memoryNote What the memory guard stopped since the last tool call, as a note for the agent.
 */
export async function runInvocation(
  payload: InvocationPayload,
  sessionId: string | undefined,
  emit: EmitFn,
  processStartMs: number,
  broker?: ApprovalBroker,
  stop?: AbortSignal,
  memoryNote?: () => string | null,
): Promise<void> {
  const coldStartMs = Date.now() - processStartMs;
  const invokeStart = Date.now();
  let firstTokenMs: number | null = null;

  const model = payload.model ?? (payload.auth ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_MODEL);
  const maxTurns = payload.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxBudgetUsd = payload.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const maxMinutes = payload.maxMinutes ?? DEFAULT_MAX_MINUTES;

  // ── Work dir ────────────────────────────────────────────────────────────────
  // Use sessionId as the directory key so repeated invocations to the same session
  // share a work dir (within the same microVM lifetime).
  // Session storage note: in AgentCore production, configure filesystemConfigurations
  // with sessionStorage.mountPath = /agent-workspace to persist the work dir across
  // stop/resume cycles. /tmp is ephemeral; /agent-workspace would survive a session
  // resume. For the spike, /tmp is fine.
  const sessionKey = (sessionId ?? `run-${payload.runId}`).replace(/[^A-Za-z0-9._-]/g, '_');
  const workRoot = process.env.AGENT_RUNNER_WORK_ROOT || path.join('/tmp', 'agent-sessions');
  fs.mkdirSync(path.join(workRoot, sessionKey, 'work'), { recursive: true });
  // The real path, so the inside-the-folder check compares like with like.
  const workDir = fs.realpathSync.native(path.join(workRoot, sessionKey, 'work'));

  emit({ type: 'status', text: `Work dir: ${workDir}` });

  // ── Clone repo ──────────────────────────────────────────────────────────────
  if (payload.repo?.url) {
    const cloneUrl = payload.repo.url;
    const branchArgs = payload.repo.branch ? ['--branch', payload.repo.branch] : [];
    emit({ type: 'status', text: `Cloning ${cloneUrl}${payload.repo.branch ? ` @ ${payload.repo.branch}` : ''}` });
    try {
      // No shell: the URL and branch are arguments, never command text. No hooks run.
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth=1', ...branchArgs, '--', cloneUrl, '.'], {
        cwd: workDir,
        stdio: 'pipe',
        timeout: 60_000,
      });
      emit({ type: 'status', text: 'Clone complete' });
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      throw new Error(`git clone failed: ${msg.slice(0, 300)}`);
    }
  }

  // Files the portal staged for this run (attachments, chosen project documents).
  if (payload.inputFiles?.length) {
    const n = await writeInputFilesAsync(workDir, payload.inputFiles, emit);
    emit({ type: 'status', text: `${n} input file${n === 1 ? '' : 's'} placed in the work folder` });
  }

  // ── The session's repositories (cloned under repos/) ───────────────────────
  if (payload.repos?.length) {
    const parsed = parseRunnerRepos(payload.repos);
    if (parsed.ok) {
      await restoreWorkspace(parseSnapshot(payload.snapshot), usablePersistRoot(PERSIST_ROOT), (ev) => emit(ev));
      await cloneRunnerRepos(parsed.repos, workDir, (ev) => emit(ev), { persistRoot: PERSIST_ROOT, homeDir: workDir, ...(payload.prepareOnly === true ? { onProgress: (u: { name: string; phase: string; percent: number; detail: string }) => emit({ type: 'progress', ...u }) } : {}) });
    } else {
      emit({ type: 'status', text: `Repositories were not cloned: ${parsed.error}` });
    }
  }
  if (payload.prepareOnly) {
    emit({ type: 'result', runId: payload.runId, stop_reason: 'prepared', metrics: {} });
    return;
  }

  // Files changed from here on are what the agent produced (the clone above is not sent back).
  const filesSinceMs = Date.now();

  // ── SDK env ─────────────────────────────────────────────────────────────────
  const region =
    process.env.AWS_DEFAULT_REGION ??
    process.env.AWS_REGION ??
    'ap-southeast-1';

  // Start with scrubbed env (removes *_KEY, *_TOKEN, *_SECRET suffix vars).
  // In AgentCore production: IAM execution role uses AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  // which is NOT in the scrub denylist, so the credential chain works unmodified.
  // In local testing: we re-add explicit AWS credential vars so Claude Code can reach Bedrock.
  const scrubbed = scrubEnvForShell(process.env as Record<string, string | undefined>);
  // Local testing only: AGENT_RUNNER_ANTHROPIC_BASE_URL sends model calls to an
  // Anthropic-compatible stand-in (test/mock-anthropic-api.ts) instead of Bedrock.
  const devAnthropicUrl = process.env.AGENT_RUNNER_ANTHROPIC_BASE_URL;
  const sdkEnv: Record<string, string> = {
    ...scrubbed,
    ...(devAnthropicUrl
      ? { ANTHROPIC_BASE_URL: devAnthropicUrl, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'local-test-key' }
      : {}),
    AWS_DEFAULT_REGION: region,
    AWS_REGION: region,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // One MCP tool call may take at most 10 minutes (Claude Code has no limit of its own).
    MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? '600000',
    // Isolate Claude's home dir to the work dir (no user-level settings loaded)
    HOME: workDir,
    USERPROFILE: workDir, // Windows compatibility (not needed in the container)
  };

  if (payload.auth) {
    // The user's own Anthropic credential, valid for this run only (the microVM is isolated per session).
    if (payload.auth.kind === 'api_key') sdkEnv.ANTHROPIC_API_KEY = payload.auth.secret;
    else sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = payload.auth.secret;
  } else if (!devAnthropicUrl) {
    sdkEnv.CLAUDE_CODE_USE_BEDROCK = '1';
    // Claude Code's aliases (haiku/sonnet/opus) -> the global Bedrock profiles the runtime role allows.
    Object.assign(sdkEnv, BEDROCK_ALIAS_MODELS);
  }

  // Re-add AWS credential chain vars needed by Claude Code itself (Bedrock path).
  // (Harmless with an Anthropic credential: the SDK ignores them.)
  // In AgentCore prod these are typically absent (IAM role via metadata service).
  // In local testing they are set via --env-file and needed for Bedrock auth.
  const credVarsToRestore = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
  ];
  const credChainVars = [
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_PROFILE',
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
  ];
  for (const k of [...credVarsToRestore, ...credChainVars]) {
    const v = (process.env as Record<string, string | undefined>)[k];
    if (v !== undefined) sdkEnv[k] = v;
  }

  // The person's own AWS access for Bedrock (pasted keys or an assumed role): the machine's role is taken out so the
  // model calls are made, and billed, as that account.
  if (payload.bedrockEnv && !payload.auth) {
    for (const k of [...credVarsToRestore, ...credChainVars]) delete sdkEnv[k];
    Object.assign(sdkEnv, payload.bedrockEnv);
  }

  // The project's AWS account for the agent's shell. With an Anthropic credential the machine's own role is not
  // needed (it only serves Bedrock), so it is taken out and the agent can only act as the account it was given.
  if (payload.awsEnv && payload.auth) {
    for (const k of [...credVarsToRestore, ...credChainVars]) delete sdkEnv[k];
    Object.assign(sdkEnv, payload.awsEnv);
  }

  // ── Load SDK ────────────────────────────────────────────────────────────────
  const sdk = await loadSdk();
  if (typeof sdk.query !== 'function') {
    throw new Error('Claude Agent SDK does not export query(). Check the SDK version.');
  }

  // ── Abort controller (wall-clock limit) ─────────────────────────────────────
  const abortController = new AbortController();
  let endedBy: 'time_limit' | 'cancelled' | null = null;
  const wallClockTimer = setTimeout(() => {
    endedBy = 'time_limit';
    abortController.abort();
    emit({ type: 'status', text: `Time limit of ${maxMinutes} minutes reached. Run stopped.` });
  }, maxMinutes * 60_000);
  const onStop = (): void => {
    if (!endedBy) endedBy = 'cancelled';
    abortController.abort();
  };
  if (stop?.aborted) onStop();
  else stop?.addEventListener('abort', onStop, { once: true });

  // ── AgentCore Browser (optional, started on first use, always stopped in finally) ──
  const browser = payload.browser ? new AgentCoreBrowser(emit, region) : null;
  if (browser) {
    browser.onSession = (s) => emit({ type: 'browser-session', ...s });
    // Live Browser view in the portal (a small picture after each action; never shown to the model).
    browser.onFrame = (f) => {
      emit({ type: 'browser-navigate', url: f.url });
      emit({ type: 'browser-screenshot', screenshotBase64: f.jpegBase64, url: f.url });
    };
  }

  // ── Remote MCP integrations: one local stdio proxy each (holds the secret headers, hides write tools unless allowed)
  const integrations = parseMcpServers(payload.mcpServers);
  const proxyPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-proxy.mjs');
  // The draw.io server is bundled in the image: an integration named "drawio" runs from there (no network).
  const drawioHome = process.env.DRAWIO_MCP_HOME || '/opt/drawio-mcp';
  const drawioPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drawio-mcp.mjs');
  const localDrawio = fs.existsSync(drawioPath) && fs.existsSync(path.join(drawioHome, 'shape-index.json'));
  const integrationServers = Object.fromEntries(integrations.map((s) => [s.name, localDrawio && s.name === 'drawio'
    ? { type: 'stdio', command: 'node', args: [drawioPath], env: { PATH: process.env.PATH ?? '', DRAWIO_MCP_HOME: drawioHome } }
    : { type: 'stdio', command: 'node', args: [proxyPath], env: { PATH: process.env.PATH ?? '', MCP_PROXY_SPEC: JSON.stringify(s) } }]));

  // ── Counters ─────────────────────────────────────────────────────────────────
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCostUsd = 0;
  // Priced per model reply (one request): used when the SDK reports no total (a stopped run).
  let estimatedCostUsd = 0;
  let turns = 0;
  let stopReason = 'end_turn';
  let resultSubtype = '';
  let gotResult = false;
  // The engine's error text when the last turn ended on an API error (a model the account may not use, a refused
  // sign-in): it then reports a "success" result with is_error. Sent on, so the portal fails the run.
  let apiError = '';
  let sdkSessionId: string | null = null;

  // Pending tool-use tracking (for tool-end correlation)
  const pendingToolUses = new Map<string, { name: string; inputStr: string }>();
  // Subagents: the agent each Agent tool call started (by tool_use id), and running subagent tasks.
  const agentOfToolUse = new Map<string, string>();
  const subagentTasks = new Map<string, { name: string; toolUseId: string | null }>();
  const subagentOf = (agentId: unknown): string | undefined =>
    typeof agentId === 'string' ? subagentTasks.get(agentId)?.name : undefined;

  // ── canUseTool ───────────────────────────────────────────────────────────────
  // The same decision as the portal's local engine (shared/agent/tool-policy.ts).
  // A call that needs a person goes to the portal as an approval-request and waits.
  const rules = payload.policy?.rules ?? [];
  const trusted = payload.policy?.trusted ?? false;
  const allowed = new Set<string>();
  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    opts?: { signal?: AbortSignal; agentID?: string },
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> => {
    const inputStr = JSON.stringify(input);
    // A call made inside a subagent names it, so the portal can show whose call it is.
    const agent = subagentOf(opts?.agentID);
    const deny = (message: string) => {
      emit({ type: 'tool-blocked', toolName, toolInput: inputStr, reason: message, ...(agent ? { agent } : {}) });
      return { behavior: 'deny' as const, message };
    };

    if (abortController.signal.aborted || opts?.signal?.aborted) {
      return { behavior: 'deny', message: 'The run has stopped.' };
    }

    const decision = decideToolCall({ toolName, input, workDir, rules, trusted, allowed });
    if (decision.action === 'deny') return deny(decision.reason);

    if (decision.action === 'ask') {
      if (!payload.approvals || !broker) {
        return deny(`"${toolName}" needs a person's approval, and this run has no way to ask one.`);
      }
      // Wait a little longer than the portal does, so the portal's expiry decides and is recorded there.
      const expiryMs = Math.round(payload.approvals.expiryMinutes * 60_000) + 60_000;
      const req = broker.open(payload.runId, decision.inputHash, expiryMs, abortController.signal);
      emit({
        type: 'approval-request',
        requestId: req.requestId,
        toolName,
        input,
        inputHash: decision.inputHash,
        scope: decision.scope,
        label: decision.label,
        reason: decision.reason,
        expiresAt: req.expiresAt,
      });
      const outcome = await req.outcome;
      if (outcome.decision === 'deny') return deny(outcome.message || 'The user declined this action.');
      if (outcome.remember) allowed.add(decision.rememberKey);
    }

    // A request without a policy (the user's own Anthropic key path) cannot ask a person: without "trust all tools"
    // only reads run. An integration's proxy has already hidden the tools it may not offer, so what is left may run.
    const isIntegrationTool = integrations.some((s) => toolName.startsWith(`mcp__${s.name}__`));
    if (!payload.policy && payload.trustTools === false && !READ_ONLY_TOOLS.has(toolName) && !isIntegrationTool) {
      const reason = `"${toolName}" needs approval. Turn on "Trust all tools" for this session to let the agent change files or run commands.`;
      emit({ type: 'tool-blocked', toolName, toolInput: inputStr, reason });
      return { behavior: 'deny', message: reason };
    }

    emit({ type: 'tool-start', toolName, toolInput: inputStr, ...(agent ? { agent } : {}) });
    return { behavior: 'allow', updatedInput: input };
  };

  // ── Run SDK ──────────────────────────────────────────────────────────────────
  try {
    const mcpServers = await portalMcpServers(sdk, payload, emit, broker, abortController.signal);
    const agentNames = Object.keys(payload.agents ?? {});
    if (agentNames.length) emit({ type: 'status', text: `Project agents available: ${agentNames.join(', ')}` });
    if (payload.agent) emit({ type: 'status', text: `Lead agent: ${payload.agent}` });
    const q = sdk.query({
      prompt: payload.prompt,
      options: {
        cwd: workDir,
        model,
        canUseTool,
        env: sdkEnv,
        abortController,
        // 'default' keeps canUseTool in control; 'bypassPermissions' skips it
        permissionMode: 'default',
        // allowedTools: [] means no tools are auto-approved; canUseTool handles each one.
        // This is correct — not "no tools at all". See SDK docs.
        allowedTools: [],
        // Suppress loading CLAUDE.md / settings from the container's / directory
        settingSources: [],
        // Send the text as the model writes it (stream_event messages) instead of once per finished message.
        includePartialMessages: true,
        // SDK spend cap (FR-GUARD-10 compatible)
        maxBudgetUsd,
        ...(payload.effort ? { effort: payload.effort } : {}),
        // Let the SDK enforce the turn limit natively so it can emit a proper
        // result message (with total_cost_usd and stop_reason:"max_turns").
        // Our manual counter below remains for the turns metric.
        maxTurns,
        // The project's subagents (the Agent tool can start them by name).
        ...(agentNames.length ? { agents: payload.agents } : {}),
        // The session's lead agent runs the main conversation (its prompt, tools and preloaded skills).
        ...(payload.agent ? { agent: payload.agent } : {}),
        // Browser tools, project integrations and (when the portal allows child sessions) delegate_session.
        ...(browser || integrations.length || mcpServers ? { mcpServers: { ...(browser ? { [BROWSER_SERVER_NAME]: createBrowserMcpServer(sdk, browser) } : {}), ...integrationServers, ...(mcpServers ?? {}) } } : {}),
        // After a tool call during which the memory guard (or the kernel) stopped a command, tell the agent why it
        // ended, so it uses less memory instead of running the same command again.
        ...(memoryNote ? { hooks: claudeCodeMemoryHooks(memoryNote) } : {}),
      },
    }) as AsyncIterable<Record<string, unknown>>;

    // True once the current top-level message has been sent piece by piece, so its final copy is not sent twice.
    let streamedMessage = false;

    for await (const msg of q) {
      if (abortController.signal.aborted) break;

      const msgType = String(msg.type ?? '');

      if (msgType === 'stream_event') {
        // Work done inside a sub-agent is shown as its finished message only.
        if (msg.parent_tool_use_id) continue;
        const ev = (msg.event ?? {}) as Record<string, unknown>;
        if (ev.type === 'message_start') {
          streamedMessage = false;
        } else if (ev.type === 'content_block_delta') {
          const delta = (ev.delta ?? {}) as Record<string, unknown>;
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - invokeStart;
            streamedMessage = true;
            emit({ type: 'assistant-text', text: delta.text, stream: true });
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
            emit({ type: 'thought', text: delta.thinking });
          }
        }
        continue;
      }

      if (msgType === 'assistant') {
        turns++;

        // Safety net only — the SDK enforces maxTurns natively (via the maxTurns option
        // above) and emits a result message with total_cost_usd when it fires.
        // The SDK may emit internal assistant messages that inflate our counter;
        // use a generous safety limit (200 = validation max) to avoid false triggers.
        const safetyLimit = Math.max(maxTurns * 4, 200);
        if (turns > safetyLimit) {
          abortController.abort();
          emit({ type: 'status', text: `Safety turn limit (${safetyLimit}) exceeded. Run stopped.` });
          stopReason = 'max_turns';
          break;
        }

        const message = msg.message as Record<string, unknown> | undefined;
        if (!message) continue;
        // Set when a subagent wrote this message: the id of the Agent tool call that started it.
        const parentToolUse = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : null;
        const agent = parentToolUse ? (agentOfToolUse.get(parentToolUse) ?? 'subagent') : null;

        const usage = message.usage as Record<string, number> | undefined;
        const inputTok = usage?.input_tokens ?? 0;
        const outputTok = usage?.output_tokens ?? 0;
        const cacheWriteTok = usage?.cache_creation_input_tokens ?? 0;
        const cacheReadTok = usage?.cache_read_input_tokens ?? 0;

        totalInputTokens += inputTok;
        totalOutputTokens += outputTok;
        totalCacheWriteTokens += cacheWriteTok;
        totalCacheReadTokens += cacheReadTok;
        // A subagent may use another model than the run's: price its replies at their own model.
        const replyModel = agent && typeof message.model === 'string' && message.model ? message.model : model;
        estimatedCostUsd += estimateCost(replyModel, usage);
        // The spend so far, after every model reply: if the run is lost before its result, the portal still records it.
        if (usage) {
          emit({
            type: 'spend', costUsd: estimatedCostUsd, model,
            metrics: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheReadTokens: totalCacheReadTokens, cacheWriteTokens: totalCacheWriteTokens },
          });
        }

        // What the model read for this message is what fills its context window (200k tokens; an estimate for
        // models with a larger window).
        if (!msg.parent_tool_use_id) {
          const used = inputTok + cacheWriteTok + cacheReadTok;
          if (used > 0) emit({ type: 'context', percent: Math.min(100, Math.round((used / 200_000) * 100)) });
        }

        const content = message.content;
        if (!Array.isArray(content)) continue;

        let textAccum = '';
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text') {
            textAccum += String(block.text ?? '');
          } else if (block.type === 'tool_use') {
            const id = String(block.id ?? `tool-${Date.now()}`);
            const name = String(block.name ?? '');
            const toolInput = block.input as Record<string, unknown> ?? {};
            // Store short input summary for tool-end correlation
            const inputSummary = JSON.stringify(toolInput).slice(0, 200);
            pendingToolUses.set(id, { name, inputStr: inputSummary });
            if (AGENT_TOOLS.has(name)) {
              agentOfToolUse.set(id, String(toolInput.subagent_type ?? '').trim() || 'general-purpose');
            }

            emit({
              type: 'tool-call',
              name,
              input: inputSummary,
            });
          }
        }

        // A top-level message that was already streamed above is not sent again.
        const alreadyStreamed = streamedMessage && !msg.parent_tool_use_id;
        if (alreadyStreamed) streamedMessage = false;
        if (textAccum && !alreadyStreamed) {
          if (firstTokenMs === null && !agent) {
            firstTokenMs = Date.now() - invokeStart;
          }
          emit({
            type: 'assistant-text',
            text: textAccum,
            // A subagent's text: shown under its name, and not part of the run's answer.
            ...(agent ? { agent } : {}),
            tokens: {
              input: inputTok,
              output: outputTok,
              cacheWrite: cacheWriteTok,
              cacheRead: cacheReadTok,
            },
          });
        }

      } else if (msgType === 'user') {
        // Emit tool-end events from tool_result blocks
        const message = msg.message as Record<string, unknown> | undefined;
        if (!message) continue;
        const content = message.content;
        if (!Array.isArray(content)) continue;

        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_result') {
            const toolUseId = String(block.tool_use_id ?? '');
            const pending = toolUseId ? pendingToolUses.get(toolUseId) : undefined;
            if (pending) {
              pendingToolUses.delete(toolUseId);
              const rawOut = block.content;
              const output = (typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut)).slice(0, 500);
              emit({ type: 'tool-result', name: pending.name, output });
            }
          }
        }

      } else if (msgType === 'system') {
        // Subagent tasks: the engine reports when each one starts and how it ends.
        const subtype = String(msg.subtype ?? '');
        const taskId = typeof msg.task_id === 'string' ? msg.task_id : '';
        const isAgentTask = msg.task_type === 'local_agent' || (msg.task_type === undefined && Boolean(msg.subagent_type));
        if (subtype === 'task_started' && taskId && isAgentTask) {
          const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : null;
          const name = String(msg.subagent_type ?? '').trim() || (toolUseId ? agentOfToolUse.get(toolUseId) : undefined) || 'general-purpose';
          subagentTasks.set(taskId, { name, toolUseId });
          const parentId = typeof msg.parent_task_id === 'string' ? msg.parent_task_id : null;
          const parent = parentId ? subagentTasks.get(parentId) : undefined;
          emit({
            type: 'subagent-started',
            id: taskId,
            name,
            description: String(msg.description ?? '').slice(0, 300),
            background: msg.is_backgrounded === true,
            depth: typeof msg.spawn_depth === 'number' ? msg.spawn_depth : 1,
            ...(parent ? { parentId, parentName: parent.name } : {}),
          });
        } else if (subtype === 'task_notification' && subagentTasks.has(taskId)) {
          const task = subagentTasks.get(taskId)!;
          const status = String(msg.status ?? 'completed');
          const usage = (msg.usage ?? {}) as { total_tokens?: number; tool_uses?: number; duration_ms?: number };
          emit({
            type: status === 'completed' ? 'subagent-finished' : 'subagent-failed',
            id: taskId,
            name: task.name,
            status,
            summary: String(msg.summary ?? '').slice(0, 1000),
            ...(typeof usage.total_tokens === 'number' ? { tokens: usage.total_tokens } : {}),
            ...(typeof usage.tool_uses === 'number' ? { toolUses: usage.tool_uses } : {}),
            ...(typeof usage.duration_ms === 'number' ? { durationMs: usage.duration_ms } : {}),
          });
          subagentTasks.delete(taskId);
        }

      } else if (msgType === 'result') {
        const sdkCost = (msg as Record<string, unknown>).total_cost_usd;
        if (typeof sdkCost === 'number' && sdkCost > 0) {
          totalCostUsd = sdkCost;
        }
        gotResult = true;
        // The engine reports how the run ended in subtype (stop_reason is the model's own reason).
        resultSubtype = String((msg as Record<string, unknown>).subtype ?? '');
        const sdkStopReason = String((msg as Record<string, unknown>).stop_reason ?? '');
        stopReason = stopReasonOf(resultSubtype, sdkStopReason || stopReason);
        // Only a "success" turn with is_error is an API error; error subtypes (spend cap, turn limit) say why the run
        // stopped and are reported through stop_reason as before.
        const isApiError = (msg as Record<string, unknown>).is_error === true && resultSubtype === 'success';
        apiError = isApiError ? String((msg as Record<string, unknown>).result ?? 'The model call failed.').slice(0, 2000) : '';
        const sid = (msg as Record<string, unknown>).session_id;
        if (typeof sid === 'string' && sid) sdkSessionId = sid;
      }
    }
  } catch (e: unknown) {
    const isAbort = (e as { name?: string })?.name === 'AbortError' || abortController.signal.aborted;
    // After a result it has already reported (e.g. the spend cap), the engine also throws
    // "Claude Code returned an error result". The run ended; the result says how.
    if (!isAbort && !gotResult) throw e;
  } finally {
    clearTimeout(wallClockTimer);
    await browser?.close();
    stop?.removeEventListener('abort', onStop);
    broker?.closeRun(payload.runId);
  }
  if (endedBy) stopReason = endedBy;

  // Flush any pending tool-ends
  for (const [, pending] of pendingToolUses) {
    emit({ type: 'tool-result', name: pending.name, output: '(completed)' });
  }
  // A subagent still open here did not report its end (the run stopped first).
  for (const [id, task] of subagentTasks) {
    emit({ type: 'subagent-failed', id, name: task.name, status: 'stopped', summary: 'The run ended before this agent finished.' });
  }

  // Cost fallback: a stopped or cancelled run ends without the SDK's total.
  // Use the estimate built up per model reply, priced for the run's own model.
  let costEstimated = false;
  if (totalCostUsd === 0 && (totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens) > 0) {
    totalCostUsd = estimatedCostUsd;
    costEstimated = true;
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────
  const durationMs = Date.now() - invokeStart;
  const mem = process.memoryUsage();
  const peakRssMb = Math.round(mem.rss / 1024 / 1024);
  const workDirDiskMb = dirSizeMb(workDir);

  const metrics: RunMetrics = {
    coldStartMs,
    startToFirstTokenMs: firstTokenMs,
    durationMs,
    turns,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheWriteTokens: totalCacheWriteTokens,
    costUsd: totalCostUsd,
    peakRssMb,
    workDirDiskMb,
  };

  // Structured metrics line → stdout (CloudWatch)
  // Prompt truncated to ~200 chars — no secrets in logs
  process.stdout.write(
    JSON.stringify({
      event: 'run_complete',
      runId: payload.runId,
      sessionId: sessionId ?? null,
      model,
      stop_reason: stopReason,
      prompt_preview: payload.prompt.slice(0, 200) + (payload.prompt.length > 200 ? '…' : ''),
      metrics,
    }) + '\n',
  );

  // Loop sessions: run the check steps where the code is and report the result for the next iteration.
  if (payload.checks?.length) {
    try {
      emit({ type: 'check-result', ...(await runCheckSteps(payload.checks as never, workDir)) });
    } catch (e) {
      emit({ type: 'check-result', ok: false, ranAt: new Date().toISOString(), steps: [{ step: 'checks', ok: false, output: String((e as Error)?.message ?? e).slice(0, 500), durationMs: 0, required: true }] });
    }
  }

  // Pull requests: say which cloned repositories changed (read-only; nothing is committed or pushed here).
  if (payload.finalizeCheck && payload.repos?.length) {
    try { await reportRepoChanges(payload.repos, workDir, emit); } catch { /* best effort */ }
  }

  // Send back the files the agent wrote (documents, images, spreadsheets...), within size limits.
  try { emitRunnerFiles(workDir, emit, filesSinceMs); } catch { /* best effort */ }

  // Final SSE event — includes full metrics
  emit({
    type: 'result',
    runId: payload.runId,
    stop_reason: stopReason,
    subtype: resultSubtype || null,
    costUsd: totalCostUsd,
    costEstimated,
    sessionId: sdkSessionId,
    model,
    metrics,
    ...(apiError ? { apiError } : {}),
  });
}
