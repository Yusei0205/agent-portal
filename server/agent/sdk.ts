import type { ProviderRunOptions, SdkMessage } from './types.ts';
import { HttpError } from '../util.ts';

// Kept in a variable so bundlers leave it as a runtime import from node_modules.
// PORTAL_SDK_MODULE lets tests substitute a fake SDK.
const SDK_PACKAGE = process.env.PORTAL_SDK_MODULE || '@anthropic-ai/claude-agent-sdk';

let sdkPromise: Promise<any> | null = null;

export function loadSdk(): Promise<any> {
  if (!sdkPromise) {
    sdkPromise = import(SDK_PACKAGE).catch((e) => {
      sdkPromise = null;
      throw new HttpError(
        500,
        `The Claude Agent SDK is not installed (${e?.message ?? e}). Run "npm install" in the portal folder, or switch Settings › Provider to Demo.`,
      );
    });
  }
  return sdkPromise;
}

/**
 * Run the real Claude Agent SDK. Uses streaming input so approvals and clarifying
 * questions work, and closes the input stream once the result arrives.
 */
export async function* sdkRun(opts: ProviderRunOptions): AsyncIterable<SdkMessage> {
  const sdk = await loadSdk();
  let closeInput: () => void = () => {};
  const inputClosed = new Promise<void>((r) => (closeInput = r));
  opts.abort.signal.addEventListener('abort', () => closeInput(), { once: true });
  // The first message waits until the run's permission mode is in place (see below).
  let releaseInput: () => void = () => {};
  const inputReleased = new Promise<void>((r) => (releaseInput = r));
  let modeError: unknown = null;

  async function* input() {
    await inputReleased;
    if (modeError) return;
    yield { type: 'user', message: { role: 'user', content: opts.prompt }, parent_tool_use_id: null };
    await inputClosed;
  }

  const hook = (event: string) => async (hookInput: any) => {
    try {
      opts.onHook?.(event, hookInput);
    } catch {
      /* never break the run because of a UI hook */
    }
    return {};
  };

  const preToolUse = async (hookInput: any) => {
    const reason = await opts.guard?.(hookInput.tool_name, hookInput.tool_input ?? {});
    if (reason) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    }
    return {};
  };

  const options: Record<string, unknown> = {
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    allowedTools: opts.allowedTools ?? [],
    settingSources: opts.settingSources,
    // MCP servers come only from the portal's own integrations (opts.mcpServers). Without this, the SDK also starts
    // servers declared in project files (.mcp.json, plugins, and agent frontmatter that project editors can change),
    // which would run commands on the portal server. The Kiro engine does the same (kiro.ts).
    strictMcpConfig: true,
    canUseTool: async (toolName: string, toolInput: Record<string, unknown>, o: any) =>
      opts.canUseTool(toolName, toolInput, { signal: o?.signal ?? opts.abort.signal, toolUseID: o?.toolUseID, agentID: o?.agentID }),
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
      SubagentStart: [{ hooks: [hook('SubagentStart')] }],
      SubagentStop: [{ hooks: [hook('SubagentStop')] }],
    },
    env: opts.env,
    abortController: opts.abort,
    systemPrompt: opts.systemPrompt ?? { type: 'preset', preset: 'claude_code', append: opts.systemAppend ?? '' },
    stderr: (data: string) => {
      if (process.env.PORTAL_DEBUG_SDK) process.stderr.write(`[claude] ${data}`);
    },
  };
  if (opts.tools) options.tools = opts.tools;
  if (opts.maxTurns) options.maxTurns = opts.maxTurns;
  if (opts.maxBudgetUsd) options.maxBudgetUsd = opts.maxBudgetUsd;
  if (opts.fallbackModel && opts.fallbackModel !== opts.model) options.fallbackModel = opts.fallbackModel;
  if (opts.effort) options.effort = opts.effort;
  if (opts.resume) options.resume = opts.resume;
  if (opts.additionalDirectories?.length) options.additionalDirectories = opts.additionalDirectories;
  if (opts.mcpServers && Object.keys(opts.mcpServers).length) options.mcpServers = opts.mcpServers;

  const q = sdk.query({ prompt: input(), options });
  // With CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (settings.ts) Claude Code starts every session in "default" mode, whatever
  // permissionMode says. Set the run's own mode again before its first message, so plan runs cannot edit and
  // auto-accept runs do not ask about every edit. If that fails, the run must not go on in another mode.
  if (opts.permissionMode && opts.permissionMode !== 'default') {
    Promise.resolve()
      .then(() => {
        if (typeof q.setPermissionMode !== 'function') throw new Error('this SDK cannot change the permission mode');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Claude Code did not answer within 60 seconds')), 60_000);
          timer.unref?.();
        });
        return Promise.race([q.setPermissionMode(opts.permissionMode), late]).finally(() => clearTimeout(timer));
      })
      .catch((e: unknown) => {
        modeError = e;
        try {
          q.close?.();
        } catch {
          /* already closed */
        }
      })
      .finally(() => releaseInput());
  } else {
    releaseInput();
  }
  try {
    for await (const msg of q as AsyncIterable<SdkMessage>) {
      yield msg;
      if (msg.type === 'result') closeInput();
    }
  } catch (e) {
    if (!modeError) throw e;
  } finally {
    closeInput();
  }
  if (modeError && !opts.abort.signal.aborted) {
    const why = modeError instanceof Error ? modeError.message : String(modeError);
    throw new Error(`The run could not start in "${opts.permissionMode}" mode (${why}), so it did not start.`);
  }
}
