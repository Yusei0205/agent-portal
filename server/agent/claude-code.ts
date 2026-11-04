/**
 * Claude Code engine — runs agent workflows via the @anthropic-ai/claude-agent-sdk.
 *
 * Supports providers:
 *   'anthropic' — ANTHROPIC_API_KEY from portal settings
 *   'bedrock'   — AWS credentials from portal settings (ambient/profile/keys/bedrock-key)
 *
 * Guardrails:
 *   - Every tool call routed through evaluateCommand() (allow/ask/block).
 *   - 'ask' suspends until the user approves or denies via ctx.awaitInput.
 *   - 'block' denies immediately without asking.
 *   - Writes outside workDir are always blocked.
 *   - allowAll set: tools in this set skip the 'ask' step.
 *
 * Usage / cost:
 *   - Per-turn cache tokens recorded on assistant-text events.
 *   - Run totals + cost written to p6_runs and budget_usage on completion.
 */

import path from 'node:path';
import fs from 'node:fs';
import { now, generateId, HttpError } from '../util.ts';
import { evaluateCommand } from '../guardrails.ts';
import { getSettings, getAgentEnv } from '../settings.ts';
import { resolveCredentialEnv } from '../credentials.ts';
import { guardToolCall } from './guard.ts';
import { shouldScrubSdkEnv } from './env-scrub.ts';
import { isReallyInsideDir } from '../real-path.ts';
import {
  rewritePlaywrightMcpHeadless,
  rewritePlaywrightMcpCdp,
  hasPlaywrightMcpEntry,
} from './browser-headless.ts';
import { launchSessionBrowser } from './browser-manager.ts';
import { getRunHomeDir } from '../user-config.ts';
import { estimateCost } from './pricing.ts';
import type { RunContext } from './types.ts';
import { createChildSession } from '../delegation.ts';
import { getDelegationSettingsRepository } from '../repositories/delegation-settings.ts';
import { buildConversationRecap } from './recap.ts';
import {
  persistClaudeTranscripts,
  restoreClaudeTranscripts,
  claudeProjectDirName,
} from './claude-sessions.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { runClaudeViaAgentCore, anthropicAuthFromEnv } from './claude-agentcore.ts';

// ── SDK loader ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkModule = Record<string, any>;
let _sdkPromise: Promise<SdkModule> | null = null;
let _sdkPkg: string | undefined;

function loadSdk(): Promise<SdkModule> {
  // Read env at call time so tests can set PORTAL_SDK_MODULE before calling.
  // Invalidate the cache if the package path changes (e.g. between tests).
  const pkg = process.env.PORTAL_SDK_MODULE ?? '@anthropic-ai/claude-agent-sdk';
  if (!_sdkPromise || _sdkPkg !== pkg) {
    _sdkPkg = pkg;
    // Use Function('m', ...) so the import expression is not rewritten by bundlers
    _sdkPromise = (Function('m', 'return import(m)')(pkg) as Promise<SdkModule>).catch(
      (e: unknown) => {
        _sdkPromise = null;
        _sdkPkg = undefined;
        throw new HttpError(
          500,
          `The Claude Agent SDK is not available (${(e as Error)?.message ?? e}). ` +
            'Run "npm install" in the portal directory, or switch Settings › Provider to Demo.',
        );
      },
    );
  }
  return _sdkPromise;
}

// ── Tool helpers ──────────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'write', 'edit', 'str_replace_editor',
]);

const BASH_TOOLS = new Set([
  'Bash', 'bash', 'execute_bash', 'execute_command', 'computer',
]);

const READ_TOOLS = new Set([
  'Read', 'read', 'Glob', 'glob', 'Grep', 'grep',
  'LS', 'ls', 'view', 'cat',
  'WebSearch', 'WebFetch', 'web_search', 'web_fetch',
]);

function toolCategory(name: string): string | null {
  if (WRITE_TOOLS.has(name)) return 'write';
  if (BASH_TOOLS.has(name)) return 'bash';
  if (READ_TOOLS.has(name)) return 'read';
  return null;
}

