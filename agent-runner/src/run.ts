/**
 * Agent run — one Claude Code invocation against Bedrock.
 *
 * Guard wiring
 * ─────────────
 * guardToolCall    : imported from shared/guard.ts, which is COPY'd from
 *                    server/agent/guard.ts at Docker build time. Same source,
 *                    not a copy. Blocks protected config writes.
 * scrubEnvForShell : imported from shared/env-scrub.ts, COPY'd from
 *                    server/agent/env-scrub.ts. Removes *_KEY/*_TOKEN/*_SECRET
 *                    vars from the env passed to the SDK subprocess.
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
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { guardToolCall } from '../shared/guard.js';
import { scrubEnvForShell } from '../shared/env-scrub.js';
import { AgentCoreBrowser, BROWSER_SERVER_NAME, createBrowserMcpServer } from './browser-tools.js';
import { emitRunnerFiles } from '../shared/runner-files.js';
import { runCheckSteps } from '../shared/runner-checks.js';
import { parseRunnerRepos, cloneRunnerRepos, usablePersistRoot, PERSIST_ROOT } from '../shared/runner-repos.js';
import { parseSnapshot, restoreWorkspace } from '../shared/runner-snapshot.js';
import { parseMcpServers } from '../shared/runner-mcp.js';
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

// ── Write-tool names (mirrors guard.ts) ──────────────────────────────────────

const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'write', 'edit', 'str_replace_editor',
]);

/** Tools that only read: allowed even when the session does not trust all tools. */
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
    const out = execSync(`du -sm "${dirPath}" 2>/dev/null || echo "0"`, { encoding: 'utf8' });
    const mb = parseInt(out.split('\t')[0] ?? '0', 10);
    return isNaN(mb) ? 0 : mb;
  } catch {
    return 0;
  }
}

// ── Work dir boundary check ───────────────────────────────────────────────────

/**
 * Returns true if absPath is inside (or equal to) baseDir.
 * Resolves relative paths against baseDir. Does not follow symlinks —
 * guardToolCall handles protected-config patterns separately.
 */
