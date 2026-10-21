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

  async function* input() {
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
    const reason = opts.guard?.(hookInput.tool_name, hookInput.tool_input ?? {});
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
  if (opts.resume) options.resume = opts.resume;
  if (opts.additionalDirectories?.length) options.additionalDirectories = opts.additionalDirectories;
  if (opts.mcpServers && Object.keys(opts.mcpServers).length) options.mcpServers = opts.mcpServers;

  const q = sdk.query({ prompt: input(), options });
  try {
    for await (const msg of q as AsyncIterable<SdkMessage>) {
      yield msg;
      if (msg.type === 'result') closeInput();
    }
  } finally {
    closeInput();
  }
}