/** Build the command string fed to evaluateCommand for non-bash tools. */
function toolCommandStr(name: string, input: Record<string, unknown>): string {
  if (BASH_TOOLS.has(name)) {
    return String(input.command ?? input.cmd ?? name);
  }
  if (WRITE_TOOLS.has(name)) {
    const fp = String(input.file_path ?? input.path ?? input.new_path ?? '');
    return fp ? `${name} ${fp}` : name;
  }
  if (READ_TOOLS.has(name)) {
    const fp = String(input.file_path ?? input.path ?? input.query ?? '');
    return fp ? `${name} ${fp}` : name;
  }
  return name;
}

// ── Model resolution ──────────────────────────────────────────────────────────

function resolveModel(runModel?: string | null): string {
  if (runModel && runModel.trim()) return runModel.trim();
  const settings = getSettings();
  return settings.defaultModel || 'claude-sonnet-4-5';
}

// ── Review system append ──────────────────────────────────────────────────────

const REVIEW_SYSTEM_APPEND = `
You are performing a code review. Read diff.patch (if present in the working directory) and the source files it touches.
Identify real defects, security risks, reliability issues, and best-practice violations.

At the end of your response, output all findings as a JSON array in a markdown code block:

\`\`\`json
[
  {
    "file": "path/to/file.ext",
    "line": 42,
    "severity": "critical|high|medium|low|info",
    "title": "Short description",
    "body": "Detailed explanation and suggestion.",
    "confidence": 0.9
  }
]
\`\`\`

Use severities: critical, high, medium, low, info.
Set confidence between 0.0 and 1.0.
Only include real findings — an empty array [] is correct when the diff is clean.
`.trim();

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run a workflow using the Claude Code SDK. Emits events via ctx.emit() and
 * returns the final summary text.
 */
/** Run Claude on the AgentCore runtime and record cost/usage like the local path does. */
async function runClaudeViaAgentCoreAdapter(
  ctx: RunContext,
  runtimeArn: string,
  auth: { kind: 'api_key' | 'oauth_token'; secret: string },
): Promise<string> {
  const { run, emit } = ctx;
  const repo = getSessionsRepository();
  const model = resolveModel(run.model);

  const wf = await repo.getWorkflowById(run.workflowId);
  const wfRow = wf as unknown as Record<string, unknown> | null;
  const wfBudget = wfRow?.['budget_usd'] != null ? Number(wfRow['budget_usd']) : null;
  const maxBudgetUsd = wfBudget ?? getSettings().agents.maxBudgetUsdPerRun;

  let prompt = run.goal;
  if (run.kind === 'review') prompt = `${run.goal}

${REVIEW_SYSTEM_APPEND}`;
  // Every AgentCore session starts fresh, so earlier turns are passed along as a recap.
  const recap = await buildConversationRecap(run.workflowId, run.runId);
  if (recap) {
    prompt = recap + prompt;
    emit('status', { text: 'Included a recap of earlier turns' });
  }

  const res = await runClaudeViaAgentCore(ctx, {
    runtimeArn,
    runId: run.runId,
    prompt,
    model,
    auth,
    trustTools: Boolean(run.trusted),
    maxBudgetUsd,
    effort: getSettings().agents.effort || null,
    // The browser bills while a session is open, so it is opt-in per deployment (see infra context agentcoreBrowser).
    browser: process.env.PORTAL_AGENTCORE_BROWSER === '1',
    repos: run.runnerRepos,
    mcpServers: run.runnerMcpServers,
    awsEnv: run.runnerAwsEnv,
    inputFiles: run.runnerInputFiles,
    checks: run.runnerChecks,
  });

  let costUsd = res.costUsd;
  if (costUsd === 0 && (res.inputTokens > 0 || res.outputTokens > 0)) {
    costUsd = estimateCost(model, {
      input_tokens: res.inputTokens,
      output_tokens: res.outputTokens,
      cache_read_input_tokens: res.cacheReadTokens,
      cache_creation_input_tokens: res.cacheWriteTokens,
    });
  }

  await repo.updateRun(run.runId, {
    cost_usd: costUsd,
    input_tokens: res.inputTokens,
    output_tokens: res.outputTokens,
    cache_write_tokens: res.cacheWriteTokens,
    cache_read_tokens: res.cacheReadTokens,
    model,
  });

  if (costUsd > 0 || res.inputTokens > 0 || res.outputTokens > 0) {
    const { getBudgetRepository } = await import('../repositories/budget.ts');
    await getBudgetRepository().record({
      user_id: wf?.created_by ?? null,
      project_id: run.projectId,
      workflow_id: run.workflowId,
      run_id: null,
      cost_usd: costUsd,
      input_tokens: res.inputTokens,
      output_tokens: res.outputTokens,
      provider: auth.kind === 'oauth_token' ? 'subscription' : 'anthropic',
      model,
      created_at: now(),
    });
  }

  const summary = res.text || 'Run complete.';
  emit('run-complete', { result: summary, cost_usd: costUsd });
  return summary;
}