function isInsideWorkDir(baseDir: string, absOrRelPath: string): boolean {
  const abs = path.isAbsolute(absOrRelPath)
    ? path.normalize(absOrRelPath)
    : path.normalize(path.resolve(baseDir, absOrRelPath));
  const base = path.normalize(baseDir);
  return abs === base || abs.startsWith(base + '/');
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
 */
export async function runInvocation(
  payload: InvocationPayload,
  sessionId: string | undefined,
  emit: EmitFn,
  processStartMs: number,
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
  const sessionKey = sessionId ?? `run-${payload.runId}`;
  const workDir = path.join('/tmp', 'agent-sessions', sessionKey, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  emit({ type: 'status', text: `Work dir: ${workDir}` });

  // ── Clone repo ──────────────────────────────────────────────────────────────
  if (payload.repo?.url) {
    const cloneUrl = payload.repo.url;
    const branchArgs = payload.repo.branch ? ['--branch', payload.repo.branch] : [];
    emit({ type: 'status', text: `Cloning ${cloneUrl}${payload.repo.branch ? ` @ ${payload.repo.branch}` : ''}` });
    try {
      execSync(['git', 'clone', '--depth=1', ...branchArgs, cloneUrl, '.'].join(' '), {
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

  // ── The session's repositories (cloned under repos/) ───────────────────────
  if (payload.repos?.length) {
    const parsed = parseRunnerRepos(payload.repos);
    if (parsed.ok) {
      await restoreWorkspace(parseSnapshot(payload.snapshot), usablePersistRoot(PERSIST_ROOT), (ev) => emit(ev));
      await cloneRunnerRepos(parsed.repos, workDir, (ev) => emit(ev), { persistRoot: PERSIST_ROOT, homeDir: workDir });
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
  const sdkEnv: Record<string, string> = {
    ...scrubbed,
    AWS_DEFAULT_REGION: region,
    AWS_REGION: region,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // Isolate Claude's home dir to the work dir (no user-level settings loaded)
    HOME: workDir,
    USERPROFILE: workDir, // Windows compatibility (not needed in the container)
  };

  if (payload.auth) {
    // The user's own Anthropic credential, valid for this run only (the microVM is isolated per session).
    if (payload.auth.kind === 'api_key') sdkEnv.ANTHROPIC_API_KEY = payload.auth.secret;
    else sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = payload.auth.secret;
  } else {
    sdkEnv.CLAUDE_CODE_USE_BEDROCK = '1';
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

  // ── Load SDK ────────────────────────────────────────────────────────────────
  const sdk = await loadSdk();
  if (typeof sdk.query !== 'function') {
    throw new Error('Claude Agent SDK does not export query(). Check the SDK version.');
  }

  // ── Abort controller (wall-clock limit) ─────────────────────────────────────
  const abortController = new AbortController();
  const wallClockTimer = setTimeout(() => {
    abortController.abort();
    emit({ type: 'status', text: `Wall-clock limit of ${maxMinutes} minutes reached. Run aborted.` });
  }, maxMinutes * 60_000);

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
  const integrationServers = Object.fromEntries(integrations.map((s) => [s.name, {
    type: 'stdio',
    command: 'node',
    args: [proxyPath],
    env: { PATH: process.env.PATH ?? '', MCP_PROXY_SPEC: JSON.stringify(s) },
  }]));

  // ── Counters ─────────────────────────────────────────────────────────────────
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCostUsd = 0;
  let turns = 0;
  let stopReason = 'end_turn';

  // Pending tool-use tracking (for tool-end correlation)
  const pendingToolUses = new Map<string, { name: string; inputStr: string }>();

  // ── canUseTool ───────────────────────────────────────────────────────────────
  // Called by the SDK before each tool execution.
  // No interactive approvals in the spike — any 'ask' is auto-denied.
  const canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
  ): { behavior: 'allow' } | { behavior: 'deny'; message: string } => {
    const inputStr = JSON.stringify(input);

    // Abort check
    if (abortController.signal.aborted) {
      return { behavior: 'deny', message: 'Run aborted (wall-clock limit).' };
    }

    // Work dir boundary — write tools must stay inside workDir
    if (WRITE_TOOLS.has(toolName)) {
      const relPath = String(
        input.file_path ?? input.path ?? input.new_path ?? input.notebook_path ?? '',
      );
      if (relPath && !isInsideWorkDir(workDir, relPath)) {
        const reason = `Write to "${relPath}" is outside the run working directory. Blocked.`;
        emit({ type: 'tool-blocked', toolName, toolInput: inputStr, reason });
        return { behavior: 'deny', message: reason };
      }
    }

    // Guard: protected config files and git hooks/config
    // (imported from server/agent/guard.ts — same source as portal)
    const guardReason = guardToolCall(toolName, input, workDir);
    if (guardReason) {
      emit({ type: 'tool-blocked', toolName, toolInput: inputStr, reason: guardReason });
      return { behavior: 'deny', message: guardReason };
    }

    // A one-shot invocation cannot ask the user for approval, so without "trust all tools" only reads run.
    // An integration's proxy has already hidden the tools it may not offer, so what is left may run.
    const isIntegrationTool = integrations.some((s) => toolName.startsWith(`mcp__${s.name}__`));
    if (payload.trustTools === false && !READ_ONLY_TOOLS.has(toolName) && !isIntegrationTool) {
      const reason = `"${toolName}" needs approval. Turn on "Trust all tools" for this session to let the agent change files or run commands.`;
      emit({ type: 'tool-blocked', toolName, toolInput: inputStr, reason });
      return { behavior: 'deny', message: reason };
    }

    // No interactive approvals in this spike — allow everything else
    emit({ type: 'tool-start', toolName, toolInput: inputStr });
    return { behavior: 'allow' };
  };

  // ── Run SDK ──────────────────────────────────────────────────────────────────
  try {
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
        ...(browser || integrations.length ? { mcpServers: { ...(browser ? { [BROWSER_SERVER_NAME]: createBrowserMcpServer(sdk, browser) } : {}), ...integrationServers } } : {}),
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

        const usage = message.usage as Record<string, number> | undefined;
        const inputTok = usage?.input_tokens ?? 0;
        const outputTok = usage?.output_tokens ?? 0;
        const cacheWriteTok = usage?.cache_creation_input_tokens ?? 0;
        const cacheReadTok = usage?.cache_read_input_tokens ?? 0;

        totalInputTokens += inputTok;
        totalOutputTokens += outputTok;
        totalCacheWriteTokens += cacheWriteTok;
        totalCacheReadTokens += cacheReadTok;

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
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - invokeStart;
          }
          emit({
            type: 'assistant-text',
            text: textAccum,
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

      } else if (msgType === 'result') {
        const sdkCost = (msg as Record<string, unknown>).total_cost_usd;
        if (typeof sdkCost === 'number' && sdkCost > 0) {
          totalCostUsd = sdkCost;
        }
        const sdkStopReason = String((msg as Record<string, unknown>).stop_reason ?? '');
        if (sdkStopReason) stopReason = sdkStopReason;
      }
    }
  } catch (e: unknown) {
    const isAbort = (e as { name?: string })?.name === 'AbortError' || abortController.signal.aborted;
    if (!isAbort) throw e;
    stopReason = 'aborted';
  } finally {
    clearTimeout(wallClockTimer);
    await browser?.close();
  }

  // Flush any pending tool-ends
  for (const [, pending] of pendingToolUses) {
    emit({ type: 'tool-result', name: pending.name, output: '(completed)' });
  }

  // Cost fallback for wall-clock aborts (SDK never emits a result message in that path).
  // The SDK sets total_cost_usd in its result message for normal and max_turns stops;
  // for a wall-clock abort we estimate from accumulated tokens using Haiku 4.5 pricing.
  // Source: https://aws.amazon.com/bedrock/pricing/ (verify before billing)
  if (totalCostUsd === 0 && (totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens) > 0) {
    const tokensUsed = totalInputTokens + totalOutputTokens + totalCacheWriteTokens + totalCacheReadTokens;
    if (tokensUsed > 0) {
      // Haiku 4.5 on Bedrock — approximate; SDK's own calculation is used when available.
      const inputPrice = 0.80 / 1e6;
      const outputPrice = 4.00 / 1e6;
      const cacheWritePrice = 0.50 / 1e6;  // estimated — verify on pricing page
      const cacheReadPrice = 0.08 / 1e6;
      totalCostUsd =
        totalInputTokens * inputPrice +
        totalOutputTokens * outputPrice +
        totalCacheWriteTokens * cacheWritePrice +
        totalCacheReadTokens * cacheReadPrice;
    }
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

  // Send back the files the agent wrote (documents, images, spreadsheets...), within size limits.
  try { emitRunnerFiles(workDir, emit, filesSinceMs); } catch { /* best effort */ }

  // Final SSE event — includes full metrics
  emit({
    type: 'result',
    runId: payload.runId,
    stop_reason: stopReason,
    metrics,
  });
}