export async function runClaudeCode(ctx: RunContext): Promise<string> {
  const { run, emit, awaitInput } = ctx;

  // ── Pre-flight: credentials check ─────────────────────────────────────────
  // Resolve env from per-user credential, default credential, or portal provider.
  const agentEnv = await resolveCredentialEnv('claude-code', run.credentialOwnerId, run.credentialId);

  // ── Cloud: run on an AgentCore runtime instead of a local SDK process ─────
  const claudeRuntimeArn = process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN;
  const cloudAuth = claudeRuntimeArn ? anthropicAuthFromEnv(agentEnv as Record<string, string | undefined>) : null;
  if (claudeRuntimeArn && cloudAuth) {
    return runClaudeViaAgentCoreAdapter(ctx, claudeRuntimeArn, cloudAuth);
  }

  // ── Materialised home dir (F5) ─────────────────────────────────────────────
  // await materialiseForRun() is called before the engine by runner.ts.
  // Set HOME (and USERPROFILE on Windows) so claude-code reads agents/, steering/,
  // and mcp.json from the materialised directory rather than the portal process home.
  const homeDir = getRunHomeDir(run.runId);
  const sdkEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...agentEnv };
  // Feature D: Credential scrubbing — keep model keys out of agent shell commands.
  // CLAUDE_CODE_DISABLE_AUTO_MEMORY and MCP_TOOL_TIMEOUT are already set in agentEnv (via getAgentEnv).
  // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is safe on Windows; on Linux it activates sandbox mode which
  // requires bubblewrap+socat. AgentCore containers use scrubEnvForShell() explicitly instead.
  if (shouldScrubSdkEnv()) {
    if (sdkEnv.ANTHROPIC_API_KEY || sdkEnv.CLAUDE_CODE_USE_BEDROCK || sdkEnv.CLAUDE_CODE_OAUTH_TOKEN) {
      sdkEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
    }
  }
  // Always disable auto-memory (notes would carry across projects unreviewed)
  sdkEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  // MCP tool call timeout
  const _settings = getSettings();
  const _mcpMinutes = _settings.agents.mcpToolTimeoutMinutes ?? 10;
  if (_mcpMinutes > 0) {
    sdkEnv.MCP_TOOL_TIMEOUT = String(_mcpMinutes * 60_000);
  }
  if (homeDir) {
    sdkEnv.HOME = homeDir;
    if (process.platform === 'win32') {
      sdkEnv.USERPROFILE = homeDir;
    }
    // Set a stable project dir name so transcripts land at a predictable path:
    // <homeDir>/.claude/projects/<workflowId-slug>/<sessionId>.jsonl
    sdkEnv.CLAUDE_CODE_PROJECT_DIR_NAME = claudeProjectDirName(run.workflowId);
    // Restore transcript files from previous runs before the engine starts
    await restoreClaudeTranscripts(run.workDir, homeDir);
    // Playwright MCP: connect to the portal's live session browser when possible
    // (same as Kiro), otherwise run headless with output in workDir/.browser/.
    const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
    let live = false;
    if (await hasPlaywrightMcpEntry(claudeSettingsPath)) {
      try {
        const cdpEndpoint = await launchSessionBrowser(run.workflowId, run.workDir);
        live = await rewritePlaywrightMcpCdp(claudeSettingsPath, run.workDir, cdpEndpoint);
        if (!live) emit('status', { text: 'Live browser rewrite failed. Falling back to headless.' });
      } catch (launchErr: unknown) {
        emit('status', {
          text: `Live browser unavailable — ${String((launchErr as Error)?.message ?? launchErr)}. Falling back to headless.`,
        });
      }
    }
    if (!live) await rewritePlaywrightMcpHeadless(claudeSettingsPath, run.workDir);
  }

  if (!sdkEnv.ANTHROPIC_API_KEY && !sdkEnv.CLAUDE_CODE_USE_BEDROCK && !sdkEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    const settings = getSettings();
    const mode = settings.provider.mode;
    if (mode === 'demo' || mode === 'kiro') {
      throw new HttpError(
        400,
        `Provider is set to "${mode}". Select Anthropic or Amazon Bedrock in Settings › Provider to use the Claude Code engine.`,
      );
    }
    if (mode === 'anthropic') {
      throw new HttpError(
        400,
        'No Anthropic API key configured. Add one in Settings › Provider › Anthropic API key, or add a credential in Credentials.',
      );
    }
    if (mode === 'bedrock') {
      throw new HttpError(
        400,
        'Amazon Bedrock is selected but AWS credentials are not configured. ' +
          'Set them in Settings › Provider › Amazon Bedrock, or add a Bedrock credential in Credentials.',
      );
    }
    throw new HttpError(
      400,
      'No Claude Code credentials configured. Add a credential in Credentials, or configure the provider in Settings.',
    );
  }

  // ── Load SDK ───────────────────────────────────────────────────────────────
  const sdk = await loadSdk();
  if (typeof sdk.query !== 'function') {
    throw new HttpError(500, 'Loaded Claude Agent SDK does not export a query() function. Check the SDK version.');
  }

  // ── Model ──────────────────────────────────────────────────────────────────
  const model = resolveModel(run.model);

  // ── Run budget limit (FR-GUARD-10) ─────────────────────────────────────────
  const repo = getSessionsRepository();
  const wfForBudget = await repo.getWorkflowById(run.workflowId);
  const wfBudget = (wfForBudget as Record<string, unknown>)?.['budget_usd'] != null
    ? Number((wfForBudget as Record<string, unknown>)['budget_usd'])
    : null;
  const globalBudget = getSettings().agents.maxBudgetUsdPerRun;
  const maxBudgetUsd = wfBudget ?? globalBudget;

  // ── Delegation settings ────────────────────────────────────────────────────
  const delegationSettings = await getDelegationSettingsRepository().get();
  const delegationEnabled = delegationSettings.enabled;
  const nudgeThreshold = delegationSettings.nudgeThreshold;

  // ── Subagent nudge tracking ────────────────────────────────────────────────
  let nudgeFired = false;
  let runningSubagents = 0;

  // ── Pending tool-use tracking (for tool-end correlation) ──────────────────
  const pendingToolUses = new Map<string, { name: string; inputStr: string }>();

  // ── Aggregate counters ─────────────────────────────────────────────────────
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCostUsd = 0;
  const textParts: string[] = [];

  // ── canUseTool callback ────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canUseTool = async (toolName: string, input: Record<string, unknown>, opts: Record<string, any>) => {
    const inputStr = JSON.stringify(input);

    // Respect cancellation
    if (ctx.signal?.aborted || opts?.signal?.aborted) {
      return { behavior: 'deny', message: 'Run cancelled.' };
    }

    // Write guard: file writes must stay inside workDir; symlinks are followed
    if (WRITE_TOOLS.has(toolName)) {
      const relPath = String(input.file_path ?? input.path ?? input.new_path ?? '');
      if (relPath) {
        const absPath = path.resolve(run.workDir, relPath);
        if (!isReallyInsideDir(run.workDir, absPath)) {
          const reason = `Write to "${relPath}" is outside the run working directory.`;
          emit('tool-blocked', { toolName, toolInput: inputStr, reason });
          return { behavior: 'deny', message: reason };
        }
      }
    }

    // Guard: tool settings, MCP lists, git hooks/config, and Kiro config are protected
    const guardReason = guardToolCall(toolName, input, run.workDir);
    if (guardReason) {
      emit('tool-blocked', { toolName, toolInput: inputStr, reason: guardReason });
      return { behavior: 'deny', message: guardReason };
    }

    // Guardrail evaluation
    const cmdStr = toolCommandStr(toolName, input);
    const decision = evaluateCommand(
      { command: cmdStr, category: toolCategory(toolName) },
      run.permissions,
      run.trusted,
    );

    if (decision.action === 'block') {
      const reason = decision.reason || `Tool "${toolName}" is blocked by portal guardrails.`;
      emit('tool-blocked', { toolName, toolInput: inputStr, reason });
      return { behavior: 'deny', message: reason };
    }

    if (decision.action === 'ask') {
      // Import rememberKey lazily to avoid circular dependency in tests
      const { rememberKey, MAX_REVIEWABLE_COMMAND } = await import('./runner.ts');
      const rk = rememberKey(toolName, input);

      // Check if already allowed for this run
      if (ctx.allowed.has(rk.key)) {
        emit('tool-start', { toolName, toolInput: inputStr });
        return { behavior: 'allow' };
      }

      // Refuse commands that are too long for a person to review.
      if (BASH_TOOLS.has(toolName)) {
        const command = String(input.command ?? input.cmd ?? '');
        if (command.length > MAX_REVIEWABLE_COMMAND) {
          const reason = `This command is ${command.length} characters long, too long for a person to review. Write a script file first, or split it into smaller steps.`;
          emit('tool-blocked', { toolName, toolInput: inputStr, reason });
          return { behavior: 'deny', message: reason };
        }
      }

      // Suspend until the user responds
      let resp: { decision: 'allow' | 'deny'; remember: boolean; message: string; expired?: boolean };
      try {
        resp = await ctx.awaitInput(toolName, input);
      } catch {
        // Abort during approval wait
        return { behavior: 'deny', message: 'Run cancelled during approval wait.' };
      }
      if (resp.decision === 'deny') {
        const msg = resp.expired ? resp.message : (resp.message ? `The user declined: ${resp.message}` : 'The user declined this action.');
        emit('tool-blocked', { toolName, toolInput: inputStr, reason: msg });
        return { behavior: 'deny', message: msg };
      }
      if (resp.remember) {
        ctx.allowed.add(rk.key);
      }
    }

    emit('tool-start', { toolName, toolInput: inputStr });
    return { behavior: 'allow' };
  };

  // ── Build goal prompt ──────────────────────────────────────────────────────
  let prompt: string = run.goal;
  if (run.kind === 'review') {
    prompt = `${run.goal}\n\n${REVIEW_SYSTEM_APPEND}`;
  }

  // ── Prepend recap for sessions without a stored id ─────────────────────────
  // When there's no engine_session_id but there are prior completed runs
  // (and no /clear since the last one), give the engine a context recap.
  if (!run.engineSessionId) {
    const recap = await buildConversationRecap(run.workflowId, run.runId);
    if (recap) {
      prompt = recap + prompt;
      emit('status', { text: 'Started a new session with a recap of earlier turns' });
    }
  }

  // ── In-process MCP server for delegation (F7) ─────────────────────────────
  // Expose delegate_session as a custom tool when delegation is enabled and
  // the workflow has an owner. The tool creates a child session immediately and
  // returns the child's workflow ID and title to the agent.
  // Source: @anthropic-ai/claude-agent-sdk createSdkMcpServer() + tool() API
  // (sdk.d.ts lines 631–643, 9903–9911, options.mcpServers line 1988).
  type McpServerConfigWithInstance = {
    type: 'sdk';
    name: string;
    instance: unknown;
  };

  let delegationMcpServers: Record<string, McpServerConfigWithInstance> | undefined;

  if (delegationEnabled && run.credentialOwnerId && typeof sdk.createSdkMcpServer === 'function' && typeof sdk.tool === 'function') {
    try {
      const delegateTool = sdk.tool(
        'delegate_session',
        'Delegate a sub-task to a new child session with its own working copy and branch. ' +
          'Use this to hand off heavy or parallel work so you can continue with other tasks. ' +
          'Returns the child session ID and title.',
        {
          task: { type: 'string', describe: 'The goal or task for the child session to accomplish' } as unknown as import('zod').ZodString,
          title: { type: 'string', describe: 'Optional short title for the child session', optional: true } as unknown as import('zod').ZodString,
        },
        async (args: Record<string, unknown>) => {
          try {
            const task = String(args.task ?? '').trim();
            if (!task) return { content: [{ type: 'text' as const, text: 'Error: task is required' }], isError: true };
            const title = args.title ? String(args.title).trim() : undefined;
            const child = await createChildSession(run.workflowId, run.credentialOwnerId!, task, { title });
            const childId = String(child.id);
            const childTitle = String(child.title || (child.goal as string).slice(0, 60));
            emit('tool-start', { toolName: 'delegate_session', toolInput: JSON.stringify(args) });
            const result = JSON.stringify({ childWorkflowId: childId, title: childTitle, status: 'started' });
            emit('tool-end', { toolName: 'delegate_session', output: result });
            return { content: [{ type: 'text' as const, text: result }] };
          } catch (e: unknown) {
            const msg = (e as Error)?.message ?? String(e);
            return { content: [{ type: 'text' as const, text: `Error delegating: ${msg}` }], isError: true };
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as unknown as Record<string, unknown>;

      const mcpConfig = sdk.createSdkMcpServer({
        name: 'portal-delegation',
        tools: [delegateTool],
      }) as McpServerConfigWithInstance;

      delegationMcpServers = { 'portal-delegation': mcpConfig };
    } catch {
      // Non-fatal: if SDK version doesn't support createSdkMcpServer, skip delegation tool
    }
  }

  // ── Run SDK ────────────────────────────────────────────────────────────────
  const abortController = new AbortController();

  // Forward the run's abort signal to the SDK
  const onAbort = (): void => { abortController.abort(); };
  if (ctx.signal) {
    if (ctx.signal.aborted) {
      abortController.abort();
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // Emit continuity status when resuming a known session
  if (run.engineSessionId) {
    emit('status', { text: 'Continuing the previous Claude Code session' });
  }

  // Active prompt may be rebuilt on retry (recap prepended)
  let activePrompt = prompt;
  let resumeId: string | null = run.engineSessionId;
  let didRetryWithoutResume = false;

  const runSdkQuery = async (): Promise<void> => {
    const q = sdk.query({
      prompt: activePrompt,
      options: {
        cwd: run.workDir,
        model,
        canUseTool,
        env: sdkEnv,
        abortController,
        // 'default' keeps our canUseTool in control of all permissions.
        // Do not use 'bypassPermissions' — canUseTool is not called in that mode.
        permissionMode: 'default',
        // No pre-allowed tools; every tool routes through canUseTool.
        allowedTools: [],
        // Suppress CLAUDE.md system prompt loading from PORTAL's cwd (not the run's cwd)
        settingSources: [],
        // Resume previous session if available (F-SESSION-RESUME)
        ...(resumeId ? { resume: resumeId } : {}),
        // Per-run spend cap (FR-GUARD-10): subagents inherit this cap.
        ...(maxBudgetUsd != null && maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
        ...(getSettings().agents.effort ? { effort: getSettings().agents.effort } : {}),
        // In-process delegation MCP server (F7)
        ...(delegationMcpServers ? { mcpServers: delegationMcpServers as unknown as Record<string, object> } : {}),
      },
    });

    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      // Abort check
      if (abortController.signal.aborted) break;

      const msgType = String(msg.type ?? '');

      if (msgType === 'assistant') {
        const message = msg.message as Record<string, unknown> | undefined;
        if (!message) continue;

        const usage = message.usage as Record<string, number> | undefined;
        const inputTok = usage?.input_tokens ?? 0;
        const outputTok = usage?.output_tokens ?? 0;
        const cacheWriteTok = usage?.cache_creation_input_tokens ?? 0;
        const cacheReadTok = usage?.cache_read_input_tokens ?? 0;

        totalInputTokens += inputTok;
        totalOutputTokens += outputTok;
        totalCacheWriteTokens += cacheWriteTok;
        totalCacheReadTokens += cacheReadTok;

        const content = message.content;
        if (!Array.isArray(content)) continue;

        let textAccum = '';
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'text') {
            textAccum += String(block.text ?? '');
          } else if (block.type === 'thinking') {
            // Skip thinking blocks — don't emit to UI
          } else if (block.type === 'tool_use') {
            const id = String(block.id ?? generateId());
            const name = String(block.name ?? '');
            const toolInput = block.input as Record<string, unknown> ?? {};
            pendingToolUses.set(id, { name, inputStr: JSON.stringify(toolInput) });

            // Subagent nudge tracking (F7): detect Agent/Task tool starts
            if (name === 'Agent' || name === 'Task') {
              runningSubagents++;
              if (!nudgeFired && nudgeThreshold > 0 && runningSubagents >= nudgeThreshold) {
                nudgeFired = true;
                emit('subagent-nudge', {
                  runningSubagents,
                  threshold: nudgeThreshold,
                  message: 'Consider using delegate_session for heavy parallel work instead of spawning more in-process subagents.',
                });
              }
            }
          }
        }

        if (textAccum) {
          emit('assistant-text', {
            text: textAccum,
            input_tokens: inputTok,
            output_tokens: outputTok,
            cache_write_tokens: cacheWriteTok,
            cache_read_tokens: cacheReadTok,
          });
          textParts.push(textAccum);
        }

      } else if (msgType === 'user') {
        // Emit tool-end events when we see tool_result blocks
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
              const output = typeof rawOut === 'string'
                ? rawOut.slice(0, 1000)
                : JSON.stringify(rawOut).slice(0, 1000);
              emit('tool-end', { toolName: pending.name, output });
            }
          }
        }

      } else if (msgType === 'result') {
        // SDK-reported total cost (authoritative over our estimate)
        const sdkCost = (msg as Record<string, unknown>).total_cost_usd;
        if (typeof sdkCost === 'number' && sdkCost > 0) {
          totalCostUsd = sdkCost;
        }
        // Detect budget stop: stop_reason == 'error_max_budget_usd' means the SDK hit the cap.
        const stopReason = String((msg as Record<string, unknown>).stop_reason ?? '');
        if (stopReason === 'error_max_budget_usd') {
          const capLabel = maxBudgetUsd != null ? ` ($${maxBudgetUsd})` : '';
          await repo.updateRun(run.runId, { stop_reason: `spend cap reached${capLabel}` });
          emit('status', { text: `Spend cap reached${capLabel}. Run stopped cleanly.` });
        }
        // Capture session_id for conversation continuity (F-SESSION-RESUME)
        const sdkSessionId = (msg as Record<string, unknown>).session_id;
        if (typeof sdkSessionId === 'string' && sdkSessionId) {
          await repo.updateWorkflow(run.workflowId, {
            engine_session_id: sdkSessionId,
            engine_session_engine: 'claude-code',
            updated_at: now(),
          });
        }
      }
    }
  };

  try {
    await runSdkQuery();
  } catch (e: unknown) {
    const isAbort =
      (e as { name?: string })?.name === 'AbortError' || abortController.signal.aborted;
    if (isAbort) {
      throw new DOMException('Run cancelled', 'AbortError');
    }

    // If we tried to resume and it failed, retry once without resume
    if (resumeId && !didRetryWithoutResume) {
      const reason = String((e as Error)?.message ?? e).slice(0, 200);
      const recap = await buildConversationRecap(run.workflowId, run.runId);
      const basePrompt = run.kind === 'review' ? `${run.goal}\n\n${REVIEW_SYSTEM_APPEND}` : run.goal;
      activePrompt = recap ? recap + basePrompt : basePrompt;
      emit('status', {
        text: `Started a new session with a recap of earlier turns (could not resume: ${reason})`,
      });
      resumeId = null;
      didRetryWithoutResume = true;
      // Reset per-attempt state before retry
      textParts.length = 0;
      totalInputTokens = 0; totalOutputTokens = 0;
      totalCacheWriteTokens = 0; totalCacheReadTokens = 0;
      totalCostUsd = 0;
      pendingToolUses.clear();
      try {
        await runSdkQuery();
      } catch (e2: unknown) {
        const isAbort2 =
          (e2 as { name?: string })?.name === 'AbortError' || abortController.signal.aborted;
        if (isAbort2) throw new DOMException('Run cancelled', 'AbortError');
        throw e2;
      }
    } else {
      throw e;
    }
  } finally {
    if (ctx.signal) {
      ctx.signal.removeEventListener('abort', onAbort);
    }
    // Persist Claude transcripts before cleanupRunHome deletes the temp home
    if (homeDir) {
      await persistClaudeTranscripts(homeDir, run.workDir).catch(() => {});
    }
  }

  // If the run was cancelled (loop exited via break), throw now so the runner
  // marks the run as cancelled rather than done.
  if (abortController.signal.aborted || ctx.signal?.aborted) {
    throw new DOMException('Run cancelled', 'AbortError');
  }

  // ── Emit any remaining tool-ends (for tools that returned without user msg) ─
  for (const [, pending] of pendingToolUses) {
    emit('tool-end', { toolName: pending.name, output: '(completed)' });
  }

  // ── Estimate cost if SDK didn't report it ──────────────────────────────────
  if (totalCostUsd === 0 && (totalInputTokens > 0 || totalOutputTokens > 0)) {
    totalCostUsd = estimateCost(model, {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cache_read_input_tokens: totalCacheReadTokens,
      cache_creation_input_tokens: totalCacheWriteTokens,
    });
  }

  // Persist totals to p6_runs
  await repo.updateRun(run.runId, {
    cost_usd: totalCostUsd,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cache_write_tokens: totalCacheWriteTokens,
    cache_read_tokens: totalCacheReadTokens,
    model,
  });

  // ── Insert budget_usage record ─────────────────────────────────────────────
  if (totalCostUsd > 0 || totalInputTokens > 0 || totalOutputTokens > 0) {
    const { getBudgetRepository } = await import('../repositories/budget.ts');
    const wfRowCC = await repo.getWorkflowById(run.workflowId);
    await getBudgetRepository().record({
      user_id: wfRowCC?.created_by ?? null,
      project_id: run.projectId,
      workflow_id: run.workflowId,
      run_id: null,
      cost_usd: totalCostUsd,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      provider: sdkEnv.CLAUDE_CODE_USE_BEDROCK ? 'bedrock' : sdkEnv.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : 'anthropic',
      model,
      created_at: now(),
    });
  }

  const summary = textParts.join('\n').trim() || 'Run complete.';
  emit('run-complete', { result: summary, cost_usd: totalCostUsd });
  return summary;
}
